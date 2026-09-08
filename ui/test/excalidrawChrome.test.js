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
  HANDLE_SIZE, ROTATE_OFFSET, HANDLES, HANDLES_WITH_ROTATE, chromeTheme,
  handlePositions, drawSelectionOutline, drawHandles, drawPointHandles,
  drawMarquee, drawSnapGuides,
} from "../src/excalidrawView.js";
// The recording context is shared with contract.test.js and
// excalidrawPaint.test.js. It used to live here; three copies of one fake had
// already begun to disagree about what a canvas does.
import { recorder, callsOf } from "./support/harness.js";

const box = { minX: 100, minY: 50, maxX: 300, maxY: 150 };
const of = callsOf;

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

// --- letting the model say where the handles are ------------------------------

test("supplied points are drawn instead of recomputed ones", () => {
  // `doc.handlePoints()` is the same nine positions worked out by the code that
  // also hit-tests them. Until something passes them in, this file and
  // geometry.rs agree only because both hard-code the same 20px rotate offset —
  // a coincidence maintained by hand. Deliberately absurd coordinates here, so
  // a fallback to handlePositions could not possibly pass.
  const points = HANDLES_WITH_ROTATE.map((_, i) => ({ x: 1000 + i, y: 2000 + i }));
  const ctx = recorder();
  drawHandles(ctx, box, { scale: 1, points });

  const squares = of(ctx, "rect");
  expect(squares).toHaveLength(8);
  // Centres, recovered from the top-left corner the rect was drawn at.
  expect(squares.map((c) => [c[1] + HANDLE_SIZE / 2, c[2] + HANDLE_SIZE / 2]))
    .toEqual(points.slice(0, 8).map((p) => [p.x, p.y]));
  // And the ninth is still the circle, at the ninth position.
  const [arc] = of(ctx, "arc");
  expect([arc[1], arc[2]]).toEqual([points[8].x, points[8].y]);
});

test("supplied points get their names from the order the model returns them in", () => {
  // handlePoints() is `[{x, y}]` with no names, and `only` plus the rotate
  // stalk both key off the name — so the zip has to happen inside drawHandles,
  // or every caller has to know that geometry::Handle discriminates nw, n, ne,
  // e, se, s, sw, w, rotate in that order.
  const points = HANDLES_WITH_ROTATE.map((_, i) => ({ x: 1000 + i, y: 2000 + i }));
  const ctx = recorder();
  drawHandles(ctx, box, { scale: 1, points, only: ["nw", "rotate"] });
  const squares = of(ctx, "rect");
  expect(squares).toHaveLength(1);
  expect([squares[0][1] + HANDLE_SIZE / 2, squares[0][2] + HANDLE_SIZE / 2])
    .toEqual([points[0].x, points[0].y]);
  expect(of(ctx, "arc")).toHaveLength(1);

  // The stalk runs from "n" to "rotate", which means it uses the supplied
  // positions too rather than falling back to the box.
  const full = recorder();
  drawHandles(full, box, { scale: 1, points });
  const [move] = of(full, "moveTo");
  const [line] = of(full, "lineTo");
  expect([move[1], move[2]]).toEqual([points[1].x, points[1].y]);
  expect([line[1], line[2]]).toEqual([points[8].x, points[8].y]);
});

// --- a linear element's own points --------------------------------------------
//
// The sibling of drawHandles, and the reason it is a sibling: these have no
// names and there are as many of them as the line has points. It is also the
// chrome the headline bug turned on — binding always worked, but an endpoint
// that cannot be picked up cannot be re-aimed.

const linePoints = [{ x: 1000, y: 2000 }, { x: 1100, y: 2050 }, { x: 1200, y: 1900 }];

test("a line's points are drawn where they are, not where a box would be", () => {
  // Same technique as the drawHandles tests above: coordinates nowhere near
  // any bounding box, so a fallback to box-derived positions cannot pass.
  const ctx = recorder();
  drawPointHandles(ctx, linePoints, { scale: 1 });
  const arcs = of(ctx, "arc");
  expect(arcs.map((c) => [c[1], c[2]])).toEqual(linePoints.map((p) => [p.x, p.y]));
  // One circle per point, and no squares — these are not resize handles.
  expect(of(ctx, "rect")).toHaveLength(0);
});

test("a point handle is the same size on screen at every zoom", () => {
  // The rule the whole section is organised around, and the one that decides
  // whether an endpoint is grabbable when you have zoomed out to see the
  // diagram.
  for (const scale of [0.25, 1, 4]) {
    const ctx = recorder();
    drawPointHandles(ctx, linePoints, { scale });
    expect(of(ctx, "arc")[0][3]).toBeCloseTo(HANDLE_SIZE / 2 / scale, 10);
    expect(ctx.lineWidth).toBeCloseTo(1 / scale, 10);
  }
});

test("a midpoint is hollow and smaller, because clicking it makes a point", () => {
  // The two kinds have to be told apart at a glance: one moves a point that
  // exists, the other adds one that does not.
  const solid = recorder();
  drawPointHandles(solid, linePoints, { scale: 1 });
  expect(of(solid, "fill")).toHaveLength(linePoints.length);

  const hollow = recorder();
  drawPointHandles(hollow, linePoints, { scale: 1, filled: false, size: HANDLE_SIZE * 0.75 });
  expect(of(hollow, "fill")).toHaveLength(0);
  expect(of(hollow, "stroke")).toHaveLength(linePoints.length);
  expect(of(hollow, "arc")[0][3]).toBeCloseTo(HANDLE_SIZE * 0.75 / 2, 10);
});

test("no points means no calls at all, not a circle at the origin", () => {
  for (const points of [null, undefined, []]) {
    const ctx = recorder();
    drawPointHandles(ctx, points, { scale: 1 });
    expect(ctx.calls).toHaveLength(0);
  }
});

test("point handles take the passed theme, like the rest of the chrome", () => {
  const ctx = recorder();
  drawPointHandles(ctx, linePoints, {
    scale: 1, colors: { accent: "#ff0000", handleFill: "#00ff00" },
  });
  expect(ctx.strokeStyle).toBe("#ff0000");
  expect(ctx.fillStyle).toBe("#00ff00");
});

test("a multi-selection can hide the rotate handle by name", () => {
  // Excalidraw hides it, and this repo's ops::rotate treats the absolute
  // pointer bearing as a delta — so a reachable rotate handle on a
  // multi-selection is a bug you can hit. `only: HANDLES` is the mitigation.
  const ctx = recorder();
  drawHandles(ctx, box, { scale: 1, only: HANDLES });
  expect(of(ctx, "rect")).toHaveLength(8);
  expect(of(ctx, "arc")).toHaveLength(0);
  // And no stalk to a handle that is not there.
  expect(of(ctx, "moveTo")).toHaveLength(0);
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
