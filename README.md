# excalidraw-rs

A native `.excalidraw` editor. Rust owns the document; JavaScript keeps the
paintbrush.

## Why this exists

term.hut can already *render* `.excalidraw` files, and does it well — the
format is JSON, the hand-drawn look is Rough.js plus perfect-freehand, and both
are framework-free. What it declined to build was the other half, because
Excalidraw's editor is a React application and the portable thing is the
format, not the app.

This is that other half. The parts that are genuinely hard — the format's
compatibility surface, geometry, hit-testing, transforms, bindings, undo — are
Rust, compiled to WASM. The parts that already work stay JavaScript.

## Layout

```
crates/xd-core/   the document model. No I/O, no wasm, no rendering.
crates/xd-wasm/   the wasm-bindgen shim. The only crate that knows JS exists.
src-tauri/        the app's native half: read a file, write a file.
ui/src/           the portable view — what term.hut will eventually receive.
ui/standalone/    this app's own surface. None of it ports.
ui/vendor/        Rough.js, perfect-freehand, and the built WASM core.
```

The discipline that makes the eventual port cheap: **the standalone app is a
host for a view, not an app with a view bolted on.** `excalidrawEdit.js` never
imports from `standalone/`, never calls `invoke`, and never touches anything
outside the host element it was handed. `scripts/check-imports.mjs` enforces
that in CI rather than trusting anyone to remember it.

## Building

```sh
cargo test -p xd-core          # the model
bun test                       # the view and the boundary
scripts/build-wasm.sh          # rebuild + re-vendor the WASM core (586 KB budget)
cargo tauri dev                # run the app
cargo tauri build              # a signed .app + .dmg
```

`scripts/build-wasm.sh` must be re-run and its output committed whenever
anything under `crates/` changes: `ui/` is served straight off disk with no
bundler, so what is committed is what ships. CI fails if the two drift.

## Licensing

Two licences, and the split is load-bearing. `crates/` is MIT OR Apache-2.0 so
that anything may depend on the document model. The app, `ui/`, and everything
in `ui/standalone/` are PolyForm-Noncommercial-1.0.0. The dependency arrow runs
one way only, and `scripts/check-licenses.sh` asserts it. See `LICENSE`.

## Status

See `PLAN.md` for the whole shape and `docs/CORE-API.md` for the crate's API
contract.
