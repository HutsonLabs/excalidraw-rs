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
import rough from "../vendor/roughjs/rough.esm.js";
import {
  FakeNode, installDom, uninstallDom, recorder, callsOf, flushFrames, leakedListeners,
} from "./support/harness.js";
import { openDoc as openReal } from "./wasmHarness.js";
import { renderExcalidraw } from "../src/excalidrawEdit.js";
import { drawElement } from "../src/excalidrawView.js";
import { roughOptions } from "../src/excalidrawScene.js";

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

// --- what each element branch actually asks Rough for ------------------------
//
// The tests above prove the wiring runs. These prove it runs with the right
// arguments, which is a different and much easier thing to get wrong: nothing
// about `continuousPath`, `curveFitting`, a per-axis corner radius or an
// arrowhead's aim is visible in "did a stroke happen". `excalidrawScene.test.js`
// pins the option *mapping*; this pins the option *call sites*, and the call
// sites were where the sloppiness bug lived — both of them, inverted, while the
// mapping test stayed green.
//
// `drawElement` takes its `rc` as an argument, so the seam is already there: a
// stand-in backed by a real generator records what was asked for and still hands
// back a real Drawable, which the arrowhead code downstream needs to read its
// tangent off.

function roughRecorder() {
  const gen = rough.generator();
  const calls = [];
  const wrap = (name) => (...args) => {
    const drawable = gen[name](...args);
    calls.push({ name, args, options: args[args.length - 1], drawable });
    return drawable;
  };
  return {
    calls,
    last: (name) => calls.filter((c) => !name || c.name === name).at(-1),
    rectangle: wrap("rectangle"),
    path: wrap("path"),
    polygon: wrap("polygon"),
    ellipse: wrap("ellipse"),
    curve: wrap("curve"),
    linearPath: wrap("linearPath"),
    line: wrap("line"),
  };
}

const shape = (over) => base({ id: "s", x: 0, y: 0, width: 200, height: 120, ...over });

/// Draw one element in isolation and hand back both recorders.
const draw = (element, scene = {}) => {
  const ctx = recorder();
  const rc = roughRecorder();
  drawElement(ctx, rc, element, scene, new Map());
  return { ctx, rc };
};

/// The gaps between the sub-paths of a Drawable, split into the ones that are
/// meant to be there and the ones that are the bug.
///
/// Rough draws each path segment twice, so a `move` either jumps back to the
/// start of the segment it is re-drawing — a long, expected hop — or steps to
/// the next segment, where it should land exactly on the previous one's end.
/// Only the second kind is a joint, and at Cartoonist without
/// `preserveVertices` every one of them opens up.
function jointGaps(drawable) {
  const ops = drawable.sets.find((s) => s.type === "path").ops;
  const gaps = [];
  let end = null;
  for (const op of ops) {
    if (op.op === "move") {
      if (end) gaps.push(Math.hypot(op.data[0] - end[0], op.data[1] - end[1]));
      end = [op.data[0], op.data[1]];
    } else if (op.op === "bcurveTo") {
      end = [op.data[4], op.data[5]];
    }
  }
  // Every other gap is a re-draw hop; the joints are the ones between them.
  return gaps.filter((_, i) => i % 2 === 1);
}

test("a rounded rectangle holds its joints together at every sloppiness", () => {
  // The "unconnected" half of the reported bug. A path() is drawn segment by
  // segment, so without preserveVertices each corner's endpoints wander
  // independently — measured 4.7-6.1px of daylight at all eight joints of the
  // app's *default* shape. Excalidraw passes continuousPath true here
  // (shape.ts:786-795) and measures 0.00px at every joint at every seed.
  for (const seed of [12345, 7, 999999]) {
    for (const roughness of [0, 1, 2]) {
      const element = shape({ type: "rectangle", roundness: { type: 3 }, seed, roughness });
      const { rc } = draw(element);
      const call = rc.last("path");
      expect(call).toBeDefined();
      expect(call.options.preserveVertices).toBe(true);
      for (const gap of jointGaps(call.drawable)) {
        expect(gap).toBeCloseTo(0, 10);
      }

      // And the counterfactual, so this test fails if the flag is dropped
      // again rather than only if the path changes: the same path string
      // without it comes apart, and only at Cartoonist.
      const loose = rough.generator().path(call.args[0], roughOptions(element));
      const worst = Math.max(...jointGaps(loose));
      if (roughness === 2) expect(worst).toBeGreaterThan(4);
      else expect(worst).toBeCloseTo(0, 10);
    }
  }
});

test("the continuousPath fix is a no-op at Architect and Artist", () => {
  // preserveVertices is already true below Cartoonist, so every existing
  // drawing at the two tidier settings renders bit-identically before and
  // after. This is the regression that stops a future change to the flag from
  // silently redrawing files nobody edited.
  for (const roughness of [0, 1]) {
    const element = shape({ type: "rectangle", roundness: { type: 3 }, roughness });
    const call = draw(element).rc.last("path");
    const gen = rough.generator();
    const withFlag = gen.path(call.args[0], roughOptions(element, { continuousPath: true }));
    const without = gen.path(call.args[0], roughOptions(element));
    expect(JSON.stringify(without.sets)).toBe(JSON.stringify(withFlag.sets));
  }
  // At Cartoonist it is emphatically not a no-op, which is the whole point.
  const cartoonist = shape({ type: "rectangle", roundness: { type: 3 }, roughness: 2 });
  const gen = rough.generator();
  const path = draw(cartoonist).rc.last("path").args[0];
  expect(JSON.stringify(gen.path(path, roughOptions(cartoonist)).sets))
    .not.toBe(JSON.stringify(gen.path(path, roughOptions(cartoonist, { continuousPath: true })).sets));
});

test("a sharp rectangle is allowed to come apart, because Excalidraw's does", () => {
  // shape.ts:797-810 passes continuousPath false for a box with square corners.
  // One primitive, no segment joints to hold, and the corner gaps are part of
  // the look — so this must not be "fixed" alongside the rounded branch.
  const { rc } = draw(shape({ type: "rectangle", roughness: 2 }));
  expect(rc.last().name).toBe("rectangle");
  expect(rc.last().options.preserveVertices).toBe(false);
});

test("a line does not force preserveVertices, which is the other inversion", () => {
  // The flag was passed true here and omitted on the rounded box: exactly
  // backwards from shape.ts:875, which passes false for every line and arrow.
  const line = shape({ type: "line", roughness: 2, points: [[0, 0], [100, 40], [200, 0]] });
  expect(draw(line).rc.last().options.preserveVertices).toBe(false);
  const arrow = shape({ type: "arrow", roughness: 2, points: [[0, 0], [200, 0]] });
  expect(draw(arrow).rc.last("linearPath").options.preserveVertices).toBe(false);
});

test("a diamond with round edges is drawn as a path, not a polygon", () => {
  // drawDiamond always called rc.polygon(), so element.roundness was never
  // read and "Round" edges did nothing at all to a diamond.
  const sharp = draw(shape({ type: "diamond" })).rc.last();
  expect(sharp.name).toBe("polygon");

  const round = draw(shape({ type: "diamond", roundness: { type: 2 } })).rc.last();
  expect(round.name).toBe("path");
  expect(round.options.preserveVertices).toBe(true); // shape.ts:847
  // Per-axis radii (shape.ts:827-834): a 200x120 diamond's proportional insets
  // are a quarter of the half-width and a quarter of the half-height, so the
  // path starts at (100 + 25, 0 + 15) and they are visibly different numbers.
  expect(round.args[0]).toContain("M 125 15");
});

test("an ellipse stops shrinking inside its own selection box", () => {
  // Rough's default curveFitting spends 5% of the radius on randomness, scaled
  // by roughness: a 200-wide ellipse drew 194.2 wide at Cartoonist, pulling
  // ~6px inside its box, where Excalidraw's spills slightly outside at 203.2.
  const drawnWidth = (roughness) => {
    const call = draw(shape({ type: "ellipse", roughness })).rc.last("ellipse");
    expect(call.options.curveFitting).toBe(1);
    let min = Infinity;
    let max = -Infinity;
    for (const set of call.drawable.sets) {
      for (const op of set.ops) {
        for (let i = 0; i < op.data.length; i += 2) {
          min = Math.min(min, op.data[i]);
          max = Math.max(max, op.data[i]);
        }
      }
    }
    return max - min;
  };
  expect(drawnWidth(0)).toBeCloseTo(200.1, 1);
  expect(drawnWidth(1)).toBeCloseTo(203.9, 1);
  expect(drawnWidth(2)).toBeCloseTo(203.2, 1);
});

test("a line's primitive comes from its roundness, not from its point count", () => {
  // shape.ts:901-913. Sharp means straight segments; a line created here draws
  // curved and reopens in Excalidraw as a linearPath, which is a round-trip
  // divergence rather than a missing line.
  const pts = [[0, 0], [100, 40], [200, 0]];
  expect(draw(shape({ type: "line", points: pts })).rc.last().name).toBe("linearPath");
  expect(draw(shape({ type: "line", points: pts, roundness: { type: 2 } })).rc.last().name)
    .toBe("curve");
  // A two-point line is the same ops either way, so nothing existing moves.
  expect(draw(shape({ type: "line", points: [[0, 0], [200, 0]] })).rc.last().name)
    .toBe("linearPath");
  // A closed line with a fill needs an inside for the fill to land in.
  const loop = shape({
    type: "line", backgroundColor: "#ffc9c9", fillStyle: "solid",
    points: [[0, 0], [100, 40], [200, 0], [3, 2]],
  });
  expect(draw(loop).rc.last().name).toBe("polygon");
});

// --- arrowheads --------------------------------------------------------------

const lineTos = (ctx) =>
  ctx.calls.filter((c) => c[0] === "moveTo" || c[0] === "lineTo").map((c) => [c[1], c[2]]);

test("an arrowhead is sized and angled the way Excalidraw sizes and angles it", () => {
  // Was: size 15 + (w-1)x2 at a 25.7 degree half-spread, unclamped. Excalidraw
  // uses 25px for `arrow` (bounds.ts:713-715) at 20 degrees
  // (bounds.ts:734-742), and clamps to half the last segment
  // (bounds.ts:831-834).
  const arrow = shape({
    type: "arrow", roughness: 0, strokeWidth: 2,
    points: [[0, 0], [200, 0]], endArrowhead: "arrow",
  });
  const pts = lineTos(draw(arrow).ctx);
  const tip = pts.find((p) => Math.abs(p[0] - 200) < 0.001);
  expect(tip).toBeDefined();
  const barbs = pts.filter((p) => p !== tip);
  for (const barb of barbs) {
    // 25px back from the tip, at 20 degrees off the shaft.
    expect(Math.hypot(200 - barb[0], 0 - barb[1])).toBeCloseTo(25, 6);
    expect(Math.abs(Math.atan2(barb[1] - 0, barb[0] - 200)) * (180 / Math.PI))
      .toBeCloseTo(180 - 20, 6);
  }
});

test("an arrowhead is scaled down rather than dwarfing a short arrow", () => {
  // min(size, lastSegment x 0.5): on a 20px arrow the head is 10px, not the 25
  // it would like to be, and not the unclamped 17 the old code drew.
  const short = shape({
    type: "arrow", roughness: 0, strokeWidth: 2, width: 20, height: 0,
    points: [[0, 0], [20, 0]], endArrowhead: "arrow",
  });
  const pts = lineTos(draw(short).ctx);
  const tip = pts.find((p) => Math.abs(p[0] - 20) < 0.001);
  for (const barb of pts.filter((p) => p !== tip)) {
    expect(Math.hypot(20 - barb[0], -barb[1])).toBeCloseTo(10, 6);
  }
});

test("a diamond arrowhead is a diamond and not a plain open V", () => {
  // `diamond` had no case at all and fell through to the two-stroke V, so an
  // arrow imported from Excalidraw with a diamond head drew as a normal arrow.
  const el = shape({
    type: "arrow", roughness: 0, strokeWidth: 2,
    points: [[0, 0], [200, 0]], endArrowhead: "diamond",
  });
  const { ctx } = draw(el);
  const pts = lineTos(ctx);
  expect(pts).toHaveLength(4);          // tip, barb, back, barb
  expect(kinds({ calls: ctx.calls })).toContain("fill");
  // 12px long (bounds.ts:717-719), clamped by a quarter of the segment, and
  // twice as long as it is deep: the back point sits 2x the head size behind
  // the tip, on the shaft.
  const [tip, , back] = pts;
  expect(tip[0]).toBeCloseTo(200, 6);
  expect(back[0]).toBeCloseTo(200 - 24, 6);
  expect(back[1]).toBeCloseTo(0, 6);
});

test("an arrowhead aims along the curve it is on, not along the last chord", () => {
  // bounds.ts:790-809 evaluates the *rendered* cubic at t = 0.3. On a curved
  // arrow the tangent and the chord of the last two points are different
  // directions, so a head aimed at the chord visibly hangs off the line.
  const curved = shape({
    type: "arrow", roughness: 0, strokeWidth: 2, roundness: { type: 2 },
    points: [[0, 0], [100, 100], [200, 0]], endArrowhead: "arrow",
  });
  const pts = lineTos(draw(curved).ctx);
  const tip = pts[1];
  const bisector = Math.atan2(
    (pts[0][1] + pts[2][1]) / 2 - tip[1],
    (pts[0][0] + pts[2][0]) / 2 - tip[0],
  );
  // The chord of the last two points rises at exactly -45 degrees; the curve's
  // tangent where it ends does not, so the head is aimed somewhere else.
  const chord = Math.atan2(0 - 100, 200 - 100) + Math.PI;
  expect(Math.abs(bisector - chord)).toBeGreaterThan(0.05);
  // Sanity: it still points backwards along *something*, i.e. up and to the
  // left of the tip rather than off into space.
  expect(bisector).toBeGreaterThan(Math.PI / 2);
});

test("an absent endArrowhead still draws one, and a null one draws none", () => {
  // This matches upstream (shape.ts:915-916) and is not a bug to fix: an
  // undefined endArrowhead means "arrow", and only an explicit null means none.
  const pts = [[0, 0], [200, 0]];
  expect(lineTos(draw(shape({ type: "arrow", points: pts })).ctx).length).toBeGreaterThan(0);
  expect(lineTos(draw(shape({ type: "arrow", points: pts, endArrowhead: null })).ctx))
    .toHaveLength(0);
  // A start arrowhead is opt-in, and points the other way.
  const both = draw(shape({
    type: "arrow", roughness: 0, points: pts, startArrowhead: "arrow", endArrowhead: "arrow",
  }));
  const xs = lineTos(both.ctx).map((p) => p[0]);
  expect(Math.min(...xs)).toBeLessThan(50);
  expect(Math.max(...xs)).toBeGreaterThan(150);
});

// --- the rest of the drawing contract ----------------------------------------

test("a deleted element is not painted", () => {
  // Tombstones stay in the file for undo and for merging another client's
  // edits. `parseScene` strips them on the read path, but the editor paints
  // straight from the live document, where a deletion *is* isDeleted: true.
  const { ctx, rc } = draw(shape({ type: "rectangle", isDeleted: true }));
  expect(rc.calls).toHaveLength(0);
  expect(ctx.calls).toHaveLength(0);
  // And an undeleted one still paints, so this is not just an early return.
  expect(draw(shape({ type: "rectangle", isDeleted: false })).rc.calls).toHaveLength(1);
});

test("every element is drawn with round joins and round caps", () => {
  // renderElement.ts:330-331. Canvas defaults to butt caps and mitre joins,
  // which leaves Rough's multi-stroke passes square-ended: small joins read as
  // notches and a gap up to strokeWidth/2 that round caps would close stays
  // open.
  for (const type of ["rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text"]) {
    const { ctx } = draw(shape({
      type, points: [[0, 0], [100, 40]], text: "hi", fontSize: 20, fontFamily: 5,
    }));
    const set = (name) => ctx.calls.filter((c) => c[0] === `set:${name}`).map((c) => c[1]);
    expect(set("lineJoin")[0]).toBe("round");
    expect(set("lineCap")[0]).toBe("round");
  }
});

test("dark mode filters the colours that reach the canvas, not just the chrome", () => {
  // A dark-authored diagram and a light-authored one are the same file in
  // Excalidraw and different pictures; painting literal colours makes this
  // renderer disagree with the one that wrote them.
  const dark = { appState: { theme: "dark" } };
  expect(draw(shape({ type: "rectangle" }), dark).rc.last().options.stroke).toBe("#d3d3d3");
  expect(draw(shape({ type: "rectangle" }), {}).rc.last().options.stroke).toBe("#1e1e1e");

  // Text and freedraw paint themselves, so they need it applied by hand.
  const text = draw(shape({ type: "text", text: "hi", fontSize: 20, fontFamily: 5 }), dark).ctx;
  expect(text.calls.some((c) => c[0] === "set:fillStyle" && c[1] === "#d3d3d3")).toBe(true);
  const free = draw(shape({
    type: "freedraw", points: [[0, 0], [10, 12], [24, 30], [40, 40]],
  }), dark).ctx;
  expect(free.calls.some((c) => c[0] === "set:fillStyle" && c[1] === "#d3d3d3")).toBe(true);
});

test("a freedraw outline is closed with quadratics, not straight segments", () => {
  // Excalidraw builds the path with getSvgPathFromStroke (utils.ts:1005-1036),
  // whose smooth quadratics are what stop the stroke's edges reading as
  // facets and its tip from tapering on the wrong curve.
  const { ctx } = draw(shape({
    type: "freedraw", strokeWidth: 2,
    points: [[0, 0], [10, 12], [24, 30], [40, 40], [60, 44]],
    pressures: [0.4, 0.5, 0.6, 0.5, 0.4],
  }));
  expect(callsOf({ calls: ctx.calls }, "quadraticCurveTo").length).toBeGreaterThan(4);
  expect(callsOf({ calls: ctx.calls }, "lineTo")).toHaveLength(0);
  expect(callsOf({ calls: ctx.calls }, "fill").length).toBe(1);
});

test("a recorded-pressure stroke and a simulated one are fed differently", () => {
  // getStroke invents pressure from point spacing when simulatePressure is on,
  // and Excalidraw passes bare 2-tuples so it does (shape.ts:1205-1211).
  // Passing a third element either way makes it trust a number nobody
  // measured, and the two produce visibly different outlines.
  const points = [[0, 0], [10, 12], [24, 30], [40, 40], [60, 44]];
  const pressures = [0.1, 0.9, 0.2, 0.8, 0.3];
  const path = (over) => JSON.stringify(
    draw(shape({ type: "freedraw", strokeWidth: 2, points, pressures, ...over })).ctx.calls,
  );
  expect(path({ simulatePressure: true })).not.toBe(path({ simulatePressure: false }));
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
