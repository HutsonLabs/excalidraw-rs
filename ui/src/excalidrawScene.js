// Reading .excalidraw files: parse, normalize, and translate an Excalidraw
// element into the options its renderer would have used.
//
// Why we can render these at all without Excalidraw: an .excalidraw file is
// JSON, and the hand-drawn look isn't Excalidraw's — it's Rough.js, plus
// perfect-freehand for pencil strokes. Both are framework-free and vendored
// (ui/vendor/roughjs, ui/vendor/perfect-freehand, 32 KB together). Excalidraw
// itself is a React application; pulling it in would have meant React, a
// bundler this frontend doesn't have, and ~3.9 MB. So we read the format with
// the same primitives that wrote it.
//
// Every element carries a `seed`, and Rough.js is deterministic for a given
// seed — so a file renders identically on every open, and the same as it does
// in Excalidraw proper. That's the property that makes this worth doing
// rather than approximating.
//
// Pure: no DOM, no canvas. excalidrawView.js does the drawing, and everything
// here is pinned in ui/test/excalidrawScene.test.js (Rough.js' generator runs
// headlessly, so the option mapping is testable for real).
//
// --- On borrowed time -------------------------------------------------------
//
// Copied from term.hut unchanged, and most of it stays that way: the format
// reading (parseScene, visibleElements, isDrawn), the Excalidraw property port
// (roughOptions, strokeDash, opacityOf, imageDataUrl) and the text layout are
// what the painter needs and nothing else has an opinion about.
//
// Four functions are not staying. `elementBounds`, `sceneBounds`,
// `fitTransform` and `cornerRadius` (with its `cornerRadiusFor` rule, which the
// rounded diamond needs per axis) are geometry, and geometry belongs to
// xd-core (PLAN.md Phase 2) — because once the editor can move a shape, the
// model has to agree with the painter about where that shape *is*, and two
// implementations of "where" is a bug waiting for a rotation. Phase 2 ports
// these rules rather than inventing new ones, precisely so the answer can't
// drift; the bun tests below them are the safety net while it happens, and
// deleting these four is the proof the port was faithful.
//
// Until then they are the only copy and they are correct. Do not fork them,
// do not "improve" them — a divergence here would be inherited by the Rust
// port and silently become the new truth.

/// Excalidraw's own constants, from its source. Named here so the arithmetic
/// below reads as the port it is rather than as magic numbers.
const DEFAULT_ADAPTIVE_RADIUS = 32;
const DEFAULT_PROPORTIONAL_RADIUS = 0.25;
const ROUNDNESS_PROPORTIONAL = 2; // legacy
const ROUNDNESS_ADAPTIVE = 3;
/// ROUGHNESS.cartoonist — at or above this, Rough.js is allowed to wander off
/// the vertices, which is what makes the sketchiest setting look sketchy.
const ROUGHNESS_CARTOONIST = 2;
/// LINE_CONFIRM_THRESHOLD (constants.ts:21) — how near its own start a path's
/// end has to land before Excalidraw calls it a loop and fills it.
const LINE_CONFIRM_THRESHOLD = 8;
/// The invert/hue-rotate pair Excalidraw's dark theme is defined as
/// (colors.ts:16-17).
const DARK_MODE_INVERT_PERCENT = 93;
const DARK_MODE_HUE_ROTATE_DEGREES = 180;

/// The same pair written as a CSS `filter` list, for the parts of the UI that
/// have to *preview* a colour rather than paint it — a swatch that claims to
/// show what the canvas will show. Built from the constants above rather than
/// spelled out again: a preview that drifts from the renderer is worse than no
/// preview, because it is a confident wrong answer to "what colour is this?".
export const THEME_FILTER =
  `invert(${DARK_MODE_INVERT_PERCENT}%) hue-rotate(${DARK_MODE_HUE_ROTATE_DEGREES}deg)`;

/// The shapes we draw. Anything else in a file (embeddables, iframes, magic
/// frames) is a live web view in Excalidraw and can't be anything here, so it
/// renders as a labelled placeholder instead of vanishing silently.
const DRAWN = new Set([
  "rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "image", "frame",
]);

/// Excalidraw's own type predicates, because three separate rules below key off
/// them and each one is a different set. Ports of typeChecks.ts:152-158 and
/// comparisons.ts:49-55.
///
/// `isLinear` is line and arrow only — *not* freedraw. Upstream has the
/// `|| freedraw` clause written out and commented off (typeChecks.ts:156), and
/// the difference is load-bearing for adjustedRoughness below.
const isLinear = (type) => type === "arrow" || type === "line";
const canChangeRoundness = (type) =>
  type === "rectangle" || type === "iframe" || type === "embeddable"
  || type === "line" || type === "diamond" || type === "image";
/// The types generateRoughOptions fills unconditionally (shape.ts:225-241).
/// A line or freedraw fills only when its path closes; an arrow never does.
const isFillableShape = (type) =>
  type === "rectangle" || type === "iframe" || type === "embeddable"
  || type === "diamond" || type === "ellipse";

/// Fonts. We don't vendor Excalidraw's (13 MB, most of it a CJK handwriting
/// face), so each family maps to the nearest stack the machine already has.
/// The hand-drawn faces matter most — a diagram set in Helvetica reads as a
/// different document — and macOS ships Chalkboard, which is close.
const FONTS = {
  1: "handwriting", // Virgil, the classic default
  2: "sans", // Helvetica
  3: "mono", // Cascadia
  4: "sans", // "Local Font"
  5: "handwriting", // Excalifont, the modern default
  6: "sans", // Nunito
  7: "handwriting", // Lilita One
  8: "handwriting", // Comic Shanns
  9: "sans", // Liberation Sans
};

const STACKS = {
  handwriting: '"Excalifont", "Virgil", "Chalkboard SE", "Comic Sans MS", cursive',
  sans: '"Nunito", "Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: '"Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
};

/// The CSS font shorthand for a text element.
export function fontString(element) {
  const size = num(element.fontSize, 20);
  const family = STACKS[FONTS[element.fontFamily] ?? "handwriting"];
  return `${size}px ${family}`;
}

/// Excalidraw stores lineHeight as a unitless multiplier (1.25 for the
/// hand-drawn faces). Older files omit it.
export const lineHeightPx = (element) =>
  num(element.fontSize, 20) * num(element.lineHeight, 1.25);

const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/// Parse a .excalidraw file.
///
/// Returns `{ ok: true, elements, appState, files }`, or `{ ok: false, error }`
/// with a sentence fit to show in the pane — a half-written file mid-save is a
/// normal thing to open, not a crash.
export function parseScene(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ""));
  } catch (e) {
    return { ok: false, error: `This file isn't valid JSON (${e.message}).` };
  }
  if (!doc || typeof doc !== "object") {
    return { ok: false, error: "This file doesn't contain an Excalidraw scene." };
  }
  // `type` is "excalidraw" for a scene and "excalidrawlib" for a shape library;
  // a library has `libraryItems` instead of elements and isn't a drawing.
  if (doc.type && doc.type !== "excalidraw") {
    return { ok: false, error: `This is an Excalidraw "${doc.type}" file, not a scene.` };
  }
  if (!Array.isArray(doc.elements)) {
    return { ok: false, error: "This scene has no elements array." };
  }
  return {
    ok: true,
    elements: visibleElements(doc.elements),
    appState: doc.appState && typeof doc.appState === "object" ? doc.appState : {},
    files: doc.files && typeof doc.files === "object" ? doc.files : {},
  };
}

/// Deleted elements stay in the file (Excalidraw keeps them for undo and for
/// merging edits from another client) and must not be drawn.
export function visibleElements(elements) {
  return (Array.isArray(elements) ? elements : []).filter(
    (e) => e && typeof e === "object" && !e.isDeleted && typeof e.type === "string",
  );
}

/// True when we have a drawing routine for this element's type.
export const isDrawn = (element) => DRAWN.has(element?.type);

/// A linear element's points are relative to its x/y; everything else is
/// bounded by x/y/width/height. Returns null for an element with no extent.
export function elementBounds(element) {
  const x = num(element.x);
  const y = num(element.y);
  if (Array.isArray(element.points) && element.points.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of element.points) {
      if (!Array.isArray(p)) continue;
      const px = x + num(p[0]);
      const py = y + num(p[1]);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }
  const w = num(element.width);
  const h = num(element.height);
  // Negative extents are legal (a shape dragged up and to the left).
  return {
    minX: Math.min(x, x + w),
    minY: Math.min(y, y + h),
    maxX: Math.max(x, x + w),
    maxY: Math.max(y, y + h),
  };
}

/// The box every element fits in, in scene coordinates. Null for an empty
/// scene, which the caller shows as "nothing to draw" rather than dividing by
/// zero working out a fit.
export function sceneBounds(elements) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of elements) {
    const b = elementBounds(e);
    if (!b) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/// Scale and offset that fit `bounds` into `viewport` with a margin, capped at
/// 1:1 — blowing a small sketch up to fill a wide pane looks like a bug.
export function fitTransform(bounds, viewport, padding = 32) {
  const vw = Math.max(0, num(viewport?.width) - padding * 2);
  const vh = Math.max(0, num(viewport?.height) - padding * 2);
  if (!bounds || vw <= 0 || vh <= 0) return { scale: 1, offsetX: padding, offsetY: padding };
  // A zero-width scene (a single vertical line) must not divide by zero.
  const sx = bounds.width > 0 ? vw / bounds.width : Infinity;
  const sy = bounds.height > 0 ? vh / bounds.height : Infinity;
  const scale = Math.min(1, sx, sy) || 1;
  return {
    scale,
    offsetX: padding + (vw - bounds.width * scale) / 2 - bounds.minX * scale,
    offsetY: padding + (vh - bounds.height * scale) / 2 - bounds.minY * scale,
  };
}

/// The dash pattern for a non-solid stroke — Excalidraw's getDashArrayDashed /
/// getDashArrayDotted, which scale with the stroke so a thick dashed line
/// doesn't close up into a solid one.
export function strokeDash(strokeStyle, strokeWidth) {
  const w = num(strokeWidth, 1);
  if (strokeStyle === "dashed") return [8, 8 + w];
  if (strokeStyle === "dotted") return [1.5, 6 + w];
  return undefined;
}

/// The corner radius of a rounded rectangle, ported from Excalidraw's
/// getCornerRadius. Two schemes: legacy files scale the radius with the shape,
/// current ones use a fixed radius until the shape gets small enough that it
/// would look wrong, then fall back to proportional.
/// getCornerRadius takes an arbitrary length, not the shape's short side: a
/// rounded diamond needs one radius per axis (shape.ts:827-834), so the rule and
/// the "which length" question are two functions rather than one.
export function cornerRadiusFor(x, element) {
  const r = element?.roundness;
  if (!r) return 0;
  if (r.type === ROUNDNESS_PROPORTIONAL) return x * DEFAULT_PROPORTIONAL_RADIUS;
  if (r.type !== ROUNDNESS_ADAPTIVE) return 0;
  const fixed = num(r.value, DEFAULT_ADAPTIVE_RADIUS);
  const cutoff = fixed / DEFAULT_PROPORTIONAL_RADIUS;
  return x <= cutoff ? x * DEFAULT_PROPORTIONAL_RADIUS : fixed;
}

/// The radius a rounded *rectangle* gets: the rule above applied to the short
/// side, which is what Excalidraw passes for a box (shape.ts:775).
export function cornerRadius(element) {
  return cornerRadiusFor(
    Math.min(Math.abs(num(element?.width)), Math.abs(num(element?.height))),
    element,
  );
}

/// True when a linear path comes back to where it started, which is the only
/// case Excalidraw fills a line or a pencil stroke (utils.ts:510-524). An arrow
/// is never filled, whatever its points do.
export function isPathALoop(points, tolerance = LINE_CONFIRM_THRESHOLD) {
  if (!Array.isArray(points) || points.length < 3) return false;
  const first = points[0];
  const last = points[points.length - 1];
  if (!Array.isArray(first) || !Array.isArray(last)) return false;
  return Math.hypot(num(last[0]) - num(first[0]), num(last[1]) - num(first[1])) <= tolerance;
}

// --- dark mode ---------------------------------------------------------------
//
// Excalidraw's dark theme is not a second palette: every element colour is put
// through the transform `filter: invert(93%) hue-rotate(180deg)` describes,
// per colour, in JS (colors.ts:62-122). So a file authored in dark mode holds
// the *light* colours and both themes are the same document — which is exactly
// why this has to be a port and not an approximation. Painting elements at
// their literal colours makes a dark-authored diagram look right here and
// wrong on excalidraw.com, or the reverse.

/// #RRGGBB (or #RRGGBBAA when the colour carries alpha), the way Excalidraw
/// writes colours back out (colors.ts:329-345).
const rgbToHex = (r, g, b, a) => {
  const hex6 = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  if (a === undefined || a >= 1) return hex6;
  return `${hex6}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/// `[r, g, b, a]` with r/g/b in 0–255 and a in 0–1, or null for a colour we
/// can't read. Excalidraw parses with tinycolor; the formats that actually
/// reach a file are hex and — because this repo's own picker can emit them
/// (colorpicker.js:103-114) — the rgb()/rgba() functions.
function parseColor(input) {
  const s = String(input ?? "").trim();
  if (!s || s.toLowerCase() === "transparent") return null;
  const hex = /^#([0-9a-f]+)$/i.exec(s);
  if (hex) {
    const h = hex[1];
    const wide = h.length === 3 || h.length === 4;
    if (!wide && h.length !== 6 && h.length !== 8) return null;
    const at = (i) => parseInt(wide ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16);
    const hasAlpha = wide ? h.length === 4 : h.length === 8;
    return [at(0), at(1), at(2), hasAlpha ? at(3) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (!fn) return null;
  // Both the legacy comma form and the modern `r g b / a` one.
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const chan = (v) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v));
  const rgb = parts.slice(0, 3).map(chan);
  if (rgb.some((v) => !Number.isFinite(v))) return null;
  const raw = parts[3] === undefined ? 1
    : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return [
    ...rgb.map((v) => Math.round(clamp(v, 0, 255))),
    Number.isFinite(raw) ? clamp(raw, 0, 1) : 1,
  ];
}

/// `invert(p%)` on one channel: the CSS blend, not a flip (colors.ts:62-85).
const invertChannel = (c, p) => Math.round(clamp(c * (1 - p) + (255 - c) * p, 0, 255));

/// `hue-rotate(deg)`, the feColorMatrix the filter spec defines, applied in
/// sRGB the way the CSS shorthand does (colors.ts:19-60).
function hueRotate(red, green, blue, degrees) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const out = [
    r * m[0] + g * m[1] + b * m[2],
    r * m[3] + g * m[4] + b * m[5],
    r * m[6] + g * m[7] + b * m[8],
  ];
  return out.map((v) => Math.round(clamp(v, 0, 1) * 255));
}

/// Memoised, like Excalidraw's (colors.ts:12-14): the option mapping runs for
/// every element on every frame, and there are only ever a handful of colours
/// in a drawing.
const darkModeCache = new Map();

/// The colour Excalidraw's dark theme would have painted `color` as.
///
/// A colour this can't parse — a CSS keyword, a gradient — comes back unchanged.
/// Leaving it alone is worse than filtering it and better than guessing.
export function applyDarkModeFilter(color, isDarkMode = true) {
  if (!isDarkMode) return color;
  const cached = darkModeCache.get(color);
  if (cached !== undefined) return cached;
  const rgba = parseColor(color);
  let out = color;
  if (rgba) {
    // Order matters: invert, then rotate. That is the order the CSS filter
    // list runs in, and the two do not commute.
    const p = clamp(DARK_MODE_INVERT_PERCENT, 0, 100) / 100;
    const [r, g, b] = hueRotate(
      invertChannel(rgba[0], p), invertChannel(rgba[1], p), invertChannel(rgba[2], p),
      DARK_MODE_HUE_ROTATE_DEGREES,
    );
    out = rgbToHex(r, g, b, rgba[3]);
  }
  darkModeCache.set(color, out);
  return out;
}

/// Excalidraw's `isTransparent` (colors.ts:373): a colour with no alpha at all.
///
/// Which is to say "no fill" — the thing that decides whether a shape's inside
/// is a surface or a hole. It is what upstream asks before it will put a label
/// in a box a double-click landed inside (App.tsx:7230): a filled box counts
/// anywhere in it, an empty one only where the pointer touched the shape itself,
/// because an empty box is something you click *through*.
///
/// Note the asymmetry, which is upstream's: the keyword `transparent` and a
/// zero-alpha colour are transparent, and a colour nothing can parse is not.
/// A colour we cannot read is more likely a fill we do not understand than no
/// fill at all, and guessing "no fill" would silently stop labels working on it.
export function isTransparent(color) {
  const s = String(color ?? "").trim();
  if (!s || s.toLowerCase() === "transparent") return true;
  const rgba = parseColor(s);
  return rgba ? rgba[3] === 0 : false;
}

/// The Rough.js options Excalidraw would have drawn this element with — a port
/// of its generateRoughOptions(). Getting this right is most of the fidelity:
/// the same seed with different options is still a different drawing.
/// Excalidraw's adjustRoughness (shape.ts:171-191): a small shape at Cartoonist
/// looks wrecked rather than sketchy, because Rough's wander is an absolute
/// number of pixels and a 30x10 box has no pixels to spare. So the roughness a
/// small element is drawn with is damped by its size.
///
/// The three escapes are upstream's: both sides comfortably big, or a rounded
/// shape at least 15px on its short side (which is why Excalidraw's rounded
/// rectangles keep their full sketchiness), or a linear element long enough to
/// carry it.
export function adjustedRoughness(element) {
  const roughness = num(element?.roughness, 1);
  const w = Math.abs(num(element?.width));
  const h = Math.abs(num(element?.height));
  const maxSize = Math.max(w, h);
  const minSize = Math.min(w, h);
  if (
    (minSize >= 20 && maxSize >= 50)
    || (minSize >= 15 && !!element?.roundness && canChangeRoundness(element?.type))
    || (isLinear(element?.type) && maxSize >= 50)
  ) {
    return roughness;
  }
  return Math.min(roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

export function roughOptions(element, { continuousPath = false, isDarkMode = false } = {}) {
  const strokeWidth = num(element.strokeWidth, 1);
  const solid = element.strokeStyle === "solid" || element.strokeStyle == null;
  const roughness = num(element.roughness, 1);
  const options = {
    // Rough falls back to Math.random() on seed 0 (`this.seed ? … :
    // Math.random()`), which re-scrambles the shape on every repaint. The core
    // can't mint a 0, but a hand-authored file can.
    seed: num(element.seed, 1) || 1,
    strokeLineDash: strokeDash(element.strokeStyle, strokeWidth),
    // A dashed line drawn twice (Rough's default) smears its gaps shut.
    disableMultiStroke: !solid,
    strokeWidth: solid ? strokeWidth : strokeWidth + 0.5,
    fillWeight: strokeWidth / 2,
    hachureGap: strokeWidth * 4,
    roughness: adjustedRoughness(element),
    stroke: applyDarkModeFilter(element.strokeColor || "#1e1e1e", isDarkMode),
    // Let the sketchiest setting actually miss the corners; keep the tidier
    // ones anchored, or long paths drift visibly away from their endpoints.
    //
    // Keyed off the *raw* roughness, not the damped one: shape.ts:221 computes
    // the adjusted value for `roughness` and :224 compares the untouched field,
    // so a small shape whose roughness was halved to 1 still gets to wander.
    preserveVertices: continuousPath || roughness < ROUGHNESS_CARTOONIST,
  };

  // Which elements get a fill is per-type, not "does it have a background"
  // (shape.ts:225-256). A background colour on an arrow fills nothing in
  // Excalidraw, and on a line only when the line closes on itself — so
  // honouring it everywhere paints shapes that exist in no other renderer.
  const opaque = element.backgroundColor && element.backgroundColor !== "transparent";
  const type = element.type;
  const loop = (type === "line" || type === "freedraw") && isPathALoop(element.points);
  // Upstream's switch throws on a type it doesn't list; a renderer can't, so an
  // unrecognised type keeps the old permissive rule rather than losing its fill.
  const known = isFillableShape(type) || type === "line" || type === "freedraw" || type === "arrow";
  if (isFillableShape(type) || loop || !known) {
    options.fillStyle = element.fillStyle || "hachure";
    if (opaque) options.fill = applyDarkModeFilter(element.backgroundColor, isDarkMode);
  }
  if (type === "ellipse") {
    // Rough's default curveFitting is 0.95, and it spends the slack on
    // `rx += randOffset(rx * (1 - curveFitting))` — so an unpinned ellipse
    // shrinks as roughness rises and pulls inside its own selection box
    // (shape.ts:237-239).
    options.curveFitting = 1;
  }
  return options;
}

/// Element opacity is 0–100 in the file; canvas wants 0–1.
export const opacityOf = (element) => Math.max(0, Math.min(100, num(element.opacity, 100))) / 100;

/// The image bytes for an image element, or null when the file didn't embed
/// them (Excalidraw can save a scene whose images live in its own backend).
export function imageDataUrl(element, files) {
  const entry = element?.fileId && files ? files[element.fileId] : null;
  const url = entry?.dataURL;
  return typeof url === "string" && url.startsWith("data:") ? url : null;
}

/// What kind of picture an image element's bytes are, lowercased, or "".
///
/// The painter needs it for one decision and one only — whether the dark theme
/// applies to this image (see `drawImage`) — and it is asked of the *file map*
/// rather than of the element, because `mimeType` is a property of the bytes.
/// A file the map has never heard of answers "", which reads as "not an SVG"
/// and is the right answer for a picture nobody can see.
export function imageMimeType(element, files) {
  const entry = element?.fileId && files ? files[element.fileId] : null;
  return String(entry?.mimeType ?? "").trim().toLowerCase();
}

/// Where each line of a text element's baseline sits, and how to align it.
/// Excalidraw's own renderer leans on a `baseline` field that current versions
/// no longer write, so lines are centred in their own slot instead: it needs
/// no font metrics, and total height stays lines × lineHeight either way.
export function textLayout(element) {
  const text = typeof element.text === "string" ? element.text : "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const lh = lineHeightPx(element);
  const align = element.textAlign === "center" ? "center"
    : element.textAlign === "right" ? "right" : "left";
  const x = num(element.x) + (align === "center" ? num(element.width) / 2
    : align === "right" ? num(element.width) : 0);
  return {
    align,
    lines: lines.map((line, i) => ({ text: line, x, y: num(element.y) + i * lh + lh / 2 })),
  };
}
