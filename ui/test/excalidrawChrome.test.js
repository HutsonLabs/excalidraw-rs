// The editor chrome the painter grew: selection outlines, handles, marquee,
// snap guides.
//
// Driven against a recording context, the same way term.hut tests drawElement
// — this file can't otherwise be exercised without a real canvas, and the
// failure mode is not a crash but a handle drawn in the wrong place, which
// nothing but an eye would catch.
//
// The property worth pinning is the one the whole section is organised around:
// chrome is measured in *screen* pixels while it is drawn in scene space, so
// every size has to come out of the transform unchanged when the zoom moves.
// A handle that halves when you zoom out is a handle you cannot grab.

import { test, expect } from "bun:test";
import {
  HANDLE_SIZE, ROTATE_OFFSET, HANDLES, chromeTheme, handlePositions,
  drawSelectionOutline, drawHandles, drawMarquee, drawSnapGuides,
} from "../src/excalidrawView.js";

/// A canvas context that records what it was told to do.
function recorder() {
  const calls = [];
  // `calls` lives on the target, not assigned through the proxy afterwards —
  // going through the setter would record the recorder's own wiring as the
  // first call every context ever made.
  const target = { lineWidth: 0, strokeStyle: "", fillStyle: "", calls };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => calls.push([prop, ...args]);
    },
    set(t, prop, value) {
      t[prop] = value;
      calls.push([`set:${String(prop)}`, value]);
      return true;
    },
  });
}

const box = { minX: 100, minY: 50, maxX: 300, maxY: 150 };
const of = (ctx, name) => ctx.calls.filter((c) => c[0] === name);

// --- the constant-on-screen property ----------------------------------------

test("a handle is the same size on screen at every zoom", () => {
  // Drawn in scene space, so the scene-space side has to be the screen size
  // divided by the scale — at 4x zoom a handle is a quarter of a scene unit
  // across, and still 8 device-independent pixels to the hand holding the
  // mouse.
  for (const scale of [0.25, 1, 4]) {
    const ctx = recorder();
    drawHandles(ctx, box, { scale });
    const [, , , w, h] = of(ctx, "rect")[0];
    expect(w).toBeCloseTo(HANDLE_SIZE / scale, 10);
    expect(h).toBeCloseTo(HANDLE_SIZE / scale, 10);
  }
});

test("outline and guide strokes are hairlines on screen, not in the scene", () => {
  const ctx = recorder();
  drawSelectionOutline(ctx, box, { scale: 8 });
  expect(ctx.lineWidth).toBeCloseTo(1 / 8, 10);
});

// --- handle geometry ---------------------------------------------------------

test("there are eight resize handles and one rotate handle", () => {
  const names = handlePositions(box, { scale: 1 }).map((h) => h.name);
  expect(names).toEqual([...HANDLES, "rotate"]);
  expect(HANDLES).toHaveLength(8);
});

test("the handles sit on the box's corners, edge midpoints, and its padding", () => {
  // padding 0 so the arithmetic is the box's own, with nothing to subtract.
  const at = Object.fromEntries(
    handlePositions(box, { scale: 1, padding: 0 }).map((h) => [h.name, [h.x, h.y]]),
  );
  expect(at.nw).toEqual([100, 50]);
  expect(at.se).toEqual([300, 150]);
  expect(at.n).toEqual([200, 50]);
  expect(at.s).toEqual([200, 150]);
  expect(at.w).toEqual([100, 100]);
  expect(at.e).toEqual([300, 100]);
});

test("the rotate handle floats clear of the north handle, in screen pixels", () => {
  for (const scale of [0.5, 2]) {
    const at = handlePositions(box, { scale, padding: 0 });
    const n = at.find((h) => h.name === "n");
    const r = at.find((h) => h.name === "rotate");
    expect(r.x).toBe(n.x);
    // Above, and by a constant on-screen distance — otherwise the two merge
    // into one ambiguous target at low zoom.
    expect(n.y - r.y).toBeCloseTo(ROTATE_OFFSET / scale, 10);
    expect((n.y - r.y) * scale).toBeCloseTo(ROTATE_OFFSET, 10);
  }
});

test("an empty selection has no handles rather than a box at the origin", () => {
  expect(handlePositions(null, { scale: 1 })).toEqual([]);
  const ctx = recorder();
  drawHandles(ctx, null, { scale: 1 });
  expect(ctx.calls).toHaveLength(0);
});

test("the rotate handle is a circle and the resize handles are squares", () => {
  // Told apart by shape, not only by position — they are a few pixels apart at
  // the top edge.
  const ctx = recorder();
  drawHandles(ctx, box, { scale: 1 });
  expect(of(ctx, "rect")).toHaveLength(8);
  expect(of(ctx, "arc")).toHaveLength(1);
});

test("`only` narrows the set — a line has no meaningful corners", () => {
  const ctx = recorder();
  drawHandles(ctx, box, { scale: 1, only: ["w", "e"] });
  expect(of(ctx, "rect")).toHaveLength(2);
  expect(of(ctx, "arc")).toHaveLength(0);
});

// --- rotation ----------------------------------------------------------------

test("a rotated selection's chrome turns with it, about the box's centre", () => {
  const ctx = recorder();
  drawSelectionOutline(ctx, box, { scale: 1, angle: Math.PI / 4 });
  expect(of(ctx, "rotate")[0][1]).toBeCloseTo(Math.PI / 4, 10);
  // Translated to the centre, turned, and translated back.
  expect(of(ctx, "translate")[0].slice(1)).toEqual([200, 100]);
  expect(of(ctx, "translate")[1].slice(1)).toEqual([-200, -100]);
});

test("an unrotated selection pays nothing for the rotation path", () => {
  const ctx = recorder();
  drawSelectionOutline(ctx, box, { scale: 1, angle: 0 });
  expect(of(ctx, "rotate")).toHaveLength(0);
  expect(of(ctx, "translate")).toHaveLength(0);
});

// --- multi-select ------------------------------------------------------------

test("a set of bounds outlines every member, so it's clear which are selected", () => {
  // The union box alone would leave the user guessing whether the shape under
  // it is in the set.
  const ctx = recorder();
  drawSelectionOutline(ctx, [box, { minX: 0, minY: 0, maxX: 10, maxY: 10 }], { scale: 1 });
  expect(of(ctx, "strokeRect")).toHaveLength(2);
});

test("nulls in the set are skipped rather than drawing at the origin", () => {
  const ctx = recorder();
  drawSelectionOutline(ctx, [box, null], { scale: 1 });
  expect(of(ctx, "strokeRect")).toHaveLength(1);
});

test("the outline sits outside the shape, by a constant on-screen padding", () => {
  const ctx = recorder();
  drawSelectionOutline(ctx, box, { scale: 2, padding: 4 });
  const [, x, y, w, h] = of(ctx, "strokeRect")[0];
  expect(x).toBeCloseTo(100 - 2, 10); // 4 screen px at 2x = 2 scene units
  expect(y).toBeCloseTo(50 - 2, 10);
  expect(w).toBeCloseTo(200 + 4, 10);
  expect(h).toBeCloseTo(100 + 4, 10);
});

// --- marquee -----------------------------------------------------------------

test("a marquee dragged up and to the left still has positive extents", () => {
  const ctx = recorder();
  drawMarquee(ctx, { minX: 300, minY: 200, maxX: 100, maxY: 50 }, { scale: 1 });
  expect(of(ctx, "fillRect")[0].slice(1)).toEqual([100, 50, 200, 150]);
  expect(of(ctx, "strokeRect")[0].slice(1)).toEqual([100, 50, 200, 150]);
});

test("the marquee is filled as well as stroked", () => {
  // An outline alone over a busy diagram is hard to see; the wash is what
  // makes "everything in here" read at a glance.
  const ctx = recorder();
  drawMarquee(ctx, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, { scale: 1 });
  expect(of(ctx, "fillRect")).toHaveLength(1);
  expect(of(ctx, "strokeRect")).toHaveLength(1);
});

// --- snap guides -------------------------------------------------------------

test("each guide is a line with a tick at both ends", () => {
  const ctx = recorder();
  drawSnapGuides(ctx, [{ x1: 0, y1: 100, x2: 500, y2: 100 }], { scale: 1 });
  // One stroke for the guide, one for each tick.
  expect(of(ctx, "stroke")).toHaveLength(3);
});

test("ticks are perpendicular, so a horizontal guide gets vertical ticks", () => {
  const ctx = recorder();
  drawSnapGuides(ctx, [{ x1: 0, y1: 100, x2: 500, y2: 100 }], { scale: 1 });
  // The first tick's two points share an x and differ in y.
  const [, mx, my] = of(ctx, "moveTo")[1];
  const [, lx, ly] = of(ctx, "lineTo")[1];
  expect(mx).toBeCloseTo(lx, 10);
  expect(Math.abs(ly - my)).toBeCloseTo(8, 10); // 4 screen px either side
});

test("the guide is dashed and the ticks are not", () => {
  // A dashed 8-pixel cross reads as nothing at all.
  const ctx = recorder();
  drawSnapGuides(ctx, [{ x1: 0, y1: 0, x2: 100, y2: 0 }], { scale: 1 });
  const dashes = of(ctx, "setLineDash").map((c) => c[1]);
  expect(dashes[0].length).toBe(2);
  expect(dashes[1]).toEqual([]);
});

test("a zero-length guide doesn't divide by zero working out its ticks", () => {
  const ctx = recorder();
  drawSnapGuides(ctx, [{ x1: 5, y1: 5, x2: 5, y2: 5 }], { scale: 1 });
  for (const call of [...of(ctx, "moveTo"), ...of(ctx, "lineTo")]) {
    expect(call.slice(1).every(Number.isFinite)).toBe(true);
  }
});

test("no guides is no drawing at all, not an empty save/restore", () => {
  const ctx = recorder();
  drawSnapGuides(ctx, [], { scale: 1 });
  expect(ctx.calls).toHaveLength(0);
});

// --- theming -----------------------------------------------------------------

test("chrome falls back to Excalidraw's own violet when there are no tokens", () => {
  // A host that defines none of these still gets chrome that looks
  // deliberate rather than black on black.
  const t = chromeTheme(null);
  expect(t.accent).toBe("#6965db");
  expect(t.guide).toBeTruthy();
  expect(t.handleFill).toBeTruthy();
  expect(t.marquee).toBeTruthy();
});

test("a passed theme is what actually gets painted", () => {
  const colors = { accent: "#ff0000", handleFill: "#00ff00", guide: "#0000ff", marquee: "#abc" };
  const ctx = recorder();
  drawSelectionOutline(ctx, box, { scale: 1, colors });
  expect(ctx.strokeStyle).toBe("#ff0000");
  const ctx2 = recorder();
  drawSnapGuides(ctx2, [{ x1: 0, y1: 0, x2: 1, y2: 0 }], { scale: 1, colors });
  expect(ctx2.strokeStyle).toBe("#0000ff");
});
