//! `xd-core` — the `.excalidraw` document model in pure Rust.
//!
//! Rust owns the document; JavaScript keeps the paintbrush. This crate holds
//! the format, the geometry, hit-testing, transforms, bindings and undo/redo —
//! the parts that are genuinely hard, benefit from a type system, and are
//! worth property-testing. Rendering lives in the JS canvas painter and no
//! rendering concern may leak in here (PLAN.md, "The architecture decision").
//!
//! There is no I/O in this crate and no wasm. `xd-wasm` is the only crate that
//! knows JavaScript exists.
#![forbid(unsafe_code)]

pub mod command;
pub mod doc;
pub mod format;
pub mod geometry;
pub mod ids;
pub mod ops;
pub mod scene;

pub use command::Command;
pub use doc::Doc;
pub use scene::{Binding, BoundElement, Element, ElementKind, Point, Roundness, Scene};
