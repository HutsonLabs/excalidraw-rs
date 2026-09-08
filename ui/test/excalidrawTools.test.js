// The tool state machine, driven without a canvas.
//
// This is the file excalidrawTools.js exists for. An editor's feel is a pile
// of small decisions — does shift constrain or extend here, does a handle beat
// the shape it belongs to, how far is a drag — and every one of them is
// invisible in a screenshot and obvious to a hand. Kept in a module with no
// DOM and no document, they can be pinned; kept inline in the event handlers,
// they can only be discovered by using the app.
//
// The `probe` argument is what makes this possible: the machine is *told* what
// is under the pointer rather than asking, so a test states the situation in a
// line instead of building a document to produce it.

import { test, expect } from "bun:test";
import {
  afterDraw, cursorFor, handlesCollapsed, isPressureDevice, keyIntent, newToolState,
  passedThreshold, pointerIntent, pressureOf, toolForKey, toolLabel, wheelIntent,
  DRAG_THRESHOLD, HANDLE, NUDGE, NUDGE_FAST, REORDER, ROTATE_SNAP, TOOLS,
} from "../src/excalidrawTools.js";

const at = (tool, extra = {}) => ({ ...newToolState(), tool, ...extra });
const down = (extra = {}) => ({ button: 0, shiftKey: false, altKey: false, ...extra });
const empty = { handle: -1, hit: -1, hitSelected: false };

// --- the tools themselves ----------------------------------------------------

test("the shortcuts are Excalidraw's, letters and digits both", () => {
  // A hand that has used Excalidraw already knows this keyboard, and a
  // nearly-right keyboard is worse than an unfamiliar one because the mistakes
  // are silent.
  expect(toolForKey("v")).toBe("select");
  expect(toolForKey("1")).toBe("select");
  expect(toolForKey("r")).toBe("rectangle");
  expect(toolForKey("2")).toBe("rectangle");
  expect(toolForKey("d")).toBe("diamond");
  expect(toolForKey("o")).toBe("ellipse");
  expect(toolForKey("a")).toBe("arrow");
  expect(toolForKey("l")).toBe("line");
  expect(toolForKey("p")).toBe("freedraw");
  expect(toolForKey("t")).toBe("text");
  expect(toolForKey("h")).toBe("hand");
  expect(toolForKey("R")).toBe("rectangle"); // caps lock is not a different tool
  expect(toolForKey("j")).toBe(null);
  expect(toolForKey("Enter")).toBe(null);
});

test("freedraw answers to X as well as P, the way Excalidraw's does", () => {
  // Upstream is `letterKey: [KEYS.P, KEYS.X]`, and both spellings are in the
  // wild — P for pencil, X for where the button sits.
  expect(toolForKey("x")).toBe("freedraw");
  expect(toolForKey("X")).toBe("freedraw");
  expect(toolForKey("p")).toBe("freedraw");
});

test("the eraser is a tool, on E and on 0", () => {
  expect(toolForKey("e")).toBe("eraser");
  expect(toolForKey("0")).toBe("eraser");
  // It draws nothing, which is what `shape: null` says — the same thing the
  // hand tool says about itself.
  expect(TOOLS.find((t) => t.id === "eraser").shape).toBe(null);
});

test("every tool has a distinct key and a distinct digit", () => {
  const keys = TOOLS.flatMap((t) => [t.key, t.alias].filter(Boolean));
  expect(new Set(keys).size).toBe(keys.length);
  const digits = TOOLS.map((t) => t.digit).filter(Boolean);
  expect(new Set(digits).size).toBe(digits.length);
});

test("a shape tool snaps back to select, unless it is locked", () => {
  expect(afterDraw(at("rectangle"))).toBe("select");
  expect(afterDraw(at("rectangle", { locked: true }))).toBe("rectangle");
});

test("the header says which tool is live, and whether it is locked", () => {
  expect(toolLabel(at("rectangle"))).toBe("Rectangle");
  expect(toolLabel(at("rectangle", { locked: true }))).toBe("Rectangle (locked)");
});

// --- what a pointerdown means ------------------------------------------------

test("a handle beats the shape it belongs to", () => {
  // Without this a small selected shape could not be resized: every grab would
  // land on the shape and move it instead.
  const probe = { handle: HANDLE.SE, hit: 0, hitSelected: true };
  expect(pointerIntent(at("select"), down(), probe)).toEqual({ kind: "resize", handle: HANDLE.SE });
});

test("the rotate handle is its own intent", () => {
  const probe = { handle: HANDLE.ROTATE, hit: -1, hitSelected: false };
  expect(pointerIntent(at("select"), down(), probe)).toEqual({ kind: "rotate" });
});

test("clicking a shape selects and drags it; shift extends instead", () => {
  const probe = { handle: -1, hit: 3, hitSelected: false };
  expect(pointerIntent(at("select"), down(), probe)).toEqual({
    kind: "move", index: 3, extend: false, selected: false,
  });
  expect(pointerIntent(at("select"), down({ shiftKey: true }), probe)).toEqual({
    kind: "move", index: 3, extend: true, selected: false,
  });
});

test("a press on an already-selected shape says so, so the set drags together", () => {
  const probe = { handle: -1, hit: 3, hitSelected: true };
  expect(pointerIntent(at("select"), down(), probe).selected).toBe(true);
});

test("empty canvas sweeps a marquee, and shift adds to what is selected", () => {
  expect(pointerIntent(at("select"), down(), empty)).toEqual({
    kind: "marquee", extend: false, contain: false,
  });
  expect(pointerIntent(at("select"), down({ shiftKey: true }), empty)).toEqual({
    kind: "marquee", extend: true, contain: false,
  });
});

test("alt narrows the marquee to what it encloses", () => {
  // `marquee(..., contain)` has been plumbed through xd-core and the boundary
  // since Phase 2 and nothing ever passed anything but false.
  expect(pointerIntent(at("select"), down({ altKey: true }), empty).contain).toBe(true);
  expect(pointerIntent(at("select"), down({ altKey: true, shiftKey: true }), empty)).toEqual({
    kind: "marquee", extend: true, contain: true,
  });
});

test("a handle that has closed over its own element loses to a move", () => {
  // At 50% zoom the grab radius is 16 scene units, so a 25-unit-tall text
  // element sits inside its own N and S handles: the second press of a
  // double-click read as a resize, and one pixel of jitter rescaled the font.
  const tiny = { minX: 0, minY: 0, maxX: 100, maxY: 25 };
  const probe = { handle: HANDLE.S, hit: 0, hitSelected: true, box: tiny, handleRadius: 16 };
  expect(pointerIntent(at("select"), down(), probe)).toEqual({
    kind: "move", index: 0, extend: false, selected: true,
  });
  // And the cursor agrees, or it promises a resize the click will not do.
  expect(cursorFor(at("select"), probe)).toBe("move");
});

test("a handle grabbed off the body still resizes, however small the element", () => {
  // Otherwise a small shape could not be resized at all, which would be a worse
  // bug than the one the rule above fixes.
  const tiny = { minX: 0, minY: 0, maxX: 100, maxY: 25 };
  const probe = { handle: HANDLE.S, hit: -1, hitSelected: false, box: tiny, handleRadius: 16 };
  expect(pointerIntent(at("select"), down(), probe)).toEqual({ kind: "resize", handle: HANDLE.S });
});

test("the collapse rule needs both a box and a radius to fire", () => {
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 25 };
  expect(handlesCollapsed(box, 16)).toBe(true); // 25 < 3 × 16
  expect(handlesCollapsed(box, 4)).toBe(false); // 25 > 3 × 4
  // A caller that measured nothing gets the plain handle-beats-shape rule.
  expect(handlesCollapsed(null, 16)).toBe(false);
  expect(handlesCollapsed(box, 0)).toBe(false);
});

test("the text tool types into text that is already there", () => {
  // It used to return `text` before any hit test ran, so clicking a text
  // element with the text tool stacked a second one on top of it.
  const onText = { handle: -1, hit: 2, hitSelected: false, hitType: "text" };
  expect(pointerIntent(at("text"), down(), onText)).toEqual({ kind: "editText", index: 2 });
  // Empty canvas is where new text comes from, and the only place.
  expect(pointerIntent(at("text"), down(), empty)).toEqual({ kind: "text" });
});

test("the text tool on a shape asks for that shape's label", () => {
  // The same thing double-clicking the shape does. It used to return `text`
  // here, which laid a free-floating element over the box — right up until the
  // box moved and the words stayed behind.
  const onRect = { handle: -1, hit: 2, hitSelected: false, hitType: "rectangle", label: 2 };
  expect(pointerIntent(at("text"), down(), onRect)).toEqual({ kind: "labelShape", index: 2 });
  // A shape the model would refuse to bind a label to — a line, an image, a
  // frame — reports no label, and free text is the honest answer for it.
  const onLine = { handle: -1, hit: 2, hitSelected: false, hitType: "line", label: -1 };
  expect(pointerIntent(at("text"), down(), onLine)).toEqual({ kind: "text" });
});

test("a point handle beats the box handle sitting on top of it", () => {
  // On a diagonal arrow the two endpoints are exactly opposite corners of the
  // bounding box, so this tie is every diagonal arrow rather than a rare case —
  // and a resize handle winning it is how dragging an endpoint becomes a scale.
  const onCorner = { point: 1, handle: HANDLE.SE, hit: 0, hitSelected: true };
  expect(pointerIntent(at("select"), down(), onCorner)).toEqual({ kind: "point", index: 1 });
  expect(cursorFor(at("select"), onCorner)).toBe("move");
});

test("a segment midpoint asks for a new point, and loses to a real one", () => {
  expect(pointerIntent(at("select"), down(), { point: -1, midpoint: 0, handle: -1, hit: 0 }))
    .toEqual({ kind: "addPoint", index: 0 });
  // A point and a midpoint can only coincide on a zero-length segment, and
  // moving the point that is there beats making another one.
  expect(pointerIntent(at("select"), down(), { point: 2, midpoint: 0, handle: -1, hit: 0 }))
    .toEqual({ kind: "point", index: 2 });
});

test("the image tool asks where before it asks what", () => {
  expect(pointerIntent(at("image"), down(), empty)).toEqual({ kind: "image" });
  expect(TOOLS.find((t) => t.id === "image").digit).toBe("9");
  // No letter key: Excalidraw's image tool has none, and 9 is the whole of it.
  expect(TOOLS.find((t) => t.id === "image").key).toBe("");
  expect(toolForKey("9")).toBe("image");
});

test("the eraser sweeps rather than drawing", () => {
  expect(pointerIntent(at("eraser"), down(), empty)).toEqual({ kind: "erase" });
  // Over a shape too: the eraser has no interest in what is selected.
  expect(pointerIntent(at("eraser"), down(), { handle: HANDLE.SE, hit: 1, hitSelected: true }))
    .toEqual({ kind: "erase" });
});

test("space and the hand tool pan, whatever is underneath", () => {
  const onAShape = { handle: HANDLE.SE, hit: 0, hitSelected: true };
  expect(pointerIntent(at("select", { space: true }), down(), onAShape)).toEqual({ kind: "pan" });
  expect(pointerIntent(at("hand"), down(), onAShape)).toEqual({ kind: "pan" });
  // Space wins over a drawing tool too — it is how you get out of any state.
  expect(pointerIntent(at("rectangle", { space: true }), down(), empty)).toEqual({ kind: "pan" });
});

test("the middle button pans, and the right button is not ours", () => {
  expect(pointerIntent(at("select"), down({ button: 1 }), empty)).toEqual({ kind: "pan" });
  expect(pointerIntent(at("select"), down({ button: 2 }), empty)).toBe(null);
});

test("each drawing tool asks for its own shape", () => {
  for (const id of ["rectangle", "diamond", "ellipse", "arrow", "line"]) {
    expect(pointerIntent(at(id), down(), empty)).toEqual({ kind: "draw", shape: id });
  }
  expect(pointerIntent(at("freedraw"), down(), empty)).toEqual({ kind: "freedraw" });
  expect(pointerIntent(at("text"), down(), empty)).toEqual({ kind: "text" });
});

test("a drawing tool ignores what is under the pointer", () => {
  // Drawing a rectangle over an existing one draws a rectangle. It does not
  // grab the handle that happens to be there.
  const busy = { handle: HANDLE.NW, hit: 2, hitSelected: true };
  expect(pointerIntent(at("rectangle"), down(), busy)).toEqual({ kind: "draw", shape: "rectangle" });
});

// --- thresholds and modifiers ------------------------------------------------

test("a wobble is a click and a travel is a drag", () => {
  expect(passedThreshold(0, 0)).toBe(false);
  expect(passedThreshold(DRAG_THRESHOLD, DRAG_THRESHOLD)).toBe(false);
  expect(passedThreshold(DRAG_THRESHOLD + 1, 0)).toBe(true);
  expect(passedThreshold(0, -(DRAG_THRESHOLD + 1))).toBe(true);
});

test("rotation snaps to 15 degrees, in radians", () => {
  expect(ROTATE_SNAP).toBeCloseTo(Math.PI / 12, 12);
  // 24 snaps make a full turn, which is what puts 45° and 90° on a stop.
  expect((Math.PI * 2) / ROTATE_SNAP).toBeCloseTo(24, 9);
});

test("a mouse reports no pressure and gets the middle of the range", () => {
  expect(pressureOf({ pressure: 0 })).toBe(0.5);
  expect(pressureOf({})).toBe(0.5);
  expect(pressureOf({ pressure: 0.8 })).toBe(0.8);
});

test("only a pen counts as reporting real pressure", () => {
  // perfect-freehand ignores recorded pressures when simulation is on, so this
  // is the flag that decides whether a pen's numbers are used at all.
  expect(isPressureDevice({ pointerType: "pen" })).toBe(true);
  expect(isPressureDevice({ pointerType: "mouse" })).toBe(false);
  expect(isPressureDevice({ pointerType: "touch" })).toBe(false);
  expect(isPressureDevice({})).toBe(false);
});

// --- cursors -----------------------------------------------------------------

test("the cursor says what a click will do", () => {
  expect(cursorFor(at("select"), empty)).toBe("default");
  expect(cursorFor(at("select"), { handle: -1, hit: 0 })).toBe("move");
  expect(cursorFor(at("select"), { handle: HANDLE.E, hit: -1 })).toBe("ew-resize");
  expect(cursorFor(at("select"), { handle: HANDLE.ROTATE, hit: -1 })).toBe("grab");
  expect(cursorFor(at("rectangle"), empty)).toBe("crosshair");
  expect(cursorFor(at("text"), empty)).toBe("text");
  expect(cursorFor(at("hand"), empty)).toBe("grab");
  expect(cursorFor(at("hand"), empty, true)).toBe("grabbing");
  expect(cursorFor(at("select", { space: true }), { handle: HANDLE.SE, hit: 0 })).toBe("grab");
});

// --- the keyboard ------------------------------------------------------------

const key = (k, extra = {}) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });

test("a key we do not claim is left to the browser", () => {
  // Returning null is what lets ⌘R reload and ⌘Q quit: the caller calls
  // preventDefault exactly when an intent comes back.
  expect(keyIntent(key("r", { metaKey: true }))).toBe(null);
  expect(keyIntent(key("Tab"))).toBe(null);
  expect(keyIntent(key("F5"))).toBe(null);
});

test("copy, cut and paste are deliberately not claimed here", () => {
  // They arrive as clipboard events with the data on them, which is the only
  // way to read the clipboard without a permission prompt — and those events
  // fire for the menu bar and the context menu, which a keydown would miss.
  for (const k of ["c", "x", "v"]) {
    expect(keyIntent(key(k, { metaKey: true }))).toBe(null);
  }
});

test("the editing commands", () => {
  expect(keyIntent(key("Escape"))).toEqual({ kind: "escape" });
  expect(keyIntent(key("Delete"))).toEqual({ kind: "delete" });
  expect(keyIntent(key("Backspace"))).toEqual({ kind: "delete" });
  expect(keyIntent(key("a", { metaKey: true }))).toEqual({ kind: "selectAll" });
  expect(keyIntent(key("d", { metaKey: true }))).toEqual({ kind: "duplicate" });
  expect(keyIntent(key("s", { metaKey: true }))).toEqual({ kind: "save" });
  expect(keyIntent(key("Enter"))).toEqual({ kind: "edit" });
});

test("ctrl is command too — a webview reporting the wrong platform is a bug class", () => {
  expect(keyIntent(key("a", { ctrlKey: true }))).toEqual({ kind: "selectAll" });
  expect(keyIntent(key("z", { ctrlKey: true }))).toEqual({ kind: "undo" });
});

test("undo, redo, and redo's second spelling", () => {
  expect(keyIntent(key("z", { metaKey: true }))).toEqual({ kind: "undo" });
  expect(keyIntent(key("z", { metaKey: true, shiftKey: true }))).toEqual({ kind: "redo" });
  expect(keyIntent(key("y", { metaKey: true }))).toEqual({ kind: "redo" });
});

test("z-order is four shortcuts over one command", () => {
  expect(keyIntent(key("]", { metaKey: true }))).toEqual({ kind: "reorder", how: REORDER.FORWARD });
  expect(keyIntent(key("]", { metaKey: true, shiftKey: true }))).toEqual({ kind: "reorder", how: REORDER.FRONT });
  expect(keyIntent(key("[", { metaKey: true }))).toEqual({ kind: "reorder", how: REORDER.BACKWARD });
  expect(keyIntent(key("[", { metaKey: true, shiftKey: true }))).toEqual({ kind: "reorder", how: REORDER.BACK });
});

test("group and ungroup share a key", () => {
  expect(keyIntent(key("g", { metaKey: true }))).toEqual({ kind: "group" });
  expect(keyIntent(key("g", { metaKey: true, shiftKey: true }))).toEqual({ kind: "ungroup" });
});

test("arrow keys nudge, and shift nudges ten times as far", () => {
  expect(keyIntent(key("ArrowLeft"))).toEqual({ kind: "nudge", dx: -NUDGE, dy: 0 });
  expect(keyIntent(key("ArrowRight"))).toEqual({ kind: "nudge", dx: NUDGE, dy: 0 });
  expect(keyIntent(key("ArrowUp"))).toEqual({ kind: "nudge", dx: 0, dy: -NUDGE });
  expect(keyIntent(key("ArrowDown", { shiftKey: true }))).toEqual({ kind: "nudge", dx: 0, dy: NUDGE_FAST });
  expect(NUDGE_FAST).toBe(NUDGE * 10);
});

test("zoom is on the keyboard as well as the wheel", () => {
  expect(keyIntent(key("0", { metaKey: true }))).toEqual({ kind: "zoomReset" });
  expect(keyIntent(key("=", { metaKey: true })).kind).toBe("zoom");
  expect(keyIntent(key("+", { metaKey: true })).factor).toBeGreaterThan(1);
  expect(keyIntent(key("-", { metaKey: true })).factor).toBeLessThan(1);
});

test("fit and zoom-to-selection are ⇧1 and ⇧2, matched on the physical key", () => {
  // ⇧1 arrives as "!" and ⇧2 as "@", so `ev.key` cannot see them — Excalidraw
  // tests `event.code` for exactly this and so does this.
  expect(keyIntent(key("!", { shiftKey: true, code: "Digit1" }))).toEqual({ kind: "zoomFit" });
  expect(keyIntent(key("@", { shiftKey: true, code: "Digit2" }))).toEqual({ kind: "zoomSelection" });
  // Unshifted they are still the tool digits.
  expect(keyIntent(key("1", { code: "Digit1" }))).toEqual({ kind: "tool", tool: "select" });
});

test("macOS z-order needs the physical bracket key", () => {
  // Option is a compose modifier on a Mac, so ⌘⌥[ arrives with key "“" and
  // never equals "[". These two never matched anything before.
  expect(keyIntent(key("“", { metaKey: true, altKey: true, code: "BracketLeft" })))
    .toEqual({ kind: "reorder", how: REORDER.BACK });
  expect(keyIntent(key("‘", { metaKey: true, altKey: true, code: "BracketRight" })))
    .toEqual({ kind: "reorder", how: REORDER.FRONT });
  // And the plain forms still mean forward/backward, not front/back.
  expect(keyIntent(key("]", { metaKey: true, code: "BracketRight" })))
    .toEqual({ kind: "reorder", how: REORDER.FORWARD });
});

test("flip is shifted, and the grid is on the command key", () => {
  expect(keyIntent(key("H", { shiftKey: true }))).toEqual({ kind: "flip", axis: "horizontal" });
  expect(keyIntent(key("V", { shiftKey: true }))).toEqual({ kind: "flip", axis: "vertical" });
  // Unshifted they are still the hand tool and nothing at all.
  expect(keyIntent(key("h"))).toEqual({ kind: "tool", tool: "hand" });
  expect(keyIntent(key("'", { metaKey: true }))).toEqual({ kind: "grid" });
});

test("the selection can be locked, and the sheet has a key", () => {
  expect(keyIntent(key("l", { metaKey: true, shiftKey: true }))).toEqual({ kind: "toggleLock" });
  // ⌘L on its own is not ours — it is the browser's address bar.
  expect(keyIntent(key("l", { metaKey: true }))).toBe(null);
  // `?` is a shifted key on every layout, so it has to be claimed ahead of the
  // guard that throws shifted keys away.
  expect(keyIntent(key("?", { shiftKey: true }))).toEqual({ kind: "help" });
});

test("tool keys, and the lock", () => {
  expect(keyIntent(key("r"))).toEqual({ kind: "tool", tool: "rectangle" });
  expect(keyIntent(key("3"))).toEqual({ kind: "tool", tool: "diamond" });
  expect(keyIntent(key("q"))).toEqual({ kind: "lock" });
});

test("a shifted letter is not a tool pick", () => {
  // Shift is the extend-selection modifier everywhere else in this editor, so
  // a shifted R is someone still holding shift from the click they just made,
  // not a request for the rectangle tool.
  expect(keyIntent(key("R", { shiftKey: true }))).toBe(null);
  expect(keyIntent(key("r", { altKey: true }))).toBe(null);
});

// --- the wheel ---------------------------------------------------------------

test("a plain wheel scrolls and a pinch zooms", () => {
  // A trackpad pinch arrives as ctrlKey+wheel. That is the platform's
  // convention, not ours.
  expect(wheelIntent({ deltaX: 4, deltaY: -8 })).toEqual({ kind: "pan", dx: -4, dy: 8 });
  const zoom = wheelIntent({ deltaY: -100, ctrlKey: true });
  expect(zoom.kind).toBe("zoom");
  expect(zoom.factor).toBeGreaterThan(1);
  expect(wheelIntent({ deltaY: 100, metaKey: true }).factor).toBeLessThan(1);
});
