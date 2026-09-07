// The same geometry, twice — and a test that they agree.
//
// PLAN.md Phase 2 names this exactly: "Two painters, one truth. Between Phase
// 2 and its deletions, the same geometry exists in Rust and JS. Keep that
// window short." The window is still open, because excalidrawView.js draws
// with the JS copies and deleting them would make the painter depend on WASM
// to draw a shape it can already draw.
//
// So until the deletion, this is the thing that makes the duplication safe:
// every function that exists in both is driven with the same inputs on both
// sides and asserted equal. A divergence here is a shape drawn in one place
// and hit-tested in another, which is the single most confusing bug this
// architecture can produce.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { wrap } from "../src/xdWasm.js";
import { elementBounds, sceneBounds, fitTransform, cornerRadius } from "../src/excalidrawScene.js";

const mod = await import("../vendor/xd-wasm/xd_wasm.js");
await mod.default({
  module_or_path: readFileSync(new URL("../vendor/xd-wasm/xd_wasm_bg.wasm", import.meta.url)),
});

/// Elements chosen to hit the edges the two implementations could disagree on:
/// negative extents, a linear element whose bounds come from its points, a
/// zero-height line, and both roundness schemes.
const ELEMENTS = [
  { type: "rectangle", x: 10, y: 20, width: 100, height: 60, roundness: { type: 3 } },
  { type: "rectangle", x: 300, y: 40, width: -80, height: -50, roundness: { type: 2 } },
  { type: "ellipse", x: -40, y: -90, width: 30, height: 200, roundness: null },
  { type: "diamond", x: 0, y: 0, width: 12, height: 12, roundness: { type: 3, value: 32 } },
  {
    type: "arrow", x: 500, y: 500, width: 120, height: 0,
    points: [[0, 0], [40, -30], [120, 0]], roundness: { type: 2 },
  },
  { type: "line", x: 5, y: 5, width: 0, height: 90, points: [[0, 0], [0, 90]] },
  { type: "text", x: 60, y: 400, width: 220, height: 25, text: "parity", fontSize: 20 },
];

/// A scene the WASM side will accept, with the bookkeeping fields the format
/// requires filled in.
const scene = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: ELEMENTS.map((e, i) => ({
    id: `el-${i}`, angle: 0, seed: 1000 + i, version: 1, versionNonce: 7 + i,
    isDeleted: false, groupIds: [], strokeColor: "#1e1e1e",
    backgroundColor: "transparent", ...e,
  })),
  appState: {},
});

const doc = wrap(mod.XdDoc.open(scene));
const js = JSON.parse(scene).elements;

/// Floating-point arithmetic in two languages does not have to be bit-equal to
/// be the same rule; a tenth of a scene unit is far below anything drawable.
const near = (a, b, what) => expect(Math.abs(a - b), what).toBeLessThan(1e-6);

test("elementBounds agrees for every shape, including the awkward ones", () => {
  js.forEach((element, i) => {
    const a = elementBounds(element);
    const b = doc.elementBounds(i);
    expect(a === null, `${element.type} #${i} nullness`).toBe(b === null);
    if (!a) return;
    near(a.minX, b.minX, `${element.type} #${i} minX`);
    near(a.minY, b.minY, `${element.type} #${i} minY`);
    near(a.maxX, b.maxX, `${element.type} #${i} maxX`);
    near(a.maxY, b.maxY, `${element.type} #${i} maxY`);
  });
});

test("sceneBounds agrees", () => {
  const a = sceneBounds(js);
  const b = doc.sceneBounds();
  near(a.minX, b.minX, "minX");
  near(a.minY, b.minY, "minY");
  near(a.maxX, b.maxX, "maxX");
  near(a.maxY, b.maxY, "maxY");
});

test("fitTransform agrees across viewports, including the degenerate ones", () => {
  const bounds = sceneBounds(js);
  for (const [w, h] of [[800, 600], [200, 2000], [64, 64], [0, 0], [1000, 40]]) {
    const a = fitTransform(bounds, { width: w, height: h });
    const b = doc.fitTransform(w, h);
    near(a.scale, b.scale, `scale at ${w}x${h}`);
    near(a.offsetX, b.offsetX, `offsetX at ${w}x${h}`);
    near(a.offsetY, b.offsetY, `offsetY at ${w}x${h}`);
  }
});

test("cornerRadius agrees for both roundness schemes and for none", () => {
  js.forEach((element, i) => {
    near(cornerRadius(element), doc.cornerRadius(i), `${element.type} #${i}`);
  });
});
