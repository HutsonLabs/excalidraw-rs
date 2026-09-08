//! Editing operations: the verbs an editor actually has.
//!
//! `command.rs` is the alphabet — insert, patch, delete, reorder — and
//! `geometry.rs` is the arithmetic. Neither is a verb a user would name. This
//! module is where "drag the selection", "pull the south-east handle" and
//! "duplicate" live, composed from the two.
//!
//! It sits in `xd-core` rather than in `xd-wasm` on purpose. A resize that
//! knows how to carry a linear element's points and a text element's font size
//! along with the box is real, load-bearing behaviour; putting it behind the
//! wasm shim would mean the browser build has an editor and every other
//! consumer of the crate has a data structure.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::binding;
use crate::command::{Command, End};
use crate::doc::Doc;
use crate::geometry::{self, Bounds, Handle, SelectionFrame};
use crate::scene::{Element, ElementKind};

/// The frame a selection is described and resized in: for one element its own
/// unrotated box plus its angle, for several the axis-aligned union.
///
/// This is the shape the handles are drawn from and the shape a resize works
/// in. Using the rotated AABB instead makes a turned rectangle resize its
/// bounding box, which shears the rectangle inside it.
pub fn selection_frame(doc: &Doc, ids: &[String]) -> Option<SelectionFrame> {
    let elements: Vec<&crate::scene::Element> =
        ids.iter().filter_map(|id| doc.index_of(id)).map(|i| &doc.elements()[i]).collect();
    geometry::selection_frame(elements)
}

/// The axis-aligned box around a set of elements, by id. `None` when nothing
/// matched or nothing had an extent. This is the box for *containment*
/// questions — what a marquee swept up, where to scroll to — not the frame a
/// resize works in; see [`selection_frame`] for that.
pub fn selection_bounds(doc: &Doc, ids: &[String]) -> Option<Bounds> {
    let mut acc: Option<Bounds> = None;
    for id in ids {
        let Some(i) = doc.index_of(id) else { continue };
        let Some(b) = geometry::element_bounds_rotated(&doc.elements()[i]) else { continue };
        acc = Some(match acc {
            Some(a) => a.union(&b),
            None => b,
        });
    }
    acc
}

/// Move a selection by a screen-space delta already converted to scene units.
///
/// Points are stored relative to the element's own `x`/`y`, so a move is two
/// numbers however many points the element has — which is why a freehand
/// stroke drags as cheaply as a rectangle.
pub fn translate(doc: &mut Doc, ids: &[String], dx: f64, dy: f64, key: Option<&str>) -> crate::doc::Change {
    let mut cmds = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(i) = doc.index_of(id) else { continue };
        let e = &doc.elements()[i];
        cmds.push(Command::Patch {
            id: id.clone(),
            fields: fields(&[("x", json!(e.x + dx)), ("y", json!(e.y + dy))]),
        });
    }
    run(doc, Command::Batch(cmds), key)
}

/// Resize a selection by dragging `handle` to `(px, py)`.
///
/// The selection box is resized first, then every element is mapped into the
/// new box by the same affine scale. That is what makes a multi-element resize
/// behave like one object rather than like several objects that happen to be
/// selected — and it is why this is one function rather than a loop in the
/// caller.
#[allow(clippy::too_many_arguments)]
pub fn resize(
    doc: &mut Doc,
    ids: &[String],
    handle: Handle,
    px: f64,
    py: f64,
    lock_aspect: bool,
    from_center: bool,
    key: Option<&str>,
) -> crate::doc::Change {
    let Some(frame) = selection_frame(doc, ids) else {
        return doc.no_change();
    };
    let before = frame.bounds;
    let after =
        geometry::resize_bounds(&before, frame.angle, handle, px, py, lock_aspect, from_center);

    // A selection collapsed to nothing has no scale to give; refuse rather
    // than divide by zero and leave the drawing full of NaNs.
    let sx = if before.width().abs() > 1e-9 { after.width() / before.width() } else { 1.0 };
    let sy = if before.height().abs() > 1e-9 { after.height() / before.height() } else { 1.0 };
    if !sx.is_finite() || !sy.is_finite() {
        return doc.no_change();
    }

    let mut cmds = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(i) = doc.index_of(id) else { continue };
        let e = &doc.elements()[i];
        let mut set: Vec<(&str, Value)> = Vec::new();
        let nx = after.min_x + (e.x - before.min_x) * sx;
        let ny = after.min_y + (e.y - before.min_y) * sy;
        set.push(("x", json!(nx)));
        set.push(("y", json!(ny)));
        set.push(("width", json!(e.width * sx)));
        set.push(("height", json!(e.height * sy)));
        if let Some(points) = &e.points {
            set.push((
                "points",
                json!(points.iter().map(|p| [p[0] * sx, p[1] * sy]).collect::<Vec<_>>()),
            ));
        }
        // Text has no independent width to stretch: Excalidraw scales the type
        // instead, and a label that stayed 20px inside a box scaled 3× reads
        // as a bug rather than as a choice.
        if e.kind == ElementKind::Text {
            let scale = if sy.abs() > 1e-9 { sy.abs() } else { sx.abs() };
            set.push(("fontSize", json!(e.font_size.unwrap_or(20.0) * scale)));
        }
        cmds.push(Command::Patch { id: id.clone(), fields: fields(&set) });
    }
    run(doc, Command::Batch(cmds), key)
}

/// Where a rotate gesture started, frozen so every later sample is a delta
/// against it.
///
/// This exists because of the coalesce key. `rotateTo` is called on every
/// pointer move under one key so the whole turn is one undo entry, which means
/// each sample re-reads a scene the previous sample already rotated. Anything
/// derived from the current scene therefore compounds: reading the pointer's
/// *absolute* bearing and adding it to each element's *current* angle applies
/// the sum of every sample's bearing, and a multi-selection spins away from the
/// pointer. The pivot compounds the same way, because the union box of
/// already-rotated elements is not the box the gesture started in.
///
/// So the pivot, the starting bearing and every element's original placement
/// are captured once, here, and each sample is computed from them alone. Hold
/// one of these for the life of the gesture and drop it when the key changes.
#[derive(Debug, Clone)]
pub struct RotateAnchor {
    /// The point everything orbits: the centre of the selection's box as it
    /// was when the gesture began.
    pivot: (f64, f64),
    /// The bearing the rotate handle sat at before the gesture: the selection
    /// frame's own angle, because the handle sits straight above the box in the
    /// frame's rotated coordinates.
    ///
    /// Taken from the handle's resting place rather than from the pointer's
    /// first sample, and that is the difference between a turn that starts
    /// where the shape already is and a turn that silently loses however much
    /// rotation the first pointer event carried. It also means one element still
    /// turns to *face* the pointer, which is what it did before and what
    /// Excalidraw does: for a single selection the frame's angle is the
    /// element's own, so the delta cancels it exactly.
    start: f64,
    origins: Vec<Origin>,
}

/// One element's placement at the start of a rotation.
#[derive(Debug, Clone)]
struct Origin {
    id: String,
    x: f64,
    y: f64,
    center: (f64, f64),
    angle: f64,
}

impl RotateAnchor {
    /// Capture the frame `ids` will turn in. `None` when nothing named has an
    /// extent, which is the same condition that makes a rotation meaningless.
    pub fn new(doc: &Doc, ids: &[String]) -> Option<RotateAnchor> {
        let frame = selection_frame(doc, ids)?;
        let pivot = frame.bounds.center();
        let origins = ids
            .iter()
            .filter_map(|id| doc.index_of(id).map(|i| &doc.elements()[i]))
            .map(|e| Origin {
                id: e.id.clone(),
                x: e.x,
                y: e.y,
                center: geometry::element_center(e),
                angle: e.angle,
            })
            .collect();
        Some(RotateAnchor { pivot, start: frame.angle, origins })
    }
}

/// Rotate the elements an anchor was captured for so the pointer at
/// `(px, py)` has dragged the rotate handle from where it was to where it is.
///
/// One element turns about its own centre and nothing else changes. Several
/// turn as a rigid body: each one's centre orbits the frozen pivot and each
/// turns by the same delta, which is what keeps their relative positions.
pub fn rotate(
    doc: &mut Doc,
    anchor: &RotateAnchor,
    px: f64,
    py: f64,
    snap: f64,
    key: Option<&str>,
) -> crate::doc::Change {
    let (cx, cy) = anchor.pivot;
    let raw = geometry::bearing(cx, cy, px, py) - anchor.start;
    let single = anchor.origins.len() == 1;
    // Snapping asks a different question of one element than of several. One
    // element snaps its *own* angle, so a rectangle can be dragged to exactly
    // 45°. Several turn as one body and it is the *turn* that snaps —
    // snapping each member's own angle would turn them by different amounts
    // and the group would come apart in the user's hands.
    let delta = if single || snap <= 0.0 { raw } else { (raw / snap).round() * snap };

    let mut cmds = Vec::with_capacity(anchor.origins.len());
    for o in &anchor.origins {
        if doc.index_of(&o.id).is_none() {
            continue;
        }
        let mut angle = o.angle + delta;
        if single && snap > 0.0 {
            angle = (angle / snap).round() * snap;
        }
        if single {
            cmds.push(Command::Patch {
                id: o.id.clone(),
                fields: fields(&[("angle", json!(norm(angle)))]),
            });
            continue;
        }
        let (rx, ry) = geometry::rotate_point(o.center.0, o.center.1, cx, cy, delta);
        cmds.push(Command::Patch {
            id: o.id.clone(),
            fields: fields(&[
                ("x", json!(o.x + rx - o.center.0)),
                ("y", json!(o.y + ry - o.center.1)),
                ("angle", json!(norm(angle))),
            ]),
        });
    }
    run(doc, Command::Batch(cmds), key)
}

// --- align, distribute, flip ------------------------------------------------

/// Which edge or centre line an alignment lines its elements up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Left,
    CenterH,
    Right,
    Top,
    CenterV,
    Bottom,
}

/// Which way distribution or a flip runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

impl Edge {
    /// Parse the panel's own spelling. `None` for anything else, so a typo in a
    /// caller is a no-op rather than a silent alignment to the wrong edge.
    pub fn parse(name: &str) -> Option<Edge> {
        Some(match name {
            "left" => Edge::Left,
            "centerH" => Edge::CenterH,
            "right" => Edge::Right,
            "top" => Edge::Top,
            "centerV" => Edge::CenterV,
            "bottom" => Edge::Bottom,
            _ => return None,
        })
    }

    fn axis(self) -> Axis {
        match self {
            Edge::Left | Edge::CenterH | Edge::Right => Axis::Horizontal,
            Edge::Top | Edge::CenterV | Edge::Bottom => Axis::Vertical,
        }
    }
}

impl Axis {
    pub fn parse(name: &str) -> Option<Axis> {
        Some(match name {
            "horizontal" => Axis::Horizontal,
            "vertical" => Axis::Vertical,
            _ => return None,
        })
    }
}

/// Each element's box along one axis, as `(min, max)`.
fn span(b: &Bounds, axis: Axis) -> (f64, f64) {
    match axis {
        Axis::Horizontal => (b.min_x, b.max_x),
        Axis::Vertical => (b.min_y, b.max_y),
    }
}

/// Every element in `ids` that has an extent, with its rotated box. The boxes
/// are the *rotated* ones because alignment is a statement about what the user
/// can see: a rectangle turned 30° lines up by the box it occupies on screen,
/// not by the unrotated box it is written down as.
fn boxes(doc: &Doc, ids: &[String]) -> Vec<(String, Bounds)> {
    ids.iter()
        .filter_map(|id| doc.index_of(id).map(|i| &doc.elements()[i]))
        .filter_map(|e| geometry::element_bounds_rotated(e).map(|b| (e.id.clone(), b)))
        .collect()
}

/// A translation per element, as one batch. The three verbs below all reduce to
/// this: they decide where each box should go and nothing else moves.
fn shift(doc: &mut Doc, moves: Vec<(String, f64, f64)>, key: Option<&str>) -> crate::doc::Change {
    let mut cmds = Vec::with_capacity(moves.len());
    for (id, dx, dy) in moves {
        if dx == 0.0 && dy == 0.0 {
            continue;
        }
        let Some(i) = doc.index_of(&id) else { continue };
        let e = &doc.elements()[i];
        cmds.push(Command::Patch {
            id,
            fields: fields(&[("x", json!(e.x + dx)), ("y", json!(e.y + dy))]),
        });
    }
    run(doc, Command::Batch(cmds), key)
}

/// Line the selection up on one edge or centre line of its own bounding box.
///
/// Needs two elements to mean anything — with one, every edge of the selection
/// box is that element's own edge and the operation is a no-op by definition,
/// which is why Excalidraw only enables it at two.
pub fn align(doc: &mut Doc, ids: &[String], edge: Edge, key: Option<&str>) -> crate::doc::Change {
    let items = boxes(doc, ids);
    if items.len() < 2 {
        return doc.no_change();
    }
    let Some(all) = items.iter().map(|(_, b)| *b).reduce(|a, b| a.union(&b)) else {
        return doc.no_change();
    };
    let axis = edge.axis();
    let (lo, hi) = span(&all, axis);
    let moves = items
        .into_iter()
        .map(|(id, b)| {
            let (bmin, bmax) = span(&b, axis);
            let delta = match edge {
                Edge::Left | Edge::Top => lo - bmin,
                Edge::Right | Edge::Bottom => hi - bmax,
                Edge::CenterH | Edge::CenterV => (lo + hi) / 2.0 - (bmin + bmax) / 2.0,
            };
            match axis {
                Axis::Horizontal => (id, delta, 0.0),
                Axis::Vertical => (id, 0.0, delta),
            }
        })
        .collect();
    shift(doc, moves, key)
}

/// Space the selection evenly along an axis, leaving the outermost two where
/// they are.
///
/// Equal *gaps*, not equal centres — which is what Excalidraw does and what
/// people mean by "distribute": three boxes of different widths laid out on
/// equal centres still look unevenly spaced, because the eye measures the white
/// between them. Needs three elements; with two there is one gap and it is
/// already even.
pub fn distribute(doc: &mut Doc, ids: &[String], axis: Axis, key: Option<&str>) -> crate::doc::Change {
    let mut items = boxes(doc, ids);
    if items.len() < 3 {
        return doc.no_change();
    }
    items.sort_by(|(_, a), (_, b)| {
        let (a0, a1) = span(a, axis);
        let (b0, b1) = span(b, axis);
        // Ties broken by the far edge so a box entirely inside another has a
        // defined place in the order; without it the sort is unstable across
        // platforms and the same click gives two different layouts.
        a0.partial_cmp(&b0).unwrap_or(std::cmp::Ordering::Equal).then(
            a1.partial_cmp(&b1).unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    let start = span(&items[0].1, axis).0;
    let end = span(&items[items.len() - 1].1, axis).1;
    let total: f64 = items.iter().map(|(_, b)| { let (lo, hi) = span(b, axis); hi - lo }).sum();
    let gap = (end - start - total) / (items.len() - 1) as f64;

    let mut cursor = start;
    let mut moves = Vec::with_capacity(items.len());
    for (id, b) in items {
        let (lo, hi) = span(&b, axis);
        let delta = cursor - lo;
        cursor += (hi - lo) + gap;
        moves.push(match axis {
            Axis::Horizontal => (id, delta, 0.0),
            Axis::Vertical => (id, 0.0, delta),
        });
    }
    shift(doc, moves, key)
}

/// Mirror the selection about the centre line of its own bounding box.
///
/// Three things have to happen together or the result is not a mirror image:
///
/// - the element's **centre** moves to the mirrored position;
/// - its **angle** negates, because a mirror conjugates a rotation into its
///   inverse — reflecting a shape turned 30° gives one turned -30°, and leaving
///   the angle alone gives a shape that has moved rather than flipped;
/// - a point list is **mirrored within itself**, in the element's own unrotated
///   frame. Mirroring only the box leaves an arrow pointing the same way it
///   always did, which is the single most visible way to get this wrong.
///
/// A single element flips in place, about its own centre, which is what
/// Excalidraw does and what "flip" means with one thing selected.
pub fn flip(doc: &mut Doc, ids: &[String], axis: Axis, key: Option<&str>) -> crate::doc::Change {
    let items = boxes(doc, ids);
    let Some(all) = items.iter().map(|(_, b)| *b).reduce(|a, b| a.union(&b)) else {
        return doc.no_change();
    };
    let (acx, acy) = all.center();

    let mut cmds = Vec::new();
    for (id, _) in items {
        let Some(i) = doc.index_of(&id) else { continue };
        let e = &doc.elements()[i];
        // The element's own *unrotated box*, and its centre — not
        // `element_center`, which reads `x + width/2` and so is only the centre
        // of a point list that happens to run in the positive direction. A flip
        // is exactly the operation that stops being true of one.
        let Some(own) = geometry::element_bounds(e) else { continue };
        let (ecx, ecy) = own.center();
        // Where this element's centre lands. Rotation is about the centre, so
        // the rotated box has the same centre and this holds at any angle.
        let (ncx, ncy) = match axis {
            Axis::Horizontal => (2.0 * acx - ecx, ecy),
            Axis::Vertical => (ecx, 2.0 * acy - ecy),
        };
        let mut set: Vec<(&str, Value)> = Vec::new();

        match &e.points {
            Some(points) if e.kind.has_points() && !points.is_empty() => {
                // Mirror the points about the element's own centre, in its own
                // unrotated frame: that plus the negated angle below is the
                // reflection. The local centre is the box centre expressed
                // relative to the origin the points are stored against.
                let (lcx, lcy) = (ecx - e.x, ecy - e.y);
                let mirrored: Vec<[f64; 2]> = points
                    .iter()
                    .map(|p| match axis {
                        Axis::Horizontal => [2.0 * lcx - p[0], p[1]],
                        Axis::Vertical => [p[0], 2.0 * lcy - p[1]],
                    })
                    .collect();
                // A linear element's origin *is* its first point, and the first
                // point just moved, so the list is re-expressed from wherever it
                // now starts and `x`/`y` follow it. Mirroring maps the local box
                // onto itself, so `width`/`height` are unchanged.
                let (ox, oy) = (mirrored[0][0], mirrored[0][1]);
                let rel: Vec<[f64; 2]> = mirrored.iter().map(|p| [p[0] - ox, p[1] - oy]).collect();
                set.push(("x", json!(ncx - lcx + ox)));
                set.push(("y", json!(ncy - lcy + oy)));
                set.push(("points", json!(rel)));
            }
            _ => {
                set.push(("x", json!(ncx - own.width() / 2.0)));
                set.push(("y", json!(ncy - own.height() / 2.0)));
            }
        }
        // A mirror conjugates a rotation into its inverse. Left alone, the angle
        // makes a "flip" that has merely moved the shape.
        if e.angle != 0.0 {
            set.push(("angle", json!(norm(-e.angle))));
        }
        cmds.push(Command::Patch { id, fields: fields(&set) });
    }
    run(doc, Command::Batch(cmds), key)
}

/// Copies of `ids`, offset so the duplicate is visibly not the original, and
/// selected in its place. Returns the new ids alongside the change.
pub fn duplicate(doc: &mut Doc, ids: &[String], dx: f64, dy: f64) -> (crate::doc::Change, Vec<String>) {
    const OFFSET: f64 = 10.0;
    let dx = if dx == 0.0 && dy == 0.0 { OFFSET } else { dx };
    let dy = if dx == OFFSET && dy == 0.0 { OFFSET } else { dy };
    // Identity for the whole set first. A copy that names another member of
    // the set — a label naming its container, a member naming its group — has
    // to be able to name the *copy*, and that means knowing every new id
    // before the first element is built.
    //
    // A duplicate is a new element, so it gets a new identity: a fresh id, a
    // fresh seed, and version bookkeeping starting over. Sharing the seed
    // would make the copy stroke-for-stroke identical, which reads as a
    // rendering glitch rather than as two shapes.
    let sources: Vec<String> =
        ids.iter().filter(|id| doc.index_of(id).is_some()).cloned().collect();
    let mut fresh: HashMap<String, (String, i64)> = HashMap::with_capacity(sources.len());
    for id in &sources {
        let identity = doc.fresh_identity();
        fresh.insert(id.clone(), identity);
    }
    // One new group id per group the set was in, so a duplicated pair stays
    // grouped *with each other* and not with the originals. Copying `groupIds`
    // through — which is what this used to do — makes ⌘G then ⌘D four elements
    // in one group, and it is visibly wrong the moment the file opens on
    // excalidraw.com.
    let mut groups: HashMap<String, String> = HashMap::new();
    for id in &sources {
        let i = doc.index_of(id).expect("filtered above");
        for g in doc.elements()[i].group_ids.clone() {
            groups.entry(g).or_insert_with(|| doc.fresh_id());
        }
    }

    let mut cmds = Vec::new();
    let mut new_ids = Vec::new();
    for id in &sources {
        let Some(i) = doc.index_of(id) else { continue };
        let mut copy: Element = doc.elements()[i].clone();
        let (id_new, seed) = fresh[id].clone();
        copy.id = id_new.clone();
        copy.seed = seed;
        copy.x += dx;
        copy.y += dy;
        copy.group_ids = copy
            .group_ids
            .iter()
            .map(|g| groups.get(g).cloned().unwrap_or_else(|| g.clone()))
            .collect();
        // A label's container: the copy of it when the container came along,
        // and nothing at all when it did not. Keeping the original's
        // `containerId` gives two labels claiming one container — and the
        // container lists only one of them.
        copy.container_id = copy
            .container_id
            .as_ref()
            .and_then(|c| fresh.get(c).map(|(new, _)| new.clone()));
        // Back-references survive only where both ends were copied. An arrow
        // is dropped either way: its own bindings go below, so a back-reference
        // to it would be half a binding.
        copy.bound_elements = copy.bound_elements.as_ref().and_then(|list| {
            let kept: Vec<_> = list
                .iter()
                .filter(|b| b.kind == "text")
                .filter_map(|b| {
                    fresh.get(&b.id).map(|(new, _)| crate::scene::BoundElement {
                        id: new.clone(),
                        kind: b.kind.clone(),
                    })
                })
                .collect();
            (!kept.is_empty()).then_some(kept)
        });
        copy.start_binding = None;
        copy.end_binding = None;
        new_ids.push(id_new);
        cmds.push(Command::Insert { at: None, element: Box::new(copy) });
    }
    (run(doc, Command::Batch(cmds), None), new_ids)
}

/// Apply a style patch — stroke colour, background, fill style, roughness — to
/// every selected element at once.
///
/// `resketch` re-rolls each element's `seed` in the same undo entry. That is
/// what Excalidraw's sloppiness buttons do, and it is the difference between
/// "the same sketch, drawn heavier" and "a different hand" — see
/// [`Command::Reseed`]. It is a parameter rather than a second call because the
/// two have to be one entry: undoing a sloppiness change halfway would leave a
/// shape with the new roughness and the old seed, which is a state the user
/// never asked for.
pub fn set_style(
    doc: &mut Doc,
    ids: &[String],
    style: &Map<String, Value>,
    resketch: bool,
) -> crate::doc::Change {
    let live: Vec<String> =
        ids.iter().filter(|id| doc.index_of(id).is_some()).cloned().collect();
    let mut cmds: Vec<Command> = live
        .iter()
        .map(|id| Command::Patch { id: id.clone(), fields: style.clone() })
        .collect();
    if resketch && !live.is_empty() {
        cmds.push(Command::Reseed { ids: live });
    }
    run(doc, Command::Batch(cmds), None)
}

/// Re-roll the `seed` of every element in `ids` — a fresh sketch of the same
/// shapes. See [`Command::Reseed`] for why this is a command of its own and
/// not a patch.
pub fn reseed(doc: &mut Doc, ids: &[String], key: Option<&str>) -> crate::doc::Change {
    run(doc, Command::Reseed { ids: ids.to_vec() }, key)
}

// --- container-bound labels -------------------------------------------------

/// Put the label of every container in `ids` back where its container now is.
///
/// This is the label half of what [`reflow_bindings`] does for arrows, and it
/// is needed for the same reason: a container whose label stayed behind when it
/// was dragged has visibly come apart, and the label's stored position is the
/// only thing the painter reads. Called after a move, a resize and a rotate.
///
/// It moves the label and turns it; it deliberately does not resize it. A
/// label's width and height are a *measurement* — how wide the string is in a
/// font — and this crate has no font metrics. The caller re-wraps against
/// [`geometry::label_budget`] and patches the size afterwards.
pub fn reflow_labels(doc: &mut Doc, ids: &[String], key: Option<&str>) -> crate::doc::Change {
    // Collect first: `bound_text_of` borrows the document and the patches
    // mutate it.
    let pairs: Vec<(String, String)> = ids
        .iter()
        .filter(|id| {
            doc.index_of(id).is_some_and(|i| doc.elements()[i].kind.is_label_container())
        })
        .filter_map(|id| doc.bound_text_of(id).map(|t| (id.clone(), t.to_string())))
        .collect();

    let mut cmds = Vec::new();
    for (container_id, label_id) in pairs {
        let Some(ci) = doc.index_of(&container_id) else { continue };
        let Some(li) = doc.index_of(&label_id) else { continue };
        let container = &doc.elements()[ci];
        let label = &doc.elements()[li];
        let (x, y) = geometry::label_position(container, label);
        let angle = container.angle;
        // A gesture that did not move the container must not bump the label's
        // version: a reflow is a correction, not an edit of its own.
        if (label.x - x).abs() < 1e-9 && (label.y - y).abs() < 1e-9 && (label.angle - angle).abs() < 1e-9
        {
            continue;
        }
        cmds.push(Command::Patch {
            id: label_id,
            fields: fields(&[("x", json!(x)), ("y", json!(y)), ("angle", json!(angle))]),
        });
    }
    run(doc, Command::Batch(cmds), key)
}

/// Keep an angle in (-π, π]. Excalidraw stores radians and does the same; an
/// angle that accumulates past 2π across a session is still correct but reads
/// as nonsense in the JSON.
fn norm(a: f64) -> f64 {
    let two = std::f64::consts::TAU;
    let mut a = a % two;
    if a > std::f64::consts::PI {
        a -= two;
    } else if a <= -std::f64::consts::PI {
        a += two;
    }
    a
}

fn fields(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect()
}

fn run(doc: &mut Doc, cmd: Command, key: Option<&str>) -> crate::doc::Change {
    match key {
        Some(k) => doc.apply_keyed(cmd, k, doc.now()),
        None => doc.apply(cmd),
    }
}

// --- arrow binding ----------------------------------------------------------

/// Re-aim every arrow bound to any of `ids` (and every arrow *in* `ids`) at the
/// shape it is bound to.
///
/// This is what makes binding worth having: dragging a shape has to move the
/// arrows that point at it, in the same undo entry as the drag, or the diagram
/// comes apart in the user's hands. It is called after a move, a resize and a
/// rotate — anything that changes where a bound shape's outline is.
pub fn reflow_bindings(doc: &mut Doc, ids: &[String], key: Option<&str>) -> crate::doc::Change {
    let mut arrows: Vec<String> = Vec::new();
    for e in doc.elements() {
        if !e.kind.is_linear() {
            continue;
        }
        let touches = |b: &Option<crate::scene::Binding>| {
            b.as_ref().is_some_and(|b| ids.contains(&b.element_id))
        };
        if ids.contains(&e.id) || touches(&e.start_binding) || touches(&e.end_binding) {
            arrows.push(e.id.clone());
        }
    }

    let mut cmds = Vec::new();
    for arrow_id in arrows {
        if let Some(cmd) = reflow_one(doc, &arrow_id) {
            cmds.push(cmd);
        }
    }
    run(doc, Command::Batch(cmds), key)
}

/// The patch that re-aims one arrow, or `None` when it is unbound or has no
/// two points to aim.
fn reflow_one(doc: &Doc, arrow_id: &str) -> Option<Command> {
    let arrow = doc.index_of(arrow_id).map(|i| &doc.elements()[i])?;
    let points = arrow.points.as_ref()?;
    if points.len() < 2 {
        return None;
    }
    if arrow.start_binding.is_none() && arrow.end_binding.is_none() {
        return None;
    }

    // Work in absolute coordinates; the file stores points relative to the
    // element's own x/y, and moving an endpoint moves that origin too.
    let mut abs: Vec<[f64; 2]> =
        points.iter().map(|p| [arrow.x + p[0], arrow.y + p[1]]).collect();
    let last = abs.len() - 1;

    if let Some(b) = &arrow.start_binding {
        if let Some(shape) = doc.index_of(&b.element_id).map(|i| &doc.elements()[i]) {
            let from = (abs[1][0], abs[1][1]);
            let (x, y) = binding::binding_point(shape, from, b.focus, b.gap);
            abs[0] = [x, y];
        }
    }
    if let Some(b) = &arrow.end_binding {
        if let Some(shape) = doc.index_of(&b.element_id).map(|i| &doc.elements()[i]) {
            let from = (abs[last - 1][0], abs[last - 1][1]);
            let (x, y) = binding::binding_point(shape, from, b.focus, b.gap);
            abs[last] = [x, y];
        }
    }

    let (ox, oy) = (abs[0][0], abs[0][1]);
    let rel: Vec<[f64; 2]> = abs.iter().map(|p| [p[0] - ox, p[1] - oy]).collect();
    let (mut w, mut h) = (0.0f64, 0.0f64);
    for p in &rel {
        w = w.max(p[0].abs());
        h = h.max(p[1].abs());
    }
    Some(Command::Patch {
        id: arrow_id.to_string(),
        fields: fields(&[
            ("x", json!(ox)),
            ("y", json!(oy)),
            ("points", json!(rel)),
            ("width", json!(w)),
            ("height", json!(h)),
        ]),
    })
}

/// Drag one point of a linear or freedraw element to `(x, y)`.
///
/// Two things happen here that a bare `Patch` on `points` cannot do, and they
/// are the reason this is an op:
///
/// 1. **Dragging a bound endpoint away unbinds it.** Clearing that end's
///    binding *first*, in the same command, is what lets the point move at all:
///    [`reflow_bindings`] re-aims any arrow whose own id it is given
///    (see the `ids.contains(&e.id)` arm), so a bound end that is patched and
///    then reflowed snaps straight back to the shape. With the binding gone
///    there is nothing to re-aim, the endpoint follows the pointer, and the
///    *other* end keeps reflowing — which is exactly Excalidraw's
///    unbind-by-drag.
/// 2. **The origin moves with point 0.** Points are stored relative to the
///    element's `x`/`y`, so moving the first one has to rewrite the origin and
///    every other point with it. The arithmetic is [`reflow_one`]'s, on purpose:
///    two formulas for one element's extent is two places for an arrow to jump
///    between.
pub fn move_point(
    doc: &mut Doc,
    id: &str,
    index: usize,
    x: f64,
    y: f64,
    key: Option<&str>,
) -> crate::doc::Change {
    let Some(i) = doc.index_of(id) else { return doc.no_change() };
    let e = &doc.elements()[i];
    if !e.kind.has_points() {
        return doc.no_change();
    }
    let Some(points) = e.points.clone() else { return doc.no_change() };
    if index >= points.len() {
        return doc.no_change();
    }
    let last = points.len() - 1;
    // The pointer arrives in scene coordinates and the point list is stored
    // unrotated, so a turned element's drag has to come back into its own
    // frame. The centre it turns about is the one it has now, which is an
    // approximation for the same reason the selection frame is: the centre
    // moves as the geometry does.
    let (cx, cy) = geometry::element_center(e);
    let (lx, ly) = geometry::rotate_point(x, y, cx, cy, -e.angle);

    let mut abs: Vec<[f64; 2]> = points.iter().map(|p| [e.x + p[0], e.y + p[1]]).collect();
    abs[index] = [lx, ly];
    let (ox, oy) = (abs[0][0], abs[0][1]);
    let rel: Vec<[f64; 2]> = abs.iter().map(|p| [p[0] - ox, p[1] - oy]).collect();
    let (mut w, mut h) = (0.0f64, 0.0f64);
    for p in &rel {
        w = w.max(p[0].abs());
        h = h.max(p[1].abs());
    }

    let mut cmds = Vec::new();
    if index == 0 && e.start_binding.is_some() {
        cmds.push(Command::Bind { arrow: id.to_string(), end: End::Start, binding: None });
    }
    if index == last && e.end_binding.is_some() {
        cmds.push(Command::Bind { arrow: id.to_string(), end: End::End, binding: None });
    }
    cmds.push(Command::Patch {
        id: id.to_string(),
        fields: fields(&[
            ("x", json!(ox)),
            ("y", json!(oy)),
            ("points", json!(rel)),
            ("width", json!(w)),
            ("height", json!(h)),
        ]),
    });
    run(doc, Command::Batch(cmds), key)
}

/// Add a point to a linear or freedraw element, in the middle of segment
/// `segment` — the gesture that turns a straight arrow into a bent one.
///
/// `segment` is a *segment* index, not a point index: segment `i` runs from
/// point `i` to point `i + 1`, which is what [`geometry::segment_midpoint_at`]
/// answers with, and the new point lands at point index `segment + 1`. Naming
/// the segment rather than the insertion slot is what keeps the caller from
/// having to know that the two differ by one.
///
/// **No binding is cleared, deliberately.** Unlike [`move_point`], this cannot
/// move an endpoint — the insertion is always strictly between two existing
/// points — so both ends stay where they are and stay bound. What does change is
/// the *direction* a bound end is approached from, since the bound tip aims at
/// its shape from its neighbour, so the caller should still reflow afterwards.
///
/// `lastCommittedPoint` is left alone. It marks how far a multi-point *draw*
/// gesture has got, which is a different question from where the points are;
/// writing it here would claim a draft is in progress when none is.
pub fn insert_point(
    doc: &mut Doc,
    id: &str,
    segment: usize,
    x: f64,
    y: f64,
    key: Option<&str>,
) -> crate::doc::Change {
    let Some(i) = doc.index_of(id) else { return doc.no_change() };
    let e = &doc.elements()[i];
    if !e.kind.has_points() {
        return doc.no_change();
    }
    let Some(points) = e.points.clone() else { return doc.no_change() };
    // A segment needs a point on each end of it.
    if points.len() < 2 || segment + 1 >= points.len() {
        return doc.no_change();
    }
    // The pointer is in scene coordinates and the list is stored unrotated, as
    // in `move_point`.
    let (cx, cy) = geometry::element_center(e);
    let (lx, ly) = geometry::rotate_point(x, y, cx, cy, -e.angle);

    let mut rel = points;
    rel.insert(segment + 1, [lx - e.x, ly - e.y]);
    // The origin cannot move — point 0 is still point 0 — but the extent can:
    // a point dragged out past the ends is what bends the arrow. Same
    // arithmetic as `reflow_one`, so the two never disagree about a box.
    let (mut w, mut h) = (0.0f64, 0.0f64);
    for p in &rel {
        w = w.max(p[0].abs());
        h = h.max(p[1].abs());
    }
    let cmd = Command::Patch {
        id: id.to_string(),
        fields: fields(&[("points", json!(rel)), ("width", json!(w)), ("height", json!(h))]),
    };
    run(doc, cmd, key)
}

/// Bind one end of an arrow to whatever bindable shape sits under that end,
/// or clear the binding when there is nothing there.
///
/// Returns the change and whether a binding now exists, so a caller can show
/// the highlight Excalidraw shows while you drag an endpoint over a shape.
pub fn rebind_end(doc: &mut Doc, arrow_id: &str, at_end: bool) -> (crate::doc::Change, bool) {
    let Some(i) = doc.index_of(arrow_id) else { return (doc.no_change(), false) };
    let arrow = &doc.elements()[i];
    // Arrows bind; lines do not. Excalidraw's `isBindingElement` admits only
    // arrows, so a `line` carrying `startBinding` re-routes here and sits inert
    // there. Enforced at the op rather than only at the call site because this
    // is a `pub` entry point and the endpoint-drag gesture calls it too.
    if !arrow.kind.is_binding_element() {
        return (doc.no_change(), false);
    }
    let Some(points) = arrow.points.clone() else { return (doc.no_change(), false) };
    if points.len() < 2 {
        return (doc.no_change(), false);
    }
    let idx = if at_end { points.len() - 1 } else { 0 };
    let other = if at_end { points.len() - 2 } else { 1 };
    let tip = (arrow.x + points[idx][0], arrow.y + points[idx][1]);
    let from = (arrow.x + points[other][0], arrow.y + points[other][1]);

    let target = binding::bindable_at(doc.elements(), tip.0, tip.1, arrow_id)
        .map(|j| doc.elements()[j].clone());

    let end = if at_end { End::End } else { End::Start };
    let binding = target.as_ref().map(|shape| crate::scene::Binding {
        element_id: shape.id.clone(),
        focus: binding::focus_for(shape, from, tip),
        gap: binding::DEFAULT_GAP,
        rest: Map::new(),
    });
    let bound = binding.is_some();
    let change = doc.apply(Command::Bind { arrow: arrow_id.to_string(), end, binding });
    if bound {
        let ids = vec![arrow_id.to_string()];
        return (reflow_bindings(doc, &ids, None), true);
    }
    (change, false)
}
