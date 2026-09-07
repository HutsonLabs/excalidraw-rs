//! The `.excalidraw` format, losslessly.
//!
//! The single most important decision in this crate is [`Element::rest`].
//! Excalidraw's schema drifts release to release: fields appear, and a file
//! written by a newer version carries keys we have never heard of. Anything we
//! do not model must survive a round trip untouched, or we silently destroy
//! other people's drawings. `rest` is not a convenience; it is the
//! compatibility contract, and every test in this module exists to defend it.
//!
//! Three fields look like bookkeeping and are not:
//!
//! - `seed` — Rough.js is deterministic in it. Preserve it on every edit or the
//!   hand-drawn strokes re-scramble on save and the diagram visibly twitches
//!   after every keystroke. Only a brand-new element gets a fresh one.
//! - `version` / `version_nonce` — Excalidraw's own reconciliation depends on
//!   these; bumping them correctly now is the difference between collaboration
//!   later and a rewrite later.
//! - `updated` — epoch milliseconds, same rule.
//!
//! ## Writing the file back the way Excalidraw writes it
//!
//! Three rules below look like fussiness and are each a bug we would otherwise
//! ship. They exist because `serde`'s convenient defaults are the wrong ones
//! for a format whose writer is `JSON.stringify` in a browser.
//!
//! 1. **A modelled key Excalidraw always writes is always written.** `frameId`,
//!    `roundness` and `boundElements` are `null` on most real elements and
//!    `groupIds` is usually `[]`. With `skip_serializing_if` those keys would
//!    deserialize to `None`/empty and then vanish on save — a key silently
//!    deleted from every element of every file we touch. So they carry no skip:
//!    absent means `null`, which is exactly what Excalidraw writes.
//!
//! 2. **Field order matches Excalidraw's.** `#[serde(flatten)]` emits the
//!    declared fields first and `rest` last, so the declaration order below is
//!    the output order. Putting it in Excalidraw's own order keeps a save from
//!    rewriting every line of a file in which nothing changed. (Unknown keys
//!    still land at the end rather than in their original slots; that is the
//!    one ordering difference left, and it costs a few lines of diff rather
//!    than all of them.)
//!
//! 3. **Whole numbers are written without a decimal point** — see [`jsnum`].
//!
//! What is *not* preserved, deliberately: an explicit `null` on a key
//! Excalidraw only writes for one element kind (`containerId` on text,
//! `startBinding` / `endBinding` / `lastCommittedPoint` on a line or arrow).
//! Those deserialize to `None` and are omitted. A null there means "not bound"
//! and an absent key reads back identically, so nothing is lost but the
//! spelling — and the alternative would be emitting `"containerId": null` on
//! rectangles, which Excalidraw never does.
//!
//! No I/O, no rendering, no wasm. See `docs/CORE-API.md` for the boundary.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Whole numbers, written the way `JSON.stringify` writes them.
///
/// Every coordinate in this format is a JSON number that Rust holds as `f64`,
/// and `serde_json` spells an `f64` of 100 as `100.0`. The browser that wrote
/// the file spells it `100`. Left alone, opening and saving a drawing rewrites
/// `"angle": 0` to `"angle": 0.0` on every element — a whole-file diff in which
/// nothing actually changed, on every save, forever.
///
/// So integral values are emitted as integers. The cutoff is JavaScript's
/// safe-integer range, because past it `JSON.stringify` stops printing digits
/// too and there is no spelling left to match.
mod jsnum {
    use serde::ser::{SerializeSeq, Serializer};

    /// 2^53. Above this an `f64` no longer has integers to itself.
    const SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;

    fn is_integral(v: f64) -> bool {
        v.is_finite() && v.fract() == 0.0 && v.abs() <= SAFE_INTEGER
    }

    pub fn number<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if is_integral(*v) {
            s.serialize_i64(*v as i64)
        } else {
            s.serialize_f64(*v)
        }
    }

    pub fn opt_number<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => number(v, s),
            None => s.serialize_none(),
        }
    }

    /// `serialize_with` runs on the field, not on the element inside an
    /// `Option`, so each container shape needs its own three lines.
    pub fn opt_numbers<S: Serializer>(v: &Option<Vec<f64>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => {
                let mut seq = s.serialize_seq(Some(v.len()))?;
                for n in v {
                    seq.serialize_element(&Num(*n))?;
                }
                seq.end()
            }
            None => s.serialize_none(),
        }
    }

    pub fn opt_point<S: Serializer>(v: &Option<[f64; 2]>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(p) => point(p, s),
            None => s.serialize_none(),
        }
    }

    pub fn opt_points<S: Serializer>(v: &Option<Vec<[f64; 2]>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => {
                let mut seq = s.serialize_seq(Some(v.len()))?;
                for p in v {
                    seq.serialize_element(&Pt(*p))?;
                }
                seq.end()
            }
            None => s.serialize_none(),
        }
    }

    fn point<S: Serializer>(p: &[f64; 2], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(2))?;
        seq.serialize_element(&Num(p[0]))?;
        seq.serialize_element(&Num(p[1]))?;
        seq.end()
    }

    /// A one-number adapter, because `serialize_element` wants a `Serialize`
    /// rather than a function.
    struct Num(f64);
    impl serde::Serialize for Num {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            number(&self.0, s)
        }
    }

    struct Pt([f64; 2]);
    impl serde::Serialize for Pt {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            point(&self.0, s)
        }
    }
}

/// The element types we understand. Anything else in a file — an embeddable,
/// an iframe, a magic frame — is a live web view in Excalidraw proper and
/// cannot be one here, so it round-trips as [`ElementKind::Other`] rather than
/// vanishing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ElementKind {
    Rectangle,
    Diamond,
    Ellipse,
    Line,
    Arrow,
    Freedraw,
    Text,
    Image,
    Frame,
    /// `untagged` is what makes this the fallback arm: the named variants are
    /// tried first and any other string lands here, keeping the original
    /// spelling so it goes back out as it came in.
    #[serde(untagged)]
    Other(String),
}

impl ElementKind {
    /// True for the two element types whose geometry is a point list rather
    /// than a width/height box.
    pub fn is_linear(&self) -> bool {
        matches!(self, ElementKind::Line | ElementKind::Arrow)
    }

    /// True when the element's extent comes from its `points`.
    pub fn has_points(&self) -> bool {
        self.is_linear() || matches!(self, ElementKind::Freedraw)
    }

    pub fn as_str(&self) -> &str {
        match self {
            ElementKind::Rectangle => "rectangle",
            ElementKind::Diamond => "diamond",
            ElementKind::Ellipse => "ellipse",
            ElementKind::Line => "line",
            ElementKind::Arrow => "arrow",
            ElementKind::Freedraw => "freedraw",
            ElementKind::Text => "text",
            ElementKind::Image => "image",
            ElementKind::Frame => "frame",
            ElementKind::Other(s) => s,
        }
    }
}

/// Excalidraw's corner-rounding descriptor. `type` 2 is the legacy
/// proportional scheme, 3 the current adaptive one; `value` is only present on
/// the latter.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Roundness {
    #[serde(rename = "type")]
    pub kind: i32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_number"
    )]
    pub value: Option<f64>,
}

/// One end of a bound arrow. `focus` is where along the shape the arrow aims
/// (-1..1 across the bound element's own axis) and `gap` the distance it stops
/// short — the two numbers that make a bound arrow follow its shape.
///
/// It has its own `rest` because this is the corner of the schema that moves:
/// elbow arrows added `fixedPoint`, and whatever comes next will land here too.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub element_id: String,
    #[serde(default, serialize_with = "jsnum::number")]
    pub focus: f64,
    #[serde(default, serialize_with = "jsnum::number")]
    pub gap: f64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// The back-reference from a shape to something attached to it: an arrow bound
/// to it, or the text label it contains.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoundElement {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// A point in an element's own coordinate space (relative to its `x`/`y`).
pub type Point = [f64; 2];

/// One element of a scene.
///
/// The modelled fields are the ones we manipulate. Everything else rides in
/// [`Element::rest`] and comes back out unchanged. The declaration order is
/// Excalidraw's own key order — see the module header, rule 2.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ElementKind,
    #[serde(default, serialize_with = "jsnum::number")]
    pub x: f64,
    #[serde(default, serialize_with = "jsnum::number")]
    pub y: f64,
    #[serde(default, serialize_with = "jsnum::number")]
    pub width: f64,
    #[serde(default, serialize_with = "jsnum::number")]
    pub height: f64,
    #[serde(default, serialize_with = "jsnum::number")]
    pub angle: f64,

    // --- appearance ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_style: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_number"
    )]
    pub stroke_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_style: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_number"
    )]
    pub roughness: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_number"
    )]
    pub opacity: Option<f64>,

    // --- structure ---
    // The four below are written unconditionally: Excalidraw writes them on
    // every element, so skipping them would delete a key from every element of
    // every file we save. Module header, rule 1.
    #[serde(default)]
    pub group_ids: Vec<String>,
    #[serde(default)]
    pub frame_id: Option<String>,
    #[serde(default)]
    pub roundness: Option<Roundness>,

    // --- bookkeeping: see the module header before touching any of these ---
    #[serde(default)]
    pub seed: i64,
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub version_nonce: i64,
    #[serde(default)]
    pub is_deleted: bool,

    #[serde(default)]
    pub bound_elements: Option<Vec<BoundElement>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,

    // --- text ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_text: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_number"
    )]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_number"
    )]
    pub line_height: Option<f64>,

    // --- linear + freedraw geometry ---
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_points"
    )]
    pub points: Option<Vec<Point>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_numbers"
    )]
    pub pressures: Option<Vec<f64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::opt_point"
    )]
    pub last_committed_point: Option<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_binding: Option<Binding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_binding: Option<Binding>,

    // --- image ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,

    /// Everything the fields above do not name. The compatibility contract:
    /// unknown keys go in here on parse and come back out on serialize, in the
    /// order the file had them (`serde_json/preserve_order`) and with the
    /// numbers spelled as the file spelled them.
    ///
    /// Never put a modelled key in here. `flatten` writes the struct's own
    /// fields first and then this map verbatim, so a collision emits the key
    /// twice and the reader takes the second one — a mutation that silently
    /// does not stick.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

fn default_scene_kind() -> String {
    "excalidraw".to_string()
}

fn default_scene_version() -> i64 {
    2
}

/// A parsed `.excalidraw` file.
///
/// `app_state` and `files` are held as raw JSON because nothing in this crate
/// decides anything about them — they exist to be handed back on save exactly
/// as they arrived. Both are written unconditionally, `{}` and all, because
/// Excalidraw writes both on every export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    /// Always `"excalidraw"` for a scene. A file that omits it is still a
    /// scene — `format::parse` only rejects a `type` that says otherwise — but
    /// it gains the key on save, which is what Excalidraw's own export does.
    #[serde(rename = "type", default = "default_scene_kind")]
    pub kind: String,
    #[serde(default = "default_scene_version")]
    pub version: i64,
    /// The URL of the editor that wrote it. Absent in hand-written files, and
    /// we do not invent one for somebody else's drawing.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    pub elements: Vec<Element>,
    #[serde(default, rename = "appState")]
    pub app_state: Map<String, Value>,
    #[serde(default)]
    pub files: Map<String, Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}
