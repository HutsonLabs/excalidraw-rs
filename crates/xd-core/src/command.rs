//! Commands — the only way a scene ever changes.
//!
//! The rule this module exists to enforce: **no caller pokes a field.** An
//! edit is a value describing what should happen, handed to [`Doc::apply`],
//! and `apply` does the Phase 1 version bookkeeping on the way through —
//! `version += 1`, a fresh `versionNonce`, `updated = now`, for every element
//! the command touched. If callers could reach a `&mut Element` they would
//! forget that bookkeeping exactly once, in the one code path nobody tests,
//! and Excalidraw's reconciliation would quietly stop working. So they can't.
//!
//! The same rule is what makes undo possible at all: `apply` sees every
//! mutation, so it can record the inverse of every mutation. A field poke is
//! invisible to history by construction.
//!
//! [`Command`] is a *description*, not a closure. It is cheap to clone, easy
//! to log, and — the part that matters for Phase 4 — trivial to build on the
//! JS side of the WASM boundary from a small integer tag and a few numbers.
//!
//! [`Doc::apply`]: crate::doc::Doc::apply

use serde_json::{Map, Value};

use crate::scene::{Binding, Element};

/// Where a z-order change moves the named elements.
///
/// `Front`/`Back` jump the whole way; `Forward`/`Backward` step one position,
/// and step *past* unselected elements only — moving a multi-selection forward
/// must not let its members overtake each other, or a repeated key press
/// scrambles their relative order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reorder {
    Front,
    Back,
    Forward,
    Backward,
}

/// Which end of an arrow a binding belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Start,
    End,
}

impl End {
    /// The JSON key this end lives under. Named here rather than spelled out
    /// at each use so the two ends can never drift apart.
    pub fn key(self) -> &'static str {
        match self {
            End::Start => "startBinding",
            End::End => "endBinding",
        }
    }
}

/// One undoable edit.
///
/// Note what is *not* here: nothing that reads the scene and decides
/// something. Hit-testing, resize maths and snapping all live in
/// `geometry.rs` as pure functions that return values; the caller turns the
/// value they returned into a `Patch`. That split is why an interaction can be
/// tried, previewed and abandoned without the document ever hearing about it.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Place an element in the scene. `at` is a z-order index; `None` means
    /// on top. The element arrives complete — [`Doc::new_element`] is the
    /// constructor and has already stamped its id, seed and version.
    ///
    /// [`Doc::new_element`]: crate::doc::Doc::new_element
    Insert {
        at: Option<usize>,
        element: Box<Element>,
    },

    /// Remove elements, and unhook every reference the survivors held to them
    /// — an arrow bound to a deleted rectangle must lose that binding, or the
    /// file names an element that is not there and Excalidraw refuses to open
    /// it cleanly.
    Delete { ids: Vec<String> },

    /// camelCase JSON keys applied over the element, exactly the shape the
    /// file uses — `{"x": 10, "strokeColor": "#f00"}`. A `null` value removes
    /// the key, which for a modelled field means "back to its default".
    ///
    /// Keys are applied to the element's JSON form, so a key this crate does
    /// not model lands in `Element::rest` and round-trips like any other
    /// unknown field. That is deliberate: a caller can carry a newer
    /// Excalidraw field through an edit without this crate learning about it.
    ///
    /// `seed` is silently dropped. Rough.js is deterministic in the seed, so
    /// rewriting one makes the hand-drawn strokes visibly twitch after every
    /// keystroke. `id` is dropped for the same class of reason — an element
    /// that renames itself mid-edit is not a thing history can invert.
    Patch {
        id: String,
        fields: Map<String, Value>,
    },

    /// Change z-order. This moves array positions and touches no element
    /// field, so it does not bump any version.
    Reorder { ids: Vec<String>, how: Reorder },

    /// Put the named elements in a new group, appending to whatever groups
    /// they are in already. Excalidraw orders `groupIds` innermost-first, so
    /// the new group goes on the end.
    Group { ids: Vec<String> },

    /// Take the named elements out of their outermost group — the last entry
    /// of `groupIds`, which is the group a click on any member selects.
    Ungroup { ids: Vec<String> },

    /// Attach or detach one end of an arrow.
    ///
    /// Binding is two-sided in the format: the arrow names the shape in
    /// `startBinding`/`endBinding`, and the shape names the arrow back in its
    /// `boundElements`. This command maintains both halves, including
    /// removing the back-reference from a shape the arrow is being detached
    /// from. Half a binding is the single most common way a hand-written
    /// `.excalidraw` file misbehaves in Excalidraw proper.
    Bind {
        arrow: String,
        end: End,
        binding: Option<Binding>,
    },

    /// Put a text element inside a container as its label.
    ///
    /// Like [`Command::Bind`] this is two-sided — the text names the container
    /// in `containerId`, the container names the text back in `boundElements`
    /// as `{id, type: "text"}` — and for the same reason: Excalidraw trusts
    /// both halves and misbehaves around half a binding. It is a separate
    /// command rather than a case of `Bind` because `Bind` is
    /// arrow-endpoint-shaped: it names one of two ends and carries a
    /// `focus`/`gap` pair, and a label has neither an end nor a gap.
    ///
    /// A text already bound to another container is detached from it first, so
    /// the old container cannot keep a back-reference to a label it no longer
    /// holds.
    BindLabel { container: String, text: String },

    /// Take a label out of its container, both halves. The text survives as a
    /// free-floating element, which is what Excalidraw's own unbind does.
    UnbindLabel { text: String },

    /// Write an entry into the scene's `files` map — the image bytes an
    /// `image` element's `fileId` names.
    ///
    /// The map is held as raw JSON (`Scene::files`) because nothing in this
    /// crate decides anything about its contents, and this command keeps that
    /// property: the entry crosses through untouched. It exists so that
    /// inserting an image is *one* undoable act. Without it the element could
    /// be undone and its bytes could not, which is a document that renders a
    /// grey placeholder for a file nobody can reach.
    PutFile { id: String, entry: Value },

    /// Take an entry out of `files`. The inverse of [`Command::PutFile`], and
    /// what undoing an image insert runs.
    DropFile { id: String },

    /// Merge keys into the scene's `appState` — the canvas background colour,
    /// the theme, the grid size. A `null` value removes a key.
    ///
    /// **Shallow, and deliberately incurious.** `Scene::app_state` is a raw
    /// JSON map because nothing in this crate decides anything about its
    /// contents, and this command is written to keep that true: it merges the
    /// keys it is given, leaves every other key alone — including nested
    /// objects it has never heard of — and models nothing. A deep merge would
    /// have to have opinions about which subtrees are records and which are
    /// values, and it would be wrong about somebody's `collaborators` map on the
    /// first release that changed it.
    SetAppState { fields: Map<String, Value> },

    /// Re-roll the `seed` of the named elements.
    ///
    /// This is the one sanctioned way a seed ever changes on an element that
    /// already has one, and it is deliberately its own command rather than a
    /// relaxation of [`Command::Patch`]'s `seed` filter. The difference is
    /// intent: a patch carrying a seed is a caller that did not mean it —
    /// forwarding an element's own JSON back through an edit — and dropping it
    /// keeps the strokes from twitching on every keystroke. A `Reseed` is a
    /// user asking for a *different sketch of the same shape*, which is what
    /// Excalidraw's sloppiness buttons do (`actionProperties.tsx` re-rolls
    /// `seed` alongside `roughness`) and the reason changing sloppiness here
    /// reads as "the line got bolder" instead of "the hand changed".
    ///
    /// Recorded like any other write, so undo puts the old seed back exactly.
    Reseed { ids: Vec<String> },

    /// Several commands as one undo entry — dragging a multi-selection is one
    /// `Batch` of one `Patch` per element, and one press of undo puts all of
    /// them back.
    Batch(Vec<Command>),
}

impl Command {
    /// Sugar for the overwhelmingly common single-field patch.
    pub fn patch1(id: impl Into<String>, key: &str, value: Value) -> Command {
        let mut fields = Map::new();
        fields.insert(key.to_string(), value);
        Command::Patch {
            id: id.into(),
            fields,
        }
    }

    /// Move an element to an absolute position. Named because "set x and y"
    /// is what half the callers in Phase 6 want and spelling it out at each
    /// site invites one of them to set only `x`.
    pub fn move_to(id: impl Into<String>, x: f64, y: f64) -> Command {
        let mut fields = Map::new();
        fields.insert("x".to_string(), json_num(x));
        fields.insert("y".to_string(), json_num(y));
        Command::Patch {
            id: id.into(),
            fields,
        }
    }
}

/// A JSON number, or `null` for a non-finite one. `serde_json` has no
/// representation for NaN or infinity, and a silent `null` is better than a
/// panic in the middle of a drag — the key simply reverts to its default,
/// which for a coordinate is 0.
pub(crate) fn json_num(v: f64) -> Value {
    serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
}
