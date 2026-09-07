//! Arrow binding, which PLAN.md calls the likeliest source of "it looks wrong
//! in excalidraw.com".
//!
//! The assertions here are deliberately about *geometry* rather than about
//! field values: a binding that stores the right numbers and puts the arrow in
//! the wrong place is exactly the failure this feature has, and only a test
//! that asks where the arrowhead ended up can see it.

use serde_json::json;
use xd_core::binding::{self, DEFAULT_GAP};
use xd_core::command::Command;
use xd_core::doc::Doc;
use xd_core::geometry::Bounds;
use xd_core::ops;
use xd_core::scene::ElementKind;

/// A document with a shape and a two-point arrow aimed at it from the left.
fn scene(kind: ElementKind) -> (Doc, String, String) {
    let mut doc = Doc::blank();

    let shape = doc.new_element(kind, &Bounds::new(200.0, 100.0, 300.0, 200.0));
    let shape_id = shape.id.clone();
    doc.apply(Command::Insert { at: None, element: Box::new(shape) });

    let mut arrow = doc.new_element(ElementKind::Arrow, &Bounds::new(0.0, 150.0, 190.0, 150.0));
    arrow.points = Some(vec![[0.0, 0.0], [190.0, 0.0]]);
    let arrow_id = arrow.id.clone();
    doc.apply(Command::Insert { at: None, element: Box::new(arrow) });

    (doc, shape_id, arrow_id)
}

/// The arrow's last point, in absolute coordinates.
fn tip(doc: &Doc, arrow_id: &str) -> (f64, f64) {
    let e = &doc.elements()[doc.index_of(arrow_id).unwrap()];
    let p = e.points.as_ref().unwrap();
    let last = p[p.len() - 1];
    (e.x + last[0], e.y + last[1])
}

#[test]
fn an_arrow_bound_to_a_rectangle_stops_outside_it_by_the_gap() {
    let (mut doc, _shape, arrow) = scene(ElementKind::Rectangle);
    let (_, bound) = ops::rebind_end(&mut doc, &arrow, true);
    assert!(bound, "the tip is inside the shape's snap area, so it should bind");

    let (x, y) = tip(&doc, &arrow);
    // The rectangle's left edge is at x = 200; the arrow comes from the left,
    // so it should stop `gap` short of it and stay on its own line.
    assert!((x - (200.0 - DEFAULT_GAP)).abs() < 0.5, "stopped at x = {x}");
    assert!((y - 150.0).abs() < 0.5, "drifted off its own line to y = {y}");
}

#[test]
fn moving_the_shape_drags_the_arrow_with_it() {
    let (mut doc, shape, arrow) = scene(ElementKind::Rectangle);
    ops::rebind_end(&mut doc, &arrow, true);
    let before = tip(&doc, &arrow);

    let ids = vec![shape.clone()];
    ops::translate(&mut doc, &ids, 80.0, 0.0, None);
    ops::reflow_bindings(&mut doc, &ids, None);

    let after = tip(&doc, &arrow);
    assert!(
        (after.0 - before.0 - 80.0).abs() < 0.5,
        "the arrow should have followed: {before:?} -> {after:?}"
    );
}

#[test]
fn an_ellipse_is_met_on_its_curve_not_on_its_box() {
    let (mut doc, shape, arrow) = scene(ElementKind::Ellipse);
    // Aim at the ellipse's upper area so the difference between the curve and
    // the bounding box is real: at the vertical centre the two coincide.
    doc.apply(Command::Patch {
        id: arrow.clone(),
        fields: [("y".to_string(), json!(120.0))].into_iter().collect(),
    });
    ops::rebind_end(&mut doc, &arrow, true);

    let (x, y) = tip(&doc, &arrow);
    let e = &doc.elements()[doc.index_of(&shape).unwrap()];
    let (cx, cy) = (e.x + e.width / 2.0, e.y + e.height / 2.0);
    let (nx, ny) = ((x - cx) / (e.width / 2.0), (y - cy) / (e.height / 2.0));
    let r = (nx * nx + ny * ny).sqrt();
    // Outside the curve (the gap pushes it out) but not out at the corner of
    // the box, which would be r ≈ √2.
    assert!(r > 1.0 && r < 1.2, "met the ellipse at r = {r}, which is not its outline");
}

#[test]
fn binding_at_the_centre_line_stores_a_focus_of_zero() {
    let (mut doc, shape, arrow) = scene(ElementKind::Rectangle);
    ops::rebind_end(&mut doc, &arrow, true);
    let e = &doc.elements()[doc.index_of(&arrow).unwrap()];
    let b = e.end_binding.as_ref().expect("bound");
    assert_eq!(b.element_id, shape);
    assert!(b.focus.abs() < 0.05, "focus was {}", b.focus);
}

#[test]
fn an_endpoint_over_nothing_clears_the_binding() {
    let (mut doc, _shape, arrow) = scene(ElementKind::Rectangle);
    ops::rebind_end(&mut doc, &arrow, true);
    assert!(doc.elements()[doc.index_of(&arrow).unwrap()].end_binding.is_some());

    // Drag the whole arrow far away from the shape, then re-evaluate.
    let ids = vec![arrow.clone()];
    ops::translate(&mut doc, &ids, -1000.0, 0.0, None);
    let (_, bound) = ops::rebind_end(&mut doc, &arrow, true);
    assert!(!bound);
    assert!(doc.elements()[doc.index_of(&arrow).unwrap()].end_binding.is_none());
}

#[test]
fn the_shape_keeps_a_back_reference_to_the_arrow() {
    let (mut doc, shape, arrow) = scene(ElementKind::Rectangle);
    ops::rebind_end(&mut doc, &arrow, true);
    let e = &doc.elements()[doc.index_of(&shape).unwrap()];
    let bound = e.bound_elements.as_ref().expect("boundElements");
    assert!(
        bound.iter().any(|b| b.id == arrow),
        "excalidraw.com reconciles from this back-reference; without it the \
         binding is invisible to every other client"
    );
}

#[test]
fn an_arrow_is_never_bindable_to_another_arrow() {
    let (doc, _shape, arrow) = scene(ElementKind::Arrow);
    let a = &doc.elements()[doc.index_of(&arrow).unwrap()];
    assert!(!binding::is_bindable(a));
}
