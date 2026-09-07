# excalidraw-rs — a Rust `.excalidraw` editor, standalone and in term.hut

## What we're actually starting from

term.hut already renders `.excalidraw`. `ui/src/excalidrawView.js` draws a scene
with Rough.js + perfect-freehand; `ui/src/excalidrawScene.js` holds everything
decidable without a canvas (bounds, fit transform, rough options, text layout)
and is tested under `bun:test`. The view's own header says why it stops there:

> Read-only by design. Excalidraw's editor is a React application; what's
> portable is the *format* … a human who wants to redraw one opens Excalidraw.

That sentence is the project. We are not building a viewer — one exists, it is
good, and it stays. We are building the half that was declined, in Rust, and
then deleting that paragraph.

Four facts from the survey that set the constraints:

- **`.bpmn` is the precedent, not `.excalidraw`.** `bpmnView.js` is an editable
  view in the preview pane with a settled contract:
  `renderBpmn(host, text, { onSave, onActions }) -> dispose`. Autosave on an
  800 ms idle debounce, a `worthSaving` guard so a failed export never lands on
  a real diagram, Fit/Save contributed to the pane header rather than a toolbar.
  Everything below is shaped to fit that contract exactly.
- **No bundler.** `ui/` is vanilla ES modules served straight from disk
  (`frontendDist: "../ui"`), deps vendored as `.esm.js`. Anything we ship must
  load as a plain ES module.
- **`csp: null`**, and `src-tauri/src/web/mod.rs:1106` already serves
  `application/wasm`. WASM works in both the Tauri webview and the `hut web`
  browser build with zero plumbing. This is the reason the plan below is viable.
- **Lazy loading is established.** bpmn-js is 586 KB and dynamically imported on
  first `.bpmn` open. That sets our size budget: a lazily-loaded WASM core at or
  under ~586 KB is precedented, not a regression.

## The architecture decision

**Rust owns the document; JavaScript keeps the paintbrush.**

`xd-core` gets the format, geometry, hit-testing, transforms, bindings, and
undo/redo — the parts that are genuinely hard, benefit from a type system, and
are worth property-testing. Rendering stays in the existing JS canvas painter.

Why not render in Rust too: the painter already exists, is tested, and themes
itself from term.hut's CSS custom properties. The Rust alternative is `rough-rs`
— 85 lifetime downloads, 0.1.0, unproven — and swapping a working renderer for
it buys nothing a user can see while risking every drawing looking subtly wrong.
Rough.js is also the reference implementation of the sketchy geometry; matching
it is the whole compatibility story.

**Settled.** If it is ever revisited, Phase 4's boundary is the only place it
changes — Phases 1–3 are rendering-agnostic by construction, so the door stays
open at no ongoing cost. Keep it that way: no rendering concern may leak into
`xd-core`.

## Layout

```
excalidraw-rs/
  crates/
    xd-core/        pure Rust: scene, geometry, commands, history. No I/O, no wasm.
    xd-wasm/        cdylib; wasm-bindgen shim over xd-core. The only crate that
                    knows about JS.
  src-tauri/        Tauri v2 shell for the standalone app (matches term.hut's
                    plugin set: dialog, opener, window-state).
  ui/
    src/
      excalidrawEdit.js    THE PORTABLE UNIT. renderExcalidraw(host, text, {onSave, onActions})
      excalidrawTools.js   tool state machine (pointer -> intent)
      xdWasm.js            the only file that knows wasm-bindgen exists
      excalidrawView.js    copied from term.hut, extended with selection chrome
      excalidrawScene.js   copied; shrinks as Phase 2 moves its math into Rust
    standalone/            the shipped app's own surface. NOTHING here ports.
      shell.js               windows, tabs, recents, preferences
      files.js               open/save dialogs, file associations
      export.js              PNG/SVG export wiring (the capability itself is portable)
      dom.js, viewActions.js, colorpicker.js   copied verbatim from term.hut
    vendor/
      roughjs/, perfect-freehand/   copied from term.hut
      xd-wasm/                       wasm-pack --target web output
  test/             bun:test, same runner as term.hut
```

The discipline that makes the port cheap: **the standalone app is a host for a
term.hut view, not an app with a view bolted on.** `excalidrawEdit.js` must
never import from `standalone/`, never call `invoke`, and never touch anything
outside the host element it was handed. Same rule `preview.js` already states
about itself ("No invoke() here on purpose").

That rule now has to survive a long time unaided. The app ships as a product and
the port comes last, so for most of this project's life the portable unit's only
consumer is an app that has every incentive to reach into it. Discipline by
intention will not hold that long — so it is mechanised in Phase 5 as an
import-allowlist check in CI, and that check is the single highest-leverage
thing in this plan.

---

## Phase 0 — Scaffold

Cargo workspace, `wasm-pack`, `bun test`, CI running `cargo test`,
`cargo clippy -- -D warnings`, and `bun test`. Tauri v2 shell that opens an
empty window.

**Licensing — settled, and it constrains the dependency graph.**
`xd-core` and `xd-wasm` are MIT OR Apache-2.0 (the Rust norm, dual so downstream
picks). The Tauri app, `ui/`, and everything in `standalone/` are
PolyForm-Noncommercial-1.0.0, matching term.hut.

The coupling runs one way only: **the PolyForm app may depend on the permissive
crates; nothing permissive may depend on anything PolyForm.** That is already
the layering the architecture wants, so it costs nothing — but it does mean
`xd-core` can never grow an app-shaped dependency, and CI should assert it.

Set up in this phase, not later: per-crate `LICENSE-MIT` + `LICENSE-APACHE`,
`license = "MIT OR Apache-2.0"` in both crate manifests, `license = "PolyForm-Noncommercial-1.0.0"`
in `src-tauri/Cargo.toml`, and a root `LICENSE` explaining the split. Publishing
`xd-core` to crates.io early — even at 0.0.1 — is worth it to claim the name and
to prove the crate really is standalone.

---

## Phase 1 — The format, losslessly

`xd-core::scene`. The single most important decision in the crate:

```rust
pub struct Element {
    pub id: String,
    pub kind: ElementKind,
    pub x: f64, pub y: f64,
    pub width: f64, pub height: f64,
    pub angle: f64,
    pub seed: i32,
    pub version: u32,
    pub version_nonce: i32,
    pub updated: i64,
    // ... the fields we actually manipulate
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,   // <-- everything else, untouched
}
```

Excalidraw's schema drifts release to release. Anything we don't model must
survive a round trip **byte-identical**, or we silently destroy other people's
files. `rest` is not a convenience; it's the compatibility contract.

Three fields that look like bookkeeping and are not:

- **`seed`** — Rough.js is deterministic in it. Preserve it on every edit or the
  hand-drawn strokes re-scramble on save and the diagram visibly "twitches"
  after every keystroke. New elements get a fresh random seed; nothing else ever
  writes one.
- **`version` / `versionNonce`** — bump per element per mutation. Excalidraw's
  own reconciliation depends on it; getting it right now is what makes
  collaboration possible later instead of a rewrite.
- **`updated`** — epoch millis, same rule.

**Acceptance:** a corpus of real `.excalidraw` files (pull from excalidraw.com,
the libraries repo, and the fixtures already in
`term.hut/ui/test/excalidrawScene.test.js`) round-trips stably through
parse → serialize. Property test: arbitrary scene → serialize → parse → equal.

---

## Phase 2 — Geometry

Bounds with rotation, hit-testing (point-in-shape, stroke proximity, text
boxes), resize/rotate/move transforms about an anchor, z-order, marquee
intersection.

Port the rules **already encoded** in `excalidrawScene.js` — `elementBounds`,
`sceneBounds`, `fitTransform`, `cornerRadius` — rather than inventing them, so
the Rust model and the JS painter can never disagree about where a thing is.
Once ported, the JS functions are deleted and call into WASM; that deletion is
the proof the port is faithful, and the existing bun tests are the safety net
while it happens.

Pure functions, no allocation in hot paths, unit-tested against the JS
originals' outputs.

---

## Phase 3 — Mutation & history

`Doc` owns a `Scene` plus an undo stack. Edits are commands, not field pokes:
`Insert`, `Delete`, `Patch { id, fields }`, `Reorder`, `Group`, `Bind`. Each
applies the Phase 1 version bookkeeping automatically — no caller can forget.

Coalescing matters for feel: one drag is one undo entry, not four hundred.
Commands carry a coalesce key and a time window.

**Acceptance:** fuzz. Random valid command sequences, then undo everything —
the scene must equal the original, including `rest`.

---

## Phase 4 — The WASM boundary

The one place this design can fail on performance. The rule: **never serialize
the whole scene per frame.**

The `Doc` lives in WASM linear memory. JS holds no model. Per pointer event:

```js
const change = doc.pointerMove(x, y, mods);
// change: { revision, dirty: Uint32Array, bbox: Float64Array, cursor: number }
```

JS repaints only `dirty` indices, fetching each element's paint data through an
accessor memoized on `(index, version)` — so an unchanged element never crosses
the boundary twice. Hover/cursor feedback is an integer, not a string.

If profiling later demands it, the escape hatch is a flat typed-array scene
buffer JS reads directly out of `memory.buffer` with zero copies. Design for it;
don't build it yet.

`xdWasm.js` is the *only* module that imports wasm-bindgen output — everything
else sees a plain JS object. That keeps the boundary swappable and keeps
`excalidrawEdit.js` unit-testable against a fake.

Build: `wasm-pack build --target web` (plain ES module, no bundler — matches
term.hut exactly), vendored to `ui/vendor/xd-wasm/`. Size budget **≤ 586 KB**
(the bpmn-js precedent), via `opt-level = "z"`, `lto = true`,
`panic = "abort"`, `codegen-units = 1`, and `wasm-opt -Oz`. Track the number in
CI and fail the build when it regresses.

---

## Phase 5 — The portable view

`renderExcalidraw(host, text, { onSave, onActions }) -> dispose`. Written to
term.hut's contract on day one, before term.hut ever sees it.

- **Autosave** on an 800 ms idle debounce, mirroring `bpmnView.js` — same
  number, so the two feel like one app.
- **`worthSaving`** before every write, mirroring `bpmnDoc.js`. A failed
  serialize must never overwrite a real drawing. This is the highest-stakes
  rule in the whole plan: the failure mode is *destroying the user's work.*
- **Header actions**, not a toolbar: contribute `{ id, icon, title, run }`
  descriptors through `onActions` — Fit, zoom readout, Save. `viewActions.js`
  diffs on `id`, so republishing every frame for the zoom % is free and is
  already what the read-only canvas does.
- **Painting**: start from `excalidrawView.js`'s `drawElement`, add selection
  handles, marquee, snap guides, and the in-progress element.
- **Theme**: read the same CSS custom properties term.hut's views do, and it
  themes for free on arrival.

### The two guards that replace "remember not to"

Because the port is deliberately last (see Phase 8), nothing will *organically*
prove the view is still host-independent for months. Two cheap CI jobs do it
instead, and both land in this phase, before there is anything to catch:

1. **Import allowlist.** Walk the import graph from `excalidrawEdit.js`. It may
   reach only: `excalidrawTools.js`, `excalidrawView.js`, `excalidrawScene.js`,
   `xdWasm.js`, `dom.js`, `viewActions.js`, `colorpicker.js`, and `vendor/*`.
   Any edge into `standalone/`, any `invoke`, any `window.__TAURI__` fails the
   build. Roughly thirty lines of Bun script; it is the whole reason Phase 8 can
   be a copy.

2. **Contract smoke test.** A `bun:test` that mounts the view exactly the way
   `preview.js` will — a detached host element, a stub `onSave`, a stub
   `onActions` — drives a few pointer events, calls `dispose`, and asserts every
   listener and observer is gone. term.hut's preview hosts learned that hazard
   the hard way (`excalidrawView.js` says so in its header); inherit the lesson
   rather than the bug.

Together they mean the port is *continuously* verified without term.hut being
in the loop, which is what makes shipping a product first and porting last a
safe ordering rather than a gamble.

---

## Phase 6 — Interactions (the long pole)

Milestone by milestone, each shippable:

1. **Select & move** — click, marquee, multi-select, drag, delete, duplicate,
   z-order, copy/paste.
2. **Shapes** — rectangle, diamond, ellipse, line; stroke/background/fill
   style/roughness via the existing `colorpicker.js`.
3. **Resize & rotate** — eight handles, aspect lock, rotation handle,
   multi-element bounding box.
4. **Freedraw** — perfect-freehand, pressure where the device reports it.
5. **Text** — a positioned `<textarea>` overlay, which is what Excalidraw itself
   does. Do not write a text engine. Then contained text in shapes
   (`containerId`), which is where the font-metric work actually is.
6. **Arrows & binding** — `startBinding`/`endBinding`/`boundElements`, elbow
   routing, midpoint handles. **Its own milestone on purpose**: it is the
   highest-value interop feature, the one most likely to be got subtly wrong,
   and the one that makes agent-authored diagrams actually editable.
7. **Snapping** — alignment guides, equal-spacing, angle snap.
8. **Images** — paste and drop into the `files` map.

Gate every milestone on a round-trip check: edit in excalidraw-rs, open in
excalidraw.com, and back. Divergence found late is divergence found expensively.

---

## Phase 7 — The standalone product

The app ships in its own right, so it gets the surface a real editor needs.
Everything here lives in `standalone/` or `src-tauri/` and **none of it ports** —
that separation is what keeps Phase 8 small.

**Product surface**
- Windows, tabs, and multiple open documents; window geometry via
  `tauri-plugin-window-state` (already in term.hut's dep set).
- Recents, and preferences that persist — theme, default stroke/background,
  grid and snap defaults, autosave interval.
- Unsaved-change handling on close, and crash recovery from an autosave
  sidecar. A drawing app that loses work has no second chance at trust.
- File associations: Tauri's `bundle.fileAssociations` for `.excalidraw`, plus
  the macOS UTI declaration and a document icon, so double-click opens the app.

**Export — build it in the portable unit, wire it up here.**
PNG via `canvas.toBlob`, SVG via Rough.js's SVG mode (the painter already has
the geometry; it just draws to a different surface). The *capability* belongs in
`excalidrawEdit.js` and is offered through `onActions`, so term.hut inherits
export for free at the port. Only the save-file-dialog half lives in
`standalone/`. Resist the shortcut of implementing export in `standalone/` — it
is the most likely single thing to end up on the wrong side of the line.

**Release engineering** — mirror term.hut rather than inventing:
`scripts/release.sh` + `scripts/publish-release.sh`, `tauri-plugin-updater`
against a minisign-signed `latest.json`, signed dmg with notarisation, and the
`.github/workflows/` nightly + release pair. term.hut's `flatpak/` and
`docker/` directories are there as precedent if Linux matters.

This phase is the largest single block of work in the plan and none of it makes
the editor better. Worth doing deliberately, and worth doing *after* Phase 6 —
polish on an editor that cannot yet draw an arrow is polish spent twice.

---

## Phase 8 — The port into term.hut

Deliberately last: term.hut's `.excalidraw` view flips from read-only to fully
editable in one move, with no half-editable intermediate state for you to
explain to yourself six weeks later.

If Phase 5's two guards have been green all along, this is a copy and a ~15-line
diff. If they were ever switched off, this is where that bill arrives.

**Copy in:**
- `ui/vendor/xd-wasm/` (the wasm-pack output)
- `ui/src/excalidrawEdit.js`, `excalidrawTools.js`, `xdWasm.js`
- the extensions to `excalidrawView.js` / `excalidrawScene.js`
- the tests, which already use `bun:test`

**`ui/src/preview.js`** — the `canvas` branch becomes the `bpmn` branch. Same
shape, same lazy import, same reason:

```js
} else if (tab.view === "canvas") {
  body.classList.add("preview-fill");
  const mount = div("xd-host");
  body.appendChild(mount);
  let live = null, gone = false;
  import("./excalidrawEdit.js")
    .then(({ renderExcalidraw }) => {
      if (gone) return;
      live = renderExcalidraw(mount, payload.text ?? "", { onSave: hooks.save, onActions });
    })
    .catch((e) => {
      if (!gone) mount.appendChild(div("preview-note", `The canvas editor failed to load: ${e}`));
    });
  disposeView = () => { gone = true; live?.(); live = null; };
}
```

**`ui/src/editor.js`** — two spots, both currently naming bpmn as the sole
editable view:

- `~line 1071` — `hooks.save` is handed out on `tab.view === "bpmn"`; make it
  `["bpmn", "canvas"].includes(tab.view)`.
- `~line 1080` — the status line says `read-only` for everything but bpmn; add
  canvas. The comment above it ("The BPMN editor writes back; every other view
  is read-only") becomes false and must be rewritten, not left to rot.

**`ui/src/preview.js` header comment** — the four-view list describes `canvas`
as a read-only viewer. So does the whole module docstring ("Read-only viewers
for the files CodeMirror can't hold"). Both are now wrong.

**`ui/src/excalidrawView.js` header** — delete the "Read-only by design"
paragraph. That is the deliverable.

**`README.md`** — the editor/viewer story changes.

Keep unchanged: `TYPES.excalidraw` still maps to `canvas`; `TEXT_BACKED` and
`TEXT_VIEWS` already include it, so the source toggle keeps working for free.

**Stays behind:** everything from Phase 7 — windows, tabs, recents,
preferences, file associations, the updater, the release pipeline. term.hut
already has all of those for itself, and a view that tried to bring its own
would be the bug. Export is the one Phase 7 feature that *does* arrive, because
it was built in the portable unit on purpose.

**Also verify at the port:** the `hut web` browser build. It serves
`application/wasm` already, but it's a second transport with a second
`hooks.save` path — exercise it before calling the port done.

---

## Risks

- **Arrow binding fidelity** is the likeliest source of "it looks wrong in
  excalidraw.com." Round-trip test it from milestone 6.1, not at the end.
- **WASM size** creeping past the 586 KB precedent. CI gate it from Phase 4.
- **Boundary chattiness.** If pointer-move latency shows up, the typed-array
  escape hatch in Phase 4 is the answer — but measure before building it.
- **Schema drift.** The `rest` passthrough covers unknown fields, but a field
  that changes *meaning* won't be caught by round-trip tests. Re-pull the corpus
  periodically.
- **Two painters, one truth.** Between Phase 2 and its deletions, the same
  geometry exists in Rust and JS. Keep that window short.
- **Leakage into the portable unit** — the defining risk of this shape. A
  shipped product built first, ported last, spends months with every incentive
  to let app concerns settle into `excalidrawEdit.js`. Phase 5's import
  allowlist is the mitigation, and it only works if it is never switched off to
  unblock something. If it ever fails and the fix is "widen the allowlist,"
  that is the moment to stop and look at what is actually being asked for.
- **Export ending up on the wrong side of the line** — the concrete instance of
  the above, and the likeliest one. Build it in the view, not in `standalone/`.
- **Late-port surprises.** The two guards cover the view's independence, not
  term.hut's environment. The `hut web` browser build in particular is a second
  transport that nothing tests until Phase 8. Cheap insurance: open a scratch
  `.excalidraw` in a dev build of term.hut once per phase from 6 onward, even
  without wiring the port — ten minutes, and it turns a class of Phase 8
  surprise into a Phase 6 note.

## Decisions

Settled:

1. **License** — `xd-core`/`xd-wasm` MIT OR Apache-2.0; app and `ui/`
   PolyForm-Noncommercial-1.0.0. Dependencies flow one way only (Phase 0).
2. **Rendering** — JS painter keeps the brush; Rust owns the model. The Phase 4
   boundary stays the only place that would change.
3. **The standalone app is a shipped product**, with its own release
   engineering (Phase 7).
4. **The port lands after the full Phase 6** — one move from read-only to fully
   editable, guarded continuously by Phase 5's CI checks rather than by an
   early integration.

Still open, and answerable later:

5. **Linux.** term.hut ships deb + flatpak; whether the standalone editor does
   too is a Phase 7 question, not one that changes any earlier phase.
6. **Collaboration.** The Phase 1 `version`/`versionNonce` bookkeeping keeps the
   door open deliberately. Nothing else in this plan assumes it, and it should
   stay that way until there is a reason.
