# Selection, Transform & Document Manipulation — audit of `excalidraw-rs` vs React Excalidraw

Scope: selection, groups, transform handles, flip, z-order, move/snap, duplicate &
clipboard, lock/link, align & distribute, undo/redo, frames, canvas navigation,
context menu, keyboard coverage.

Every claim about this repo is cited to `file:line`. Reference behaviour for
shortcuts is Excalidraw's own `HelpDialog.tsx`; multi-element resize semantics
were checked against `packages/element/src/resizeElements.ts`.

Files read in full: `crates/xd-core/src/{scene,geometry,ops,command}.rs`,
`crates/xd-core/src/doc.rs` (group/ungroup/reorder/index regions),
`crates/xd-wasm/src/lib.rs`, `ui/src/{excalidrawEdit,excalidrawTools,xdWasm}.js`,
`ui/src/excalidrawView.js` (chrome), `ui/src/excalidrawDoc.js` (clipboard),
`ui/standalone/menu.js`, plus `crates/xd-core/tests/{geometry,history}.rs` and
`ui/test/contract.test.js` test inventories.

---

## 1. Feature matrix

| Feature | Excalidraw (React) | This repo | Status | Evidence |
| --- | --- | --- | --- | --- |
| **Selection** | | | | |
| Click to select topmost | topmost non-deleted under point | same | PRESENT | `crates/xd-core/src/geometry.rs:479-486`; `ui/src/excalidrawEdit.js:679` |
| Shift-click add/remove | toggles membership | toggles | PRESENT | `crates/xd-wasm/src/lib.rs:257-265`; `ui/src/excalidrawEdit.js:678` |
| Rubber-band marquee | brush (intersect) | intersect; `contain` mode exists but never used | PRESENT | `crates/xd-core/src/geometry.rs:495-509`; `ui/src/excalidrawEdit.js:762` |
| Shift-marquee extends | union with prior selection | union | PRESENT | `ui/src/excalidrawEdit.js:684,763` |
| Click-inside-multiselection narrows to one | yes | yes, on pointerup when not dragged | PRESENT | `ui/src/excalidrawEdit.js:814-823` |
| Select all (⌘A) | excludes locked | includes locked (no lock exists) | PRESENT | `crates/xd-wasm/src/lib.rs:268-276` |
| Click a group member selects whole group | yes — `groupIds` drives selection | selects the one element only; `groupIds` is never read | **BROKEN** | `ui/src/excalidrawEdit.js:679`; only writers exist: `crates/xd-core/src/doc.rs:757,774` |
| Deep-select inside group (⌘-click / dbl-click) | yes | no | MISSING | `ui/src/excalidrawEdit.js:858-871` (dbl-click only handles text) |
| Select element *under* another | ⌘-click; click-through unfilled shapes | click-through unfilled works; no cycling | PARTIAL | `crates/xd-core/src/geometry.rs:369-397` |
| Hit-test: transparent fill = outline only | yes | yes, ported | PRESENT | `crates/xd-core/src/geometry.rs:292-297,369-397`; tests `crates/xd-core/tests/geometry.rs:211-235` |
| Hit-test: ellipse/diamond real outline | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:407-441`; tests `crates/xd-core/tests/geometry.rs:236-258` |
| Hit-test respects `angle` | yes | yes, via `to_local` | PRESENT | `crates/xd-core/src/geometry.rs:280-288`; test `crates/xd-core/tests/geometry.rs:318` |
| Stroke slop scales with `strokeWidth` | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:303-306`; test `crates/xd-core/tests/geometry.rs:229` |
| Frame hit only on its border | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:393`; test `crates/xd-core/tests/geometry.rs:308` |
| `isDeleted` elements unselectable | and unpainted | unselectable but **still painted** by the editor | BROKEN | skipped in hit/marquee: `crates/xd-core/src/geometry.rs:483,499`; paint has no guard: `ui/src/excalidrawEdit.js:276` → `ui/src/excalidrawView.js:277` |
| **Groups** | | | | |
| ⌘G / ⌘⇧G write `groupIds` | append/pop, innermost-first | append/pop, innermost-first | PRESENT | `crates/xd-core/src/doc.rs:753-785`; `crates/xd-wasm/src/lib.rs:536-542`; `ui/src/excalidrawTools.js:255`; test `crates/xd-core/tests/history.rs:649` |
| `groupIds` on the element model | yes | yes, round-trips losslessly | PRESENT | `crates/xd-core/src/scene.rs:304` |
| Group behaves as a selection unit | yes | **no** — nothing reads `groupIds` | MISSING | grep across `crates/*/src` + `ui/src`: writers only (`crates/xd-core/src/doc.rs:757,774`) |
| Nested groups | yes | storable, no semantics | PARTIAL | `crates/xd-core/src/command.rs:104-111` |
| Group bounding box / group-level chrome | yes | no | MISSING | `ui/src/excalidrawEdit.js:322-348` |
| Editing within a group | yes (editingGroupId) | no such state | MISSING | `crates/xd-wasm/src/lib.rs:85-93` (no group state on `XdDoc`) |
| Duplicate/paste regenerates group ids | yes | **no** — the copy joins the original's group | BROKEN | `crates/xd-core/src/ops.rs:170-186`; `ui/src/excalidrawDoc.js:215` (`DROPPED` omits `groupIds`) |
| **Transform handles** | | | | |
| 8 resize + 1 rotate handle | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:583-600,662-687` |
| Handles rotate with the selection | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:678-684`; test `crates/xd-core/tests/geometry.rs:396` |
| Rotate handle a fixed *screen* distance above the box | yes | yes — 20px on both sides of the boundary | PRESENT | `crates/xd-core/src/geometry.rs:511-524`; `ui/src/excalidrawView.js:499`; tests `crates/xd-core/tests/geometry.rs:421,448` |
| Handle hit areas; rotate wins an overlap | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:695-720`; test `crates/xd-core/tests/geometry.rs:414` |
| Resize in the element's own frame (no shear on a rotated shape) | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:556-576,734-824`; tests `crates/xd-core/tests/geometry.rs:480,527,609` |
| Shift = lock aspect ratio | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:783-800`; `ui/src/excalidrawEdit.js:753`; tests `crates/xd-core/tests/geometry.rs:588,595` |
| Alt = resize from centre | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:837-855`; test `crates/xd-core/tests/geometry.rs:581` |
| Multi-element resize behaves as one object | yes; aspect **free** by default | same (aspect free, each element keeps its own angle) | PRESENT | `crates/xd-core/src/ops.rs:77-129` |
| Drag past the anchor flips and normalises | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:730-732`; test `crates/xd-core/tests/geometry.rs:572` |
| Rotation snapping (Shift = 15°) | yes | yes | PRESENT | `crates/xd-core/src/geometry.rs:872-879`; `ui/src/excalidrawTools.js:66`; `ui/src/excalidrawEdit.js:757` |
| Rotate a **multi**-selection | Excalidraw hides the rotate handle entirely | handle is drawn *and* the maths accumulates the absolute bearing every frame | **BROKEN** | `crates/xd-core/src/ops.rs:146-157`; handle not filtered: `ui/src/excalidrawEdit.js:348` vs `ui/src/excalidrawView.js:629` (`only` supported, never passed) |
| Per-point / endpoint handles on linear elements | yes — drag an arrow's endpoints and midpoints; dbl-click enters the line editor | **no** — the `Handle` enum is 8 box handles + rotate, nothing per-point | MISSING | `crates/xd-core/src/geometry.rs:583-631` (enum + discriminants, box-only); `crates/xd-core/src/geometry.rs:662-687` (`handle_points` returns exactly 9 box positions); dbl-click does not enter a line editor: `ui/src/excalidrawEdit.js:858-871`. *This is the reason arrow endpoints cannot be dragged (finding corroborated by the bindings audit).* `ops::rebind_end` (`crates/xd-core/src/ops.rs:316`) and `XdDoc::rebindEnd` (`crates/xd-wasm/src/lib.rs:571`) already exist to re-bind an endpoint once something can move one. |
| **Flip** | | | | |
| Flip horizontal ⇧H / vertical ⇧V | yes | absent everywhere | MISSING | no match for flip-as-a-verb in `crates/*/src` or `ui/src` (only `geometry.rs:730,785` describing a resize past its anchor) |
| **Z-order** | | | | |
| Bring forward / send backward / to front / to back | yes | yes, block-preserving, no overtaking within the selection | PRESENT | `crates/xd-core/src/doc.rs:817-930`; `crates/xd-wasm/src/lib.rs:526-534`; tests `crates/xd-core/tests/history.rs:359,375,520,553` |
| Fractional `index` rewritten on reorder | yes | yes, and only for what actually moved | PRESENT | `crates/xd-core/src/doc.rs:889-929`, `crates/xd-core/src/doc.rs:1179-1466`; tests `crates/xd-core/tests/history.rs:431-646` |
| Shortcut spelling | ⌘[ / ⌘] ; ⌘⌥[ / ⌘⌥] on macOS, ⌘⇧[ / ⌘⇧] elsewhere | ⌘[ / ⌘] ; ⌘⇧[ / ⌘⇧] — the macOS ⌥ form is dead | PARTIAL | `ui/src/excalidrawTools.js:256-257` |
| Z-order controls in a panel or menu | yes | none — keyboard only | MISSING | `ui/src/excalidrawProps.js`, `ui/src/excalidrawToolbar.js` (no reorder entries); `ui/src/excalidrawEdit.js:391-420` (`publish` contributes only zoom/undo/redo/save) |
| **Move** | | | | |
| Drag with a 3px screen threshold | yes | yes | PRESENT | `ui/src/excalidrawTools.js:57`; `ui/src/excalidrawEdit.js:741-746` |
| Arrow-key nudge, coarse step with Shift | 1px; coarse step tied to grid size | 1 / 10 | PRESENT | `ui/src/excalidrawTools.js:69-70,267-271` |
| A burst of arrow keys is one undo entry | yes | yes | PRESENT | `ui/src/excalidrawEdit.js:911-916` |
| Object snapping + alignment guides (⌥S) | yes | painter exists and is tested; **nothing computes guides** | MISSING | `ui/src/excalidrawView.js:692-733` — `drawSnapGuides` is called only from `ui/test/excalidrawChrome.test.js:172-228` |
| Grid + grid snap (⌘') | yes | no grid at all; `gridSize` only ever written as `null` | MISSING | `crates/xd-core/src/format.rs:77`; `ui/src/excalidrawDoc.js:28` |
| **Duplicate / clipboard** | | | | |
| ⌘D duplicate, offset +10/+10 | yes | yes; fresh id and seed per copy | PRESENT | `crates/xd-core/src/ops.rs:164-189`; `crates/xd-wasm/src/lib.rs:516-523`; `ui/src/excalidrawEdit.js:921-925`; test `ui/test/contract.test.js:984` |
| Alt-drag duplicate | yes | no | MISSING | `ui/src/excalidrawEdit.js:736-747` (no alt branch in the `move` gesture) |
| Copy / cut / paste through clipboard *events* | yes | yes, using Excalidraw's own payload marker | PRESENT | `ui/src/excalidrawEdit.js:990-1019`; `ui/src/excalidrawDoc.js:206-262`; test `ui/test/contract.test.js:1003` |
| Paste **at cursor** | yes | pastes at the copied coordinates +10 | PARTIAL | `ui/src/excalidrawEdit.js:1021-1041` |
| Paste plain text as a text element | yes | yes, at viewport centre | PRESENT | `ui/src/excalidrawEdit.js:1043-1060` |
| Paste styles ⌘⌥V | yes | no — `stylePatch` exists but is not wired to a paste | MISSING | `ui/src/excalidrawTools.js:248-261` (⌘⌥V falls through to `null`); `ui/src/excalidrawDoc.js:195-202` |
| Delete / Backspace | yes | yes | PRESENT | `ui/src/excalidrawEdit.js:907-910`; `crates/xd-wasm/src/lib.rs:510-513` |
| Delete semantics in the file | sets `isDeleted: true`, keeps the element | removes it from the array | PARTIAL (collab-relevant) | `crates/xd-core/src/doc.rs:726-740` |
| Delete unhooks references (bindings) | yes | yes, both halves | PRESENT | `crates/xd-core/src/doc.rs:1040`; tests `crates/xd-core/tests/history.rs:759,782` |
| **Lock / link** | | | | |
| Lock element ⌘⇧L | yes | no. `locked` is modelled and written `false`, never read. Q is the *tool* lock, unrelated | MISSING | `crates/xd-core/src/scene.rs:347`; `crates/xd-core/src/doc.rs:1152`; tool lock: `ui/src/excalidrawTools.js:85,102,111` |
| Locked elements skip hit-test / marquee / select-all | yes | no filter anywhere | MISSING | `crates/xd-core/src/geometry.rs:479-509`; `crates/xd-wasm/src/lib.rs:268-276` |
| Element `link` | yes, clickable, shown in chrome | modelled, inert by design | MISSING | `crates/xd-core/src/scene.rs:340-345` (the field's own doc says "Inert here") |
| Hide/show element | not an Excalidraw feature | n/a | — | — |
| **Align & distribute** | | | | |
| Align left/centre/right/top/middle/bottom (⌘⇧←↑→↓) | yes | absent everywhere | MISSING | no match in `crates/*/src` or `ui/src` |
| Distribute horizontally / vertically | yes (panel) | absent | MISSING | same |
| **Undo / redo** | | | | |
| Command-inverse history over every mutation | yes | yes, and no caller can poke a field | PRESENT | `crates/xd-core/src/command.rs:1-19`; `crates/xd-core/src/doc.rs:401-555` |
| Gesture coalescing into one entry (800ms) | yes | yes | PRESENT | `crates/xd-core/src/doc.rs:413-459`; tests `crates/xd-core/tests/history.rs:803-906` |
| Redo branch forfeited on a new edit | yes | yes | PRESENT | test `crates/xd-core/tests/history.rs:908` |
| Non-mutating actions excluded from history | yes | yes (`no_change`, empty batch, no-op reorder) | PRESENT | tests `crates/xd-core/tests/history.rs:206,226,249,388` |
| Undo restores the **selection** | yes — the entry carries `selectedElementIds` | no — dangling ids are pruned, nothing is restored | PARTIAL | `crates/xd-wasm/src/lib.rs:599-630` (`prune_selection`); selection emptied at delete time: `crates/xd-wasm/src/lib.rs:511` |
| Version / nonce / `updated` bookkeeping restored by undo | yes | yes, fuzz-verified | PRESENT | tests `crates/xd-core/tests/history.rs:1076,1137,1151,1180` |
| **Frames** | | | | |
| `frame` element type | yes | parsed, painted, border-only hit test | PARTIAL | `crates/xd-core/src/scene.rs:168`; `ui/src/excalidrawView.js:442`; `crates/xd-core/src/geometry.rs:393` |
| Frame tool (F) | yes | not in the tool list (`kind_of` would accept it) | MISSING | `ui/src/excalidrawTools.js:36-46`; `crates/xd-wasm/src/lib.rs:670` |
| `frameId` membership: children move with the frame, auto-capture on drop | yes | never assigned, never read | MISSING | `crates/xd-core/src/scene.rs:306`; `crates/xd-core/src/doc.rs:1148` |
| **Canvas navigation** | | | | |
| Space-drag / middle-drag / hand tool pan | yes | yes | PRESENT | `ui/src/excalidrawTools.js:155-157`; `ui/src/excalidrawEdit.js:728-734,879-886` |
| Trackpad two-finger scroll | yes | yes | PRESENT | `ui/src/excalidrawTools.js:288-293`; `ui/src/excalidrawEdit.js:852-855` |
| Ctrl+wheel / trackpad pinch zoom, anchored at the pointer | yes | yes | PRESENT | `ui/src/excalidrawTools.js:289-291`; `ui/src/excalidrawEdit.js:843-851,372-380` |
| Touch pinch (two simultaneous pointers) | yes | no multi-touch handling | MISSING | `ui/src/excalidrawEdit.js:1290-1305` (pointerdown/move/up/cancel only) |
| ⌘+ / ⌘− zoom | yes | yes | PRESENT | `ui/src/excalidrawTools.js:259-260` |
| ⌘0 = reset zoom to 100% | yes | **⌘0 fits to view instead**; 1:1 is a menu item with no key | BROKEN | `ui/src/excalidrawTools.js:258` → `ui/src/excalidrawEdit.js:942-944,360-368`; unbound 1:1 at `ui/src/excalidrawEdit.js:401` |
| Zoom to fit ⇧1 | yes | missing (the `shift` guard returns null first) | MISSING | `ui/src/excalidrawTools.js:276` |
| Zoom to selection ⇧2 | yes | missing | MISSING | same |
| Scroll back to content | yes | no | MISSING | no match in `ui/src` |
| PgUp/PgDn page scroll | yes | no | MISSING | `ui/src/excalidrawTools.js:241-280` |
| Zoom clamped to a sane range | yes | yes, 5%–800% | PRESENT | `ui/src/excalidrawEdit.js:81-82,373` |
| **Context menu** | | | | |
| Right-click menu and its actions | large menu: cut/copy/paste, paste styles, z-order, group, flip, lock, link, delete | **none.** Right button returns `null` "for the context menu", and no `contextmenu` listener exists anywhere; no Tauri menu either | MISSING | `ui/src/excalidrawTools.js:156`; grep `contextmenu` across `ui/` and `src-tauri/`: no match |
| **Keyboard generally** | | | | |
| Tool letters + digits, Q lock, Escape | yes | yes for 8 tools + hand; missing image (9), eraser (E/0), frame (F), laser (K), bucket (B), eyedropper (I) | PARTIAL | `ui/src/excalidrawTools.js:36-46,277-279` |
| ⌘S save, ⌘Z / ⌘⇧Z / ⌘Y | yes (⌘S is app-level in Excalidraw) | yes | PRESENT | `ui/src/excalidrawTools.js:252-254` |
| Unclaimed keys reach the browser | yes | yes, deliberate | PRESENT | `ui/src/excalidrawTools.js:217-222`; `ui/src/excalidrawEdit.js:887-889` |

---

## 2. The cheap wins

### 2a. Implemented in `xd-core` but **not exposed** through `xd-wasm`

1. **`Command::Insert { at: Some(index) }`** — z-order-aware insert. `XdDoc::insert`
   hard-codes `at: None` (`crates/xd-wasm/src/lib.rs:487`), so "paste in place",
   "paste behind" and any insert-below-a-given-element is unreachable from JS.
   `Doc::run` already keys the fractional index from wherever the element actually
   lands (`crates/xd-core/src/doc.rs:704-724`), so this is a signature change and
   nothing more.
2. **`ops::selection_bounds(doc, ids)`** (`crates/xd-core/src/ops.rs:38-49`) — the
   *containment* box for a set of ids, deliberately distinct from
   `selection_frame`. Unexposed. It is exactly what "zoom to selection" (⇧2) and
   "scroll back to content" both need.
3. **`Command::Patch` is a fully general escape hatch and it is already exposed**
   (`crates/xd-wasm/src/lib.rs:494-499`, forwarded at `ui/src/xdWasm.js:158`).
   Because `Patch` applies camelCase keys to the element's JSON form
   (`crates/xd-core/src/command.rs:83-98`), `locked`, `link`, `groupIds`,
   `frameId` and flipped geometry can **all** be written from JS today with zero
   Rust changes. This is the single most useful fact in this audit: the missing
   manipulation features are missing in the UI layer, not in the model.
4. **`doc::index_between` / `doc::indices_between`**
   (`crates/xd-core/src/doc.rs:1387,1443`) — public and well tested
   (`crates/xd-core/tests/history.rs:431-518`), reachable from JS only indirectly
   through `reorder`. Anything that wants to place an element at a chosen depth
   needs them.
5. `geometry::hit_test` (single element), `to_local`, `rotate_point`, `union_all`,
   `element_center` — primitives, correctly kept internal.

### 2b. Exposed through `xd-wasm` but **not wired** in the UI

1. **`handlePoints(scenePerPx)`** — `crates/xd-wasm/src/lib.rs:300`, forwarded at
   `ui/src/xdWasm.js:140-146`, and **called by nothing** (only
   `ui/test/contract.test.js:176` stubs it). The painter recomputes all nine
   positions itself in `handlePositions` (`ui/src/excalidrawView.js:600-620`).
   They agree today only because both hard-code 20px
   (`crates/xd-core/src/geometry.rs:524` vs `ui/src/excalidrawView.js:499`) —
   which is precisely the duplication `ui/src/excalidrawEdit.js:49-55` claims to
   have eliminated. Switching `drawHandles` to consume `doc.handlePoints()`
   removes the second source of truth for free.
2. **`marquee(..., contain = true)`** — plumbed all the way through
   (`crates/xd-wasm/src/lib.rs:212`, `ui/src/xdWasm.js:124`) but
   `ui/src/excalidrawEdit.js:762` always passes `false`. Enclose-only marquee is
   one boolean.
3. **`drawHandles(…, { only })`** — `ui/src/excalidrawView.js:629` supports
   narrowing the handle set, and its own doc comment says "a multi-selection
   hides the rotate handle in Excalidraw" — but `ui/src/excalidrawEdit.js:348`
   never passes it. Passing `only` for multi-selections is the **one-line
   mitigation** for the rotate bug in §3.2.
4. **`drawSnapGuides`** (`ui/src/excalidrawView.js:701-733`) — a complete, tested
   guide painter with no producer at all. Only
   `ui/test/excalidrawChrome.test.js:172-228` calls it.
5. **`group()` / `ungroup()` / `reorder(how)`** — reachable only from ⌘G / ⌘⇧G /
   ⌘[ / ⌘] (`ui/src/excalidrawTools.js:255-257`). No toolbar button, no props-panel
   row, no menu entry (`publish` at `ui/src/excalidrawEdit.js:391-420` contributes
   only zoom, undo, redo and save), and no context menu. **A mouse-only user
   cannot group or change z-order at all.**
6. **`patch(id, fields)`** — wired only for the text overlay's measured box
   (`ui/src/excalidrawEdit.js:1191-1216`). See 2a.3: this is the lever for lock,
   link and flip.
7. **`selectionAngle()`** — used for chrome (`ui/src/excalidrawEdit.js:326`) but
   note it returns 0 for any multi-selection by design
   (`crates/xd-wasm/src/lib.rs:242-245`), which is what makes the multi rotate
   handle meaningless as well as broken.

---

## 3. MISSING / BROKEN, ranked by user impact

### 3.1 Groups are write-only — `groupIds` is set and never read (BROKEN)

`Command::Group` correctly appends a shared id innermost-last
(`crates/xd-core/src/doc.rs:753-770`) and the field round-trips
(`crates/xd-core/src/scene.rs:304`), but **nothing in the editor or the wasm layer
ever reads `group_ids`** — a grep across `crates/*/src` and `ui/src` finds writers
only (`crates/xd-core/src/doc.rs:757,774`).

Consequences, all user-visible:
- Clicking one member selects one element (`ui/src/excalidrawEdit.js:679`).
- A marquee that catches part of a group selects part of it
  (`ui/src/excalidrawEdit.js:762-763`).
- Dragging a member tears the group apart.
- `duplicate` clones the ids, so the copy **joins** the original group
  (`crates/xd-core/src/ops.rs:170-186`) — ⌘G then ⌘D yields four elements in one
  group. Paste has the same hole: `groupIds` is absent from `DROPPED`
  (`ui/src/excalidrawDoc.js:215`). Both are visibly wrong the moment the file
  opens on excalidraw.com.

The contract test only asserts that the ids are written and shared
(`ui/test/contract.test.js:984-1001`), never that selection honours them.

**Root cause.** The selection is a flat `Vec<String>` on `XdDoc`
(`crates/xd-wasm/src/lib.rs:85-93`) with no group-expansion step and no
"editing group" state.

**Sketch.** Add `fn expand_groups(&self, ids: Vec<String>) -> Vec<String>` in
`xd-wasm`: for each id with a non-empty `group_ids`, take the **last** entry (the
outermost group — `crates/xd-core/src/command.rs:108-110` documents the ordering)
and pull in every element sharing it; iterate to a fixed point for nested groups.
Call it from `set_selection`, `toggle_selection` and after `marquee`. Add
`editing_group: Option<String>` to `XdDoc`, set by a new `deepSelect(index)` bound
to ⌘-click and double-click, and skip expansion while it is `Some`. Separately, in
`ops::duplicate` (`crates/xd-core/src/ops.rs:170`) remap `copy.group_ids` through a
per-call `HashMap<old, new>` so a duplicated group becomes a *new* group; and add
`groupIds` to `DROPPED` (or remap it in `pasteElements`,
`ui/src/excalidrawEdit.js:1021`).

### 3.2 Rotating a multi-selection accumulates the absolute angle every frame (BROKEN)

`ops::rotate` (`crates/xd-core/src/ops.rs:132-160`) computes `angle` as the
**absolute** bearing from the selection centre to the pointer
(`geometry::rotation_angle`, `crates/xd-core/src/geometry.rs:872-879`). The
single-element branch assigns it absolutely
(`crates/xd-core/src/ops.rs:142-144`) — correct. The multi-element branch treats
the same value as a **delta**:

```rust
let (rx, ry) = geometry::rotate_point(ex, ey, cx, cy, angle);   // ops.rs:149
...
("angle", json!(norm(e.angle + angle))),                        // ops.rs:155
```

`rotateTo` is called on every `pointermove` under one coalesce key
(`ui/src/excalidrawEdit.js:756-758`), so the total rotation applied is the *sum* of
every sample's absolute bearing. The pivot drifts too, because `selection_bounds`
is recomputed from the already-rotated positions on each call
(`crates/xd-core/src/ops.rs:133`). Select two elements, drag the rotate handle:
the selection spins away from the pointer.

It is reachable because the rotate handle *is* drawn on multi-selections —
`ui/src/excalidrawEdit.js:348` never passes `only`, and `handle_at` happily
returns `Handle::Rotate` for any frame
(`crates/xd-core/src/geometry.rs:695-720`). Excalidraw hides the handle for
multi-selections; this repo's own painter knows that
(`ui/src/excalidrawView.js:629`) and the crate's own comment says as much
(`crates/xd-core/src/geometry.rs:566-568`).

**`ops::resize` and `ops::rotate` have no test at all.**
`crates/xd-core/tests/` covers only the geometry primitives; `ops` appears in the
test tree solely as `ops::translate` in `crates/xd-core/tests/binding.rs:61,110`,
and the UI contract test stubs both transforms
(`ui/test/contract.test.js:186-187`).

**Sketch.** Make the gesture stateful, the way the draft already is. Add
`rotate_from: Option<(Bounds, f64)>` to `XdDoc`, captured on the first `rotateTo`
of a given coalesce key (the frame's bounds and the starting bearing); pass
`delta = angle - start` and the **frozen** pivot into `ops::rotate`; clear it when
the key changes or the gesture ends. Immediate mitigation, one line: pass
`only: ["nw","n","ne","e","se","s","sw","w"]` from
`ui/src/excalidrawEdit.js:348` when `selection.length > 1`, matching Excalidraw.
Then add the ops-level tests that should have caught this.

### 3.3 Linear elements have no per-point handles, so arrow endpoints cannot be dragged (MISSING)

The `Handle` enum is eight box handles plus rotate and nothing else
(`crates/xd-core/src/geometry.rs:583-631`), and `handle_points` returns exactly
nine box-derived positions (`crates/xd-core/src/geometry.rs:662-687`). There is no
representation for "the *n*th point of this line", so a selected arrow offers only
a bounding-box resize — you cannot move an endpoint, cannot move a midpoint, and
double-click does not enter a line editor
(`ui/src/excalidrawEdit.js:858-871` handles only text). This is the root cause of
the bindings audit's finding that arrow endpoints are undraggable.

What already exists on the other side of that gap: `ops::rebind_end`
(`crates/xd-core/src/ops.rs:316-345`), `XdDoc::rebindEnd`
(`crates/xd-wasm/src/lib.rs:571`), `bindableAt`
(`crates/xd-wasm/src/lib.rs:562`) and the binding highlight
(`ui/src/excalidrawEdit.js:308-316`) are all in place and tested
(`crates/xd-core/tests/binding.rs`). Everything needed to *finish* an endpoint
drag is built; only the handle that starts one is absent.

**Sketch.** Widen the handle space rather than the enum: keep discriminants 0–8
(they are a documented part of the WASM boundary,
`crates/xd-core/src/geometry.rs:601-604`) and define `9 + i` as "point *i*". Add
`geometry::point_handles(e, scene_per_px) -> Vec<(f64, f64)>` returning the
absolute positions of `e.points` for a single selected linear element, have
`handle_at` check those first (they sit inside the box, so they must win over the
box handles), and add `XdDoc::movePoint(i, x, y, key)` that patches `points` —
re-normalising `x`/`y`/`width`/`height` the way `reflow_one` already does
(`crates/xd-core/src/ops.rs:292-308`) — followed by `rebind_end` when `i` is the
first or last point. In the UI, `pointerIntent` gains a `{ kind: "point", index }`
branch and `drawHandles` a small-circle variant.

### 3.4 There is no context menu at all (MISSING)

`pointerIntent` returns `null` for the right button, explicitly deferring to "the
context menu" (`ui/src/excalidrawTools.js:156`), but no `contextmenu` listener
exists in `ui/` and no menu is registered in `src-tauri/`. Combined with the
absence of z-order, group, duplicate and delete controls in the props panel
(`ui/src/excalidrawProps.js`) and toolbar (`ui/src/excalidrawToolbar.js` — its only
button is the *tool* lock, `ui/src/excalidrawToolbar.js:182-190`), **every
document-manipulation verb in this editor is keyboard-only.** In Excalidraw the
right-click menu is where cut/copy/paste, paste styles, z-order, group/ungroup,
flip, lock and link all live, and it is how most users reach them.

**Sketch.** A `contextmenu` listener on `wrap` (added to the listener table at
`ui/src/excalidrawEdit.js:1290-1305`) that hit-tests under the pointer, selects
that element if the current selection does not already contain it, and renders a
popover built from the **same descriptor shape** `ui/standalone/menu.js:126`
already consumes (`{ name, shortcut, run, disabled }`) — so the popover module is
reused rather than rewritten, and `ui/src/excalidrawEdit.js:391-420` becomes the
one place that lists the verbs. Every entry is an existing `doc.*` call except
flip, lock and align.

### 3.5 Flip, align and distribute are absent (MISSING)

No match for any of the three as a verb in `crates/*/src` or `ui/src`. In
Excalidraw these are ⇧H/⇧V, ⌘⇧arrows, and a whole panel section.

**Sketch.** All three are pure `Command::Batch(Patch…)` and belong in `ops.rs`
beside `resize`, mirroring its structure exactly (compute a frame, derive a
transform, emit one patch per element):

- `flip(doc, ids, horizontal)` — reflect each element's centre across the
  selection frame's axis; negate the relevant component of every entry in
  `points`; keep `pressures` aligned with the reordered points for freedraw;
  negate `angle` (Excalidraw's `flipFactor` handling in `resizeElements.ts`);
  leave `width`/`height` positive.
- `align(doc, ids, edge)` — take `ops::selection_bounds`
  (`crates/xd-core/src/ops.rs:38`) and translate each element's own *rotated* box
  (`geometry::element_bounds_rotated`) to the target edge or centre. Rotated boxes,
  not raw `x`/`y`, or a turned shape aligns by a corner that isn't its visual edge.
- `distribute(doc, ids, axis)` — sort by rotated-box centre, equalise the gaps
  between consecutive boxes, leave the two extremes fixed.

Then three `#[wasm_bindgen]` methods, three `ui/src/xdWasm.js` forwards, keys in
`keyIntent` (⇧H/⇧V require narrowing the blanket `if (shift || ev?.altKey) return
null` guard at `ui/src/excalidrawTools.js:276`), and rows in the props panel and
the new context menu. Six functions, no new machinery.

### 3.6 ⌘0 fits instead of resetting to 100%, and ⇧1/⇧2 are missing (BROKEN + MISSING)

`keyIntent` maps ⌘0 to `zoomReset` (`ui/src/excalidrawTools.js:258`) and
`ui/src/excalidrawEdit.js:942-944` runs `fit()`
(`ui/src/excalidrawEdit.js:360-368`). Excalidraw's ⌘0 is *reset zoom to 100%*; fit
is ⇧1 and zoom-to-selection is ⇧2. Actual size exists here only as an unbound
menu item (`ui/src/excalidrawEdit.js:401`). This is exactly the
"a nearly-right keyboard is worse than an unfamiliar one, because the mistakes are
silent" failure `ui/src/excalidrawTools.js:23-26` sets out to avoid.

**Sketch.** ⌘0 → `zoomAt(1 / camera.scale, ...centre())`. Add
`{ kind: "zoomFit" }` on ⇧1 and `{ kind: "zoomSelection" }` on ⇧2, placed *ahead*
of the shift guard at `ui/src/excalidrawTools.js:276`. ⇧2 needs
`ops::selection_bounds` exposed (cheap win 2a.2) plus a `fitTransform`-shaped call
over that box rather than over `scene_bounds`.

### 3.7 Element lock is unimplemented, and unlocks other people's files (MISSING)

`locked` is modelled (`crates/xd-core/src/scene.rs:347`) and written as `false` on
every new element (`crates/xd-core/src/doc.rs:1152`), but there is no lock
operation, no shortcut, and — the part that matters — **`hit_test_scene`
(`crates/xd-core/src/geometry.rs:479-486`), `marquee_hits`
(`crates/xd-core/src/geometry.rs:495-509`) and `select_all`
(`crates/xd-wasm/src/lib.rs:268-276`) do not filter on it.** A file authored in
Excalidraw with locked elements opens here with those elements freely selectable,
draggable and deletable, silently defeating the thing the author locked them for.
(The `locked` in `ui/src/excalidrawTools.js:85` and the toolbar button at
`ui/src/excalidrawToolbar.js:182` are the *tool* lock — Q — and are unrelated.)

**Sketch.** The correctness half is three lines: filter `e.locked != Some(true)`
in `hit_test_scene`, `marquee_hits` and `select_all`. Then
`XdDoc::setLocked(bool)` as a `Batch` of `Patch { locked }` over the selection,
⌘⇧L in `keyIntent`, a context-menu entry, and a distinct outline for a locked
selection in `paintChrome` (`ui/src/excalidrawEdit.js:302-349`).

### 3.8 No object snapping or grid, despite a finished, tested guide painter (MISSING)

`drawSnapGuides` (`ui/src/excalidrawView.js:692-733`) is complete — dashed lines,
end ticks, theme-aware — and covered by six assertions
(`ui/test/excalidrawChrome.test.js:172-228`), with **no producer**. `gridSize` is
only ever written as `null` (`crates/xd-core/src/format.rs:77`;
`ui/src/excalidrawDoc.js:28`), so there is no grid to snap to either.

**Sketch.** `geometry::snap_candidates(elements, moving_ids, frame,
threshold_px) -> (dx, dy, Vec<Guide>)`: compare the dragged frame's three x-lines
(left/centre/right) and three y-lines (top/middle/bottom) against every other
element's rotated box; nearest within threshold wins per axis. Apply the offset
inside `ops::translate` behind a flag, and return the guides through a new
`XdDoc::snapGuides()` accessor for `paintChrome` to draw. Grid snap is then a
one-line quantise of `dx`/`dy` at the same site, and ⌘' / ⌥S toggle the two.

### 3.9 Frames are decoration only (MISSING)

`frame` parses (`crates/xd-core/src/scene.rs:168`), paints
(`ui/src/excalidrawView.js:442`), hit-tests on its border only
(`crates/xd-core/src/geometry.rs:393`, test
`crates/xd-core/tests/geometry.rs:308`) and is excluded from arrow binding
(`crates/xd-core/src/binding.rs:66`) — all correct. But there is no frame tool
(`ui/src/excalidrawTools.js:36-46`; `kind_of` would accept one,
`crates/xd-wasm/src/lib.rs:670`), and `frame_id` is written `None`
(`crates/xd-core/src/doc.rs:1148`) and never read. Dragging a frame leaves its
children behind; dropping a shape into a frame does not capture it; deleting a
frame does not take its contents.

**Sketch.** Add the tool entry (key `F`); on draft-end and drag-end, assign
`frameId` for elements whose rotated bounds sit inside a frame's box and clear it
for those that left; make `ops::translate` and `Command::Delete` expand a frame id
to its members. This is the largest missing item here and is reasonably deferred
behind §3.1–§3.5.

### 3.10 Undo does not restore the selection (PARTIAL)

`delete_selection` empties the selection before applying the command
(`crates/xd-wasm/src/lib.rs:511`), and `undo`/`redo` only prune ids that no longer
resolve (`crates/xd-wasm/src/lib.rs:599-630`). So undoing a delete brings the
shapes back **unselected**, where Excalidraw re-selects them — a difference felt
on every accidental delete, because the natural next action (move it back, retype,
restyle) needs the selection.

**Sketch.** Carry the selection with each history entry. `Doc` already stores a
`Vec<Edit>` per entry (`crates/xd-core/src/doc.rs:431-459`); the least invasive
version keeps a parallel `Vec<Vec<String>>` on `XdDoc` pushed in `apply`/
`apply_keyed` and restored in `undo`/`redo`, which keeps selection out of
`xd-core` as the module header intends (`crates/xd-wasm/src/lib.rs:10-14`).

### 3.11 Smaller items, cheap enough to batch

- **Paste at cursor.** `pasteElements` offsets from each element's stored
  coordinates (`ui/src/excalidrawEdit.js:1026`); it should translate the payload's
  bounding box to the last pointer position, as Excalidraw does. `pasteText`
  already centres in the viewport (`ui/src/excalidrawEdit.js:1044`), so the two
  paste paths currently disagree with each other as well as with Excalidraw.
- **Alt-drag duplicate.** The `"move"` gesture has no alt branch
  (`ui/src/excalidrawEdit.js:736-747`): call `duplicateSelection(0, 0)` on the
  first move past the threshold, then drag the new copies.
- **Paste styles ⌘⌥V.** `stylePatch` (`ui/src/excalidrawDoc.js:195-202`) and
  `setStyle` (`crates/xd-wasm/src/lib.rs:502`) both exist; this needs a stashed
  style on copy and a key that currently falls through to `null`
  (`ui/src/excalidrawTools.js:248-261`).
- **macOS z-order keys.** ⌘⌥[ and ⌘⌥] never match, because `ev.key` is not `"["`
  when Option is held on a Mac (`ui/src/excalidrawTools.js:256-257`). Test
  `ev.code === "BracketLeft"` / `"BracketRight"` instead, and keep the ⇧ forms.
- **`isDeleted` elements are painted but not selectable.** The editor's paint loop
  iterates every element (`ui/src/excalidrawEdit.js:276`) and `drawElement` has no
  guard (`ui/src/excalidrawView.js:277-302`), while hit-test and marquee skip
  deleted ones (`crates/xd-core/src/geometry.rs:483,499`). A file carrying
  tombstones therefore shows shapes that cannot be clicked. The filter already
  exists elsewhere in the codebase (`ui/src/excalidrawScene.js:129`) and just
  needs applying here.
- **Delete removes rather than tombstones** (`crates/xd-core/src/doc.rs:726-740`).
  Defensible for a local editor and it keeps history simple, but Excalidraw's
  reconciliation expects `isDeleted: true` to survive; worth a decision record
  before collaboration is attempted, since `version`/`versionNonce` are being
  maintained specifically for that future
  (`crates/xd-core/src/scene.rs:15-18`).
- **Missing tools**: image (9), eraser (E/0), frame (F), laser (K), bucket (B),
  eyedropper (I) — `ui/src/excalidrawTools.js:36-46`.
- **No touch pinch-zoom.** Only single-pointer events are bound
  (`ui/src/excalidrawEdit.js:1290-1305`); trackpad pinch works because the
  platform delivers it as ctrl+wheel (`ui/src/excalidrawTools.js:288-293`), but a
  touchscreen gets nothing.

---

## 4. Overall shape of the domain

The Rust side is in unusually good condition. The resize/handle/hit-test geometry
is a careful port with real coverage, including five proptests
(`crates/xd-core/tests/geometry.rs:655-745`), and history is the best-tested thing
in the repo — 1204 lines with three fuzz tests over random command streams
(`crates/xd-core/tests/history.rs:1076,1151,1180`). Fractional indexing is
implemented properly, reindexes only what moved, and declines keys it cannot parse
rather than guessing (`crates/xd-core/src/doc.rs:889-929,1179-1466`).

The gaps cluster in exactly two places:

1. **`ops.rs` is untested.** It is the only module in `xd-core` with no test file,
   and it is where the one genuine transform bug lives (§3.2). The UI contract
   test stubs `resizeTo` and `rotateTo` (`ui/test/contract.test.js:186-187`), so
   nothing anywhere exercises them.
2. **The UI exposes almost none of what the model can already do.** There is no
   context menu, no panel button for any manipulation verb, `handlePoints` and
   `drawSnapGuides` are dead, `contain` marquee and `drawHandles({ only })` are
   unreached, and `Command::Patch` — which can write `locked`, `link`, `groupIds`
   and `frameId` today — is used only by the text overlay.

The highest-value single change is §3.1 (make selection group-aware), because
grouping currently *appears* to work and silently produces files that behave
differently on excalidraw.com. The cheapest high-value change is the one-line
mitigation in §3.2 plus the three-line locked filter in §3.7.
