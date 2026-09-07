//! Phase 3's acceptance gate: a scene that has been edited at random and then
//! fully undone must be the scene we started with.
//!
//! The fuzz test at the bottom is the one that matters. Everything above it is
//! a named case for a rule that fuzzing would catch only as "something,
//! somewhere, differs" — the seed that must never be rewritten, the binding
//! that has two halves, the four-hundred-event drag that must be one press of
//! undo. When the fuzz test fails, one of the named tests usually fails too
//! and says why.
//!
//! The comparison is *exact*, `version`/`versionNonce`/`updated` included.
//! That is a deliberate reading of what undo means here (see the `doc.rs`
//! header): undo restores the previous bytes rather than applying a second
//! edit, so opening a file and undoing back to the start leaves it
//! byte-identical. `bookkeeping_is_restored_too` pins that separately from the
//! rest so a failure tells you which of the two properties broke.

use serde_json::{json, Map, Value};

use xd_core::command::{Command, End, Reorder};
use xd_core::doc::{index_between, indices_between, Doc, COALESCE_WINDOW_MS};
use xd_core::geometry::Bounds;
use xd_core::ids::Rng;
use xd_core::scene::{Binding, ElementKind, Scene};

// ---------------------------------------------------------------------------
// A starting scene with teeth in it
// ---------------------------------------------------------------------------

/// A scene chosen to be awkward: unknown keys at every level, an arrow bound
/// at both ends, a text element in a container, a freedraw with pressures, a
/// group, and an element type this crate does not model. If undo can restore
/// this, it can restore a real file.
fn seed_json() -> String {
    json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "unknownTopLevelKey": { "kept": true },
        "elements": [
            {
                "id": "rect", "type": "rectangle",
                "x": 10.0, "y": 20.0, "width": 100.0, "height": 60.0, "angle": 0.0,
                "seed": 111111, "version": 7, "versionNonce": 222222, "updated": 1700000000000i64,
                "strokeColor": "#1e1e1e", "backgroundColor": "transparent",
                "boundElements": [{ "id": "arrow", "type": "arrow" }, { "id": "label", "type": "text" }],
                "customData": { "note": "an unknown field that must survive" },
                "index": "a1"
            },
            {
                "id": "ellipse", "type": "ellipse",
                "x": 300.0, "y": 40.0, "width": 80.0, "height": 80.0, "angle": 0.35,
                "seed": 333333, "version": 3, "versionNonce": 444444, "updated": 1700000000001i64,
                "boundElements": [{ "id": "arrow", "type": "arrow" }],
                "index": "a2"
            },
            {
                "id": "arrow", "type": "arrow",
                "x": 110.0, "y": 50.0, "width": 190.0, "height": 30.0, "angle": 0.0,
                "seed": 555555, "version": 12, "versionNonce": 666666, "updated": 1700000000002i64,
                "points": [[0.0, 0.0], [95.0, 10.0], [190.0, 30.0]],
                "startBinding": { "elementId": "rect", "focus": 0.1, "gap": 4.0, "fixedPoint": null },
                "endBinding": { "elementId": "ellipse", "focus": -0.2, "gap": 6.0 },
                "index": "a3"
            },
            {
                "id": "label", "type": "text",
                "x": 20.0, "y": 40.0, "width": 60.0, "height": 25.0, "angle": 0.0,
                "seed": 777777, "version": 2, "versionNonce": 888888, "updated": 1700000000003i64,
                "text": "hello", "originalText": "hello", "fontSize": 20, "fontFamily": 1,
                "containerId": "rect", "lineHeight": 1.25,
                "index": "a4"
            },
            {
                "id": "scribble", "type": "freedraw",
                "x": 0.0, "y": 200.0, "width": 40.0, "height": 30.0, "angle": 0.0,
                "seed": 999999, "version": 1, "versionNonce": 101010, "updated": 1700000000004i64,
                "points": [[0.0, 0.0], [10.0, 12.0], [40.0, 30.0]],
                "pressures": [0.1, 0.5, 0.9],
                "groupIds": ["grp"],
                "index": "a5"
            },
            {
                "id": "diamond", "type": "diamond",
                "x": 150.0, "y": 250.0, "width": 70.0, "height": 70.0, "angle": 0.0,
                "seed": 121212, "version": 4, "versionNonce": 131313, "updated": 1700000000005i64,
                "groupIds": ["grp"],
                "index": "a6"
            },
            {
                "id": "embed", "type": "embeddable",
                "x": 400.0, "y": 300.0, "width": 200.0, "height": 120.0, "angle": 0.0,
                "seed": 141414, "version": 1, "versionNonce": 151515, "updated": 1700000000006i64,
                "link": "https://example.com", "index": "a7"
            }
        ],
        "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
        "files": { "someFile": { "mimeType": "image/png" } }
    })
    .to_string()
}

fn seed_doc() -> Doc {
    let mut doc = Doc::from_json(&seed_json()).expect("the fixture parses");
    doc.set_seed(0xd0c);
    doc.set_now(1_700_000_100_000);
    doc
}

/// The same scene with every element's bookkeeping flattened. Comparing this
/// first separates "an edit was not inverted" from "an edit was inverted but
/// the version counter drifted", which are different bugs with different
/// fixes.
fn without_bookkeeping(scene: &Scene) -> Scene {
    let mut s = scene.clone();
    for e in &mut s.elements {
        e.version = 0;
        e.version_nonce = 0;
        e.updated = None;
    }
    s
}

fn undo_all(doc: &mut Doc) -> usize {
    let mut n = 0;
    while doc.undo().is_some() {
        n += 1;
    }
    n
}

fn redo_all(doc: &mut Doc) -> usize {
    let mut n = 0;
    while doc.redo().is_some() {
        n += 1;
    }
    n
}

fn get<'a>(doc: &'a Doc, id: &str) -> &'a xd_core::scene::Element {
    let i = doc.index_of(id).unwrap_or_else(|| panic!("no element {id}"));
    &doc.elements()[i]
}

fn ids(doc: &Doc) -> Vec<String> {
    doc.elements().iter().map(|e| e.id.clone()).collect()
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

#[test]
fn patch_bumps_version_and_stamps_the_clock() {
    let mut doc = seed_doc();
    let before = get(&doc, "rect").clone();

    doc.apply(Command::move_to("rect", 55.0, 66.0));

    let after = get(&doc, "rect");
    assert_eq!(after.x, 55.0);
    assert_eq!(after.y, 66.0);
    assert_eq!(after.version, before.version + 1);
    assert_ne!(after.version_nonce, before.version_nonce);
    assert_eq!(after.updated, Some(1_700_000_100_000));
}

#[test]
fn a_patch_carrying_a_seed_is_ignored() {
    let mut doc = seed_doc();
    let seed = get(&doc, "rect").seed;

    let mut fields = Map::new();
    fields.insert("seed".to_string(), json!(424242));
    fields.insert("x".to_string(), json!(1.0));
    doc.apply(Command::Patch {
        id: "rect".to_string(),
        fields,
    });

    // The rest of the patch still lands — dropping the seed is a filter, not
    // a rejection of the whole edit.
    assert_eq!(get(&doc, "rect").x, 1.0);
    assert_eq!(
        get(&doc, "rect").seed,
        seed,
        "Rough.js is deterministic in the seed; rewriting it makes the strokes twitch"
    );
}

#[test]
fn a_patch_carrying_an_id_is_ignored() {
    let mut doc = seed_doc();
    let mut fields = Map::new();
    fields.insert("id".to_string(), json!("somethingElse"));
    fields.insert("angle".to_string(), json!(1.0));
    doc.apply(Command::Patch {
        id: "rect".to_string(),
        fields,
    });
    assert_eq!(get(&doc, "rect").angle, 1.0);
    assert!(doc.index_of("somethingElse").is_none());
}

#[test]
fn a_no_op_command_is_not_history() {
    let mut doc = seed_doc();
    let rev = doc.revision();
    doc.apply(Command::Patch {
        id: "rect".to_string(),
        fields: Map::new(),
    });
    doc.apply(Command::Patch {
        id: "nosuchelement".to_string(),
        fields: {
            let mut m = Map::new();
            m.insert("x".to_string(), json!(1));
            m
        },
    });
    assert_eq!(doc.revision(), rev);
    assert!(!doc.can_undo());
}

#[test]
fn an_empty_batch_is_a_clean_no_op() {
    // `ops.rs` builds a batch by filtering ids that may all have been deleted
    // since the gesture began, so an empty batch is a normal thing to apply,
    // not a caller bug. It must leave no undo entry and no revision behind —
    // otherwise a drag over a vanished selection fills the history with
    // presses of undo that do nothing.
    let mut doc = seed_doc();
    let rev = doc.revision();
    let change = doc.apply(Command::Batch(Vec::new()));
    assert_eq!(change, doc.no_change());
    assert_eq!(doc.revision(), rev);
    assert!(!doc.can_undo());

    // Same through the keyed path, and it must not close an open gesture
    // either: a no-op in the middle of a drag is not the end of the drag.
    doc.apply_keyed(Command::move_to("rect", 1.0, 1.0), "drag:rect", 1_000);
    doc.apply_keyed(Command::Batch(Vec::new()), "drag:rect", 1_008);
    doc.apply_keyed(Command::move_to("rect", 2.0, 2.0), "drag:rect", 1_016);
    assert_eq!(undo_all(&mut doc), 1);
    assert_eq!(get(&doc, "rect").x, 10.0);
}

#[test]
fn no_change_says_nothing_happened_without_moving_the_revision() {
    let mut doc = seed_doc();
    doc.apply(Command::move_to("rect", 5.0, 5.0));
    let change = doc.no_change();
    assert_eq!(change.revision, doc.revision());
    assert!(change.dirty.is_empty());
    assert!(change.bbox.is_none());
    assert!(!change.structural);
}

#[test]
fn fresh_identity_never_repeats_and_new_element_uses_it() {
    let mut doc = seed_doc();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..1000 {
        let (id, seed) = doc.fresh_identity();
        assert!(seen.insert(id), "an id repeated inside one session");
        assert!(seed >= 0, "a seed is a non-negative 31-bit integer");
    }
    // The element constructor draws from the same stream, so an element built
    // by hand for `Command::Insert` cannot collide with one built here.
    let el = doc.new_element(ElementKind::Rectangle, &Bounds::new(0.0, 0.0, 1.0, 1.0));
    assert!(!seen.contains(&el.id));
}

// ---------------------------------------------------------------------------
// Patching unknown keys
// ---------------------------------------------------------------------------

#[test]
fn a_key_that_did_not_exist_is_removed_again_by_undo() {
    let mut doc = seed_doc();
    let mut fields = Map::new();
    fields.insert("brandNewField".to_string(), json!({ "a": [1, 2, 3] }));
    doc.apply(Command::Patch {
        id: "ellipse".to_string(),
        fields,
    });
    assert_eq!(
        get(&doc, "ellipse").rest.get("brandNewField"),
        Some(&json!({ "a": [1, 2, 3] })),
        "an unmodelled key is patchable and lands in `rest`"
    );

    doc.undo().unwrap();
    assert!(
        !get(&doc, "ellipse").rest.contains_key("brandNewField"),
        "undo must remove a key that did not exist, not write a null over it"
    );
}

#[test]
fn a_null_removes_a_key_and_undo_puts_it_back() {
    let mut doc = seed_doc();
    let original = get(&doc, "rect").rest.get("customData").cloned();
    assert!(original.is_some());

    let mut fields = Map::new();
    fields.insert("customData".to_string(), Value::Null);
    doc.apply(Command::Patch {
        id: "rect".to_string(),
        fields,
    });
    assert!(!get(&doc, "rect").rest.contains_key("customData"));

    doc.undo().unwrap();
    assert_eq!(get(&doc, "rect").rest.get("customData"), original.as_ref());
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

#[test]
fn insert_does_not_restamp_the_element() {
    let mut doc = seed_doc();
    let el = doc.new_element(ElementKind::Rectangle, &Bounds::new(0.0, 0.0, 10.0, 10.0));
    let (id, seed, nonce) = (el.id.clone(), el.seed, el.version_nonce);

    let change = doc.apply(Command::Insert {
        at: Some(1),
        element: Box::new(el),
    });

    assert!(change.structural);
    assert_eq!(doc.index_of(&id), Some(1));
    let placed = get(&doc, &id);
    assert_eq!(placed.version, 1, "a new element arrives at version 1");
    assert_eq!(placed.seed, seed);
    assert_eq!(placed.version_nonce, nonce);

    doc.undo().unwrap();
    assert!(doc.index_of(&id).is_none());
}

#[test]
fn delete_restores_position_as_well_as_content() {
    let mut doc = seed_doc();
    let before = ids(&doc);
    doc.apply(Command::Delete {
        ids: vec!["ellipse".to_string(), "scribble".to_string()],
    });
    assert!(doc.index_of("ellipse").is_none());
    assert!(doc.index_of("scribble").is_none());

    doc.undo().unwrap();
    assert_eq!(ids(&doc), before, "undone deletes come back where they were");
}

#[test]
fn reorder_moves_a_selection_as_a_block() {
    let mut doc = seed_doc();
    let before = ids(&doc);

    doc.apply(Command::Reorder {
        ids: vec!["rect".to_string(), "arrow".to_string()],
        how: Reorder::Front,
    });
    let after = ids(&doc);
    assert_eq!(&after[after.len() - 2..], &["rect".to_string(), "arrow".to_string()]);

    doc.undo().unwrap();
    assert_eq!(ids(&doc), before);
}

#[test]
fn forward_does_not_let_a_selection_overtake_itself() {
    let mut doc = seed_doc();
    // "rect" and "ellipse" are adjacent at indices 0 and 1. Stepping both
    // forward must give 1 and 2, not swap them past each other.
    doc.apply(Command::Reorder {
        ids: vec!["rect".to_string(), "ellipse".to_string()],
        how: Reorder::Forward,
    });
    assert_eq!(doc.index_of("rect"), Some(1));
    assert_eq!(doc.index_of("ellipse"), Some(2));
}

#[test]
fn a_reorder_that_changes_nothing_is_not_history() {
    // "rect" is already at the back, so sending it to the back is a no-op —
    // no index written, no version moved, no undo entry.
    let mut doc = seed_doc();
    let before = get(&doc, "rect").clone();
    let rev = doc.revision();
    doc.apply(Command::Reorder {
        ids: vec!["rect".to_string()],
        how: Reorder::Back,
    });
    assert_eq!(get(&doc, "rect"), &before);
    assert_eq!(doc.revision(), rev);
    assert!(!doc.can_undo());
}

// ---------------------------------------------------------------------------
// Fractional indexing
//
// excalidraw.com re-sorts by `index` on load, so an edit that moves array
// positions without moving keys is an edit that does not travel. These pin the
// key generator on its own and then pin the two commands that write keys.
// ---------------------------------------------------------------------------

/// Every element that carries an `index` must carry one greater than the last
/// indexed element before it. This is the property excalidraw.com relies on;
/// if it does not hold, the drawing opens over there in a different order than
/// it has here.
fn assert_indices_agree_with_order(doc: &Doc, context: &str) {
    let mut last: Option<&str> = None;
    for e in doc.elements() {
        let Some(k) = e.index.as_deref() else { continue };
        if let Some(prev) = last {
            assert!(
                prev < k,
                "{context}: index {k:?} on {} does not sort after {prev:?}",
                e.id
            );
        }
        last = Some(k);
    }
}

#[test]
fn fuzz_generated_indices_sort_where_they_were_asked_to() {
    let mut rng = Rng::new(0xf00d);
    let mut keys: Vec<String> = Vec::new();
    for step in 0..2000u64 {
        let pos = if keys.is_empty() {
            0
        } else {
            (rng.next_u64() % (keys.len() as u64 + 1)) as usize
        };
        let lower = if pos == 0 {
            None
        } else {
            Some(keys[pos - 1].clone())
        };
        let upper = keys.get(pos).cloned();
        let key = index_between(lower.as_deref(), upper.as_deref())
            .unwrap_or_else(|| panic!("step {step}: no key between {lower:?} and {upper:?}"));
        if let Some(l) = &lower {
            assert!(l.as_str() < key.as_str(), "step {step}: {key:?} <= {l:?}");
        }
        if let Some(u) = &upper {
            assert!(key.as_str() < u.as_str(), "step {step}: {key:?} >= {u:?}");
        }
        keys.insert(pos, key);
    }
    assert!(keys.windows(2).all(|w| w[0] < w[1]), "keys fell out of order");
    let unique: std::collections::HashSet<&String> = keys.iter().collect();
    assert_eq!(unique.len(), keys.len(), "two elements got the same index");
}

#[test]
fn appending_keeps_keys_short() {
    // The common case by far: every new shape goes on top. Appending must not
    // make the keys grow, or a long drawing session bloats the file.
    let mut last: Option<String> = None;
    let mut keys = Vec::new();
    for _ in 0..1000 {
        let k = index_between(last.as_deref(), None).expect("appending never runs out");
        last = Some(k.clone());
        keys.push(k);
    }
    assert!(keys.windows(2).all(|w| w[0] < w[1]));
    let longest = keys.iter().map(String::len).max().unwrap();
    assert!(longest <= 3, "a thousand appends grew to {longest} characters");
}

#[test]
fn repeated_insertion_at_one_spot_never_collides() {
    // The algorithm's genuine worst case: always taking the same slot makes
    // each key one character longer than the last. It stays correct, and it
    // stays linear — it does not blow up, and it never repeats itself.
    let mut upper = "a1".to_string();
    let mut made = Vec::new();
    for _ in 0..200 {
        let k = index_between(Some("a0"), Some(&upper)).expect("the space never runs out");
        assert!("a0" < k.as_str() && k.as_str() < upper.as_str());
        upper = k.clone();
        made.push(k);
    }
    let unique: std::collections::HashSet<&String> = made.iter().collect();
    assert_eq!(unique.len(), made.len());
    let longest = made.iter().map(String::len).max().unwrap();
    assert!(longest <= 2 + made.len(), "growth is worse than one char a step");
}

#[test]
fn a_run_of_keys_between_two_neighbours_is_bisected_not_chained() {
    let keys = indices_between(Some("a0"), Some("a1"), 50);
    assert_eq!(keys.len(), 50);
    assert!(keys.windows(2).all(|w| w[0] < w[1]));
    assert!(keys.iter().all(|k| k.as_str() > "a0" && k.as_str() < "a1"));
    let longest = keys.iter().map(String::len).max().unwrap();
    assert!(
        longest <= 10,
        "bisecting 50 keys into one gap grew to {longest} characters — chained, not split?"
    );
}

#[test]
fn a_key_we_do_not_understand_is_declined_rather_than_guessed() {
    assert_eq!(index_between(None, None).as_deref(), Some("a0"));
    assert!(index_between(Some("not a key"), None).is_none());
    assert!(index_between(Some("a1"), Some("a1")).is_none());
    assert!(index_between(Some("a2"), Some("a1")).is_none(), "out of order");
    // A trailing zero makes a key ambiguous ("a01" and "a010" name one spot).
    assert!(index_between(Some("a010"), None).is_none());
}

#[test]
fn reorder_reindexes_only_what_moved_and_bumps_only_those() {
    let mut doc = seed_doc();
    let before: Vec<(String, Option<String>, i64)> = doc
        .elements()
        .iter()
        .map(|e| (e.id.clone(), e.index.clone(), e.version))
        .collect();

    doc.apply(Command::Reorder {
        ids: vec!["rect".to_string()],
        how: Reorder::Front,
    });

    assert_eq!(ids(&doc).last().unwrap(), "rect");
    assert_indices_agree_with_order(&doc, "after sending rect to the front");

    for (id, index, version) in &before {
        let e = get(&doc, id);
        if id == "rect" {
            assert_ne!(&e.index, index, "the moved element kept its stale key");
            assert_eq!(
                e.version,
                version + 1,
                "`index` is a field; writing it carries the bookkeeping"
            );
        } else {
            assert_eq!(&e.index, index, "{id} shifted position but did not move");
            assert_eq!(e.version, *version, "{id} was not edited, so its version stands");
        }
    }
}

#[test]
fn a_moved_block_is_reindexed_as_a_block() {
    let mut doc = seed_doc();
    doc.apply(Command::Reorder {
        ids: vec!["scribble".to_string(), "diamond".to_string()],
        how: Reorder::Back,
    });
    assert_eq!(&ids(&doc)[..2], &["scribble".to_string(), "diamond".to_string()]);
    assert_indices_agree_with_order(&doc, "after sending two elements to the back");
}

#[test]
fn undo_restores_the_previous_index_exactly() {
    let mut doc = seed_doc();
    let before: Vec<Option<String>> = doc.elements().iter().map(|e| e.index.clone()).collect();
    doc.apply(Command::Reorder {
        ids: vec!["rect".to_string(), "arrow".to_string()],
        how: Reorder::Front,
    });
    doc.undo().unwrap();
    let after: Vec<Option<String>> = doc.elements().iter().map(|e| e.index.clone()).collect();
    assert_eq!(after, before);
}

#[test]
fn a_file_with_no_indices_at_all_keeps_working() {
    // Older exports, and most files in the wild, have no `index` anywhere.
    // Excalidraw backfills those from the array order on load, so the array
    // alone is already right — we must not backfill the whole scene here, and
    // we must not fall over.
    let text = seed_json().replace("\"index\"", "\"wasIndex\"");
    let mut doc = Doc::from_json(&text).unwrap();
    assert!(doc.elements().iter().all(|e| e.index.is_none()));

    doc.apply(Command::Reorder {
        ids: vec!["rect".to_string()],
        how: Reorder::Front,
    });
    assert_eq!(ids(&doc).last().unwrap(), "rect");

    let indexed: Vec<&str> = doc
        .elements()
        .iter()
        .filter_map(|e| e.index.as_deref())
        .collect();
    assert_eq!(
        indexed.len(),
        1,
        "only the element that moved should have gained a key"
    );
    assert_indices_agree_with_order(&doc, "unindexed file after a reorder");
}

#[test]
fn insert_keys_the_element_where_it_actually_lands() {
    let mut doc = seed_doc();
    let el = doc.new_element(ElementKind::Rectangle, &Bounds::new(0.0, 0.0, 10.0, 10.0));
    assert!(
        el.index.as_deref() > Some("a7"),
        "a freshly drawn shape is keyed on top"
    );

    // Inserted in the middle instead, it must be keyed for where it went.
    let id = el.id.clone();
    doc.apply(Command::Insert {
        at: Some(2),
        element: Box::new(el),
    });
    assert_eq!(doc.index_of(&id), Some(2));
    assert_indices_agree_with_order(&doc, "after inserting in the middle");

    doc.undo().unwrap();
    assert!(doc.index_of(&id).is_none());
    assert_indices_agree_with_order(&doc, "after undoing the insert");
}

#[test]
fn a_duplicate_does_not_inherit_the_original_index() {
    // `ops.rs` duplicates by cloning an element and handing it to `Insert`.
    // Two elements with one key is exactly the ambiguity the scheme exists to
    // prevent, so `Insert` overwrites rather than filling in a blank.
    let mut doc = seed_doc();
    let mut copy = get(&doc, "rect").clone();
    let (id, seed) = doc.fresh_identity();
    copy.id = id.clone();
    copy.seed = seed;
    assert_eq!(copy.index.as_deref(), Some("a1"));

    doc.apply(Command::Insert {
        at: None,
        element: Box::new(copy),
    });
    assert_ne!(get(&doc, &id).index.as_deref(), Some("a1"));
    assert_indices_agree_with_order(&doc, "after duplicating");
}

#[test]
fn group_appends_and_ungroup_pops() {
    let mut doc = seed_doc();
    doc.apply(Command::Group {
        ids: vec!["rect".to_string(), "scribble".to_string()],
    });
    let gid = get(&doc, "rect").group_ids.last().cloned().unwrap();
    assert_eq!(get(&doc, "scribble").group_ids, vec!["grp".to_string(), gid.clone()]);

    doc.apply(Command::Ungroup {
        ids: vec!["rect".to_string(), "scribble".to_string()],
    });
    assert!(get(&doc, "rect").group_ids.is_empty());
    assert_eq!(get(&doc, "scribble").group_ids, vec!["grp".to_string()]);
}

// ---------------------------------------------------------------------------
// Binding — both halves, every time
// ---------------------------------------------------------------------------

fn binding_to(id: &str) -> Binding {
    Binding {
        element_id: id.to_string(),
        focus: 0.0,
        gap: 4.0,
        rest: Map::new(),
    }
}

#[test]
fn bind_writes_both_halves() {
    let mut doc = seed_doc();
    doc.apply(Command::Bind {
        arrow: "arrow".to_string(),
        end: End::End,
        binding: Some(binding_to("diamond")),
    });

    // The arrow names the shape...
    assert_eq!(
        get(&doc, "arrow").end_binding.as_ref().map(|b| b.element_id.as_str()),
        Some("diamond")
    );
    // ...the shape names the arrow back...
    assert!(get(&doc, "diamond")
        .bound_elements
        .as_ref()
        .is_some_and(|v| v.iter().any(|b| b.id == "arrow" && b.kind == "arrow")));
    // ...and the shape it left no longer does.
    assert!(get(&doc, "ellipse")
        .bound_elements
        .as_ref()
        .is_some_and(|v| v.iter().all(|b| b.id != "arrow")));
}

#[test]
fn unbinding_removes_the_back_reference() {
    let mut doc = seed_doc();
    doc.apply(Command::Bind {
        arrow: "arrow".to_string(),
        end: End::Start,
        binding: None,
    });
    assert!(get(&doc, "arrow").start_binding.is_none());
    let rect = get(&doc, "rect");
    let bound = rect.bound_elements.as_ref().unwrap();
    assert!(bound.iter().all(|b| b.id != "arrow"));
    assert!(
        bound.iter().any(|b| b.id == "label"),
        "the contained text's back-reference is not ours to remove"
    );
}

#[test]
fn an_arrow_bound_at_both_ends_keeps_one_back_reference() {
    let mut doc = seed_doc();
    // Point the start at the ellipse too, so both ends name it.
    doc.apply(Command::Bind {
        arrow: "arrow".to_string(),
        end: End::Start,
        binding: Some(binding_to("ellipse")),
    });
    // Now move the end away. The start is still bound, so the ellipse must
    // keep its `boundElements` entry.
    doc.apply(Command::Bind {
        arrow: "arrow".to_string(),
        end: End::End,
        binding: None,
    });
    assert!(get(&doc, "ellipse")
        .bound_elements
        .as_ref()
        .is_some_and(|v| v.iter().any(|b| b.id == "arrow")));
}

#[test]
fn a_shape_that_never_had_bound_elements_does_not_gain_an_empty_array() {
    let mut doc = seed_doc();
    assert!(get(&doc, "diamond").bound_elements.is_none());
    doc.apply(Command::Bind {
        arrow: "arrow".to_string(),
        end: End::End,
        binding: None,
    });
    assert!(
        get(&doc, "diamond").bound_elements.is_none(),
        "an unrelated shape is untouched"
    );
}

#[test]
fn deleting_a_shape_clears_the_arrows_that_pointed_at_it() {
    let mut doc = seed_doc();
    doc.apply(Command::Delete {
        ids: vec!["rect".to_string()],
    });
    assert!(
        get(&doc, "arrow").start_binding.is_none(),
        "a binding to an element that is gone is the classic broken .excalidraw"
    );
    // The other end is untouched.
    assert_eq!(
        get(&doc, "arrow").end_binding.as_ref().map(|b| b.element_id.as_str()),
        Some("ellipse")
    );

    doc.undo().unwrap();
    assert_eq!(
        get(&doc, "arrow").start_binding.as_ref().map(|b| b.element_id.as_str()),
        Some("rect")
    );
}

#[test]
fn deleting_an_arrow_clears_the_shapes_that_named_it() {
    let mut doc = seed_doc();
    doc.apply(Command::Delete {
        ids: vec!["arrow".to_string()],
    });
    for shape in ["rect", "ellipse"] {
        let bound = get(&doc, shape).bound_elements.as_ref().unwrap();
        assert!(bound.iter().all(|b| b.id != "arrow"), "{shape} still names a deleted arrow");
    }
    doc.undo().unwrap();
    assert!(get(&doc, "rect")
        .bound_elements
        .as_ref()
        .is_some_and(|v| v.iter().any(|b| b.id == "arrow")));
}

// ---------------------------------------------------------------------------
// Coalescing — one drag, one undo
// ---------------------------------------------------------------------------

#[test]
fn a_four_hundred_event_drag_is_one_undo_entry() {
    let mut doc = seed_doc();
    let start = (get(&doc, "rect").x, get(&doc, "rect").y);
    let version = get(&doc, "rect").version;

    let mut t = 1_700_000_100_000;
    for step in 1..=400 {
        doc.apply_keyed(
            Command::move_to("rect", start.0 + step as f64, start.1 + step as f64),
            "drag:rect",
            t,
        );
        t += 8; // ~120 Hz, the rate a trackpad actually delivers
    }
    assert_eq!(get(&doc, "rect").x, start.0 + 400.0);
    assert_eq!(
        get(&doc, "rect").version,
        version + 400,
        "every event is still a real edit; only the history entry is shared"
    );

    assert_eq!(undo_all(&mut doc), 1, "one drag is one press of undo");
    assert_eq!((get(&doc, "rect").x, get(&doc, "rect").y), start);
    assert_eq!(
        get(&doc, "rect").version,
        version,
        "the folded entry kept the original before-state, not the one from event 399"
    );

    doc.redo().unwrap();
    assert_eq!(get(&doc, "rect").x, start.0 + 400.0);
    assert_eq!(
        get(&doc, "rect").version,
        version + 400,
        "the folded entry kept the newest after-state"
    );
}

#[test]
fn a_pause_ends_the_gesture() {
    let mut doc = seed_doc();
    doc.apply_keyed(Command::move_to("rect", 1.0, 1.0), "drag:rect", 1_000);
    doc.apply_keyed(
        Command::move_to("rect", 2.0, 2.0),
        "drag:rect",
        1_000 + COALESCE_WINDOW_MS + 1,
    );
    assert_eq!(undo_all(&mut doc), 2);
}

#[test]
fn a_different_key_ends_the_gesture() {
    let mut doc = seed_doc();
    doc.apply_keyed(Command::move_to("rect", 1.0, 1.0), "drag:rect", 1_000);
    doc.apply_keyed(Command::move_to("ellipse", 2.0, 2.0), "drag:ellipse", 1_008);
    assert_eq!(undo_all(&mut doc), 2);
}

#[test]
fn an_empty_key_never_coalesces() {
    let mut doc = seed_doc();
    doc.apply_keyed(Command::move_to("rect", 1.0, 1.0), "", 1_000);
    doc.apply_keyed(Command::move_to("rect", 2.0, 2.0), "", 1_008);
    assert_eq!(undo_all(&mut doc), 2);
}

#[test]
fn a_gesture_does_not_resume_across_an_undo() {
    let mut doc = seed_doc();
    doc.apply_keyed(Command::move_to("rect", 1.0, 1.0), "drag:rect", 1_000);
    doc.apply_keyed(Command::move_to("rect", 2.0, 2.0), "drag:rect", 1_008);
    doc.undo().unwrap();
    // The entry the drag was folding into is on the redo stack now. Folding
    // into whatever is on top of the undo stack would corrupt an unrelated
    // entry, so the window is closed by the undo.
    doc.apply_keyed(Command::move_to("rect", 3.0, 3.0), "drag:rect", 1_016);
    assert_eq!(undo_all(&mut doc), 1);
    assert_eq!(get(&doc, "rect").x, 10.0);
}

#[test]
fn a_coalesced_multi_element_drag_undoes_as_one() {
    let mut doc = seed_doc();
    let before = (get(&doc, "rect").x, get(&doc, "ellipse").x);
    let mut t = 0;
    for step in 1..=50 {
        doc.apply_keyed(
            Command::Batch(vec![
                Command::move_to("rect", before.0 + step as f64, 20.0),
                Command::move_to("ellipse", before.1 + step as f64, 40.0),
            ]),
            "drag:selection",
            t,
        );
        t += 8;
    }
    assert_eq!(undo_all(&mut doc), 1);
    assert_eq!((get(&doc, "rect").x, get(&doc, "ellipse").x), before);
}

// ---------------------------------------------------------------------------
// Redo
// ---------------------------------------------------------------------------

#[test]
fn a_new_edit_forfeits_the_redo_branch() {
    let mut doc = seed_doc();
    doc.apply(Command::move_to("rect", 1.0, 1.0));
    doc.undo().unwrap();
    assert!(doc.can_redo());
    doc.apply(Command::move_to("rect", 2.0, 2.0));
    assert!(!doc.can_redo());
}

// ---------------------------------------------------------------------------
// The fuzz
// ---------------------------------------------------------------------------

/// A random command that makes sense against the current scene. Returns
/// `None` when the scene has nothing to operate on.
fn random_command(doc: &mut Doc, rng: &mut Rng) -> Option<Command> {
    let live = ids(doc);
    if live.is_empty() {
        // Only one thing to do with an empty scene.
        let el = doc.new_element(ElementKind::Rectangle, &Bounds::new(0.0, 0.0, 20.0, 20.0));
        return Some(Command::Insert {
            at: None,
            element: Box::new(el),
        });
    }
    let pick = |rng: &mut Rng, v: &[String]| v[(rng.next_u64() % v.len() as u64) as usize].clone();

    Some(match rng.next_u64() % 10 {
        0..=2 => {
            // A patch, weighted heavily because that is what an editor does.
            let id = pick(rng, &live);
            let mut fields = Map::new();
            match rng.next_u64() % 7 {
                0 => {
                    fields.insert("x".to_string(), json!((rng.next_u64() % 1000) as f64));
                    fields.insert("y".to_string(), json!((rng.next_u64() % 1000) as f64));
                }
                1 => {
                    fields.insert("width".to_string(), json!((rng.next_u64() % 500) as f64));
                    fields.insert("height".to_string(), json!((rng.next_u64() % 500) as f64));
                }
                2 => {
                    fields.insert("angle".to_string(), json!((rng.next_u64() % 628) as f64 / 100.0));
                }
                3 => {
                    fields.insert("strokeColor".to_string(), json!(format!("#{:06x}", rng.next_u64() % 0xff_ffff)));
                    fields.insert("opacity".to_string(), json!((rng.next_u64() % 101) as f64));
                }
                4 => {
                    // An unmodelled key, added and later removed — the case
                    // where the undo record has to remember "there was no
                    // such key" rather than "there was a null here".
                    fields.insert("scratchpad".to_string(), json!({ "n": rng.next_u64() % 100 }));
                }
                5 => {
                    fields.insert("scratchpad".to_string(), Value::Null);
                    fields.insert("customData".to_string(), Value::Null);
                }
                _ => {
                    // The seed and the id are refused; including them keeps
                    // the filter under test rather than under comment.
                    fields.insert("seed".to_string(), json!(rng.next_u64() % 1_000_000));
                    fields.insert("id".to_string(), json!("hijacked"));
                    fields.insert("isDeleted".to_string(), json!(rng.next_u64().is_multiple_of(2)));
                }
            }
            Command::Patch { id, fields }
        }
        3 => {
            let kinds = [
                ElementKind::Rectangle,
                ElementKind::Ellipse,
                ElementKind::Arrow,
                ElementKind::Text,
                ElementKind::Freedraw,
            ];
            let kind = kinds[(rng.next_u64() % kinds.len() as u64) as usize].clone();
            let x = (rng.next_u64() % 500) as f64;
            let y = (rng.next_u64() % 500) as f64;
            let el = doc.new_element(kind, &Bounds::new(x, y, x + 40.0, y + 30.0));
            let at = if rng.next_u64().is_multiple_of(2) {
                None
            } else {
                Some((rng.next_u64() % (live.len() as u64 + 1)) as usize)
            };
            Command::Insert {
                at,
                element: Box::new(el),
            }
        }
        4 => {
            let n = 1 + rng.next_u64() % 2;
            let mut victims: Vec<String> = (0..n).map(|_| pick(rng, &live)).collect();
            victims.sort();
            victims.dedup();
            Command::Delete { ids: victims }
        }
        5 => {
            let n = 1 + rng.next_u64() % 3;
            let picked: Vec<String> = (0..n).map(|_| pick(rng, &live)).collect();
            let how = match rng.next_u64() % 4 {
                0 => Reorder::Front,
                1 => Reorder::Back,
                2 => Reorder::Forward,
                _ => Reorder::Backward,
            };
            Command::Reorder { ids: picked, how }
        }
        6 => {
            let n = 1 + rng.next_u64() % 3;
            let picked: Vec<String> = (0..n).map(|_| pick(rng, &live)).collect();
            if rng.next_u64().is_multiple_of(2) {
                Command::Group { ids: picked }
            } else {
                Command::Ungroup { ids: picked }
            }
        }
        7 | 8 => {
            let arrows: Vec<String> = doc
                .elements()
                .iter()
                .filter(|e| e.kind == ElementKind::Arrow)
                .map(|e| e.id.clone())
                .collect();
            if arrows.is_empty() {
                return None;
            }
            let arrow = pick(rng, &arrows);
            let end = if rng.next_u64().is_multiple_of(2) { End::Start } else { End::End };
            let binding = if rng.next_u64().is_multiple_of(4) {
                None
            } else {
                Some(Binding {
                    element_id: pick(rng, &live),
                    focus: (rng.next_u64() % 200) as f64 / 100.0 - 1.0,
                    gap: (rng.next_u64() % 20) as f64,
                    rest: Map::new(),
                })
            };
            Command::Bind { arrow, end, binding }
        }
        _ => {
            // A batch, which is how a multi-selection drag arrives.
            let n = 1 + rng.next_u64() % 3;
            let mut parts = Vec::new();
            for _ in 0..n {
                let id = pick(rng, &live);
                parts.push(Command::move_to(
                    id,
                    (rng.next_u64() % 800) as f64,
                    (rng.next_u64() % 800) as f64,
                ));
            }
            Command::Batch(parts)
        }
    })
}

/// **The Phase 3 acceptance gate.** 200 runs of 50 random commands against a
/// real scene, then undo everything. What comes out must be what went in,
/// `rest` maps and bookkeeping fields included.
///
/// Half the runs use `apply_keyed` with a small pool of keys and a clock that
/// sometimes jumps past the coalesce window, so the folding path is fuzzed
/// alongside the plain one — coalescing is where an undo record is rewritten
/// after the fact, which is exactly where a "keeps the original before-state"
/// bug would hide.
#[test]
fn fuzz_undo_restores_the_scene_exactly() {
    for run in 0..200u64 {
        let mut doc = seed_doc();
        doc.set_seed(run);
        let original = doc.scene().clone();
        let mut rng = Rng::new(run.wrapping_mul(0x9e37_79b9) ^ 0x5eed);
        let keyed = run % 2 == 0;
        let mut t: i64 = 1_700_000_000_000;
        let mut applied = 0;

        for _ in 0..50 {
            let Some(cmd) = random_command(&mut doc, &mut rng) else {
                continue;
            };
            if keyed {
                let key = format!("gesture:{}", rng.next_u64() % 3);
                // Usually inside the window, occasionally well past it.
                t += if rng.next_u64().is_multiple_of(5) {
                    COALESCE_WINDOW_MS + 1
                } else {
                    8
                };
                doc.apply_keyed(cmd, &key, t);
            } else {
                doc.set_now(t);
                t += 16;
                doc.apply(cmd);
            }
            applied += 1;
        }
        assert!(applied > 0);
        // The interop property, checked on the edited scene rather than only
        // on the restored one: whatever the commands did, an element that
        // carries an `index` still sorts after the last one that does.
        assert_indices_agree_with_order(&doc, &format!("run {run} after editing"));

        undo_all(&mut doc);
        assert!(!doc.can_undo());

        assert_eq!(
            without_bookkeeping(doc.scene()),
            without_bookkeeping(&original),
            "run {run}: undoing everything did not restore the scene's content"
        );
        assert_eq!(
            doc.scene(),
            &original,
            "run {run}: content was restored but the version bookkeeping drifted"
        );
        assert_eq!(
            doc.to_json(),
            xd_core::format::serialize(&original),
            "run {run}: the file is not byte-identical after undoing everything"
        );
    }
}

/// Pinned separately from the fuzz so a bookkeeping regression is named rather
/// than reported as "something differs": undo is a state restore, so the three
/// bookkeeping fields come back as they were, not bumped again.
#[test]
fn bookkeeping_is_restored_too() {
    let mut doc = seed_doc();
    let before = get(&doc, "rect").clone();
    doc.apply(Command::move_to("rect", 999.0, 999.0));
    doc.undo().unwrap();
    let after = get(&doc, "rect");
    assert_eq!(after.version, before.version);
    assert_eq!(after.version_nonce, before.version_nonce);
    assert_eq!(after.updated, before.updated);
}

/// Redo has to be the exact forward replay of what undo reversed, or a
/// ⌘Z/⇧⌘Z round trip is a silent edit.
#[test]
fn fuzz_redo_replays_exactly() {
    for run in 0..100u64 {
        let mut doc = seed_doc();
        doc.set_seed(run);
        let mut rng = Rng::new(run.wrapping_mul(0x2545_f491) ^ 0xfeed);
        let mut t: i64 = 1_700_000_000_000;

        for _ in 0..40 {
            let Some(cmd) = random_command(&mut doc, &mut rng) else {
                continue;
            };
            doc.set_now(t);
            t += 16;
            doc.apply(cmd);
        }
        let final_scene = doc.scene().clone();

        let undone = undo_all(&mut doc);
        let redone = redo_all(&mut doc);
        assert_eq!(undone, redone, "run {run}: history depth changed");
        assert_eq!(doc.scene(), &final_scene, "run {run}: redo did not replay exactly");
        assert!(!doc.can_redo());
    }
}

/// Whatever else happens, no command may write a seed. Fuzzing the whole
/// command set and then comparing seeds against the elements that still exist
/// is a cheaper statement of that than auditing every code path.
#[test]
fn fuzz_never_rewrites_a_seed() {
    for run in 0..100u64 {
        let mut doc = seed_doc();
        doc.set_seed(run);
        let mut before: Vec<(String, i64)> = doc
            .elements()
            .iter()
            .map(|e| (e.id.clone(), e.seed))
            .collect();
        before.sort();
        let mut rng = Rng::new(run ^ 0xabcd_ef01);

        for _ in 0..40 {
            if let Some(cmd) = random_command(&mut doc, &mut rng) {
                doc.apply(cmd);
            }
        }

        for (id, seed) in before {
            if let Some(i) = doc.index_of(&id) {
                assert_eq!(doc.elements()[i].seed, seed, "run {run}: seed rewritten on {id}");
            }
        }
    }
}
