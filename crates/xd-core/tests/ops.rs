//! The editor's verbs: drag, resize, rotate, duplicate, style, point-drag.
//!
//! `ops.rs` had no test file at all, which is how a multi-selection rotation
//! came to spin away from the pointer: every one of these operations is called
//! once per pointer event under a single coalesce key, and the property that
//! matters is that **a gesture's result depends on where the pointer is, not on
//! how many samples got there**. A sixty-sample drag and a one-sample drag to
//! the same place must land in the same place. Most of the tests below are that
//! one property, asked of one verb each.

use serde_json::json;
use xd_core::command::Command;
use xd_core::doc::Doc;
use xd_core::geometry::{self, Bounds, Handle};
use xd_core::ops::{self, Axis, Edge, RotateAnchor};
use xd_core::scene::ElementKind;

/// Insert an element of `kind` with the given box, returning its id.
fn add(doc: &mut Doc, kind: ElementKind, b: Bounds) -> String {
    let e = doc.new_element(kind, &b);
    let id = e.id.clone();
    doc.apply(Command::Insert { at: None, element: Box::new(e) });
    id
}

fn el<'a>(doc: &'a Doc, id: &str) -> &'a xd_core::scene::Element {
    &doc.elements()[doc.index_of(id).expect("element is in the scene")]
}

fn center(doc: &Doc, id: &str) -> (f64, f64) {
    geometry::element_center(el(doc, id))
}

/// Two rectangles side by side, and the ids in selection order.
fn pair() -> (Doc, String, String) {
    let mut doc = Doc::blank();
    let a = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 100.0));
    let b = add(&mut doc, ElementKind::Rectangle, Bounds::new(200.0, 0.0, 300.0, 100.0));
    (doc, a, b)
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

#[test]
fn a_multi_selection_rotation_does_not_accumulate_across_samples() {
    let (mut doc, a, b) = pair();
    let ids = vec![a.clone(), b.clone()];
    let frame = ops::selection_bounds(&doc, &ids).unwrap();
    let (cx, cy) = frame.center();

    let anchor = RotateAnchor::new(&doc, &ids).unwrap();
    // A quarter turn, delivered the way a pointer delivers it: many samples
    // along the arc, all under one key. The bug this pins treated each sample's
    // absolute bearing as a delta, so the selection turned by the *sum* of
    // every sample and left the pointer behind on the second event.
    for step in 1..=20 {
        let t = std::f64::consts::FRAC_PI_2 * step as f64 / 20.0;
        let (px, py) = (cx + 200.0 * t.sin(), cy - 200.0 * t.cos());
        ops::rotate(&mut doc, &anchor, px, py, 0.0, Some("rotate:1"));
    }

    let quarter = std::f64::consts::FRAC_PI_2;
    for id in [&a, &b] {
        assert!(
            (el(&doc, id).angle - quarter).abs() < 1e-6,
            "{id} turned to {} instead of a quarter turn",
            el(&doc, id).angle
        );
    }
    // The left rectangle's centre started 100 left of the pivot, so a quarter
    // turn clockwise puts it 100 above it.
    let (ax, ay) = center(&doc, &a);
    assert!((ax - cx).abs() < 1e-6, "x drifted: {ax} vs pivot {cx}");
    assert!((ay - (cy - 100.0)).abs() < 1e-6, "y is {ay}, expected {}", cy - 100.0);
}

#[test]
fn twenty_samples_land_where_one_sample_lands() {
    let quarter = std::f64::consts::FRAC_PI_2;
    let outcome = |samples: usize| {
        let (mut doc, a, b) = pair();
        let ids = vec![a.clone(), b.clone()];
        let frame = ops::selection_bounds(&doc, &ids).unwrap();
        let (cx, cy) = frame.center();
            let anchor = RotateAnchor::new(&doc, &ids).unwrap();
        for step in 1..=samples {
            let t = quarter * step as f64 / samples as f64;
            ops::rotate(
                &mut doc,
                &anchor,
                cx + 200.0 * t.sin(),
                cy - 200.0 * t.cos(),
                0.0,
                Some("rotate:1"),
            );
        }
        (center(&doc, &a), center(&doc, &b), el(&doc, &a).angle)
    };
    let one = outcome(1);
    let many = outcome(20);
    assert!((one.0 .0 - many.0 .0).abs() < 1e-6 && (one.0 .1 - many.0 .1).abs() < 1e-6);
    assert!((one.1 .0 - many.1 .0).abs() < 1e-6 && (one.1 .1 - many.1 .1).abs() < 1e-6);
    assert!((one.2 - many.2).abs() < 1e-6);
}

#[test]
fn a_rotated_selection_keeps_its_shape() {
    let (mut doc, a, b) = pair();
    let ids = vec![a.clone(), b.clone()];
    let before = {
        let (ax, ay) = center(&doc, &a);
        let (bx, by) = center(&doc, &b);
        ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
    };
    let frame = ops::selection_bounds(&doc, &ids).unwrap();
    let anchor = RotateAnchor::new(&doc, &ids).unwrap();
    let (cx, cy) = frame.center();
    ops::rotate(&mut doc, &anchor, cx + 137.0, cy + 42.0, 0.0, None);

    let (ax, ay) = center(&doc, &a);
    let (bx, by) = center(&doc, &b);
    let after = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    assert!((after - before).abs() < 1e-6, "the pair stretched: {before} -> {after}");
    // Both turned by the same amount, which is what makes it one body.
    assert!((el(&doc, &a).angle - el(&doc, &b).angle).abs() < 1e-9);
}

#[test]
fn one_element_turns_to_face_the_pointer() {
    let mut doc = Doc::blank();
    let id = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 100.0));
    let ids = vec![id.clone()];
    let anchor = RotateAnchor::new(&doc, &ids).unwrap();
    // Pointer swung to due east of the centre: the shape faces that way.
    ops::rotate(&mut doc, &anchor, 200.0, 50.0, 0.0, Some("rotate:1"));
    assert!((el(&doc, &id).angle - std::f64::consts::FRAC_PI_2).abs() < 1e-6);
    // And its position is untouched — a single element turns about its own
    // centre, so there is nothing to orbit.
    assert_eq!((el(&doc, &id).x, el(&doc, &id).y), (0.0, 0.0));
}

#[test]
fn one_element_snaps_its_own_angle_to_a_multiple() {
    let mut doc = Doc::blank();
    let id = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 100.0));
    let ids = vec![id.clone()];
    let snap = std::f64::consts::PI / 12.0; // 15°, the editor's shift-rotate
    let anchor = RotateAnchor::new(&doc, &ids).unwrap();
    // 40° from straight up snaps to 45°.
    let t = 40.0_f64.to_radians();
    ops::rotate(&mut doc, &anchor, 50.0 + 200.0 * t.sin(), 50.0 - 200.0 * t.cos(), snap, None);
    let angle = el(&doc, &id).angle;
    assert!((angle - 45.0_f64.to_radians()).abs() < 1e-6, "snapped to {}", angle.to_degrees());
}

#[test]
fn the_first_sample_of_a_turn_is_not_swallowed() {
    // The anchor is taken from where the *handle* was, not from where the first
    // pointer event landed. Anchoring on the first sample instead loses however
    // much rotation that event already carried — a quarter-turn drag delivered
    // in twenty samples would come up one twentieth short.
    let (mut doc, a, b) = pair();
    let ids = vec![a.clone(), b.clone()];
    let anchor = RotateAnchor::new(&doc, &ids).unwrap();
    let (cx, cy) = ops::selection_bounds(&doc, &ids).unwrap().center();
    let t = std::f64::consts::FRAC_PI_2;
    ops::rotate(&mut doc, &anchor, cx + 200.0 * t.sin(), cy - 200.0 * t.cos(), 0.0, Some("r:1"));
    assert!((el(&doc, &a).angle - t).abs() < 1e-9);
    assert!((el(&doc, &b).angle - t).abs() < 1e-9);
}

#[test]
fn a_rotation_of_a_gone_element_is_not_a_panic() {
    let (mut doc, a, b) = pair();
    let ids = vec![a.clone(), b.clone()];
    let frame = ops::selection_bounds(&doc, &ids).unwrap();
    let anchor = RotateAnchor::new(&doc, &ids).unwrap();
    doc.apply(Command::Delete { ids: vec![b] });
    let (cx, cy) = frame.center();
    ops::rotate(&mut doc, &anchor, cx + 100.0, cy, 0.0, None);
    assert!(doc.index_of(&a).is_some());
}

// ---------------------------------------------------------------------------
// Align, distribute, flip
// ---------------------------------------------------------------------------

/// Three boxes of different sizes at different heights, unevenly spaced.
fn three() -> (Doc, Vec<String>) {
    let mut doc = Doc::blank();
    let ids = vec![
        add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 50.0)),
        add(&mut doc, ElementKind::Rectangle, Bounds::new(140.0, 20.0, 180.0, 60.0)),
        add(&mut doc, ElementKind::Rectangle, Bounds::new(300.0, 80.0, 400.0, 100.0)),
    ];
    (doc, ids)
}

fn box_of(doc: &Doc, id: &str) -> [f64; 4] {
    geometry::element_bounds_rotated(el(doc, id)).unwrap().to_array()
}

#[test]
fn align_lines_the_selection_up_on_one_edge() {
    let (mut doc, ids) = three();
    ops::align(&mut doc, &ids, Edge::Left, None);
    for id in &ids {
        assert_eq!(box_of(&doc, id)[0], 0.0, "{id} is not on the left edge");
    }

    let (mut doc, ids) = three();
    ops::align(&mut doc, &ids, Edge::Bottom, None);
    for id in &ids {
        assert_eq!(box_of(&doc, id)[3], 100.0, "{id} is not on the bottom edge");
    }

    let (mut doc, ids) = three();
    ops::align(&mut doc, &ids, Edge::CenterV, None);
    for id in &ids {
        let b = box_of(&doc, id);
        assert!(((b[1] + b[3]) / 2.0 - 50.0).abs() < 1e-9, "{id} centre is {}", (b[1] + b[3]) / 2.0);
    }
}

#[test]
fn align_moves_along_one_axis_only() {
    let (mut doc, ids) = three();
    let before: Vec<f64> = ids.iter().map(|id| el(&doc, id).y).collect();
    ops::align(&mut doc, &ids, Edge::Right, None);
    let after: Vec<f64> = ids.iter().map(|id| el(&doc, id).y).collect();
    assert_eq!(before, after, "a horizontal align must not move anything vertically");
}

#[test]
fn align_needs_two_elements_and_is_one_undo_entry() {
    let (mut doc, ids) = three();
    let revision = doc.revision();
    ops::align(&mut doc, std::slice::from_ref(&ids[0]), Edge::Left, None);
    assert_eq!(doc.revision(), revision, "one element is already aligned with itself");

    ops::align(&mut doc, &ids, Edge::Left, None);
    doc.undo().unwrap();
    assert_eq!(box_of(&doc, &ids[1])[0], 140.0, "one press of undo puts the whole align back");
}

#[test]
fn distribute_evens_the_gaps_not_the_centres() {
    let (mut doc, ids) = three();
    ops::distribute(&mut doc, &ids, Axis::Horizontal, None);
    // The outermost two stay put; the middle one moves so the two gaps match.
    assert_eq!(box_of(&doc, &ids[0])[0], 0.0);
    assert_eq!(box_of(&doc, &ids[2])[2], 400.0);
    let boxes: Vec<[f64; 4]> = ids.iter().map(|id| box_of(&doc, id)).collect();
    let first_gap = boxes[1][0] - boxes[0][2];
    let second_gap = boxes[2][0] - boxes[1][2];
    assert!((first_gap - second_gap).abs() < 1e-9, "gaps are {first_gap} and {second_gap}");
    // Equal gaps rather than equal centres is the whole point: with widths of
    // 100, 40 and 100 across a 400 span, even centres would leave visibly
    // different amounts of white.
    assert!((first_gap - 80.0).abs() < 1e-9, "gap is {first_gap}");
}

#[test]
fn distribute_needs_three_elements() {
    let (mut doc, ids) = three();
    let revision = doc.revision();
    ops::distribute(&mut doc, &ids[..2], Axis::Horizontal, None);
    assert_eq!(doc.revision(), revision, "two elements have one gap and it is already even");
}

#[test]
fn distribute_ignores_the_order_the_ids_arrive_in() {
    let (mut doc, ids) = three();
    ops::distribute(&mut doc, &ids, Axis::Horizontal, None);
    let forwards: Vec<[f64; 4]> = ids.iter().map(|id| box_of(&doc, id)).collect();

    let (mut doc, ids) = three();
    let mut shuffled = ids.clone();
    shuffled.reverse();
    ops::distribute(&mut doc, &shuffled, Axis::Horizontal, None);
    let backwards: Vec<[f64; 4]> = ids.iter().map(|id| box_of(&doc, id)).collect();
    assert_eq!(forwards, backwards);
}

#[test]
fn flipping_a_selection_mirrors_it_about_its_own_centre() {
    let (mut doc, ids) = three();
    let before: Vec<[f64; 4]> = ids.iter().map(|id| box_of(&doc, id)).collect();
    ops::flip(&mut doc, &ids, Axis::Horizontal, None);
    let after: Vec<[f64; 4]> = ids.iter().map(|id| box_of(&doc, id)).collect();
    // The selection box is 0..400; every element's box is reflected in x = 200
    // and untouched in y.
    for (b, a) in before.iter().zip(after.iter()) {
        assert!((a[0] - (400.0 - b[2])).abs() < 1e-9, "{a:?} is not the mirror of {b:?}");
        assert!((a[2] - (400.0 - b[0])).abs() < 1e-9);
        assert_eq!((a[1], a[3]), (b[1], b[3]));
    }
}

#[test]
fn flipping_an_arrow_turns_it_around_rather_than_just_moving_it() {
    let (mut doc, id) = arrow();
    let ids = vec![id.clone()];
    // One element flips in place: same box, reversed direction. The tip is what
    // says it worked — mirroring only the box leaves the arrow pointing the way
    // it always did.
    ops::flip(&mut doc, &ids, Axis::Horizontal, None);
    let e = el(&doc, &id);
    let pts = e.points.as_ref().unwrap();
    assert_eq!(pts[0], [0.0, 0.0], "a linear element's first point is its origin");
    let tip = (e.x + pts[1][0], e.y + pts[1][1]);
    assert!((tip.0 - 0.0).abs() < 1e-9, "the tip should now be at the left end, not {}", tip.0);
    assert_eq!(box_of(&doc, &id), [0.0, 150.0, 190.0, 150.0], "the box must not move");
    // And flipping twice is the identity.
    ops::flip(&mut doc, &ids, Axis::Horizontal, None);
    let e = el(&doc, &id);
    assert_eq!(e.points.as_ref().unwrap()[1], [190.0, 0.0]);
    assert_eq!((e.x, e.y), (0.0, 150.0));
}

#[test]
fn flipping_a_turned_shape_negates_its_angle() {
    let mut doc = Doc::blank();
    let id = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 50.0));
    doc.apply(Command::Patch {
        id: id.clone(),
        fields: [("angle".to_string(), json!(0.4))].into_iter().collect(),
    });
    let before = box_of(&doc, &id);
    ops::flip(&mut doc, std::slice::from_ref(&id), Axis::Vertical, None);
    // A mirror conjugates a rotation into its inverse; the shape's own box is
    // unchanged because it was mirrored about its own centre.
    assert!((el(&doc, &id).angle + 0.4).abs() < 1e-9);
    let after = box_of(&doc, &id);
    for k in 0..4 {
        assert!((after[k] - before[k]).abs() < 1e-9, "{after:?} vs {before:?}");
    }
}

#[test]
fn the_panel_spellings_are_the_ones_the_ops_answer_to() {
    assert_eq!(Edge::parse("centerH"), Some(Edge::CenterH));
    assert_eq!(Edge::parse("bottom"), Some(Edge::Bottom));
    assert_eq!(Edge::parse("middle"), None);
    assert_eq!(Axis::parse("vertical"), Some(Axis::Vertical));
    assert_eq!(Axis::parse("sideways"), None);
}

// ---------------------------------------------------------------------------
// Duplication
// ---------------------------------------------------------------------------

#[test]
fn a_duplicated_group_becomes_a_new_group() {
    let (mut doc, a, b) = pair();
    let ids = vec![a.clone(), b.clone()];
    doc.apply(Command::Group { ids: ids.clone() });
    let original = el(&doc, &a).group_ids.clone();
    assert_eq!(original.len(), 1);

    let (_, copies) = ops::duplicate(&mut doc, &ids, 10.0, 10.0);
    assert_eq!(copies.len(), 2);
    let ga = el(&doc, &copies[0]).group_ids.clone();
    let gb = el(&doc, &copies[1]).group_ids.clone();
    // The copies are grouped with each other...
    assert_eq!(ga, gb, "the duplicated pair must stay one group");
    assert_eq!(ga.len(), 1);
    // ...and not with the originals. ⌘G then ⌘D used to yield four elements in
    // one group, which is visibly wrong the moment the file opens elsewhere.
    assert_ne!(ga, original, "the copy joined the original's group");
    assert_eq!(el(&doc, &a).group_ids, original, "the original's group changed");
}

#[test]
fn duplicating_only_part_of_a_group_still_leaves_the_original_alone() {
    let (mut doc, a, b) = pair();
    doc.apply(Command::Group { ids: vec![a.clone(), b.clone()] });
    let (_, copies) = ops::duplicate(&mut doc, std::slice::from_ref(&a), 10.0, 10.0);
    assert_ne!(el(&doc, &copies[0]).group_ids, el(&doc, &a).group_ids);
}

#[test]
fn a_duplicated_label_follows_its_container_or_lets_go() {
    let mut doc = Doc::blank();
    let rect = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 50.0));
    let text = add(&mut doc, ElementKind::Text, Bounds::new(10.0, 10.0, 60.0, 35.0));
    doc.apply(Command::BindLabel { container: rect.clone(), text: text.clone() });

    // Both copied: the copy of the label names the copy of the container, and
    // the copy of the container names the copy of the label. Neither names the
    // original.
    let (_, copies) = ops::duplicate(&mut doc, &[rect.clone(), text.clone()], 10.0, 10.0);
    let (rect2, text2) = (copies[0].clone(), copies[1].clone());
    assert_eq!(el(&doc, &text2).container_id.as_deref(), Some(rect2.as_str()));
    let bound = el(&doc, &rect2).bound_elements.clone().unwrap();
    assert_eq!(bound.len(), 1);
    assert_eq!(bound[0].id, text2);
    assert_eq!(bound[0].kind, "text");

    // The label alone: it has no container in the set, so it lets go rather
    // than claiming one that already has a label.
    let (_, lone) = ops::duplicate(&mut doc, std::slice::from_ref(&text), 10.0, 10.0);
    assert_eq!(el(&doc, &lone[0]).container_id, None);
}

#[test]
fn a_duplicate_drops_its_bindings_and_takes_a_new_seed() {
    let mut doc = Doc::blank();
    let shape = add(&mut doc, ElementKind::Rectangle, Bounds::new(200.0, 100.0, 300.0, 200.0));
    let arrow = add(&mut doc, ElementKind::Arrow, Bounds::new(0.0, 150.0, 190.0, 150.0));
    doc.apply(Command::Patch {
        id: arrow.clone(),
        fields: [("points".to_string(), json!([[0.0, 0.0], [190.0, 0.0]]))].into_iter().collect(),
    });
    ops::rebind_end(&mut doc, &arrow, true);
    assert!(el(&doc, &arrow).end_binding.is_some());

    let seed = el(&doc, &arrow).seed;
    let (_, copies) = ops::duplicate(&mut doc, std::slice::from_ref(&arrow), 10.0, 10.0);
    assert!(el(&doc, &copies[0]).end_binding.is_none(), "a copied arrow would point at the original");
    assert_ne!(el(&doc, &copies[0]).seed, seed, "an identical seed draws an identical stroke");
    // The shape keeps its one back-reference, to the original arrow only.
    assert_eq!(el(&doc, &shape).bound_elements.as_ref().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Container-bound labels
// ---------------------------------------------------------------------------

/// A rectangle with a label centred in it.
fn labelled() -> (Doc, String, String) {
    let mut doc = Doc::blank();
    let rect = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 200.0, 100.0));
    let text = add(&mut doc, ElementKind::Text, Bounds::new(60.0, 40.0, 140.0, 60.0));
    doc.apply(Command::Patch {
        id: text.clone(),
        fields: [("verticalAlign".to_string(), json!("middle"))].into_iter().collect(),
    });
    doc.apply(Command::BindLabel { container: rect.clone(), text: text.clone() });
    (doc, rect, text)
}

#[test]
fn dragging_a_container_carries_its_label() {
    let (mut doc, rect, text) = labelled();
    let ids = vec![rect.clone()];
    ops::translate(&mut doc, &ids, 100.0, 100.0, Some("drag:1"));
    ops::reflow_labels(&mut doc, &ids, Some("drag:1"));

    let (rx, ry) = (el(&doc, &rect).x, el(&doc, &rect).y);
    let label = el(&doc, &text);
    assert!((label.x - (rx + (200.0 - label.width) / 2.0)).abs() < 1e-6, "label x is {}", label.x);
    assert!((label.y - (ry + (100.0 - label.height) / 2.0)).abs() < 1e-6, "label y is {}", label.y);
}

#[test]
fn resizing_a_container_recentres_its_label() {
    let (mut doc, rect, text) = labelled();
    let ids = vec![rect.clone()];
    ops::resize(&mut doc, &ids, Handle::Se, 400.0, 300.0, false, false, Some("resize:se"));
    ops::reflow_labels(&mut doc, &ids, Some("resize:se"));

    let container = el(&doc, &rect).clone();
    let label = el(&doc, &text);
    let (x, y) = geometry::label_position(&container, label);
    assert!((label.x - x).abs() < 1e-6 && (label.y - y).abs() < 1e-6);
    // The label's own size is a measurement JS owns; a resize must not invent
    // one. Only the position moved.
    assert_eq!((label.width, label.height), (80.0, 20.0));
}

#[test]
fn rotating_a_container_turns_its_label_with_it() {
    let (mut doc, rect, text) = labelled();
    let ids = vec![rect.clone()];
    let anchor = RotateAnchor::new(&doc, &ids).unwrap();
    ops::rotate(&mut doc, &anchor, 300.0, 50.0, 0.0, Some("rotate:1"));
    ops::reflow_labels(&mut doc, &ids, Some("rotate:1"));
    assert!((el(&doc, &text).angle - el(&doc, &rect).angle).abs() < 1e-9);
}

#[test]
fn a_container_that_did_not_move_does_not_bump_its_label() {
    let (mut doc, rect, text) = labelled();
    // Put the label where the reflow would put it, then reflow: nothing to do,
    // and a version bump here would mean every unrelated gesture rewrote the
    // label.
    let container = el(&doc, &rect).clone();
    let (x, y) = geometry::label_position(&container, el(&doc, &text));
    doc.apply(Command::Patch {
        id: text.clone(),
        fields: [("x".to_string(), json!(x)), ("y".to_string(), json!(y))].into_iter().collect(),
    });
    let version = el(&doc, &text).version;
    ops::reflow_labels(&mut doc, &[rect], None);
    assert_eq!(el(&doc, &text).version, version);
}

#[test]
fn the_label_budget_leaves_room_for_the_padding() {
    let mut doc = Doc::blank();
    let rect = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 200.0, 100.0));
    assert_eq!(geometry::label_budget(el(&doc, &rect)), 190.0);
    let ellipse = add(&mut doc, ElementKind::Ellipse, Bounds::new(0.0, 0.0, 200.0, 100.0));
    // The largest rectangle inscribed in the ellipse, less the padding.
    let expected = 100.0 * std::f64::consts::SQRT_2 - 10.0;
    assert!((geometry::label_budget(el(&doc, &ellipse)) - expected).abs() < 1e-9);
    // Never negative, however small the container gets.
    let tiny = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 2.0, 2.0));
    assert_eq!(geometry::label_budget(el(&doc, &tiny)), 0.0);
}

// ---------------------------------------------------------------------------
// Point dragging
// ---------------------------------------------------------------------------

/// A two-point arrow from (0, 150) to (190, 150).
fn arrow() -> (Doc, String) {
    let mut doc = Doc::blank();
    let id = add(&mut doc, ElementKind::Arrow, Bounds::new(0.0, 150.0, 190.0, 150.0));
    doc.apply(Command::Patch {
        id: id.clone(),
        fields: [("points".to_string(), json!([[0.0, 0.0], [190.0, 0.0]]))].into_iter().collect(),
    });
    (doc, id)
}

#[test]
fn moving_the_last_point_leaves_the_origin_alone() {
    let (mut doc, id) = arrow();
    ops::move_point(&mut doc, &id, 1, 300.0, 250.0, Some("point:1"));
    let e = el(&doc, &id);
    assert_eq!((e.x, e.y), (0.0, 150.0));
    assert_eq!(e.points.as_ref().unwrap()[1], [300.0, 100.0]);
    assert_eq!((e.width, e.height), (300.0, 100.0));
}

#[test]
fn moving_the_first_point_moves_the_origin_with_it() {
    let (mut doc, id) = arrow();
    ops::move_point(&mut doc, &id, 0, -10.0, 100.0, Some("point:1"));
    let e = el(&doc, &id);
    // The origin is point 0, so it becomes the pointer and everything else is
    // re-expressed relative to it.
    assert_eq!((e.x, e.y), (-10.0, 100.0));
    let pts = e.points.as_ref().unwrap();
    assert_eq!(pts[0], [0.0, 0.0]);
    assert_eq!(pts[1], [200.0, 50.0]);
}

#[test]
fn a_point_index_past_the_end_is_declined() {
    let (mut doc, id) = arrow();
    let before = el(&doc, &id).version;
    ops::move_point(&mut doc, &id, 7, 0.0, 0.0, None);
    assert_eq!(el(&doc, &id).version, before);
}

#[test]
fn a_box_has_no_points_to_drag() {
    let mut doc = Doc::blank();
    let id = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 100.0));
    let before = el(&doc, &id).version;
    ops::move_point(&mut doc, &id, 0, 50.0, 50.0, None);
    assert_eq!(el(&doc, &id).version, before);
    assert!(geometry::point_handles(el(&doc, &id)).is_empty());
}

#[test]
fn point_handles_are_the_points_in_scene_coordinates() {
    let (doc, id) = arrow();
    let handles = geometry::point_handles(el(&doc, &id));
    assert_eq!(handles, vec![(0.0, 150.0), (190.0, 150.0)]);
    let mids = geometry::segment_midpoints(el(&doc, &id));
    assert_eq!(mids, vec![(95.0, 150.0)]);
    // The grab radius is scene units, as `handle_at`'s is.
    assert_eq!(geometry::point_handle_at(el(&doc, &id), 188.0, 152.0, 8.0), Some(1));
    assert_eq!(geometry::point_handle_at(el(&doc, &id), 95.0, 150.0, 8.0), None);
    assert_eq!(geometry::segment_midpoint_at(el(&doc, &id), 95.0, 150.0, 8.0), Some(0));
}

#[test]
fn a_turned_element_has_its_handles_on_the_stroke() {
    let (mut doc, id) = arrow();
    // A quarter turn about the arrow's own centre, (95, 150).
    doc.apply(Command::Patch {
        id: id.clone(),
        fields: [("angle".to_string(), json!(std::f64::consts::FRAC_PI_2))].into_iter().collect(),
    });
    let handles = geometry::point_handles(el(&doc, &id));
    // The horizontal arrow now runs vertically through its centre.
    assert!((handles[0].0 - 95.0).abs() < 1e-6 && (handles[0].1 - 55.0).abs() < 1e-6);
    assert!((handles[1].0 - 95.0).abs() < 1e-6 && (handles[1].1 - 245.0).abs() < 1e-6);
}

#[test]
fn inserting_a_point_bends_the_segment_it_was_asked_for() {
    let (mut doc, id) = arrow();
    // Segment 0 runs from point 0 to point 1, so the new point lands between
    // them — at index 1, not at index 0.
    ops::insert_point(&mut doc, &id, 0, 95.0, 250.0, Some("point:1"));
    let e = el(&doc, &id);
    let pts = e.points.as_ref().unwrap();
    assert_eq!(pts.len(), 3);
    assert_eq!(pts[0], [0.0, 0.0], "the origin is still the origin");
    assert_eq!(pts[1], [95.0, 100.0]);
    assert_eq!(pts[2], [190.0, 0.0], "the far end kept its place");
    // The origin cannot move, but the extent grew with the bend.
    assert_eq!((e.x, e.y), (0.0, 150.0));
    assert_eq!((e.width, e.height), (190.0, 100.0));

    // And it is one undo entry.
    doc.undo().unwrap();
    assert_eq!(el(&doc, &id).points.as_ref().unwrap().len(), 2);
}

#[test]
fn a_later_segment_inserts_later_in_the_list() {
    let (mut doc, id) = arrow();
    ops::insert_point(&mut doc, &id, 0, 95.0, 250.0, None);
    // Now three points, so segment 1 is the second half.
    ops::insert_point(&mut doc, &id, 1, 140.0, 200.0, None);
    let pts = el(&doc, &id).points.clone().unwrap();
    assert_eq!(pts.len(), 4);
    assert_eq!(pts[2], [140.0, 50.0], "segment 1's new point belongs at index 2");
    assert_eq!(pts[3], [190.0, 0.0]);
}

#[test]
fn a_segment_that_does_not_exist_is_declined() {
    let (mut doc, id) = arrow();
    let version = el(&doc, &id).version;
    // A two-point arrow has exactly one segment, numbered 0.
    ops::insert_point(&mut doc, &id, 1, 50.0, 50.0, None);
    ops::insert_point(&mut doc, &id, 9, 50.0, 50.0, None);
    assert_eq!(el(&doc, &id).version, version);

    // And a box has no segments at all.
    let mut doc = Doc::blank();
    let box_id = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 100.0));
    let version = el(&doc, &box_id).version;
    ops::insert_point(&mut doc, &box_id, 0, 50.0, 50.0, None);
    assert_eq!(el(&doc, &box_id).version, version);
}

#[test]
fn inserting_a_point_keeps_both_ends_bound() {
    let mut doc = Doc::blank();
    let shape = add(&mut doc, ElementKind::Rectangle, Bounds::new(200.0, 100.0, 300.0, 200.0));
    let id = add(&mut doc, ElementKind::Arrow, Bounds::new(0.0, 150.0, 190.0, 150.0));
    doc.apply(Command::Patch {
        id: id.clone(),
        fields: [("points".to_string(), json!([[0.0, 0.0], [190.0, 0.0]]))].into_iter().collect(),
    });
    ops::rebind_end(&mut doc, &id, true);
    assert!(el(&doc, &id).end_binding.is_some());

    // Bending the arrow does not move either endpoint, so unlike a point
    // *drag* there is nothing to unbind.
    ops::insert_point(&mut doc, &id, 0, 95.0, 400.0, Some("point:1"));
    ops::reflow_bindings(&mut doc, std::slice::from_ref(&id), Some("point:1"));
    assert_eq!(
        el(&doc, &id).end_binding.as_ref().map(|b| b.element_id.as_str()),
        Some(shape.as_str())
    );
    // The bound tip re-aims, because it is now approached from the new point
    // rather than from the far end.
    let pts = el(&doc, &id).points.clone().unwrap();
    let e = el(&doc, &id);
    let tip = (e.x + pts[2][0], e.y + pts[2][1]);
    assert!(tip.1 > 150.0, "the tip should have swung down towards the bend: {tip:?}");
}

#[test]
fn inserting_a_point_does_not_claim_a_draft_is_in_progress() {
    // `lastCommittedPoint` says how far a multi-point *draw* has got. Bending an
    // existing arrow is not drawing one, and writing the field here would make
    // every edited line look mid-gesture to Excalidraw.
    let (mut doc, id) = arrow();
    ops::insert_point(&mut doc, &id, 0, 95.0, 250.0, None);
    assert_eq!(el(&doc, &id).last_committed_point, None);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

#[test]
fn a_resketch_changes_the_seed_and_a_plain_style_change_does_not() {
    let mut doc = Doc::blank();
    let id = add(&mut doc, ElementKind::Rectangle, Bounds::new(0.0, 0.0, 100.0, 100.0));
    let ids = vec![id.clone()];
    let patch: serde_json::Map<String, serde_json::Value> =
        [("roughness".to_string(), json!(2.0))].into_iter().collect();

    let seed = el(&doc, &id).seed;
    ops::set_style(&mut doc, &ids, &patch, false);
    assert_eq!(el(&doc, &id).seed, seed, "a style change must not re-scramble the strokes");
    assert_eq!(el(&doc, &id).roughness, Some(2.0));

    ops::set_style(&mut doc, &ids, &patch, true);
    assert_ne!(el(&doc, &id).seed, seed, "a sloppiness change is a different sketch");
    assert_eq!(el(&doc, &id).roughness, Some(2.0));

    // And it is one undo entry: the roughness and the seed go back together,
    // because a shape with the new roughness and the old seed is a state
    // nobody asked for.
    doc.undo().unwrap();
    assert_eq!(el(&doc, &id).seed, seed);
}

#[test]
fn selection_bounds_is_the_box_the_selection_occupies() {
    let (doc, a, b) = pair();
    let bounds = ops::selection_bounds(&doc, &[a, b]).unwrap();
    assert_eq!(bounds.to_array(), [0.0, 0.0, 300.0, 100.0]);
    assert_eq!(ops::selection_bounds(&doc, &["nobody".to_string()]), None);
}
