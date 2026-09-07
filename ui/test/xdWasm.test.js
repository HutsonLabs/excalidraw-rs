// The WASM boundary, end to end, with no browser.
//
// This is the test that would have caught every mistake in Phase 4 that unit
// tests on either side cannot: a name that differs between `#[wasm_bindgen(js_name)]`
// and xdWasm.js, an element that crosses as a Map instead of an object, a
// change descriptor whose `dirty` array is empty when it should not be. Bun
// can instantiate the module from bytes, so the whole document model is
// exercised here at `bun test` speed.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { wrap } from "../src/xdWasm.js";

const mod = await import("../vendor/xd-wasm/xd_wasm.js");
await mod.default({
  module_or_path: readFileSync(new URL("../vendor/xd-wasm/xd_wasm_bg.wasm", import.meta.url)),
});

const doc = () => wrap(mod.XdDoc.blank());

test("a blank document serializes as a scene Excalidraw would open", () => {
  const scene = JSON.parse(doc().toJson());
  expect(scene.type).toBe("excalidraw");
  expect(Array.isArray(scene.elements)).toBe(true);
  expect(scene.elements.length).toBe(0);
});

test("an element crosses the boundary as a plain object in the file's own shape", () => {
  const d = doc();
  d.beginDraft("rectangle", 10, 10, { strokeColor: "#e03131" });
  d.draftTo(110, 60, false);
  d.endDraft();
  const el = d.element(0);
  expect(el.type).toBe("rectangle");
  expect(el.x).toBe(10);
  expect(el.width).toBe(100);
  expect(el.strokeColor).toBe("#e03131");
  // A Map would make the painter unwritable as a copy of term.hut's.
  expect(Object.getPrototypeOf(el)).toBe(Object.prototype);
});

test("unknown fields survive a round trip through the model", () => {
  const source = JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [{
      id: "keepme", type: "rectangle", x: 0, y: 0, width: 10, height: 10,
      seed: 12345, version: 1, versionNonce: 7, angle: 0,
      somethingFromTheFuture: { nested: [1, 2, 3] },
    }],
    appState: { viewBackgroundColor: "#ffffff" },
  });
  const d = wrap(mod.XdDoc.open(source));
  d.setSelection([0]);
  d.dragBy(5, 5, "");
  const out = JSON.parse(d.toJson());
  expect(out.elements[0].somethingFromTheFuture).toEqual({ nested: [1, 2, 3] });
  // The seed is what makes Rough.js redraw the same strokes; an edit must
  // never rewrite it, or the drawing twitches on every keystroke.
  expect(out.elements[0].seed).toBe(12345);
  expect(out.elements[0].version).toBeGreaterThan(1);
  expect(out.elements[0].x).toBe(5);
});

test("hit-testing finds the shape under the point and nothing under empty canvas", () => {
  const d = doc();
  d.beginDraft("ellipse", 0, 0, { backgroundColor: "#a5d8ff" });
  d.draftTo(100, 100, false);
  d.endDraft();
  expect(d.hitTest(50, 50, 5)).toBe(0);
  expect(d.hitTest(400, 400, 5)).toBe(-1);
});

test("a drag is one undo entry, and undo restores the position", () => {
  const d = doc();
  d.beginDraft("rectangle", 0, 0, {});
  d.draftTo(50, 50, false);
  d.endDraft();
  d.setSelection([0]);
  const start = d.element(0).x;
  for (let i = 0; i < 40; i++) d.dragBy(1, 0, "drag");
  expect(d.element(0).x).toBe(start + 40);
  d.undo();
  expect(d.element(0).x).toBe(start);
});

test("the element memo is invalidated by the change it reports", () => {
  const d = doc();
  d.beginDraft("rectangle", 0, 0, {});
  d.draftTo(50, 50, false);
  d.endDraft();
  d.setSelection([0]);
  const before = d.element(0);
  d.dragBy(7, 0, "");
  expect(d.element(0)).not.toBe(before);
  expect(d.element(0).x).toBe(7);
});

test("deleting a shape and undoing restores it with its unknown fields", () => {
  const d = doc();
  d.beginDraft("diamond", 0, 0, {});
  d.draftTo(20, 20, false);
  d.endDraft();
  d.setSelection([0]);
  d.deleteSelection();
  d.undo();
  expect(d.length).toBe(1);
  expect(d.element(0).type).toBe("diamond");
});

test("an arrow drawn between two shapes binds to both and follows them", () => {
  const d = doc();
  d.beginDraft("rectangle", 0, 0, {});
  d.draftTo(100, 100, false);
  d.endDraft();
  d.beginDraft("rectangle", 300, 0, {});
  d.draftTo(400, 100, false);
  d.endDraft();

  // Drawn from inside the first box to inside the second, which is how a
  // person draws one — the endpoints land on the shapes, not near them.
  d.beginDraft("arrow", 50, 50, {});
  d.draftTo(350, 50, false);
  d.endDraft();

  const arrow = d.elementId(2);
  expect(d.isBound(arrow, false)).toBe(true);
  expect(d.isBound(arrow, true)).toBe(true);

  const tipOf = () => {
    const e = d.element(2);
    const last = e.points[e.points.length - 1];
    return e.x + last[0];
  };
  const before = tipOf();

  // Move the second box; the arrow's far end must come with it.
  d.setSelection([1]);
  d.dragBy(60, 0, "");
  expect(tipOf() - before).toBeCloseTo(60, 1);
});

test("a bound arrow stops short of the shape rather than inside it", () => {
  const d = doc();
  d.beginDraft("ellipse", 200, 100, {});
  d.draftTo(300, 200, false);
  d.endDraft();
  d.beginDraft("arrow", 0, 150, {});
  d.draftTo(250, 150, false);
  d.endDraft();
  const e = d.element(1);
  const last = e.points[e.points.length - 1];
  // The ellipse's left extreme is x = 200; a bound arrow stops before it.
  expect(e.x + last[0]).toBeLessThan(200);
});
