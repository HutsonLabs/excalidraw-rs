// The WASM boundary, end to end, with no browser.
//
// This is the test that would have caught every mistake in Phase 4 that unit
// tests on either side cannot: a name that differs between `#[wasm_bindgen(js_name)]`
// and xdWasm.js, an element that crosses as a Map instead of an object, a
// change descriptor whose `dirty` array is empty when it should not be. Bun
// can instantiate the module from bytes, so the whole document model is
// exercised here at `bun test` speed.
import { test, expect } from "bun:test";
import { blankDoc, openDoc, mod } from "./wasmHarness.js";

const doc = blankDoc;

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
  const d = openDoc(source);
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

test("a freehand stroke's pressures line up with its points", () => {
  const d = blankDoc();
  d.beginDraft("freedraw", 0, 0, {});
  for (let i = 1; i <= 5; i++) d.draftPoint(i * 3, i * 2, 0.25 + i * 0.1);
  d.endDraft();
  const el = d.element(0);
  // perfect-freehand indexes the two arrays together. One short and every
  // pressure lands on the wrong point — invisible with simulated pressure,
  // visible with a pen.
  expect(el.pressures.length).toBe(el.points.length);
});

test("a text element survives being created before anything is typed", () => {
  const d = blankDoc();
  d.beginDraft("text", 40, 40, { fontSize: 20 });
  d.endDraft();
  // Text is 0x0 until the overlay has measured what was typed; the empty-draft
  // rule must not reach it.
  expect(d.length).toBe(1);
  expect(d.element(0).type).toBe("text");
  d.patch(d.elementId(0), { text: "hello", width: 60, height: 25 });
  expect(d.element(0).text).toBe("hello");
});

// ---------------------------------------------------------------------------
// Exports added for the audit fixes.
//
// These go through `mod.XdDoc` directly rather than through the `wrap()` facade
// the tests above use. The facade is an explicit whitelist of what the *editor*
// may call (`ui/src/xdWasm.js`), and it gains these names as the editor learns
// to use them; the boundary itself is what is under test here, so a test that
// waited for the whitelist would be testing two things and reporting one.
// ---------------------------------------------------------------------------

const raw = () => mod.XdDoc.blank();

/// Two boxes and an arrow drawn between them, the fixture several tests want.
const drawn = (d, kind, x0, y0, x1, y1) => {
  d.beginDraft(kind, x0, y0, {});
  d.draftTo(x1, y1, false);
  d.endDraft(2);
  return d.elementId(d.length - 1);
};

test("a line drawn across two shapes gains no binding", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  drawn(d, "rectangle", 300, 0, 400, 100);
  const line = drawn(d, "line", 50, 50, 350, 50);
  // Excalidraw's `isBindingElement` admits arrows only, so a bound line is a
  // diagram that re-routes here and sits inert on excalidraw.com.
  expect(d.isBound(line, false)).toBe(false);
  expect(d.isBound(line, true)).toBe(false);
  expect(d.element(0).boundElements ?? null).toBe(null);
});

test("rotating two elements follows the pointer instead of spinning away", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  drawn(d, "rectangle", 200, 0, 300, 100);
  d.setSelection(Uint32Array.from([0, 1]));
  // The union box is 0,0..300,100, so its centre is (150, 50) and the rotate
  // handle starts straight above it. Twenty samples around a quarter turn, all
  // under one coalesce key, the way a pointer delivers a drag.
  for (let step = 1; step <= 20; step++) {
    const t = (Math.PI / 2) * (step / 20);
    d.rotateTo(150 + 200 * Math.sin(t), 50 - 200 * Math.cos(t), 0, "rotate:1");
  }
  expect(d.element(0).angle).toBeCloseTo(Math.PI / 2, 5);
  expect(d.element(1).angle).toBeCloseTo(Math.PI / 2, 5);
  // And the whole gesture is one press of undo.
  d.undo();
  expect(d.element(0).angle).toBe(0);
  expect(d.element(1).angle).toBe(0);
});

test("an arrow's endpoints are grabbable and dragging one off its shape unbinds it", () => {
  const d = raw();
  drawn(d, "rectangle", 300, 0, 400, 100);
  const arrow = drawn(d, "arrow", 50, 50, 350, 50);
  expect(d.isBound(arrow, true)).toBe(true);

  d.setSelection(Uint32Array.from([1]));
  const handles = Array.from(d.pointHandles());
  expect(handles.length).toBe(4);
  expect(handles[0]).toBeCloseTo(50, 5);
  // The tip was pulled back to the shape's outline when it bound, so ask for
  // the index rather than the coordinate.
  expect(d.pointHandleAt(handles[2], handles[3], 8)).toBe(1);
  expect(d.midpointHandleAt((handles[0] + handles[2]) / 2, 50, 8)).toBe(0);

  d.movePoint(1, 120, 400, "point:1");
  expect(d.isBound(arrow, true)).toBe(false);
  const e = d.element(1);
  const tip = e.points[e.points.length - 1];
  // The regression: the reflow used to re-aim a bound tip straight back onto
  // the shape, so the endpoint could not be dragged at all.
  expect(e.x + tip[0]).toBeCloseTo(120, 1);
  expect(e.y + tip[1]).toBeCloseTo(400, 1);
});

test("a box has no point handles", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  d.setSelection(Uint32Array.from([0]));
  expect(d.pointHandles()).toBeUndefined();
  expect(d.pointHandleAt(0, 0, 8)).toBe(-1);
});

test("a label can be bound to a container, found again, and unbound", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 200, 100);
  const rect = d.elementId(0);
  d.insert({ type: "text", x: 60, y: 40, width: 80, height: 20, text: "hi", originalText: "hi",
             fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle" });
  const text = d.elementId(1);

  d.bindLabel(rect, text);
  expect(d.element(1).containerId).toBe(rect);
  expect(d.element(0).boundElements).toEqual([{ id: text, type: "text" }]);
  expect(d.labelOf(0)).toBe(1);
  // A rectangle 200 wide leaves the label 190 to wrap inside.
  expect(d.labelBudget(0)).toBe(190);

  d.unbindLabel(text);
  expect(d.element(1).containerId ?? null).toBe(null);
  expect(d.labelOf(0)).toBe(-1);
});

test("dragging a container carries its label, and deleting it takes the label with it", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 200, 100);
  const rect = d.elementId(0);
  d.insert({ type: "text", x: 60, y: 40, width: 80, height: 20, text: "hi", originalText: "hi",
             fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle" });
  d.bindLabel(rect, d.elementId(1));

  d.setSelection(Uint32Array.from([0]));
  d.dragBy(100, 100, "drag:1");
  expect(d.element(1).x).toBe(160);
  expect(d.element(1).y).toBe(140);

  d.deleteSelection();
  expect(d.length).toBe(0);
  d.undo();
  expect(d.length).toBe(2);
  expect(d.element(1).containerId).toBe(rect);
});

test("an image's bytes can be put in the files map and undone out of it", () => {
  const d = raw();
  const entry = { mimeType: "image/png", id: "abc123", dataURL: "data:image/png;base64,AAAA" };
  d.putFile("abc123", entry);
  expect(d.files()["abc123"].dataURL).toBe("data:image/png;base64,AAAA");
  expect(JSON.parse(d.toJson()).files.abc123.mimeType).toBe("image/png");

  d.undo();
  expect(d.files()["abc123"]).toBeUndefined();
  d.redo();
  expect(d.files()["abc123"]).toBeDefined();
  d.dropFile("abc123");
  expect(d.files()["abc123"]).toBeUndefined();
});

test("insert can name the z-order index it lands on", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  drawn(d, "ellipse", 0, 0, 100, 100);
  d.insert({ type: "diamond", x: 0, y: 0, width: 10, height: 10 }, 0);
  expect([0, 1, 2].map((i) => d.element(i).type)).toEqual(["diamond", "rectangle", "ellipse"]);
  // Omitting it still means "on top", which is where a drawing gesture puts a
  // new shape.
  d.insert({ type: "diamond", x: 0, y: 0, width: 10, height: 10 });
  expect(d.element(3).type).toBe("diamond");
});

test("a sloppiness change re-rolls the seed and a plain style change does not", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  d.setSelection(Uint32Array.from([0]));
  const seed = d.element(0).seed;

  d.setStyle({ roughness: 2 });
  expect(d.element(0).seed).toBe(seed);
  expect(d.element(0).roughness).toBe(2);

  d.setStyleResketched({ roughness: 0 });
  expect(d.element(0).seed).not.toBe(seed);
  expect(d.element(0).roughness).toBe(0);
  // One undo entry: the roughness and the seed go back together.
  d.undo();
  expect(d.element(0).seed).toBe(seed);
  expect(d.element(0).roughness).toBe(2);

  d.reseed();
  expect(d.element(0).seed).not.toBe(seed);
});

test("the selection's extent is the box it occupies, not the box its handles sit on", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  drawn(d, "rectangle", 200, 0, 300, 100);
  d.setSelection(Uint32Array.from([0, 1]));
  expect(Array.from(d.selectionExtent())).toEqual([0, 0, 300, 100]);
});

test("appState can be written, merged and undone without disturbing the rest", () => {
  const d = mod.XdDoc.open(JSON.stringify({
    type: "excalidraw", version: 2, elements: [],
    appState: { viewBackgroundColor: "#ffffff", somethingNested: { keep: [1, 2] } },
  }));
  const change = d.setAppState({ theme: "dark", gridSize: 20 });
  // No element changed and everything may look different, so the whole canvas
  // is dirty — `structural` is the flag that says "repaint the lot".
  expect(change.structural).toBe(true);
  const after = d.appState();
  expect(after.theme).toBe("dark");
  expect(after.gridSize).toBe(20);
  expect(after.viewBackgroundColor).toBe("#ffffff");
  expect(after.somethingNested).toEqual({ keep: [1, 2] });

  d.undo();
  expect(d.appState().theme).toBeUndefined();
  expect(d.appState().viewBackgroundColor).toBe("#ffffff");
  // A null removes a key.
  d.setAppState({ viewBackgroundColor: null });
  expect(d.appState().viewBackgroundColor).toBeUndefined();
});

test("a keyed patch folds a whole sweep into one undo entry", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  drawn(d, "rectangle", 200, 0, 300, 100);
  const before = d.length;
  // What an eraser sweep is: one patch per element it crosses, all under one
  // key, so ⌘Z takes the whole stroke back rather than one shape at a time.
  d.patch(d.elementId(0), { isDeleted: true }, "erase:1");
  d.patch(d.elementId(1), { isDeleted: true }, "erase:1");
  expect(d.element(0).isDeleted).toBe(true);
  expect(d.element(1).isDeleted).toBe(true);

  d.undo();
  expect(d.element(0).isDeleted).toBe(false);
  expect(d.element(1).isDeleted).toBe(false);
  expect(d.length).toBe(before);
  // And the two-argument form still means "an entry of its own".
  d.patch(d.elementId(0), { x: 5 });
  d.patch(d.elementId(0), { x: 9 });
  d.undo();
  expect(d.element(0).x).toBe(5);
});

test("a locked element is transparent to the pointer and to select-all", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 100);
  drawn(d, "rectangle", 0, 0, 100, 100);
  // Both filled, so both are hit anywhere inside — a transparent shape is
  // stroke-only and would miss the point below for an unrelated reason.
  d.patch(d.elementId(0), { backgroundColor: "#ffc9c9" });
  d.patch(d.elementId(1), { locked: true, backgroundColor: "#a5d8ff" });
  // The locked one is on top, and the click still lands on what is behind it.
  expect(d.hitTest(50, 50, 10)).toBe(0);
  expect(Array.from(d.marquee(-10, -10, 200, 200, false))).toEqual([0]);
  d.selectAll();
  expect(Array.from(d.selection)).toEqual([0]);
});

test("align, distribute and flip move the selection as the panel asks", () => {
  const d = raw();
  drawn(d, "rectangle", 0, 0, 100, 50);
  drawn(d, "rectangle", 140, 20, 180, 60);
  drawn(d, "rectangle", 300, 80, 400, 100);
  d.setSelection(Uint32Array.from([0, 1, 2]));

  d.align("left");
  expect([0, 1, 2].map((i) => d.element(i).x)).toEqual([0, 0, 0]);
  d.undo();
  expect(d.element(1).x).toBe(140);

  d.distribute("horizontal");
  const boxes = [0, 1, 2].map((i) => Array.from(d.elementBounds(i)));
  expect(boxes[1][0] - boxes[0][2]).toBeCloseTo(boxes[2][0] - boxes[1][2], 6);

  // An unknown edge or axis is a no-op rather than a wrong move.
  const revision = d.revision;
  d.align("sideways");
  expect(d.revision).toBe(revision);
});

test("flipping an arrow turns it around rather than moving it", () => {
  const d = raw();
  const arrow = drawn(d, "arrow", 10, 10, 110, 10);
  d.setSelection(Uint32Array.from([0]));
  const boxBefore = Array.from(d.elementBounds(0));

  d.flip("horizontal");
  const e = d.element(0);
  expect(e.points[0]).toEqual([0, 0]);
  // The tip was on the right; it is now on the left, and the box has not moved.
  expect(e.x + e.points[1][0]).toBeCloseTo(10, 6);
  expect(Array.from(d.elementBounds(0))).toEqual(boxBefore);
  expect(arrow).toBe(d.elementId(0));
});

test("clicking a midpoint adds a point there, and the endpoints stay put", () => {
  const d = raw();
  drawn(d, "rectangle", 300, 0, 400, 100);
  const arrow = drawn(d, "arrow", 50, 50, 350, 50);
  d.setSelection(Uint32Array.from([1]));
  expect(d.isBound(arrow, true)).toBe(true);

  // The index is a *segment* index, which is what midpointHandleAt answers
  // with: a two-point arrow has exactly one segment, numbered 0.
  const mid = Array.from(d.midpointHandles());
  expect(mid.length).toBe(2);
  expect(d.midpointHandleAt(mid[0], mid[1], 8)).toBe(0);

  d.insertPoint(0, mid[0], 200, "point:1");
  const e = d.element(1);
  expect(e.points.length).toBe(3);
  expect(e.points[0]).toEqual([0, 0]);
  expect(e.x + e.points[1][0]).toBeCloseTo(mid[0], 6);
  // Bending an arrow moves no endpoint, so the binding survives — unlike a
  // point drag, which unbinds the end it pulls away.
  expect(d.isBound(arrow, true)).toBe(true);
  // Nothing here is mid-draw, so the field that says so stays empty.
  expect(e.lastCommittedPoint ?? null).toBe(null);

  d.undo();
  expect(d.element(1).points.length).toBe(2);
});
