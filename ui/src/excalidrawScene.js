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
// `fitTransform` and `cornerRadius` are geometry, and geometry belongs to
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

/// The shapes we draw. Anything else in a file (embeddables, iframes, magic
/// frames) is a live web view in Excalidraw and can't be anything here, so it
/// renders as a labelled placeholder instead of vanishing silently.
const DRAWN = new Set([
  "rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "image", "frame",
]);

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
export function cornerRadius(element) {
  const r = element?.roundness;
  if (!r) return 0;
  const x = Math.min(Math.abs(num(element.width)), Math.abs(num(element.height)));
  if (r.type === ROUNDNESS_PROPORTIONAL) return x * DEFAULT_PROPORTIONAL_RADIUS;
  if (r.type !== ROUNDNESS_ADAPTIVE) return 0;
  const fixed = num(r.value, DEFAULT_ADAPTIVE_RADIUS);
  const cutoff = fixed / DEFAULT_PROPORTIONAL_RADIUS;
  return x <= cutoff ? x * DEFAULT_PROPORTIONAL_RADIUS : fixed;
}

/// The Rough.js options Excalidraw would have drawn this element with — a port
/// of its generateRoughOptions(). Getting this right is most of the fidelity:
/// the same seed with different options is still a different drawing.
export function roughOptions(element, { continuousPath = false } = {}) {
  const strokeWidth = num(element.strokeWidth, 1);
  const solid = element.strokeStyle === "solid" || element.strokeStyle == null;
  const roughness = num(element.roughness, 1);
  const options = {
    seed: num(element.seed, 1),
    strokeLineDash: strokeDash(element.strokeStyle, strokeWidth),
    // A dashed line drawn twice (Rough's default) smears its gaps shut.
    disableMultiStroke: !solid,
    strokeWidth: solid ? strokeWidth : strokeWidth + 0.5,
    fillWeight: strokeWidth / 2,
    hachureGap: strokeWidth * 4,
    roughness,
    stroke: element.strokeColor || "#1e1e1e",
    // Let the sketchiest setting actually miss the corners; keep the tidier
    // ones anchored, or long paths drift visibly away from their endpoints.
    preserveVertices: continuousPath || roughness < ROUGHNESS_CARTOONIST,
  };
  if (element.backgroundColor && element.backgroundColor !== "transparent") {
    options.fill = element.backgroundColor;
    options.fillStyle = element.fillStyle || "hachure";
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
