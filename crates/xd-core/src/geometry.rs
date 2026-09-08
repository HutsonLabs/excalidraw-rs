//! Bounds, hit-testing and transforms.
//!
//! These rules are a *port*, not an invention. `elementBounds`, `sceneBounds`,
//! `fitTransform` and `cornerRadius` already exist in term.hut's
//! `excalidrawScene.js` and are pinned by its tests; reimplementing them from
//! first principles would let the Rust model and the JS painter disagree about
//! where a thing is, which is the one disagreement a user can see. Match the
//! JS behaviour including its edge cases (negative extents are legal; a
//! zero-width scene must not divide by zero).
//!
//! Pure functions, no allocation in the hot paths.

use crate::scene::{Element, ElementKind};

/// An axis-aligned box in scene coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Bounds {
    pub fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        Bounds { min_x, min_y, max_x, max_y }
    }

    /// The box around two corners, in any order.
    pub fn from_corners(ax: f64, ay: f64, bx: f64, by: f64) -> Self {
        Bounds {
            min_x: ax.min(bx),
            min_y: ay.min(by),
            max_x: ax.max(bx),
            max_y: ay.max(by),
        }
    }

    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }

    pub fn center(&self) -> (f64, f64) {
        ((self.min_x + self.max_x) / 2.0, (self.min_y + self.max_y) / 2.0)
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.min_x && x <= self.max_x && y >= self.min_y && y <= self.max_y
    }

    pub fn intersects(&self, other: &Bounds) -> bool {
        self.min_x <= other.max_x
            && self.max_x >= other.min_x
            && self.min_y <= other.max_y
            && self.max_y >= other.min_y
    }

    /// True when `self` lies entirely inside `other`.
    pub fn inside(&self, other: &Bounds) -> bool {
        self.min_x >= other.min_x
            && self.max_x <= other.max_x
            && self.min_y >= other.min_y
            && self.max_y <= other.max_y
    }

    pub fn union(&self, other: &Bounds) -> Bounds {
        Bounds {
            min_x: self.min_x.min(other.min_x),
            min_y: self.min_y.min(other.min_y),
            max_x: self.max_x.max(other.max_x),
            max_y: self.max_y.max(other.max_y),
        }
    }

    pub fn expand(&self, by: f64) -> Bounds {
        Bounds {
            min_x: self.min_x - by,
            min_y: self.min_y - by,
            max_x: self.max_x + by,
            max_y: self.max_y + by,
        }
    }

    /// `[min_x, min_y, max_x, max_y]` — the shape the WASM boundary hands to
    /// JS, so a repaint can clip without four accessor calls.
    pub fn to_array(&self) -> [f64; 4] {
        [self.min_x, self.min_y, self.max_x, self.max_y]
    }
}

/// The union of `parts`, or `None` when there is nothing to bound.
pub fn union_all<I: IntoIterator<Item = Bounds>>(parts: I) -> Option<Bounds> {
    parts.into_iter().reduce(|a, b| a.union(&b))
}

/// Rotate `(x, y)` about `(cx, cy)` by `angle` radians.
pub fn rotate_point(x: f64, y: f64, cx: f64, cy: f64, angle: f64) -> (f64, f64) {
    if angle == 0.0 {
        return (x, y);
    }
    let (s, c) = angle.sin_cos();
    let dx = x - cx;
    let dy = y - cy;
    (cx + dx * c - dy * s, cy + dx * s + dy * c)
}

/// A finite number, or `fallback`. Mirrors the JS `num()` helper: files in the
/// wild carry nulls and strings where numbers belong.
pub(crate) fn num(v: f64, fallback: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

/// The centre of an element's own box — the point every rotation is about.
pub fn element_center(e: &Element) -> (f64, f64) {
    (e.x + e.width / 2.0, e.y + e.height / 2.0)
}

// --- bounds -----------------------------------------------------------------

/// Excalidraw's own constants, from its source. Named here so the arithmetic
/// below reads as the port it is rather than as magic numbers.
const DEFAULT_ADAPTIVE_RADIUS: f64 = 32.0;
const DEFAULT_PROPORTIONAL_RADIUS: f64 = 0.25;
const ROUNDNESS_PROPORTIONAL: i32 = 2; // legacy
const ROUNDNESS_ADAPTIVE: i32 = 3;

/// A linear or freedraw element's points are relative to its `x`/`y`;
/// everything else is bounded by `x`/`y`/`width`/`height`. `None` for an
/// element with no extent at all.
///
/// Port of `elementBounds` in term.hut's `excalidrawScene.js`, including the
/// case that looks like a bug and is not: an empty `points` array falls
/// through to the width/height box, because that is what a linear element
/// looks like on the first pointer-down before it has any geometry.
pub fn element_bounds(e: &Element) -> Option<Bounds> {
    let x = num(e.x, 0.0);
    let y = num(e.y, 0.0);
    if let Some(points) = e.points.as_ref() {
        if !points.is_empty() {
            let mut min_x = f64::INFINITY;
            let mut min_y = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            for p in points {
                let px = x + num(p[0], 0.0);
                let py = y + num(p[1], 0.0);
                min_x = min_x.min(px);
                min_y = min_y.min(py);
                max_x = max_x.max(px);
                max_y = max_y.max(py);
            }
            if min_x == f64::INFINITY {
                return None;
            }
            return Some(Bounds { min_x, min_y, max_x, max_y });
        }
    }
    let w = num(e.width, 0.0);
    let h = num(e.height, 0.0);
    // Negative extents are legal (a shape dragged up and to the left).
    Some(Bounds::from_corners(x, y, x + w, y + h))
}

/// The axis-aligned box the element occupies *after* its own rotation.
///
/// The pivot is `element_center` — `x + width/2`, `y + height/2` — for every
/// kind, including linear ones whose drawn extent comes from their points and
/// may therefore sit off-centre. That is not an oversight: the JS painter
/// rotates about exactly that point (`excalidrawView.js`, "Rotation is about
/// the element's own centre"), and a model that picked a more defensible pivot
/// would put the selection box somewhere the drawing isn't.
pub fn element_bounds_rotated(e: &Element) -> Option<Bounds> {
    let b = element_bounds(e)?;
    let angle = num(e.angle, 0.0);
    if angle == 0.0 {
        return Some(b);
    }
    let (cx, cy) = element_center(e);
    let (x0, y0) = rotate_point(b.min_x, b.min_y, cx, cy, angle);
    let (x1, y1) = rotate_point(b.max_x, b.min_y, cx, cy, angle);
    let (x2, y2) = rotate_point(b.max_x, b.max_y, cx, cy, angle);
    let (x3, y3) = rotate_point(b.min_x, b.max_y, cx, cy, angle);
    Some(Bounds {
        min_x: x0.min(x1).min(x2).min(x3),
        min_y: y0.min(y1).min(y2).min(y3),
        max_x: x0.max(x1).max(x2).max(x3),
        max_y: y0.max(y1).max(y2).max(y3),
    })
}

/// The box every element fits in, in scene coordinates. `None` for an empty
/// scene, which the caller shows as "nothing to draw" rather than dividing by
/// zero working out a fit.
///
/// Port of `sceneBounds`. Like the JS, it bounds every element it is handed,
/// deleted ones included — the caller filters first if it means visible.
pub fn scene_bounds(elements: &[Element]) -> Option<Bounds> {
    union_all(elements.iter().filter_map(element_bounds))
}

/// Scale and offset that fit a drawing into a viewport.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FitTransform {
    pub scale: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

/// Scale and offset that fit `bounds` into a `vw` x `vh` viewport with a
/// margin, capped at 1:1 — blowing a small sketch up to fill a wide pane looks
/// like a bug.
///
/// Port of `fitTransform`. The two guards it grew are both real files: a scene
/// that is a single vertical line has no width and must not divide by zero,
/// and a pane laid out but not yet sized has no room at all, where the answer
/// is 1:1 at the margin rather than a negative scale.
pub fn fit_transform(bounds: Option<&Bounds>, vw: f64, vh: f64, padding: f64) -> FitTransform {
    let vw = (num(vw, 0.0) - padding * 2.0).max(0.0);
    let vh = (num(vh, 0.0) - padding * 2.0).max(0.0);
    let b = match bounds {
        Some(b) if vw > 0.0 && vh > 0.0 => b,
        _ => return FitTransform { scale: 1.0, offset_x: padding, offset_y: padding },
    };
    let (w, h) = (b.width(), b.height());
    let sx = if w > 0.0 { vw / w } else { f64::INFINITY };
    let sy = if h > 0.0 { vh / h } else { f64::INFINITY };
    // JS reads `Math.min(1, sx, sy) || 1`; the `|| 1` is the zero case, which a
    // viewport smaller than a rounding error can still produce.
    let scale = 1.0_f64.min(sx).min(sy);
    let scale = if scale > 0.0 && scale.is_finite() { scale } else { 1.0 };
    FitTransform {
        scale,
        offset_x: padding + (vw - w * scale) / 2.0 - b.min_x * scale,
        offset_y: padding + (vh - h * scale) / 2.0 - b.min_y * scale,
    }
}

/// The corner radius of a rounded shape, ported from Excalidraw's
/// `getCornerRadius` by way of the JS `cornerRadius`. Two schemes: legacy files
/// scale the radius with the shape, current ones use a fixed radius until the
/// shape gets small enough that it would look wrong, then fall back to
/// proportional.
pub fn corner_radius(e: &Element) -> f64 {
    let r = match e.roundness.as_ref() {
        Some(r) => r,
        None => return 0.0,
    };
    let x = num(e.width, 0.0).abs().min(num(e.height, 0.0).abs());
    if r.kind == ROUNDNESS_PROPORTIONAL {
        return x * DEFAULT_PROPORTIONAL_RADIUS;
    }
    if r.kind != ROUNDNESS_ADAPTIVE {
        return 0.0;
    }
    let fixed = num(r.value.unwrap_or(DEFAULT_ADAPTIVE_RADIUS), DEFAULT_ADAPTIVE_RADIUS);
    let cutoff = fixed / DEFAULT_PROPORTIONAL_RADIUS;
    if x <= cutoff {
        x * DEFAULT_PROPORTIONAL_RADIUS
    } else {
        fixed
    }
}

// --- hit-testing ------------------------------------------------------------

/// Scene point -> element-local point, undoing the element's rotation.
///
/// Every hit test below works in this frame, so each shape only ever has to
/// answer the unrotated question. The frame is the one [`element_bounds`]
/// reports in: rotation is undone about the element's centre, translation is
/// left alone.
pub fn to_local(e: &Element, x: f64, y: f64) -> (f64, f64) {
    let angle = num(e.angle, 0.0);
    if angle == 0.0 {
        return (x, y);
    }
    let (cx, cy) = element_center(e);
    rotate_point(x, y, cx, cy, -angle)
}

/// True when the shape has an interior to click: Excalidraw writes the literal
/// string `"transparent"` for "no fill", and an element that never had the key
/// has no fill either.
fn is_filled(e: &Element) -> bool {
    match e.background_color.as_deref() {
        None | Some("") | Some("transparent") => false,
        Some(_) => true,
    }
}

/// The slop a hit test actually uses. The caller knows the zoom (it passes
/// ~10 / zoom); only the element knows how fat its own stroke is, and a 4 px
/// stroke you cannot click on the middle of feels broken. Excalidraw takes the
/// same maximum.
fn slop(e: &Element, threshold: f64) -> f64 {
    let t = num(threshold, 0.0).max(0.0);
    t.max(num(e.stroke_width.unwrap_or(0.0), 0.0).abs() / 2.0)
}

/// Distance from a point to a line segment. The one primitive every open shape
/// is tested with, so it stays branch-light and allocation-free.
fn dist_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let vx = bx - ax;
    let vy = by - ay;
    let len2 = vx * vx + vy * vy;
    let (qx, qy) = if len2 <= 0.0 {
        (ax, ay) // a degenerate segment is a point
    } else {
        let t = (((px - ax) * vx + (py - ay) * vy) / len2).clamp(0.0, 1.0);
        (ax + t * vx, ay + t * vy)
    };
    ((px - qx).powi(2) + (py - qy).powi(2)).sqrt()
}

/// Within `t` of the box's edge, but not deep inside it — the "click through
/// an unfilled rectangle" rule. A box thinner than `2 * t` has no inside left,
/// and `Bounds::contains` on the inverted shrunk box correctly says so.
fn near_box_outline(b: &Bounds, x: f64, y: f64, t: f64) -> bool {
    b.expand(t).contains(x, y) && !b.expand(-t).contains(x, y)
}

/// Winding-free point-in-polygon (the classic ray cast), over a slice we walk
/// rather than a polygon we build. `f` maps an index to a vertex so both the
/// four-vertex diamond and a freedraw's point list can use it.
fn point_in_polygon(n: usize, x: f64, y: f64, f: impl Fn(usize) -> (f64, f64)) -> bool {
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = f(i);
        let (xj, yj) = f(j);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// The four vertices of a diamond inscribed in `b`, clockwise from the top —
/// the same polygon `drawDiamond` hands to Rough.js.
fn diamond_vertices(b: &Bounds) -> [(f64, f64); 4] {
    let (cx, cy) = b.center();
    [(cx, b.min_y), (b.max_x, cy), (cx, b.max_y), (b.min_x, cy)]
}

/// Is this point on/in the element?
///
/// `threshold` is the stroke-proximity slop in scene units (the caller passes
/// ~10 / zoom). The rule that matters, and the one users feel: a shape with a
/// real `backgroundColor` hits anywhere on its interior, a transparent one only
/// within `threshold` of its outline. That is Excalidraw's own behaviour and
/// people rely on clicking *through* an unfilled rectangle to reach what is
/// behind it — a filled-everywhere model makes a diagram of empty boxes
/// unusable.
///
/// Ellipses and diamonds are tested against their real outlines rather than
/// their boxes, because the corner of an ellipse's box is visibly empty space.
pub fn hit_test(e: &Element, x: f64, y: f64, threshold: f64) -> bool {
    let b = match element_bounds(e) {
        Some(b) => b,
        None => return false,
    };
    let (lx, ly) = to_local(e, x, y);
    let t = slop(e, threshold);

    // Cheap rejection first: nothing outside the padded box can hit anything,
    // and this runs for every element on every pointer move.
    if !b.expand(t).contains(lx, ly) {
        return false;
    }

    match &e.kind {
        ElementKind::Ellipse => hit_ellipse(&b, lx, ly, t, is_filled(e)),
        ElementKind::Diamond => hit_diamond(&b, lx, ly, t, is_filled(e)),
        k if k.has_points() => hit_points(e, &b, lx, ly, t),
        // Text, images and anything we do not model are opaque: their whole box
        // is content, and a transparent-background image is still a picture you
        // clicked on.
        ElementKind::Text | ElementKind::Image | ElementKind::Other(_) => true,
        // A frame is a container, not a shape. Hitting its interior would make
        // everything inside it unselectable, so only its border counts.
        ElementKind::Frame => near_box_outline(&b, lx, ly, t),
        // Rectangle, and any future box shape.
        _ => is_filled(e) || near_box_outline(&b, lx, ly, t),
    }
}

/// An ellipse hit, tested against the ellipse rather than its box.
///
/// The outline band is the region between the ellipse grown by `t` and the one
/// shrunk by `t`. That is an approximation of the true offset curve — exact on
/// both axes, a little generous in between — and it is the right trade for a
/// test that runs per element per pointer move: the alternative is iterating
/// for the closest point on an ellipse, which costs far more than the pixel it
/// would buy.
fn hit_ellipse(b: &Bounds, x: f64, y: f64, t: f64, filled: bool) -> bool {
    let (cx, cy) = b.center();
    let rx = b.width() / 2.0;
    let ry = b.height() / 2.0;
    if rx <= 0.0 || ry <= 0.0 {
        // A degenerate ellipse is a line segment; its box outline is that line.
        return near_box_outline(b, x, y, t);
    }
    let norm = |rx: f64, ry: f64| ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2);
    if norm(rx + t, ry + t) > 1.0 {
        return false;
    }
    if filled {
        return true;
    }
    // Inside the grown ellipse; a hit unless it is also inside the shrunk one.
    rx - t <= 0.0 || ry - t <= 0.0 || norm(rx - t, ry - t) >= 1.0
}

/// A diamond hit, tested against the four edges Excalidraw actually draws.
fn hit_diamond(b: &Bounds, x: f64, y: f64, t: f64, filled: bool) -> bool {
    let v = diamond_vertices(b);
    if filled && point_in_polygon(4, x, y, |i| v[i]) {
        return true;
    }
    for i in 0..4 {
        let (ax, ay) = v[i];
        let (bx, by) = v[(i + 1) % 4];
        if dist_to_segment(x, y, ax, ay, bx, by) <= t {
            return true;
        }
    }
    false
}

/// A line, arrow or freedraw hit: proximity to the polyline its `points`
/// describe. A filled one also hits on its interior, because Excalidraw fills
/// a path whether or not the user closed it exactly.
fn hit_points(e: &Element, b: &Bounds, x: f64, y: f64, t: f64) -> bool {
    let points = match e.points.as_ref() {
        Some(p) if p.len() >= 2 => p,
        // A linear element with no geometry yet is still a thing on the canvas;
        // fall back to its box so it can be selected at all.
        _ => return near_box_outline(b, x, y, t),
    };
    let ox = num(e.x, 0.0);
    let oy = num(e.y, 0.0);
    if is_filled(e) && points.len() >= 3 {
        let inside = point_in_polygon(points.len(), x, y, |i| {
            (ox + num(points[i][0], 0.0), oy + num(points[i][1], 0.0))
        });
        if inside {
            return true;
        }
    }
    for w in points.windows(2) {
        let ax = ox + num(w[0][0], 0.0);
        let ay = oy + num(w[0][1], 0.0);
        let bx = ox + num(w[1][0], 0.0);
        let by = oy + num(w[1][1], 0.0);
        if dist_to_segment(x, y, ax, ay, bx, by) <= t {
            return true;
        }
    }
    false
}

/// True when an element is there to be picked up: not a tombstone, not locked.
///
/// Locked belongs here rather than in the caller because "locked" in Excalidraw
/// means *transparent to the pointer*, not merely unselectable. Filtering the
/// answer afterwards stops the element being selected and still lets it swallow
/// the click, so a locked background photo becomes an unclickable hole over
/// everything behind it — which is the opposite of what locking it was for.
fn is_pickable(e: &Element) -> bool {
    !e.is_deleted && e.locked != Some(true)
}

/// Topmost element under the point (last in z-order wins), by index.
///
/// Deleted elements are skipped: Excalidraw keeps them in the file for undo and
/// for merging another client's edits, and they are not drawn — clicking one
/// would be clicking something invisible. Locked ones are skipped too; see
/// [`is_pickable`].
pub fn hit_test_scene(elements: &[Element], x: f64, y: f64, threshold: f64) -> Option<usize> {
    elements
        .iter()
        .enumerate()
        .rev()
        .find(|(_, e)| is_pickable(e) && hit_test(e, x, y, threshold))
        .map(|(i, _)| i)
}

/// Indices intersecting a marquee, in z-order. `contain = true` requires full
/// containment — the difference between a marquee that grabs anything it
/// brushes and one that only takes what it swallows whole.
///
/// The comparison is against each element's *rotated* box, so a rotated shape
/// is not selected by a marquee that only overlaps the empty corner of its
/// unrotated one.
pub fn marquee_hits(elements: &[Element], area: &Bounds, contain: bool) -> Vec<usize> {
    let mut out = Vec::new();
    for (i, e) in elements.iter().enumerate() {
        if !is_pickable(e) {
            continue;
        }
        if let Some(b) = element_bounds_rotated(e) {
            let hit = if contain { b.inside(area) } else { b.intersects(area) };
            if hit {
                out.push(i);
            }
        }
    }
    out
}

// --- handles and transforms -------------------------------------------------

/// How far above the top edge the rotation handle sits, in **screen pixels**.
///
/// Screen pixels, not scene units, and the `_PX` is load-bearing: a constant in
/// scene units is a handle that sits six pixels above the box at 25% zoom and
/// ninety-six at 400%, which is a handle you cannot reliably grab. Every other
/// measurement in this section is screen-measured for the same reason — the
/// grab radius, the handle size the painter draws — so this one has to be too.
///
/// The value matches `ROTATE_OFFSET` in `excalidrawView.js`. The two are the
/// same handle; if they ever disagree, you can grab a handle where none is
/// drawn.
pub const ROTATE_HANDLE_OFFSET_PX: f64 = 20.0;

/// Scene units per screen pixel — the reciprocal of the zoom — sanitised.
///
/// A zero or a NaN here would drop the rotate handle onto the north handle and
/// make the two one ambiguous target, so a nonsense scale is read as 1:1.
fn scene_per_px(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        1.0
    }
}

/// The box a selection's handles belong on, and the angle to draw it at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SelectionFrame {
    pub bounds: Bounds,
    pub angle: f64,
}

/// The frame for a selection: which box the handles are computed from.
///
/// This is the decomposition, and getting it wrong is subtle because the wrong
/// answer still looks self-consistent on screen. A **single** element is its
/// own *unrotated* box plus its own angle — the box it is written down as, and
/// the frame [`resize_bounds`] returns its answer in — so dragging a corner
/// changes the element's width and height and nothing else. Take the rotated
/// AABB instead and the handles no longer sit on the shape's own edges: a
/// rectangle turned 30° and dragged by its corner resizes its bounding box,
/// which shears the rectangle inside it. Excalidraw resizes in the element's
/// own frame, and so does a user's expectation — they dragged the corner of a
/// rectangle, so a rectangle is what should change size.
///
/// A **multi**-selection has no shared angle to work in, so it falls back to
/// the axis-aligned union of the rotated boxes and an angle of zero. That is
/// also why Excalidraw shows no rotate handle on one, though this crate will
/// happily rotate it if asked.
pub fn selection_frame<'a>(
    elements: impl IntoIterator<Item = &'a Element>,
) -> Option<SelectionFrame> {
    let mut it = elements.into_iter();
    let first = it.next()?;
    let Some(second) = it.next() else {
        let bounds = element_bounds(first)?;
        return Some(SelectionFrame { bounds, angle: num(first.angle, 0.0) });
    };
    let pair = [element_bounds_rotated(first), element_bounds_rotated(second)];
    let mut acc = union_all(pair.into_iter().flatten());
    for e in it {
        if let Some(b) = element_bounds_rotated(e) {
            acc = Some(match acc {
                Some(a) => a.union(&b),
                None => b,
            });
        }
    }
    Some(SelectionFrame { bounds: acc?, angle: 0.0 })
}

/// The eight resize handles and the rotation handle, in the order
/// [`handle_points`] returns them: clockwise from the top-left corner, then
/// rotate.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Handle {
    Nw,
    N,
    Ne,
    E,
    Se,
    S,
    Sw,
    W,
    Rotate,
}

/// The discriminants are part of the WASM boundary — JS receives a handle as an
/// integer, never a string, because hover feedback runs per pointer move
/// (PLAN.md, Phase 4). Do not renumber them.
impl Handle {
    pub fn as_u32(self) -> u32 {
        match self {
            Handle::Nw => 0,
            Handle::N => 1,
            Handle::Ne => 2,
            Handle::E => 3,
            Handle::Se => 4,
            Handle::S => 5,
            Handle::Sw => 6,
            Handle::W => 7,
            Handle::Rotate => 8,
        }
    }

    pub fn from_u32(v: u32) -> Option<Handle> {
        Some(match v {
            0 => Handle::Nw,
            1 => Handle::N,
            2 => Handle::Ne,
            3 => Handle::E,
            4 => Handle::Se,
            5 => Handle::S,
            6 => Handle::Sw,
            7 => Handle::W,
            8 => Handle::Rotate,
            _ => return None,
        })
    }

    /// Which sides of the box this handle moves: -1 west/north, +1 east/south,
    /// 0 for the axis it leaves alone.
    fn axes(self) -> (i32, i32) {
        match self {
            Handle::Nw => (-1, -1),
            Handle::N => (0, -1),
            Handle::Ne => (1, -1),
            Handle::E => (1, 0),
            Handle::Se => (1, 1),
            Handle::S => (0, 1),
            Handle::Sw => (-1, 1),
            Handle::W => (-1, 0),
            Handle::Rotate => (0, 0),
        }
    }
}

/// The nine handle positions for a selection box drawn at `angle`, in scene
/// coordinates, in [`Handle`] order.
///
/// The handles rotate with the selection, which is the whole reason this takes
/// an angle: a rotated shape whose handles stayed axis-aligned would resize
/// along the wrong axes, and the user would be dragging a box that isn't the
/// one they can see. Pass the box from [`selection_frame`], not a rotated AABB.
///
/// `scene_per_px` is the reciprocal of the zoom, and it exists for exactly one
/// position: the rotate handle floats a constant distance above the box *on
/// screen*, so the distance in scene units depends on how far the caller is
/// zoomed in. The other eight sit on the box and need no scale at all.
pub fn handle_points(b: &Bounds, angle: f64, scene_per_px: f64) -> [(f64, f64); 9] {
    let (cx, cy) = b.center();
    let lift = ROTATE_HANDLE_OFFSET_PX * self::scene_per_px(scene_per_px);
    let mut pts = [
        (b.min_x, b.min_y),
        (cx, b.min_y),
        (b.max_x, b.min_y),
        (b.max_x, cy),
        (b.max_x, b.max_y),
        (cx, b.max_y),
        (b.min_x, b.max_y),
        (b.min_x, cy),
        (cx, b.min_y - lift),
    ];
    if angle != 0.0 {
        for p in pts.iter_mut() {
            *p = rotate_point(p.0, p.1, cx, cy, angle);
        }
    }
    pts
}

/// The handle within `radius` of `(x, y)`, or `None`.
///
/// `radius` is in scene units — the caller already divides its screen-pixel
/// grab size by the zoom — while `scene_per_px` places the rotate handle, as
/// in [`handle_points`]. Both are screen-measured quantities arriving in
/// different units because the pointer is in scene coordinates by the time it
/// gets here.
///
/// Rotate is checked first and wins outright. On a small selection its circle
/// overlaps the north handle, and if the nearest-handle rule decided it there
/// would be shapes in a real drawing that simply cannot be rotated.
pub fn handle_at(
    b: &Bounds,
    angle: f64,
    x: f64,
    y: f64,
    radius: f64,
    scene_per_px: f64,
) -> Option<Handle> {
    let pts = handle_points(b, angle, scene_per_px);
    let r2 = radius * radius;
    let d2 = |p: (f64, f64)| (x - p.0).powi(2) + (y - p.1).powi(2);
    if d2(pts[8]) <= r2 {
        return Some(Handle::Rotate);
    }
    let mut best = f64::INFINITY;
    let mut found = None;
    for (i, p) in pts.iter().take(8).enumerate() {
        let d = d2(*p);
        if d <= r2 && d < best {
            best = d;
            found = Handle::from_u32(i as u32);
        }
    }
    found
}

// --- per-point handles ------------------------------------------------------
//
// A second, parallel handle model, and parallel on purpose. The nine
// [`Handle`]s describe a *box*; an arrow's endpoint is not on its box — it is
// one entry of its `points` — so there is no discriminant to add. Extending
// the enum would also renumber a set of integers the WASM boundary and
// `xdWasm.js` both hard-code (see [`Handle`]), for a handle that is not one of
// the nine anyway. So: separate functions, same shape of answer.

/// The grab points on a linear or freedraw element's own geometry: every entry
/// of `points`, in absolute scene coordinates, rotated by the element's angle
/// so the handles sit on the stroke as drawn rather than on the unrotated
/// point list.
///
/// Empty for anything whose shape is a box — a rectangle has no points to
/// grab, and returning its corners here would give the caller two competing
/// answers for the same pixel.
pub fn point_handles(e: &Element) -> Vec<(f64, f64)> {
    let Some(points) = e.points.as_ref().filter(|_| e.kind.has_points()) else {
        return Vec::new();
    };
    let (cx, cy) = element_center(e);
    let angle = num(e.angle, 0.0);
    points
        .iter()
        .map(|p| {
            let (x, y) = (num(e.x, 0.0) + p[0], num(e.y, 0.0) + p[1]);
            rotate_point(x, y, cx, cy, angle)
        })
        .collect()
}

/// The midpoint of every segment between consecutive points, in the same frame
/// as [`point_handles`]. These are the "add a point here" targets Excalidraw
/// shows on a selected line; a two-point arrow has exactly one.
pub fn segment_midpoints(e: &Element) -> Vec<(f64, f64)> {
    let pts = point_handles(e);
    pts.windows(2).map(|w| ((w[0].0 + w[1].0) / 2.0, (w[0].1 + w[1].1) / 2.0)).collect()
}

/// The index of the point within `radius` of `(x, y)`, nearest first, or
/// `None`.
///
/// The last point is tested before the first so that a closed shape — a
/// polygon whose ends coincide — hands the caller the end it can drag onward
/// rather than the one it would drag backwards.
pub fn point_handle_at(e: &Element, x: f64, y: f64, radius: f64) -> Option<usize> {
    nearest_within(&point_handles(e), x, y, radius)
}

/// The index of the *segment* whose midpoint is within `radius` of `(x, y)` —
/// segment `i` runs from point `i` to point `i + 1`.
pub fn segment_midpoint_at(e: &Element, x: f64, y: f64, radius: f64) -> Option<usize> {
    nearest_within(&segment_midpoints(e), x, y, radius)
}

fn nearest_within(pts: &[(f64, f64)], x: f64, y: f64, radius: f64) -> Option<usize> {
    let r2 = radius * radius;
    let mut best = f64::INFINITY;
    let mut found = None;
    for (i, p) in pts.iter().enumerate().rev() {
        let d = (x - p.0).powi(2) + (y - p.1).powi(2);
        if d <= r2 && d < best {
            best = d;
            found = Some(i);
        }
    }
    found
}

// --- container-bound labels -------------------------------------------------

/// The padding Excalidraw leaves between a container's edge and the label
/// inside it (`BOUND_TEXT_PADDING`). Containers apply it twice — once per side
/// — and arrows eight times, because an arrow label floats free of an outline
/// and needs the room.
pub const BOUND_TEXT_PADDING: f64 = 5.0;

/// The width a label bound to this container has to wrap inside.
///
/// The per-kind formulas are Excalidraw's own: a rectangle gives up its
/// padding on both sides, an ellipse the largest inscribed rectangle
/// (`w/2 · √2`), a diamond half its width, and an arrow a fixed fraction of
/// its length. Measurement itself stays in JS — only `ctx.measureText` knows
/// how wide a string is — so this returns the *budget* and the caller returns
/// the wrapped text.
pub fn label_budget(container: &Element) -> f64 {
    let w = num(container.width, 0.0).abs();
    let pad = BOUND_TEXT_PADDING * 2.0;
    let budget = match container.kind {
        ElementKind::Ellipse => w / 2.0 * std::f64::consts::SQRT_2 - pad,
        ElementKind::Diamond => (w / 2.0).round() - pad,
        // `ARROW_LABEL_WIDTH_FRACTION`, and the padding an arrow label gets.
        ElementKind::Arrow => w * 0.7 - BOUND_TEXT_PADDING * 8.0,
        _ => w - pad,
    };
    budget.max(0.0)
}

/// Where a label sits inside its container: the box it should occupy, keeping
/// its own measured `width`/`height` and honouring its `verticalAlign`.
///
/// Horizontally a bound label is always centred — Excalidraw centres the *box*
/// and lets `textAlign` place the glyphs inside it — so this is the one
/// position a container's move, resize or rotation has to put the label back
/// at. It deliberately does not touch the label's size: that is a measurement,
/// and this crate has no font metrics.
pub fn label_position(container: &Element, label: &Element) -> (f64, f64) {
    let cw = num(container.width, 0.0);
    let ch = num(container.height, 0.0);
    let lw = num(label.width, 0.0);
    let lh = num(label.height, 0.0);
    let x = num(container.x, 0.0) + (cw - lw) / 2.0;
    let y = num(container.y, 0.0)
        + match label.vertical_align.as_deref() {
            Some("top") => BOUND_TEXT_PADDING,
            Some("bottom") => ch - lh - BOUND_TEXT_PADDING,
            // Excalidraw's default for bound text, and the only one that keeps
            // a label centred while the container grows in both directions.
            _ => (ch - lh) / 2.0,
        };
    (x, y)
}

/// The bearing from `(cx, cy)` to `(px, py)`, measured clockwise from straight
/// up in a y-down coordinate system — the same convention element angles use.
pub fn bearing(cx: f64, cy: f64, px: f64, py: f64) -> f64 {
    (px - cx).atan2(cy - py)
}

/// The new box when `handle` is dragged to `(px, py)`.
///
/// The box is axis-aligned but drawn rotated by `angle`, so the drag is done in
/// the box's own frame and mapped back: the anchor — the opposite corner, or
/// the centre under `from_center` (alt-drag) — is the one point that must not
/// move on screen, and everything else swings around it. Doing the arithmetic
/// in scene coordinates instead would slide a rotated shape sideways as you
/// resized it.
///
/// A drag past the anchor is not an error. The box flips, and it comes back
/// with min/max normalised, because that is what the user asked for and
/// Excalidraw does the same; the caller turns the flip into negative width or
/// a reversed point list.
pub fn resize_bounds(
    b: &Bounds,
    angle: f64,
    handle: Handle,
    px: f64,
    py: f64,
    lock_aspect: bool,
    from_center: bool,
) -> Bounds {
    let (hx, hy) = handle.axes();
    if hx == 0 && hy == 0 {
        return *b; // Rotate is not a resize; see `rotation_angle`.
    }
    let (cx, cy) = b.center();
    let (lx, ly) = rotate_point(px, py, cx, cy, -angle);

    // The dragged sides follow the pointer. Under `from_center` the opposite
    // side mirrors it, which is what makes alt-drag grow both ways at once.
    let (mut min_x, mut max_x) = (b.min_x, b.max_x);
    let (mut min_y, mut max_y) = (b.min_y, b.max_y);
    match hx {
        -1 => {
            min_x = lx;
            if from_center {
                max_x = 2.0 * cx - lx;
            }
        }
        1 => {
            max_x = lx;
            if from_center {
                min_x = 2.0 * cx - lx;
            }
        }
        _ => {}
    }
    match hy {
        -1 => {
            min_y = ly;
            if from_center {
                max_y = 2.0 * cy - ly;
            }
        }
        1 => {
            max_y = ly;
            if from_center {
                min_y = 2.0 * cy - ly;
            }
        }
        _ => {}
    }

    // Signed, so a flipped drag keeps its direction through the aspect maths.
    let (mut w, mut h) = (max_x - min_x, max_y - min_y);
    let (w0, h0) = (b.width(), b.height());
    if lock_aspect && w0 > 0.0 && h0 > 0.0 {
        let ratio = w0 / h0;
        if hx != 0 && hy != 0 {
            // A corner follows whichever axis the pointer pulled further, so the
            // handle stays under the cursor rather than lagging one axis behind.
            let s = (w.abs() / w0).max(h.abs() / h0);
            w = sign(w) * w0 * s;
            h = sign(h) * h0 * s;
        } else if hx != 0 {
            h = sign(h) * w.abs() / ratio;
        } else {
            w = sign(w) * h.abs() * ratio;
        }
    }

    // Rebuild both axes from the anchor, so whatever the aspect lock did to the
    // extents, the fixed point is still fixed.
    let (ax, ay) = anchor(b, hx, hy, from_center);
    let (min_x, max_x) = span(ax, w, hx, from_center);
    let (min_y, max_y) = span(ay, h, hy, from_center);
    let local = Bounds::from_corners(min_x, min_y, max_x, max_y);

    if angle == 0.0 {
        return local;
    }
    // Back to scene coordinates: the anchor sits where it always did, and the
    // new centre is the anchor plus the (rotated) vector to it.
    let (asx, asy) = rotate_point(ax, ay, cx, cy, angle);
    let (ncx, ncy) = local.center();
    let (s, c) = angle.sin_cos();
    let (vx, vy) = (ncx - ax, ncy - ay);
    let (scx, scy) = (asx + vx * c - vy * s, asy + vx * s + vy * c);
    let (hw, hh) = (local.width() / 2.0, local.height() / 2.0);
    Bounds::new(scx - hw, scy - hh, scx + hw, scy + hh)
}

/// -1 or +1; never 0, so a zero-extent drag still picks a direction instead of
/// collapsing the box's sign.
fn sign(v: f64) -> f64 {
    if v < 0.0 {
        -1.0
    } else {
        1.0
    }
}

/// The point that must not move: the opposite corner, the midpoint of the
/// opposite edge, or the centre under alt-drag. An edge handle anchors at the
/// midpoint so an aspect-locked edge drag grows evenly to both sides.
fn anchor(b: &Bounds, hx: i32, hy: i32, from_center: bool) -> (f64, f64) {
    let (cx, cy) = b.center();
    if from_center {
        return (cx, cy);
    }
    let ax = match hx {
        1 => b.min_x,
        -1 => b.max_x,
        _ => cx,
    };
    let ay = match hy {
        1 => b.min_y,
        -1 => b.max_y,
        _ => cy,
    };
    (ax, ay)
}

/// One axis of the new box, given its anchor and signed extent.
fn span(a: f64, extent: f64, dir: i32, from_center: bool) -> (f64, f64) {
    if from_center || dir == 0 {
        (a - extent / 2.0, a + extent / 2.0)
    } else if dir > 0 {
        (a, a + extent)
    } else {
        (a - extent, a)
    }
}

/// The angle a rotation handle dragged to `(px, py)` implies, snapped to `snap`
/// radians when `snap > 0`, normalised to `[0, 2π)`.
///
/// Zero points straight up, because that is where the handle sits on an
/// unrotated box: the angle is measured from the box centre to the pointer,
/// clockwise, in a y-down coordinate system.
pub fn rotation_angle(b: &Bounds, px: f64, py: f64, snap: f64) -> f64 {
    let (cx, cy) = b.center();
    let mut a = bearing(cx, cy, px, py);
    if snap > 0.0 {
        a = (a / snap).round() * snap;
    }
    a.rem_euclid(std::f64::consts::TAU)
}
