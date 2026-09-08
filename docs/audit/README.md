# Editor gap audit vs. React Excalidraw

Five parallel audits of the current editor against `excalidraw/excalidraw@master`.
Every claim in the detailed reports is cited to `file:line`; the rendering and
text findings were verified empirically against the vendored WASM core rather
than reasoned about.

| Report | Domain |
| --- | --- |
| [audit-text.md](audit-text.md) | text tool, editing committed text, container-bound labels |
| [audit-bindings.md](audit-bindings.md) | arrows, lines, points, arrowheads, bindings |
| [audit-styles.md](audit-styles.md) | properties panel, colours, fills, rendering fidelity |
| [audit-selection.md](audit-selection.md) | selection, groups, transforms, z-order, undo, navigation |
| [audit-tools.md](audit-tools.md) | tool inventory, element types, images, file I/O, export |

---

## The three reported bugs

Two of the three were misdiagnosed, and knowing that changes what to fix.

### "I can't anchor an arrow to objects"

**Binding works.** It is implemented, exported, wired, and verified — 7/7 Rust
binding tests and 51/51 JS tests pass against the *vendored* `.wasm`, including
"an arrow dropped on a shape binds itself" and "an arrow drawn between two
shapes binds to both and follows them". Moving a bound shape re-routes the
arrow.

What is missing is the **gesture**. Binding fires only inside `endDraft`
(`crates/xd-wasm/src/lib.rs:453-458`), so it is a one-shot at draw time:

- Selection handles are bounding-box-only (`crates/xd-core/src/geometry.rs:588-631`),
  so an arrow **endpoint cannot be grabbed**. The motion people actually reach
  for — select an existing arrow, drag its tip onto a shape — does not exist.
- `rebindEnd` has **zero call sites** in `ui/src/`, so a binding once made is
  permanent; `ops.rs:245` re-aims the arrow back.
- The bind highlight only appears once you are already mid-drag
  (`ui/src/excalidrawEdit.js:770-772`), never on hover.

### "Sloppiness goes from smooth to bold to unconnected"

Three stacked defects, all real, all measured. Nothing conflates roughness with
`strokeWidth`.

1. **"Unconnected"** — `drawRectangle` omits `{continuousPath: true}` on the
   rounded-path branch (`ui/src/excalidrawView.js:315`) where Excalidraw passes
   `true` (`shape.ts:786-795`). At Cartoonist `preserveVertices` goes false and
   rounded rectangles — this repo's *default* shape — open **4.7–6.1px gaps at
   all 8 joints**. Excalidraw measures 0.00px at every joint, every seed.
   `drawLinear` has the same flag inverted the other way (`:341` passes `true`;
   Excalidraw passes `false` at `shape.ts:875`).
2. **"Bold"** — Excalidraw re-rolls `seed: randomInteger()` on every sloppiness
   change (`actionProperties.tsx:711`). This repo cannot, because
   `Command::Patch` filters `seed` (`crates/xd-core/src/doc.rs:216-221`), so the
   same random draws are merely scaled by roughness. Measured ink band on one
   identical sketch: **2.00 → 3.08 → 4.14px**. It reads as weight, not as a
   different hand.
3. **Small shapes fall apart** — Excalidraw's `adjustRoughness` size damping
   (`shape.ts:171-191`) is absent entirely, so small shapes get 2–3× the
   roughness they should.

Also missing: `curveFitting: 1` for ellipses, and `lineJoin`/`lineCap = "round"`.

The `continuousPath` fix is **provably a no-op at roughness 0 and 1**, so no
existing file changes except at Cartoonist. Note `ui/test/excalidrawScene.test.js:158-165`
currently pins the buggy behaviour and must change with it.

### "I can't click an object and start writing, or edit a committed textbox"

**Double-click to edit committed text works** — verified: double-clicking a
committed `text` element opens a `<textarea>` containing its text
(`ui/src/excalidrawEdit.js:858-871`). What you hit is one of three real bugs
that look identical from the outside:

- Double-clicking a **filled** shape does nothing at all — `:864` only opens the
  overlay when the hit element is `type === "text"`, and `:870` only creates text
  when the hit *misses*. On a filled rectangle both branches fall through: no
  overlay, no label, no feedback.
- Double-clicking inside an **unfilled** shape silently creates a *free-floating*
  text element, because transparent shapes are stroke-only for hit-testing
  (`crates/xd-core/src/geometry.rs:395`) so the click "misses".
- Clicking existing text **with the text tool active** creates a second
  overlapping element — `pointerIntent` returns `text` before any hit test
  (`:704-708`).
- At zoom < ~0.65, double-clicking small text fires a resize first and rescales
  `fontSize`.

**Container-bound labels are entirely absent**, and this is confirmed. Nothing
in the repo ever sets `containerId` or appends to a container's `boundElements`.
`container_id` exists at `crates/xd-core/src/scene.rs:367` and is initialised to
`None` at `doc.rs:1167` — that is all. The blocker is **structural**: no WASM
export can express it (`Command::Bind` is arrow-endpoint-shaped) and
`ui/src/xdWasm.js:108-170` is an explicit whitelist. Labels are
parse-and-preserve-only today.

---

## The shape of the whole gap

**The Rust model is consistently ahead of the UI.** The genuinely hard parts are
done and well tested — proptested geometry, fuzzed undo, correct fractional
indexing, byte-faithful round-trip. Most of what is missing is UI wiring, not
model work. Three recurring patterns:

1. **Write-only model fields.** `groupIds` is written by ⌘G and read by nothing.
   `frame_id` is written `None` and read nowhere. `container_id` is never
   written. `lastCommittedPoint` is always `None`.
2. **Renderable but not creatable.** `frame`, `image` and `embeddable` all paint
   and round-trip correctly, but nothing can make one.
3. **Built and never called.** `handlePoints`, `drawSnapGuides`, the `contain`
   marquee, and `drawHandles({only})` are all finished, tested dead code.

**No file-level data loss.** Load→save preserves the top-level `files` map
(image bytes, `dataURL`, `crop`, `scale`), *every* `appState` key including
unknown nested ones, unknown element fields, unknown binding sub-keys, and
element types this build cannot draw. Both `files` and `appState` are held as raw
`serde_json::Map` precisely so nothing decides anything about them
(`scene.rs:424-429, 444-447`). Saving an unedited file is a byte-for-byte no-op.
The suspected image data-loss bug **does not exist**.

---

## Tier 1 — correctness bugs that produce wrong files

These matter most because interop *is* this project's thesis: a file that looks
fine here misbehaves on excalidraw.com.

| # | Bug | Evidence |
| --- | --- | --- |
| 1 | **Groups are write-only.** `groupIds` has no reader, so clicking a member selects one element, there is no group bbox, and duplicate/paste clone the group id so copies join the *original's* group. | `crates/xd-core/src/doc.rs:757,774` are the only references |
| 2 | **Lines silently gain bindings.** `is_linear()` is `Line \| Arrow`, and `endDraft` binds on that predicate, so plain lines get `startBinding`/`endBinding` that Excalidraw will not honour. | `scene.rs:179-181` + `lib.rs:453` |
| 3 | **Rotating a multi-selection spins away.** `ops::rotate` treats the absolute pointer bearing as a delta. Reachable because the rotate handle is drawn on multi-selections where Excalidraw hides it. `ops.rs` is the only xd-core module with no test file. | `crates/xd-core/src/ops.rs:146-157` |
| 4 | **Four dangling-reference bugs around labels.** Deleting a container orphans its label with a `containerId` naming a ghost; duplicate keeps the original's `containerId`; the clipboard ships `containerId`; moving/resizing a container leaves the label behind. | `doc.rs:1041-1080`, `ops.rs:182`, `excalidrawDoc.js:215` |
| 5 | **Paste/duplicate carry `groupIds`, `containerId`, `frameId`** from the source. Excalidraw regenerates all three. | `excalidrawDoc.js:215`, `ops.rs:170-187` |
| 6 | **Locked elements from other people's files are freely editable.** ~3-line filter fix. | see audit-selection §3.7 |
| 7 | **Deleted elements are still painted.** Correctly excluded from hit-testing, but not from the paint loop. | `excalidrawEdit.js:276` → `excalidrawView.js:277` |
| 8 | **Copying an image drops its bytes.** `clipboardText` hard-codes `files: {}`, so cross-document paste yields a permanent grey placeholder. Blocked on #9. | `excalidrawDoc.js:232` |
| 9 | **Nothing can ever add to the `files` map** — `XdDoc::files` is a getter with no counterpart and no `Command` reaches `Scene::files`. Hard blocker behind image insert, paste and drop. | `crates/xd-wasm/src/lib.rs:196-198`, `command.rs:65-165` |

## Tier 2 — rendering fidelity

Beyond the sloppiness stack above:

- Rounded diamonds never round.
- Roundness type is wrong for diamonds (`{type:3}` written where Excalidraw
  writes `{type:2}`), and absent for lines — so **curved lines never render**.
- Freedraw strokes are **2× too thick** — the width buttons skip
  `getStrokeWidthByKey`.
- Arrowheads are the wrong shape, size and direction; `diamond` falls through to
  a plain open V (`excalidrawView.js:361-393`).
- No dark-mode colour handling (`applyDarkModeFilter` absent).
- Arrows are hard-coded to exactly two points (`crates/xd-wasm/src/lib.rs:373`),
  which kills multi-point lines, point-edit mode and curved lines at once.

Exact matches, confirmed against upstream: palettes, dash arrays, `fillWeight`,
`hachureGap`, stroke widths, font sizes, `getCornerRadius`, and the vendored
Rough.js version itself (4.6.6, same major as Excalidraw).

## Tier 3 — missing features

**Tools (6 absent entirely):** image (`9`), eraser (`E`/`0`), frame (`F`), laser
(`K`), embed, bucket fill, plus lasso select, autoshape, and `Tab`
shape-switching. Freedraw is missing its `X` alias.

**Text:** no line wrapping anywhere; `verticalAlign` parsed and never honoured;
no text-align controls (and `stylePatch` would filter them out); changing font
size leaves `width`/`height` stale; fonts not bundled so measurements diverge
from Excalidraw; `dispose()` mid-edit silently discards typed text.

**Arrows/lines:** multi-point drawing, point-edit mode (Enter), midpoint
drag/delete, double-click to finish, arrowhead pickers, elbow arrows, arrow
labels.

**Selection/manipulation:** flip H/V, align, distribute, element lock, object
snapping and grid (its guide painter is *finished and tested* but has no
producer), frame membership, undo does not restore selection.

**Panel/UI:** no layers UI, no align/distribute, no canvas-background control;
mixed multi-selection shows element[0]'s values as pressed; all 9 panel groups
shown for every element type regardless of relevance.

**App surface:** **no context menu anywhere** — combined with no panel button for
any manipulation verb, every one of group/ungroup/z-order is keyboard-only, so a
mouse-only user cannot reach them at all. Also absent: PNG and SVG export (both
non-functional stubs), grid, help dialog, stats, zen/view mode, library.
`⌘0` fits instead of resetting to 100%; `⇧1`/`⇧2` unbound.

---

## Cheap wins, highest value first

The single most useful fact in the audit: **`Command::Patch` is a fully general
escape hatch and is already exposed.** Because it applies camelCase keys to the
element's JSON form (`command.rs:83-98`), `locked`, `link`, `groupIds`,
`frameId` and flipped geometry can **all** be written from JS today with zero
Rust changes.

1. **Pass `only` to `drawHandles` for multi-selections** — one line, and it is
   the mitigation for the multi-rotate bug (#3).
2. **The sloppiness diff** — two flag corrections plus `adjustedRoughness`; see
   audit-styles §1g for the ready-to-apply diff.
3. **`marquee(contain = true)`** — plumbed end to end, one boolean at
   `excalidrawEdit.js:762`.
4. **Switch `drawHandles` to `doc.handlePoints()`** — removes a second source of
   truth that agrees only because both sides hard-code 20px.
5. **Eraser** — cheapest large win; tombstones already exist so undo is free.
6. **SVG export** — Rough.js can emit SVG from the same generator the canvas
   path already uses, so the option mapping is reusable unchanged.
7. **Help dialog** — the shortcut table is already data.
8. **`⌘0` semantics and `⇧1`/`⇧2`** — two-line fixes with real muscle-memory payoff.

The structurally expensive items, for planning: **frame** (needs `frameId`
membership, clipping, move-children-with-frame — none of which exists),
**container-bound labels** (needs a new Rust command *and* a new WASM export
*and* line wrapping), and **image insertion** (needs `Command::PutFile` before
anything else can work).
