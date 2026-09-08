# Text & Labels audit — excalidraw-rs vs. Excalidraw (React)

**Scope:** the TEXT & LABELS domain only.
**Method:** read the code; verified every behavioural claim empirically with throwaway probe
tests under `/Users/hutson/.claude/jobs/c8f3875b/tmp/probe*.test.js` (**not** in the repo) run
against the real vendored WASM core (`ui/vendor/xd-wasm/`). No repo files modified. Baseline
`bun test` at the time of the audit: **219 pass / 0 fail**. Reference behaviour confirmed against
`excalidraw/excalidraw` `packages/element/src/textElement.ts`, `packages/common/src/constants.ts`
and `packages/common/src/font-metadata.ts`.

---

## Verdict on the two user reports

### "Double-click an existing text element to re-edit is BROKEN/MISSING" — actually PRESENT and working

`ui/src/excalidrawEdit.js:858-871` handles `dblclick`, and I verified it empirically: with a
committed `text` element in the scene, `dbl(wrap, 320, 310)` produces a `<textarea>` whose
`value` is `"hello"`. Overlay positioning is sound too — `wrap.style.position = "relative"`
(`ui/src/excalidrawEdit.js:130`) is the containing block for the overlay's
`position:absolute` (`ui/src/excalidrawEdit.js:1122`), so the textarea lands on the element it
is editing.

What the user almost certainly hit is one of these three, all real:

1. **Double-clicking a shape does nothing at all.** `ui/src/excalidrawEdit.js:864` only opens the
   overlay when `element?.type === "text"`, and `:870` only creates text when `hit < 0`. On a
   *filled* rectangle the hit test succeeds and both branches fall through: no overlay, no label,
   no feedback of any kind. Verified: filled rect, `hitTest(100,60) === 0`, overlay absent,
   element count stays 1.
2. **Double-clicking the interior of an *unfilled* shape silently creates a free-floating text
   element** at the pointer instead of a label — `hit < 0` because transparent shapes are
   stroke-only (`crates/xd-core/src/geometry.rs:395`). Verified: produces a `text` element with no
   `containerId`, and the rectangle gains no `boundElements` entry. Reads as "it typed outside the
   box".
3. **Double-clicking a text element at zoom < ~0.65 rescales its font first** — see BROKEN-8.

### "Can't click on an object and start writing" — correct, container-bound text creation is entirely MISSING

Confirmed and extended the bindings auditor's finding. `container_id` **is** modelled on the
element — `crates/xd-core/src/scene.rs:367` (note: 367, not 369; 369 is inside the following
`line_height` serde attribute) — and it is **never set by anything**. `createText`
(`ui/src/excalidrawEdit.js:1169-1184`) writes neither `containerId` on the text nor a
`{id, type:"text"}` entry in the container's `boundElements`. Arrow labels are absent for the same
reason.

Corroborating greps:

- `rg -n "containerId|boundElements|autoResize" ui/src/` returns **exactly one** hit —
  `ui/src/excalidrawDoc.js:215`, where `boundElements` is on the clipboard *drop* list.
- `container_id` appears in Rust only at `crates/xd-core/src/scene.rs:367` (the field declaration)
  and `crates/xd-core/src/doc.rs:1167` (initialised to `None`).

Labels are therefore a **parse-and-preserve-only** feature: a file authored in Excalidraw renders
its labels roughly correctly and round-trips byte-faithfully, but the moment you move, resize,
duplicate, copy or delete anything, the label decouples or dangles.

---

## Feature table

| Feature | Excalidraw (React) | This repo | Status | Evidence |
| --- | --- | --- | --- | --- |
| **Text tool** | | | | |
| Text tool + shortcut | `t` / `8` | `t` / `8`, cursor `text` | PRESENT | `ui/src/excalidrawTools.js:44`, `:174` |
| Click-to-place text | caret at click point | element created, overlay opened, dropped ½ line so caret lands at the pointer | PRESENT | `ui/src/excalidrawEdit.js:706-708`, `:1169-1184` |
| Click-**drag** to create a fixed-width text box (`autoResize:false`) | yes | no — the text tool ignores drag entirely | MISSING | `ui/src/excalidrawTools.js:174` returns `{kind:"text"}`; no draw path at `ui/src/excalidrawEdit.js:706-708` |
| Clicking existing text **with the text tool** edits it | yes | creates a second overlapping text element | BROKEN | `ui/src/excalidrawEdit.js:704-708` — `pointerIntent` returns `text` before any hit test |
| Multi-line entry (Enter = newline) | yes | native `<textarea>` | PRESENT | `ui/src/excalidrawEdit.js:1078`, `:1226-1239` |
| Escape / ⌘Enter commits | yes | yes | PRESENT | `ui/src/excalidrawEdit.js:1228-1234` |
| Click-out commits | yes | `pointerdown` on canvas and `blur` both commit | PRESENT | `ui/src/excalidrawEdit.js:660`, `:1241` |
| Empty text edit removes the element | yes | yes | PRESENT | `ui/src/excalidrawEdit.js:1201-1209` |
| Auto-resize width/height from measured text | yes | `measure()` → `patch(width,height)` on commit; live re-place on input | PARTIAL (no wrap) | `ui/src/excalidrawEdit.js:1084-1101`, `:1214`, `:1222-1224` |
| Paste plain text → text element | yes | yes, at viewport centre | PRESENT | `ui/src/excalidrawEdit.js:1043-1068` |
| **Font & alignment** | | | | |
| Font size S/M/L/XL (16/20/28/36) | yes | yes | PRESENT | `ui/src/excalidrawProps.js:94-99`, `:511` |
| Font family picker | Excalifont 5 / Nunito 6 / Comic Shanns 8, plus an extended picker | 3 buttons: Hand-drawn 5, Normal **2 (Helvetica)**, Code **3 (Cascadia)** | PARTIAL | `ui/src/excalidrawProps.js:104-108`, `:512-514` |
| Bundled fonts (Excalifont, Nunito, Cascadia) | shipped as woff2 | none; CSS fallback stacks only | MISSING | `ui/src/excalidrawScene.js:73-77`; no `@font-face`, no font files (`find ui src-tauri -iname "*.woff*"` → empty) |
| `lineHeight` per font (1.15 Helvetica, 1.2 Cascadia, 1.25 rest) | yes | hardcoded 1.25 everywhere | PARTIAL | `crates/xd-core/src/doc.rs:1168`, `ui/src/excalidrawScene.js:89-90`, `ui/src/excalidrawEdit.js:1171` |
| Changing font size/family re-measures the box | yes | **no** — `setStyle` patches `fontSize` and leaves `width`/`height` stale | BROKEN | `crates/xd-core/src/ops.rs:192-199`; verified fontSize 20→36, width/height stayed 100/25 |
| `textAlign` left/center/right control | yes | **no control at all**, and `stylePatch` would filter it out anyway | MISSING | `ui/src/excalidrawProps.js:505-514` (only two text rows); `ui/src/excalidrawDoc.js:105-122` `STYLE_KEYS`; verified `stylePatch({textAlign:"center"}) === {}` |
| `textAlign` honoured when painting | yes | yes (measured against `element.width`) | PRESENT | `ui/src/excalidrawScene.js:272-278`, `ui/src/excalidrawView.js:424-431` |
| `textAlign` honoured in the overlay | yes | yes | PRESENT | `ui/src/excalidrawEdit.js:1120-1121`, `:1131` |
| `verticalAlign` top/middle/bottom | yes | **parsed, preserved, never honoured** by painter, overlay, or any control | MISSING | `crates/xd-core/src/scene.rs:365`; `ui/src/excalidrawScene.js:267-280` never reads it; `ui/src/excalidrawView.js:424-431` |
| Resizing text scales `fontSize` | yes | yes | PRESENT | `crates/xd-core/src/ops.rs:120-125` |
| **Line wrapping / measurement** | | | | |
| Word wrap to a width (`wrapText`) | yes | **no wrapping anywhere** — both `measure()` and `textLayout()` split on `\n` only | MISSING | `ui/src/excalidrawEdit.js:1092-1093`, `ui/src/excalidrawScene.js:268-269` |
| Overlay wraps as you type | yes (textarea width = container width) | `overlay.wrap = "off"`, `white-space:pre` | MISSING | `ui/src/excalidrawEdit.js:1081`, `:1137` |
| Who owns measurement | JS (`ctx.measureText` + font metrics) | JS only; Rust never measures | PRESENT (by design) | `ui/src/excalidrawEdit.js:1073-1077`, `ui/src/excalidrawDoc.js:278-286` |
| `originalText` vs `text` distinction (unwrapped source vs wrapped render) | yes | fields exist, always written identical | MISSING | `crates/xd-core/src/scene.rs:351-353`; `ui/src/excalidrawEdit.js:1214` writes the same string to both |
| Baseline placement | font-metric ascender | each line centred in its slot, `textBaseline:"middle"` | PARTIAL (documented approximation) | `ui/src/excalidrawScene.js:263-266`, `ui/src/excalidrawView.js:429` |
| **Container-bound labels** | | | | |
| Double-click shape → type a label | yes | nothing happens | MISSING | `ui/src/excalidrawEdit.js:864-870` |
| Enter with a shape selected → label | yes | only works if the selection *is* a text element | MISSING | `ui/src/excalidrawEdit.js:947-955`; verified Enter on a selected rect → no overlay |
| Text tool clicked on a shape → binds | yes | creates a free text element on top | MISSING | `ui/src/excalidrawEdit.js:706-708` |
| Arrow labels | yes | none | MISSING | no arrow-label code; `crates/xd-core/src/binding.rs` is arrow endpoints only |
| `containerId` set on the text | yes | never written | MISSING | `crates/xd-core/src/doc.rs:1167`; `rg containerId ui/src/` → 0 hits |
| `boundElements` gains the text | yes | only `Command::Bind` writes it, and only for arrows | MISSING | `crates/xd-core/src/command.rs:118-127`, `crates/xd-core/src/doc.rs:985-1030` |
| Label auto-wrapped to `container.width - 2*5` (`BOUND_TEXT_PADDING = 5`) | yes | no | MISSING | no wrap code exists |
| Label vertically centred in container | yes | no | MISSING | `ui/src/excalidrawScene.js:267-280` |
| **Moving container moves label** | yes | **no** | BROKEN | verified: rect 10,10 → 110,110 while the text stayed at 60,45 |
| **Resizing container reflows label** | yes | **no** | BROKEN | verified: rect width 200→390, text `x/y/width/fontSize` unchanged at 60/45/100/20 |
| Container grows in height for a tall label | yes (`computeContainerDimensionForBoundText`) | no | MISSING | — |
| **Deleting container deletes label** | yes | **no** — label survives with `containerId` naming a ghost | BROKEN | `crates/xd-core/src/doc.rs:1032-1080` cleans `startBinding`/`endBinding`/`boundElements` but not `containerId`; verified: delete rect → `text/t` remains with `containerId:"r"` |
| Deleting label cleans container's `boundElements` | yes | yes | PRESENT | `crates/xd-core/src/doc.rs:1062-1073`; verified → `boundElements: []` |
| Duplicating a labelled container duplicates the label | yes | no — the copy loses `boundElements`; a duplicated label keeps `containerId` pointing at the **original** | BROKEN | `crates/xd-core/src/ops.rs:182` clears `bound_elements` but not `container_id` |
| Copy/paste a label | Excalidraw re-parents or strips | `containerId` survives the clipboard and points at a foreign id | BROKEN | `ui/src/excalidrawDoc.js:215` `DROPPED` omits `containerId`; verified the payload contains `"containerId": "r"` |
| **Format round-trip** | | | | |
| `containerId`, `originalText`, `lineHeight`, `fontFamily`, `fontSize`, `textAlign`, `verticalAlign`, `boundElements` | — | all modelled, all preserved | PRESENT | `crates/xd-core/src/scene.rs:337`, `:351-373`; differential test `crates/xd-core/tests/roundtrip.rs:119-185` |
| `autoResize` | — | unknown key → rides in `Element::rest`, preserved verbatim | PRESENT | `crates/xd-core/src/scene.rs:401-410`; verified `"autoResize":true` survives open→edit→save |
| `autoResize` **honoured** | yes | never read | MISSING | `rg autoResize` → fixtures only |
| **Editing UX** | | | | |
| Caret, in-text selection, IME, native undo | DOM textarea | DOM textarea | PRESENT | `ui/src/excalidrawEdit.js:1071-1078` |
| Copy/cut/paste inside the overlay stays native | yes | yes — all three handlers early-return on `editing` | PRESENT | `ui/src/excalidrawEdit.js:990`, `:1001`, `:1007` |
| Canvas keys don't leak while typing | yes | `stopPropagation` on overlay keydown | PRESENT | `ui/src/excalidrawEdit.js:1235-1238`; test `ui/test/contract.test.js:590-601` |
| Overlay follows camera (pan/zoom/resize) | yes | `placeOverlay()` on wheel + ResizeObserver | PRESENT | `ui/src/excalidrawEdit.js:774`, `:1312-1315` |
| Overlay has an accessible name | — | none (`aria-label` unset) | MISSING | `ui/src/excalidrawEdit.js:1078-1081` |
| `dispose()` mid-edit commits the text | — | **discards it** | BROKEN | `ui/src/excalidrawEdit.js:1427-1429` sets `editing = null` then `overlay.remove()` |

---

## Ranked MISSING/BROKEN items with root cause and implementation sketch

### 1. Container-bound labels cannot be created (the headline bug)

**What's absent.** Every entry point Excalidraw offers — double-click a shape, Enter with a shape
selected, text tool clicked on a shape — does nothing here. No code writes `containerId` or a text
entry in `boundElements`.

**Root cause.** Two layers:

- `ui/src/excalidrawEdit.js:858-871` — `onDoubleClick` has exactly two branches
  (`type === "text"` → edit; `hit < 0` → new free text). A shape hit falls through silently.
- The WASM surface has no way to express "create a text bound to this container".
  `XdDoc::bind` (`crates/xd-wasm/src/lib.rs:546-559`) maintains `boundElements` but only for arrow
  `startBinding`/`endBinding` via `Command::Bind` (`crates/xd-core/src/command.rs:118-127`), whose
  payload is a `Binding {elementId, focus, gap}` — the wrong shape for a label.
  `Doc::new_element` hardcodes `container_id: None` (`crates/xd-core/src/doc.rs:1167`).
  A missing WASM export is the strongest evidence here: the UI could not do this even if
  `onDoubleClick` wanted to.

**Sketch.**

1. `crates/xd-core/src/command.rs` — add a variant, or reuse
   `Batch(vec![Patch{text: containerId}, Patch{container: boundElements}])`. Reuse is cheaper and
   inverts correctly for free, but `boundElements` maintenance is already centralised in
   `Doc::set_bound_elements` (`crates/xd-core/src/doc.rs:985-1030`), so prefer a
   `Command::BindLabel { container: String, text: String }` that calls it — that keeps the "never
   write `[]` onto an element that never had the key" rule
   (`crates/xd-core/src/doc.rs:986-990`) in one place.
2. `crates/xd-core/src/doc.rs` — teach `new_element` to accept an optional container, so a label
   is born with `container_id: Some(..)`, `text_align: "center"`, `vertical_align: "middle"`
   (Excalidraw's defaults for bound text, unlike free text's `left`/`top` at
   `crates/xd-core/src/doc.rs:1165-1166`).
3. `crates/xd-wasm/src/lib.rs` — new exports next to `bind`:
   - `#[wasm_bindgen(js_name = beginLabel)] pub fn begin_label(&mut self, container_index: usize, style: JsValue) -> Result<Change, JsValue>`
     — creates the text, binds both halves, selects the container, returns the change.
   - `#[wasm_bindgen(js_name = labelOf)] pub fn label_of(&self, index: usize) -> i32`
     — so JS can find an existing label from the container's `boundElements`.
4. `ui/src/xdWasm.js` — the facade is an **explicit whitelist** (`:108-170`); add `beginLabel` and
   `labelOf` lines or the new exports are unreachable from the editor.
5. `ui/src/excalidrawEdit.js:858-871` — rewrite `onDoubleClick`:
   ```
   if text            -> openOverlay(existing, false)
   else if labelable  -> const li = doc.labelOf(hit);
                         if (li >= 0) openOverlay(doc.element(li), false);
                         else { edited(doc.beginLabel(hit, styleFor("text", style)));
                                openOverlay(doc.element(doc.labelOf(hit)), true); }
   else if hit < 0    -> createText(x, y)
   ```
   `labelable` = rectangle | ellipse | diamond | arrow | line | image | frame — Excalidraw's
   `isTextBindableContainer`.
6. Same in the `"edit"` intent (`ui/src/excalidrawEdit.js:947-955`) so Enter on a selected shape
   enters its label, and in the `case "text":` pointerdown branch (`:706-708`) so the text tool
   clicked on a shape binds instead of stacking a free text element on top.

### 2. No line wrapping — so a label cannot be laid out even once it exists

**What's absent.** `measure()` (`ui/src/excalidrawEdit.js:1092-1093`) and `textLayout()`
(`ui/src/excalidrawScene.js:268-269`) both do `text.split("\n")` and nothing else.
`overlay.wrap = "off"` (`ui/src/excalidrawEdit.js:1081`) with `white-space:pre` (`:1137`).
`originalText` and `text` are therefore always identical — the field pair exists in the model
(`crates/xd-core/src/scene.rs:351-353`) but the distinction Excalidraw uses it for (unwrapped
source vs. wrapped render) is never exercised.

**Root cause.** Wrapping needs a width budget and a measurement function in the same place. The
width budget comes from the container (`BOUND_TEXT_PADDING = 5`, so for a rectangle
`width - 2*5`; for an ellipse `(width/2)*√2 - 10`; for a diamond `round(width/2) - 10`; for an
arrow `max(ARROW_LABEL_WIDTH_FRACTION * width, minWidth)` with `padding * 8`), and measurement is
`ctx.measureText`, which only JS has. So this has to be a JS function.

**Sketch.** In `ui/src/excalidrawDoc.js`, next to `textBox` (`:278-286`), add a pure
`wrapText(measureFn, value, maxWidth) -> string` (greedy word wrap; break over-long words per
grapheme; preserve explicit `\n`) plus `labelWidthFor(container) -> number` implementing the
per-kind formulas above. Then:

- `ui/src/excalidrawEdit.js` `measure()` (`:1091-1101`) takes an optional `maxWidth` and wraps first.
- `closeOverlay` (`:1211-1214`) writes `originalText: value` and `text: wrapped` — currently it
  writes the same string to both (`:1214`).
- `placeOverlay` (`:1103-1141`) sets the overlay width from `labelWidthFor(container)` and
  `wrap = "soft"` when editing a bound label, so what you type wraps the way it will paint.
- `ui/src/excalidrawScene.js` `textLayout` needs no change if `text` is pre-wrapped — which is
  exactly why Excalidraw stores both fields.

### 3. Deleting a container orphans its label — a dangling reference in the saved file

**What's broken.** Verified: delete a labelled rectangle and the text element survives in the file
with `containerId: "r"` where no `r` exists. This is precisely the failure
`Doc::detach_references`' own doc comment warns about
(`crates/xd-core/src/doc.rs:1034-1038`: *"A file that names an element it does not contain is the
classic hand-edited-`.excalidraw` failure, and it does not announce itself"*).

**Root cause.** `detach_references` (`crates/xd-core/src/doc.rs:1041-1080`) walks `start_binding`,
`end_binding` and `bound_elements`. It never looks at `container_id`, and `Command::Delete`'s
handler (`crates/xd-core/src/doc.rs:724`) never expands the doomed set to include bound children.

**Sketch.** In `Doc::apply`'s `Command::Delete` arm (`crates/xd-core/src/doc.rs:724`), before
computing `doomed`, expand it: for each id, if that element has `bound_elements` entries of
`type: "text"`, add those ids too (Excalidraw's `getBoundTextElementId` cascade). Then in
`detach_references`, add a third check: a surviving element whose `container_id` names a doomed
element gets `containerId: null`. The second half is the safety net for a file that arrived already
half-bound. Add a test in `crates/xd-core/tests/history.rs` — the labelled fixture is already there
at `:44-72`.

Two sibling dangling-reference paths, same fix shape:

- `ops::duplicate` (`crates/xd-core/src/ops.rs:182`) clears `bound_elements` but not
  `container_id`; a duplicated label points at the original container. Duplicating a container
  should clone its label and re-point both halves.
- `ui/src/excalidrawDoc.js:215` `DROPPED` omits `containerId`. Verified: `clipboardText` emits
  `"containerId": "r"`. Add `"containerId"` to that list — the comment above it already explains
  exactly why (`:210-214`).

### 4. Moving/resizing a container does not carry the label

**What's broken.** Verified independently: drag rect 10,10 → 110,110, label stays at 60,45; resize
rect width 200 → 390, label `x/y/width/fontSize` unchanged.

**Root cause.** `ops::drag`, `ops::resize` (`crates/xd-core/src/ops.rs:95-129`) and `ops::rotate`
(`:132-160`) iterate `ids` and emit one `Patch` each. `container_id` and `bound_elements` are never
consulted, so a label only moves when it is itself selected. Note the label *is* dragged correctly
when grabbed directly, and a select-all drag moves both (verified) — so this reads as working until
you grab only the box, which is the common case.

**Sketch.** In `crates/xd-core/src/ops.rs`, add
`fn with_labels(doc: &Doc, ids: &[String]) -> Vec<String>` that appends each id's bound text
children, and run `drag`/`rotate` over that expanded set. `resize` needs more than translation:
after resizing the container, re-emit the label's `x`/`y`/`width` for the new box. Since wrapping
lives in JS (item 2), the honest split is: Rust translates and computes the *available* width; JS
re-measures and patches `text`/`width`/`height` afterwards. That means a new export —
`#[wasm_bindgen(js_name = labelBudget)] pub fn label_budget(&self, text_index: usize) -> f64`
returning the per-kind max width — plus a `reflowLabels()` pass in `ui/src/excalidrawEdit.js`'s
`onPointerUp` (`:789-833`) for the labels touched by the gesture, and a facade line in
`ui/src/xdWasm.js`.

### 5. `verticalAlign` is silently ignored

**What's broken.** Parsed and preserved (`crates/xd-core/src/scene.rs:365`) and never read.
`textLayout` (`ui/src/excalidrawScene.js:267-280`) always lays lines from `element.y` downward. A
file whose labels are `verticalAlign: "middle"` (Excalidraw's default for bound text) paints at the
label's stored `y`, which happens to be right on open — and drifts as soon as anything reflows.

**Sketch.** `textLayout` needs the container's box to honour middle/bottom, which it does not
receive. Give it an optional second argument `container` and offset `y` by `0` /
`(maxH - textH)/2` / `(maxH - textH)` per Excalidraw's `handleBindTextResize`. The caller is
`ui/src/excalidrawView.js:424`; the painter already has the element list, so looking up
`element.containerId` is cheap. Add a `verticalAlign` row to the properties panel (item 6).

### 6. No text-align or vertical-align controls, and the style pipeline would reject them

**What's broken.** `ui/src/excalidrawProps.js:505-514` documents that there are exactly two text
rows, size and family. Excalidraw has four (size, family, text align, vertical align). Even adding a
button is not enough: `STYLE_KEYS` is derived from `DEFAULT_STYLE`
(`ui/src/excalidrawDoc.js:105-122`), which has no `textAlign`/`verticalAlign`, and `stylePatch`
filters against it — verified `stylePatch({textAlign:"center"})` returns `{}`.

**Sketch.** Add `textAlign: "left"` and `verticalAlign: "top"` to `DEFAULT_STYLE`
(`ui/src/excalidrawDoc.js:105-121`); add both to the `TEXTUAL` branch of `styleFor` (`:158`,
`:182-185`) so they only land on text elements; add `styleFrom` reads (`:135-153`); then two
`choiceGroup` rows in `ui/src/excalidrawProps.js` after `:514` with icons in the existing `ICONS`
table. No WASM change needed — `setStyle` (`crates/xd-wasm/src/lib.rs:501-507`) forwards an
arbitrary key map.

### 7. Changing font size or family leaves the element's box stale

**What's broken.** Verified: `setStyle({fontSize: 36})` on a text element whose box was 100×25
leaves `width`/`height` at 100/25. `ops::set_style` (`crates/xd-core/src/ops.rs:192-199`) is a plain
`Patch` fan-out. Consequences: the selection frame is wrong, the hit box is wrong (text is opaque
over its whole box, `crates/xd-core/src/geometry.rs:390`), and centre/right alignment measures
against the stale `element.width` (`ui/src/excalidrawScene.js:274-276`), so the text visibly slides.

**Sketch.** Rust cannot fix this — it has no font metrics. Do it in `applyStyle`
(`ui/src/excalidrawEdit.js:1288+`): after `doc.setStyle(patch)`, if the patch touched `fontSize` or
`fontFamily`, walk the selected text elements, `measure()` each with the new font, and
`doc.patch(id, {width, height})`. Bundle both under one coalesce key so it stays one undo entry.
While there, set `lineHeight` from the family (1.15 Helvetica/2, 1.2 Cascadia/3, 1.25 otherwise) —
currently hardcoded 1.25 at `crates/xd-core/src/doc.rs:1168`, `ui/src/excalidrawScene.js:89-90` and
`ui/src/excalidrawEdit.js:1171`, so picking "Normal" or "Code" writes a `lineHeight` Excalidraw
would not, and the height is off by 4-8% when reopened there.

### 8. Double-clicking small text while zoomed out rescales its font first

**What's broken.** `HANDLE_SIZE = 8` (`ui/src/excalidrawView.js:494`) is divided by the zoom
(`ui/src/excalidrawEdit.js:606`), so at 50% zoom the handle grab radius is 16 scene units. A 25px-tall
text element's N and S handles are 12.5 units from its centre — the whole element sits inside its own
handles. The second `pointerdown` of a double-click becomes a `resize` intent, and one pixel of
jitter fires `resizeTo`, which for text scales `fontSize` (`crates/xd-core/src/ops.rs:120-125`). The
overlay still opens, so the symptom is "double-clicking my label changed its size".

**Sketch.** In `pointerIntent` (`ui/src/excalidrawTools.js:136-180`), suppress the resize intent when
the probe's `hit` is the sole selected element *and* it is smaller than roughly 3× the handle radius
— i.e. prefer `move` when the handle ring has collapsed onto the body. Alternatively clamp the
divisor to `HANDLE_SIZE / Math.max(camera.scale, 1)` at `ui/src/excalidrawEdit.js:606`, which is the
smaller change but also makes handles harder to grab when zoomed out.

### 9. `dispose()` mid-edit discards the typed text

**What's broken.** `ui/src/excalidrawEdit.js:1427-1429` does `editing = null; overlay.remove();` —
no commit. Closing the pane while typing loses the text. Worse for a *new* element: `createText`
(`:1169-1184`) already inserted it and armed the autosave (`edited()` twice), so if dispose lands
inside the 800 ms debounce, the flush at `:1447` writes an invisible 0×0 empty text element to disk.
That contradicts the comment three lines above it (*"A tab closing on a debounce that has not fired
yet is an edit the user made and would never see again"*).

**Sketch.** Call `closeOverlay()` — not `closeOverlay(true)` — before `editing = null` at
`ui/src/excalidrawEdit.js:1427`. `closeOverlay` already handles both cases correctly: it deletes the
element when the value is blank (`:1201-1209`) and patches the measured box otherwise (`:1211-1214`).
The `discard` path stays for `history()` (`:529`), where the element genuinely may not survive.

### 10. Fonts are not bundled, so measurements do not match Excalidraw

No `@font-face` and no font files (`find ui src-tauri -iname "*.woff*"` → empty).
`ui/src/excalidrawScene.js:73-77` falls back to Chalkboard SE / Comic Sans / Helvetica Neue / SF
Mono. So `ctx.measureText` measures a *different typeface* than excalidraw.com would, and the
`width` this editor writes into the file is wrong for the `fontFamily` it names. Low user impact
locally (self-consistent: `measure` and `textLayout` agree, which is the property
`ui/src/excalidrawDoc.js:270-273` is written to protect) but widths do not survive a trip to
excalidraw.com.

**Sketch.** Vendor Excalifont/Nunito/Cascadia woff2 alongside `ui/vendor/xd-wasm/`, add `@font-face`
to `ui/styles.css`, and gate the first `measure()` behind `document.fonts.ready`.

**Aside:** `ui/src/excalidrawProps.js:101-103`'s comment says "3 Comic Shanns" — 3 is Cascadia. The
mapping in `ui/src/excalidrawScene.js:52-58` is right; only the comment is wrong.

---

## Reference values confirmed against the Excalidraw source

- `BOUND_TEXT_PADDING = 5`; containers apply `padding * 2`, arrows `padding * 8`
  (`packages/common/src/constants.ts`, `packages/element/src/textElement.ts`).
- Label max width: rectangle `width - padding*2`; ellipse `(width/2)*√2 - padding*2`; diamond
  `round(width/2) - padding*2`; arrow `max(ARROW_LABEL_WIDTH_FRACTION * width, minWidth)`.
- Container growth: `computeContainerDimensionForBoundText` — rectangle `dimension + padding`;
  ellipse `((dimension + padding)/√2)*2`; diamond `2*(dimension + padding)`; arrow
  `dimension + padding*8`.
- `FONT_FAMILY`: Virgil 1, Helvetica 2, Cascadia 3, Local 4, Excalifont 5, Nunito 6, Lilita One 7,
  Comic Shanns 8, Liberation Sans 9, Assistant 10. `DEFAULT_FONT_FAMILY = 5`,
  `DEFAULT_FONT_SIZE = 20`.
- Per-font `lineHeight`: Excalifont 1.25, Nunito 1.25, Virgil 1.25, Comic Shanns 1.25,
  Lilita One 1.15, Helvetica 1.15, Liberation Sans 1.15, Cascadia 1.2, Assistant 1.25.
- `VERTICAL_ALIGN` = TOP | MIDDLE | BOTTOM; `TEXT_ALIGN` = LEFT | CENTER | RIGHT.

---

## Test coverage gaps

`ui/test/contract.test.js` covers text creation (`:556-571`), commit-and-measure (`:573-588`),
keyboard isolation (`:590-601`) and a real-core round trip (`:967-982`).
`ui/test/excalidrawPaint.test.js:366-376` checks a frame still paints with the overlay open.
`crates/xd-core/tests/roundtrip.rs:119-185` is a strong differential test over the text fields.

Nothing anywhere covers:

- double-clicking an **existing** text element — the path the user reported broken, untested even
  though it works
- double-clicking a shape
- Enter-to-edit (`ui/src/excalidrawEdit.js:947-955`)
- any `containerId` / `boundElements` label behaviour, in JS or Rust
- `textAlign` / `verticalAlign` in the painter or the panel
- a font size or family change on a committed text element
- `dispose()` while the overlay is open

`crates/xd-core/tests/history.rs:44-72` already builds a labelled rectangle fixture, and `:684-800`
exercises `boundElements` maintenance for arrows — that fixture is the natural place to pin the
delete-cascade and `containerId` detach behaviour from item 3.
