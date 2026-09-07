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

use serde_json::{json, Map, Value};

use crate::command::Command;
use crate::doc::Doc;
use crate::geometry::{self, Bounds, Handle};
use crate::scene::{Element, ElementKind};

/// The box around a set of elements, by id. `None` when nothing matched or
/// nothing had an extent.
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
    let Some(before) = selection_bounds(doc, ids) else {
        return doc.no_change();
    };
    // A single rotated element resizes in its own frame; a multi-selection has
    // no shared angle, so it resizes axis-aligned.
    let angle = if ids.len() == 1 {
        doc.index_of(&ids[0]).map(|i| doc.elements()[i].angle).unwrap_or(0.0)
    } else {
        0.0
    };
    let after = geometry::resize_bounds(&before, angle, handle, px, py, lock_aspect, from_center);

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

/// Rotate a selection so its rotate handle follows `(px, py)`.
pub fn rotate(doc: &mut Doc, ids: &[String], px: f64, py: f64, snap: f64, key: Option<&str>) -> crate::doc::Change {
    let Some(b) = selection_bounds(doc, ids) else {
        return doc.no_change();
    };
    let angle = geometry::rotation_angle(&b, px, py, snap);
    let (cx, cy) = b.center();
    let mut cmds = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(i) = doc.index_of(id) else { continue };
        let e = &doc.elements()[i];
        if ids.len() == 1 {
            cmds.push(Command::Patch { id: id.clone(), fields: fields(&[("angle", json!(norm(angle)))]) });
            continue;
        }
        // Several elements turn as a rigid body: each one's own centre orbits
        // the selection's centre, and each one turns by the same delta.
        let (ex, ey) = geometry::element_center(e);
        let (rx, ry) = geometry::rotate_point(ex, ey, cx, cy, angle);
        cmds.push(Command::Patch {
            id: id.clone(),
            fields: fields(&[
                ("x", json!(e.x + rx - ex)),
                ("y", json!(e.y + ry - ey)),
                ("angle", json!(norm(e.angle + angle))),
            ]),
        });
    }
    run(doc, Command::Batch(cmds), key)
}

/// Copies of `ids`, offset so the duplicate is visibly not the original, and
/// selected in its place. Returns the new ids alongside the change.
pub fn duplicate(doc: &mut Doc, ids: &[String], dx: f64, dy: f64) -> (crate::doc::Change, Vec<String>) {
    const OFFSET: f64 = 10.0;
    let dx = if dx == 0.0 && dy == 0.0 { OFFSET } else { dx };
    let dy = if dx == OFFSET && dy == 0.0 { OFFSET } else { dy };
    let mut cmds = Vec::new();
    let mut new_ids = Vec::new();
    for id in ids {
        let Some(i) = doc.index_of(id) else { continue };
        let mut copy: Element = doc.elements()[i].clone();
        // A duplicate is a new element, so it gets a new identity — a fresh
        // id, a fresh seed, and version bookkeeping starting over. Sharing the
        // seed would make the copy stroke-for-stroke identical, which reads as
        // a rendering glitch rather than as two shapes.
        let (id_new, seed) = doc.fresh_identity();
        copy.id = id_new.clone();
        copy.seed = seed;
        copy.x += dx;
        copy.y += dy;
        copy.bound_elements = None;
        copy.start_binding = None;
        copy.end_binding = None;
        new_ids.push(id_new);
        cmds.push(Command::Insert { at: None, element: Box::new(copy) });
    }
    (run(doc, Command::Batch(cmds), None), new_ids)
}

/// Apply a style patch — stroke colour, background, fill style, roughness — to
/// every selected element at once.
pub fn set_style(doc: &mut Doc, ids: &[String], style: &Map<String, Value>) -> crate::doc::Change {
    let cmds = ids
        .iter()
        .filter(|id| doc.index_of(id).is_some())
        .map(|id| Command::Patch { id: id.clone(), fields: style.clone() })
        .collect();
    run(doc, Command::Batch(cmds), None)
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
