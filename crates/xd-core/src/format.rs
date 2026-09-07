//! Reading and writing `.excalidraw` files.
//!
//! This is a port of term.hut's `parseScene`, and it keeps that function's
//! most important property: **a file that will not open explains itself in a
//! sentence rather than throwing.** Opening a half-written file mid-save is a
//! normal thing to do, not an exceptional one, and the caller has a pane to
//! put the sentence in. Every error below is written to be read by whoever
//! double-clicked the file, not by whoever wrote this module — no "expected
//! value at line 1 column 1" leaking out on its own.
//!
//! The other half of the contract is the one the whole crate is built around:
//! what comes out is what went in. [`serialize`] writes with a two-space
//! indent because that is what `JSON.stringify(data, null, 2)` produces and
//! that is what excalidraw.com puts in the file; `scene.rs` handles the rest
//! of the spelling. A save that reformats a drawing nobody edited is a diff
//! the user has to read and a merge conflict they have to resolve.

use crate::scene::{Element, Scene};
use serde_json::{Map, Value};

/// Read a `.excalidraw` file.
///
/// The error is a sentence fit to show in a pane. The checks run in the same
/// order term.hut's `parseScene` runs them, so the two builds say the same
/// thing about the same bad file.
pub fn parse(text: &str) -> Result<Scene, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| format!("This file isn't valid JSON ({e})."))?;

    let object = match &value {
        Value::Object(map) => map,
        // Valid JSON, but an array or a bare string is not a drawing.
        _ => return Err("This file doesn't contain an Excalidraw scene.".to_string()),
    };

    // `type` is "excalidraw" for a scene and "excalidrawlib" for a shape
    // library; a library holds `libraryItems` instead of elements and is not a
    // drawing. Naming the type back to the user is the difference between
    // "this didn't work" and "you opened the wrong file".
    if let Some(Value::String(kind)) = object.get("type") {
        if kind != "excalidraw" {
            return Err(format!(
                "This is an Excalidraw \"{kind}\" file, not a scene."
            ));
        }
    }

    if !matches!(object.get("elements"), Some(Value::Array(_))) {
        return Err("This scene has no elements array.".to_string());
    }

    // Only now is it worth handing to serde. Anything that fails here is a
    // real scene with a field of the wrong shape — rare, and worth quoting the
    // detail for, because the fix is in the file.
    serde_json::from_value(value)
        .map_err(|e| format!("This scene has an element we can't read ({e})."))
}

/// Write a scene back out, the way excalidraw.com writes it: two-space indent,
/// no trailing newline.
pub fn serialize(scene: &Scene) -> String {
    // The only way `to_string_pretty` fails on a `Scene` is a non-finite float,
    // which cannot get into one: `parse` would have rejected it (JSON has no
    // NaN) and no command in this crate produces one. Falling back to an empty
    // string here would be worse than the panic — see `worthSaving` in PLAN.md
    // Phase 5, the caller must never write a placeholder over a real drawing.
    serde_json::to_string_pretty(scene).expect("a Scene is always representable as JSON")
}

/// An empty scene, shaped the way excalidraw.com shapes a new one.
///
/// `gridSize: null` and `viewBackgroundColor` are the two `appState` keys
/// Excalidraw always writes; starting from its own shape means a file we
/// create and a file it creates differ only in `source`.
pub fn blank_scene() -> Scene {
    let mut app_state = Map::new();
    app_state.insert("gridSize".to_string(), Value::Null);
    app_state.insert(
        "viewBackgroundColor".to_string(),
        Value::String("#ffffff".to_string()),
    );

    Scene {
        kind: "excalidraw".to_string(),
        version: 2,
        source: SOURCE.to_string(),
        elements: Vec::new(),
        app_state,
        files: Map::new(),
        rest: Map::new(),
    }
}

/// What we write in `source`. Excalidraw puts the URL of the editor that wrote
/// the file here; it is informational and nothing reads it, but claiming to be
/// excalidraw.com when we are not would be a lie in someone's file.
pub const SOURCE: &str = "https://github.com/hutsonlabs/excalidraw-rs";

/// The elements a painter should draw: everything not deleted.
///
/// Deleted elements stay in the file — Excalidraw keeps them so undo and
/// merging edits from another client still work — and must not be drawn. They
/// must also not be dropped on save, which is why this is a view over the
/// scene and not something [`parse`] does.
pub fn visible_elements(scene: &Scene) -> impl Iterator<Item = &Element> {
    scene.elements.iter().filter(|e| !e.is_deleted)
}
