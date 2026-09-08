# STYLING, PROPERTIES PANEL & RENDERING FIDELITY — audit vs. React Excalidraw (`master`)

Reference sources fetched from `github.com/excalidraw/excalidraw@master`:
`packages/element/src/shape.ts`, `renderElement.ts`, `bounds.ts`, `utils.ts`,
`typeChecks.ts`, `comparisons.ts`, `packages/common/src/constants.ts`,
`colors.ts`, `packages/excalidraw/actions/actionProperties.tsx`,
`components/Actions.tsx`, `components/shapeActionPredicates.ts`, `appState.ts`.

The vendored Rough.js is genuine — 4.6.6 `bundled/rough.esm.js`
(`ui/vendor/roughjs/README.md`), the same library and major version Excalidraw
uses. So every divergence below is in the *options* this repo generates, not in
the engine.

Everything marked ▸MEASURED was verified by running the vendored generator
headlessly against this repo's own `roughOptions`.

---

## 1. THE SLOPPINESS BUG — deep dive

The user's report ("sloppiness goes from smooth to bold to unconnected") is
three separate defects stacked, and they are all real. Nothing is conflating
roughness with `strokeWidth`; the "bold" is a genuine consequence of a fixed
seed, and the "unconnected" is a genuine missing flag.

### 1a. Side-by-side: `generateRoughOptions` vs `roughOptions`

| Option | Excalidraw (`shape.ts:194-256`) | This repo (`excalidrawScene.js:228-251`) | Verdict |
|---|---|---|---|
| `seed` | `element.seed` (`:196`) | `num(element.seed, 1)` (`:233`) | OK (but see 11a) |
| `strokeLineDash` | `[8, 8+w]` dashed / `[1.5, 6+w]` dotted (`:167-169`) | same, `strokeDash()` (`:203-208`, `:234`) | **exact match** |
| `disableMultiStroke` | `element.strokeStyle !== "solid"` (`:208`) | `!(strokeStyle === "solid" \|\| == null)` (`:230`, `:236`) | differs only when `strokeStyle` is absent |
| `strokeWidth` | `w + 0.5` non-solid, else `w` (`:211-214`) | same (`:237`) | **exact match** |
| `fillWeight` | `w / 2` (`:218`) | same (`:238`) | **exact match** |
| `hachureGap` | `w * 4` (`:219`) | same (`:239`) | **exact match** |
| `roughness` | **`adjustRoughness(element)`** (`:221`, defined `:171-191`) | raw `element.roughness` (`:231`, `:240`) | **MISSING** |
| `preserveVertices` | `continuousPath \|\| roughness < ROUGHNESS.cartoonist` (`:223-224`) | identical expression (`:244`) — but the *caller* passes the wrong `continuousPath` | **BROKEN at call sites** |
| `curveFitting` | **`1` for ellipse** (`:237-239`) | never set → Rough default `0.95` | **MISSING** |
| `fillStyle` | always set for rect/diamond/ellipse (`:233`); set for line/freedraw only when `isPathALoop` (`:245`) | set only when background is non-transparent, **for every type** (`:246-249`) | **BROKEN for line/arrow** |
| `fill` | `undefined` when transparent (`:234-236`) | key omitted when transparent | equivalent |
| `stroke` | `applyDarkModeFilter(strokeColor, isDarkMode)` (`:222`) | `element.strokeColor \|\| "#1e1e1e"` (`:241`) | dark mode MISSING |
| `bowing` | never set (Rough default `1`) | never set | **match** |
| `maxRandomnessOffset` | never set (Rough default `2`) | never set | **match** |
| `hachureAngle` | never set (Rough default `-41`) | never set | **match** |

Constants are right: `ROUGHNESS = {architect:0, artist:1, cartoonist:2}`
(`constants.ts:402-406`) matches `SLOPPINESS` (`excalidrawProps.js:78-82`) and
`ROUGHNESS_CARTOONIST` (`excalidrawScene.js:49`). `DEFAULT_ADAPTIVE_RADIUS = 32`
and `DEFAULT_PROPORTIONAL_RADIUS = 0.25` (`constants.ts:379-381`) match
`excalidrawScene.js:43-44`.

### 1b. Root cause of "unconnected" — `continuousPath` is inverted at both call sites

Excalidraw passes `continuousPath = true` for every shape it draws through
`generator.path()` — rounded rectangle (`shape.ts:786-795`), rounded diamond
(`shape.ts:847`), elbow arrow (`shape.ts:900`) — because a `path()` is rendered
segment-by-segment and, without `preserveVertices`, each segment's endpoints
wander independently. It passes `false` for lines and arrows (`shape.ts:875`)
and for sharp rectangles (`shape.ts:797-810`).

This repo does the exact opposite of both:

- `drawRectangle` (`excalidrawView.js:309`, `:315`) calls `roughOptions(element)`
  with **no** `continuousPath` — including on the rounded-path branch.
- `drawLinear` (`excalidrawView.js:341`) calls
  `roughOptions(element, { continuousPath: true })` — for *all* lines and arrows.

▸MEASURED, 200×120 rounded rectangle (`roundness: {type:3}`), which is the
repo's **default** shape (`crates/xd-core/src/doc.rs:1118-1127`). Max
discontinuity at the 8 path joints:

| roughness | this repo | Excalidraw |
|---|---|---|
| 0 (Architect) | 0.00 px | 0.00 px |
| 1 (Artist) | 0.00 px | 0.00 px |
| **2 (Cartoonist)** | **4.68 – 6.05 px** | **0.00 px at every joint, every seed** |

Per-joint gaps, three seeds:

```
seed 12345  repo [2.23, 2.75, 2.15, 5.99, 4.78, 5.80, 0.83]   excal [0,0,0,0,0,0,0]
seed 7      repo [4.00, 1.05, 3.76, 5.56, 4.56, 6.05, 2.50]   excal [0,0,0,0,0,0,0]
seed 999999 repo [4.13, 2.47, 2.50, 2.06, 0.23, 4.68, 3.87]   excal [0,0,0,0,0,0,0]
```

That is the "unconnected". Every rounded shape in the app comes apart at
Cartoonist and only at Cartoonist, which is exactly the reported symptom.

For contrast, a *sharp* rectangle does get corner gaps at Cartoonist in
Excalidraw too — ▸MEASURED `[1.61, 1.09, 2.13]` px, with the drawn path
straying up to 5.11 px outside its box — so that part of the look is faithful.

### 1c. Root cause of "bold" — the seed is never re-rolled

`actionChangeSloppiness.perform` sets **`seed: randomInteger()`** alongside
`roughness` (`actionProperties.tsx:711`). Every sloppiness click in Excalidraw
produces a *different sketch*.

This repo cannot do that: the panel emits `{ roughness }` only
(`excalidrawProps.js:495-497`), `applyStyle` → `doc.setStyle(stylePatch(patch))`
(`excalidrawEdit.js:1259-1263`), and `Command::Patch` deliberately filters
`seed` out (`crates/xd-core/src/doc.rs:216-221`, documented at `doc.rs:17-19`
and `command.rs:91`). So the seed is pinned and Rough's

```js
E(t,e,s,n) = s.roughness * n * (W(s)*(e-t)+t)     // rough.esm.js
```

multiplies the *same* random draws by `roughness` — a linear scale-up of one
drawing.

▸MEASURED, top edge (ideal `y = 0`) of that rounded rect, `strokeWidth: 2`,
seed fixed at 12345. The two multi-stroke passes fall on **opposite sides** of
the ideal line and separate linearly:

| roughness | pass 1 y-range | pass 2 y-range | combined ink band |
|---|---|---|---|
| 0 | `[0, 0]` | `[0, 0]` | **2.00 px** |
| 1 | `[-0.35, 0]` | `[0, 0.73]` | **3.08 px** |
| 2 | `[-0.69, 0]` | `[0, 1.45]` | **4.14 px** |

A 2 px stroke reads as a 3.1 px band at Artist and a 4.1 px band at Cartoonist,
with the ink centred on the same curve at all three levels. That is
"smooth → bold": not a `strokeWidth` change (`strokeWidth` is untouched —
`excalidrawScene.js:237`), but a monotone widening of one identical sketch.
Excalidraw runs the same rough.js math and hides it entirely by re-seeding.

The asymmetry is structural, not seed luck: Rough's `R()` gives pass 1 an
amplitude of `maxRandomnessOffset` (2) and pass 2 an amplitude of
`maxRandomnessOffset/2` (1), both scaled by roughness, so with a fixed seed the
two passes drift apart in lockstep as roughness rises.

### 1d. Root cause of small shapes falling apart — `adjustRoughness` is missing

`shape.ts:171-191`:

```ts
function adjustRoughness(element: ExcalidrawElement): number {
  const roughness = element.roughness;
  const maxSize = Math.max(element.width, element.height);
  const minSize = Math.min(element.width, element.height);
  if (
    (minSize >= 20 && maxSize >= 50) ||
    (minSize >= 15 && !!element.roundness && canChangeRoundness(element.type)) ||
    (isLinearElement(element) && maxSize >= 50)
  ) {
    return roughness;
  }
  return Math.min(roughness / (maxSize < 10 ? 3 : 2), 2.5);
}
```

▸MEASURED effective roughness, Excalidraw vs this repo:

| element | Excalidraw @artist / @cartoonist | this repo |
|---|---|---|
| 200×120 | 1 / 2 | 1 / 2 |
| 40×30 sharp | 0.5 / **1** | 1 / **2** |
| 30×10 sharp | 0.5 / **1** | 1 / **2** |
| 120×12 sharp | 0.5 / **1** | 1 / **2** |
| 8×8 sharp | 0.33 / **0.67** | 1 / **2** |

A small sharp shape here gets 2–3× the roughness Excalidraw would give it, on
top of 1b. Note the second clause is why Excalidraw's rounded shapes survive:
at ≥ 15 px they keep full roughness *and* full `preserveVertices`.

### 1e. `curveFitting` — ellipses shrink with roughness

Excalidraw forces `curveFitting: 1` for ellipses (`shape.ts:237-239`). Rough's
default is `0.95`, and it feeds `rx += randOffset(rx * (1 - curveFitting))` —
±5 % of the radius, scaled by roughness.

▸MEASURED drawn width of a 200-wide ellipse:

| roughness | this repo | Excalidraw |
|---|---|---|
| 0 | 200.1 | 200.1 |
| 1 | 199.4 | 203.9 |
| 2 | **194.2** | 203.2 |

At Cartoonist the repo's ellipse pulls ~6 px *inside* its own selection box,
where Excalidraw's spills slightly outside it.

### 1f. Missing `lineJoin` / `lineCap = "round"`

`drawElementOnCanvas` sets both to `"round"` before drawing shapes and before
drawing linear elements (`renderElement.ts:330-331`, `:338-339`). This repo sets
neither anywhere in the paint path — `grep` finds `lineCap` only in the
arrowhead helper (`excalidrawView.js:352`). Canvas defaults (`butt` / `miter`)
leave every multi-stroke pass square-ended, which makes small joins read as
notches and stops gaps up to `strokeWidth/2` from visually closing. It does not
account for the 2–6 px gaps in 1b on its own, but it is why what is left of them
after the fix would still look chopped at `strokeWidth: 4`.

### 1g. The concrete fix

```diff
--- a/ui/src/excalidrawScene.js
@@ -226,6 +226,25 @@
+/// Excalidraw's adjustRoughness: a small shape at Cartoonist looks wrecked
+/// rather than sketchy, so the roughness is damped by the shape's size.
+function adjustedRoughness(element) {
+  const roughness = num(element.roughness, 1);
+  const w = Math.abs(num(element.width));
+  const h = Math.abs(num(element.height));
+  const maxSize = Math.max(w, h);
+  const minSize = Math.min(w, h);
+  const linear = element.type === "line" || element.type === "arrow"
+    || element.type === "freedraw";
+  const roundable = element.type === "rectangle" || element.type === "diamond"
+    || element.type === "line" || element.type === "image";
+  if ((minSize >= 20 && maxSize >= 50)
+    || (minSize >= 15 && !!element.roundness && roundable)
+    || (linear && maxSize >= 50)) return roughness;
+  return Math.min(roughness / (maxSize < 10 ? 3 : 2), 2.5);
+}
+
 export function roughOptions(element, { continuousPath = false } = {}) {
   const strokeWidth = num(element.strokeWidth, 1);
   const solid = element.strokeStyle === "solid" || element.strokeStyle == null;
   const roughness = num(element.roughness, 1);
   const options = {
-    seed: num(element.seed, 1),
+    // Rough falls back to Math.random() on seed 0, which re-scrambles the
+    // shape on every repaint.
+    seed: num(element.seed, 1) || 1,
     ...
-    roughness,
+    roughness: adjustedRoughness(element),
     ...
     preserveVertices: continuousPath || roughness < ROUGHNESS_CARTOONIST,
   };
+  if (element.type === "ellipse") options.curveFitting = 1;
```

Keep `preserveVertices` keyed off the **raw** `roughness`, not the adjusted one
— that is what Excalidraw does (`shape.ts:221` computes the adjusted value for
`roughness`, `:224` compares the raw field).

```diff
--- a/ui/src/excalidrawView.js
@@ drawElement
   ctx.save();
   ctx.globalAlpha = opacityOf(element);
+  // renderElement.ts:330-331 — square-ended passes read as notches at every
+  // join, and butt caps stop small gaps from closing.
+  ctx.lineJoin = "round";
+  ctx.lineCap = "round";

@@ drawRectangle
-  const opts = roughOptions(element);
   if (r <= 0) {
-    rc.rectangle(x, y, w, h, opts);
+    rc.rectangle(x, y, w, h, roughOptions(element));
     return;
   }
-  rc.path(roundedRectPath(...), opts);
+  // A path() is drawn segment by segment; without preserveVertices every
+  // corner comes apart at Cartoonist. Excalidraw passes true here
+  // (shape.ts:786-795).
+  rc.path(roundedRectPath(...), roughOptions(element, { continuousPath: true }));

@@ drawLinear
-  const opts = roughOptions(element, { continuousPath: true });
+  const opts = roughOptions(element);   // Excalidraw: shape.ts:875 passes false
```

And, separately, a re-seed path so sloppiness reads as three sketches rather
than one amplified: add a `Command::Reseed { ids }` (or an `XdDoc.reseed(ids)`
wasm entry) rather than relaxing the `seed` filter in `doc.rs:216-221` — that
guard is load-bearing and documented. Then have the Sloppiness group ask the
host to re-seed after the patch lands.

Existing files at roughness 0 and 1 render bit-identically before and after the
`continuousPath` fix (▸MEASURED: `preserveVertices` is already `true` there), so
the rendering change is confined to Cartoonist.

---

## 2. Feature table

| Feature | Excalidraw (React) | This repo | Status | Evidence |
|---|---|---|---|---|
| **Sloppiness values** | 0 / 1 / 2 | 0 / 1 / 2 | PRESENT | `excalidrawProps.js:78-82` vs `constants.ts:402-406` |
| **Sloppiness → rough options** | `adjustRoughness`, re-seed, per-shape `continuousPath` | raw roughness, no re-seed, `continuousPath` inverted | **BROKEN** | §1; `excalidrawScene.js:231,244`, `excalidrawView.js:315,341` |
| `preserveVertices` on rounded shapes | `true` always | `false` at Cartoonist | **BROKEN** | `shape.ts:786-795` vs `excalidrawView.js:315` |
| `preserveVertices` on lines/arrows | `roughness < 2` | forced `true` | BROKEN | `shape.ts:875` vs `excalidrawView.js:341` |
| `adjustRoughness` size damping | yes | absent | **MISSING** | `shape.ts:171-191` |
| Seed re-roll on sloppiness change | `seed: randomInteger()` | impossible (patch filters `seed`) | **MISSING** | `actionProperties.tsx:711` vs `doc.rs:216-221` |
| `lineJoin`/`lineCap = "round"` | yes | absent | **MISSING** | `renderElement.ts:330-331,338-339` |
| Drawable cached per element | `ShapeCache` | regenerated every frame; new `rough.canvas()` per frame | PARTIAL (correct, wasteful) | `shape.ts:140-162` vs `excalidrawEdit.js:275-286`, `excalidrawView.js:101` |
| **Fill styles** hachure / cross-hatch / solid | 3 (+ zigzag easter egg) | 3, same order | PRESENT | `excalidrawProps.js:58-62` vs `actionProperties.tsx:582-596` |
| `fillWeight` = `w/2`, `hachureGap` = `w*4` | yes | yes | PRESENT | `excalidrawScene.js:238-239` vs `shape.ts:218-219` |
| `hachureAngle` | never set (Rough default −41) | never set | PRESENT | — |
| `fillStyle` on line/arrow | line only when the path is a loop; arrow never | any element with a background | **BROKEN** | `shape.ts:243-252` vs `excalidrawScene.js:246-249` |
| Freedraw background loop-fill | `generator.curve(simplify(points, 0.75), {stroke:"none"})` | not drawn | MISSING | `shape.ts:965-975` vs `excalidrawView.js:394-422` |
| **Stroke style** solid / dashed / dotted | 3 | 3 | PRESENT | `excalidrawProps.js:70-74` |
| `strokeLineDash` arrays | `[8,8+w]` / `[1.5,6+w]` | identical | PRESENT | `excalidrawScene.js:203-208` vs `shape.ts:167-169` |
| `disableMultiStroke` on non-solid | yes | yes (differs when `strokeStyle` absent) | PRESENT | `excalidrawScene.js:236` |
| **Stroke width** px values | `thin 1 / medium 2 / bold 4` (`extraBold 8` unused) | `1 / 2 / 4` | PRESENT | `excalidrawProps.js:64-68` vs `constants.ts:416-423` |
| Freedraw stroke width scale | `FREEDRAW_STROKE_WIDTH = 0.5 / 1 / 2` via `getStrokeWidthByKey` | writes 1/2/4 for freedraw too | **BROKEN** | `constants.ts:430-446`, `actionProperties.tsx:633-642` vs `excalidrawProps.js:64-68` |
| Default `strokeWidth` | `medium` = 2 | 2 (doc) / **1** (panel table) | PARTIAL | `constants.ts:448,463`; `doc.rs:1142`, `excalidrawDoc.js:110` vs `excalidrawProps.js:118` |
| **Edges** sharp / round | 2 | 2 | PRESENT | `excalidrawProps.js:89-92` |
| `getCornerRadius` algorithm | adaptive 32 px with an `x ≤ 128` proportional cutoff; proportional 0.25 | line-for-line port | **PRESENT** | `excalidrawScene.js:214-223` vs `utils.ts:526-547` |
| Roundness **type** per shape | rect/iframe/embeddable/image → `{type:3}`; **line/arrow/diamond → `{type:2}`** | `{type:3}` for everything | **BROKEN** | `typeChecks.ts:309-316`, `actionProperties.tsx:1690-1694` vs `excalidrawProps.js:150-152`, `doc.rs:1118-1127` |
| Rounded **diamond** rendering | `generator.path()` with per-axis radii | always `rc.polygon()` — corners never round | **BROKEN** | `shape.ts:826-843` vs `excalidrawView.js:324-330` |
| Rounded **image** clip | `ctx.roundRect` + `clip` | ignored | MISSING | `renderElement.ts:381-390` vs `excalidrawView.js:433-440` |
| Roundness on **line** | `canChangeRoundness` includes `line`; new lines default `{type:2}` | never written for linear elements | MISSING | `comparisons.ts:49-55`, `appState.ts:41` vs `excalidrawDoc.js:157`, `doc.rs:1118-1127` |
| Sharp multi-point line render | `generator.linearPath()` (straight segments) | always `rc.curve()` when > 2 points | BROKEN | `shape.ts:901-913` vs `excalidrawView.js:344-345` |
| **Stroke palette** (5) | `#1e1e1e #e03131 #2f9e44 #1971c2 #f08c00` | identical | **PRESENT** | `excalidrawProps.js:44` vs `colors.ts:239-245` |
| **Background palette** (5) | `transparent #ffc9c9 #b2f2bb #a5d8ff #ffec99` | identical | **PRESENT** | `excalidrawProps.js:46` vs `colors.ts:248-254` |
| Color picker: hex input | `ColorInput` field | none (SV square + hue + alpha only) | MISSING | `ColorPicker.tsx:108-117` vs `colorpicker.js:142-149` |
| Color picker: 15-color palette + 5 shades | `Picker` / `ShadeList` | none | MISSING | `ColorPicker.tsx:193` vs `colorpicker.js` |
| Color picker: keyboard shortcuts | letter-keyed swatches, section nav | Escape only | MISSING | `colorpicker.js:232-236` |
| Color picker: recent / most-used colors | yes | none | MISSING | — |
| Color picker: eyedropper | `activeEyeDropperAtom` | none | MISSING | `ColorPicker.tsx:24,104` |
| Color output format | hex (incl. 8-digit) | hex **or** `rgb()/rgba()/hsl()/hsla()` | PARTIAL — interop risk | `colorpicker.js:103-114,209-213` |
| **Style memory** for new elements | `currentItem*` in appState | `let style` + `mergeStyle` | PRESENT | `excalidrawEdit.js:196,1259` |
| **Opacity** slider 0–100 step 10 | yes | yes | PRESENT | `excalidrawProps.js:450-471` vs `actionProperties.tsx:927-929` |
| Opacity render | `element.opacity/100`, multiplied by the containing frame's | `element.opacity/100` | PRESENT (frame nesting MISSING) | `excalidrawScene.js:254` vs `renderElement.ts:113-121` |
| **Layers** send-to-back / backward / forward / front | 4 panel buttons + `⌘[` / `⌘]` | keyboard only, no UI | **PARTIAL** | `Actions.tsx` `LayersFieldset`; `excalidrawTools.js:256-257`, `doc.rs:795`, `xdWasm.js:162` |
| **Align** (6 actions) | `AlignFieldset` | absent — no UI, no shortcut, no core op | **MISSING** | `Actions.tsx`; nothing in `ui/src` |
| **Distribute** h/v (> 2 selected) | yes | absent | MISSING | `shapeActionPredicates.ts` `distribute` |
| Font size S/M/L/XL | 16 / 20 / 28 / 36 | 16 / 20 / 28 / 36 | PRESENT | `excalidrawProps.js:94-99` vs `constants.ts:213` |
| Font family picker | Excalifont 5 / Nunito 6 / Comic Shanns 8 | 5 / **2** / **3** | PARTIAL | `excalidrawProps.js:104-108` vs `constants.ts:130-141` |
| Default font family of a new text element | `Excalifont` = 5 | `font_family: 1` (Virgil) in core, overridden to 5 by `styleFor` | PARTIAL / fragile | `doc.rs:1163` vs `excalidrawDoc.js:115`, `constants.ts:214` |
| Text align (left / center / right) | `changeTextAlign` | no control (the renderer honours the field) | MISSING | `actionProperties.tsx:1475`; `excalidrawScene.js:272-275` |
| Vertical align | `changeVerticalAlign` | no control | MISSING | `actionProperties.tsx:1576` |
| Arrowhead pickers (start / end) | `changeArrowhead`, 13 kinds | no control | MISSING | `actionProperties.tsx:1873` |
| Arrowhead rendering | rough-generated; size 25 (`arrow`) / 15; angle 20° / 25° / 90°; clamped to `lastSegment × 0.5`; direction from the bezier tangent at t = 0.3 | plain canvas paths; `size = 15 + (w−1)×2`; spread 25.7°; no clamp; chord direction | **BROKEN** | `bounds.ts:710-742,796-838`, `shape.ts:417-423` vs `excalidrawView.js:347-392` |
| Arrowhead kinds drawn | 13, incl. `diamond`, `*_outline`, crowfoot cardinality | `dot`/`circle`, `bar`, `triangle`, open V; **no `diamond` case** — falls through to the open V | **PARTIAL** *(cross-check from the bindings auditor; that auditor owns the fix)* | `excalidrawView.js:361-393` vs `bounds.ts:713-731` |
| Absent `endArrowhead` default | `endArrowhead = "arrow"` when undefined, `startArrowhead = null` | same (`element.endArrowhead ?? "arrow"`, start only when truthy) | PRESENT — **the bindings auditor's note here is incorrect**; Excalidraw also defaults an absent `endArrowhead` to `"arrow"` | `shape.ts:915-916` vs `excalidrawView.js:353-356` |
| Canvas background control | `changeViewBackgroundColor` + 5 picks | none (field honoured on read only) | MISSING | `colors.ts:268-278`; `excalidrawEdit.js:270`, `excalidrawDoc.js:28` |
| Dark mode / theme colour handling | `applyDarkModeFilter` per stroke and fill | not applied (chrome themed only) | MISSING | `colors.ts:86-116`, `shape.ts:222,236` vs `excalidrawView.js:517-536` |
| Per-type panel sections | `getShapeActionPredicates` gates ~15 sections | 9 fixed groups; only Fill conditional | **BROKEN** | `shapeActionPredicates.ts`, `comparisons.ts:3-59` vs `excalidrawProps.js:482-514,550` |
| Fill shown only when fillable | `!isTransparent(bg)` | same rule | PRESENT | `excalidrawProps.js:142-144,550`; `[hidden]` handled at `excalidrawProps.css:120` |
| Mixed multi-selection | `getFormValue` → `null`, nothing pressed | shows `selection[0]`'s values as pressed | **BROKEN** | `actionProperties.tsx:687-693` vs `excalidrawEdit.js:1272` |
| Freedraw: perfect-freehand params | `size w×4.25`, `thinning .6`, `smoothing .5`, `streamline .5`, `easing` easeOutSine, `last: true` | same **minus `easing`** | PARTIAL | `shape.ts:1182-1221`, `constants.ts:557` vs `excalidrawView.js:405-412` |
| Freedraw outline → path | `getSvgPathFromStroke` (quadratics through midpoints) | straight `lineTo` polyline | PARTIAL | `shape.ts:1169-1173` vs `excalidrawView.js:414-417` |
| Freedraw input tuples | 2-tuples when `simulatePressure`, else 3-tuples | always 3-tuples | PARTIAL | `shape.ts:1205-1211` vs `excalidrawView.js:400-404` |
| Rotation rendering | rotate about the element's centre | same | PRESENT | `excalidrawView.js:282-289` |
| Diamond apex points | `floor(w/2)+1`, `floor(h/2)+1` | exact `w/2`, `h/2` | PARTIAL (sub-pixel) | `bounds.ts:521-534` vs `excalidrawView.js:326-328` |

---

## 3. Other MISSING / BROKEN items, ranked by user impact

### 1 — Rounded diamonds never round

`drawDiamond` (`excalidrawView.js:324-330`) always calls `rc.polygon()`;
`element.roundness` is never read. Excalidraw builds a `generator.path()` with
separate vertical and horizontal radii (`shape.ts:826-843`). Combined with the
wrong roundness *type* (item 2), a diamond drawn here with "Round" edges looks
sharp in this app and rounded-but-differently in Excalidraw.

**Sketch.** Port the diamond path string from `shape.ts:838-843` verbatim,
computing `verticalRadius = getCornerRadius(|topX − leftX|, element)` and
`horizontalRadius = getCornerRadius(|rightY − topY|, element)`. Note
`getCornerRadius` takes an arbitrary `x`, so `cornerRadius(element)`
(`excalidrawScene.js:214-223`) needs to split into `cornerRadiusFor(x, element)`
plus the current `min(w,h)` convenience wrapper. Pass
`{ continuousPath: true }`, as Excalidraw does at `shape.ts:847`.

### 2 — Roundness type is wrong for diamonds, and absent for lines

`roundnessFor()` returns `{type:3}` for everything
(`excalidrawProps.js:150-152`) and `new_element` hard-codes `kind: 3` for both
rectangle and diamond (`doc.rs:1118-1127`). Excalidraw uses `ADAPTIVE_RADIUS`
(3) only for rectangle / iframe / embeddable / **image** and
`PROPORTIONAL_RADIUS` (2) for **line / arrow / diamond**
(`typeChecks.ts:309-316`), applied at `actionProperties.tsx:1690-1694`. A
diamond written here carries a value Excalidraw would never write for that type,
and re-renders over there with a fixed 32 px radius instead of
`0.25 × min(w,h)`.

The same gap explains the bindings auditor's cross-check that `roundness` is
never written for linear elements: `ROUNDABLE` is `{rectangle, diamond}`
(`excalidrawDoc.js:157`) and `new_element` matches only those two. Excalidraw's
`currentItemRoundness` defaults to `"round"` (`appState.ts:41`), so new lines
there get `{type:2}`. In *this* app lines still draw curved regardless, because
`drawLinear` uses `rc.curve()` for any >2-point line without consulting
`roundness` (`excalidrawView.js:344`) — so the visible symptom is a round-trip
divergence, not a line that fails to render: a line created here reopens in
Excalidraw as straight `linearPath` segments (`shape.ts:901-913`). Fix owned by
the bindings auditor.

**Sketch (this domain's half).** Make `roundnessFor(key, kind)` type-aware and
pick the type in `new_element` from the same predicate.

### 3 — Freedraw strokes are twice as thick as Excalidraw's

The width buttons write raw 1/2/4 (`excalidrawProps.js:64-68`) for every element
type. Excalidraw's buttons carry *keys* and resolve through
`getStrokeWidthByKey`, which maps freedraw to 0.5/1/2
(`constants.ts:430-446`, `actionProperties.tsx:633-642`) — the schema-2.0
back-compat halving. Two consequences: every pencil stroke drawn here is 2×
Excalidraw's, and the panel shows nothing pressed for a freedraw element
imported from Excalidraw, because its 0.5/1/2 matches none of 1/2/4.

**Sketch.** Change `STROKE_WIDTHS` to carry `{key: "thin"|"medium"|"bold"}` and
resolve to px per selected element kind in `styleFor` / `stylePatch`
(`excalidrawDoc.js:168-202`); `choiceGroup`'s `read` has to compare through the
same mapping (`excalidrawProps.js:337-367` already supports a custom `read`).

### 4 — Arrowheads are the wrong shape, size and direction

`excalidrawView.js:361-392` draws plain canvas paths at
`size = 15 + (lineWidth−1)×2` with a 25.7° half-spread (`Math.PI/7`), aimed
along the chord of the last two points. Excalidraw generates them with Rough
(`shape.ts:417-423`; roughness clamped to ≤ 1, solid stroke), sizes them 25 px
for `arrow` and 15 px otherwise (`bounds.ts:713-731`), uses 20° / 25° / 90°
(`bounds.ts:734-742`), clamps to `min(size, lastSegmentLength × 0.5)`
(`bounds.ts:831-834`), and takes the direction from the *rendered* bezier's
tangent at t = 0.3 (`bounds.ts:790-809`) — so on a curved arrow this repo's head
points along the chord instead of along the curve. The comment at
`excalidrawView.js:348-349` ("Arrowheads are solid, not sketched — Excalidraw
draws them the same way") is factually wrong.

**Sketch.** Keep the canvas implementation but fix size / angle / clamp first
— that is most of the visible error and is a few lines — then move to
rough-generated heads if byte-fidelity matters. The missing `diamond` case
(cross-check from the bindings auditor) lands in the same switch; that auditor
owns it.

### 5 — Mixed multi-selection lies about the current value

`getStyle` returns `styleFrom(doc.element(doc.selection[0]))`
(`excalidrawEdit.js:1272`). Select a red rectangle and a blue one and the panel
shows red pressed; clicking "Bold" then silently rewrites both. Excalidraw's
`getFormValue` returns `null` when the selected elements disagree, so no button
is pressed (`actionProperties.tsx:687-693`).

**Sketch.** Have the editor fold every selected element's style and emit
`undefined` for keys that differ. `choiceGroup`'s sync already handles
"nothing matches" correctly (`excalidrawProps.js:358-365`); `colorGroup` needs
the same treatment for its custom swatch (`:424-442`), which currently lights up
for any non-preset value including `undefined`.

### 6 — Every panel section is shown for every element type

`excalidrawProps.js:482-514` appends nine groups unconditionally; only Fill is
gated (`:550`). Excalidraw gates each one (`shapeActionPredicates.ts`, built on
`comparisons.ts:3-59`):

- no background / fill / stroke-style / sloppiness / edges for **text**
- no stroke colour for **image**, **frame**, **magicframe**
- no edges for **ellipse**, **arrow**, **freedraw**, **text**
  (`canChangeRoundness` = rectangle, iframe, embeddable, line, diamond, image)
- no sloppiness for **freedraw**, **text**, **image**
  (`sloppiness: forToolOrSelection(hasStrokeStyle)`)
- text controls only when a text element is selected or the text tool is active

The file's own comment (`:505-510`) defends showing the two text rows always to
stop the island changing height, which is a defensible local call. Edges on an
ellipse and Sloppiness on a text element are not — they are controls with no
effect at all.

**Sketch.** Pass the selection's kinds into `refresh()` and drive
`group.hidden` from ports of `hasBackground` / `hasStrokeWidth` /
`hasStrokeStyle` / `canChangeRoundness`. The `[hidden]` CSS is already correct
for flex children (`excalidrawProps.css:118-120`), so this is purely a matter of
holding the groups by name the way `fillGroup` already is.

### 7 — No layers UI, no align, no distribute

Z-order exists in the core (`doc.rs:795`, `xdWasm.js:162`,
`crates/xd-wasm/src/lib.rs:526-533`) and on the keyboard (`⌘[` / `⌘]`,
`excalidrawTools.js:256-257`) but has no buttons; Excalidraw puts four in the
panel (`Actions.tsx` `LayersFieldset`). Align (6 actions) and distribute (2) are
absent everywhere — no core op, no shortcut, no UI. Worth noting
`excalidrawView.js:701-735` already draws snap guides, so the alignment
*feedback* exists without the alignment *commands*.

### 8 — No canvas-background control, and no dark-mode colour handling

`viewBackgroundColor` is read (`excalidrawEdit.js:270`, refreshed by `syncFiles`
at `:549-550`) and written once into `BLANK` (`excalidrawDoc.js:28`), but nothing
can change it; Excalidraw offers five picks (`colors.ts:268-278`) plus the full
picker. Separately, Excalidraw's dark theme rewrites every element colour
through `applyDarkModeFilter` — a per-colour invert plus hue-rotate
(`colors.ts:86-116`) — at `shape.ts:222` and `:236`. This repo themes only its
*chrome* (`excalidrawView.js:517-536`) and paints elements at their literal
colours, so a dark-authored diagram and a light-authored one look the same here
and different there.

### 9 — Line/arrow fill, and sharp-line geometry

`roughOptions` attaches `fill`/`fillStyle` for any element with a background
(`excalidrawScene.js:246-249`), so a background colour set on a **line** or
**arrow** fills it. Excalidraw fills a line only when `isPathALoop(points)` and
an arrow never (`shape.ts:243-252`). And `drawLinear` uses `rc.curve()` for any
>2-point line (`excalidrawView.js:344`), where Excalidraw uses
`generator.linearPath()` unless `roundness` is set (`shape.ts:901-913`).

**Sketch.** Gate `fill` on `element.type` the way `generateRoughOptions`'s
switch does; port `isPathALoop` (first and last point within a tolerance) for
the line and freedraw cases.

### 10 — Freedraw path smoothing and easing

Missing `easing: t => Math.sin(t * π / 2)` (`shape.ts:1219`), and the outline is
closed with straight `lineTo` (`excalidrawView.js:414-417`) rather than
Excalidraw's `getSvgPathFromStroke` quadratics (`shape.ts:1170`). Visible as
slightly faceted stroke edges and a tip that tapers on the wrong curve. Also,
this repo always passes 3-tuples to `getStroke` (`excalidrawView.js:400-404`)
while Excalidraw passes bare 2-tuples when `simulatePressure` is true
(`shape.ts:1205-1211`). `streamline`, `thinning`, `smoothing` and the ×4.25 size
factor all match exactly (`shape.ts:1182-1187`, `constants.ts:557`).

### 11 — Low priority

- **(a)** `seed: 0` in an imported file passes `num(element.seed, 1)` unchanged
  (`excalidrawScene.js:233`), and Rough then falls back to `Math.random()` per
  draw (`rough.esm.js`: `this.seed ? … : Math.random()`) — the shape
  re-scrambles on every repaint. `|| 1` fixes it. The core cannot mint 0 in
  practice (`ids.rs:37-39` gives a 31-bit value, as does Excalidraw's
  `randomInteger()`), so this only bites hand-authored or generated files.
- **(b)** `disableMultiStroke` differs from Excalidraw for elements with no
  `strokeStyle` key: this repo treats absent as solid (`excalidrawScene.js:230`),
  Excalidraw treats it as non-solid (`shape.ts:208`). Excalidraw's `restore()`
  fills the field, so real files are unaffected.
- **(c)** Two disagreeing `DEFAULT_STYLE` objects.
  `excalidrawProps.js:114-125` says `strokeWidth: 1`, `fillStyle: "hachure"`,
  `roundness: null`; `excalidrawDoc.js:106-117` says `2`, `"solid"`,
  `{type:3}`. Excalidraw's `DEFAULT_ELEMENT_PROPS` is `2` / `"solid"`
  (`constants.ts:459-468`). Only the doc one is live today (because `styleFrom`
  always returns all ten keys), but the panel's is the fallback for a style
  object with holes.
- **(d)** The Drawable is regenerated for every element on every frame and a
  fresh `rough.canvas()` is built per frame (`excalidrawEdit.js:275-286`,
  `excalidrawView.js:101`). Output is stable because the seed is, but Excalidraw
  caches per element (`shape.ts:140-162`). Worth a `WeakMap` keyed by element
  identity plus a style signature once drags get heavy.
- **(e)** Diamond apexes: Excalidraw uses `floor(w/2)+1` / `floor(h/2)+1`
  (`bounds.ts:521-534`, with a comment about avoiding zeros); this repo uses
  exact `w/2` / `h/2` (`excalidrawView.js:326-328`). A sub-pixel offset, but it
  means the two renderers disagree about where a diamond's points are.

---

## 4. Test coverage in `ui/test/`

`excalidrawScene.test.js` pins the option mapping well — dash arrays
(`:116-121`), corner radius including both roundness types (`:123-136`),
`disableMultiStroke` (`:139-143`), `fillWeight` / `hachureGap` (`:152-156`), fill
only when there is a background (`:145-150`), seed determinism (`:176-191`), and
Rough actually accepting the mapped options (`:193-204`).

Its `preserveVertices` test (`:158-165`) asserts exactly the *current*
behaviour, `continuousPath` included, so it will need updating alongside the fix
in §1g — and it is the reason the inversion went unnoticed: the mapping is
tested, the two callers that supply `continuousPath` are not.

`excalidrawPaint.test.js` only asserts that each branch paints *something*
(`:170-205`) — no geometry, no options. `excalidrawProps.test.js` pins the value
tables against Excalidraw's (`:39-64`), the fill-group rule (`:87-91`, `:383`),
the emitted patches (`:305-345`) and the single-active-value invariant (`:356`),
but it exercises only single-value styles — nothing covers a mixed selection.

Nothing anywhere tests `adjustRoughness` (absent), `curveFitting`, `lineJoin` /
`lineCap`, rounded diamonds, freedraw width scaling, arrowhead geometry, or
per-type panel gating.
