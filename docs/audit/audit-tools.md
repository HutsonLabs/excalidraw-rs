# TOOLS, CANVAS & APP-SURFACE audit — `excalidraw-rs` vs. Excalidraw

**Scope:** tool inventory, element-type support in the Rust model, images, eraser, freedraw,
canvas/app chrome, file format & I/O, export, library, collaboration/links/embeds, accessibility.

**Reference for Excalidraw's own bindings** is its source, not memory: `packages/excalidraw/components/Tools.tsx`
(the `TOOLS` table — "the single source of truth for tool buttons, keyboard shortcuts (`findShapeByKey`),
and the command palette") and `packages/excalidraw/components/HelpDialog.tsx`. Both fetched live from
`excalidraw/excalidraw@master`.

**Every claim about this repo is cited `file:line`. No files were modified.**

---

## 0. Headline

- The nine tools that exist are faithful and well-built. **Six Excalidraw tools do not exist at all**
  (image, eraser, frame, laser, embed, plus the newer bucket-fill / autoshape / lasso).
- **The document-level `.excalidraw` round trip is lossless, including the top-level `files` map and
  every `appState` key.** I went looking for the suspected image data-loss bug and it is not there.
  See §1 for the verdict and the proof.
- The real data losses are narrower and live on the **clipboard and paste** paths, not the file path.
- **Export (PNG/SVG) does not work at all.** Menu entries exist and honestly report "isn't built yet";
  the capability half was never written, and PNG is additionally blocked by a missing Rust command.
- No grid, no snapping, no help dialog, no context menu, no stats, no zen/view mode, no library.

---

## 1. DATA LOSS — the verdict (highest severity, read first)

### 1.1 DOCUMENT level: **NO LOSS.** Confirmed, not refuted.

The team lead asked me to confirm or refute at the document level — the top-level `files` map and
`appState` — rather than re-derive the element-level result. Verdict: **both are fully preserved.**

**`appState` — every key survives, including keys xd-core has never heard of.**

`Scene::app_state` is `Map<String, Value>`, i.e. raw JSON, and the struct doc says why in as many
words: `app_state` and `files` "are held as raw JSON because nothing in this crate decides anything
about them — they exist to be handed back on save exactly as they arrived. Both are written
unconditionally, `{}` and all, because Excalidraw writes both on every export."

- `crates/xd-core/src/scene.rs:424-429` — the doc comment above.
- `crates/xd-core/src/scene.rs:444-445` — `#[serde(default, rename = "appState")] pub app_state: Map<String, Value>`.
- Nothing reads or normalises an `appState` key on the parse path. `gridSize` and `viewBackgroundColor`
  are special-cased in exactly one place — `format::blank_scene`, which *constructs* a new empty
  scene (`crates/xd-core/src/format.rs:75-92`) — and never on the read/write path of an existing file.
- **Proof from the test suite:** `crates/xd-core/tests/roundtrip.rs:293-296` asserts that an
  `appState` key invented purely for the fixture survives the write with its nested value intact:
  `out["appState"]["someFutureAppStateKey"] == { "enabled": true, "list": [1,2,3] }`.
  That is a nested object under an unknown key — the hardest case.
- `appState` appears in `ADDABLE_DEFAULTS` (`roundtrip.rs:184`) only for the *addition* direction
  (a file that omitted it gains `{}`, matching Excalidraw's own export), and even then only when the
  added value is empty — gated by `is_empty` at `roundtrip.rs:204-207, 226-235`. It is **not** in
  `DROPPABLE_NULLS` (`roundtrip.rs:128-154`), so it can never be dropped.
- `roundtrip.rs:412` pins the addition direction explicitly: a minimal file gains `"appState": {}`.

**`files` (the image map) — fully preserved, bytes and all.**

- `crates/xd-core/src/scene.rs:447` — `#[serde(default)] pub files: Map<String, Value>`, same raw-JSON
  treatment, same reasoning at `scene.rs:424-429`.
- The corpus contains a genuine image scene: `crates/xd-core/tests/fixtures/image-with-files.excalidraw`
  has two `image` elements and a real `files` entry carrying `mimeType`, `id`, a base64 PNG `dataURL`,
  `created` and `lastRetrieved`, plus per-element `status: "saved"`, `scale: [1,1]` and a full `crop`
  object (`{x, y, width, height, naturalWidth, naturalHeight}`). I read the fixture directly to confirm
  this rather than trusting the header comment.
- Every fixture in that directory is run through all three round-trip properties:
  - `nothing_the_file_said_is_lost` — `roundtrip.rs:111-118`, which walks the *JSON* before and after
    and asserts nothing was dropped or changed except the two narrow allowances above.
  - `parse_serialize_parse_is_identity` — `roundtrip.rs:89-96`.
  - `serializing_is_a_fixed_point` — `roundtrip.rs:98-109`, so autosave cannot churn the file.
- `files` is in `ADDABLE_DEFAULTS` (`roundtrip.rs:185`) and **not** in `DROPPABLE_NULLS`. Same gate:
  addable only when empty. `roundtrip.rs:413` pins that a minimal file gains `"files": {}`.
- The proptest generates arbitrary `files` maps as well as arbitrary elements and `rest` maps, so the
  property is not fixture-bound (`roundtrip.rs:677-685`; `MODELLED` collision guard at `:524-531`).

**And the app really does save the whole `Scene`, not a reconstruction.** This is the step where a
careful format layer usually gets undermined by the UI, so I traced it end to end:

`ui/src/excalidrawEdit.js:436-442` (`serialize()` → `doc.toJson()`)
→ `crates/xd-wasm/src/lib.rs:110-113` (`to_json` → `self.doc.to_json()`)
→ `crates/xd-core/src/doc.rs:316-318` (`format::serialize(&self.scene)`)
→ `crates/xd-core/src/format.rs:61-68` (`serde_json::to_string_pretty` over the whole `Scene`).

Nothing on the JS side ever rebuilds a scene from elements. `ui/src/excalidrawScene.js:99-123`
(`parseScene`) *does* return a lossy `{elements, appState, files}` view, but it is only used by the
read-only painter path (`renderExcalidrawCanvas`) and is never on a save path — `shell.js:39-41`
records that the read-only adapter was deleted rather than kept.

**Conclusion: opening and saving a file with images does NOT destroy the images. The suspected
data-loss bug does not exist.** Nor does one for `appState`.

### 1.2 ELEMENT level: no loss (cross-check with the bindings auditor — confirmed)

Not re-derived, per instruction. Confirming the bindings auditor's finding and adding the two
citations that make it airtight rather than merely plausible:

- `Element::rest` is the flattened catch-all, documented as "the compatibility contract"
  (`crates/xd-core/src/scene.rs:403-413`), with the whole module header explaining why
  (`scene.rs:1-53`).
- The strongest test does **not** compare models — it reaches into the written bytes, because
  "Scene equality would pass even if `rest` round-tripped through some lossy normalisation of its
  own, because both sides would be equally wrong" (`roundtrip.rs:239-247`). It then checks
  `customData`, `elbowed`, `crop`, a big integer, an empty array, an empty object, unicode, `false`,
  and a four-deep nested subtree (`roundtrip.rs:258-278`).
- Unknown keys inside a `Binding` are covered too — `Binding::rest` (`scene.rs:225-235`), asserted
  for `fixedPoint`, `someFutureBindingKey`, `startArrowhead`, `fixedSegments`
  (`roundtrip.rs:280-289`).
- Element *types* xd-core cannot draw keep their names rather than degrading to rectangles or
  vanishing: `ElementKind::Other(String)` under `#[serde(untagged)]` (`scene.rs:169-173`), pinned for
  `embeddable` and `iframe` at `roundtrip.rs:301-343`.

### 1.3 The real losses, ranked

**D1 — Copying an image drops its bytes (real loss, cross-document).**
`clipboardText` hard-codes `files: {}` (`ui/src/excalidrawDoc.js:232`). The copied element keeps its
`fileId`, so pasting *within* the same document works (the file map is already in the doc). Pasting
into **another** document — or into excalidraw.com, which is the stated point of using Excalidraw's
own `excalidraw/clipboard` marker (`excalidrawDoc.js:206-208`) — yields an element pointing at a
`fileId` that resolves to nothing: a permanent grey placeholder (`excalidrawView.js:434-437`).
Symmetrically, `onPaste` never reads a `files` map out of an incoming payload
(`ui/src/excalidrawEdit.js:1006-1019`), so an image copied *from* Excalidraw arrives as a placeholder.
Fixing this requires D2 first.

**D2 — Nothing can ever add to the `files` map.**
Not a loss of existing data, but the hard blocker behind D1, image paste, image drop and the image
tool. `XdDoc::files` is a getter with no counterpart (`crates/xd-wasm/src/lib.rs:196-198`), and no
`Command` variant reaches `Scene::files` — the enum is `Insert`, `Delete`, `Patch`, `Reorder`,
`Group`, `Ungroup`, `Bind`, `Batch` (`crates/xd-core/src/command.rs:65-165`), and grepping `files`
across `command.rs` and `ops.rs` returns nothing. Consequence worth noting: a file-map entry cannot be
undone into existence either — `history()` calls `syncFiles()` in anticipation of exactly that
(`excalidrawEdit.js:531-533`), which is currently unreachable code.

**D3 — Paste and duplicate keep `groupIds`, `containerId` and `frameId` from the source.**
`DROPPED` is `["id","seed","version","versionNonce","updated","boundElements","startBinding","endBinding"]`
(`ui/src/excalidrawDoc.js:215`). So:
- pasting a grouped shape lands the copy **inside the original's group**;
- pasting a container's label text lands a second text claiming the same `containerId`;
- pasting a framed element claims membership of a frame that may not exist in the target document.

Excalidraw regenerates all three on paste. `ops::duplicate` has the same issue for `groupIds` — it
clears `bound_elements` / `start_binding` / `end_binding` but copies `group_ids` straight through
(`crates/xd-core/src/ops.rs:170-187`). Not file corruption, but it produces documents whose group and
container structure is wrong, and `Cmd+D` on a group is a common gesture.
`index` is **not** affected: `Command::Insert` overwrites the arriving fractional key unconditionally,
with a comment naming this exact hazard (`crates/xd-core/src/doc.rs:706-715`).

**D4 — A cropped image renders un-cropped (display-only).**
`crop` survives the round trip (`roundtrip.rs:263`) but `drawImage` ignores it and draws the whole
bitmap into the element box (`ui/src/excalidrawView.js:433-440`). The data is intact. Listed here
because a user seeing the full bitmap may "fix" it by resizing, which *would* write a wrong
`width`/`height` over correct data.

### 1.4 Explicitly NOT data loss (checked and cleared)

- Images, `files`, `dataURL`, `status`, `scale` through load→save — §1.1.
- All `appState` keys, including unknown nested ones — §1.1.
- Unknown element fields, nested unknown subtrees, unknown binding fields, unknown top-level keys — §1.2.
- Element types this build cannot draw (`embeddable`, `iframe`, `magicframe`) — `roundtrip.rs:301-343`.
- Deleted elements: kept in the file, not drawn — `format.rs:99-107`, `roundtrip.rs:385-397`.
- `seed` (rewriting it would visibly re-scramble every hand-drawn stroke) — refused by
  `Command::Patch` (`command.rs:91-98`), pinned by `ui/test/contract.test.js:845`.
- Number spelling and key order, so saving an unedited file is a byte-for-byte no-op —
  `mod jsnum` (`scene.rs:58-151`), `roundtrip.rs:98-109, 420-443`, `contract.test.js:835`.
- The `null`-only drops (`containerId`, `startBinding`, `endBinding`, `lastCommittedPoint`) are
  value-preserving by construction and reasoned about at `scene.rs:45-51` and `roundtrip.rs:120-154`.
- A failed serialize can never overwrite a real drawing: `worthSaving` refuses empty, unparseable and
  no-change writes (`ui/src/excalidrawDoc.js:63-74`), and every save path goes through it
  (`excalidrawEdit.js:444-469`).
- A file that will not parse is not replaced by a blank canvas (`excalidrawEdit.js:1387-1396`).

---

## 2. Tool inventory

The tool table is `TOOLS` in `ui/src/excalidrawTools.js:36-46` (9 entries, frozen); the button order is
`ORDER` in `ui/src/excalidrawToolbar.js:36-39`; key dispatch is `toolForKey`
(`excalidrawTools.js:90-95`) reached from `keyIntent` (`excalidrawTools.js:278-279`).

| Tool/Feature | Excalidraw shortcut | Excalidraw | This repo | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Selection | `V` / `1` | yes | yes | **PRESENT** | `excalidrawTools.js:37`; intent `:161-172`; button `excalidrawToolbar.js:37` |
| Hand / pan | `H` (no digit) | yes | yes | **PRESENT** | `excalidrawTools.js:45`; pan intent `:157`; space-drag `excalidrawEdit.js:879-886`; middle-button `excalidrawTools.js:155` |
| Rectangle | `R` / `2` | yes | yes | **PRESENT** | `excalidrawTools.js:38` |
| Diamond | `D` / `3` | yes | yes | **PRESENT** | `excalidrawTools.js:39` |
| Ellipse | `O` / `4` | yes | yes | **PRESENT** | `excalidrawTools.js:40` |
| Arrow | `A` / `5` | yes | yes (auto-binds on drop) | **PRESENT** | `excalidrawTools.js:41`; bind `crates/xd-wasm/src/lib.rs:455-459` |
| Line | `L` / `6` | yes | yes | **PRESENT** | `excalidrawTools.js:42` |
| Freedraw / Draw | `P` **or `X`** / `7` | yes | `P` / `7` only — **`X` missing** | **PARTIAL** | `excalidrawTools.js:43`; Excalidraw: `letterKey: [KEYS.P, KEYS.X]` (`Tools.tsx`) |
| Text | `T` / `8` | yes | yes | **PRESENT** | `excalidrawTools.js:44`; overlay `excalidrawEdit.js:1079-1102` |
| **Image** | `9` | yes | **no tool, no insert path** | **MISSING** | absent from `TOOLS` (`excalidrawTools.js:36-46`); rendering exists (`excalidrawView.js:433-440`) but nothing can create one — §4 |
| **Eraser** | `E` / `0` | yes | no | **MISSING** | absent from `TOOLS`; no erase intent in `pointerIntent` (`excalidrawTools.js:152-178`) |
| **Frame** | `F` | yes | no tool | **MISSING** | `frame` is renderable (`excalidrawView.js:442-453`) and modelled (`scene.rs:168`) but has no tool and **no membership logic** — `frame_id` is written `None` once and read nowhere (`crates/xd-core/src/doc.rs:1148`; that grep returns exactly one hit outside `scene.rs`) |
| **Laser pointer** | `K` | yes | no | **MISSING** | not in `TOOLS`; nothing ephemeral in the paint loop (`excalidrawEdit.js:251-295`) |
| **Embed / web-embed** | (no key) | yes | no | **MISSING** | `embeddable` round-trips as `Other` (`scene.rs:169-173`) and paints as a labelled placeholder (`excalidrawScene.js:51-56`) — correct degradation, not creatable |
| **Bucket fill** | `B` | yes | no | **MISSING** | `Tools.tsx` `bucketfill` |
| **Autoshape** | `Shift+X` | yes | no | **MISSING** | `Tools.tsx` `autoshape` |
| **Lasso select** | (no key) | yes | no | **MISSING** | `Tools.tsx` `lasso`; marquee here is rectangular only (`excalidrawTools.js:171`) |
| **Shape-switching (morph)** | `Tab` / `Shift+Tab` | yes | no | **MISSING** | `keyIntent` never inspects `Tab` (`excalidrawTools.js:241-280`) |
| Lock / keep-selected-tool | `Q` | yes | yes | **PRESENT** | intent `excalidrawTools.js:277`; `afterDraw` `:110-112`; button `excalidrawToolbar.js:182-190` |
| **More-tools dropdown** | — | yes | no | **MISSING** | flat `ORDER`, no overflow (`excalidrawToolbar.js:160-178`) |
| **Library panel** | — | yes | no | **MISSING** | §10 |
| Eyedropper | `I` / `Shift+S` / `Shift+G` | yes | no | **MISSING** | not in `keyIntent` |
| Toggle element lock | `Cmd+Shift+L` | yes | no | **MISSING** | `locked` is modelled (`scene.rs:347`) but no command sets it |
| Element link | `Cmd+K` | yes | no | **MISSING** | `link` modelled and explicitly inert (`scene.rs:340-345`) |

**Toolbar order divergence (cosmetic).** This repo puts select before hand and the lock at the far
right; Excalidraw puts the lock first and hand before selection (`Tools.tsx` declaration order;
`HelpDialog.tsx:149-152` lists hand first). `excalidrawToolbar.js:31-35` claims to be "Excalidraw's
own order" — it isn't quite.

### 2.1 Keyboard beyond tools

| Command | Excalidraw | This repo | Status | Evidence |
| --- | --- | --- | --- | --- |
| Undo / redo | `Cmd+Z` / `Cmd+Shift+Z`, `Cmd+Y` | all three | **PRESENT** | `excalidrawTools.js:252-254` |
| Select all / duplicate / delete | `Cmd+A`, `Cmd+D`, `Delete` | same | **PRESENT** | `:250-251, 264` |
| Group / ungroup | `Cmd+G` / `Cmd+Shift+G` | same | **PRESENT** | `:255` |
| Bring forward / send backward | `Cmd+]` / `Cmd+[` | same | **PRESENT** | `:256-257` |
| Bring to front / send to back | **macOS: `Cmd+Alt+]` / `Cmd+Alt+[`** | `Cmd+Shift+]` / `Cmd+Shift+[` | **PARTIAL** | `:256-257` vs `HelpDialog.tsx:414-427` — this repo uses the *non-Mac* binding in a Mac-first app |
| Reset zoom to 100% | `Cmd+0` | `Cmd+0` **fits to view instead** | **BROKEN (divergent)** | `excalidrawTools.js:258` → `{kind:"zoomReset"}` → `fit()` (`excalidrawEdit.js:942-943`). Excalidraw's `Cmd+0` resets zoom; zoom-to-fit is `Shift+1` (`HelpDialog.tsx:274-280`). "Actual size" exists only as the header `1:1` button (`excalidrawEdit.js:401`) |
| Zoom to fit / to selection | `Shift+1` / `Shift+2` | neither | **MISSING** | shift-letters explicitly refused (`excalidrawTools.js:276`) |
| Page up/down scroll | `PgUp`/`PgDn`, `Shift+`same | no | **MISSING** | not in `keyIntent` |
| Nudge / fast nudge | arrows / `Shift`+arrows | same (1 / 10 px) | **PRESENT** | `:267-271` |
| Copy / cut / paste | `Cmd+C/X/V` | via `copy`/`cut`/`paste` events | **PRESENT** | deliberately not in `keyIntent` (`:236-240`); handlers `excalidrawEdit.js:990-1019` |
| Paste as plaintext | `Cmd+Shift+V` | no | **MISSING** | — |
| Copy / paste styles | `Cmd+Alt+C` / `Cmd+Alt+V` | no | **MISSING** | — |
| Deep select / deep box select | `Cmd+click`, `Cmd+drag` | no | **MISSING** | unhandled cmd combos return `null` (`excalidrawTools.js:261`) |
| Flip H / V | `Shift+H` / `Shift+V` | no | **MISSING** | shift-letters refused (`:276`) |
| Align (6 commands) | `Cmd+Shift+`arrows | no | **MISSING** | — |
| Command palette / search | `Cmd+P`, `Cmd+F` | no | **MISSING** | — |
| Prevent binding | hold `Cmd` | no | **MISSING** | `endDraft` binds unconditionally (`crates/xd-wasm/src/lib.rs:455-459`) |
| Line/arrow point editing | `Cmd+Enter` | no | **MISSING** | `Enter` only opens the text overlay (`excalidrawTools.js:265`, `excalidrawEdit.js:948-956`) |
| Save | `Cmd+S` | yes (view + shell, capture-phase) | **PRESENT** | `excalidrawTools.js:254`; `ui/standalone/files.js:129-149` |

---

## 3. Element types the Rust model can represent

`ElementKind` — `crates/xd-core/src/scene.rs:157-174`. The JS→Rust mapping `kind_of`
(`crates/xd-wasm/src/lib.rs:660-673`) mirrors it exactly.

| Type | Modelled variant? | Geometry / hit-test? | Renderable? | Creatable here? | Evidence |
| --- | --- | --- | --- | --- | --- |
| `rectangle` | yes | yes | yes | yes | `scene.rs:160` |
| `diamond` | yes | yes | yes | yes | `scene.rs:161` |
| `ellipse` | yes | yes | yes | yes | `scene.rs:162` |
| `line` | yes (`is_linear`) | yes | yes | yes | `scene.rs:163, 179-181` |
| `arrow` | yes (`is_linear`) | yes | yes | yes | `scene.rs:164` |
| `freedraw` | yes (`has_points`) | yes | yes | yes | `scene.rs:165, 184-186` |
| `text` | yes | yes | yes | yes | `scene.rs:166` |
| `image` | **yes** | yes (opaque box, `geometry.rs:387-390`) | **yes** (`excalidrawView.js:433-440`) | **no** | `scene.rs:167`; `file_id` at `scene.rs:401` |
| `frame` | **yes** | yes | **yes** (box + `name`, `excalidrawView.js:442-453`) | **no**, and `frameId` membership is inert | `scene.rs:168`; `doc.rs:1148` |
| `magicframe` | no → `Other(String)` | opaque box | placeholder | no | `scene.rs:169-173`; `geometry.rs:390` |
| `embeddable` | no → `Other` | opaque box | placeholder | no | round-trip proven: `roundtrip.rs:301-343` |
| `iframe` | no → `Other` | opaque box | placeholder | no | same test |
| `selection` | n/a — Excalidraw never persists it | — | — | — | marquee is view state (`excalidrawEdit.js:203`) |

**Hard blockers: none at the model layer.** `Other(String)` is `#[serde(untagged)]` and keeps the
original spelling, so no element type can vanish or be misread as something else. The blockers are one
layer up:

1. **`image` has no write path for the `files` map** — D2 above. An image tool cannot be built without
   first adding a file-map command to `xd-core` and a setter to `XdDoc`.
2. **`frame` has no membership.** `frame_id` is set to `None` once (`doc.rs:1148`) and read nowhere, so
   frames would neither clip their contents nor carry children when moved.

---

## 4. Images

| Aspect | Status | Evidence |
| --- | --- | --- |
| `files` top-level key in `format.rs` | **PRESENT, unconditional, lossless** | `scene.rs:447`, doc at `:424-429`; §1.1 |
| Rendering from `files[fileId].dataURL` | **PRESENT** | `imageDataUrl` `ui/src/excalidrawScene.js:258-262`; decode-and-cache `excalidrawEdit.js:546-575`; draw `excalidrawView.js:433-440` |
| Placeholder when bytes never arrived | **PRESENT** | `excalidrawView.js:434-437`; the cache slot is claimed *before* the decode resolves so a repaint mid-decode does not queue a second one (`excalidrawEdit.js:561-565`) |
| Refreshed after undo/redo and paste | **PRESENT** | `syncFiles()` at open (`:1381`), in `history()` (`:533`), in `pasteElements` (`:1037`) — and deliberately not on every structural change, with the reason given (`:540-545`) |
| **Paste an image from the clipboard** | **MISSING** | `onPaste` reads only `getData("text/plain")` (`excalidrawEdit.js:1006-1019`). No `clipboardData.files`, no `items[].getAsFile()` anywhere in the repo |
| **Drop an image onto the canvas** | **MISSING** | no `drop` / `dragover` listener; the full listener table is `excalidrawEdit.js:1293-1309` |
| Image tool (`9`) | **MISSING** | §2 |
| Cropping | **MISSING as a feature, PRESERVED as data** | `crop` rides in `Element::rest` and is asserted to survive (`roundtrip.rs:263`); the renderer ignores it (`excalidrawView.js:439`), so a cropped image renders un-cropped. See D4 |
| **Round-trip safety with images** | **SAFE — no data loss** | §1.1 |

---

## 5. Eraser

**Entirely absent.** No tool entry, no hover-to-erase, no partial/stroke-splitting erase, nothing to
restore. The nearest thing is `Delete`/`Backspace` on a selection (`excalidrawTools.js:264` →
`XdDoc::delete_selection` at `crates/xd-wasm/src/lib.rs:509-513`), which *is* undoable.

Worth noting for whoever implements it: the model is already the right shape. Excalidraw's eraser sets
`isDeleted` rather than removing, `is_deleted` is modelled (`scene.rs:334`), and there is a test
pinning that deleted elements stay in the file rather than being tidied away
(`format.rs:99-107`, `roundtrip.rs:385-397`). So undo-restores-the-stroke comes free.

---

## 6. Freedraw

**The best-matched feature in the repo — not partial.**

- `pressures` is a modelled field with JS-compatible number spelling (`scene.rs:376-387`).
- Every sample records the device's real pressure; a mouse gets `0.5` (`pressureOf`,
  `excalidrawTools.js:200-203`).
- `simulatePressure` is derived from the device — `false` for a pen, `true` otherwise
  (`isPressureDevice`, `excalidrawTools.js:205-213`; applied at `excalidrawEdit.js:696-703`), with the
  reasoning stated correctly: with simulation on, perfect-freehand invents a profile from stroke speed
  and ignores the recorded numbers.
- `draft_point` back-fills the pressure array so it can never be shorter than `points`
  (`crates/xd-wasm/src/lib.rs:392-419`).
- Coalesced pointer events are drained per frame, so a trackpad stroke is a stroke and not a polygon
  (`excalidrawEdit.js:775-783`).
- perfect-freehand options match Excalidraw's own `generateFreeDrawShape`:
  `size: (strokeWidth||1) * 4.25, thinning: 0.6, smoothing: 0.5, streamline: 0.5, last: true`
  (`ui/src/excalidrawView.js:399-412`), rendered as a filled outline rather than a stroked path, which
  is what gives it variable width (`:414-421`).

Only gap: no `X` as the second shortcut (§2).

---

## 7. Canvas / app chrome

| Feature | Excalidraw | This repo | Status | Evidence |
| --- | --- | --- | --- | --- |
| Zoom in / out / readout / 1:1 | on-canvas island | header descriptors + menu | **PRESENT** | `excalidrawEdit.js:396-402`; row renderer `ui/src/viewActions.js:74-97`; menu `ui/standalone/menu.js:124-164` |
| Undo / redo buttons | yes | yes, correctly disabled | **PRESENT** | `excalidrawEdit.js:403-406` |
| Scroll to content / Fit | yes | yes (`fit()`, arithmetic from the model not the painter) | **PRESENT** | `excalidrawEdit.js:353-368, 394-395`; `XdDoc::fit_transform` `crates/xd-wasm/src/lib.rs:173-178` |
| Hamburger / main menu | yes | **yes** — one button, sections File/Edit/View/Export/Other | **PRESENT** | `ui/standalone/menu.js:32-38, 67-251`; mounted `ui/standalone/shell.js:178` |
| Canvas background control | yes | **no UI** | **MISSING** | `appState.viewBackgroundColor` is honoured on paint (`excalidrawEdit.js:268-271`, `excalidrawView.js:96-97`) and preserved on save, but nothing can change it. The props panel offers stroke and *element* background only (`ui/src/excalidrawProps.js:48-117`) |
| Appearance (light/dark) | `Alt+Shift+D` | in-menu control, no shortcut | **PARTIAL** | `menu.js:95-101` → `ui/standalone/theme.js`; the view re-reads its tokens via `MutationObserver` on `data-theme`/`class` (`excalidrawEdit.js:1318-1334`) |
| Grid mode | `Cmd+'` | **no** | **MISSING** | nothing draws a grid in the paint loop (`excalidrawEdit.js:251-295`); `gridSize` is written `null` into new scenes and never read (`format.rs:76-82`, `ui/src/excalidrawDoc.js:28`) |
| Zen mode | `Alt+Z` | no | **MISSING** | — |
| View mode | `Alt+R` | no | **MISSING** | `excalidrawView.js` exports `renderExcalidrawCanvas` for a read-only viewer (`shell.js:39-41`) but nothing toggles into it |
| Object snapping | `Alt+S` | **no** | **MISSING** | `drawGuides` is written *and tested* (`ui/test/excalidrawChrome.test.js:170-204`) and never called from the editor — the alignment-guide renderer is built and unwired |
| Stats panel | `Alt+/` | no | **MISSING** | — |
| Help dialog | `?` | **no** | **MISSING** | shortcut discovery is tooltips (`excalidrawToolbar.js:89-92, 167-169`) plus the printed digit on each button (`:171-173`) |
| Context menu | right-click | **no** | **MISSING** | no `contextmenu` listener anywhere in `ui/`; `pointerIntent` returns `null` for the right button and comments that it "belongs to the context menu" (`excalidrawTools.js:135-136, 156`) |
| Zoom limits | 0.1 – 30 | **0.05 – 8** | **PARTIAL** | `excalidrawEdit.js:81-82` |
| Trackpad pinch-zoom / wheel-pan | yes | yes | **PRESENT** | `wheelIntent` `excalidrawTools.js:288-293` |
| Dirty marker / window title | n/a | yes, derived from saved-vs-current text | **PRESENT** | `shell.js:119-139` |
| Error line in chrome | n/a | one line, trouble only | **PRESENT** | `ui/index.html:115-124`; `shell.js:180-204` |

---

## 8. File format & document-level I/O

The strongest area in the codebase. Specifics, because this is the part most likely to be doubted:

| Property | Status | Evidence |
| --- | --- | --- |
| `type` | preserved; a missing `type` gains `"excalidraw"` on save, matching Excalidraw's export | `scene.rs:435`; `roundtrip.rs:494-505` |
| `version` | preserved verbatim, not normalised | `scene.rs:438`; `roundtrip.rs:298` (a fixture's `version: 3` survives) |
| `source` | preserved; **never invented for somebody else's file** | `scene.rs:439-442` (`skip_serializing_if = "String::is_empty"`); `roundtrip.rs:504` |
| `appState` — all keys | **fully preserved** | §1.1 |
| `files` | **fully preserved** | §1.1 |
| Unknown top-level keys | preserved | `Scene::rest` `scene.rs:448-449`; `roundtrip.rs:292` |
| Unknown element keys | preserved with values, nested arbitrarily deep | §1.2 |
| Unknown binding keys | preserved | `scene.rs:225-235`; `roundtrip.rs:280-289` |
| Deleted elements | kept in the file, not drawn | `format.rs:99-107`; `roundtrip.rs:385-397` |
| Keys Excalidraw always writes | always written, even when `null` (the `skip_serializing_if` trap, avoided deliberately) | `scene.rs:26-33, 300-324`; `roundtrip.rs:399-418` |
| Whole numbers written without `.0` | yes — otherwise every save rewrites every line | `mod jsnum` `scene.rs:58-151`; `roundtrip.rs:420-434` |
| Field order matches Excalidraw's | yes, via declaration order + `flatten` | `scene.rs:35-41`; `roundtrip.rs:364-375` |
| 2-space indent, no trailing newline | yes | `format.rs:59-68`; `roundtrip.rs:436-443` |
| Save is a fixed point (autosave can't churn) | yes | `roundtrip.rs:98-109`; `contract.test.js:835` |
| Holds for scenes nobody wrote by hand | yes — proptest over arbitrary elements, `rest`, `appState`, `files` | `roundtrip.rs:518-...`; `MODELLED` collision guard `:524-531` |
| Fractional `index` maintained on reorder | **yes** — a full port of Excalidraw's `fractional-indexing` | `doc.rs:817-923`: reindexes each maximal moved run between its surviving neighbours, and *declines* rather than guessing when the space is exhausted or a neighbour's key is unparseable (`:908-912`). `Insert` overwrites an arriving key unconditionally (`:706-715`). **Note: the comment at `scene.rs:320` ("Nothing in this crate generates one yet") is stale** |
| `.excalidrawlib` opened as a scene | refused with a sentence naming the type | `format.rs:36-46`; `roundtrip.rs:456-463` |
| Error sentences fit to show a user | yes, in `parseScene`'s original order | `format.rs:1-16, 26-57`; `roundtrip.rs:445-492` |

**Corpus:** 15 fixtures, 4 of them real captured drawings (34–80 KB), with a self-check that the corpus
cannot silently shrink (`roundtrip.rs:62-72`) and a labelled caveat that
`excalidraw-com-export.excalidraw` is a reconstruction rather than a capture (`roundtrip.rs:17-22`).

### 8.1 App-layer I/O

- Three Tauri commands and no more: `xd_read_file`, `xd_write_file`, `xd_startup_path`
  (`src-tauri/src/lib.rs:34, 53, 77`).
- Dialogs and the `excalidraw`/`json` filter — `ui/standalone/files.js:83-110`, with an extension
  appended when the user typed none (`:104-110`).
- New / Open / Save / Save As in the menu and on `Cmd+N/O/S/Shift+S` (`shell.js:148-173`;
  `files.js:129-149`, bound capture-phase so a canvas cannot swallow `Cmd+S`).
- Autosave is an 800 ms idle debounce behind `worthSaving` (`excalidrawEdit.js:79, 444-485`), and a
  pending autosave is flushed by `dispose` rather than dropped (`:1441-1453`).
- A double-clicked document arrives via `xd_startup_path` because macOS sends an open-document event
  rather than an argv entry (`files.js:67-78`); a failure there degrades to an empty document with the
  reason in the header rather than refusing to launch (`shell.js:325-348`).

---

## 9. Export

**Nothing works today, and it is blocked on two independent things.**

| Path | Status | Evidence |
| --- | --- | --- |
| SVG export | **MISSING (capability)** | `exportSvg` checks `typeof view.exportSVG !== "function"` and reports "SVG export isn't built yet — it lands with the editor" (`ui/standalone/export.js:46-55`). The view's handle carries only `setSidebar` and `sidebarOpen` (`excalidrawEdit.js:1406-1412`) — there is no `exportSVG` |
| PNG export | **MISSING (capability *and* transport)** | same guard (`export.js:86-95`), plus `xd_write_file` takes a `String` and there is **no `xd_write_bytes`** — `src-tauri/src/lib.rs` defines exactly three commands (34, 53, 77). Even a rendered PNG has nowhere to go: the code says so and discards the bytes at `export.js:104-107` |
| Menu entries | present, and honest about being stubs | `export.js:115-133`, group `"export"` (`menu.js:36`) |
| Export to clipboard / copy-as-PNG (`Shift+Alt+C`) / copy-as-SVG | **MISSING** | `onCopy` writes only `text/plain` (`excalidrawEdit.js:990-996`) |
| Scale / background / dark-mode / embed-scene / only-selected options | **MISSING** | no export dialog exists |

The split is deliberate and documented at length (`export.js:1-26`): the *capability* belongs to the
portable view, the *dialog* to the shell. The dialog half is built; the capability half was never
written.

---

## 10. Library

**Absent in every respect.**

- No `.excalidrawlib` reading or writing. The only mentions are the two parse rejections that exist to
  tell the user they opened the wrong file: `crates/xd-core/src/format.rs:36-46` and its JS twin
  `ui/src/excalidrawScene.js:109-113`. `roundtrip.rs:456-463` pins that sentence.
- No `libraryItems` handling, no library sidebar, no "Add selection to library", no library browser.
  Grepping `library` / `excalidrawlib` across `ui/src`, `ui/standalone` and `crates` returns only those
  two rejection sites and prose in comments.

---

## 11. Collaboration, links, embeds — out of scope but missing

- **Collaboration:** none. Worth recording that the model is deliberately *prepared* for it:
  `version` / `versionNonce` / `updated` are maintained on every edit specifically because
  "Excalidraw's own reconciliation depends on these; bumping them correctly now is the difference
  between collaboration later and a rewrite later" (`scene.rs:15-18`), and `isDeleted` tombstones are
  kept (`format.rs:99-107`). Groundwork laid, not designed out.
- **Element links (`Cmd+K`):** `link` is modelled and explicitly inert — "nothing in this crate reads
  it" (`scene.rs:340-345`). No UI, no click-through, no link indicator on the canvas.
- **Embeds / iframes:** round-trip safe as `Other`, rendered as labelled placeholders
  (`excalidrawScene.js:51-56`; `drawPlaceholder` `excalidrawView.js:455+`). Correct behaviour for a
  native app that cannot host a live web view; not creatable, not interactive.
- **Scene sharing / live collaboration URL / room:** none.

---

## 12. Accessibility and `a11y.js`

`ui/src/a11y.js` (193 lines) is a copy of term.hut's module. It exports five things.
**Only `setPressed` is used anywhere in this repo** — three imports, all of them `setPressed` alone:
`ui/src/viewActions.js:37`, `ui/src/excalidrawToolbar.js:28`, `ui/src/excalidrawProps.js:33`.

| Primitive | Defined | Used here | Consequence |
| --- | --- | --- | --- |
| `setPressed(el, on)` — mirrors an `.on` class to `aria-pressed` | `a11y.js:152-154` | **yes** | toggle state is exposed: toolbar buttons (`excalidrawToolbar.js:174, 188, 201-206`), props controls, header toggles (`viewActions.js:130-133`) |
| `asDialog(overlay, panel, {label})` — real modal: `role="dialog"`, `aria-modal`, Tab containment, stacking-aware, focus restore | `a11y.js:47-113` | **no** | there are no dialogs yet; needed the moment an export or help dialog lands |
| `asButton(el, …)` — makes a `div` Enter/Space-activatable | `a11y.js:130-148` | **no** | genuinely unneeded — every control here is a real `<button>` |
| `announce(msg, assertive)` — shared polite live region | `a11y.js:161-183` | **no** | **gap:** tool changes, save failures and "No app host" are never announced |
| `asStatus(el, assertive)` — marks an in-place readout as a live region | `a11y.js:188-193` | **no** | **gap:** its own doc comment says it is for "the editor's saved/editing status line" — and `#app-status` (`ui/index.html:121`) *is* that line, written with `textContent` and toggled `hidden` by `shell.js:186-191`, with no `role="status"`. **A failed save is silent to a screen reader.** |

**What is done well:**

- The toolbar is a real `role="toolbar"` with an `aria-label`, one tab stop rather than nine, with the
  arrow keys deliberately left to the canvas because they nudge the selection
  (`excalidrawToolbar.js:150-157`).
- Every tool button carries its name *and* its shortcut in both `title` and `aria-label`
  (`excalidrawToolbar.js:167-169`), and the icon SVGs are `aria-hidden="true"` +
  `focusable="false"` (`:86`), so the glyph is never the only affordance.
- The menu is `aria-haspopup="menu"` / `aria-expanded`, `role="menu"` / `role="menuitem"`, closes on
  Escape and restores focus to its button, and Up/Down walk only *enabled* rows — a disabled entry is
  skipped rather than being a stop that does nothing (`menu.js:80-89, 105-108, 137-139, 217-231`).
- Boot failure is reported into the DOM, not only the console, on the reasoning that "a drawing app
  that shows nothing is indistinguishable from a drawing app that lost the drawing"
  (`ui/index.html:51-83`).
- The canvas takes the keyboard on mount so the first `Cmd+C` / `Cmd+A` / `R` works without clicking
  first (`excalidrawEdit.js:1355-1359`), and each chrome control hands the keyboard back afterwards —
  with the properties panel deliberately excluded so a swatch row stays tabbable
  (`excalidrawEdit.js:616-641`).

**What is missing beyond the two live-region gaps:**

- **The canvas is a bare `<canvas>` inside a `tabIndex = 0` div** (`excalidrawEdit.js:131-155`) with no
  `role`, no `aria-label` and no text alternative. A screen reader gets nothing about the drawing's
  contents — no element list, no "3 rectangles, 1 arrow".
- No keyboard-only path to *select* an element. `Cmd+A` then arrow-nudge is the only route; there is no
  Tab-through-elements.
- No `prefers-reduced-motion` handling.
- Focus-visible styling not audited here (`excalidrawToolbar.css` / `excalidrawProps.css` are the
  styles agent's surface).

---

## 13. Missing items ranked by user impact, with implementation sketches

**1. Image insertion (tool `9`, paste, drop) — highest impact.**
Blocked on D2. Sketch: add `Command::PutFile { id: String, entry: Value }` (and a `DropFile`) to
`crates/xd-core/src/command.rs:65`, applying to `Scene::files` and producing an inverse `Edit` like
every other command so undo works; expose `XdDoc::putFile(id, entry)` beside the existing getter
(`crates/xd-wasm/src/lib.rs:196-198`). Then in `excalidrawEdit.js`: a `drop` listener plus an
`onPaste` branch (`:1006`) that reads `ev.clipboardData.files`, resolves a data URL via `FileReader`,
computes the SHA-1 `fileId` Excalidraw uses, calls `putFile` then
`insert({type:"image", fileId, …})`, then `syncFiles()` (`:546`). Add an `image` entry to `TOOLS` with
`digit: "9"` and no letter key. Note the view may not touch the filesystem
(`scripts/check-imports.mjs:58`), so use an `<input type="file">` inside `host` — portable, and no
allowlist widening. Finally add the `files` map to `clipboardText` (`excalidrawDoc.js:232`) and read it
back in `parseClipboard` (`:245`), which closes **D1**.

**2. Eraser (`E` / `0`).**
Cheapest large win. `TOOLS` entry with `shape: null`; `pointerIntent` returns `{kind:"erase"}`; on
pointerdown/move hit-test along the pointer path, collect ids, and apply
`Command::Patch { fields: {"isDeleted": true} }` under a single constant coalesce key so the whole
sweep is one undo entry — the coalescing machinery already exists, `dragBy(dx, dy, "nudge")` at
`excalidrawEdit.js:915` is the precedent. Paint pending-erase elements at reduced opacity during the
sweep, as Excalidraw does. Undo restores for free because tombstones are kept (§5).

**3. SVG export.**
Add `exportSVG()` to the view's handle (`excalidrawEdit.js:1406`). Rough.js can emit SVG from the same
generator the canvas path already uses — `rough.svg(...)` alongside `rough.canvas(...)` at
`excalidrawEdit.js:275` — so the option mapping in `excalidrawScene.js:228-251` is reusable unchanged,
which is what keeps the two renderers from drifting. `export.js:46-73` already does the dialog and the
write, and SVG is text so nothing is needed on the Rust side. Highest value-per-line in the export
area.

**4. Grid mode (`Cmd+'`) and object snapping (`Alt+S`).**
Grid: `appState.gridSize` is already synced into `scene.appState` (`excalidrawEdit.js:550`); draw lines
in the paint loop just after the background fill (`:271-273`), and write `gridSize` back — which needs
the same new `appState`-write command as item 1, so bundle them. Snapping: `drawGuides` is already
written and tested (`ui/test/excalidrawChrome.test.js:170-204`) and simply never called; compute
candidate edge/centre alignments in `xd-core` during a `move` gesture and hand it the segments.

**5. Help dialog (`?`).**
The shortcut table is already data — `TOOLS` (`excalidrawTools.js:36-46`) plus the descriptors'
`name`/`shortcut` fields (`excalidrawEdit.js:393-419`), and `viewActions.js:21-30` documents those
fields as existing for exactly this kind of consumer. Render them into an overlay and wrap it in the
currently-unused `asDialog` (`a11y.js:47`). Low effort, and it retires the "unusable without knowing
nine keyboard shortcuts" problem that `excalidrawToolbar.js:1-7` describes.

**6. Canvas background control.**
Needs the same `appState`-write command as items 1 and 4. Then one swatch row in
`excalidrawProps.js` beside the existing stroke / element-background rows.

**7. Context menu.**
Nothing exists, and `excalidrawTools.js:135-136, 156` already reserves the right button for it. Every
entry it would need is already a command (copy/cut/paste/duplicate/delete/reorder/group), so this is
mostly a positioned popover reusing `menu.js`'s row-building.

**8. PNG export.**
Needs `xd_write_bytes(path, contents: Vec<u8>)` in `src-tauri/src/lib.rs` **and** `exportPNG()` on the
view (`canvas.toBlob` over an offscreen canvas at the requested scale). `export.js:75-107` documents
the blocker accurately, including why writing bytes through a `String` command would corrupt them.

**9. `Cmd+0` semantics and the macOS reorder bindings.**
Two-line fixes with real muscle-memory payoff: make `Cmd+0` reset to 100% and add `Shift+1` for
zoom-to-fit (`excalidrawTools.js:258`); use `Cmd+Alt+[` / `Cmd+Alt+]` for send-to-back /
bring-to-front on macOS (`:256-257`).

**10. Paste/duplicate group and container identity (D3).**
Add `groupIds`, `containerId`, `frameId` to `DROPPED` (`ui/src/excalidrawDoc.js:215`), minting fresh
group ids for the pasted set; clear or remap `group_ids` in `ops::duplicate`
(`crates/xd-core/src/ops.rs:172-186`).

**11. Lower priority for a local single-user editor.**
Frame tool, laser pointer, shape-switching (`Tab`), lasso, bucket fill, autoshape, library, embeds,
element links, view/zen mode, stats panel, command palette, align/flip, copy-paste-styles, eyedropper.
Of these, **frame** is the most structurally expensive (needs `frameId` membership, clipping and
move-children-with-frame, none of which exists — `doc.rs:1148`), and **library** the most
self-contained (a `.excalidrawlib` reader is a small variant of `format::parse`, which already
recognises and names the type at `format.rs:40-46`).

---

## 14. Sources

**Files read (absolute paths):**

- `/Users/hutson/code/excalidraw-rs/ui/src/excalidrawToolbar.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/excalidrawTools.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/excalidrawEdit.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/excalidrawView.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/excalidrawScene.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/excalidrawDoc.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/viewActions.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/a11y.js`
- `/Users/hutson/code/excalidraw-rs/ui/src/excalidrawProps.js` (grepped)
- `/Users/hutson/code/excalidraw-rs/ui/src/xdWasm.js` (grepped)
- `/Users/hutson/code/excalidraw-rs/ui/standalone/shell.js`
- `/Users/hutson/code/excalidraw-rs/ui/standalone/menu.js`
- `/Users/hutson/code/excalidraw-rs/ui/standalone/export.js`
- `/Users/hutson/code/excalidraw-rs/ui/standalone/files.js`
- `/Users/hutson/code/excalidraw-rs/ui/index.html`
- `/Users/hutson/code/excalidraw-rs/crates/xd-core/src/scene.rs`
- `/Users/hutson/code/excalidraw-rs/crates/xd-core/src/format.rs`
- `/Users/hutson/code/excalidraw-rs/crates/xd-core/src/doc.rs`
- `/Users/hutson/code/excalidraw-rs/crates/xd-core/src/command.rs`
- `/Users/hutson/code/excalidraw-rs/crates/xd-core/src/ops.rs`
- `/Users/hutson/code/excalidraw-rs/crates/xd-core/tests/roundtrip.rs`
- `/Users/hutson/code/excalidraw-rs/crates/xd-core/tests/fixtures/image-with-files.excalidraw`
- `/Users/hutson/code/excalidraw-rs/crates/xd-wasm/src/lib.rs`
- `/Users/hutson/code/excalidraw-rs/src-tauri/src/lib.rs`
- `/Users/hutson/code/excalidraw-rs/ui/test/excalidrawTools.test.js`
- `/Users/hutson/code/excalidraw-rs/ui/test/excalidrawChrome.test.js`
- `/Users/hutson/code/excalidraw-rs/ui/test/menu.test.js`
- `/Users/hutson/code/excalidraw-rs/ui/test/contract.test.js`
- `/Users/hutson/code/excalidraw-rs/scripts/check-imports.mjs` (grepped)

**Upstream reference:** `excalidraw/excalidraw@master` —
`packages/excalidraw/components/Tools.tsx` (the `TOOLS` table, `getToolShortcut`, `findShapeByKey`),
`packages/excalidraw/components/HelpDialog.tsx` (the full shortcut list),
`packages/common/src/keys.ts`.

**No files in the repository were modified.**
