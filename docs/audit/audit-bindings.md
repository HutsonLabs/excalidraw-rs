# ARROWS, LINES & BINDINGS — audit of excalidraw-rs vs. React Excalidraw

Scope: arrows, lines, bindings only. Every claim about this repo carries a `file:line`.
No files in the repo were modified.

---

## Headline finding

**Arrow binding is implemented, exported, wired, and demonstrably works — but only
during the initial draw gesture, and with almost no visible affordance.**

The user's "I can't anchor an arrow to objects" is *not* a broken chain. It is a
**missing gesture**: there are no arrow-endpoint handles anywhere in this editor, so
the Excalidraw motion people actually reach for — select an existing arrow, drag its
endpoint onto a shape — is impossible. And hovering a shape with the arrow tool shows
no highlight until you are already mid-drag, so nothing advertises that binding exists
at all.

Verified by execution, not inferred:

- `cargo test -p xd-core --test binding` — **7/7 pass** (`crates/xd-core/tests/binding.rs:41-131`).
- `bun test ui/test/contract.test.js ui/test/xdWasm.test.js` — **51/51 pass**, including
  `contract.test.js:938` *"an arrow dropped on a shape binds itself"* and
  `xdWasm.test.js:105` *"an arrow drawn between two shapes binds to both and follows them"*.
- Those JS tests load the **vendored** artifact directly (`ui/test/wasmHarness.js:16-18`
  reads `ui/vendor/xd-wasm/xd_wasm_bg.wasm`), so the shipped build genuinely binds. The
  stale-vendor risk implied by commit `c11db8f` ("Ask history whether the vendored WASM is
  current, not the bytes") is **not** the cause of the reported bug.

---

## The binding gesture, traced end to end

The path that **works** (pointerdown → Rust op):

1. `ui/src/excalidrawEdit.js:663` — `pointerIntent(tools, ev, probeAt(x,y))` returns
   `{kind:"draw", shape:"arrow"}` (`ui/src/excalidrawTools.js:181`).
2. `excalidrawEdit.js:688` — `doc.beginDraft("arrow", x, y, styleFor("arrow", style))`
   → `crates/xd-wasm/src/lib.rs:350`.
3. `excalidrawEdit.js:691` — stashes `gesture.draftId` so the arrow cannot bind to itself.
4. `excalidrawEdit.js:769` (pointermove) — `doc.draftTo(x, y, shift)` → `lib.rs:367`,
   which writes **exactly two points**.
5. `excalidrawEdit.js:772` — `bindTarget = doc.bindableAt(x, y, gesture.draftId)`
   → `lib.rs:562` → `xd_core::binding::bindable_at`. Highlight painted at
   `excalidrawEdit.js:305-310`.
6. `excalidrawEdit.js:806` (pointerup) — `doc.endDraft(MIN_DRAW_SIZE)` → `lib.rs:431`,
   which at `lib.rs:453-458` calls `ops::rebind_end` for **both** ends → `ops.rs:311` →
   `Command::Bind` → `reflow_bindings` re-aims the tips to the outline minus `gap`.

### Where it stops

Step 5/6 is the **only** entry into binding in the entire UI. `rebindEnd`, `bind` and
`isBound` are exported (`lib.rs:571`, `:547`, `:580`) and wrapped in
`ui/src/xdWasm.js:166-171`, but a grep across `ui/src/` and `ui/standalone/` finds
**zero** call sites — the only callers are `xdWasm.js` itself and two test files.

Consequences:

- Miss the shape on the first try and there is no recovery but delete-and-redraw.
- A binding, once made, is **permanent**. `reflow_bindings` re-aims arrows whose own id
  is in `ids` (`ops.rs:245`), so dragging the arrow re-snaps its bound end back to the
  shape, and resizing it via a bbox handle is a no-op at that end (`lib.rs:336` reflows
  after `ops::resize`).
- The `focus` captured at draw time can never be adjusted.

The reason no endpoint gesture can exist today: handles come from `ops::selection_frame`'s
**bounding box** only — `handle_points(&f.bounds, f.angle, scene_per_px)` at
`lib.rs:300-304`, nine handles NW…W + Rotate (`geometry.rs:588-631`, mirrored in
`xdWasm.js:19-21`). Nothing in the handle model derives from `element.points`, so
`handleAt` can never report "endpoint 0 of this arrow."

---

## Feature table

| Feature | Excalidraw (React) | This repo | Status | Evidence |
|---|---|---|---|---|
| `focus`/`gap` binding geometry | Stored focus, gap, edge intersection | Full: `bindable_at`, `focus_for`, `binding_point`, bisection outline hit | **PRESENT** | `crates/xd-core/src/binding.rs:41,75,110,141` |
| Two-sided binding (`boundElements` back-ref) | Maintained both ways | `Command::Bind` maintains both halves + inverts for undo | **PRESENT** | `command.rs:121`, `doc.rs:928-1030` |
| Bind on arrow-draw release | Yes | `endDraft` auto-binds both ends | **PRESENT** | `crates/xd-wasm/src/lib.rs:453-458` |
| Re-route bound arrow on shape move/resize/rotate | Yes | `with_reflow` on all three | **PRESENT** | `lib.rs:311,336,342`; `ops.rs:236` |
| Clear bindings when bound shape deleted | Yes | Yes, restored whole on undo | **PRESENT** | `doc.rs:1033-1075` |
| Binding highlight while drawing | Hover **and** drag | Drag only, and `arrow` only | **PARTIAL** | `excalidrawEdit.js:770-772`, `:305-310` |
| **Drag an arrow endpoint to (re)bind** | Core gesture | **No endpoint handles exist**; `rebindEnd` never called by UI | **MISSING** | handles bbox-only: `geometry.rs:588-631`, `lib.rs:300-304`; no call site in `ui/src/` |
| **Unbind by dragging endpoint away** | Yes | Impossible; reflow snaps it back | **MISSING** | `ops.rs:245` re-aims arrows whose own id is in `ids` |
| **Multi-point lines (click-click-click)** | Yes | `draftTo` hard-codes exactly 2 points | **MISSING** | `lib.rs:373` `vec![[0.0,0.0],[x-e.x,y-e.y]]` |
| **Enter → point-edit mode** | Yes | Enter only opens the text overlay | **MISSING** | `excalidrawEdit.js:948-955` |
| Drag / delete individual midpoints | Yes | No point-edit mode at all | **MISSING** | — |
| Double-click to finish a line | Yes | Double-click creates text on empty canvas only | **MISSING** | `excalidrawEdit.js:870` |
| `lastCommittedPoint` | Written during multi-point draw | Always `None`; nothing ever writes it | **MISSING** (preserved on roundtrip) | `doc.rs:1157`; modelled at `scene.rs:393` |
| `roundness` on linear elements | New arrows/lines get `{type:2}` | Never written; `ROUNDABLE` excludes linear | **MISSING** | `excalidrawDoc.js:157,179`; `doc.rs:1121` `_ => None` |
| Curved line rendering | Honours `roundness` | `rc.curve` iff >2 points, ignores `roundness` — and all arrows here are 2-point, so always straight | **MISSING** | `excalidrawView.js:341-343` |
| Elbow arrows (`elbowed`, orthogonal routing) | Toggle + right-angle router | No router, no toggle, no UI; field only ever read back out of `rest` | **MISSING** (roundtrip-safe) | fixtures + `tests/roundtrip.rs:262`; `scene.rs:224` names it as the reason `Binding.rest` exists |
| `fixedPoint` (elbow anchor) | Normalised anchor on bound shape | Never produced, never read; survives via `Binding.rest` | **MISSING** (roundtrip-safe) | `scene.rs:227-236`; preserved per `roundtrip.rs:283` |
| Arrowhead **rendering** | arrow, bar, dot, circle, triangle, diamond, none | arrow, bar, dot, circle, triangle — **`diamond` falls through to the open V** | **PARTIAL** | `excalidrawView.js:361-393`; `triangle` closes+fills at `:389-392`, no diamond case |
| Arrowhead `none` | `null` ⇒ no head | Honoured for explicit `null`; **absent** key defaults to `"arrow"` | **PARTIAL** | `excalidrawView.js:353-354` — `!== null` then `?? "arrow"` |
| Arrowheads only on arrows, not lines | Yes | Yes — correctly gated | **PRESENT** | `excalidrawView.js:349` `element.type === "arrow"` |
| Arrowhead **authoring UI** | Start + end dropdowns | No control; not a style key; not modelled on `Element` | **MISSING** | `excalidrawProps.js:480-512` (9 groups, none arrowhead); `excalidrawDoc.js:107-121`; `scene.rs:386-397` |
| Arrow labels (text with `containerId` → arrow) | Yes, centred on midpoint | Absent — `createText` never sets `containerId` or a `boundElements` entry | **MISSING** | `excalidrawEdit.js:1169-1184`; `container_id` modelled but unused at `scene.rs:369` — **detail handed to the text auditor** |
| Undo/redo of a bind | Yes | Inverts cleanly: `Bind` is three `Patched` records | **PRESENT** | `doc.rs:107-108`, `:928-1030` |
| Undo/redo of bind *via* `endDraft` | One entry | Draft + both `rebind_end` calls `merge`d into one change | **PRESENT** | `lib.rs:453-458` |
| Copy/paste of a bound pair | Remaps ids when both ends copied | Bindings stripped unconditionally | **PARTIAL** | `excalidrawDoc.js:215` `DROPPED` |
| **Lines must not bind** | `isBindingElement` ⇒ arrows only | `is_linear()` = `Line \| Arrow`, so **lines silently gain bindings** | **BROKEN** | `scene.rs:179-181` + `lib.rs:453` |

### Format fidelity — linear elements

| Field | Parsed | Preserved on roundtrip | Authored by this editor | Evidence |
|---|---|---|---|---|
| `points` | Modelled | Yes, JS number spelling kept | Yes — but always exactly 2 | `scene.rs:386-389`; `lib.rs:373` |
| `pressures` | Modelled | Yes | freedraw only | `scene.rs:390` |
| `lastCommittedPoint` | Modelled | Yes | **Never written** (always `None`) | `scene.rs:393`; `doc.rs:1157`; `roundtrip.rs:148` |
| `startBinding` / `endBinding` | Modelled, with own `rest` | Yes, incl. unknown sub-keys | Yes | `scene.rs:395-397`, `:227-236` |
| `startArrowhead` / `endArrowhead` | **Unmodelled** → `rest` | Yes, verbatim | **No** — key omitted entirely | `scene.rs:400-410`; asserted at `roundtrip.rs:288` |
| `elbowed` | **Unmodelled** → `rest` | Yes | No | `roundtrip.rs:262` |
| `fixedPoint` | **Unmodelled** → `Binding.rest` | Yes | No | `roundtrip.rs:283` |
| `boundElements` | Modelled | Yes; absent ≠ `[]` is respected | Yes, by `Command::Bind` | `scene.rs:337`; `doc.rs:985-1025` |

Reading is genuinely lossless — `roundtrip.rs:99` `serializing_is_a_fixed_point` plus the
key-order list at `:529` cover it. **Every gap above is in authoring, not preservation.**

---

## Ranked MISSING / BROKEN — root cause + fix sketch

### 1. Arrow endpoint handles + `rebindEnd` wiring — *the reported bug*

Full sketch in its own section below.

### 2. Hover highlight before pressing

**Absent:** any binding affordance until a drag is already underway — which is why the
feature reads as absent even though it works.

**Root cause:** `bindTarget` is assigned only inside `case "draw"` of `onPointerMove`
(`excalidrawEdit.js:770-772`).

**Fix:** in the no-gesture branch of `onPointerMove` (`excalidrawEdit.js:719-724`), when
`tools.tool === "arrow"` set `bindTarget = doc.bindableAt(x, y, "")` and `schedule()`.
Roughly four lines — the paint path at `:305-310` already exists. Cheapest change with
the largest effect on perceived brokenness.

### 3. Lines must not bind — real correctness break

**Broken:** a `line` drawn across two rectangles silently gains `startBinding` and
`endBinding`.

**Root cause:** the guard in `endDraft` is `e.kind.is_linear()` (`lib.rs:453`), and
`is_linear()` is `matches!(self, ElementKind::Line | ElementKind::Arrow)`
(`scene.rs:179-181`). Excalidraw's `isBindingElement` admits **arrows only**, so:

- the file carries bindings on a `line` that excalidraw.com will not act on — a diagram
  that re-routes here and is inert there;
- dragging a bound shape drags the *line* in this editor and not in Excalidraw
  (`ops.rs:236` `reflow_bindings` filters on `is_linear()` too, so the line reflows);
- `ops::rebind_end` is reachable for lines by any future caller, not just `endDraft`.

**Fix:**
- `crates/xd-wasm/src/lib.rs:453` — narrow the guard from `e.kind.is_linear()` to
  `e.kind == ElementKind::Arrow`.
- `crates/xd-core/src/ops.rs:311` — at the top of `rebind_end`, return
  `(doc.no_change(), false)` unless the element is `ElementKind::Arrow`. Belt and braces:
  the invariant then holds regardless of caller, which matters because `rebind_end` is a
  `pub` API the new endpoint gesture (#1) will also call.
- Leave `is_linear()` itself alone — `reflow_bindings` (`ops.rs:240`), `draftTo`
  (`lib.rs:371`) and `hit_points` (`geometry.rs:445`) all correctly want "geometry is a
  point list", which is what `is_linear`/`has_points` mean. The bug is the *binding*
  predicate borrowing a *geometry* predicate; introducing
  `ElementKind::is_bindable_source()` returning `matches!(self, Arrow)` beside
  `is_linear` at `scene.rs:179` documents the distinction if you prefer it named.
- Tests: `crates/xd-core/tests/binding.rs` — a `line` drawn across two rectangles gains
  no binding, and a pre-existing file that *does* carry a binding on a line still
  roundtrips byte-identically (the parse path must stay permissive; only authoring
  tightens).

### 4. Multi-point lines and arrows

**Absent:** click-click-click; every linear element is exactly two points.

**Root cause:** `draftTo` rebuilds a two-element vec on every move —
`lib.rs:373`, `let pts = vec![[0.0, 0.0], [x - e.x, y - e.y]];`.

**Fix:**
- **New WASM export** `draftCommit(x, y) -> Change` (`lib.rs`, beside `draftPoint` at
  `:395`): append a point to `points` and set `lastCommittedPoint`, keyed into the same
  `"draft"` undo entry.
- Change `draftTo` (`lib.rs:367`) to move only the **trailing** point when
  `points.len() > 2`, instead of rebuilding the pair.
- `ui/src/excalidrawTools.js`: a click with line/arrow active *while a draft is live*
  returns `{kind:"commitPoint"}`; claim `Enter`, `Escape` and double-click as finish.
  The draft-live flag has to reach `pointerIntent` via `probe`, keeping that module
  document-free per its header contract.
- `ui/src/excalidrawEdit.js`: handle `commitPoint` in `onPointerDown`; call `endDraft`
  on the finish keys rather than only on pointerup.
- Unlocks the `rc.curve` branch already sitting at `excalidrawView.js:343`.

### 5. Point-edit mode on an existing line

Depends on #1 and #4.

**Root cause:** `case "edit"` only opens the text overlay, and only for
`element?.type === "text"` (`excalidrawEdit.js:948-955`).

**Fix:** when the selection is a single element with `has_points()`, Enter toggles a
`pointEditing` flag that makes #1's handles visible; add midpoint insert (click on a
segment) and delete (⌫ on a selected point). Needs two more exports beside `movePoint`:
`insertPoint(afterIndex, x, y, key)` and `deletePoint(index)` — the latter refusing to go
below two points, and clearing the corresponding binding if an endpoint is removed.

### 6. Arrowhead pickers

**Absent:** no UI, not a style key, not modelled. A new arrow is written with **no**
`endArrowhead` key at all; the renderer's `?? "arrow"` fallback
(`excalidrawView.js:354`) makes it *look* right locally and happens to match
Excalidraw's default, but `startArrowhead: null` is likewise omitted and nothing is
user-selectable.

**Fix:**
- `crates/xd-core/src/scene.rs` — add `start_arrowhead: Option<String>` and
  `end_arrowhead: Option<String>` immediately after `end_binding` (`:397`) to hold
  Excalidraw's own key order (module-header rule 2). Both
  `skip_serializing_if = "Option::is_none"`.
- `crates/xd-core/src/doc.rs:1116` — in `new_element`, set `end_arrowhead` to
  `Some("arrow")` for `ElementKind::Arrow`, `None` otherwise.
- `ui/src/excalidrawDoc.js:107` — add both keys to `DEFAULT_STYLE` (hence
  `STYLE_KEYS`); add an `ARROWLIKE = new Set(["arrow"])` beside `ROUNDABLE` at `:157`
  and emit them from `styleFor` (`:166-186`) for arrows only, so the panel cannot write
  `endArrowhead` onto a rectangle.
- `ui/src/excalidrawProps.js` — two `choiceGroup`s near `:498`, with icons, for
  `startArrowhead` and `endArrowhead`; options `none`(→`null`), `arrow`, `bar`, `dot`,
  `triangle`, `diamond`. `none` needs the same key-to-value indirection `roundness`
  already uses (`roundnessFor`, `excalidrawProps.js:150`), since the field value is
  `null` rather than a string.
- `ui/src/excalidrawView.js:361` — add the `diamond` case: filled rhombus at the tip,
  same `size` as `triangle`.

### 7. `roundness` on new linear elements

**Absent:** every arrow this editor authors differs from one excalidraw.com authors.

**Root cause:** `doc.rs:1121` matches only `Rectangle | Diamond` and returns `None`
otherwise; `ROUNDABLE` likewise excludes linear kinds
(`excalidrawDoc.js:157`, applied at `:179`). Excalidraw writes
`roundness: {type: 2}` (proportional) on new arrows and lines.

**Fix:** add `ElementKind::Line | ElementKind::Arrow => Some(Roundness { kind: 2, value: None })`
at `doc.rs:1121`; add `"line"`/`"arrow"` to `ROUNDABLE`; and make `drawLinear`
(`excalidrawView.js:339-343`) consult `element.roundness` rather than point count when
choosing `rc.curve` vs `rc.line`.

### 8. Copy/paste of bound pairs

**Root cause:** `DROPPED` strips `boundElements`, `startBinding` and `endBinding`
unconditionally (`excalidrawDoc.js:215`). Correct for a lone arrow — the ids would dangle
or, worse, point at the *original* shape — but wrong for a copied pair, which Excalidraw
remaps.

**Fix:** keep the three keys in the payload from `clipboardText`
(`excalidrawDoc.js:~220`). On paste, build an old-id → new-id map as elements are
inserted, then rewrite `startBinding.elementId`, `endBinding.elementId` and each
`boundElements[].id` **only** where the target is also in the payload, dropping any
reference that is not. Needs the paste path to insert then patch, since
`XdDoc.insert` assigns ids itself (`lib.rs:477-491`).

### 9. Elbow arrows

Largest piece; sequence last, on top of #1/#4/#5. An opened elbow arrow renders
acceptably today (its stored points are drawn as a polyline) and roundtrips losslessly,
but editing one will not re-route, so the geometry drifts out of agreement with
`elbowed: true`.

**Fix:** new `crates/xd-core/src/elbow.rs` with an orthogonal router taking the two
`fixedPoint` anchors and the two shape bounds; promote `elbowed` from `rest` to a
modelled `Option<bool>` on `Element`; produce `fixedPoint` in `ops::rebind_end`
(`ops.rs:332-336`) when the arrow is elbowed; and have `reflow_one` (`ops.rs:262`)
dispatch to the router instead of the two-point aim. Panel toggle beside the arrowhead
groups from #6.

---

## #1 in detail: the endpoint-handle gesture

### Where the handles get generated

Do **not** extend the `Handle` enum. `geometry.rs:600-602` states outright that its
discriminants are part of the WASM boundary, and renumbering would silently break
`HANDLE` / `HANDLE_CURSOR` in `xdWasm.js:19-29`. Add a parallel path instead, leaving
`handle_points` (`geometry.rs:662`) and `lib.rs:300-304` untouched:

```rust
// crates/xd-core/src/geometry.rs — new, beside handle_points at :662
pub fn point_handles(e: &Element, scene_per_px: f64) -> Vec<(f64, f64)>
pub fn point_handle_at(e: &Element, x: f64, y: f64, radius: f64, scene_per_px: f64) -> Option<usize>
```

Both gated on `e.kind.has_points()` (`scene.rs:184`) and returning **absolute** coords
(`e.x + p[0]`, `e.y + p[1]`), rotated by `e.angle` about the bbox centre so the handles
sit on the drawn stroke rather than on the unrotated point list.

### New WASM exports

In `crates/xd-wasm/src/lib.rs`, beside `handlePoints` at `:299`:

| Export | Signature | Notes |
|---|---|---|
| `pointHandles` | `(scene_per_px: f64) -> Option<Vec<f64>>` | flat x,y pairs; `None` unless the selection is exactly one element with `has_points()` |
| `pointHandleAt` | `(x, y, radius, scene_per_px) -> i32` | point index, or -1 |
| `movePoint` | `(index: usize, x: f64, y: f64, key: &str) -> Change` | see below |

`movePoint` must, inside one keyed command so the whole drag folds into a single undo
entry:

1. **If `index` is `0` or `len-1`, clear that end's binding first** —
   `Command::Bind { arrow, end, binding: None }`.
2. Patch `points[index]`, then re-derive `x`, `y`, `width`, `height` exactly the way
   `ops::reflow_one` does at `ops.rs:295-308`. Moving point 0 moves the element origin;
   skipping this leaves the bbox — and therefore every handle — drifting off the stroke.
3. Route through `apply_keyed(..., key, now)`, mirroring `draftTo` at `lib.rs:388-390`.

### How unbind-by-drag suppresses the `ops.rs:245` snap-back

Step 1 above **is** the answer. `reflow_bindings` re-aims any arrow whose own id is in
`ids` (`ops.rs:245`), which is what currently makes a bound endpoint immovable — the
patch moves it, the reflow puts it straight back. With the dragged end's binding cleared
*before* the point is patched, there is nothing for `reflow_bindings` to re-aim at that
end, so the endpoint follows the pointer; the **other** end, still bound, keeps
reflowing correctly. Dragging an endpoint off a shape therefore unbinds it — precisely
Excalidraw's behaviour — and **no signature in `reflow_bindings` has to change.**

Prefer this over the alternative of threading a `skip: Option<(&str, End)>` parameter
through `reflow_bindings`: that variant touches all three `with_reflow` call sites
(`lib.rs:311`, `:336`, `:342`) and buys no extra behaviour.

### How the UI reaches `rebindEnd`

- **`ui/src/xdWasm.js`** (beside `rebindEnd` at `:170`) — wrap the three new exports;
  `movePoint` goes through `invalidate(...)` like its neighbours.
- **`ui/src/excalidrawEdit.js`** `probeAt` (`:603-609`) — add
  `point: doc.pointHandleAt(x, y, HANDLE_SIZE / camera.scale, 1 / camera.scale)`.
- **`ui/src/excalidrawTools.js`** `pointerIntent` (`:181`) — inside the `select` branch,
  test `probe.point >= 0` **before** `handle >= 0` and return
  `{kind: "point", index: probe.point}`. Ordering is load-bearing: on a diagonal arrow
  the endpoints coincide with the bbox corner handles, so the endpoint must win or it is
  ungrabbable. Add a `"crosshair"` case to `cursorFor` (`:~200`).
- **`onPointerDown`** (`excalidrawEdit.js:674`) —
  `case "point": gesture.pointIndex = intent.index; gesture.arrowId = doc.elementId(doc.selection[0]);`
- **`onPointerMove`** (`:725`) —
  ```js
  case "point":
    edited(doc.movePoint(g.pointIndex, x, y, `point:${g.id}`));
    bindTarget = doc.bindableAt(x, y, g.arrowId);
    break;
  ```
  The `point:${g.id}` key matches the `drag:${gesture.id}` convention at `:741`.
- **`onPointerUp`** (`:806`) —
  ```js
  case "point":
    if (g.pointIndex === 0 || g.pointIndex === lastIndex)
      edited(doc.rebindEnd(g.arrowId, g.pointIndex !== 0));
    break;
  ```
  **This is the first UI call site `rebindEnd` has ever had.** `bindTarget = -1` at
  `:799` already clears the highlight.
- **`ui/src/excalidrawView.js`** — paint the handles from `pointHandles` next to the
  existing selection frame; smaller and round, so they read as points rather than
  resize grips.

### Tests to add

- `crates/xd-core/tests/binding.rs` — dragging a bound endpoint away clears the binding
  and the tip **stays where it was put** (this is the regression guard for the
  `ops.rs:245` snap-back); dropping it on a second shape rebinds to that shape.
- `ui/test/xdWasm.test.js` — `pointHandleAt` finds both ends of a two-point arrow and
  neither end of a rectangle.
- `ui/test/excalidrawTools.test.js` — a point handle beats a bbox handle at identical
  coordinates.

---

## Caveats

- Two **reference** claims rest on my knowledge of the Excalidraw source rather than a
  fetch during this audit: that `isBindingElement` admits arrows only (drives #3), and
  that new linear elements get `roundness: {type: 2}` (drives #7). I am confident in
  both, but each is worth a two-minute confirmation before implementing.
- `binding::bindable_at` (`binding.rs:41-58`) tests the **expanded AABB**
  (`b.expand(BINDING_THRESHOLD).contains(x, y)`), not the true outline, so an arrow
  ending near an ellipse's or diamond's bbox *corner* binds where Excalidraw would not.
  Over-binding, minor, and arguably the friendlier error — recorded, not ranked.
- `focus_for` and `binding_point` (`binding.rs:75`, `:110`) pick their axis with
  `if dx > dy`, a hard switch. Excalidraw's focus is a continuous function, so a bound
  arrow approaching a shape near the 45° diagonal will jump between axes as the shape is
  dragged. Cosmetic; worth a note if diagonal bindings look unstable in testing.
