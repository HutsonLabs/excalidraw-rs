# xd-core

The `.excalidraw` document model in pure Rust: the format, geometry,
hit-testing, transforms, bindings and undo/redo. No I/O, no rendering, no
`wasm`, no async — the parts of a drawing editor that are worth a type system,
and nothing else.

It compiles to WebAssembly without a shim (`xd-wasm` is the only crate that
knows JavaScript exists) and has two dependencies, `serde` and `serde_json`.

## What it is for

Reading, editing and writing `.excalidraw` files **without damaging them.**

Excalidraw's schema drifts release to release. A viewer that misreads a field
draws something wrong and you can see it; an editor that misreads a field
writes the file back without it, and you find out weeks later when the arrow no
longer follows the box. So every element keeps a `rest` map of the keys this
crate does not model, and they come back out with their values intact — nested
objects, arrays, `customData`, whatever the next release adds.

```rust
use xd_core::format::{parse, serialize};

let scene = parse(&std::fs::read_to_string("diagram.excalidraw")?)?;
println!("{} elements", scene.elements.len());
std::fs::write("diagram.excalidraw", serialize(&scene))?;
```

That write is the point: every key the file carried comes back with its value,
down to the last bit of every coordinate, with a two-space indent, Excalidraw's
own key order and whole numbers spelled without a decimal point — the way
`JSON.stringify(data, null, 2)` in a browser wrote it in the first place. The
one thing a save moves is unknown keys, which land at the end of the element
they came from rather than in their original slot; it happens once and the
output is a fixed point thereafter.

`parse` fails with a sentence, not a stack trace, because a half-written file
mid-save is a normal thing to open:

```text
This file isn't valid JSON (EOF while parsing an object at line 1 column 34).
This is an Excalidraw "excalidrawlib" file, not a scene.
This scene has no elements array.
```

## What it deliberately does not do

**Rendering.** Excalidraw's hand-drawn look is [Rough.js] plus
[perfect-freehand], and matching it exactly is the whole compatibility story.
This crate holds the document; a canvas painter holds the brush. Nothing in
here knows what a pixel is.

## Layout

| Module | |
| --- | --- |
| `scene` | `Scene`, `Element`, `ElementKind` — the format, and the `rest` passthrough that is its compatibility contract. |
| `format` | `parse`, `serialize`, `blank_scene`. |
| `geometry` | Bounds, hit-testing, resize and rotate transforms. Pure functions. |
| `command` / `doc` | `Doc` owns a scene and an undo stack; every edit is a `Command`, so no caller can forget the `version` / `versionNonce` / `updated` bookkeeping Excalidraw's own reconciliation depends on. |
| `ids` | Ids, seeds and nonces from a seedable counter — no `rand`, no system entropy, deterministic under test. |

## Status

0.1. The format layer is settled and property-tested against a corpus of real
files; the rest is being built out.

## License

MIT ([LICENSE-MIT](LICENSE-MIT)) or Apache-2.0 ([LICENSE-APACHE](LICENSE-APACHE)),
at your option. Permissive on purpose: the editor built on top of this crate is
not, and the dependency arrow only runs one way.

[Rough.js]: https://roughjs.com
[perfect-freehand]: https://github.com/steveruizok/perfect-freehand
