import { test, expect } from "bun:test";
import rough from "../vendor/roughjs/rough.esm.js";
import {
  parseScene, visibleElements, sceneBounds, elementBounds, fitTransform,
  strokeDash, cornerRadius, cornerRadiusFor, roughOptions, adjustedRoughness,
  isPathALoop, applyDarkModeFilter, THEME_FILTER, opacityOf, imageDataUrl,
  fontString, lineHeightPx, textLayout, isDrawn,
} from "../src/excalidrawScene.js";

const rect = (over = {}) => ({
  type: "rectangle", x: 10, y: 20, width: 100, height: 50, angle: 0,
  strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "hachure",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, seed: 12345,
  ...over,
});

const scene = (elements) => JSON.stringify({ type: "excalidraw", version: 2, elements });

// --- parsing ----------------------------------------------------------------

test("a scene parses to its elements", () => {
  const r = parseScene(scene([rect()]));
  expect(r.ok).toBe(true);
  expect(r.elements).toHaveLength(1);
  expect(r.elements[0].type).toBe("rectangle");
});

test("a half-written file explains itself instead of throwing", () => {
  // Opening a file mid-save is normal, not exceptional.
  const r = parseScene('{"type":"excalidraw","elements":[');
  expect(r.ok).toBe(false);
  expect(r.error).toContain("valid JSON");
});

test("a shape library is not a scene and says so", () => {
  const r = parseScene(JSON.stringify({ type: "excalidrawlib", libraryItems: [] }));
  expect(r.ok).toBe(false);
  expect(r.error).toContain("excalidrawlib");
});

test("JSON that isn't a scene at all is rejected", () => {
  expect(parseScene("[]").ok).toBe(false);
  expect(parseScene('"hello"').ok).toBe(false);
  expect(parseScene(JSON.stringify({ type: "excalidraw" })).ok).toBe(false);
  expect(parseScene(null).ok).toBe(false);
});

test("appState and files default to objects so the renderer needn't guard", () => {
  const r = parseScene(scene([]));
  expect(r.appState).toEqual({});
  expect(r.files).toEqual({});
});

test("deleted elements are dropped — the file keeps them, the drawing doesn't", () => {
  const r = parseScene(scene([rect(), rect({ isDeleted: true })]));
  expect(r.elements).toHaveLength(1);
});

test("junk in the elements array is skipped rather than crashing the draw", () => {
  expect(visibleElements([null, 42, "x", { noType: true }, rect()])).toHaveLength(1);
});

// --- bounds and fit ---------------------------------------------------------

test("a shape's bounds come from x/y/width/height", () => {
  expect(elementBounds(rect())).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
});

test("a shape dragged up and left has negative extents and still bounds correctly", () => {
  expect(elementBounds(rect({ width: -100, height: -50 }))).toEqual({
    minX: -90, minY: -30, maxX: 10, maxY: 20,
  });
});

test("a linear element's points are relative to its origin", () => {
  const line = { type: "line", x: 100, y: 100, points: [[0, 0], [50, -20], [10, 30]] };
  expect(elementBounds(line)).toEqual({ minX: 100, minY: 80, maxX: 150, maxY: 130 });
});

test("scene bounds are the union", () => {
  const b = sceneBounds([rect(), rect({ x: 200, y: 0, width: 10, height: 10 })]);
  expect(b).toEqual({ minX: 10, minY: 0, maxX: 210, maxY: 70, width: 200, height: 70 });
});

test("an empty scene has no bounds, which the caller shows as empty", () => {
  expect(sceneBounds([])).toBeNull();
});

test("fit centres the drawing and never enlarges past 1:1", () => {
  // A small sketch blown up to fill a wide pane reads as a bug.
  const b = sceneBounds([rect()]);
  const t = fitTransform(b, { width: 1000, height: 800 });
  expect(t.scale).toBe(1);
});

test("fit shrinks a drawing that overflows the pane", () => {
  const b = sceneBounds([rect({ width: 2000, height: 1000 })]);
  const t = fitTransform(b, { width: 500, height: 500 }, 0);
  expect(t.scale).toBeCloseTo(0.25, 5);
});

test("a zero-width scene doesn't divide by zero", () => {
  // A single vertical line has no width at all.
  const b = sceneBounds([{ type: "line", x: 0, y: 0, points: [[0, 0], [0, 100]] }]);
  const t = fitTransform(b, { width: 400, height: 400 });
  expect(Number.isFinite(t.scale)).toBe(true);
  expect(t.scale).toBeGreaterThan(0);
});

test("fitting into a pane with no room falls back rather than going negative", () => {
  const t = fitTransform(sceneBounds([rect()]), { width: 0, height: 0 });
  expect(t.scale).toBe(1);
});

// --- the Excalidraw property port -------------------------------------------

test("dash patterns scale with the stroke, so a thick dash stays a dash", () => {
  expect(strokeDash("dashed", 1)).toEqual([8, 9]);
  expect(strokeDash("dashed", 4)).toEqual([8, 12]);
  expect(strokeDash("dotted", 2)).toEqual([1.5, 8]);
  expect(strokeDash("solid", 2)).toBeUndefined();
});

test("adaptive corner radius is fixed above the cutoff and proportional below", () => {
  // Ported from Excalidraw's getCornerRadius: fixed 32 until the short side
  // drops under 128, then a quarter of it.
  expect(cornerRadius(rect({ roundness: { type: 3 }, width: 400, height: 300 }))).toBe(32);
  expect(cornerRadius(rect({ roundness: { type: 3 }, width: 400, height: 40 }))).toBe(10);
});

test("legacy proportional roundness is a quarter of the short side", () => {
  expect(cornerRadius(rect({ roundness: { type: 2 }, width: 400, height: 80 }))).toBe(20);
});

test("a sharp-cornered shape has no radius", () => {
  expect(cornerRadius(rect())).toBe(0);
  expect(cornerRadius(rect({ roundness: null }))).toBe(0);
});

test("the radius rule takes a length, because a diamond needs one per axis", () => {
  // cornerRadius() is the rule applied to the short side; a rounded diamond
  // measures its two insets along different runs (shape.ts:827-834), so the two
  // have to be separable. Same shape, three answers.
  const d = rect({ type: "diamond", roundness: { type: 2 }, width: 200, height: 80 });
  expect(cornerRadius(d)).toBe(20);              // min(200, 80) x 0.25
  expect(cornerRadiusFor(100, d)).toBe(25);      // half the width
  expect(cornerRadiusFor(40, d)).toBe(10);       // half the height
});

test("a non-solid stroke is drawn once, not twice", () => {
  // Rough's default double stroke smears a dashed line's gaps shut.
  expect(roughOptions(rect({ strokeStyle: "dashed" })).disableMultiStroke).toBe(true);
  expect(roughOptions(rect()).disableMultiStroke).toBe(false);
});

test("fill is only set when the shape actually has one", () => {
  expect(roughOptions(rect()).fill).toBeUndefined();
  const filled = roughOptions(rect({ backgroundColor: "#ffc9c9", fillStyle: "cross-hatch" }));
  expect(filled.fill).toBe("#ffc9c9");
  expect(filled.fillStyle).toBe("cross-hatch");
});

test("hachure density and fill weight follow the stroke width", () => {
  const o = roughOptions(rect({ strokeWidth: 4 }));
  expect(o.fillWeight).toBe(2);
  expect(o.hachureGap).toBe(16);
});

test("which elements a background actually fills is per-type, not universal", () => {
  // shape.ts:225-256. A background colour on an arrow fills nothing in
  // Excalidraw, and on a line only when the line closes on itself — so
  // honouring it everywhere paints shapes that exist in no other renderer.
  const bg = { backgroundColor: "#ffc9c9", fillStyle: "solid" };
  const open = [[0, 0], [50, 0], [50, 50]];
  const closed = [[0, 0], [50, 0], [50, 50], [2, 1]]; // ends within 8px of its start

  expect(roughOptions(rect({ ...bg })).fill).toBe("#ffc9c9");
  expect(roughOptions(rect({ ...bg, type: "diamond" })).fill).toBe("#ffc9c9");
  expect(roughOptions(rect({ ...bg, type: "ellipse" })).fill).toBe("#ffc9c9");

  expect(roughOptions(rect({ ...bg, type: "arrow", points: closed })).fill).toBeUndefined();
  expect(roughOptions(rect({ ...bg, type: "line", points: open })).fill).toBeUndefined();
  expect(roughOptions(rect({ ...bg, type: "line", points: closed })).fill).toBe("#ffc9c9");
  expect(roughOptions(rect({ ...bg, type: "freedraw", points: closed })).fill).toBe("#ffc9c9");
});

test("a path counts as a loop when its end lands within Excalidraw's threshold", () => {
  // LINE_CONFIRM_THRESHOLD is 8px (constants.ts:21), and two points can never
  // be a loop however close they are (utils.ts:515).
  expect(isPathALoop([[0, 0], [50, 0], [8, 0]])).toBe(true);
  expect(isPathALoop([[0, 0], [50, 0], [9, 0]])).toBe(false);
  expect(isPathALoop([[0, 0], [0, 0]])).toBe(false);
  expect(isPathALoop(undefined)).toBe(false);
});

test("only the sketchiest roughness is allowed to miss its vertices", () => {
  expect(roughOptions(rect({ roughness: 0 })).preserveVertices).toBe(true);
  expect(roughOptions(rect({ roughness: 1 })).preserveVertices).toBe(true);
  expect(roughOptions(rect({ roughness: 2 })).preserveVertices).toBe(false);
  // A shape drawn as a multi-segment path() stays anchored whatever its
  // roughness, because each segment's endpoints wander independently and the
  // corners would come apart. Which shapes those are is a property of the call
  // site, not of the element — excalidrawPaint.test.js pins the call sites.
  expect(roughOptions(rect({ roughness: 2 }), { continuousPath: true }).preserveVertices).toBe(true);
});

test("preserveVertices reads the raw roughness, not the size-damped one", () => {
  // shape.ts:221 computes the adjusted value for `roughness` and :224 compares
  // the untouched field. A small shape whose roughness is halved from 2 to 1
  // still gets to miss its vertices, and matching that is the difference
  // between a faithful sketch and a tidier-looking one.
  const small = rect({ roughness: 2, width: 40, height: 30 });
  expect(roughOptions(small).roughness).toBe(1);
  expect(roughOptions(small).preserveVertices).toBe(false);
});

test("roughness is damped by the shape's size, the way Excalidraw damps it", () => {
  // adjustRoughness (shape.ts:171-191). Without this a small shape gets 2-3x
  // the roughness Excalidraw would give it and reads as wrecked rather than
  // sketchy. The reference column is measured against upstream.
  const at = (over) => [
    adjustedRoughness({ type: "rectangle", roughness: 1, ...over }),
    adjustedRoughness({ type: "rectangle", roughness: 2, ...over }),
  ];
  expect(at({ width: 200, height: 120 })).toEqual([1, 2]);        // both sides big
  expect(at({ width: 40, height: 30 })).toEqual([0.5, 1]);
  expect(at({ width: 30, height: 10 })).toEqual([0.5, 1]);
  expect(at({ width: 120, height: 12 })).toEqual([0.5, 1]);       // long but thin
  // Under 10px on its long side the divisor is 3, not 2.
  const [tinyArtist, tinyCartoonist] = at({ width: 8, height: 8 });
  expect(tinyArtist).toBeCloseTo(1 / 3, 10);
  expect(tinyCartoonist).toBeCloseTo(2 / 3, 10);
  // The escapes: a rounded shape at 15px+, and a linear element at 50px+.
  expect(at({ width: 40, height: 16, roundness: { type: 3 } })).toEqual([1, 2]);
  expect(at({ width: 40, height: 14, roundness: { type: 3 } })).toEqual([0.5, 1]);
  expect(at({ type: "line", width: 60, height: 4 })).toEqual([1, 2]);
  expect(at({ type: "arrow", width: 40, height: 4 })).toEqual([0.5, 1]);
  // Freedraw is *not* linear — upstream has the `|| freedraw` clause written
  // out and commented off (typeChecks.ts:156).
  expect(at({ type: "freedraw", width: 60, height: 4 })).toEqual([0.5, 1]);
  // And the damping is capped, so a file with an out-of-range roughness can't
  // produce an arbitrarily rough tiny shape.
  expect(adjustedRoughness({ type: "rectangle", roughness: 40, width: 8, height: 8 })).toBe(2.5);
});

test("seed 0 becomes 1, or Rough re-rolls the shape on every repaint", () => {
  // Rough's `this.seed ? … : Math.random()` means seed 0 is "no seed", and a
  // shape that re-scrambles per frame is the one thing this renderer promises
  // not to do. The core can't mint a 0, but a hand-authored file can.
  expect(roughOptions(rect({ seed: 0 })).seed).toBe(1);
  expect(roughOptions(rect({ seed: undefined })).seed).toBe(1);
  expect(roughOptions(rect({ seed: 12345 })).seed).toBe(12345);
});

test("an ellipse pins curveFitting, so it stops shrinking as roughness rises", () => {
  // Rough's default 0.95 is spent on `rx += randOffset(rx * (1 - curveFitting))`
  // (shape.ts:237-239). Ellipses only — nothing else sets it.
  expect(roughOptions(rect({ type: "ellipse" })).curveFitting).toBe(1);
  expect(roughOptions(rect()).curveFitting).toBeUndefined();
  expect(roughOptions(rect({ type: "line" })).curveFitting).toBeUndefined();
});

// --- dark mode --------------------------------------------------------------

test("dark mode is off unless asked for, and then it is a per-colour transform", () => {
  // Excalidraw's dark theme rewrites every element colour through
  // invert(93%) hue-rotate(180deg) (colors.ts:62-122) rather than swapping
  // palettes, so a dark-authored file holds the light colours and both themes
  // are the same document.
  expect(applyDarkModeFilter("#1e1e1e", false)).toBe("#1e1e1e");
  // Grey stays grey: each row of the 180deg matrix sums to 1.
  expect(applyDarkModeFilter("#1e1e1e", true)).toBe("#d3d3d3");
  expect(applyDarkModeFilter("#ffffff", true)).toBe("#121212");
  // And a hue survives as its light counterpart rather than as mud.
  expect(applyDarkModeFilter("#e03131", true)).toBe("#ff8383");
});

test("the CSS spelling of the theme filter is the one the renderer applies", () => {
  // The colour previews in the panel and the picker are filtered by CSS rather
  // than recomputed, so this string and `applyDarkModeFilter` have to be the
  // same transform. A swatch drifting from the canvas is the bug the whole
  // preview exists to fix.
  expect(THEME_FILTER).toBe("invert(93%) hue-rotate(180deg)");
});

test("dark mode keeps alpha, and leaves a colour it cannot read alone", () => {
  expect(applyDarkModeFilter("#1e1e1e80", true)).toBe("#d3d3d380");
  expect(applyDarkModeFilter("rgb(30, 30, 30)", true)).toBe("#d3d3d3");
  expect(applyDarkModeFilter("rgba(30, 30, 30, 0.5)", true)).toBe("#d3d3d380");
  // Wrong is worse than unfiltered: a CSS keyword or anything else this can't
  // parse comes back untouched rather than guessed at.
  expect(applyDarkModeFilter("transparent", true)).toBe("transparent");
  expect(applyDarkModeFilter("rebeccapurple", true)).toBe("rebeccapurple");
});

test("the option mapping carries dark mode into stroke and fill", () => {
  const o = roughOptions(rect({ backgroundColor: "#ffffff" }), { isDarkMode: true });
  expect(o.stroke).toBe("#d3d3d3");
  expect(o.fill).toBe("#121212");
  const light = roughOptions(rect({ backgroundColor: "#ffffff" }));
  expect(light.stroke).toBe("#1e1e1e");
  expect(light.fill).toBe("#ffffff");
});

test("opacity converts from the file's 0-100 to canvas' 0-1", () => {
  expect(opacityOf(rect())).toBe(1);
  expect(opacityOf(rect({ opacity: 30 }))).toBe(0.3);
  expect(opacityOf(rect({ opacity: 999 }))).toBe(1);
  expect(opacityOf(rect({ opacity: undefined }))).toBe(1);
});

// --- the property that makes this worth doing -------------------------------

test("the same seed draws the same shape every time", () => {
  // Rough.js is deterministic per seed, and every element carries one — so a
  // file renders identically on every open, and the same as in Excalidraw.
  const g = rough.generator();
  const opts = roughOptions(rect());
  const a = g.rectangle(10, 20, 100, 50, opts);
  const b = g.rectangle(10, 20, 100, 50, opts);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("a different seed draws a different shape", () => {
  const g = rough.generator();
  const a = g.rectangle(10, 20, 100, 50, roughOptions(rect({ seed: 1 })));
  const b = g.rectangle(10, 20, 100, 50, roughOptions(rect({ seed: 2 })));
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
});

test("the mapped options are ones Rough.js actually accepts", () => {
  // Guards the port against drift in either direction: a bad option would
  // either throw here or silently stop affecting the drawing.
  const g = rough.generator();
  const d = g.rectangle(0, 0, 50, 50, roughOptions(rect({
    backgroundColor: "#b2f2bb", fillStyle: "cross-hatch", strokeStyle: "dotted", strokeWidth: 3,
  })));
  expect(d.sets.length).toBeGreaterThan(0);
  expect(d.options.fill).toBe("#b2f2bb");
});

// --- images -----------------------------------------------------------------

test("an embedded image resolves to its data URL", () => {
  const files = { abc: { dataURL: "data:image/png;base64,iVBOR" } };
  expect(imageDataUrl({ fileId: "abc" }, files)).toBe("data:image/png;base64,iVBOR");
});

test("an image whose bytes the file didn't embed resolves to null", () => {
  // Excalidraw can save a scene whose images live in its own backend.
  expect(imageDataUrl({ fileId: "abc" }, {})).toBeNull();
  expect(imageDataUrl({ fileId: "abc" }, { abc: { dataURL: "https://example.com/x.png" } })).toBeNull();
  expect(imageDataUrl({}, {})).toBeNull();
});

// --- text -------------------------------------------------------------------

test("the hand-drawn families map to a handwriting stack, not a sans one", () => {
  // A diagram set in Helvetica reads as a different document.
  expect(fontString({ fontSize: 20, fontFamily: 1 })).toContain("cursive");
  expect(fontString({ fontSize: 20, fontFamily: 5 })).toContain("cursive");
  expect(fontString({ fontSize: 16, fontFamily: 2 })).toContain("Helvetica");
  expect(fontString({ fontSize: 16, fontFamily: 3 })).toContain("monospace");
});

test("font size leads the shorthand so canvas can parse it", () => {
  expect(fontString({ fontSize: 28, fontFamily: 1 }).startsWith("28px ")).toBe(true);
});

test("line height is a multiplier, and older files that omit it still lay out", () => {
  expect(lineHeightPx({ fontSize: 20, lineHeight: 1.25 })).toBe(25);
  expect(lineHeightPx({ fontSize: 20 })).toBe(25);
});

test("each line is centred in its own slot, so total height is lines x lineHeight", () => {
  const l = textLayout({ x: 0, y: 0, width: 100, text: "a\nb", fontSize: 20, lineHeight: 1.25 });
  expect(l.lines.map((n) => n.y)).toEqual([12.5, 37.5]);
});

test("alignment moves the anchor to the edge canvas measures from", () => {
  const base = { x: 10, y: 0, width: 100, text: "x", fontSize: 20 };
  expect(textLayout({ ...base, textAlign: "left" }).lines[0].x).toBe(10);
  expect(textLayout({ ...base, textAlign: "center" }).lines[0].x).toBe(60);
  expect(textLayout({ ...base, textAlign: "right" }).lines[0].x).toBe(110);
});

test("CRLF text doesn't render a stray blank line per row", () => {
  expect(textLayout({ x: 0, y: 0, width: 10, text: "a\r\nb", fontSize: 10 }).lines).toHaveLength(2);
});

// --- coverage ---------------------------------------------------------------

test("the drawable set is what the renderer switches on", () => {
  for (const t of ["rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "image", "frame"]) {
    expect(isDrawn({ type: t })).toBe(true);
  }
  // Live web views in Excalidraw; a placeholder box here.
  expect(isDrawn({ type: "embeddable" })).toBe(false);
  expect(isDrawn({ type: "iframe" })).toBe(false);
  expect(isDrawn(null)).toBe(false);
});
