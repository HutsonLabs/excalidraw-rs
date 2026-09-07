//! The compatibility contract, defended.
//!
//! Everything here exists to answer one question: if somebody opens a drawing
//! in this editor and saves it, is it still their drawing? A viewer that
//! misreads a field draws something wrong and you can see it. An editor that
//! misreads a field *writes the file back without it*, and you find out weeks
//! later when the arrow no longer follows the box in Excalidraw proper. That
//! failure is silent, permanent, and ours.
//!
//! So the corpus is real files first — the ones this build will actually be
//! pointed at — and hand-written ones only for what the real files do not
//! reach: every element kind including ones we cannot draw, a bound arrow
//! pair, contained text, an image with its `files` entry, a frame, groups,
//! both roundness schemes, deleted elements, and elements carrying keys
//! invented here to stand in for whatever Excalidraw adds next.
//!
//! `excalidraw-com-export.excalidraw` is the odd one out and is labelled so
//! nobody mistakes it: it is a *reconstruction* of a current excalidraw.com
//! export, not a capture. The four `real-` files all predate fractional
//! indexing and carry no `index`, so without it nothing in the corpus would
//! exercise the key that decides z-order. Replace it with a genuine export the
//! first time one is to hand.
//!
//! The properties, in the order they matter:
//!
//! 1. Nothing the file said is lost or changed (`nothing_the_file_said_is_lost`).
//! 2. Reading our own output gives back the same scene, so a save-open-save
//!    cycle converges instead of drifting (`parse_serialize_parse_is_identity`,
//!    `serializing_is_a_fixed_point`).
//! 3. It holds for scenes nobody wrote by hand (`prop_arbitrary_scene`).

use serde_json::{Map, Value};
use std::path::Path;
use xd_core::format::{self, blank_scene, parse, serialize};
use xd_core::scene::{Element, ElementKind, Scene};

// --- the corpus -------------------------------------------------------------

fn fixtures() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut out: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("no fixtures at {}: {e}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "excalidraw"))
        .map(|p| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            (name, std::fs::read_to_string(&p).unwrap())
        })
        .collect();
    out.sort();
    out
}

fn fixture(name: &str) -> String {
    fixtures()
        .into_iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no fixture named {name}"))
        .1
}

#[test]
fn the_corpus_is_a_corpus() {
    // The acceptance criterion is a *corpus*, not an example. If this ever
    // shrinks, the thing it was protecting shrank with it.
    let names: Vec<String> = fixtures().into_iter().map(|(n, _)| n).collect();
    assert!(names.len() >= 8, "only {} fixtures: {names:?}", names.len());
    assert!(
        names.iter().filter(|n| n.starts_with("real-")).count() >= 3,
        "the corpus has stopped containing real files: {names:?}"
    );
}

#[test]
fn every_fixture_parses() {
    for (name, text) in fixtures() {
        match parse(&text) {
            Ok(scene) => assert!(
                !scene.elements.is_empty() || name == "empty.excalidraw",
                "{name} parsed to nothing"
            ),
            Err(e) => panic!("{name} did not parse: {e}"),
        }
    }
}

// --- the three round-trip properties ---------------------------------------

#[test]
fn parse_serialize_parse_is_identity() {
    for (name, text) in fixtures() {
        let once = parse(&text).unwrap();
        let twice = parse(&serialize(&once)).unwrap_or_else(|e| panic!("{name} re-parse: {e}"));
        assert_eq!(once, twice, "{name} changed on the way out and back");
    }
}

#[test]
fn serializing_is_a_fixed_point() {
    // Our output differs from the input in spelling — unknown keys move to the
    // end of the element. That normalisation is allowed to happen once. If it
    // happened *every* time, every save would produce a diff and autosave would
    // churn the file forever.
    for (name, text) in fixtures() {
        let first = serialize(&parse(&text).unwrap());
        let second = serialize(&parse(&first).unwrap());
        assert_eq!(first, second, "{name} keeps moving");
    }
}

#[test]
fn nothing_the_file_said_is_lost() {
    for (name, text) in fixtures() {
        let before: Value = serde_json::from_str(&text).unwrap();
        let after: Value = serde_json::from_str(&serialize(&parse(&text).unwrap())).unwrap();
        compare(&name, &before, &after);
    }
}

/// Keys we are allowed to drop, and only when the file's value was `null`.
///
/// These are the modelled keys Excalidraw writes for one element kind and not
/// others: `containerId` on text, the binding fields on a line or arrow. A
/// `null` there means "not bound", and an absent key reads back as exactly the
/// same thing — so the value survives even though the spelling does not. The
/// alternative is writing `"containerId": null` onto rectangles, which
/// Excalidraw never does and which would be its own kind of corruption.
const DROPPABLE_NULLS: &[&str] = &[
    "strokeColor",
    "backgroundColor",
    "fillStyle",
    "strokeWidth",
    "strokeStyle",
    "roughness",
    "opacity",
    "updated",
    "locked",
    "text",
    "originalText",
    "fontSize",
    "fontFamily",
    "textAlign",
    "verticalAlign",
    "containerId",
    "lineHeight",
    "points",
    "pressures",
    "lastCommittedPoint",
    "startBinding",
    "endBinding",
    "fileId",
    "value",
    "source",
];

/// Keys we are allowed to *add*, and only with an empty value.
///
/// Excalidraw writes all of these on every element (or, for `appState` and
/// `files`, on every scene). A file that omits them is one we normalise
/// towards the format its own editor produces — which is the direction a round
/// trip is allowed to move in, unlike the other one.
///
/// `index` and `link` joined this list when they stopped riding in `rest`.
/// That is the honest cost of modelling a key: an unknown key needs no
/// allowance because it is copied verbatim, and a modelled one that Excalidraw
/// always writes needs an addition allowance for the files that omit it. What
/// does *not* change is the loss side — nothing new became droppable.
const ADDABLE_DEFAULTS: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "angle",
    "groupIds",
    "frameId",
    "roundness",
    "seed",
    "version",
    "versionNonce",
    "isDeleted",
    "boundElements",
    "index",
    "link",
    "appState",
    "files",
];

fn compare(where_: &str, before: &Value, after: &Value) {
    match (before, after) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => compare(&format!("{where_}.{key}"), value, other),
                    None => assert!(
                        value.is_null() && DROPPABLE_NULLS.contains(&key.as_str()),
                        "{where_}.{key} was dropped (it held {value})"
                    ),
                }
            }
            for (key, value) in b {
                if a.contains_key(key) {
                    continue;
                }
                assert!(
                    ADDABLE_DEFAULTS.contains(&key.as_str()) && is_empty(value),
                    "{where_}.{key} appeared out of nowhere, holding {value}"
                );
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{where_} changed length");
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                compare(&format!("{where_}[{i}]"), x, y);
            }
        }
        // JSON has numbers, not spellings. `20` and `20.0` are the same value,
        // and which one gets written is `scene.rs`'s business, not this test's.
        (Value::Number(a), Value::Number(b)) => {
            let (x, y) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert_eq!(x, y, "{where_} changed from {a} to {b}");
        }
        _ => assert_eq!(before, after, "{where_} changed"),
    }
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::String(s) => s.is_empty(),
    }
}

// --- unknown keys, asserted on the JSON rather than on the model ------------

#[test]
fn unknown_keys_come_back_with_their_values_intact() {
    // Scene equality would pass even if `rest` round-tripped through some lossy
    // normalisation of its own, because both sides would be equally wrong. So
    // this one reaches into the written bytes and reads them back.
    let text = fixture("future-keys.excalidraw");
    let out: Value = serde_json::from_str(&serialize(&parse(&text).unwrap())).unwrap();
    let src: Value = serde_json::from_str(&text).unwrap();

    let element = |doc: &Value, id: &str| -> Value {
        doc["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == id)
            .unwrap_or_else(|| panic!("no element {id}"))
            .clone()
    };

    let a = element(&src, "carries-unknown-keys");
    let b = element(&out, "carries-unknown-keys");
    for key in [
        "customData",
        "elbowed",
        "crop",
        "someFutureNumber",
        "someFutureBigInteger",
        "someFutureEmptyArray",
        "someFutureEmptyObject",
        "someFutureUnicode",
        "someFutureFalse",
    ] {
        assert_eq!(a[key], b[key], "element key {key}");
    }
    // The nested case specifically: a whole subtree we have no opinion about.
    assert_eq!(
        b["customData"]["hut"]["nested"]["deeply"]["enough"],
        serde_json::json!([1, [2, [3, null]]])
    );
    assert_eq!(b["customData"]["hut"]["tags"], serde_json::json!(["design", "phase-1"]));

    // A binding is a modelled struct with its own `rest`; the future lands
    // there too (`fixedPoint` already did).
    let arrow = element(&out, "arrow-with-unknown-binding-keys");
    assert_eq!(arrow["startBinding"]["fixedPoint"], serde_json::json!([1, 0.5]));
    assert_eq!(
        arrow["startBinding"]["someFutureBindingKey"],
        serde_json::json!({ "mode": "sticky" })
    );
    assert_eq!(arrow["startArrowhead"], "dot");
    assert_eq!(arrow["fixedSegments"][0]["end"], serde_json::json!([320, 0]));

    // And at the top level, beside `elements`.
    assert_eq!(out["someFutureTopLevelKey"], src["someFutureTopLevelKey"]);
    assert_eq!(
        out["appState"]["someFutureAppStateKey"],
        serde_json::json!({ "enabled": true, "list": [1, 2, 3] })
    );
    // `version` is the scene's schema version, not ours to normalise.
    assert_eq!(out["version"], 3);
}

#[test]
fn an_element_type_we_cannot_draw_keeps_its_name() {
    // Embeddables and iframes are live web views in Excalidraw and cannot be
    // one here. Round-tripping the name is what lets somebody edit the rest of
    // a diagram in this editor without their YouTube embed turning into a
    // rectangle — or into nothing.
    let scene = parse(&fixture("every-kind.excalidraw")).unwrap();
    let kinds: Vec<&str> = scene.elements.iter().map(|e| e.kind.as_str()).collect();
    assert!(kinds.contains(&"embeddable"), "{kinds:?}");
    assert!(kinds.contains(&"iframe"), "{kinds:?}");
    assert_eq!(
        scene
            .elements
            .iter()
            .filter(|e| matches!(e.kind, ElementKind::Other(_)))
            .count(),
        2
    );

    let out: Value = serde_json::from_str(&serialize(&scene)).unwrap();
    let types: Vec<&str> = out["elements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "rectangle",
            "diamond",
            "ellipse",
            "line",
            "arrow",
            "freedraw",
            "text",
            "image",
            "frame",
            "embeddable",
            "iframe"
        ]
    );
}

#[test]
fn z_order_and_links_stay_in_their_own_slots() {
    // `index` is Excalidraw's fractional index and the only thing that carries
    // stacking order to excalidraw.com. While it rode in `rest` it survived a
    // round trip but no command could keep it consistent, so a reorder here
    // produced a file that reordered here and nowhere else. Modelling it is
    // what makes that fixable; generating one is `Reorder`'s job.
    let text = fixture("excalidraw-com-export.excalidraw");
    let scene = parse(&text).unwrap();
    let indexes: Vec<Option<&str>> = scene
        .elements
        .iter()
        .map(|e| e.index.as_deref())
        .collect();
    assert_eq!(indexes, [Some("a0"), Some("a1"), Some("a2"), Some("a3"), Some("a4")]);
    assert_eq!(scene.elements[2].link.as_deref(), Some("https://excalidraw.com"));
    assert_eq!(scene.elements[0].link, None);
    assert!(scene.elements.iter().all(|e| e.rest.get("index").is_none()));

    // Both keep Excalidraw's slot rather than migrating to the end of the
    // element, which is the entire point of modelling them.
    let out = serialize(&scene);
    let keys: Vec<&str> = out
        .lines()
        .skip_while(|l| !l.contains("\"id\": \"Qm7xK2pLvR9dN4sTfWbYc\""))
        .take_while(|l| !l.contains("\"locked\""))
        .filter_map(|l| l.trim().strip_prefix('"')?.split('"').next())
        .collect();
    let at = |k: &str| keys.iter().position(|x| *x == k);
    assert!(at("frameId") < at("index") && at("index") < at("roundness"), "{keys:?}");
    assert!(at("updated") < at("link"), "{keys:?}");

    // A file that predates fractional indexing gains the "not yet indexed"
    // state Excalidraw itself writes, not a fabricated order.
    let bare: Value =
        serde_json::from_str(&serialize(&parse(&fixture("minimal.excalidraw")).unwrap())).unwrap();
    assert_eq!(bare["elements"][0]["index"], Value::Null);
    assert_eq!(bare["elements"][0]["link"], Value::Null);
}

#[test]
fn a_deleted_element_stays_in_the_file() {
    // Excalidraw keeps deleted elements so undo and merging another client's
    // edits still work. Dropping them on save is a data-loss bug that looks
    // like a tidy-up.
    let scene = parse(&fixture("deleted.excalidraw")).unwrap();
    assert_eq!(scene.elements.len(), 3);
    assert_eq!(format::visible_elements(&scene).count(), 1);

    let out: Value = serde_json::from_str(&serialize(&scene)).unwrap();
    assert_eq!(out["elements"].as_array().unwrap().len(), 3);
    assert_eq!(out["elements"][1]["isDeleted"], true);
}

#[test]
fn the_keys_excalidraw_always_writes_are_always_written() {
    // The regression this pins: with `skip_serializing_if`, `"frameId": null`
    // deserialises to `None` and then vanishes on save — a key quietly deleted
    // from every element of every file we touch.
    let out: Value = serde_json::from_str(&serialize(&parse(&fixture("minimal.excalidraw")).unwrap()))
        .unwrap();
    let e = &out["elements"][0];
    assert_eq!(e["frameId"], Value::Null);
    assert_eq!(e["roundness"], Value::Null);
    assert_eq!(e["boundElements"], Value::Null);
    assert_eq!(e["groupIds"], serde_json::json!([]));
    assert_eq!(e["isDeleted"], false);
    assert_eq!(out["appState"], serde_json::json!({}));
    assert_eq!(out["files"], serde_json::json!({}));
    // ...and the ones it does not write for a rectangle stay unwritten.
    for absent in ["containerId", "startBinding", "points", "text", "fileId"] {
        assert!(e.get(absent).is_none(), "a rectangle gained {absent}");
    }
}

#[test]
fn whole_numbers_are_written_without_a_decimal_point() {
    // `JSON.stringify` writes 0, serde writes 0.0. Left alone, opening and
    // saving rewrites `"angle": 0` on every element of every file.
    let text = serialize(&parse(&fixture("every-kind.excalidraw")).unwrap());
    assert!(text.contains("\"angle\": 0,"), "angle: {:?}", &text[..400]);
    assert!(text.contains("\"width\": 120,"));
    assert!(text.contains("\"opacity\": 100,"));
    assert!(!text.contains(".0,"), "a whole number got a decimal point");
    // Real fractions keep theirs.
    assert!(text.contains("\"height\": 60.5,"));
    assert!(text.contains("\"angle\": 0.7853981633974483,"));
    // Including inside a point list.
    assert!(text.contains("95.5,"));
}

#[test]
fn the_indent_is_two_spaces() {
    // Matching `JSON.stringify(data, null, 2)` is what keeps a file edited here
    // and a file edited on excalidraw.com from reformatting each other.
    let text = serialize(&blank_scene());
    assert!(text.starts_with("{\n  \"type\": \"excalidraw\","), "{text}");
    assert!(!text.ends_with('\n'), "excalidraw writes no trailing newline");
}

// --- the error sentences ----------------------------------------------------

#[test]
fn a_half_written_file_explains_itself_instead_of_throwing() {
    // Opening a file mid-save is normal, not exceptional. Ported from
    // term.hut's parseScene tests so the two builds say the same thing.
    let e = parse("{\"type\":\"excalidraw\",\"elements\":[").unwrap_err();
    assert!(e.starts_with("This file isn't valid JSON ("), "{e}");
    assert!(e.ends_with(")."), "{e}");
}

#[test]
fn a_shape_library_is_not_a_scene_and_says_so() {
    let text = r#"{"type":"excalidrawlib","version":2,"libraryItems":[]}"#;
    assert_eq!(
        parse(text).unwrap_err(),
        "This is an Excalidraw \"excalidrawlib\" file, not a scene."
    );
}

#[test]
fn json_that_is_not_a_scene_at_all_is_rejected() {
    assert_eq!(
        parse("[]").unwrap_err(),
        "This file doesn't contain an Excalidraw scene."
    );
    assert_eq!(
        parse("\"hello\"").unwrap_err(),
        "This file doesn't contain an Excalidraw scene."
    );
    assert_eq!(
        parse(r#"{"type":"excalidraw"}"#).unwrap_err(),
        "This scene has no elements array."
    );
    assert_eq!(
        parse(r#"{"elements":{}}"#).unwrap_err(),
        "This scene has no elements array."
    );
}

#[test]
fn a_scene_with_a_malformed_element_names_the_problem() {
    // The one case where quoting serde is right: the file really is broken and
    // the detail is where the fix is.
    let e = parse(r#"{"type":"excalidraw","elements":[{"id":"a","type":"rectangle","x":"NaN"}]}"#)
        .unwrap_err();
    assert!(e.starts_with("This scene has an element we can't read ("), "{e}");
}

#[test]
fn a_scene_without_a_type_is_still_a_scene() {
    // parseScene only rejects a `type` that says otherwise. It gains the key on
    // save, which is what Excalidraw's own export does.
    let scene = parse(r#"{"elements":[]}"#).unwrap();
    assert_eq!(scene.kind, "excalidraw");
    assert_eq!(scene.version, 2);
    assert_eq!(serialize(&scene).lines().next().unwrap(), "{");
    assert!(serialize(&scene).contains("\"type\": \"excalidraw\""));
    // We do not sign somebody else's file.
    assert!(!serialize(&scene).contains("source"));
}

#[test]
fn a_blank_scene_is_a_scene() {
    let blank = blank_scene();
    let text = serialize(&blank);
    assert_eq!(parse(&text).unwrap(), blank);
    assert_eq!(blank.app_state["viewBackgroundColor"], "#ffffff");
    assert_eq!(blank.app_state["gridSize"], Value::Null);
    assert!(blank.elements.is_empty());
    assert_eq!(blank.source, format::SOURCE);
}

// --- the property test ------------------------------------------------------

/// Every key `Element`, `Scene` and `Binding` model. A generated `rest` may not
/// contain one: `flatten` writes the struct's fields and then the map, so a
/// collision emits the key twice and the reader takes the second. That is a
/// bug worth its own guard rather than a shape to generate.
const MODELLED: &[&str] = &[
    "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor",
    "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds", "frameId",
    "roundness", "seed", "version", "versionNonce", "isDeleted", "boundElements", "updated",
    "locked", "index", "link", "text", "originalText", "fontSize", "fontFamily", "textAlign", "verticalAlign",
    "containerId", "lineHeight", "points", "pressures", "lastCommittedPoint", "startBinding",
    "endBinding", "fileId", "elementId", "focus", "gap", "source", "elements", "appState", "files",
];

const KNOWN_KINDS: &[&str] = &[
    "rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "image", "frame",
];

mod arb {
    use super::*;
    use proptest::prelude::*;

    fn key() -> impl Strategy<Value = String> {
        "[a-zA-Z][a-zA-Z0-9]{0,7}".prop_filter("collides with a modelled key", |k| {
            !MODELLED.contains(&k.as_str())
        })
    }

    /// Numbers worth generating: whole ones (which exercise the integer
    /// spelling) and fractional ones (which must keep their decimals).
    fn number() -> impl Strategy<Value = f64> {
        prop_oneof![
            (-10_000i64..10_000).prop_map(|i| i as f64),
            -1.0e6f64..1.0e6,
        ]
    }

    fn json() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i64>().prop_map(|i| Value::Number(i.into())),
            number().prop_map(|f| serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)),
            ".{0,12}".prop_map(Value::String),
        ];
        leaf.prop_recursive(3, 16, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                prop::collection::vec((key(), inner), 0..4)
                    .prop_map(|kv| Value::Object(kv.into_iter().collect())),
            ]
        })
    }

    fn rest() -> impl Strategy<Value = Map<String, Value>> {
        prop::collection::vec((key(), json()), 0..4).prop_map(|kv| kv.into_iter().collect())
    }

    fn kind() -> impl Strategy<Value = ElementKind> {
        prop_oneof![
            Just(ElementKind::Rectangle),
            Just(ElementKind::Diamond),
            Just(ElementKind::Ellipse),
            Just(ElementKind::Line),
            Just(ElementKind::Arrow),
            Just(ElementKind::Freedraw),
            Just(ElementKind::Text),
            Just(ElementKind::Image),
            Just(ElementKind::Frame),
            // An `Other` that spells a known kind would come back as that
            // known kind — correctly, and not equal to what we generated.
            "[a-z]{1,10}"
                .prop_filter("a known kind", |s| !KNOWN_KINDS.contains(&s.as_str()))
                .prop_map(ElementKind::Other),
        ]
    }

    pub fn element() -> impl Strategy<Value = Element> {
        (
            "[a-zA-Z0-9_-]{1,12}",
            kind(),
            (number(), number(), number(), number(), number()),
            (any::<i64>(), any::<i64>(), any::<i64>(), any::<Option<i64>>()),
            (
                prop::option::of("#[0-9a-f]{6}"),
                prop::option::of("[a-z]{1,8}"),
                prop::option::of(number()),
                prop::option::of(prop::collection::vec("[a-z0-9]{1,8}", 0..3)),
                prop::option::of(prop::collection::vec(
                    (number(), number()).prop_map(|(a, b)| [a, b]),
                    0..6,
                )),
                // Fractional indexes are short strings from a base-62-ish
                // alphabet ("a0", "a1", "a0V"); `None` is the legal
                // "not yet indexed" state of a pre-2024 file.
                prop::option::of("a[0-9A-Za-z]{1,3}"),
                prop::option::of("https://[a-z]{1,8}\\.example"),
            ),
            any::<bool>(),
            rest(),
        )
            .prop_map(
                |(id, kind, (x, y, w, h, angle), (seed, version, nonce, updated), (color, style, size, groups, points, index, link), deleted, rest)| {
                    Element {
                        id,
                        kind,
                        x,
                        y,
                        width: w,
                        height: h,
                        angle,
                        stroke_color: color,
                        background_color: None,
                        fill_style: style.clone(),
                        stroke_width: size,
                        stroke_style: style,
                        roughness: size,
                        opacity: size,
                        group_ids: groups.unwrap_or_default(),
                        frame_id: None,
                        index,
                        link,
                        roundness: None,
                        seed,
                        version,
                        version_nonce: nonce,
                        is_deleted: deleted,
                        bound_elements: None,
                        updated,
                        locked: Some(deleted),
                        text: None,
                        original_text: None,
                        font_size: size,
                        font_family: updated,
                        text_align: None,
                        vertical_align: None,
                        container_id: None,
                        line_height: size,
                        points,
                        pressures: None,
                        last_committed_point: None,
                        start_binding: None,
                        end_binding: None,
                        file_id: None,
                        rest,
                    }
                },
            )
    }

    pub fn scene() -> impl Strategy<Value = Scene> {
        (
            prop::collection::vec(element(), 0..4),
            rest(),
            rest(),
            rest(),
            any::<i64>(),
        )
            .prop_map(|(elements, app_state, files, rest, version)| Scene {
                // `parse` rejects any other type, so generating one would only
                // test the rejection, which has its own test.
                kind: "excalidraw".to_string(),
                version,
                source: "https://excalidraw.com".to_string(),
                elements,
                app_state,
                files,
                rest,
            })
    }
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(256))]

    /// The acceptance criterion from PLAN.md, Phase 1: arbitrary scene →
    /// serialize → parse → equal.
    #[test]
    fn prop_arbitrary_scene(scene in arb::scene()) {
        let text = serialize(&scene);
        let back = parse(&text).expect("our own output must parse");
        proptest::prop_assert_eq!(&scene, &back);
        // And writing it again produces the identical bytes, which is what
        // makes an idle autosave a no-op rather than a diff.
        proptest::prop_assert_eq!(text, serialize(&back));
    }

    /// No object we write has the same key twice.
    ///
    /// `flatten` emits the struct's own fields and then `rest` verbatim, so a
    /// `rest` holding a modelled key writes it twice; every JSON reader takes
    /// the second, which means the edit that set the field silently did not
    /// stick. The check works because reading our output into a `Value` and
    /// writing it again is a no-op *unless* something collapsed on the way in —
    /// `preserve_order` keeps the order, `to_string_pretty` is the same writer,
    /// and a duplicate key is the one thing an object cannot hold.
    #[test]
    fn prop_no_duplicate_keys(scene in arb::scene()) {
        let text = serialize(&scene);
        let reread: Value = serde_json::from_str(&text).unwrap();
        proptest::prop_assert_eq!(&text, &serde_json::to_string_pretty(&reread).unwrap());
    }
}

#[test]
fn a_coordinate_survives_to_the_last_bit() {
    // serde_json's default float parser is *not* correctly rounded: it reads
    // -932956.6664465701 back as a different f64. That number is the shortest
    // round-trip spelling of its own value, which is exactly what
    // `JSON.stringify` writes — so on a default build, opening and saving a
    // drawing nudges coordinates Excalidraw itself wrote. The fix is the
    // `float_roundtrip` feature in Cargo.toml, and this test is what stops a
    // future dependency tidy-up from quietly removing it.
    let hard = [
        -932_956.666_446_570_1_f64,
        0.100_000_000_000_000_02,
        123_456_789.123_456_79,
        1.797_693_134_862_315_7e308,
        5e-324,
    ];
    for value in hard {
        let text = format!(
            r#"{{"type":"excalidraw","elements":[{{"id":"a","type":"rectangle","x":{value:?}}}]}}"#
        );
        let back = parse(&text).unwrap().elements[0].x;
        assert_eq!(back.to_bits(), value.to_bits(), "{value:?} came back as {back:?}");
        // And out again: our writer must not round it either.
        let out = parse(&serialize(&parse(&text).unwrap())).unwrap().elements[0].x;
        assert_eq!(out.to_bits(), value.to_bits(), "{value:?} was rounded on the way out");
    }
}
