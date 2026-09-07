//! Phase 2 geometry, pinned.
//!
//! The first half of this file is not a fresh test suite: it is the assertions
//! from term.hut's `ui/test/excalidrawScene.test.js`, transcribed number for
//! number. `elementBounds`, `sceneBounds`, `fitTransform` and `cornerRadius`
//! are ported code, and the point of porting rather than reinventing is that
//! the Rust model and the JS painter can never disagree about where a thing
//! is. If one of these ever needs its number changed, the JS test is changed in
//! the same commit or the port has silently forked.
//!
//! Elements are built from JSON on purpose. It is the shape a real file has,
//! it keeps the fixtures readable next to their JS originals, and it exercises
//! the deserializer every hit test will actually be fed by.

use serde_json::{json, Value};
use xd_core::geometry::*;
use xd_core::scene::Element;

/// The JS test's `rect()` fixture, field for field.
fn rect(over: Value) -> Element {
    el(
        json!({
            "id": "r1", "type": "rectangle", "x": 10, "y": 20, "width": 100, "height": 50,
            "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent",
            "fillStyle": "hachure", "strokeWidth": 2, "strokeStyle": "solid",
            "roughness": 1, "opacity": 100, "seed": 12345
        }),
        over,
    )
}

fn el(base: Value, over: Value) -> Element {
    let mut m = base.as_object().expect("fixture is an object").clone();
    if let Value::Object(o) = over {
        for (k, v) in o {
            m.insert(k, v);
        }
    }
    serde_json::from_value(Value::Object(m)).expect("fixture deserializes")
}

#[track_caller]
fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

#[track_caller]
fn close_bounds(a: &Bounds, b: (f64, f64, f64, f64)) {
    close(a.min_x, b.0);
    close(a.min_y, b.1);
    close(a.max_x, b.2);
    close(a.max_y, b.3);
}

// --- bounds: ported from excalidrawScene.test.js ----------------------------

#[test]
fn a_shape_is_bounded_by_its_box() {
    assert_eq!(element_bounds(&rect(json!({}))), Some(Bounds::new(10.0, 20.0, 110.0, 70.0)));
}

#[test]
fn a_shape_dragged_up_and_left_has_negative_extents_and_still_bounds_correctly() {
    let b = element_bounds(&rect(json!({ "width": -100, "height": -50 })));
    assert_eq!(b, Some(Bounds::new(-90.0, -30.0, 10.0, 20.0)));
}

#[test]
fn a_linear_elements_points_are_relative_to_its_origin() {
    let line = el(
        json!({ "id": "l1", "type": "line", "x": 100, "y": 100,
                "points": [[0, 0], [50, -20], [10, 30]] }),
        json!({}),
    );
    assert_eq!(element_bounds(&line), Some(Bounds::new(100.0, 80.0, 150.0, 130.0)));
}

#[test]
fn an_empty_point_list_falls_back_to_the_box() {
    // The state a linear element is in between pointer-down and the first move.
    let line = el(
        json!({ "id": "l1", "type": "line", "x": 5, "y": 5, "width": 0, "height": 0,
                "points": [] }),
        json!({}),
    );
    assert_eq!(element_bounds(&line), Some(Bounds::new(5.0, 5.0, 5.0, 5.0)));
}

#[test]
fn scene_bounds_are_the_union() {
    let els =
        vec![rect(json!({})), rect(json!({ "x": 200, "y": 0, "width": 10, "height": 10 }))];
    let b = scene_bounds(&els).expect("two elements have bounds");
    assert_eq!(b, Bounds::new(10.0, 0.0, 210.0, 70.0));
    assert_eq!((b.width(), b.height()), (200.0, 70.0));
}

#[test]
fn an_empty_scene_has_no_bounds_which_the_caller_shows_as_empty() {
    assert_eq!(scene_bounds(&[]), None);
}

#[test]
fn fit_centres_the_drawing_and_never_enlarges_past_one_to_one() {
    let b = scene_bounds(&[rect(json!({}))]);
    let t = fit_transform(b.as_ref(), 1000.0, 800.0, 32.0);
    assert_eq!(t.scale, 1.0);
}

#[test]
fn fit_shrinks_a_drawing_that_overflows_the_pane() {
    let b = scene_bounds(&[rect(json!({ "width": 2000, "height": 1000 }))]);
    let t = fit_transform(b.as_ref(), 500.0, 500.0, 0.0);
    close(t.scale, 0.25);
}

#[test]
fn a_zero_width_scene_doesnt_divide_by_zero() {
    let line = el(
        json!({ "id": "l1", "type": "line", "x": 0, "y": 0, "points": [[0, 0], [0, 100]] }),
        json!({}),
    );
    let b = scene_bounds(&[line]);
    let t = fit_transform(b.as_ref(), 400.0, 400.0, 32.0);
    assert!(t.scale.is_finite());
    assert!(t.scale > 0.0);
}

#[test]
fn fitting_into_a_pane_with_no_room_falls_back_rather_than_going_negative() {
    let b = scene_bounds(&[rect(json!({}))]);
    let t = fit_transform(b.as_ref(), 0.0, 0.0, 32.0);
    assert_eq!(t.scale, 1.0);
    assert_eq!((t.offset_x, t.offset_y), (32.0, 32.0));
}

#[test]
fn fit_centres_what_it_shrinks() {
    // Not in the JS suite, but the offsets are half the function and the JS
    // only ever asserted the scale.
    let b = Bounds::new(0.0, 0.0, 1000.0, 1000.0);
    let t = fit_transform(Some(&b), 500.0, 500.0, 0.0);
    close(t.scale, 0.5);
    close(t.offset_x, 0.0);
    close(t.offset_y, 0.0);
}

#[test]
fn adaptive_corner_radius_is_fixed_above_the_cutoff_and_proportional_below() {
    let fixed = rect(json!({ "roundness": { "type": 3 }, "width": 400, "height": 300 }));
    let small = rect(json!({ "roundness": { "type": 3 }, "width": 400, "height": 40 }));
    assert_eq!(corner_radius(&fixed), 32.0);
    assert_eq!(corner_radius(&small), 10.0);
}

#[test]
fn legacy_proportional_roundness_is_a_quarter_of_the_short_side() {
    let e = rect(json!({ "roundness": { "type": 2 }, "width": 400, "height": 80 }));
    assert_eq!(corner_radius(&e), 20.0);
}

#[test]
fn a_sharp_cornered_shape_has_no_radius() {
    assert_eq!(corner_radius(&rect(json!({}))), 0.0);
    assert_eq!(corner_radius(&rect(json!({ "roundness": null }))), 0.0);
}

// --- rotated bounds ---------------------------------------------------------

#[test]
fn a_quarter_turn_swaps_the_box_about_the_elements_centre() {
    let e = rect(json!({ "angle": std::f64::consts::FRAC_PI_2 }));
    // 100x50 about (60, 45) becomes 50x100 about the same point.
    let b = element_bounds_rotated(&e).expect("a rectangle has bounds");
    close_bounds(&b, (35.0, -5.0, 85.0, 95.0));
}

#[test]
fn a_square_turned_forty_five_degrees_grows_to_its_diagonal() {
    let e = rect(json!({ "x": 0, "y": 0, "width": 100, "height": 100,
                         "angle": std::f64::consts::FRAC_PI_4 }));
    let b = element_bounds_rotated(&e).expect("a rectangle has bounds");
    let half = 100.0 * std::f64::consts::SQRT_2 / 2.0;
    close_bounds(&b, (50.0 - half, 50.0 - half, 50.0 + half, 50.0 + half));
}

#[test]
fn an_unrotated_element_is_its_own_rotated_box() {
    let e = rect(json!({}));
    assert_eq!(element_bounds_rotated(&e), element_bounds(&e));
}

// --- local space ------------------------------------------------------------

#[test]
fn to_local_undoes_the_rotation_about_the_centre() {
    let e = rect(json!({ "angle": std::f64::consts::FRAC_PI_2 }));
    // The centre is fixed by its own rotation.
    let (lx, ly) = to_local(&e, 60.0, 45.0);
    close(lx, 60.0);
    close(ly, 45.0);
    // A point below the centre in scene space is to its right in local space.
    let (lx, ly) = to_local(&e, 60.0, 90.0);
    close(lx, 105.0);
    close(ly, 45.0);
}

// --- hit-testing ------------------------------------------------------------

#[test]
fn an_unfilled_rectangle_is_clicked_through() {
    // The rule users rely on: a diagram of empty boxes stays usable because the
    // inside of an unfilled box belongs to whatever is behind it.
    let e = rect(json!({}));
    assert!(!hit_test(&e, 60.0, 45.0, 10.0), "the interior of a transparent box is not a hit");
    assert!(hit_test(&e, 10.0, 45.0, 10.0), "its outline is");
    assert!(hit_test(&e, 14.0, 45.0, 10.0), "and so is just inside its outline");
    assert!(!hit_test(&e, 10.0, 5.0, 10.0), "well outside is not");
}

#[test]
fn a_filled_rectangle_is_hit_anywhere_inside() {
    let e = rect(json!({ "backgroundColor": "#ffc9c9" }));
    assert!(hit_test(&e, 60.0, 45.0, 10.0));
    assert!(!hit_test(&e, 10.0, 5.0, 10.0));
}

#[test]
fn a_fat_stroke_is_clickable_along_its_whole_width() {
    // The caller only knows the zoom; the element knows how fat it is.
    let e = rect(json!({ "strokeWidth": 40 }));
    assert!(hit_test(&e, 10.0, 45.0, 0.0));
}

#[test]
fn an_ellipse_uses_its_outline_not_its_box() {
    let filled = rect(json!({ "type": "ellipse", "backgroundColor": "#ffc9c9" }));
    // The corner of the box is visibly empty space, filled or not.
    assert!(!hit_test(&filled, 12.0, 22.0, 10.0));
    assert!(hit_test(&filled, 60.0, 45.0, 10.0));

    let hollow = rect(json!({ "type": "ellipse" }));
    assert!(!hit_test(&hollow, 60.0, 45.0, 10.0), "the centre of a hollow ellipse is empty");
    assert!(hit_test(&hollow, 110.0, 45.0, 10.0), "its rightmost point is on the curve");
}

#[test]
fn a_diamond_uses_its_outline_not_its_box() {
    let filled = rect(json!({ "type": "diamond", "backgroundColor": "#ffc9c9" }));
    assert!(!hit_test(&filled, 12.0, 22.0, 10.0), "the box corner is outside the diamond");
    assert!(hit_test(&filled, 60.0, 45.0, 10.0));

    let hollow = rect(json!({ "type": "diamond" }));
    assert!(!hit_test(&hollow, 60.0, 45.0, 10.0));
    assert!(hit_test(&hollow, 60.0, 20.0, 10.0), "the top vertex is on the outline");
}

#[test]
fn a_line_is_hit_near_its_segments() {
    let line = el(
        json!({ "id": "l1", "type": "line", "x": 100, "y": 100,
                "points": [[0, 0], [50, -20], [10, 30]] }),
        json!({}),
    );
    assert!(hit_test(&line, 125.0, 90.0, 10.0), "the midpoint of the first segment");
    assert!(!hit_test(&line, 149.0, 129.0, 10.0), "a corner of its box it never passes through");
}

#[test]
fn a_freedraw_stroke_is_hit_near_its_path() {
    let stroke = el(
        json!({ "id": "f1", "type": "freedraw", "x": 0, "y": 0,
                "points": [[0, 0], [10, 10], [20, 0], [30, 10]] }),
        json!({}),
    );
    assert!(hit_test(&stroke, 5.0, 5.0, 2.0));
    assert!(!hit_test(&stroke, 15.0, 12.0, 2.0));
}

#[test]
fn a_closed_filled_path_is_hit_on_its_inside() {
    let poly = el(
        json!({ "id": "l1", "type": "line", "x": 0, "y": 0, "backgroundColor": "#ffc9c9",
                "points": [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]] }),
        json!({}),
    );
    assert!(hit_test(&poly, 50.0, 50.0, 2.0));
    let hollow = el(
        json!({ "id": "l2", "type": "line", "x": 0, "y": 0,
                "points": [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]] }),
        json!({}),
    );
    assert!(!hit_test(&hollow, 50.0, 50.0, 2.0));
}

#[test]
fn text_is_hit_on_its_box_however_it_is_filled() {
    let t = el(
        json!({ "id": "t1", "type": "text", "x": 0, "y": 0, "width": 100, "height": 25,
                "text": "hello", "backgroundColor": "transparent" }),
        json!({}),
    );
    assert!(hit_test(&t, 50.0, 12.0, 10.0));
    assert!(!hit_test(&t, 200.0, 12.0, 10.0));
}

#[test]
fn a_frame_is_hit_on_its_border_so_its_contents_stay_reachable() {
    let f = el(
        json!({ "id": "fr1", "type": "frame", "x": 0, "y": 0, "width": 400, "height": 300 }),
        json!({}),
    );
    assert!(hit_test(&f, 0.0, 150.0, 10.0));
    assert!(!hit_test(&f, 200.0, 150.0, 10.0));
}

#[test]
fn hit_testing_undoes_the_rotation_first() {
    let e = rect(json!({ "angle": std::f64::consts::FRAC_PI_2, "backgroundColor": "#ffc9c9" }));
    // Inside the rotated shape, outside the box it was written down as.
    assert!(hit_test(&e, 60.0, 90.0, 1.0));
    assert!(!hit_test(&e, 105.0, 45.0, 1.0));
}

#[test]
fn the_topmost_element_wins() {
    let els = vec![
        rect(json!({ "id": "under", "backgroundColor": "#ffc9c9" })),
        rect(json!({ "id": "over", "backgroundColor": "#a5d8ff" })),
    ];
    assert_eq!(hit_test_scene(&els, 60.0, 45.0, 10.0), Some(1));
    assert_eq!(hit_test_scene(&els, 500.0, 500.0, 10.0), None);
}

#[test]
fn a_deleted_element_is_not_clickable() {
    // Excalidraw keeps deleted elements in the file for undo and for merging
    // another client's edits. They are not drawn, so they cannot be hit.
    let els = vec![
        rect(json!({ "id": "under", "backgroundColor": "#ffc9c9" })),
        rect(json!({ "id": "gone", "backgroundColor": "#a5d8ff", "isDeleted": true })),
    ];
    assert_eq!(hit_test_scene(&els, 60.0, 45.0, 10.0), Some(0));
}

// --- marquee ----------------------------------------------------------------

#[test]
fn a_marquee_takes_what_it_brushes_or_only_what_it_swallows() {
    let els =
        vec![rect(json!({})), rect(json!({ "x": 200, "y": 0, "width": 10, "height": 10 }))];
    let all = Bounds::new(0.0, 0.0, 300.0, 300.0);
    assert_eq!(marquee_hits(&els, &all, false), vec![0, 1]);
    assert_eq!(marquee_hits(&els, &all, true), vec![0, 1]);

    let corner = Bounds::new(0.0, 0.0, 50.0, 50.0);
    assert_eq!(marquee_hits(&els, &corner, false), vec![0]);
    assert!(marquee_hits(&els, &corner, true).is_empty());
}

#[test]
fn a_marquee_sees_the_rotated_box() {
    // A tall thin shape turned on its side reaches sideways, and a marquee that
    // only overlaps where it now *is* must still catch it.
    let e = rect(json!({ "x": 0, "y": 0, "width": 20, "height": 200,
                         "angle": std::f64::consts::FRAC_PI_2 }));
    let els = vec![e];
    let sideways = Bounds::new(-95.0, 90.0, -80.0, 110.0);
    assert_eq!(marquee_hits(&els, &sideways, false), vec![0]);
}

#[test]
fn a_deleted_element_is_not_in_a_marquee() {
    let els = vec![rect(json!({ "isDeleted": true }))];
    assert!(marquee_hits(&els, &Bounds::new(0.0, 0.0, 300.0, 300.0), false).is_empty());
}

// --- handles ----------------------------------------------------------------

#[test]
fn handles_sit_on_the_box_with_rotate_above_it() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let p = handle_points(&b, 0.0);
    assert_eq!(p[Handle::Nw.as_u32() as usize], (0.0, 0.0));
    assert_eq!(p[Handle::N.as_u32() as usize], (50.0, 0.0));
    assert_eq!(p[Handle::Ne.as_u32() as usize], (100.0, 0.0));
    assert_eq!(p[Handle::E.as_u32() as usize], (100.0, 50.0));
    assert_eq!(p[Handle::Se.as_u32() as usize], (100.0, 100.0));
    assert_eq!(p[Handle::S.as_u32() as usize], (50.0, 100.0));
    assert_eq!(p[Handle::Sw.as_u32() as usize], (0.0, 100.0));
    assert_eq!(p[Handle::W.as_u32() as usize], (0.0, 50.0));
    assert_eq!(p[Handle::Rotate.as_u32() as usize], (50.0, -ROTATE_HANDLE_OFFSET));
}

#[test]
fn handles_rotate_with_the_selection() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let p = handle_points(&b, std::f64::consts::PI);
    close(p[0].0, 100.0);
    close(p[0].1, 100.0);
    close(p[8].0, 50.0);
    close(p[8].1, 100.0 + ROTATE_HANDLE_OFFSET);
}

#[test]
fn handle_at_finds_the_one_under_the_pointer() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    assert_eq!(handle_at(&b, 0.0, 100.0, 100.0, 8.0), Some(Handle::Se));
    assert_eq!(handle_at(&b, 0.0, 50.0, -ROTATE_HANDLE_OFFSET, 8.0), Some(Handle::Rotate));
    assert_eq!(handle_at(&b, 0.0, 50.0, 50.0, 8.0), None);
}

#[test]
fn rotate_wins_an_overlap_or_a_small_shape_could_never_be_turned() {
    let tiny = Bounds::new(0.0, 0.0, 1.0, 1.0);
    // Nearest would say N; rotate is checked first on purpose.
    assert_eq!(handle_at(&tiny, 0.0, 0.5, -1.0, 30.0), Some(Handle::Rotate));
}

#[test]
fn handle_numbering_round_trips() {
    for v in 0..9 {
        let h = Handle::from_u32(v).expect("0..9 are handles");
        assert_eq!(h.as_u32(), v);
    }
    assert_eq!(Handle::from_u32(9), None);
}

// --- resize -----------------------------------------------------------------

#[test]
fn dragging_the_se_handle_moves_two_edges_and_pins_the_other_two() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let r = resize_bounds(&b, 0.0, Handle::Se, 200.0, 150.0, false, false);
    close_bounds(&r, (0.0, 0.0, 200.0, 150.0));
}

#[test]
fn an_edge_handle_moves_only_its_own_edge() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let r = resize_bounds(&b, 0.0, Handle::W, -50.0, 999.0, false, false);
    close_bounds(&r, (-50.0, 0.0, 100.0, 100.0));
}

#[test]
fn a_box_dragged_past_its_anchor_flips_and_comes_back_normalised() {
    // Legal, and the caller turns it into negative width or a reversed point
    // list. Refusing the drag instead is the bug.
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let r = resize_bounds(&b, 0.0, Handle::Se, -50.0, -30.0, false, false);
    close_bounds(&r, (-50.0, -30.0, 0.0, 0.0));
}

#[test]
fn alt_drag_resizes_about_the_centre() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let r = resize_bounds(&b, 0.0, Handle::E, 150.0, 0.0, false, true);
    close_bounds(&r, (-50.0, 0.0, 150.0, 100.0));
}

#[test]
fn an_aspect_locked_corner_follows_the_axis_the_pointer_pulled_further() {
    let b = Bounds::new(0.0, 0.0, 100.0, 50.0);
    let r = resize_bounds(&b, 0.0, Handle::Se, 300.0, 60.0, true, false);
    close_bounds(&r, (0.0, 0.0, 300.0, 150.0));
}

#[test]
fn an_aspect_locked_edge_grows_the_other_axis_evenly() {
    let b = Bounds::new(0.0, 0.0, 100.0, 50.0);
    let r = resize_bounds(&b, 0.0, Handle::E, 200.0, 0.0, true, false);
    // Twice as wide, so twice as tall, centred on the anchored edge.
    close_bounds(&r, (0.0, -25.0, 200.0, 75.0));
}

#[test]
fn the_rotate_handle_is_not_a_resize() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    assert_eq!(resize_bounds(&b, 0.0, Handle::Rotate, 500.0, 500.0, false, false), b);
}

#[test]
fn a_rotated_box_resizes_along_its_own_axes() {
    // Turned a quarter turn, the box's own +x axis points down the screen, so
    // pulling the SE handle downwards makes the shape wider in its own frame —
    // and the returned box is in that frame, not the screen's.
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let angle = std::f64::consts::FRAC_PI_2;
    let se = handle_points(&b, angle)[Handle::Se.as_u32() as usize];
    let r = resize_bounds(&b, angle, Handle::Se, se.0, se.1 + 100.0, false, false);
    close(r.width(), 200.0);
    close(r.height(), 100.0);
    // And the anchor — the NW corner — has not moved on screen, which is the
    // whole reason the arithmetic happens in the local frame.
    let anchor_before = handle_points(&b, angle)[Handle::Nw.as_u32() as usize];
    let anchor_after = handle_points(&r, angle)[Handle::Nw.as_u32() as usize];
    close(anchor_after.0, anchor_before.0);
    close(anchor_after.1, anchor_before.1);
}

// --- rotation ---------------------------------------------------------------

#[test]
fn zero_points_straight_up_where_the_handle_starts() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    close(rotation_angle(&b, 50.0, -24.0, 0.0), 0.0);
    close(rotation_angle(&b, 150.0, 50.0, 0.0), std::f64::consts::FRAC_PI_2);
    close(rotation_angle(&b, 50.0, 150.0, 0.0), std::f64::consts::PI);
    close(rotation_angle(&b, -50.0, 50.0, 0.0), 3.0 * std::f64::consts::FRAC_PI_2);
}

#[test]
fn a_snapped_rotation_lands_on_a_multiple() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let snap = std::f64::consts::FRAC_PI_2;
    close(rotation_angle(&b, 150.0, 60.0, snap), snap);
    close(rotation_angle(&b, 55.0, -24.0, snap), 0.0);
}

#[test]
fn a_rotation_is_normalised_into_one_turn() {
    let b = Bounds::new(0.0, 0.0, 100.0, 100.0);
    let a = rotation_angle(&b, 49.0, 150.0, 0.0);
    assert!((0.0..std::f64::consts::TAU).contains(&a), "got {a}");
    assert!(a > std::f64::consts::PI, "just past half a turn, not just under minus one");
}

// --- properties -------------------------------------------------------------

proptest::proptest! {
    /// The one invariant a selection tool cannot survive being wrong about.
    #[test]
    fn a_point_inside_a_filled_rectangle_is_always_hit(
        x in -500.0f64..500.0, y in -500.0f64..500.0,
        w in 1.0f64..500.0, h in 1.0f64..500.0,
        fx in 0.0f64..1.0, fy in 0.0f64..1.0,
    ) {
        let e = rect(serde_json::json!({
            "x": x, "y": y, "width": w, "height": h, "backgroundColor": "#ffc9c9"
        }));
        proptest::prop_assert!(hit_test(&e, x + fx * w, y + fy * h, 1.0));
    }

    /// A full turn is no turn. The bounds are recomputed through sin/cos, so
    /// this is really a check that the pivot never drifts.
    #[test]
    fn rotating_by_a_full_turn_is_the_identity(
        x in -500.0f64..500.0, y in -500.0f64..500.0,
        w in -500.0f64..500.0, h in -500.0f64..500.0,
    ) {
        let plain = rect(serde_json::json!({ "x": x, "y": y, "width": w, "height": h }));
        let turned = rect(serde_json::json!({
            "x": x, "y": y, "width": w, "height": h, "angle": std::f64::consts::TAU
        }));
        let a = element_bounds(&plain).unwrap();
        let b = element_bounds_rotated(&turned).unwrap();
        proptest::prop_assert!((a.min_x - b.min_x).abs() < 1e-6);
        proptest::prop_assert!((a.min_y - b.min_y).abs() < 1e-6);
        proptest::prop_assert!((a.max_x - b.max_x).abs() < 1e-6);
        proptest::prop_assert!((a.max_y - b.max_y).abs() < 1e-6);
    }

    /// Dragging a handle to where it already is must change nothing — at any
    /// angle. A drag that nudges the shape on pointer-down is the classic
    /// symptom of doing this arithmetic in the wrong frame.
    #[test]
    fn dragging_a_handle_onto_itself_is_a_no_op(
        min_x in -500.0f64..500.0, min_y in -500.0f64..500.0,
        w in 1.0f64..500.0, h in 1.0f64..500.0,
        angle in 0.0f64..std::f64::consts::TAU,
        which in 0u32..8,
    ) {
        let b = Bounds::new(min_x, min_y, min_x + w, min_y + h);
        let handle = Handle::from_u32(which).unwrap();
        let p = handle_points(&b, angle)[which as usize];
        for from_center in [false, true] {
            let r = resize_bounds(&b, angle, handle, p.0, p.1, false, from_center);
            proptest::prop_assert!((r.min_x - b.min_x).abs() < 1e-6, "{r:?} != {b:?}");
            proptest::prop_assert!((r.min_y - b.min_y).abs() < 1e-6, "{r:?} != {b:?}");
            proptest::prop_assert!((r.max_x - b.max_x).abs() < 1e-6, "{r:?} != {b:?}");
            proptest::prop_assert!((r.max_y - b.max_y).abs() < 1e-6, "{r:?} != {b:?}");
        }
    }

    /// Marquee containment implies intersection, whatever the angle. The two
    /// modes disagreeing is how a "select all" ends up missing a shape.
    #[test]
    fn containment_implies_intersection(
        x in -200.0f64..200.0, y in -200.0f64..200.0,
        w in 1.0f64..200.0, h in 1.0f64..200.0,
        angle in 0.0f64..std::f64::consts::TAU,
    ) {
        let els = vec![rect(serde_json::json!({
            "x": x, "y": y, "width": w, "height": h, "angle": angle
        }))];
        let area = Bounds::new(-1000.0, -1000.0, 1000.0, 1000.0);
        let contained = marquee_hits(&els, &area, true);
        let touched = marquee_hits(&els, &area, false);
        proptest::prop_assert!(contained.iter().all(|i| touched.contains(i)));
    }
}
