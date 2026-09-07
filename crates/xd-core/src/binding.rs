//! Arrow binding: the geometry that makes an arrow follow the shape it points
//! at.
//!
//! PLAN.md makes this its own milestone on purpose. It is the highest-value
//! interop feature — a bound arrow is what turns an agent-authored diagram
//! into an editable one — and it is the one most likely to be got subtly
//! wrong, because "wrong" here does not look like a crash. It looks like a
//! diagram that is fine in this editor and visibly detached in
//! excalidraw.com.
//!
//! Excalidraw's model, and the two numbers that matter:
//!
//! - **`focus`** — where across the shape the arrow aims, as a signed ratio
//!   roughly in -1..1. Zero aims at the centre; ±1 grazes the edge. It is
//!   stored rather than recomputed so that dragging a shape moves the arrow
//!   without the arrow sliding around the shape's outline.
//! - **`gap`** — how far short of the outline the arrow stops, so the
//!   arrowhead does not overlap the border it points at.
//!
//! Both are held on the arrow. The shape carries only a back-reference in
//! `boundElements`, which `Command::Bind` maintains.

use crate::geometry::{self, Bounds};
use crate::scene::{Element, ElementKind};

/// How close a pointer must come to a shape for an arrow endpoint to snap to
/// it, in scene units. Excalidraw's own hit area for this is generous —
/// binding is the behaviour people want by default, and a binding that refuses
/// to happen is more annoying than one that has to be undone.
pub const BINDING_THRESHOLD: f64 = 12.0;

/// The default gap for a newly bound arrow: enough that the arrowhead reads as
/// pointing *at* the shape rather than *into* it.
pub const DEFAULT_GAP: f64 = 4.0;

/// A shape an arrow endpoint at `(x, y)` should bind to, if any.
///
/// Bindable means: a closed shape, not the arrow itself, and not another
/// linear element — Excalidraw does not bind arrows to arrows, and an editor
/// that did would produce files it could not reopen faithfully.
pub fn bindable_at(elements: &[Element], x: f64, y: f64, skip: &str) -> Option<usize> {
    let mut found = None;
    for (i, e) in elements.iter().enumerate() {
        if e.is_deleted || e.id == skip || !is_bindable(e) {
            continue;
        }
        let Some(b) = geometry::element_bounds_rotated(e) else { continue };
        // Inside, or within the snap threshold of the outline. Later elements
        // win, matching the z-order rule everywhere else in this crate.
        if b.expand(BINDING_THRESHOLD).contains(x, y) {
            found = Some(i);
        }
    }
    found
}

/// True for the shapes an arrow may bind to.
pub fn is_bindable(e: &Element) -> bool {
    matches!(
        e.kind,
        ElementKind::Rectangle
            | ElementKind::Diamond
            | ElementKind::Ellipse
            | ElementKind::Image
            | ElementKind::Text
            | ElementKind::Frame
    )
}

/// The `focus` to store for an arrow that currently points at `(x, y)` on
/// `shape`, coming from `from`.
///
/// Captured at bind time rather than recomputed on every move: recomputing
/// would make the arrow slide around the shape as the shape is dragged, which
/// is exactly the behaviour binding exists to prevent.
pub fn focus_for(shape: &Element, from: (f64, f64), at: (f64, f64)) -> f64 {
    let Some(b) = geometry::element_bounds(shape) else { return 0.0 };
    let (cx, cy) = b.center();
    // Work in the shape's own frame so a rotated shape's focus means the same
    // thing it would unrotated.
    let (fx, fy) = geometry::rotate_point(from.0, from.1, cx, cy, -shape.angle);
    let (ax, ay) = geometry::rotate_point(at.0, at.1, cx, cy, -shape.angle);

    // The offset of the aim point from the centre, measured across the axis
    // the arrow approaches along — so an arrow coming in horizontally reports
    // how far up or down the shape it lands, and vice versa.
    let dx = (fx - cx).abs();
    let dy = (fy - cy).abs();
    let (offset, half) = if dx > dy {
        (ay - cy, b.height() / 2.0)
    } else {
        (ax - cx, b.width() / 2.0)
    };
    if half.abs() < 1e-9 {
        return 0.0;
    }
    (offset / half).clamp(-1.0, 1.0)
}

/// Where an arrow coming from `from` should stop, given a binding to `shape`.
///
/// The aim point is the shape's centre pushed off-axis by `focus`; the arrow
/// then stops where the segment to that point crosses the shape's outline,
/// backed off by `gap`.
pub fn binding_point(shape: &Element, from: (f64, f64), focus: f64, gap: f64) -> (f64, f64) {
    let Some(b) = geometry::element_bounds(shape) else { return from };
    let (cx, cy) = b.center();
    let angle = shape.angle;

    // Everything below happens unrotated; the result is rotated back at the
    // end. A rotated diamond is a diamond, but only in its own frame.
    let (fx, fy) = geometry::rotate_point(from.0, from.1, cx, cy, -angle);

    let dx = (fx - cx).abs();
    let dy = (fy - cy).abs();
    let (tx, ty) = if dx > dy {
        (cx, cy + focus * b.height() / 2.0)
    } else {
        (cx + focus * b.width() / 2.0, cy)
    };

    let hit = outline_hit(shape, &b, (fx, fy), (tx, ty)).unwrap_or((tx, ty));
    // Back off along the incoming direction by `gap`.
    let (vx, vy) = (fx - hit.0, fy - hit.1);
    let len = (vx * vx + vy * vy).sqrt();
    let stopped = if len > 1e-9 {
        (hit.0 + vx / len * gap, hit.1 + vy / len * gap)
    } else {
        hit
    };
    geometry::rotate_point(stopped.0, stopped.1, cx, cy, angle)
}

/// Where the segment from `from` to `to` first crosses the shape's outline,
/// in the shape's own unrotated frame.
///
/// `to` is inside the shape by construction (it is the centre, offset by a
/// focus that is clamped to the box), so there is exactly one crossing and the
/// bisection below always converges.
fn outline_hit(shape: &Element, b: &Bounds, from: (f64, f64), to: (f64, f64)) -> Option<(f64, f64)> {
    if inside(shape, b, from) {
        return None;
    }
    // Bisection rather than a closed form per shape: a diamond, an ellipse and
    // a rounded rectangle each want their own algebra, and forty iterations of
    // a predicate we already have is exact to well under a pixel and cannot
    // disagree with hit-testing about where the edge is.
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        let p = (from.0 + (to.0 - from.0) * mid, from.1 + (to.1 - from.1) * mid);
        if inside(shape, b, p) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    Some((from.0 + (to.0 - from.0) * hi, from.1 + (to.1 - from.1) * hi))
}

/// Is a point inside the shape's outline, in its own unrotated frame?
fn inside(shape: &Element, b: &Bounds, p: (f64, f64)) -> bool {
    let (cx, cy) = b.center();
    let (hw, hh) = (b.width() / 2.0, b.height() / 2.0);
    if hw < 1e-9 || hh < 1e-9 {
        return false;
    }
    let (nx, ny) = ((p.0 - cx) / hw, (p.1 - cy) / hh);
    match shape.kind {
        ElementKind::Ellipse => nx * nx + ny * ny <= 1.0,
        ElementKind::Diamond => nx.abs() + ny.abs() <= 1.0,
        _ => nx.abs() <= 1.0 && ny.abs() <= 1.0,
    }
}
