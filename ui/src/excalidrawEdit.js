// The `.excalidraw` editor, as a portable view.
//
//   renderExcalidraw(host, text, { onSave, onActions }) -> dispose
//
// That signature is `bpmnView.js`'s, deliberately and down to the argument
// names, because term.hut already has a preview pane that speaks it and the
// whole point of PLAN.md's ordering is that Phase 8 is a copy rather than an
// unpicking. Everything that follows is shaped to fit it: an 800 ms idle
// autosave, a `worthSaving` guard in front of every write, Fit and Save
// contributed to the pane's header instead of a toolbar of our own, and a
// dispose that leaves nothing running.
//
// **This file may not know where it is.** No import from `standalone/`, no
// `invoke`, no `window.__TAURI__`, and nothing outside the `host` element it
// was handed. That is not a style rule — it is the reason the port is cheap,
// and `scripts/check-imports.mjs` fails the build on any of the three. If it
// ever fails and the fix looks like widening the allowlist, PLAN.md's risk
// list is about exactly that moment.
//
// ## How the pieces divide
//
//   xdWasm.js           the document. The *only* thing that mutates a
//                       drawing, and the only thing that knows where an
//                       element is. This file holds no model.
//   excalidrawTools.js  the decisions. What a pointerdown means, what a key
//                       means, how far a drag has to travel. No DOM, no
//                       document, so it is testable on its own.
//   excalidrawView.js   the paintbrush. Shapes and chrome, both.
//   excalidrawDoc.js    whether a serialization is safe to write, and what a
//                       new shape is styled with.
//   this file           events in, intents out of the tools, calls into the
//                       document, a repaint on the next frame. It should read
//                       as glue, and where it stops reading as glue there is
//                       usually a decision that belongs in one of the four.
//
// ## Two rules the painting obeys
//
// **Never repaint synchronously in an event handler.** Every path ends in
// `schedule()`, which coalesces to one `requestAnimationFrame`. A pointermove
// that painted inline would paint three times per frame on a fast trackpad and
// the drag would feel *slower* for it.
//
// **Never re-fetch the whole scene.** `doc.elements()` looks like it does
// that; it does not. xdWasm.js memoizes each element on `(index, version)`, so
// a frame in which one shape moved costs one serialization across the wasm
// boundary and not a hundred. The way to break that is to keep our own copy of
// the elements and let it go stale, so we keep none.
//
// ## Where the model wins
//
// Anywhere the painter and `xd-core` could disagree about a coordinate, the
// model is right. Handles are hit-tested with `doc.handleAt` and drawn from
// `doc.selectionBounds()` with no padding, so the thing you can grab and the
// thing you can see are derived from one number. The one place they measure
// differently is called out where it happens.

import rough from "../vendor/roughjs/rough.esm.js";
import { div, el } from "./dom.js";
import { openDoc } from "./xdWasm.js";
import {
  chromeTheme, drawElement, drawHandles, drawMarquee, drawPointHandles, drawSelectionOutline,
  drawSnapGuides, HANDLE_SIZE, HANDLES,
} from "./excalidrawView.js";
import { fontString, imageDataUrl, lineHeightPx, opacityOf } from "./excalidrawScene.js";
import {
  clipboardText, drawingSource, fileStyle, openMessage, parseClipboard, strokeWidthPx,
  stylePatch, styleFor, styleFrom, textBox, worthSaving, DEFAULT_STYLE, mergeStyle,
} from "./excalidrawDoc.js";
import {
  afterDraw, cursorFor, isPressureDevice, keyIntent, newToolState, passedThreshold,
  pointerIntent, pressureOf, toolLabel, wheelIntent, HIT_SLOP, MIN_DRAW_SIZE, REORDER,
  ROTATE_SNAP, TOOLS,
} from "./excalidrawTools.js";
import { renderToolbar } from "./excalidrawToolbar.js";

/// The same idle window as `bpmnView.js`, and the same one `xd-core` coalesces
/// undo entries on. A pause long enough to end an undo step is a pause long
/// enough to save, so the two feel like one app because they are timed like
/// one app.
const AUTOSAVE_MS = 800;

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

/// Where a paste lands relative to where it was copied from. Enough that the
/// copy is visibly not the original, matching `duplicateSelection`'s default.
const PASTE_OFFSET = 10;

/// How close two edges have to be, in *screen* pixels, before a drag snaps them
/// level and draws a guide. Screen rather than scene for the same reason
/// `DRAG_THRESHOLD` is: it is a property of the hand, not of the zoom.
const SNAP_THRESHOLD = 5;

/// How faint an element goes while the eraser is over it but the sweep has not
/// been let go of yet. Excalidraw dims rather than removes, so a sweep that
/// caught something by accident can be undone by leaving the button held and
/// nothing has happened to the document yet.
const ERASE_PREVIEW = 0.25;

/// How much of the pane an inserted image leaves clear on each side, in scene
/// units. A phone photograph dropped at its natural size is four thousand units
/// of drawing nobody asked for.
const IMAGE_MARGIN = 16;

/// The margin an export leaves around the drawing, in scene units.
/// Excalidraw's `DEFAULT_EXPORT_PADDING`.
const EXPORT_PADDING = 10;

/// How much bigger than scene units a PNG export is by default. Excalidraw
/// offers 1×/2×/3× and defaults to 1; 2 is here because a diagram exported at 1×
/// looks soft on every screen made in the last decade.
const EXPORT_SCALE = 2;

/// The shapes a double-click asks for text on: Excalidraw's
/// `isTextBindableContainer`, and exactly what `bindLabel` will accept.
///
/// A line, an image and a frame are deliberately not here even though they look
/// like containers. `bindLabel` declines them, so offering the gesture would
/// create a free-floating text element over the shape and call it a label —
/// which is the exact bug double-clicking a shape used to have.
const LABELABLE = new Set(["rectangle", "diamond", "ellipse", "arrow"]);

/// The subset of those with an *interior* worth double-clicking into.
///
/// An arrow has no inside — its bounding box is mostly empty canvas, and
/// treating that box as a target would put a label on an arrow because somebody
/// double-clicked ninety pixels away from it. An arrow is still labelable by
/// double-clicking the stroke itself, which is a real hit.
const ENCLOSING = new Set(["rectangle", "diamond", "ellipse"]);

// --- SVG, as a second surface rather than a second painter -------------------
//
// SVG export has one hazard and it is the one this file's header is about: the
// obvious way to write it is a second painter that walks the elements and emits
// shapes, and a second painter agrees with the first one today and not next
// month. Rough.js is deterministic in the seed, so "agrees" is a real property
// and losing it is a real bug — the same drawing exported and screenshotted
// would differ.
//
// So there is no second painter. `drawElement` runs exactly as it does on
// screen, with the same `roughOptions`, the same corner radii and the same
// arrowhead geometry, and what changes is the *surface* it draws onto: a 2D
// context that records SVG instead of pixels, and a `rough` façade that hands
// back drawables instead of painting them. Everything below is that surface, and
// it holds no opinion about any element type.

/// Two decimal places, and never NaN. An SVG carrying `NaN` in a path is a file
/// that renders as nothing at all, with no error.
const n2 = (value) => {
  const v = Number(value);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};

const xmlText = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const xmlAttr = (value) => xmlText(value).replace(/"/g, "&quot;");

/// `[a, b, c, d, e, f]`, the order SVG's `matrix()` takes and the order canvas's
/// own transform uses. Canvas post-multiplies, so `translate` then `rotate`
/// composes as `M · T · R`, which is what this does.
const IDENTITY = [1, 0, 0, 1, 0, 0];

const matMul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/// A Rough.js drawable's ops as an SVG path.
///
/// Rough emits every shape as a `move` followed by `bcurveTo`s — including a
/// straight line, which is what `drawLinear`'s arrowhead tangent relies on — so
/// three op names cover the whole library.
const opsToPath = (ops) => (Array.isArray(ops) ? ops : [])
  .map((op) => {
    const v = op?.data ?? [];
    if (op?.op === "move") return `M${n2(v[0])} ${n2(v[1])}`;
    if (op?.op === "lineTo") return `L${n2(v[0])} ${n2(v[1])}`;
    if (op?.op === "bcurveTo") {
      return `C${n2(v[0])} ${n2(v[1])} ${n2(v[2])} ${n2(v[3])} ${n2(v[4])} ${n2(v[5])}`;
    }
    return "";
  })
  .filter(Boolean)
  .join(" ");

/// The `text-anchor` a canvas `textAlign` means. Canvas measures from the
/// anchor; SVG names the same three positions differently.
const ANCHOR = { left: "start", start: "start", center: "middle", right: "end", end: "end" };

/// A drawing surface that records SVG.
///
/// Returns the two objects `drawElement(ctx, rc, …)` wants and a `nodes()` that
/// hands back what they recorded. Every emitted node carries the transform and
/// the alpha that were in force when it was drawn, so `ctx.save` / `rotate` /
/// `restore` come out as per-node `transform` attributes rather than as nesting —
/// which keeps the writer stateless about grouping.
export function svgSurface() {
  const nodes = [];
  /// The canvas properties that `save`/`restore` carry. Held on `ctx` itself
  /// rather than mirrored, because the painter both writes them and reads them
  /// back (`ctx.fillStyle = ctx.strokeStyle`, in the arrowheads).
  const PROPS = [
    "globalAlpha", "lineJoin", "lineCap", "strokeStyle", "fillStyle", "lineWidth",
    "font", "textAlign", "textBaseline",
  ];
  let m = IDENTITY;
  let dash = [];
  let d = [];
  const stack = [];

  const common = () => {
    const out = [];
    if (m.some((v, i) => v !== IDENTITY[i])) out.push(`transform="matrix(${m.map(n2).join(" ")})"`);
    const alpha = Number(ctx.globalAlpha);
    if (Number.isFinite(alpha) && alpha < 1) out.push(`opacity="${n2(alpha)}"`);
    return out;
  };

  const emit = (tag, attrs) => {
    const all = [...attrs.filter(Boolean), ...common()];
    nodes.push(`<${tag} ${all.join(" ")}/>`);
  };

  const dashAttr = (list) => {
    const arr = (Array.isArray(list) ? list : []).filter((v) => Number.isFinite(v));
    return arr.length ? `stroke-dasharray="${arr.map(n2).join(" ")}"` : "";
  };

  const strokeAttrs = (color, width, list) => [
    'fill="none"',
    `stroke="${xmlAttr(color)}"`,
    `stroke-width="${n2(width)}"`,
    `stroke-linecap="${xmlAttr(ctx.lineCap || "round")}"`,
    `stroke-linejoin="${xmlAttr(ctx.lineJoin || "round")}"`,
    dashAttr(list),
  ];

  const ctx = {
    globalAlpha: 1,
    lineJoin: "round",
    lineCap: "round",
    strokeStyle: "#000000",
    fillStyle: "#000000",
    lineWidth: 1,
    font: "20px sans-serif",
    textAlign: "left",
    textBaseline: "alphabetic",

    save() {
      const snap = { m, dash };
      for (const key of PROPS) snap[key] = ctx[key];
      stack.push(snap);
    },
    restore() {
      const snap = stack.pop();
      if (!snap) return;
      m = snap.m;
      dash = snap.dash;
      for (const key of PROPS) ctx[key] = snap[key];
    },
    translate(tx, ty) { m = matMul(m, [1, 0, 0, 1, tx, ty]); },
    rotate(angle) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      m = matMul(m, [c, s, -s, c, 0, 0]);
    },
    scale(sx, sy) { m = matMul(m, [sx, 0, 0, sy, 0, 0]); },
    setLineDash(list) { dash = Array.isArray(list) ? list : []; },
    getLineDash() { return [...dash]; },

    beginPath() { d = []; },
    moveTo(x, y) { d.push(`M${n2(x)} ${n2(y)}`); },
    lineTo(x, y) { d.push(`L${n2(x)} ${n2(y)}`); },
    quadraticCurveTo(cx, cy, x, y) { d.push(`Q${n2(cx)} ${n2(cy)} ${n2(x)} ${n2(y)}`); },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      d.push(`C${n2(c1x)} ${n2(c1y)} ${n2(c2x)} ${n2(c2y)} ${n2(x)} ${n2(y)}`);
    },
    closePath() { d.push("Z"); },
    /// Only ever a full circle here — the `dot` arrowhead — and SVG cannot
    /// express a 360° arc in one command, so it goes as two halves.
    arc(x, y, r) {
      d.push(
        `M${n2(x - r)} ${n2(y)}`,
        `A${n2(r)} ${n2(r)} 0 1 0 ${n2(x + r)} ${n2(y)}`,
        `A${n2(r)} ${n2(r)} 0 1 0 ${n2(x - r)} ${n2(y)}`,
        "Z",
      );
    },
    rect(x, y, w, h) {
      d.push(`M${n2(x)} ${n2(y)}`, `h${n2(w)}`, `v${n2(h)}`, `h${n2(-w)}`, "Z");
    },

    fill() {
      if (!d.length) return;
      emit("path", [`d="${d.join(" ")}"`, `fill="${xmlAttr(ctx.fillStyle)}"`, 'stroke="none"']);
    },
    stroke() {
      if (!d.length) return;
      emit("path", [`d="${d.join(" ")}"`, ...strokeAttrs(ctx.strokeStyle, ctx.lineWidth, dash)]);
    },
    fillRect(x, y, w, h) {
      emit("rect", [
        `x="${n2(x)}"`, `y="${n2(y)}"`, `width="${n2(w)}"`, `height="${n2(h)}"`,
        `fill="${xmlAttr(ctx.fillStyle)}"`,
      ]);
    },
    strokeRect(x, y, w, h) {
      emit("rect", [
        `x="${n2(x)}"`, `y="${n2(y)}"`, `width="${n2(w)}"`, `height="${n2(h)}"`,
        ...strokeAttrs(ctx.strokeStyle, ctx.lineWidth, dash),
      ]);
    },
    fillText(text, x, y) {
      const value = String(text ?? "");
      if (!value) return;
      const attrs = [
        `x="${n2(x)}"`, `y="${n2(y)}"`,
        `fill="${xmlAttr(ctx.fillStyle)}"`,
        `text-anchor="${ANCHOR[ctx.textAlign] ?? "start"}"`,
        // Canvas's "middle" is SVG's "central"; the painter centres each line in
        // its slot, so getting this wrong shifts every line by half its height.
        ctx.textBaseline === "middle" ? 'dominant-baseline="central"' : "",
        ctx.textBaseline === "bottom" ? 'dominant-baseline="text-after-edge"' : "",
        `style="font:${xmlAttr(ctx.font)};white-space:pre"`,
        ...common(),
      ];
      nodes.push(`<text ${attrs.filter(Boolean).join(" ")}>${xmlText(value)}</text>`);
    },
    /// The decoded `Image` the paint loop is holding. Its `src` is the data URL
    /// out of the file's own `files` map, so the bytes travel with the SVG and it
    /// stands alone.
    drawImage(img, x, y, w, h) {
      const href = img?.src;
      if (!href) return;
      emit("image", [
        `x="${n2(x)}"`, `y="${n2(y)}"`, `width="${n2(w)}"`, `height="${n2(h)}"`,
        `href="${xmlAttr(href)}"`, `preserveAspectRatio="none"`,
      ]);
    },
    /// The painter does not measure on this path — `textLayout` is pure — but a
    /// context with no `measureText` is a `TypeError` waiting for the first
    /// element that does.
    measureText(text) { return { width: String(text ?? "").length * 8 }; },
  };

  /// A drawable's three set types, as Rough's own renderer treats them: `path`
  /// is the outline, `fillPath` a solid fill, `fillSketch` the hachure strokes —
  /// which are stroked in the *fill* colour at `fillWeight`, defaulting to half
  /// the stroke width.
  const record = (drawable) => {
    const o = drawable?.options ?? {};
    for (const set of drawable?.sets ?? []) {
      const path = opsToPath(set?.ops);
      if (!path) continue;
      if (set.type === "fillPath") {
        emit("path", [`d="${path}"`, `fill="${xmlAttr(o.fill ?? "none")}"`, 'stroke="none"', 'fill-rule="evenodd"']);
      } else if (set.type === "fillSketch") {
        const weight = Number(o.fillWeight) > 0 ? Number(o.fillWeight) : (Number(o.strokeWidth) || 1) / 2;
        emit("path", [`d="${path}"`, ...strokeAttrs(o.fill ?? "none", weight, o.fillLineDash)]);
      } else if (o.stroke !== "none") {
        emit("path", [`d="${path}"`, ...strokeAttrs(o.stroke ?? "#000000", Number(o.strokeWidth) || 1, o.strokeLineDash)]);
      }
    }
    return drawable;
  };

  /// `rough.canvas`'s shape API, backed by the generator so nothing is painted.
  /// The drawable is returned as well as recorded, because `drawLinear` reads the
  /// curve back out of it to aim the arrowheads.
  const gen = rough.generator();
  const rc = {
    rectangle: (...a) => record(gen.rectangle(...a)),
    ellipse: (...a) => record(gen.ellipse(...a)),
    circle: (...a) => record(gen.circle(...a)),
    polygon: (...a) => record(gen.polygon(...a)),
    linearPath: (...a) => record(gen.linearPath(...a)),
    curve: (...a) => record(gen.curve(...a)),
    path: (...a) => record(gen.path(...a)),
    line: (...a) => record(gen.line(...a)),
    arc: (...a) => record(gen.arc(...a)),
  };

  return { ctx, rc, nodes: () => [...nodes] };
}

/// Mount the editor for `text` into `host`.
///
/// `onSave(text)` persists; it may throw, and a throw is reported in the pane
/// header next to the save button rather than swallowed. `onActions(list)`
/// takes this view's contributions to that header. Both are optional — a
/// caller that passes neither gets a working editor that cannot save, which is
/// exactly what the contract test wants.
///
/// `openDocument` is the document factory, and it is here for one reason: it
/// is the seam ui/test/contract.test.js drives the whole editor through
/// against a plain-object fake. That is not a testing trick bolted on — it is
/// the thing xdWasm.js's wrapper shape was designed to allow, in its own
/// words, and having it as an argument is cheaper and more honest than a
/// module mock, which in a shared test process leaks into everyone else's
/// files. No caller in the app passes it.
///
/// `toolbarSlot` is an element the host would rather the tool island lived in
/// — its titlebar, its pane header — instead of the island floating over the
/// top of the canvas. It is optional and the view does not care which it gets:
/// a host that offers nothing keeps the floating island, which is what a
/// browser opening ui/ off disk and a term.hut pane both get. Nothing else
/// changes; the island is the same module either way and is torn down by the
/// same dispose.
///
/// `sidebar` is whether the properties panel starts on screen, and the handle
/// this returns carries `setSidebar(on)` / `sidebarOpen()` so a host that has
/// drawn a toggle for it can drive it afterwards. Passing nothing leaves the
/// panel deciding for itself — it shows when there is a selection to edit or a
/// drawing tool whose defaults are worth setting — which is what a host with
/// no toggle wants and what every host got before there was one.
///
/// Returns a dispose function. Call it twice if it is convenient; the second
/// call does nothing.
export function renderExcalidraw(host, text, {
  onSave, onActions, toolbarSlot = null, sidebar = null, openDocument = openDoc,
} = {}) {
  // --- the surface ---------------------------------------------------------
  //
  // Three elements and no stylesheet. The class names match term.hut's so the
  // pane styles them on arrival, but everything load-bearing is set inline:
  // the view has to look right in a host that has never heard of it, and the
  // text overlay's font and position are per-element anyway.

  const wrap = div("xd-wrap");
  const canvas = el("canvas", "xd-canvas");
  const panelHost = div("xd-props");
  const toolbarHost = div("xd-toolbar");
  wrap.style.position = "relative";
  wrap.style.overflow = "hidden";
  wrap.style.touchAction = "none";
  wrap.style.flex = "1";
  wrap.style.minHeight = "0";
  canvas.style.display = "block";
  // The panel's container is deliberately unstyled and unpositioned. The
  // island inside it places itself absolutely with a `max-height: 100%`, and
  // "100%" resolves against the nearest *positioned* ancestor — so giving this
  // div a position of its own would make the island measure itself against a
  // zero-height box and offset it twice. Left static, it collapses to nothing
  // and the island measures against `wrap`, which is what it wants.
  wrap.appendChild(canvas);
  wrap.appendChild(panelHost);
  // Only when the island is ours to place. With a host slot this div would be
  // an empty element inside the pointer target for no reason.
  if (!toolbarSlot) wrap.appendChild(toolbarHost);
  // Focusable, or the keyboard — which is how tools are chosen — never
  // reaches us.
  wrap.tabIndex = 0;
  host.appendChild(wrap);

  /// Chrome colours, read from the host's CSS custom properties. `let`, not
  /// `const`: the app can switch between its light and dark palettes while the
  /// view is mounted, and --bg (which is what a resize handle is filled with)
  /// is one of the tokens that changes. Read once per switch rather than per
  /// frame — getComputedStyle forces style resolution and this would otherwise
  /// run inside the paint loop of a drag.
  let colors = chromeTheme(wrap);

  // --- state ---------------------------------------------------------------

  /// The document, once the WASM core has loaded. Null before that and after a
  /// file that would not open, and every handler checks: the view is on screen
  /// from the first frame and the pointer does not wait for a download.
  let doc = null;
  /// Set the instant dispose runs. Nothing may paint, listen or edit after it.
  let detached = false;
  /// Set once the view is finished *including* its last save. The two are
  /// separate so a pending autosave can still land after the listeners are
  /// gone — an edit made a moment before a tab closed is an edit the user
  /// would never see again.
  let disposed = false;
  let frame = 0;
  let timer = null;

  /// What is on disk, as far as we know.
  let saved = String(text ?? "");
  let inFlight = false;
  /// What the header's save button says about itself. "" is the resting state.
  let state = "";
  let error = "";
  let zoomText = "100%";
  /// The undo/redo pair, as a two-character signature, so the header is
  /// republished when they change and not on every frame of a drag.
  let historyKey = "";
  /// The selection, as a signature, for the same reason.
  let selectionKey = "";

  const camera = { scale: 1, x: 0, y: 0 };
  const tools = newToolState();
  let style = { ...DEFAULT_STYLE };
  /// The in-flight pointer gesture, or null. One object rather than a handful
  /// of booleans: a gesture has exactly one kind at a time, and the field that
  /// says which is the field that says what pointermove does.
  let gesture = null;
  let gestureSeq = 0;
  /// The rubber band, in scene coordinates, while one is being swept.
  let marquee = null;
  /// The element index an arrow endpoint would bind to right now, or -1.
  ///
  /// Binding itself is the core's — `endDraft` binds both ends to whatever is
  /// under them, and every later move re-aims the arrow, with no call from
  /// here. What the core cannot do is *say so before it happens*, and that
  /// promise is the whole of the feature: an arrow you are about to drop on a
  /// box should have told you it was going to stick to it.
  let bindTarget = -1;
  /// The properties panel, once it loads. Optional by construction — the
  /// editor works without it, which is what lets it be written in parallel.
  let panel = null;
  /// The tool island. Statically imported and therefore always present: it is
  /// the only way to change tools without a keyboard, so an editor that
  /// degraded gracefully without it would be degrading to unusable.
  let toolbar = null;
  /// `{ id, created }` while the text overlay is open.
  let editing = null;
  /// Alignment guides for the drag in progress, as `{ x1, y1, x2, y2 }`
  /// segments in scene coordinates. Empty whenever nothing is snapped.
  let guides = [];
  /// The locked element a click was just refused by, or -1. Lives only until the
  /// next press, which is what makes it an answer rather than decoration.
  let lockedHint = -1;
  /// The context-menu popover, and the shortcut sheet, while either is open.
  /// Both live inside `wrap`: this view may not put anything in the host's
  /// document, and a popover appended to `document.body` is exactly that.
  let menuEl = null;
  let helpEl = null;
  /// Their listeners, so every one of them comes back off. A node leaving the
  /// tree does not un-count its listeners, and dispose is measured.
  let menuBag = null;
  let helpBag = null;

  /// The `scene` argument `drawElement` wants. It reads `files` off it for
  /// image elements and nothing else, so it is refreshed when the file map
  /// could have changed rather than on every frame.
  const scene = { files: {}, appState: {} };
  const images = new Map(); // fileId -> HTMLImageElement, or null while decoding

  // --- coordinates ---------------------------------------------------------
  //
  // One pair of functions, used everywhere. Screen space is CSS pixels
  // relative to the canvas's top-left corner; scene space is the file's own
  // coordinates. Every mixed-up-units bug in a canvas editor comes from having
  // two of these.

  const localOf = (ev) => {
    const r = wrap.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  const toScene = (sx, sy) => [(sx - camera.x) / camera.scale, (sy - camera.y) / camera.scale];
  const toScreen = (x, y) => [x * camera.scale + camera.x, y * camera.scale + camera.y];
  const scenePoint = (ev) => toScene(...localOf(ev));
  const centre = () => [wrap.clientWidth / 2, wrap.clientHeight / 2];

  // --- painting ------------------------------------------------------------

  const schedule = () => {
    if (frame || detached) return;
    frame = requestAnimationFrame(paint);
  };

  function paint() {
    frame = 0;
    if (detached || !doc) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return; // laid out but not shown yet
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // The scene's own background, not the app's: a drawing authored on white
    // is unreadable composited onto a dark pane.
    ctx.fillStyle = scene.appState?.viewBackgroundColor || "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.scale, camera.scale);
    // Under the drawing and in scene units, so it moves and scales with the
    // picture rather than sitting on the glass — which is what makes it
    // something to align *to* rather than a texture.
    drawGrid(ctx, w, h);

    const rc = rough.canvas(canvas);
    // What the eraser is currently over. Nothing has been deleted yet — the
    // sweep only commits on pointerup — so the fade is the whole of the
    // feedback, and it is applied by handing the painter a dimmed copy rather
    // than by setting an alpha it overwrites with the element's own.
    const pending = gesture?.kind === "erase" ? gesture.ids : null;
    for (const element of doc.elements()) {
      if (!element) continue;
      // The element being dragged out is a real element in the document from
      // the first pixel (see xd-wasm's `beginDraft`), so there is no separate
      // in-progress thing to draw here.
      try {
        drawElement(
          ctx, rc,
          pending?.has(element.id)
            ? { ...element, opacity: (element.opacity ?? 100) * ERASE_PREVIEW }
            : element,
          scene, images,
        );
      } catch {
        // One malformed element must not blank the whole drawing.
      }
    }
    paintChrome(ctx);
    ctx.restore();

    const pct = `${Math.round(camera.scale * 100)}%`;
    if (pct !== zoomText) {
      zoomText = pct;
      publish();
    }
  }

  /// The grid the file asks for, or nothing.
  ///
  /// `appState.gridSize` was written `null` by every path in this codebase until
  /// `setAppState` existed, so this has never had anything to draw.
  function drawGrid(ctx, w, h) {
    const size = gridSize();
    // Below about four screen pixels apart a grid stops being a guide and
    // becomes a grey wash over the drawing.
    if (!size || size * camera.scale < 4) return;
    const [x0, y0] = toScene(0, 0);
    const [x1, y1] = toScene(w, h);
    ctx.save();
    ctx.strokeStyle = colors.guide ?? "#c0c0c0";
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1 / camera.scale;
    ctx.beginPath();
    for (let x = Math.floor(x0 / size) * size; x <= x1; x += size) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = Math.floor(y0 / size) * size; y <= y1; y += size) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /// A padlock above a box's top-right corner, sized in screen pixels.
  ///
  /// Small enough to be a badge rather than a shape in the drawing, and drawn in
  /// the guide colour so it cannot be mistaken for something selected. The
  /// shackle goes down first and the body over it, so the body's fill hides
  /// where the two meet.
  function drawLockBadge(ctx, box) {
    const s = 12 / camera.scale;
    const x = box.maxX - s / 2;
    const y = box.minY - s * 1.2;
    ctx.save();
    ctx.strokeStyle = colors.guide ?? "#ff6b6b";
    ctx.fillStyle = colors.handleFill ?? "#ffffff";
    ctx.lineWidth = 1.5 / camera.scale;
    ctx.beginPath();
    ctx.arc(x + s / 2, y + s * 0.44, s * 0.22, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(x + s * 0.18, y + s * 0.44, s * 0.64, s * 0.48);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /// Selection outlines, handles and the marquee.
  ///
  /// Drawn inside the scene transform but measured in screen pixels, which is
  /// what every `{ scale }` below is for: a handle that shrank as you zoomed
  /// out would be a handle you could not grab.
  function paintChrome(ctx) {
    if (marquee) drawMarquee(ctx, marquee, { scale: camera.scale, colors });
    // Drawn before the selection chrome, so a guide never covers a handle.
    if (guides.length) drawSnapGuides(ctx, guides, { scale: camera.scale, colors });

    // The shape an arrow endpoint is about to bind to. Dashed and in the guide
    // colour rather than the accent, because it is a prediction about what is
    // going to happen and not a statement about what is selected.
    if (bindTarget >= 0) {
      const box = doc.elementBounds(bindTarget);
      if (box) {
        drawSelectionOutline(ctx, box, {
          scale: camera.scale, dashed: true, padding: 6, lineWidth: 2,
          colors: { accent: colors.guide },
        });
      }
    }

    // The answer to a click that was refused. The model does not hit-test a
    // locked element at all now (`geometry::is_pickable`), which is right — the
    // click passes through to whatever is behind — and completely silent.
    //
    // Drawn on the one that was just clicked rather than on every locked element
    // in the drawing, which is both what Excalidraw does and the version that
    // does not change what a drawing looks like at rest: a mark that is always
    // there has stopped being an answer to anything.
    if (lockedHint >= 0) {
      const box = doc.elementBounds(lockedHint);
      if (box) {
        drawSelectionOutline(ctx, box, {
          scale: camera.scale, dashed: true, padding: 2, colors: { accent: colors.guide },
        });
        drawLockBadge(ctx, box);
      }
    }

    // A shape being dragged out is not a shape you are about to resize, and
    // handles around a rectangle that is still growing read as a glitch.
    if (gesture && (gesture.kind === "draw" || gesture.kind === "freedraw")) return;

    const selection = doc.selection;
    if (!selection.length) return;
    const box = doc.selectionBounds();
    if (!box) return;
    const angle = doc.selectionAngle();

    // Several elements: each one gets a thin dashed outline of its own, so it
    // is obvious *which* things are in the set, and the union box below then
    // carries the handles.
    if (selection.length > 1) {
      const each = selection.map((i) => doc.elementBounds(i)).filter(Boolean);
      drawSelectionOutline(ctx, each, { scale: camera.scale, colors, dashed: true, padding: 2 });
    }
    drawSelectionOutline(ctx, box, { scale: camera.scale, angle, colors });

    // All nine handles, with **no padding**. Padding would look slightly
    // better and would be a lie: `doc.handleAt` looks for them on the box
    // itself, and a handle drawn a few pixels away from the one you can grab
    // is the exact bug this whole boundary exists to prevent.
    //
    // The rotate handle lands in the right place for free, because both sides
    // now measure it the same way: `geometry::ROTATE_HANDLE_OFFSET_PX` and
    // this file's `ROTATE_OFFSET` are the same twenty *screen* pixels, and the
    // crate's own comment says the two are one handle. It was not always so —
    // the crate used to place it a fixed distance in scene units, which put it
    // six pixels above the box at 25% zoom and ninety-six at 400%.
    //
    // A multi-selection gets the eight resize handles and no rotate handle,
    // which is what Excalidraw draws. Here it is also the mitigation for a real
    // bug: `ops::rotate` reads the absolute pointer bearing as a delta, and
    // `selectionAngle()` returns 0 for any multi-selection by design, so the
    // handle was both meaningless and destructive (audit-selection.md §3.2).
    //
    // The positions come from `doc.handlePoints`, which is the same function
    // `doc.handleAt` hit-tests against — so the thing you can grab and the thing
    // you can see are one computation rather than two that agree because both
    // hard-code twenty pixels. They arrive already rotated (`handle_points`
    // applies the angle itself), so the painter is asked not to rotate them
    // again; the eight squares are then axis-aligned rather than turned with the
    // box, which is the one visible difference and is invisible at 8px. A
    // wrapper that cannot answer yet gets the painter's own arithmetic.
    const points = doc.handlePoints?.(1 / camera.scale) ?? null;
    drawHandles(ctx, box, {
      scale: camera.scale, angle: points ? 0 : angle, colors, padding: 0,
      points,
      only: selection.length > 1 ? HANDLES : null,
    });

    // A selected line or arrow gets handles on its own points as well. This is
    // the whole of "I can't anchor an arrow to objects": binding works and has
    // always worked, but it fired once at draw time because there was no way to
    // pick an endpoint back up. The midpoints are drawn hollow and smaller, since
    // clicking one makes a point rather than moving one.
    const own = doc.pointHandles?.() ?? null;
    if (own?.length) {
      drawPointHandles(ctx, doc.midpointHandles?.() ?? [], {
        scale: camera.scale, colors, filled: false, size: HANDLE_SIZE * 0.75,
      });
      drawPointHandles(ctx, own, { scale: camera.scale, colors });
    }
  }

  // --- the camera ----------------------------------------------------------

  /// Fit the drawing to the pane.
  ///
  /// The arithmetic is the model's, not ours. `excalidrawScene.js` still has a
  /// `fitTransform` and it is still correct, but PLAN.md Phase 2 is explicit
  /// that geometry belongs to xd-core precisely so the painter and the model
  /// cannot drift — and the editor is the place that drift would show, because
  /// it is the only thing that both fits a view and hit-tests inside it.
  const fit = () => {
    if (!doc) return;
    const t = doc.fitTransform(wrap.clientWidth, wrap.clientHeight);
    camera.scale = t.scale;
    camera.x = t.offsetX;
    camera.y = t.offsetY;
    placeOverlay();
    schedule();
  };

  /// Put a scene box in the middle of the pane at the largest zoom that holds
  /// it — ⇧2's "zoom to selection".
  ///
  /// `fit()` above is this over the whole drawing and is deliberately the
  /// model's arithmetic, because the model is the only thing that knows the
  /// drawing's extent. This one is handed the box, so there is nothing for the
  /// model to be the authority on.
  ///
  /// It fits the *selection frame*, not `ops::selection_bounds` — the
  /// containment box that audit-selection.md §2a.2 says this wants — because
  /// that one is not exposed through the boundary yet. The two differ only for a
  /// rotated single element, where the frame is the unrotated box.
  const fitBox = (box, padding = 32) => {
    if (!box) return;
    const vw = wrap.clientWidth - padding * 2;
    const vh = wrap.clientHeight - padding * 2;
    if (vw <= 0 || vh <= 0) return;
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    const scale = Math.max(MIN_SCALE, Math.min(
      MAX_SCALE,
      w > 0 ? vw / w : MAX_SCALE,
      h > 0 ? vh / h : MAX_SCALE,
    ));
    camera.scale = scale;
    camera.x = padding + (vw - w * scale) / 2 - box.minX * scale;
    camera.y = padding + (vh - h * scale) / 2 - box.minY * scale;
    placeOverlay();
    schedule();
  };

  /// Zoom about a point in *screen* space, so the pixel under the cursor stays
  /// under the cursor.
  const zoomAt = (factor, sx, sy) => {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, camera.scale * factor));
    const k = next / camera.scale;
    camera.x = sx - (sx - camera.x) * k;
    camera.y = sy - (sy - camera.y) * k;
    camera.scale = next;
    placeOverlay();
    schedule();
  };

  // --- the pane header -----------------------------------------------------

  /// This view's contributions to the header. Rebuilt rather than mutated:
  /// `renderActions` diffs by id, so republishing costs nothing on screen and
  /// the zoom readout can be republished on every frame of a pinch.
  ///
  /// Undo and redo are text glyphs rather than icons because viewActions.js's
  /// icon set has no undo in it, and reaching into that file to add one would
  /// be this view growing a dependency term.hut does not have.
  const publish = () => {
    if (detached) return;
    onActions?.([
      { id: "xd-fit", icon: "fit", title: "Fit the drawing to the pane (⇧1)", run: act(fit),
        name: "Fit to view", shortcut: "⇧1", group: "view" },
      { id: "xd-out", icon: "zoomOut", title: "Zoom out (⌘−)", run: act(() => zoomAt(1 / 1.2, ...centre())),
        name: "Zoom out", shortcut: "⌘−", group: "view" },
      { id: "xd-zoom", kind: "status", text: zoomText },
      { id: "xd-in", icon: "zoomIn", title: "Zoom in (⌘+)", run: act(() => zoomAt(1.2, ...centre())),
        name: "Zoom in", shortcut: "⌘+", group: "view" },
      { id: "xd-one", label: "1:1", title: "Actual size (⌘0)", run: act(() => zoomAt(1 / camera.scale, ...centre())),
        name: "Actual size", shortcut: "⌘0", group: "view" },
      { id: "xd-undo", label: "↶", title: "Undo (⌘Z)", run: act(() => history("undo")), disabled: !doc?.canUndo(),
        name: "Undo", shortcut: "⌘Z", group: "edit" },
      { id: "xd-redo", label: "↷", title: "Redo (⌘⇧Z)", run: act(() => history("redo")), disabled: !doc?.canRedo(),
        name: "Redo", shortcut: "⇧⌘Z", group: "edit" },
      // Which tool is live. With no toolbar of its own this readout is the
      // only thing that says a keystroke changed the tool, and a drawing app
      // whose next click does something unexpected is an infuriating one.
      { id: "xd-tool", kind: "status", text: toolLabel(tools) },
      {
        id: "xd-save",
        icon: "save",
        title: state === "editing" ? "Save now (⌘S)" : state === "saving" ? "Saving…" : "Saved",
        run: act(saveNow),
        disabled: state !== "editing",
      },
      ...(error ? [{ id: "xd-error", kind: "status", text: error, tone: "err" }] : []),
    ]);
  };

  const setStatus = (next, message = "") => {
    state = next;
    error = message;
    publish();
  };

  // --- saving --------------------------------------------------------------
  //
  // The rule PLAN.md calls the highest-stakes one in the plan: a failed
  // serialize must never overwrite a real drawing. Every path to `onSave` goes
  // through `worthSaving`, and the two ways to get an empty write — a throw
  // out of `toJson`, and a document that never loaded — are both refused here
  // before it is even asked.

  const serialize = () => {
    try {
      return doc ? doc.toJson() : "";
    } catch {
      return "";
    }
  };

  const save = async () => {
    if (disposed || !onSave || inFlight || !doc) return;
    const out = serialize();
    if (!out.trim()) {
      // Nothing to write, and the file stays exactly as it was — the only safe
      // outcome. `worthSaving` would refuse this too; saying so in the header
      // is the difference between a bug and a silent one.
      setStatus("editing", "couldn't serialize the drawing");
      return;
    }
    if (!worthSaving(saved, out)) {
      setStatus("");
      return;
    }
    inFlight = true;
    setStatus("saving");
    try {
      await onSave(out);
      saved = out;
      setStatus("");
    } catch (e) {
      setStatus("editing", `save failed: ${e?.message ?? e}`);
    } finally {
      inFlight = false;
    }
  };

  const saveNow = () => {
    clearTimeout(timer);
    timer = null;
    save();
  };

  const scheduleSave = () => {
    if (disposed) return;
    setStatus("editing");
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save();
    }, AUTOSAVE_MS);
  };

  // --- reacting to the document -------------------------------------------

  /// After anything that may have changed the drawing.
  const edited = (change) => {
    if (!change) return;
    schedule();
    scheduleSave();
    syncHistory();
  };

  /// After anything that may have changed what is selected. Guarded on a
  /// signature because a marquee drag calls this on every frame and the
  /// properties panel has nothing to say about a selection that did not move.
  const reselected = () => {
    schedule();
    if (!doc) return;
    const key = doc.selection.join(",");
    if (key === selectionKey) return;
    selectionKey = key;
    panel?.refresh?.();
  };

  /// After the active tool changes. The header's readout is the obvious half;
  /// the properties panel is the other, because it takes itself off screen
  /// entirely when the select tool is live with nothing selected (see
  /// `panelShown`) and has to be told the tool moved.
  const toolChanged = () => {
    // The hover bind highlight belongs to the arrow tool; leaving it up after a
    // keystroke switched away from it would be a promise about a gesture that is
    // no longer available.
    if (tools.tool !== "arrow" && bindTarget >= 0) bindTarget = -1;
    publish();
    panel?.refresh?.();
    toolbar?.refresh();
    setCursor(cursorFor(tools, {}, !!gesture));
  };

  const syncHistory = () => {
    const key = `${doc?.canUndo() ? 1 : 0}${doc?.canRedo() ? 1 : 0}`;
    if (key === historyKey) return;
    historyKey = key;
    publish();
  };

  const history = (which) => {
    if (!doc) return;
    closeOverlay(true);
    edited(which === "undo" ? doc.undo() : doc.redo());
    // Undo can bring elements back, images among them, and can restore a file
    // map entry the paint loop has never seen.
    syncFiles();
    // Undo renumbers, so the same indices can mean different elements. The
    // signature cannot tell, so it is dropped rather than trusted.
    selectionKey = "";
    reselected();
  };

  // --- appState -------------------------------------------------------------
  //
  // `appState` is the document's own view state — the canvas colour, the theme,
  // the grid — and it is held as a raw `serde_json::Map` precisely so nothing
  // decides anything about it. Until `setAppState` existed nothing could write
  // it at all, which is why the grid was always `null`, the canvas colour could
  // only be whatever the file arrived with, and a document authored in dark mode
  // reopened light and had every colour in it re-inverted.

  /// Excalidraw's own default grid step.
  const GRID_SIZE = 20;

  const appStateSet = (fields) => {
    if (!doc || typeof doc.setAppState !== "function") return;
    edited(doc.setAppState(fields));
    // `scene.appState` is the copy the paint loop reads, and this is one of the
    // few places it can have changed.
    syncFiles();
    panel?.refresh?.();
    schedule();
  };

  /// The grid step in scene units, or 0 for no grid.
  const gridSize = () => {
    const size = Number(scene.appState?.gridSize);
    return Number.isFinite(size) && size > 0 ? size : 0;
  };

  /// Null rather than 0 or false when off: `gridSize` is nullable in the format
  /// and a 0 there is a value Excalidraw would not write.
  const toggleGrid = () => appStateSet({ gridSize: gridSize() ? null : GRID_SIZE });

  /// Re-read the file map and start decoding anything new.
  ///
  /// Called at open and after history and paste — the only three ways an image
  /// can appear that this view did not already know about. Not on every
  /// structural change: `doc.files()` builds an object across the boundary,
  /// and drawing a rectangle cannot add a file.
  function syncFiles() {
    if (!doc) return;
    try {
      scene.files = doc.files() ?? {};
      scene.appState = doc.appState() ?? {};
    } catch {
      return;
    }
    if (typeof Image === "undefined") return; // headless; nothing can decode
    for (let i = 0; i < doc.length; i++) {
      const element = doc.element(i);
      if (!element || element.type !== "image" || images.has(element.fileId)) continue;
      const url = imageDataUrl(element, scene.files);
      if (!url) continue;
      const img = new Image();
      // The slot is claimed before the decode finishes so a repaint mid-decode
      // does not queue a second one. `drawElement` draws a placeholder box for
      // a null, which is what an image that has not arrived should look like.
      images.set(element.fileId, null);
      img.src = url;
      img.decode().then(
        () => {
          if (detached) return;
          images.set(element.fileId, img);
          schedule();
        },
        () => {}, // an undecodable embed keeps its placeholder
      );
    }
  }

  /// The index of an element by id. Linear, and deliberately not cached: it is
  /// called when a text overlay closes and when a paste lands, never in a
  /// loop, and a cache of indices is a cache that goes stale on every insert.
  const indexOfId = (id) => {
    if (!doc || !id) return -1;
    for (let i = 0; i < doc.length; i++) if (doc.elementId(i) === id) return i;
    return -1;
  };

  const selectedElements = () =>
    (doc ? doc.selection : []).map((i) => doc.element(i)).filter(Boolean);

  const hasSelection = () => !!doc && doc.selection.length > 0;

  // --- the pointer ---------------------------------------------------------

  /// What the document says is under a screen point. Two integer round trips
  /// across the boundary and no allocation, which is what makes it cheap
  /// enough to run on every hover.
  ///
  /// Two screen-measured quantities go in, in different units, because the
  /// pointer is already in scene coordinates by the time it gets here: the
  /// grab radius divided by the zoom, and the zoom's reciprocal itself — which
  /// is what places the rotate handle a constant distance above the box on
  /// screen (`geometry::handle_at`). The fourth argument is harmlessly ignored
  /// by a wrapper that does not take it yet.
  const probeAt = (x, y) => {
    const hit = hitAt(x, y);
    const radius = HANDLE_SIZE / camera.scale;
    return {
      // Asked first because it is answered first — see `pointerIntent`'s note
      // about a diagonal arrow's endpoints sitting on the box's corners. Both
      // return -1 unless exactly one linear element is selected, so this costs
      // two integer round trips on every hover and nothing else.
      point: doc.pointHandleAt?.(x, y, radius) ?? -1,
      midpoint: doc.midpointHandleAt?.(x, y, radius) ?? -1,
      handle: doc.handleAt(x, y, radius, 1 / camera.scale),
      hit,
      hitSelected: hit >= 0 && doc.selection.includes(hit),
      // What kind of thing it is, so the text tool can tell typing into what is
      // already there apart from starting something new — and how big the
      // selection is against how big a handle is, so that a tiny element at a
      // low zoom is not entirely covered by its own handles.
      hitType: (hit >= 0 ? doc.element(hit)?.type : "") ?? "",
      box: doc.selectionBounds(),
      handleRadius: radius,
    };
  };

  /// The topmost element under a scene point that the user may act on, or -1.
  ///
  /// Thin now, and deliberately still here. `locked` used to be filtered on this
  /// side because the model did not honour it (audit-selection.md §3.7) — a
  /// drawing authored elsewhere opened here with the author's locked elements
  /// freely draggable. `geometry::is_pickable` gates hit-testing, the marquee and
  /// select-all now, so the JS filter is gone: the model's version is strictly
  /// better, because it can see *through* a locked element to whatever is behind
  /// it, where this could only ever report a miss.
  const hitAt = (x, y) => doc.hitTest(x, y, HIT_SLOP / camera.scale);

  /// The locked element under a scene point, or -1.
  ///
  /// The second question, asked only when the first one missed: "was there
  /// something here that would not answer?" Boxes rather than outlines, because
  /// it is used to explain a click that already happened rather than to decide
  /// one — being a little generous at the corners of an ellipse costs nothing.
  const lockedAt = (x, y) => {
    for (let i = doc.length - 1; i >= 0; i--) {
      const element = doc.element(i);
      if (element?.locked !== true || element.isDeleted) continue;
      const b = doc.elementBounds(i);
      if (b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return i;
    }
    return -1;
  };

  // --- snapping ------------------------------------------------------------
  //
  // `drawSnapGuides` (excalidrawView.js) is a finished, tested painter that
  // nothing has ever called — audit-selection.md §2b.4. This is its producer.
  //
  // It lives here rather than in xd-core for one reason: the threshold is five
  // *screen* pixels, so it needs the zoom, and the model is deliberately unaware
  // that there is a camera. The audit's own sketch puts a `snap_candidates` in
  // `geometry.rs` and threads a threshold in from JS; that is the better home
  // once anything else needs snapping (a grid, a draw gesture), and this stays
  // the same six lines of arithmetic wherever it lives.

  /// The three x-lines and three y-lines Excalidraw aligns against: an edge,
  /// the centre, the other edge.
  const linesX = (b) => [b.minX, (b.minX + b.maxX) / 2, b.maxX];
  const linesY = (b) => [b.minY, (b.minY + b.maxY) / 2, b.maxY];

  /// How far `box` has to move to sit level with something else in the drawing,
  /// as `[dx, dy]`, filling `guides` with the segments that say why.
  ///
  /// Nearest candidate within the threshold wins, per axis independently — so
  /// two axes can snap at once and neither drags the other off its line.
  function snapOffset(box) {
    guides = [];
    const moving = new Set(doc.selection);
    const tol = SNAP_THRESHOLD / camera.scale;
    let bestX = null;
    let bestY = null;
    const mineX = linesX(box);
    const mineY = linesY(box);
    for (let i = 0; i < doc.length; i++) {
      if (moving.has(i)) continue;
      const element = doc.element(i);
      if (!element || element.isDeleted) continue;
      const other = doc.elementBounds(i);
      if (!other) continue;
      for (const t of linesX(other)) {
        for (const m of mineX) {
          const d = t - m;
          if (Math.abs(d) > tol) continue;
          if (!bestX || Math.abs(d) < Math.abs(bestX.d)) bestX = { d, at: t, other };
        }
      }
      for (const t of linesY(other)) {
        for (const m of mineY) {
          const d = t - m;
          if (Math.abs(d) > tol) continue;
          if (!bestY || Math.abs(d) < Math.abs(bestY.d)) bestY = { d, at: t, other };
        }
      }
    }
    const dx = bestX ? bestX.d : 0;
    const dy = bestY ? bestY.d : 0;
    // The guide spans both boxes, which is what makes it read as "these two are
    // level" rather than as a line someone drew.
    if (bestX) {
      guides.push({
        x1: bestX.at, x2: bestX.at,
        y1: Math.min(box.minY + dy, bestX.other.minY),
        y2: Math.max(box.maxY + dy, bestX.other.maxY),
      });
    }
    if (bestY) {
      guides.push({
        y1: bestY.at, y2: bestY.at,
        x1: Math.min(box.minX + dx, bestY.other.minX),
        x2: Math.max(box.maxX + dx, bestY.other.maxX),
      });
    }
    return [dx, dy];
  }

  /// The delta to hand `dragBy` for a pointer now at `(x, y)`.
  ///
  /// Derived from where the gesture *started* rather than accumulated frame by
  /// frame, because snapping means the shapes are deliberately not where the
  /// pointer is. Adding a snap offset to an incremental delta would leave that
  /// offset in place for the rest of the drag, and the shapes would walk away
  /// from the cursor one snap at a time.
  function dragDelta(g, x, y, snapping) {
    const now = doc.selectionBounds();
    if (!g.startBox || !now) {
      guides = [];
      return [x - g.lastX, y - g.lastY];
    }
    const w = g.startBox.maxX - g.startBox.minX;
    const h = g.startBox.maxY - g.startBox.minY;
    const minX = g.startBox.minX + (x - g.x);
    const minY = g.startBox.minY + (y - g.y);
    const raw = { minX, minY, maxX: minX + w, maxY: minY + h };
    // The grid takes precedence over element alignment, and replaces it rather
    // than composing with it: a drag that snapped to a grid line *and* to another
    // shape's edge would be pulled two ways and land on neither.
    const step = gridSize();
    if (snapping && step) {
      guides = [];
      const gx = Math.round(minX / step) * step;
      const gy = Math.round(minY / step) * step;
      return [gx - now.minX, gy - now.minY];
    }
    const [ox, oy] = snapping ? snapOffset(raw) : ((guides = []), [0, 0]);
    return [minX + ox - now.minX, minY + oy - now.minY];
  }

  const setCursor = (value) => {
    if (wrap.style.cursor !== value) wrap.style.cursor = value;
  };

  /// Give the canvas the keyboard back.
  ///
  /// Clipboard events are delivered to whatever is focused, so ⌘C only reaches
  /// this view while the canvas holds focus — and every button click leaves
  /// focus on the button that was clicked. So each control that acts on the
  /// drawing and then has nothing more to say hands the keyboard back: the
  /// pane header's buttons, and the tool island's.
  ///
  /// Never while the text overlay is open. The overlay owns the keyboard for
  /// as long as it exists, and taking focus off it fires its blur handler,
  /// which commits the edit — so a stray call here would end a text edit the
  /// user was in the middle of.
  ///
  /// The properties panel is deliberately not in this list: its controls are a
  /// sequence someone may be tabbing through, and yanking focus out of a swatch
  /// row after every click would make it unusable from the keyboard.
  const takeFocus = () => {
    if (detached || editing) return;
    wrap.focus?.();
  };

  /// A header action: do the thing, then hand the keyboard back.
  const act = (fn) => () => {
    fn();
    takeFocus();
  };

  /// True when an event is the canvas's own rather than one that bubbled up
  /// from a piece of chrome sitting on top of it.
  ///
  /// The tool island and the properties panel are children of `wrap`, which is
  /// where the pointer, wheel and double-click listeners live — so without
  /// this, clicking a tool button also starts a marquee behind it and
  /// scrolling the properties panel zooms the drawing. Checking the target
  /// rather than calling `stopPropagation` in the islands keeps the rule in
  /// one place instead of in every module that ever floats over the canvas.
  const onCanvas = (ev) => !ev?.target || ev.target === canvas;

  const onPointerDown = (ev) => {
    if (detached || !doc || !onCanvas(ev)) return;
    // A press on the canvas dismisses the popover, the way a press anywhere
    // else dismisses every popover in every application.
    closeMenu();
    // A click anywhere on the canvas is the end of a text edit. Committing
    // before the hit test matters: the commit resizes the element, and a
    // pointerdown that tested against its old box would select the wrong
    // thing.
    closeOverlay();
    const [sx, sy] = localOf(ev);
    const [x, y] = toScene(sx, sy);
    const intent = pointerIntent(tools, ev, probeAt(x, y));
    // A press that found nothing may have been refused by something locked, and
    // any other press clears the badge — so it lasts exactly as long as the
    // question it answers.
    lockedHint = intent?.kind === "marquee" ? lockedAt(x, y) : -1;
    if (!intent) return;
    ev.preventDefault?.();
    wrap.focus?.();
    try {
      wrap.setPointerCapture?.(ev.pointerId);
    } catch {
      // A synthetic event with no pointer id; the window listeners still work.
    }
    gesture = { ...intent, id: ++gestureSeq, sx, sy, ox: sx, oy: sy, x, y, lastX: x, lastY: y, moved: false };

    switch (intent.kind) {
      case "move":
        // Shift toggles; an unselected shape replaces the selection; an
        // already-selected one is left alone so a drag moves the whole set.
        if (intent.extend) doc.toggleSelection(intent.index);
        else if (!intent.selected) doc.setSelection([intent.index]);
        reselected();
        // Where the set started, so a snapped drag can be measured from the
        // pointer rather than from the last frame — see `dragDelta`.
        gesture.startBox = doc.selectionBounds();
        break;
      case "marquee":
        if (!intent.extend) doc.clearSelection();
        gesture.base = doc.selection;
        gesture.contain = !!intent.contain;
        marquee = { minX: x, minY: y, maxX: x, maxY: y };
        reselected();
        break;
      case "draw":
        edited(doc.beginDraft(intent.shape, x, y, styleFor(intent.shape, style)));
        // The draft's own id, so `bindableAt` can be told to ignore the arrow
        // being dragged — without it every arrow binds to itself.
        gesture.draftId = doc.elementId(doc.selection[0]) ?? "";
        reselected();
        break;
      case "freedraw":
        edited(doc.beginDraft("freedraw", x, y, {
          ...styleFor("freedraw", style),
          // perfect-freehand ignores recorded pressures when this is true and
          // invents a profile from the stroke's speed instead — which is what
          // makes a mouse stroke look drawn rather than extruded. A pen has
          // real numbers and must not have them thrown away.
          simulatePressure: !isPressureDevice(ev),
        }));
        reselected();
        break;
      case "text":
        createText(x, y);
        gesture = null; // the overlay owns the keyboard now
        break;
      case "editText": {
        // The text tool clicked on text that is already there. Excalidraw types
        // into it; this used to stack a second element on top, which reads as
        // "my text duplicated itself and now neither copy can be fixed".
        doc.setSelection([intent.index]);
        reselected();
        const element = doc.element(intent.index);
        if (element) openOverlay(element, false);
        gesture = null;
        break;
      }
      case "erase":
        // Nothing is deleted on the way down. The sweep collects ids and paints
        // them faint, and `commitErase` on pointerup does it in one command —
        // so a sweep that caught the wrong thing can be corrected by moving off
        // it before letting go.
        gesture.ids = new Set();
        eraseAt(x, y);
        break;
      case "point":
        // The id, because the drag ends in `rebindEnd`, which names its arrow by
        // id — and because an index is only true until something is inserted.
        gesture.linearId = doc.elementId(doc.selection[0]) ?? "";
        break;
      case "addPoint": {
        // A segment index in, a point index out: segment `i` runs from point `i`
        // to point `i + 1`, and the new point lands at `i + 1`. It goes in under
        // the *drag's* coalesce key, so making a point and bending it are one
        // undo entry rather than an insert nobody asked to keep on its own.
        //
        // Nothing is unbound here, unlike `movePoint`: an insert is strictly
        // between two existing points, so neither end has moved and both stay
        // tied to whatever they were tied to.
        const key = `point:${gesture.id}`;
        edited(doc.insertPoint(intent.index, x, y, key));
        gesture.kind = "point";
        gesture.index = intent.index + 1;
        gesture.linearId = doc.elementId(doc.selection[0]) ?? "";
        break;
      }
      case "image":
        // The click says where; the picker says what. Nothing is inserted until
        // bytes come back, and a cancelled picker leaves the drawing alone.
        askForImage(x, y);
        gesture = null;
        break;
      default:
        break;
    }
    setCursor(cursorFor(tools, {}, true));
    schedule();
  };

  const onPointerMove = (ev) => {
    if (detached || !doc) return;
    const [sx, sy] = localOf(ev);
    if (!gesture) {
      const [x, y] = toScene(sx, sy);
      setCursor(cursorFor(tools, probeAt(x, y), false));
      // The bind highlight, before anything is being dragged. It only ever
      // appeared mid-drag, which is the wrong half: the promise the feature
      // makes is that an arrow you are *about to* draw or drop will stick to
      // that box, and a promise made after the fact is not one.
      const next = tools.tool === "arrow" ? doc.bindableAt(x, y, "") : -1;
      if (next !== bindTarget) {
        bindTarget = next;
        schedule();
      }
      return;
    }
    const [x, y] = toScene(sx, sy);

    switch (gesture.kind) {
      case "pan":
        camera.x += sx - gesture.sx;
        camera.y += sy - gesture.sy;
        gesture.sx = sx;
        gesture.sy = sy;
        schedule();
        break;

      case "move": {
        // The threshold is only on a move, and only on the first one. A press
        // that wobbles three pixels is a click; a resize or a draw that
        // wobbles three pixels is a resize or a draw, and making those wait
        // would make the shape lag the pointer at the start of every gesture.
        if (!gesture.moved && !passedThreshold(sx - gesture.ox, sy - gesture.oy)) break;
        gesture.moved = true;
        // Alt suspends snapping, which is the modifier every editor that snaps
        // uses for "no, I meant exactly here".
        const [dx, dy] = dragDelta(gesture, x, y, !ev.altKey);
        if (dx || dy) edited(doc.dragBy(dx, dy, `drag:${gesture.id}`));
        else schedule(); // the guides may have changed even if nothing moved
        gesture.lastX = x;
        gesture.lastY = y;
        break;
      }

      case "resize":
        // Absolute, not incremental: the handle follows the pointer exactly,
        // so a resize cannot drift away from the cursor over a long drag.
        // Shift locks the aspect ratio, alt resizes about the centre.
        edited(doc.resizeTo(gesture.handle, x, y, ev.shiftKey, ev.altKey, `resize:${gesture.id}`));
        break;

      case "rotate":
        edited(doc.rotateTo(x, y, ev.shiftKey ? ROTATE_SNAP : 0, `rotate:${gesture.id}`));
        break;

      case "point":
        // `movePoint` clears the dragged end's binding on the way in, which is
        // what stops the reflow from snapping the endpoint straight back onto the
        // shape it was tied to — the reason this gesture looked impossible rather
        // than merely missing.
        edited(doc.movePoint(gesture.index, x, y, `point:${gesture.id}`));
        // Only the two ends can bind, and only an arrow's. A midpoint dragged
        // over a box binds to nothing, so highlighting one would be a promise
        // nobody is going to keep.
        bindTarget = isEndpoint(gesture.index) ? doc.bindableAt(x, y, gesture.linearId) : -1;
        break;

      case "marquee": {
        marquee = { minX: gesture.x, minY: gesture.y, maxX: x, maxY: y };
        // Read live rather than off the intent, so alt can be pressed or
        // released part-way through a sweep and the band changes meaning under
        // the hand — which is the only way a modifier on a drag is usable.
        gesture.contain = !!ev.altKey;
        const swept = doc.marquee(gesture.x, gesture.y, x, y, gesture.contain);
        doc.setSelection(gesture.base.length ? [...new Set([...gesture.base, ...swept])] : swept);
        reselected();
        break;
      }

      case "draw":
        edited(doc.draftTo(x, y, ev.shiftKey));
        // Only for arrows: a rectangle dragged over a box binds to nothing, so
        // highlighting one would be a promise the core is not going to keep.
        if (gesture.shape === "arrow") bindTarget = doc.bindableAt(x, y, gesture.draftId);
        break;

      case "freedraw":
        // Coalesced events are the samples the browser collected between two
        // frames. On a trackpad that is the difference between a stroke and a
        // polygon, and asking for them costs nothing when there are none.
        for (const sample of coalesced(ev)) {
          const [px, py] = toScene(...localOf(sample));
          edited(doc.draftPoint(px, py, pressureOf(sample)));
        }
        break;

      case "erase":
        // The same coalesced samples, for the same reason: a fast sweep between
        // two frames must not skip over what it passed through.
        for (const sample of coalesced(ev)) {
          eraseAt(...toScene(...localOf(sample)));
        }
        break;

      default:
        break;
    }
  };

  const onPointerUp = (ev) => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    try {
      wrap.releasePointerCapture?.(ev.pointerId);
    } catch {
      // Never captured; nothing to release.
    }
    bindTarget = -1;
    guides = [];
    if (doc) {
      switch (g.kind) {
        case "erase":
          commitErase(g.ids);
          break;
        case "point":
          // On the way *up*, not during the drag. Binding mid-drag would re-aim
          // the arrow at the shape under the pointer on every frame, so the
          // endpoint would be dragged and immediately pulled back — which is
          // what "I can't anchor an arrow" felt like from the outside.
          if (g.linearId && isEndpoint(g.index)) {
            edited(doc.rebindEnd(g.linearId, g.index !== 0));
          }
          break;
        case "draw":
        case "freedraw":
          edited(doc.endDraft(g.kind === "freedraw" ? 0 : MIN_DRAW_SIZE));
          tools.tool = afterDraw(tools);
          selectionKey = ""; // endDraft may have dropped the draft entirely
          reselected();
          toolChanged();
          break;
        case "marquee":
          marquee = null;
          reselected();
          break;
        case "move":
          // A click — not a drag — on a shape that was already part of a
          // multi-selection narrows to it. Without this there is no way to
          // pick one shape out of a group you have just swept up except by
          // clicking somewhere empty first.
          if (!g.moved && !g.extend && doc.selection.length > 1) {
            doc.setSelection([g.index]);
            reselected();
          }
          break;
        default:
          break;
      }
      // A pointercancel carries no position; the cursor is left as it was
      // rather than probed against NaN.
      if (Number.isFinite(ev?.clientX)) {
        const [x, y] = scenePoint(ev);
        setCursor(cursorFor(tools, probeAt(x, y), false));
      }
    }
    schedule();
  };

  /// The samples between this frame and the last, or just this one.
  const coalesced = (ev) => {
    const list = ev.getCoalescedEvents?.();
    return list && list.length ? list : [ev];
  };

  // --- linear points -------------------------------------------------------
  //
  // The gesture behind "I can't anchor an arrow to objects". Binding itself has
  // always worked — it fires inside `endDraft` and every later move re-aims the
  // arrow — but it was a one-shot at draw time, because the selection handles
  // are bounding-box-only and there was no way to pick up an endpoint and put it
  // somewhere else. That is the motion people actually reach for.

  /// The points of the one selected linear element, or null.
  const linearPoints = () => {
    if (!doc || doc.selection.length !== 1) return null;
    const element = doc.element(doc.selection[0]);
    if (!element || (element.type !== "line" && element.type !== "arrow")) return null;
    return Array.isArray(element.points) ? element.points : null;
  };

  /// Whether point `index` is one of the two ends — the only two that bind.
  const isEndpoint = (index) => {
    const pts = linearPoints();
    return !!pts && (index === 0 || index === pts.length - 1);
  };

  // --- images ---------------------------------------------------------------
  //
  // Three ways in — the tool, a paste, a drop — and one way through: `putFile`
  // puts the bytes in the document's file map, and an `image` element names them
  // by `fileId`. Until `putFile` existed nothing could add to that map at all,
  // which is why every one of the three was missing rather than merely rough.
  //
  // The picker is an `<input type="file">` inside `wrap`, not anything the
  // platform offers. This view may not know that a filesystem exists — the
  // import guard fails the build over it — and a hidden input is the one way to
  // ask for a file that works the same in a browser tab, in the app, and in a
  // term.hut pane.

  const filePicker = el("input", "xd-file");
  filePicker.type = "file";
  filePicker.accept = "image/*";
  filePicker.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
  // Inside the host, invisible, and out of the tab order. Asking for a file is
  // the one capability this view needs that has no API of its own, and a hidden
  // input is how you ask without knowing whether there is a filesystem behind it
  // — which is exactly the boundary this file may not cross.
  filePicker.tabIndex = -1;
  wrap.appendChild(filePicker);

  /// Where the image being asked for should land, in scene coordinates.
  let imageAt = null;

  const askForImage = (x, y) => {
    imageAt = [x, y];
    // Or picking the same file twice in a row fires no change event at all.
    filePicker.value = "";
    filePicker.click?.();
  };

  const onPickImage = () => {
    const file = filePicker.files?.[0];
    const at = imageAt ?? toScene(...centre());
    imageAt = null;
    if (file) addImage(file, at[0], at[1]);
  };

  /// The `data:` URL the file map stores and the painter decodes.
  ///
  /// Built from the bytes rather than through a `FileReader`: the bytes have
  /// already been read once for the hash, and a second asynchronous way to get
  /// the same data is a second way for it to fail — and one that does not exist
  /// in every environment this view is meant to run in.
  ///
  /// Chunked, because `String.fromCharCode(...bytes)` spreads the whole array
  /// into an argument list and a screenshot is more arguments than a call frame
  /// holds.
  const dataUrlOf = (bytes, mime) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${mime || "image/png"};base64,${btoa(binary)}`;
  };

  /// Excalidraw keys the file map by the SHA-1 of the bytes, so the same picture
  /// dropped twice is stored once and a document that already has it pays
  /// nothing. Where `crypto.subtle` is missing — it needs a secure context — a
  /// random id is the honest fallback: the file still works, it just cannot be
  /// recognised as a duplicate.
  const fileIdFor = async (bytes) => {
    try {
      const digest = await crypto.subtle.digest("SHA-1", bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
  };

  /// The image's own pixel size, or null where nothing can decode.
  const naturalSize = (url) => new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve(null);
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth || img.width || 0, img.naturalHeight || img.height || 0]);
    img.onerror = () => resolve(null);
    img.src = url;
  });

  /// The box an image of `w × h` should occupy: its own size, shrunk to fit the
  /// pane if it is bigger than that. A phone photograph dropped at its natural
  /// size is 4000 units of drawing nobody asked for.
  const imageBox = (w, h) => {
    const maxW = Math.max(64, (wrap.clientWidth || 800) / camera.scale - IMAGE_MARGIN * 2);
    const maxH = Math.max(64, (wrap.clientHeight || 600) / camera.scale - IMAGE_MARGIN * 2);
    const k = Math.min(1, maxW / (w || 1), maxH / (h || 1));
    return [Math.round(w * k), Math.round(h * k)];
  };

  /// Put a picked, pasted or dropped file into the document, centred on a point.
  async function addImage(file, x, y) {
    if (!doc || !file || typeof doc.putFile !== "function") return;
    let dataURL = "";
    let bytes = null;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      dataURL = dataUrlOf(bytes, file.type);
    } catch {
      return; // an unreadable file is not an edit
    }
    if (detached || !doc || !dataURL) return;
    const fileId = await fileIdFor(bytes);
    const natural = await naturalSize(dataURL);
    if (detached || !doc) return;
    const [w, h] = imageBox(natural?.[0] || 200, natural?.[1] || 200);
    try {
      edited(doc.putFile(fileId, {
        id: fileId,
        mimeType: file.type || "image/png",
        dataURL,
        created: Date.now(),
        lastRetrieved: Date.now(),
      }));
      doc.insert({
        type: "image",
        x: x - w / 2,
        y: y - h / 2,
        width: w,
        height: h,
        angle: 0,
        fileId,
        status: "saved",
        scale: [1, 1],
        ...styleFor("image", style),
      });
    } catch {
      return; // the core refused it; the drawing is untouched
    }
    tools.tool = afterDraw(tools);
    syncFiles();
    selectionKey = "";
    edited({ structural: true });
    reselected();
    toolChanged();
  }

  /// The images out of a drop or a paste, in the order they arrived.
  const imagesIn = (list) => [...(list ?? [])].filter((f) => f && String(f.type ?? "").startsWith("image/"));

  const onDragOver = (ev) => {
    if (detached || !doc) return;
    if (!imagesIn(ev.dataTransfer?.items ?? ev.dataTransfer?.files).length) return;
    // Without this the browser navigates to the dropped file and the drawing is
    // gone from under the user.
    ev.preventDefault?.();
  };

  const onDrop = (ev) => {
    if (detached || !doc) return;
    const files = imagesIn(ev.dataTransfer?.files);
    if (!files.length) return;
    ev.preventDefault?.();
    const [x, y] = scenePoint(ev);
    files.forEach((file, i) => addImage(file, x + i * PASTE_OFFSET, y + i * PASTE_OFFSET));
  };

  // --- the eraser ----------------------------------------------------------

  /// Add whatever is under a scene point to the sweep. Ids, not indices: the
  /// commit renumbers, and an index recorded at the start of a sweep would name
  /// a different element by the end of it.
  const eraseAt = (x, y) => {
    if (!gesture?.ids) return;
    const i = hitAt(x, y);
    if (i < 0) return;
    const id = doc.elementId(i);
    if (!id || gesture.ids.has(id)) return;
    gesture.ids.add(id);
    schedule();
  };

  /// The coalesce key the whole eraser shares. Constant on purpose: every patch
  /// a sweep makes folds into one undo entry, the same way `dragBy(dx, dy,
  /// "nudge")` folds a burst of arrow keys into one.
  const ERASE_KEY = "erase";

  /// Tombstone everything the sweep touched, as one undo entry.
  ///
  /// `isDeleted` rather than a delete: Excalidraw keeps tombstones, both for undo
  /// and so another client's reconciliation can see that the element went rather
  /// than never existed. This used to be a `deleteSelection` — one command, so
  /// one undo entry, but the wrong shape — because `patch` took no coalesce key
  /// and N unkeyed patches would have been N presses of ⌘Z to take back a single
  /// sweep. It takes one now.
  const commitErase = (ids) => {
    if (!doc || !ids?.size) return;
    for (let i = 0; i < doc.length; i++) {
      const id = doc.elementId(i);
      if (id && ids.has(id)) edited(doc.patch(id, { isDeleted: true }, ERASE_KEY));
    }
    // The tombstones are still in the selection's indices if they were selected
    // before the sweep, and a selection frame around something invisible is a
    // handle you cannot see the shape of.
    doc.clearSelection();
    selectionKey = "";
    reselected();
  };

  const onWheel = (ev) => {
    if (detached || !onCanvas(ev)) return;
    ev.preventDefault?.();
    const intent = wheelIntent(ev);
    if (intent.kind === "zoom") {
      const [sx, sy] = localOf(ev);
      zoomAt(intent.factor, sx, sy);
      return;
    }
    camera.x += intent.dx;
    camera.y += intent.dy;
    placeOverlay();
    schedule();
  };

  /// The topmost element whose *box* contains a scene point, or -1.
  ///
  /// The companion to `hitAt`, and only ever a fallback to it. A shape with a
  /// transparent background is hit on its stroke alone
  /// (`crates/xd-core/src/geometry.rs:395`), which is right for selection — a
  /// hollow box is a frame, and clicking through the hole in it selects what is
  /// behind. It is wrong for "double-click here to label this", where the whole
  /// interior is the target: without this, double-clicking inside an unfilled
  /// rectangle counts as a miss and silently drops a free-floating text element
  /// in the middle of it.
  ///
  /// Boxes rather than outlines, so a rotated ellipse is a little generous at
  /// its corners. For choosing what to type into, generous is the right way to
  /// be wrong.
  const enclosingAt = (x, y) => {
    for (let i = doc.length - 1; i >= 0; i--) {
      const element = doc.element(i);
      if (!element || element.isDeleted || element.locked === true) continue;
      if (!ENCLOSING.has(element.type)) continue;
      const b = doc.elementBounds(i);
      if (!b) continue;
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return i;
    }
    return -1;
  };

  const onDoubleClick = (ev) => {
    if (detached || !doc || !onCanvas(ev)) return;
    ev.preventDefault?.();
    const [x, y] = scenePoint(ev);
    const hit = hitAt(x, y);
    // Three branches, and it used to have two: text, then a *miss*. A filled
    // rectangle fell between them — the hit succeeded and it was not text — so
    // double-clicking one did nothing at all, no overlay and no feedback
    // (docs/audit/audit-text.md, verdict). An unfilled one fell out the other
    // side of the same gap and got a stray text element instead of a label.
    const target = hit >= 0 ? hit : enclosingAt(x, y);
    const element = target >= 0 ? doc.element(target) : null;
    if (element?.type === "text") {
      doc.setSelection([target]);
      reselected();
      openOverlay(element, false);
      return;
    }
    if (element && LABELABLE.has(element.type)) {
      editLabel(target);
      return;
    }
    if (target < 0) createText(x, y);
  };

  // --- the keyboard --------------------------------------------------------

  const onKeyDown = (ev) => {
    if (detached || !doc) return;
    // Space is a modifier, not a command: held down it turns every drag into a
    // pan, which is how you get out of any tool without leaving it.
    if (ev.key === " " || ev.code === "Space") {
      if (!tools.space) {
        tools.space = true;
        setCursor(cursorFor(tools, {}, !!gesture));
      }
      ev.preventDefault();
      return;
    }
    const intent = keyIntent(ev, tools);
    if (!intent) return;
    ev.preventDefault();

    switch (intent.kind) {
      case "tool":
        tools.tool = intent.tool;
        toolChanged();
        break;
      case "lock":
        tools.locked = !tools.locked;
        toolChanged();
        break;
      case "escape":
        // Escape is "get me out of whatever this is", so it unwinds one layer
        // at a time: a popover or the shortcut sheet first, the selection only
        // once there is nothing on top of it.
        if (menuEl || helpEl) {
          closeMenu();
          closeHelp();
          break;
        }
        doc.clearSelection();
        tools.tool = "select";
        marquee = null;
        reselected();
        toolChanged();
        break;
      case "delete":
        edited(doc.deleteSelection());
        reselected();
        break;
      case "nudge":
        // One undo entry per burst of arrow keys, the same way a drag is one
        // entry: the coalesce key is constant, and xd-core's 800 ms window
        // closes it when the fingers stop.
        edited(doc.dragBy(intent.dx, intent.dy, "nudge"));
        break;
      case "selectAll":
        // "Everything" excludes what the author locked, and that is the model's
        // rule now rather than a filter here — see `hitAt`.
        doc.selectAll();
        reselected();
        break;
      case "duplicate":
        edited(doc.duplicateSelection(PASTE_OFFSET, PASTE_OFFSET));
        selectionKey = "";
        reselected();
        break;
      case "undo":
      case "redo":
        history(intent.kind);
        break;
      case "reorder":
        edited(doc.reorder(intent.how));
        break;
      case "group":
        edited(doc.group());
        break;
      case "ungroup":
        edited(doc.ungroup());
        break;
      case "zoom":
        zoomAt(intent.factor, ...centre());
        break;
      case "zoomReset":
        // Excalidraw's ⌘0 is *reset to 100%*. This ran `fit()`, which is ⇧1 —
        // and a nearly-right keyboard is worse than an unfamiliar one, because
        // the mistakes are silent.
        zoomAt(1 / camera.scale, ...centre());
        break;
      case "zoomFit":
        fit();
        break;
      case "zoomSelection":
        // Nothing selected has nothing to zoom to, so it means the drawing —
        // which is also what Excalidraw falls back to.
        //
        // `selectionExtent` is the *containment* box, deliberately distinct from
        // the selection frame: for a rotated element the frame is its unrotated
        // box, which would zoom past the corners that stick out of it.
        if (hasSelection()) fitBox(doc.selectionExtent?.() ?? doc.selectionBounds());
        else fit();
        break;
      case "toggleLock":
        setLocked(!allLocked());
        break;
      case "flip":
        edited(doc.flip?.(intent.axis));
        break;
      case "grid":
        toggleGrid();
        break;
      case "help":
        toggleHelp();
        break;
      case "save":
        saveNow();
        break;
      case "edit": {
        // Enter types into what is selected: the text itself, or the label of a
        // shape, which is what Excalidraw does with a rectangle selected.
        const index = doc.selection[0];
        const element = index == null ? null : doc.element(index);
        if (element?.type === "text") openOverlay(element, false);
        else if (element && LABELABLE.has(element.type)) editLabel(index);
        break;
      }
      default:
        break;
    }
  };

  const onKeyUp = (ev) => {
    if (ev.key === " " || ev.code === "Space") {
      tools.space = false;
      setCursor(cursorFor(tools, {}, false));
    }
  };

  /// Alt-tabbing away with space held would otherwise leave the editor
  /// convinced the space bar is still down, because the keyup lands in another
  /// window. The listener is on `window` and is one of the things dispose has
  /// to remember.
  const onBlur = () => {
    tools.space = false;
    if (gesture) {
      gesture = null;
      marquee = null;
      guides = [];
      schedule();
    }
    setCursor(cursorFor(tools, {}, false));
  };

  // --- the clipboard -------------------------------------------------------
  //
  // Clipboard *events*, not `navigator.clipboard`: the event carries the data
  // synchronously and needs no permission prompt, and it fires for the menu
  // bar and the context menu as well as for the keystroke. `keyIntent`
  // deliberately does not claim ⌘C/⌘X/⌘V for that reason.

  const onCopy = (ev) => {
    if (detached || !doc || editing) return;
    const elements = selectedElements();
    if (!elements.length) return;
    ev.preventDefault();
    // The file map goes with it, or an image copied out of here arrives
    // anywhere else as a `fileId` resolving to nothing — a permanent grey
    // placeholder, and the one real cross-document loss in this build.
    ev.clipboardData?.setData("text/plain", clipboardText(elements, scene.files));
  };

  const onCut = (ev) => {
    if (detached || !doc || editing) return;
    if (!doc.selection.length) return;
    onCopy(ev);
    edited(doc.deleteSelection());
    reselected();
  };

  const onPaste = (ev) => {
    if (detached || !doc || editing) return;
    // Images first: a screenshot on the clipboard carries no text at all, so
    // asking for text first would find nothing and return before ever looking.
    const files = imagesIn(ev.clipboardData?.files);
    if (files.length) {
      ev.preventDefault();
      const [x, y] = toScene(...centre());
      files.forEach((file, i) => addImage(file, x + i * PASTE_OFFSET, y + i * PASTE_OFFSET));
      return;
    }
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    ev.preventDefault();
    const payload = parseClipboard(text);
    if (payload) {
      pasteElements(payload.elements, payload.files);
      return;
    }
    // Plain text becomes a text element, which is what Excalidraw does and is
    // most of what anyone actually pastes into a diagram.
    pasteText(text);
  };

  function pasteElements(elements, files = null) {
    const before = doc.length;
    let added = 0;
    // The bytes before the elements that name them, so an image is never briefly
    // a grey placeholder pointing at a `fileId` that resolves to nothing. This is
    // the paste-in half of the image clipboard fix; the copy-out half is
    // `clipboardText`, and neither worked until `putFile` existed.
    if (files && typeof files === "object" && typeof doc.putFile === "function") {
      for (const [id, entry] of Object.entries(files)) {
        try {
          edited(doc.putFile(id, entry));
        } catch {
          // A malformed entry loses that one image, not the whole paste.
        }
      }
    }
    for (const element of elements) {
      try {
        doc.insert({ ...element, x: (element.x ?? 0) + PASTE_OFFSET, y: (element.y ?? 0) + PASTE_OFFSET });
        added++;
      } catch {
        // One element the core will not take must not lose the rest of the
        // paste; the format drifts and a clipboard is the likeliest place to
        // meet a shape from a newer Excalidraw.
      }
    }
    if (!added) return;
    // `insert` appends, so the new elements are the last `added` indices.
    doc.setSelection(Array.from({ length: added }, (_, k) => before + k));
    syncFiles();
    selectionKey = "";
    edited({ structural: true });
    reselected();
  }

  function pasteText(text) {
    const [x, y] = toScene(...centre());
    const value = String(text).replace(/\r\n?/g, "\n");
    const measured = measure(value, { fontSize: style.fontSize, fontFamily: style.fontFamily });
    try {
      doc.insert({
        type: "text",
        x,
        y,
        width: measured.width,
        height: measured.height,
        angle: 0,
        text: value,
        originalText: value,
        textAlign: "left",
        verticalAlign: "top",
        lineHeight: 1.25,
        ...styleFor("text", style),
      });
    } catch {
      return;
    }
    selectionKey = "";
    edited({ structural: true });
    reselected();
  }

  // --- text ----------------------------------------------------------------
  //
  // A positioned `<textarea>`, which is what Excalidraw itself does and for
  // the same reason: a text engine is carets, selection, IME, bidi, undo and
  // autocorrect, and the platform has one. What JS contributes that Rust
  // cannot is the *measurement* — `ctx.measureText` is the only way to know
  // how wide a run of text is in a given font — and that is exactly the one
  // thing this section sends back into the document.

  const overlay = el("textarea", "xd-text-overlay");
  overlay.spellcheck = false;
  overlay.autocapitalize = "off";
  overlay.wrap = "off";

  /// Measure a run of text as it will be drawn.
  ///
  /// The height is lines × line height rather than anything font-metric,
  /// because that is precisely what `excalidrawScene.js`'s `textLayout`
  /// assumes when it lays the lines back out. If these two ever disagree the
  /// text jumps the moment the overlay closes, which is the single most
  /// noticeable bug this editor could have.
  function measure(value, element) {
    const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
    const ctx = canvas.getContext("2d");
    const widths = [];
    if (ctx?.measureText) {
      const previous = ctx.font;
      ctx.font = fontString(element);
      for (const line of lines) widths.push(ctx.measureText(line).width);
      ctx.font = previous;
    }
    return textBox(widths, lineHeightPx(element), lines.length);
  }

  /// Break a line that does not fit even on its own, a character at a time.
  /// A word wider than its container has to go somewhere, and overflowing the
  /// box it is meant to be a label *of* is the one place it must not go.
  function breakLong(line, element, maxWidth) {
    if (measure(line, element).width <= maxWidth) return [line];
    const out = [];
    let chunk = "";
    for (const ch of line) {
      const next = chunk + ch;
      if (chunk && measure(next, element).width > maxWidth) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk = next;
      }
    }
    if (chunk) out.push(chunk);
    return out;
  }

  /// Greedy word wrap to a width, in the element's own font.
  ///
  /// This is the half of a bound label that Rust cannot do: it recentres a label
  /// and knows how wide the container will allow one to be (`labelBudget`), but
  /// it has no font metrics, so it cannot know where the words break. Explicit
  /// newlines are kept, because a line the user pressed Enter for is a line.
  function wrapText(value, element, maxWidth) {
    const text = String(value ?? "").replace(/\r\n?/g, "\n");
    if (!(maxWidth > 0)) return text;
    const out = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const candidate = line ? `${line} ${word}` : word;
        if (!line || measure(candidate, element).width <= maxWidth) {
          line = candidate;
          continue;
        }
        out.push(...breakLong(line, element, maxWidth));
        line = word;
      }
      out.push(...breakLong(line, element, maxWidth));
    }
    return out.join("\n");
  }

  /// How wide the label being edited may be, or 0 when this is free text.
  const labelBudget = () => {
    if (!editing?.containerId || typeof doc?.labelBudget !== "function") return 0;
    const index = indexOfId(editing.containerId);
    if (index < 0) return 0;
    const budget = doc.labelBudget(index);
    return Number.isFinite(budget) && budget > 0 ? budget : 0;
  };

  /// Put the overlay where its element is, at the current zoom, wearing the
  /// element's own font and colour. Called on open, on every keystroke, and
  /// after any camera move — so the text does not shift when the overlay
  /// closes and the painter takes over.
  function placeOverlay() {
    if (!editing || !doc) return;
    const index = indexOfId(editing.id);
    const element = index >= 0 ? doc.element(index) : null;
    if (!element) return;
    const scale = camera.scale;
    // A bound label wraps as it is typed, to the width its container allows —
    // so what is on screen while typing is the shape the text will keep when the
    // overlay closes and the painter takes over.
    const budget = labelBudget();
    const box = measure(budget ? wrapText(overlay.value, element, budget) : overlay.value, element);
    const [sx, sy] = toScreen(element.x, element.y);
    // The element's own width is what the alignment is measured against; a new
    // element has none yet, in which case it grows from the caret.
    const outer = Math.max(element.width || 0, box.width) * scale;
    const width = budget ? budget * scale : Math.max(box.width * scale, 8);
    const align = element.textAlign === "center" ? "center" : element.textAlign === "right" ? "right" : "left";
    const left = align === "center" ? sx + (outer - width) / 2 : align === "right" ? sx + outer - width : sx;
    overlay.style.cssText = [
      "position:absolute",
      `left:${left}px`,
      `top:${sy}px`,
      `width:${width}px`,
      `height:${box.height * scale}px`,
      `font:${fontString({ ...element, fontSize: (element.fontSize ?? 20) * scale })}`,
      `line-height:${lineHeightPx(element) * scale}px`,
      `color:${element.strokeColor || "#1e1e1e"}`,
      `text-align:${align}`,
      `opacity:${opacityOf(element)}`,
      "background:transparent",
      "border:0",
      "outline:0",
      "padding:0",
      "margin:0",
      "resize:none",
      "overflow:hidden",
      budget ? "white-space:pre-wrap" : "white-space:pre",
      "z-index:3",
    ].join(";");
    overlay.wrap = budget ? "soft" : "off";
  }

  /// Open the overlay on an existing element.
  ///
  /// `centre` is a scene point the finished text should be centred on, or null
  /// for text that keeps the top-left corner it was created with. Only a shape's
  /// label passes one: its size is not known until there is something in it, so
  /// where it belongs can only be worked out when the edit ends.
  function openOverlay(element, created, centre = null, containerId = null) {
    if (!element?.id) return;
    editing = { id: element.id, created, centre, containerId };
    overlay.value = element.originalText ?? element.text ?? "";
    wrap.appendChild(overlay);
    placeOverlay();
    overlay.focus?.();
    overlay.setSelectionRange?.(overlay.value.length, overlay.value.length);
    schedule();
  }

  /// A new text element at a scene point, with the overlay already open.
  ///
  /// The element joins the document first and is typed into second, which is
  /// the same shape as a dragged-out rectangle: there is no half-existing
  /// thing for the painter or for undo to know about.
  ///
  /// The zero passed to `endDraft` is the minimum size a draft has to reach to
  /// survive, and a text element that nothing has been typed into yet has no
  /// size at all. The core keeps text out of that check on its own; asking for
  /// zero as well costs nothing and says here, at the call site, that a
  /// zero-by-zero text element is intended rather than an oversight. Deleting
  /// an empty one is `closeOverlay`'s job, where the user's intent is known.
  function createText(x, y, centre = null, containerId = null) {
    if (!doc) return;
    const lh = (style.fontSize ?? 20) * 1.25;
    // Dropped by half a line so the caret lands where the pointer did rather
    // than with its top there.
    edited(doc.beginDraft("text", x, y - lh / 2, styleFor("text", style)));
    edited(doc.endDraft(0));
    const index = doc.selection[0];
    const element = index == null ? null : doc.element(index);
    if (!element) return;
    tools.tool = afterDraw(tools);
    selectionKey = "";
    reselected();
    toolChanged();
    openOverlay(element, true, centre, containerId);
  }

  /// The text bound to a container, or -1.
  ///
  /// The model's own answer where the boundary offers one, and a `containerId`
  /// scan where it does not. The scan is the path an Excalidraw-authored file
  /// takes through an older boundary, which is exactly the case where stacking
  /// a second label would damage somebody else's drawing.
  const labelOf = (index) => {
    if (typeof doc.labelOf === "function") return doc.labelOf(index);
    const id = doc.elementId(index);
    if (!id) return -1;
    for (let i = 0; i < doc.length; i++) {
      const e = doc.element(i);
      if (e && !e.isDeleted && e.type === "text" && e.containerId === id) return i;
    }
    return -1;
  };

  /// Type into a shape: its existing label, or a new one bound to it.
  ///
  /// This is what double-clicking a shape does, and what Enter on a selected
  /// shape does. Before it, both did nothing whatsoever on a filled shape and
  /// dropped a stray free-floating text element on an unfilled one.
  function editLabel(index) {
    const existing = labelOf(index);
    if (existing >= 0) {
      doc.setSelection([existing]);
      reselected();
      openOverlay(doc.element(existing), false, null, doc.elementId(index));
      return;
    }
    const box = doc.elementBounds(index);
    if (!box) return;
    const containerId = doc.elementId(index);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    createText(cx, cy, { x: cx, y: cy }, containerId);
    const textId = editing?.id;
    if (!textId || !containerId || typeof doc.bindLabel !== "function") return;
    // `containerId` on the label and a `{ id, type: "text" }` entry in the
    // container's `boundElements`, written together so the two halves cannot
    // drift apart the way a hand-written pair would.
    edited(doc.bindLabel(containerId, textId));
    // Two things Rust deliberately leaves alone. A *bound* label is centred both
    // ways where free text is left/top (`new_element`'s defaults are free text's,
    // correctly), and re-wrapping needs font metrics, which only JS has — so the
    // width comes from `labelBudget` and the measuring happens in `closeOverlay`.
    edited(doc.patch(textId, { textAlign: "center", verticalAlign: "middle" }));
    placeOverlay();
  }

  /// Close the overlay, writing what was typed back into the document.
  ///
  /// `discard` skips the write — used when the document is about to change
  /// underneath us (an undo) and the element the overlay is editing may not
  /// survive.
  function closeOverlay(discard = false) {
    if (!editing) return;
    const { id, created, centre } = editing;
    const value = overlay.value;
    // Measured while `editing` is still set, because `labelBudget` reads it.
    const budget = labelBudget();
    editing = null;
    overlay.remove();
    if (discard || !doc) return;

    const index = indexOfId(id);
    if (index < 0) return;
    // An empty text element is invisible and unselectable — the user would
    // have no way to get rid of it, and no way to know it was there. So a text
    // edit that ends empty deletes the element rather than leaving one.
    if (!value.trim()) {
      doc.setSelection([index]);
      edited(doc.deleteSelection());
      selectionKey = "";
      reselected();
      return;
    }
    const element = doc.element(index);
    // A bound label is stored twice: `originalText` is what was typed and `text`
    // is what is painted. The field pair has existed in the model since the
    // beginning and both were always written the same string, because nothing
    // wrapped — which is exactly the distinction Excalidraw keeps them for.
    const painted = budget ? wrapText(value, element, budget) : value;
    const box = measure(painted, element);
    // The measurement is the one thing JS knows that Rust does not.
    const fields = { text: painted, originalText: value, width: box.width, height: box.height };
    // A label is centred on its shape, and how wide it is only becomes true
    // once there is text in it — so the placement is settled here, at the end
    // of the edit, rather than guessed at the start of one.
    if (centre) {
      fields.x = centre.x - box.width / 2;
      fields.y = centre.y - box.height / 2;
    }
    edited(doc.patch(id, fields));
    const again = indexOfId(id);
    if (again >= 0) doc.setSelection([again]);
    selectionKey = created ? "" : selectionKey;
    reselected();
  }

  const onOverlayInput = () => {
    placeOverlay();
  };

  const onOverlayKeyDown = (ev) => {
    // Escape and ⌘Enter both commit. Excalidraw commits on Escape too — a text
    // edit has no "cancel", because every keystroke was already visible.
    if (ev.key === "Escape" || (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey))) {
      ev.preventDefault();
      ev.stopPropagation();
      closeOverlay();
      wrap.focus?.();
      return;
    }
    // Everything else belongs to the textarea. Without this the canvas's own
    // handler would read Delete as "delete the selection" while the user is
    // deleting a character.
    ev.stopPropagation();
  };

  const onOverlayBlur = () => closeOverlay();

  // --- verbs, the context menu and the shortcut sheet -----------------------
  //
  // Every document verb in this editor used to be keyboard-only. Group, ungroup
  // and all four z-order moves have no toolbar button, no properties-panel row
  // and no entry in the app's menu (audit-selection.md §3.4) — so a mouse-only
  // user could not reach a single one of them. The right button has been
  // reserved for this since the tool state machine was written: `pointerIntent`
  // returns null for it and says why.
  //
  // One list, two consumers. The popover *runs* these descriptors and the
  // shortcut sheet only *reads* them, which is what stops the sheet from
  // describing a keyboard this editor does not actually have. The shape —
  // `{ name, shortcut, run, disabled }` — is the one `viewActions.js` and the
  // app's own menu already consume, so a host that would rather render these
  // itself can.

  /// The system clipboard, or null when the platform will not lend it.
  ///
  /// ⌘C and ⌘X arrive as `copy`/`cut` events with the data already on them,
  /// which is why `keyIntent` does not claim those keys. A menu click is not one
  /// of those events, so the menu has to write the clipboard itself, and this is
  /// the only way to do that. Where it is missing the row is disabled rather
  /// than present and silently inert.
  const clipboardApi = () => (typeof navigator === "undefined" ? null : navigator?.clipboard ?? null);

  const copyOut = (cut) => {
    const api = clipboardApi();
    if (!api?.writeText) return;
    const elements = selectedElements();
    if (!elements.length) return;
    const written = api.writeText(clipboardText(elements, scene.files));
    if (!cut) return;
    // A cut that deleted before the copy landed would be data loss, so the
    // delete waits for the write — and does not happen at all if it was refused.
    Promise.resolve(written).then(
      () => {
        if (detached || !doc) return;
        edited(doc.deleteSelection());
        reselected();
      },
      () => {},
    );
  };

  const pasteIn = () => {
    const api = clipboardApi();
    if (!api?.readText) return;
    Promise.resolve(api.readText()).then(
      (text) => {
        if (detached || !doc || !text) return;
        const payload = parseClipboard(text);
        if (payload) pasteElements(payload.elements);
        else pasteText(text);
      },
      () => {}, // refused, or nothing readable on it
    );
  };

  const allLocked = () => hasSelection() && selectedElements().every((e) => e.locked === true);

  const hasLocked = () => {
    if (!doc) return false;
    for (let i = 0; i < doc.length; i++) if (doc.element(i)?.locked === true) return true;
    return false;
  };

  /// The coalesce key every lock and unlock shares, so a whole selection
  /// changing state is one undo entry rather than one per element.
  const LOCK_KEY = "lock";

  /// Lock or unlock the selection.
  ///
  /// No new export is needed: `Command::Patch` applies camelCase keys to the
  /// element's JSON form, so `locked` is writable from here today
  /// (audit-selection.md §2a.3). Locking deselects, because a locked element
  /// that stayed selected would still move with an arrow key — the lock has to
  /// bite immediately or it is decoration.
  ///
  /// One patch per element, under one coalesce key, the way `commitErase`
  /// folds a sweep: locking six shapes is one press of undo to take back,
  /// because it was one decision.
  const setLocked = (on) => {
    if (!doc) return;
    const ids = doc.selection.map((i) => doc.elementId(i)).filter(Boolean);
    if (!ids.length) return;
    for (const id of ids) edited(doc.patch(id, { locked: on }, LOCK_KEY));
    if (on) doc.clearSelection();
    selectionKey = "";
    reselected();
  };

  /// Unlock everything in the drawing.
  ///
  /// The way back. The model will not hit-test, marquee or select-all a locked
  /// element (`geometry::is_pickable`), so once something is locked there is no
  /// way to select it and therefore no way to reach "unlock" through the
  /// selection — this is that door, and it is why the row is offered with
  /// nothing selected.
  const unlockAll = () => {
    if (!doc) return;
    for (let i = 0; i < doc.length; i++) {
      if (doc.element(i)?.locked !== true) continue;
      const id = doc.elementId(i);
      if (id) edited(doc.patch(id, { locked: false }, LOCK_KEY));
    }
    reselected();
  };

  /// The verbs, grouped the way the popover separates them.
  const verbGroups = () => {
    const some = hasSelection();
    const api = clipboardApi();
    return [
      {
        title: "Edit",
        items: [
          { name: "Cut", shortcut: "⌘X", disabled: !some || !api?.writeText, run: () => copyOut(true) },
          { name: "Copy", shortcut: "⌘C", disabled: !some || !api?.writeText, run: () => copyOut(false) },
          { name: "Paste", shortcut: "⌘V", disabled: !api?.readText, run: pasteIn },
          {
            name: "Duplicate",
            shortcut: "⌘D",
            disabled: !some,
            run: () => {
              edited(doc.duplicateSelection(PASTE_OFFSET, PASTE_OFFSET));
              selectionKey = "";
              reselected();
            },
          },
          {
            name: "Delete",
            shortcut: "⌫",
            disabled: !some,
            run: () => {
              edited(doc.deleteSelection());
              reselected();
            },
          },
        ],
      },
      {
        title: "Arrange",
        items: [
          { name: "Bring to front", shortcut: "⌘⇧]", disabled: !some, run: () => edited(doc.reorder(REORDER.FRONT)) },
          { name: "Bring forward", shortcut: "⌘]", disabled: !some, run: () => edited(doc.reorder(REORDER.FORWARD)) },
          { name: "Send backward", shortcut: "⌘[", disabled: !some, run: () => edited(doc.reorder(REORDER.BACKWARD)) },
          { name: "Send to back", shortcut: "⌘⇧[", disabled: !some, run: () => edited(doc.reorder(REORDER.BACK)) },
          { name: "Group", shortcut: "⌘G", disabled: doc.selection.length < 2, run: () => edited(doc.group()) },
          { name: "Ungroup", shortcut: "⌘⇧G", disabled: !some, run: () => edited(doc.ungroup()) },
          // Flip needs one element; align needs two to align *to*; distribute
          // needs three, because two are already evenly spaced. Those are the
          // same thresholds the core no-ops at and upstream greys out at.
          { name: "Flip horizontally", shortcut: "⇧H", disabled: !some, run: () => edited(doc.flip?.("horizontal")) },
          { name: "Flip vertically", shortcut: "⇧V", disabled: !some, run: () => edited(doc.flip?.("vertical")) },
        ],
      },
      {
        title: "Protect",
        items: [
          {
            name: allLocked() ? "Unlock" : "Lock",
            shortcut: "⌘⇧L",
            disabled: !some,
            run: () => setLocked(!allLocked()),
          },
          { name: "Unlock all", disabled: !hasLocked(), run: unlockAll },
          {
            name: "Select all",
            shortcut: "⌘A",
            run: () => {
              doc.selectAll();
              reselected();
            },
          },
        ],
      },
    ];
  };

  /// A popover's listeners, kept so its teardown can take every one back off.
  const listenerBag = () => {
    const list = [];
    return {
      on: (node, type, fn) => {
        node.addEventListener(type, fn);
        list.push([node, type, fn]);
      },
      off: () => {
        for (const [node, type, fn] of list) node.removeEventListener(type, fn);
        list.length = 0;
      },
    };
  };

  const ROW_STYLE = [
    "display:flex", "width:100%", "gap:24px", "align-items:center",
    "justify-content:space-between", "padding:5px 8px", "background:transparent",
    "border:0", "border-radius:5px", "color:inherit", "font:inherit",
    "text-align:left", "cursor:pointer",
  ].join(";");

  const SURFACE_STYLE = [
    "background:var(--bg, #ffffff)", "color:var(--fg, #1e1e1e)",
    "border:1px solid var(--border, rgba(0,0,0,0.15))", "border-radius:8px",
    "box-shadow:0 8px 28px rgba(0,0,0,0.18)", "padding:4px",
    "font:13px/1.4 system-ui, -apple-system, sans-serif",
  ].join(";");

  /// One descriptor as a row. Shared by the popover and the sheet so the two
  /// cannot drift into looking like different applications.
  const rowFor = (item, bag) => {
    const row = el(bag ? "button" : "div", "xd-menu-item");
    if (bag) row.type = "button";
    row.style.cssText = `${ROW_STYLE};opacity:${item.disabled ? 0.45 : 1}`;
    row.appendChild(el("span", "xd-menu-name", item.name));
    if (item.shortcut) {
      const key = el("span", "xd-menu-key", item.shortcut);
      key.style.cssText = "opacity:0.55;white-space:nowrap";
      row.appendChild(key);
    }
    if (!bag) return row;
    row.disabled = !!item.disabled;
    bag.on(row, "click", () => {
      if (item.disabled) return;
      closeMenu();
      item.run?.();
      takeFocus();
    });
    return row;
  };

  const separator = () => {
    const line = div("xd-menu-sep");
    line.style.cssText = "height:1px;margin:4px 6px;background:var(--border, rgba(0,0,0,0.12))";
    return line;
  };

  function closeMenu() {
    if (!menuEl) return;
    menuBag?.off();
    menuBag = null;
    menuEl.remove();
    menuEl = null;
  }

  function openMenu(sx, sy) {
    closeMenu();
    menuBag = listenerBag();
    menuEl = div("xd-menu");
    menuEl.setAttribute("role", "menu");
    menuEl.setAttribute("aria-label", "Element actions");
    // Clamped so a right-click near the right edge does not open a menu that is
    // half outside the pane. The width is the minimum below rather than a
    // measurement, because measuring means a layout pass before it is on screen.
    const left = Math.max(0, Math.min(sx, Math.max(0, wrap.clientWidth - 220)));
    const top = Math.max(0, Math.min(sy, Math.max(0, wrap.clientHeight - 40)));
    menuEl.style.cssText = `position:absolute;left:${left}px;top:${top}px;z-index:5;min-width:212px;${SURFACE_STYLE}`;
    verbGroups().forEach((group, i) => {
      if (i) menuEl.appendChild(separator());
      for (const item of group.items) menuEl.appendChild(rowFor(item, menuBag));
    });
    wrap.appendChild(menuEl);
  }

  const onContextMenu = (ev) => {
    if (detached || !doc || !onCanvas(ev)) return;
    ev.preventDefault?.();
    closeOverlay();
    const [sx, sy] = localOf(ev);
    const [x, y] = toScene(sx, sy);
    // Right-clicking something outside the selection selects it first. Without
    // that the menu's verbs act on whatever was selected before, which is never
    // what the pointer just pointed at.
    const hit = hitAt(x, y);
    if (hit >= 0 && !doc.selection.includes(hit)) {
      doc.setSelection([hit]);
      reselected();
    }
    openMenu(sx, sy);
  };

  /// The shortcut sheet's contents.
  ///
  /// The tools come from `TOOLS`, which is the only list of them anywhere, and
  /// the verbs come from the same descriptors the popover runs. Nothing here is
  /// typed out twice, so a key that changes changes here with it.
  const shortcutGroups = () => [
    {
      title: "Tools",
      items: TOOLS.map((t) => ({
        name: t.label,
        shortcut: [t.key.toUpperCase(), t.alias?.toUpperCase(), t.digit].filter(Boolean).join(" / "),
      })),
    },
    ...verbGroups().map((g) => ({
      title: g.title,
      items: g.items.filter((i) => i.shortcut).map((i) => ({ name: i.name, shortcut: i.shortcut })),
    })),
    {
      title: "View",
      items: [
        { name: "Zoom in", shortcut: "⌘+" },
        { name: "Zoom out", shortcut: "⌘−" },
        { name: "Actual size", shortcut: "⌘0" },
        { name: "Zoom to fit", shortcut: "⇧1" },
        { name: "Zoom to selection", shortcut: "⇧2" },
        { name: "Grid", shortcut: "⌘'" },
        { name: "Pan", shortcut: "Space-drag" },
        { name: "Enclose-only marquee", shortcut: "⌥-drag" },
        { name: "Ignore snapping", shortcut: "⌥-drag" },
      ],
    },
    {
      title: "Document",
      items: [
        { name: "Undo", shortcut: "⌘Z" },
        { name: "Redo", shortcut: "⌘⇧Z" },
        { name: "Save", shortcut: "⌘S" },
        { name: "Edit text", shortcut: "Enter" },
        { name: "Keep the tool after drawing", shortcut: "Q" },
        { name: "This sheet", shortcut: "?" },
      ],
    },
  ];

  function closeHelp() {
    if (!helpEl) return;
    helpBag?.off();
    helpBag = null;
    helpEl.remove();
    helpEl = null;
    takeFocus();
    schedule();
  }

  /// The shortcut sheet.
  ///
  /// Deliberately *not* `a11y.js`'s `asDialog`, which is the obvious candidate
  /// and is the wrong shape here: it listens on `document`, looks the stack of
  /// open dialogs up by a `.modal-overlay` class the app shell owns, and hands
  /// focus back to `document.activeElement`. This view may not touch anything
  /// outside the host element it was handed — that rule is the whole reason the
  /// port is a copy — so the sheet is a plain panel inside `wrap`, and Escape,
  /// which `onKeyDown` already claims, closes it.
  function openHelp() {
    if (helpEl) return;
    helpBag = listenerBag();
    helpEl = div("xd-help");
    helpEl.setAttribute("role", "dialog");
    helpEl.setAttribute("aria-modal", "true");
    helpEl.setAttribute("aria-label", "Keyboard shortcuts");
    helpEl.tabIndex = -1;
    helpEl.style.cssText = [
      "position:absolute", "left:50%", "top:50%", "transform:translate(-50%,-50%)",
      "z-index:6", "max-height:82%", "overflow:auto", "padding:16px 18px",
      "display:grid", "gap:18px", "grid-template-columns:repeat(2, minmax(210px, 1fr))",
      SURFACE_STYLE,
    ].join(";");

    for (const group of shortcutGroups()) {
      const column = div("xd-help-group");
      const heading = el("h2", "xd-help-title", group.title);
      heading.style.cssText = "margin:0 0 6px;font:600 12px/1.4 inherit;opacity:0.6;text-transform:uppercase";
      column.appendChild(heading);
      for (const item of group.items) column.appendChild(rowFor(item, null));
      helpEl.appendChild(column);
    }

    const close = el("button", "xd-help-close", "Close");
    close.type = "button";
    close.style.cssText = `${ROW_STYLE};justify-content:center;grid-column:1/-1;border:1px solid var(--border, rgba(0,0,0,0.15))`;
    helpBag.on(close, "click", closeHelp);
    helpEl.appendChild(close);

    wrap.appendChild(helpEl);
    helpEl.focus?.();
    schedule();
  }

  const toggleHelp = () => {
    closeMenu();
    if (helpEl) closeHelp();
    else openHelp();
  };

  // --- the properties panel ------------------------------------------------
  //
  // Loaded lazily and tolerated absent. The panel is a separate module written
  // against a contract; this view has to work while it does not exist yet, and
  // has to keep working if it ever fails to load.

  /// Whether the properties sidebar is on screen. The view owns the state and
  /// the host owns the button, which is the same division as the tool island:
  /// the host decides where a control lives, the view decides what it means.
  ///
  /// Null until a host says otherwise, and null is not "closed" — it is "no
  /// opinion", which hands the decision back to the panel's own rule. A host
  /// that never drew a toggle must not be silently made to hold one.
  let sidebarOpen = sidebar == null ? null : !!sidebar;

  /// The element kinds a style patch is about to land on.
  ///
  /// The selection's types when there is one; otherwise the shape the active
  /// tool would draw, because a patch with nothing selected is a preference for
  /// the next shape and "the next shape" is a kind too. Two fields need it:
  /// stroke width, whose px depends on whether the target is a pencil stroke,
  /// and roundness, whose *type* is a property of the kind.
  const selectedKinds = () => {
    if (hasSelection()) return doc.selection.map((i) => doc.element(i)?.type).filter(Boolean);
    const tool = TOOLS.find((t) => t.id === tools.tool);
    return tool?.shape ? [tool.shape] : [];
  };

  const applyStyle = (patch, opts) => {
    const kinds = selectedKinds();
    style = mergeStyle(style, patch, kinds);
    // With a selection, the patch is an edit; without one it is a preference
    // for the next shape. Both, always — otherwise drawing a red box, clicking
    // away and drawing another gets you a black one.
    if (hasSelection()) {
      const fields = stylePatch(patch, kinds);
      // Sloppiness re-rolls the seed, and the patch and the re-roll have to be
      // one command. Excalidraw writes `seed: randomInteger()` on every
      // sloppiness change (`actionProperties.tsx:711`), and without it the same
      // random draws are merely scaled by the new roughness — the measured
      // symptom is ink getting heavier, 2.00 → 3.08 → 4.14px, which reads as
      // weight rather than as a different hand. Two separate writes would let an
      // undo land between them and leave the new roughness on the old seed.
      if (opts?.resketch && doc.setStyleResketched) {
        edited(doc.setStyleResketched(fields));
      } else {
        edited(doc.setStyle(fields));
        // Until the boundary forwards `setStyleResketched` the re-roll is a
        // second command: two undo entries where there should be one, but the
        // right pixels.
        if (opts?.resketch && doc.reseed) edited(doc.reseed());
      }
    }
    panel?.refresh?.();
    schedule();
  };

  /// The remembered defaults, as the panel wants to read them.
  ///
  /// `fileStyle` drops the editor's own `strokeWidthKey` memo, and then the width
  /// is resolved back through it for the kind that is about to be drawn — so the
  /// button the panel lights up is the width the next shape will actually get.
  /// Without that second step, "Extra bold" chosen on a pencil stroke would show
  /// as Bold the moment the rectangle tool was picked.
  const panelDefaults = () => {
    const out = fileStyle(style);
    if (style.strokeWidthKey) {
      out.strokeWidth = strokeWidthPx(style.strokeWidthKey, selectedKinds()[0] ?? "rectangle");
    }
    return out;
  };

  import("./excalidrawProps.js")
    .then((mod) => {
      if (detached || typeof mod.renderProps !== "function") return;
      panel = mod.renderProps(panelHost, {
        // An array, one style per selected element, so the panel can fold them
        // and show "mixed" rather than the *first* element's values pressed —
        // which is a button already in its on state that rewrites both when
        // clicked.
        getStyle: () => (hasSelection()
          ? doc.selection.map((i) => styleFrom(doc.element(i)))
          : panelDefaults()),
        setStyle: applyStyle,
        hasSelection,
        // Which types are selected, so the panel can show only the groups that
        // mean something for them — and resolve a stroke-width key against the
        // right table.
        getKinds: selectedKinds,
        // A live function rather than a value: the panel takes itself off
        // screen over an empty canvas with the select tool active, and the
        // tool changes on a keystroke it never sees.
        activeTool: () => tools.tool,
        // With a toggle in the host's chrome, "is it open" is the user's
        // answer and not a guess from the tool and the selection. The panel's
        // own rule stays the default for hosts that never call setSidebar.
        shown: () => sidebarOpen,
        // The manipulation verbs the panel can offer a row for. Only the ones
        // that exist: `align`, `distribute` and `flip` have no core op and no
        // export (audit-selection.md §3.5), and the panel leaves a row out
        // rather than showing one that does nothing.
        //
        // `reseed` is deliberately absent. The panel sends `{ resketch: true }`
        // with the patch when nothing here claims to re-roll separately, and
        // `applyStyle` handles that — supplying `reseed` as well would ask for
        // the seed to be re-rolled twice.
        actions: {
          reorder: (how) => edited(doc.reorder(REORDER[String(how).toUpperCase()])),
          align: (edge) => edited(doc.align?.(edge)),
          distribute: (axis) => edited(doc.distribute?.(axis)),
          flip: (axis) => edited(doc.flip?.(axis)),
          group: () => edited(doc.group()),
          ungroup: () => edited(doc.ungroup()),
        },
        // The document's own view state, which needed `setAppState` before any
        // of it could be offered. The panel keeps these rows off screen entirely
        // unless both halves of a pair are supplied, so they were dark until now.
        getCanvasBackground: () => scene.appState?.viewBackgroundColor ?? "#ffffff",
        setCanvasBackground: (color) => appStateSet({ viewBackgroundColor: color }),
        getTheme: () => (scene.appState?.theme === "dark" ? "dark" : "light"),
        setTheme: (theme) => appStateSet({ theme }),
      });
      panel.refresh?.();
    })
    .catch(() => {
      // The editor is fully usable from the keyboard without it; a missing
      // panel is a missing convenience, not a broken view.
    });

  // --- export ---------------------------------------------------------------
  //
  // Both of these render the *document*, not the view: no camera, no selection
  // chrome, a margin of their own, and every element rather than the visible
  // ones. And both go through `drawElement`, which is what makes an export look
  // like the screen.
  //
  // Neither writes a file. The view returns a string or bytes and the host
  // chooses where they go — `ui/standalone/export.js` does the dialog and the
  // write, and this file may not know that a filesystem exists.

  /// The box an export covers: the drawing, plus a margin.
  const exportBox = () => {
    const box = doc?.sceneBounds();
    if (!box) return null;
    return {
      minX: box.minX - EXPORT_PADDING,
      minY: box.minY - EXPORT_PADDING,
      maxX: box.maxX + EXPORT_PADDING,
      maxY: box.maxY + EXPORT_PADDING,
    };
  };

  /// Every element, painted onto whatever surface is handed in.
  const paintDocument = (ctx, rc) => {
    for (const element of doc.elements()) {
      if (!element) continue;
      try {
        drawElement(ctx, rc, element, scene, images);
      } catch {
        // One malformed element must not lose the whole export, the same way it
        // must not blank the whole drawing.
      }
    }
  };

  /// The drawing as an SVG string.
  const exportSVG = () => {
    if (!doc) throw new Error("the drawing hasn't finished opening yet");
    const box = exportBox();
    if (!box) throw new Error("there's nothing in this drawing to export");
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    const surface = svgSurface();
    paintDocument(surface.ctx, surface.rc);
    // The viewBox is the scene's own coordinates, so nothing had to be
    // translated on the way in and the numbers in the file are the numbers in
    // the drawing — which makes a hand-read of the output possible.
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(w)}" height="${n2(h)}"`
        + ` viewBox="${n2(box.minX)} ${n2(box.minY)} ${n2(w)} ${n2(h)}">`,
      // The scene's own background, for the same reason the paint loop uses it:
      // a drawing authored on white is unreadable on whatever the viewer's
      // default happens to be.
      `<rect x="${n2(box.minX)}" y="${n2(box.minY)}" width="${n2(w)}" height="${n2(h)}"`
        + ` fill="${xmlAttr(scene.appState?.viewBackgroundColor || "#ffffff")}"/>`,
      ...surface.nodes(),
      "</svg>",
      "",
    ].join("\n");
  };

  /// The drawing as PNG bytes.
  ///
  /// A second canvas, not this one: the on-screen canvas is at the current camera
  /// and carries the selection chrome, and a resize would have to be undone
  /// afterwards. `toBlob` rather than `toDataURL` because the caller wants bytes
  /// and a base64 round trip through a string is what `xd_write_bytes` exists to
  /// avoid.
  const exportPNG = async (scale = EXPORT_SCALE) => {
    if (!doc) throw new Error("the drawing hasn't finished opening yet");
    const box = exportBox();
    if (!box) throw new Error("there's nothing in this drawing to export");
    const k = Math.max(0.1, Number(scale) || EXPORT_SCALE);
    const off = wrap.ownerDocument?.createElement?.("canvas") ?? el("canvas");
    off.width = Math.max(1, Math.ceil((box.maxX - box.minX) * k));
    off.height = Math.max(1, Math.ceil((box.maxY - box.minY) * k));
    const ctx = off.getContext?.("2d");
    if (!ctx) throw new Error("this platform has no 2D canvas to render into");
    ctx.fillStyle = scene.appState?.viewBackgroundColor || "#ffffff";
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.scale(k, k);
    ctx.translate(-box.minX, -box.minY);
    paintDocument(ctx, rough.canvas(off));
    if (typeof off.toBlob !== "function") {
      throw new Error("this platform can't turn a canvas into an image");
    }
    const blob = await new Promise((resolve, reject) => {
      off.toBlob((b) => (b ? resolve(b) : reject(new Error("the canvas produced no image"))), "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
  };

  // --- wiring --------------------------------------------------------------

  const listeners = [
    [wrap, "pointerdown", onPointerDown, undefined],
    [wrap, "pointermove", onPointerMove, undefined],
    [wrap, "pointerup", onPointerUp, undefined],
    [wrap, "pointercancel", onPointerUp, undefined],
    [wrap, "dblclick", onDoubleClick, undefined],
    [wrap, "contextmenu", onContextMenu, undefined],
    [wrap, "wheel", onWheel, { passive: false }],
    [wrap, "keydown", onKeyDown, undefined],
    [wrap, "keyup", onKeyUp, undefined],
    [wrap, "copy", onCopy, undefined],
    [wrap, "cut", onCut, undefined],
    [wrap, "paste", onPaste, undefined],
    [wrap, "dragover", onDragOver, undefined],
    [wrap, "drop", onDrop, undefined],
    [filePicker, "change", onPickImage, undefined],
    [overlay, "input", onOverlayInput, undefined],
    [overlay, "keydown", onOverlayKeyDown, undefined],
    [overlay, "blur", onOverlayBlur, undefined],
    [typeof window === "undefined" ? null : window, "blur", onBlur, undefined],
  ];
  for (const [target, type, fn, opts] of listeners) target?.addEventListener(type, fn, opts);

  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    placeOverlay();
    schedule();
  });
  ro?.observe(wrap);

  /// The host repainting itself in a different palette. Watched rather than
  /// pushed: a host that switches themes does so by changing an attribute on
  /// <html> — the app writes `data-theme` there, and term.hut's own theming
  /// works the same way — so the view can notice on its own and needs no
  /// second entry in the mount contract for it. A host that never changes
  /// anything up there never fires this.
  const themeWatch = typeof MutationObserver === "undefined" || !wrap.ownerDocument
    ? null
    : new MutationObserver(() => {
      if (detached) return;
      colors = chromeTheme(wrap);
      schedule();
    });
  themeWatch?.observe(wrap.ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });

  toolbar = renderToolbar(toolbarSlot ?? toolbarHost, {
    inline: !!toolbarSlot,
    getTool: () => tools.tool,
    setTool: (id) => {
      tools.tool = id;
      toolChanged();
      // Or the keyboard stays on the button that was just clicked, and the
      // next shortcut — and the next ⌘C — goes nowhere.
      takeFocus();
    },
    getLocked: () => tools.locked,
    setLocked: (value) => {
      tools.locked = value;
      toolChanged();
      takeFocus();
    },
  });

  publish();
  // The canvas takes the keyboard on mount so the first ⌘C, ⌘A or R works
  // without the user having to click the drawing first. It is the only thing
  // in the host that wants the keyboard by default; a host that disagrees can
  // focus something else immediately after, and this will not take it back.
  takeFocus();

  // --- opening -------------------------------------------------------------
  //
  // Asynchronous because the WASM core is loaded lazily — the same precedent
  // as bpmn-js in term.hut, and a session that never opens a drawing never
  // pays for it. The view is already on screen and already contributing to the
  // header by the time this starts.

  let note = null;
  // Wrapped in a resolved promise so a factory that throws synchronously
  // lands on the same path as one whose promise rejects — the pane says what
  // is wrong either way.
  Promise.resolve()
    .then(() => openDocument(drawingSource(text)))
    .then(
      (opened) => {
        if (detached) return;
        doc = opened;
        // The host owns the clock: xd-core has no `SystemTime` because it
        // compiles to wasm, so `updated` stamps come from here.
        doc.setNow(Date.now());
        syncFiles();
        fit();
        publish();
        reselected();
        schedule();
      },
      (err) => {
        if (detached) return;
        // A file we cannot parse must not be silently replaced by a blank
        // canvas: that would be one stray keystroke away from overwriting it.
        // The same call bpmnView.js makes, for the same reason.
        wrap.remove();
        note = div("preview-note err", openMessage(err));
        host.appendChild(note);
        onActions?.([]);
      },
    );

  // --- teardown ------------------------------------------------------------

  /// The handle. A function, because the contract is "returns dispose" and
  /// term.hut's preview.js stores exactly that — with the view's capabilities
  /// hung off it, which is the shape export.js already reaches for
  /// (`view.exportPNG`). A host that only ever calls it as a function never
  /// notices the rest.
  dispose.setSidebar = (on) => {
    if (detached) return;
    sidebarOpen = !!on;
    panel?.refresh?.();
  };
  dispose.sidebarOpen = () => sidebarOpen;
  // The two export capabilities, which is the shape `ui/standalone/export.js`
  // already reaches for (`view.exportSVG`, `view.exportPNG`). They render and
  // return; the host decides where the result goes.
  dispose.exportSVG = exportSVG;
  dispose.exportPNG = exportPNG;
  return dispose;

  function dispose() {
    if (detached) return;
    detached = true;

    // Everything that could fire into a torn-down view goes first, and goes
    // synchronously. bpmnView.js defers its teardown behind a pending save;
    // here the listeners cannot wait for that, because a pointer event landing
    // during the flush would edit a document nobody is watching.
    for (const [target, type, fn, opts] of listeners) target?.removeEventListener(type, fn, opts);
    ro?.disconnect();
    themeWatch?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    closeMenu();
    closeHelp();
    // Commit rather than discard. This used to be `editing = null` followed by
    // `overlay.remove()`, which threw away whatever had been typed — and for a
    // *new* text element it was worse than that: `createText` has already
    // inserted it and armed the autosave, so a dispose landing inside the 800 ms
    // debounce wrote an invisible 0×0 empty text element to disk. Both halves
    // are `closeOverlay`'s job already: it deletes the element when the value is
    // blank and patches the measured box otherwise. The pending save flushed at
    // the end of this function is what lets the commit reach the file, which is
    // the same promise the comment down there makes.
    closeOverlay();
    overlay.remove();
    panel?.dispose?.();
    panel = null;
    toolbar?.dispose();
    toolbar = null;
    // The decoded images are held only by this map and were never in the
    // document, and their sources are data: URLs, so there is no fetch left in
    // flight to abort.
    images.clear();
    wrap.remove();
    note?.remove();
    note = null;

    // A tab closing on a debounce that has not fired yet is an edit the user
    // made and would never see again, so the pending save is flushed —
    // `disposed` stays false until it lands, which is what lets `save()` run
    // at all.
    const pending = timer != null;
    clearTimeout(timer);
    timer = null;
    const finish = () => {
      disposed = true;
      doc = null;
    };
    if (pending) save().then(finish, finish);
    else finish();
  }
}
