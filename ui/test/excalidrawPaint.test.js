// The paint loop, actually run.
//
// Everything else in ui/test/ verifies the editor without ever producing a
// pixel. `contract.test.js` mounts the view against a canvas whose
// `getContext` returns null — the honest headless answer, and the reason
// `paint()` bails out on its first line there. `excalidrawChrome.test.js`
// drives the drawing helpers directly, with bounds objects it builds itself.
// Neither has ever executed the code between them: the part that asks the
// document for elements, decides which chrome to draw, and hands both to the
// painter.
//
// That gap matters more than it sounds. A `TypeError` in `paintChrome`, a
// bounds object of the wrong shape reaching `drawHandles`, a `drawElement`
// call with its arguments in the wrong order — none of it fails a test, and
// all of it shows up in the app as a blank canvas, which is the single worst
// symptom this program can have and the hardest to attribute.
//
// So this file mounts the real view, against the real document model, with a
// canvas whose context records every call, and drives a frame in each of the
// states `paintChrome` branches on. The assertions are deliberately coarse —
// that the right *kinds* of call happened and that nothing threw.
// `excalidrawChrome.test.js` already pins the geometry to the pixel; this is
// about the wiring, which is the part that has never once run.
//
// Rough.js is a real vendored module and runs for real against the recorder.
// If it ever reaches for a context method the recorder cannot answer, that is
// a finding about the fake and not something to paper over.

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  FakeNode, installDom, uninstallDom, recorder, callsOf, flushFrames, leakedListeners,
} from "./support/harness.js";
import { openDoc as openReal } from "./wasmHarness.js";
import { renderExcalidraw } from "../src/excalidrawEdit.js";

// --- a scene with one of everything ------------------------------------------
//
// Every branch of `drawElement`, including the default one. The unknown type
// is the important member: Excalidraw's schema drifts, an `embeddable` or an
// `iframe` is a live web view there and cannot be one here, and the painter is
// supposed to draw a labelled placeholder rather than throw or vanish.

const base = (over) => ({
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "#ffc9c9",
  fillStyle: "hachure",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  seed: 12345,
  version: 1,
  versionNonce: 1,
  updated: 0,
  isDeleted: false,
  groupIds: [],
  ...over,
});

const EVERYTHING = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [
    base({ id: "r", type: "rectangle", x: 0, y: 0, width: 80, height: 50, roundness: { type: 3 } }),
    base({ id: "d", type: "diamond", x: 100, y: 0, width: 80, height: 50 }),
    base({ id: "e", type: "ellipse", x: 200, y: 0, width: 80, height: 50 }),
    base({ id: "l", type: "line", x: 0, y: 80, width: 80, height: 40, points: [[0, 0], [40, 20], [80, 40]] }),
    base({ id: "a", type: "arrow", x: 100, y: 80, width: 80, height: 40, points: [[0, 0], [80, 40]], endArrowhead: "arrow" }),
    base({ id: "f", type: "freedraw", x: 200, y: 80, width: 40, height: 40, points: [[0, 0], [10, 12], [24, 30], [40, 40]], pressures: [0.4, 0.5, 0.6, 0.5] }),
    base({ id: "t", type: "text", x: 0, y: 160, width: 120, height: 25, text: "hello\nthere", originalText: "hello\nthere", fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", lineHeight: 1.25 }),
    // An image whose bytes are not in the file — Excalidraw can save one whose
    // data lives in its own backend. It draws as a placeholder, which is the
    // branch worth running because it is the one nobody looks at.
    base({ id: "i", type: "image", x: 140, y: 160, width: 60, height: 60, fileId: "missing" }),
    base({ id: "fr", type: "frame", x: 220, y: 160, width: 90, height: 60, name: "Frame 1" }),
    base({ id: "x", type: "embeddable", x: 0, y: 240, width: 90, height: 40 }),
    // A rotated rectangle, so the angle branch of drawElement and the rotated
    // selection frame both get a turn.
    base({ id: "rot", type: "rectangle", x: 120, y: 240, width: 70, height: 40, angle: 0.6 }),
  ],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

// --- mounting ----------------------------------------------------------------

let ctx = null;
let live = null;

beforeEach(() => {
  ctx = null;
  live = null;
  // A pane with a real size, and a canvas that answers. Both are what
  // `paint()` checks before it does anything, and both are what the rest of
  // ui/test/ deliberately withholds.
  installDom({
    width: 800,
    height: 600,
    context: () => (ctx = ctx ?? recorder()),
  });
});
afterEach(uninstallDom);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const mount = async (text = EVERYTHING) => {
  const host = new FakeNode("main");
  const dispose = renderExcalidraw(host, text, {
    onSave: () => {},
    onActions: () => {},
    openDocument: async (t) => (live = openReal(t)),
  });
  await settle();
  return { host, dispose, wrap: host.children[0] };
};

/// Run whatever the view has queued, and hand back *this frame's* calls.
///
/// A delta rather than the whole record, because the recorder is one object
/// for the life of the view — the painter asks for a context per frame and
/// Rough.js asks for its own, and a recorder that reset between those two
/// would record half a drawing. Without the delta, "the marquee added a filled
/// rectangle" is unanswerable, because the previous frame's background fill is
/// still in the list.
///
/// It also asserts a frame was queued at all. Zero is the blank-canvas
/// symptom, and it is indistinguishable from a frame that ran and drew nothing
/// if you only look at the calls.
const paintFrame = () => {
  const from = ctx?.calls.length ?? 0;
  const ran = flushFrames();
  expect(ran).toBeGreaterThan(0);
  return { calls: ctx.calls.slice(from) };
};

const kinds = (c) => new Set(c.calls.map((call) => call[0]));

/// The two calls that only the editor's chrome makes.
///
/// Deliberately not `strokeRect`: `drawFrame` and `drawPlaceholder` both
/// stroke a bare rectangle for reasons that have nothing to do with selection,
/// so a scene containing a frame or an unrenderable embed has three of them
/// before any chrome is drawn at all. `rect` (the eight square handles) and
/// `arc` (the rotate handle) are drawn by nothing else.
const handleCount = (c) => callsOf(c, "rect").length;
const rotateCount = (c) => callsOf(c, "arc").length;

// The camera after `fit()` on an 800x600 pane; the presses below go through it
// the same way the view does, so a test can name a scene coordinate.
const toScreen = (view, x, y) => {
  // fit() is deterministic for a given scene and viewport, and the view has
  // already applied it by the time this runs. Recovering it from the model
  // rather than recomputing it keeps this honest if the fit ever changes.
  const t = live.fitTransform(view.clientWidth, view.clientHeight);
  return [x * t.scale + t.offsetX, y * t.scale + t.offsetY];
};

const press = (wrap, x, y, extra = {}) =>
  wrap.dispatch("pointerdown", { pointerId: 1, button: 0, target: wrap.children[0], clientX: toScreen(wrap, x, y)[0], clientY: toScreen(wrap, x, y)[1], shiftKey: false, altKey: false, ...extra });
const move = (wrap, x, y, extra = {}) =>
  wrap.dispatch("pointermove", { pointerId: 1, clientX: toScreen(wrap, x, y)[0], clientY: toScreen(wrap, x, y)[1], shiftKey: false, altKey: false, ...extra });
const lift = (wrap, x, y) =>
  wrap.dispatch("pointerup", { pointerId: 1, clientX: toScreen(wrap, x, y)[0], clientY: toScreen(wrap, x, y)[1] });
const type = (wrap, key, extra = {}) =>
  wrap.dispatch("keydown", { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });

// --- the drawing half --------------------------------------------------------

test("a frame paints, and paints every kind of element", async () => {
  const { dispose } = await mount();
  const c = paintFrame();

  // It ran at all. Zero calls is the blank-canvas symptom this file exists for.
  expect(c.calls.length).toBeGreaterThan(50);

  const seen = kinds(c);
  // The canvas was set up: cleared, filled with the scene's own background,
  // and put into the camera's transform.
  expect(seen).toContain("clearRect");
  expect(seen).toContain("fillRect");
  expect(seen).toContain("translate");
  expect(seen).toContain("scale");
  // The scene's background colour, not the app's — a drawing authored on white
  // is unreadable composited onto a dark pane.
  expect(c.calls.some((call) => call[0] === "set:fillStyle" && call[1] === "#ffffff")).toBe(true);

  // Rough.js drew: it works in paths and strokes, and it ran for real here.
  expect(seen).toContain("beginPath");
  expect(seen).toContain("stroke");
  // The text element went through fillText, which is the one element kind the
  // painter draws itself rather than through Rough.
  const text = callsOf(c, "fillText").map((call) => call[1]);
  expect(text).toContain("hello");
  expect(text).toContain("there");
  // The frame's label, and the placeholders for the image with no bytes and
  // the element type we have no drawing routine for.
  expect(text).toContain("Frame 1");
  expect(text).toContain("image");
  expect(text).toContain("embeddable");
  // The rotated rectangle turned the canvas rather than being drawn askew.
  expect(seen).toContain("rotate");

  dispose();
});

test("degenerate but legal elements do not blank the drawing", async () => {
  // Zero-size boxes, empty point lists and empty text are all things a real
  // file contains — an element half-created when someone's browser closed, a
  // line whose points were stripped by another tool. Each is a path through
  // `drawElement` that returns early, and any one of them throwing would take
  // the whole frame with it.
  const odd = JSON.parse(EVERYTHING);
  odd.elements.push(
    base({ id: "z", type: "rectangle", x: 300, y: 300, width: 0, height: 0 }),
    base({ id: "p", type: "line", x: 320, y: 300, width: 0, height: 0, points: [] }),
    base({ id: "q", type: "freedraw", x: 340, y: 300, width: 0, height: 0, points: [] }),
    base({ id: "b", type: "text", x: 360, y: 300, width: 0, height: 0, text: "", originalText: "", fontSize: 20, fontFamily: 5 }),
  );
  const { dispose } = await mount(JSON.stringify(odd));
  const c = paintFrame();
  expect(c.calls.length).toBeGreaterThan(50);
  expect(callsOf(c, "fillText").map((call) => call[1])).toContain("hello");
  dispose();
});

test("a file the core will not parse paints nothing, and says so", async () => {
  // The other half of the same worry, and the direction that actually matters:
  // an element the core cannot deserialize — `points: [null, "nonsense"]`, the
  // sort of thing a hand-edited file produces — fails the *whole* open rather
  // than being dropped silently. The result must be a sentence in the pane and
  // not a blank canvas, because a blank canvas over a file we failed to read is
  // one stray keystroke away from overwriting it.
  const broken = JSON.parse(EVERYTHING);
  broken.elements.push(base({ id: "bad", type: "line", x: 0, y: 0, points: [null, "nonsense"] }));

  const host = new FakeNode("main");
  const dispose = renderExcalidraw(host, JSON.stringify(broken), {
    onSave: () => { throw new Error("must not be called"); },
    onActions: () => {},
    openDocument: async (t) => (live = openReal(t)),
  });
  await settle();

  expect(flushFrames()).toBe(0);        // nothing to paint
  expect(host.children).toHaveLength(1); // and something to read
  expect(host.children[0].textContent).toContain("isn't a drawing we can open");
  dispose();
});

test("an empty drawing still paints its background", async () => {
  const { dispose } = await mount(JSON.stringify({
    type: "excalidraw", version: 2, elements: [], appState: { viewBackgroundColor: "#1e1e22" }, files: {},
  }));
  const c = paintFrame();
  expect(kinds(c)).toContain("fillRect");
  expect(c.calls.some((call) => call[0] === "set:fillStyle" && call[1] === "#1e1e22")).toBe(true);
  dispose();
});

// --- the chrome half ---------------------------------------------------------
//
// Each of these is a separate branch in `paintChrome`, and none of them was
// reachable from any test before this file.

test("nothing selected draws no chrome", async () => {
  const { dispose } = await mount();
  const c = paintFrame();
  expect(handleCount(c)).toBe(0);
  expect(rotateCount(c)).toBe(0);
  dispose();
});

test("a single selection draws an outline and nine handles", async () => {
  const { wrap, dispose } = await mount();
  live.setSelection([0]);
  type(wrap, "ArrowRight"); // any edit, to make the view repaint
  const c = paintFrame();

  expect(callsOf(c, "strokeRect").length).toBeGreaterThan(0);
  // Eight square handles, drawn as `rect`, plus the rotate handle as an `arc`.
  // The exact positions are excalidrawChrome.test.js's job.
  expect(handleCount(c)).toBe(8);
  expect(rotateCount(c)).toBe(1);
  dispose();
});

test("a multi-selection outlines each member as well as the union", async () => {
  const { wrap, dispose } = await mount();
  type(wrap, "a", { metaKey: true });
  const c = paintFrame();

  // One dashed outline per member, plus the union box — so at least as many
  // stroked rectangles as there are elements. That is what tells the user
  // *which* things are in the set rather than only where the set is.
  expect(callsOf(c, "strokeRect").length).toBeGreaterThanOrEqual(live.length + 1);
  expect(callsOf(c, "setLineDash").length).toBeGreaterThan(0);
  // Still one set of handles, on the union box.
  expect(handleCount(c)).toBe(8);
  dispose();
});

test("a rotated element's chrome turns with it", async () => {
  const { wrap, dispose } = await mount();
  const rotated = live.elements().findIndex((e) => e.angle !== 0);
  expect(rotated).toBeGreaterThanOrEqual(0);
  live.setSelection([rotated]);
  type(wrap, "ArrowRight");
  const c = paintFrame();

  // The chrome rotates about the selection's centre, which is a translate,
  // rotate, translate around the handles — and is the branch that would throw
  // if `selectionAngle()` ever came back as something other than a number.
  expect(callsOf(c, "rotate").length).toBeGreaterThan(1);
  expect(handleCount(c)).toBe(8);
  dispose();
});

test("a marquee paints its rubber band", async () => {
  const { wrap, dispose } = await mount();
  press(wrap, 600, 600);   // clear of everything
  move(wrap, 400, 400);
  const c = paintFrame();

  // Filled as well as stroked: an outline alone over a busy diagram is hard to
  // see, and the wash is what makes "everything in here" read at a glance.
  expect(callsOf(c, "fillRect").length).toBeGreaterThan(1); // the background, and the band
  expect(callsOf(c, "strokeRect").length).toBeGreaterThan(0);
  lift(wrap, 400, 400);
  dispose();
});

test("a shape being dragged out is painted without handles round it", async () => {
  const { wrap, dispose } = await mount();
  type(wrap, "r");
  press(wrap, 400, 400);
  move(wrap, 500, 460);
  const c = paintFrame();

  // The draft is a real element in the document from the first pixel, so it is
  // drawn like any other — but handles round a rectangle that is still growing
  // read as a glitch, so `paintChrome` returns before them.
  expect(handleCount(c)).toBe(0);
  expect(rotateCount(c)).toBe(0);
  expect(c.calls.length).toBeGreaterThan(50);
  lift(wrap, 500, 460);
  dispose();
});

test("an arrow over a shape paints the binding highlight", async () => {
  const { wrap, dispose } = await mount();
  type(wrap, "a");
  press(wrap, 400, 400);
  move(wrap, 40, 25);      // into the middle of the filled rectangle at 0,0
  expect(live.bindableAt(40, 25, live.elementId(live.selection[0]))).toBeGreaterThanOrEqual(0);
  const c = paintFrame();

  // The highlight is the only dashed stroked rectangle on screen during a
  // draft — the draft itself has no chrome, per the test above.
  expect(callsOf(c, "strokeRect").length).toBeGreaterThan(0);
  expect(callsOf(c, "setLineDash").length).toBeGreaterThan(0);
  lift(wrap, 40, 25);
  dispose();
});

test("the text overlay paints the element it is editing", async () => {
  const { wrap, dispose } = await mount();
  const textIndex = live.elements().findIndex((e) => e.type === "text");
  wrap.dispatch("dblclick", {
    target: wrap.children[0],
    clientX: toScreen(wrap, 10, 170)[0],
    clientY: toScreen(wrap, 10, 170)[1],
  });
  // Whether the double-click landed on the text element or created a new one,
  // an overlay is open and a frame still paints.
  expect(wrap.children.some((c) => c.tagName === "TEXTAREA")).toBe(true);
  expect(textIndex).toBeGreaterThanOrEqual(0);
  const c = paintFrame();
  expect(c.calls.length).toBeGreaterThan(50);
  dispose();
});

// --- and it still tears down -------------------------------------------------

test("a view that has actually painted still disposes clean", async () => {
  // The teardown assertions in contract.test.js run against a view whose paint
  // loop never executed. This is the same check on one that has — a decoded
  // image cache, a live context and a queued frame all exist here and did not
  // there.
  const { host, dispose, wrap } = await mount();
  type(wrap, "a", { metaKey: true });
  paintFrame();
  type(wrap, "ArrowRight");

  dispose();
  await settle();
  expect(leakedListeners()).toEqual([]);
  expect(host.children).toHaveLength(0);
  // And a frame queued by that last edit was cancelled rather than left to
  // fire into a torn-down view.
  expect(flushFrames()).toBe(0);
});
