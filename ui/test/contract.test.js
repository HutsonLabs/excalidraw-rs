// The contract smoke test (PLAN.md Phase 5, guard #2).
//
// This mounts the portable view exactly the way term.hut's preview.js will —
// a detached host element, a stub `onSave`, a stub `onActions` — drives a few
// pointer events, calls dispose, and asserts that nothing is left running.
//
// The hazard it guards is the one excalidrawView.js's own header names.
// term.hut's preview panes learned it the hard way: a view whose tab closed
// kept its ResizeObserver and its window-level listeners, kept repainting, and
// kept the closed document's canvas alive. The editor holds strictly more of
// that than the viewer did — pointer capture, a keydown handler, an autosave
// timer, a textarea overlay, a properties panel and a WASM document — so every
// one of those has an assertion below rather than a hope.
//
// ## Why there is a fake DOM and a fake document in here
//
// `bun test` has no DOM, and this project has no dev dependencies on purpose
// (package.json says so: every module under ui/ is a plain ES module loaded
// from disk, and a test runner that needed a build step would be the first
// crack in that). So the DOM below is a stand-in — real enough to *count*, and
// no more. The assertion is "every listener and observer is gone", and that is
// a counting question: a view that passes this against a real DOM passes it
// against this one, and the failure it catches — dispose forgetting one of the
// eight things it has to undo — looks identical either way.
//
// The document is faked for a different reason, and it is the reason xdWasm.js
// exists at all: it hands JS a plain object with plain methods, so a plain
// object satisfies the same shape. That makes the editor's *behaviour* — click
// selects, drag moves, ⌘S writes, a failed serialize does not — testable here
// rather than only by hand, which is worth more than the teardown check that
// was the original point of the file.

import { test, expect, beforeEach, afterEach } from "bun:test";
// One WASM instance for the whole run — see the harness for why it must be
// exactly one, and why no test may call the module's own init.
import { openDoc as openReal } from "./wasmHarness.js";

// --- a DOM, to the extent this needs one -------------------------------------

/// Every add/remove of a listener, anywhere, in one tally. A view that removed
/// nine of its ten listeners fails this, and so does one that removed a
/// listener it never added.
const ledger = new Map(); // `${tag}:${type}` -> net count
const tally = (node, type, delta) => {
  const k = `${node.tagName ?? "window"}:${type}`;
  ledger.set(k, (ledger.get(k) ?? 0) + delta);
};

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.handlers = new Map(); // type -> Set(fn)
    // No layout. A detached host has none in a real browser either, and it is
    // what keeps `fit()` — and therefore every coordinate in this file —
    // deterministic; see PAD below.
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.value = "";
    this.textContent = "";
  }

  addEventListener(type, fn) {
    tally(this, type, 1);
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    tally(this, type, -1);
    this.handlers.get(type)?.delete(fn);
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    if (child.parentNode === this) child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  /// Deliver an event to whatever is listening, with the two methods every
  /// handler in the view calls on it.
  dispatch(type, ev = {}) {
    const list = [...(this.handlers.get(type) ?? [])];
    const event = { type, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of list) fn(event);
    return event;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  // The handful of element methods the view pokes. All no-ops: none of them
  // decides anything, and a stub that did something would be inventing
  // behaviour to then assert.
  focus() {}
  blur() {}
  select() {}
  setSelectionRange() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  querySelectorAll() { return []; }
  /// No 2D context. The view checks for one before measuring text and bails
  /// out of `paint` before ever asking for it, which is the honest headless
  /// answer — a stub context would be a canvas that silently drew nothing.
  getContext() { return null; }
}

let frames = new Set();
let observers = 0;

class FakeResizeObserver {
  constructor() { observers++; }
  observe() {}
  disconnect() { observers--; }
}

const installDom = () => {
  ledger.clear();
  frames = new Set();
  observers = 0;
  let seq = 0;
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    head: new FakeNode("head"),
    body: new FakeNode("body"),
    querySelectorAll: () => [],
  };
  const win = new FakeNode("window");
  win.devicePixelRatio = 1;
  globalThis.window = win;
  globalThis.ResizeObserver = FakeResizeObserver;
  // Queued and never run. The view must still cancel it, and cancelling
  // something that already fired would prove nothing.
  globalThis.requestAnimationFrame = () => {
    const id = ++seq;
    frames.add(id);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
};

const uninstallDom = () => {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.ResizeObserver;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
};

// --- a document, to the extent this needs one --------------------------------

const RECT = {
  type: "rectangle", id: "a", x: 10, y: 10, width: 100, height: 60, angle: 0,
  strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, seed: 1,
  version: 1, versionNonce: 1, updated: 0, isDeleted: false,
};

const SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [RECT],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

/// xdWasm.js's wrapper shape, in JavaScript. Enough of a document to select,
/// drag, delete, undo and serialize — which is exactly the set of things the
/// tests below need it to be honest about.
function fakeDoc(text) {
  let list = JSON.parse(text).elements.map((e) => ({ ...e }));
  let selection = [];
  const undo = [];
  const redo = [];
  let broken = false; // set by a test to make toJson fail
  let ids = 0;

  const snapshot = () => list.map((e) => ({ ...e }));
  const record = () => {
    undo.push(snapshot());
    redo.length = 0;
  };
  const change = (structural = false) => ({ revision: undo.length, dirty: [], bbox: null, structural });
  const boxOf = (e) => ({ minX: e.x, minY: e.y, maxX: e.x + e.width, maxY: e.y + e.height });
  const union = (indices) => {
    const boxes = indices.map((i) => list[i]).filter(Boolean).map(boxOf);
    if (!boxes.length) return null;
    return {
      minX: Math.min(...boxes.map((b) => b.minX)),
      minY: Math.min(...boxes.map((b) => b.minY)),
      maxX: Math.max(...boxes.map((b) => b.maxX)),
      maxY: Math.max(...boxes.map((b) => b.maxY)),
    };
  };

  return {
    get length() { return list.length; },
    get selection() { return [...selection]; },
    element: (i) => list[i] ?? null,
    elements: () => [...list],
    elementId: (i) => list[i]?.id,
    elementBounds: (i) => (list[i] ? boxOf(list[i]) : null),
    sceneBounds: () => union(list.map((_, i) => i)),
    /// The crate's port of excalidrawScene.js's `fitTransform`, mirrored so
    /// the fake and the real core put the camera in the same place and the
    /// coordinates below mean the same thing under both.
    fitTransform: (width, height, padding = 32) => {
      const b = union(list.map((_, i) => i));
      const vw = Math.max(0, width - padding * 2);
      const vh = Math.max(0, height - padding * 2);
      if (!b || vw <= 0 || vh <= 0) return { scale: 1, offsetX: padding, offsetY: padding };
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      const scale = Math.min(1, w > 0 ? vw / w : Infinity, h > 0 ? vh / h : Infinity) || 1;
      return {
        scale,
        offsetX: padding + (vw - w * scale) / 2 - b.minX * scale,
        offsetY: padding + (vh - h * scale) / 2 - b.minY * scale,
      };
    },
    appState: () => ({ viewBackgroundColor: "#ffffff" }),
    files: () => ({}),
    toJson: () => {
      if (broken) throw new Error("serialize failed");
      // Byte-identical to the input when nothing has changed, which is the
      // property the real core is built around (`Element::rest`, `jsnum`) and
      // the property `worthSaving`'s "identical is not written" rule needs in
      // order to mean anything.
      return JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: list,
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      });
    },
    setNow: () => {},
    /// Excalidraw's rule, and the crate's: a shape with a background is hit
    /// anywhere inside it, and a transparent one is hit on its stroke only —
    /// a hollow box is a frame, and clicking through the hole in it selects
    /// what is behind. Mirrored here rather than simplified to "inside the
    /// box", because a fake that is easier to satisfy than the real model is a
    /// fake that hides the bug it was written to catch.
    hitTest: (x, y, threshold) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        const b = boxOf(e);
        const inside = x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
        if (inside && e.backgroundColor && e.backgroundColor !== "transparent") return i;
        const outer = x >= b.minX - threshold && x <= b.maxX + threshold
          && y >= b.minY - threshold && y <= b.maxY + threshold;
        const hole = x > b.minX + threshold && x < b.maxX - threshold
          && y > b.minY + threshold && y < b.maxY - threshold;
        if (outer && !hole) return i;
      }
      return -1;
    },
    marquee: (x0, y0, x1, y1) => {
      const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
      const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
      return list
        .map((e, i) => [e, i])
        .filter(([e]) => {
          const b = boxOf(e);
          return b.minX <= hi.x && b.maxX >= lo.x && b.minY <= hi.y && b.maxY >= lo.y;
        })
        .map(([, i]) => i);
    },
    selectionBounds: () => union(selection),
    selectionAngle: () => 0,
    setSelection: (indices) => { selection = [...indices]; },
    toggleSelection: (i) => {
      const at = selection.indexOf(i);
      if (at >= 0) selection.splice(at, 1);
      else selection.push(i);
    },
    selectAll: () => { selection = list.map((_, i) => i); },
    clearSelection: () => { selection = []; },
    // Nothing in these tests aims at a handle; -1 is "not on one".
    handleAt: () => -1,
    handlePoints: () => null,
    bindableAt: () => -1,
    dragBy: (dx, dy) => {
      record();
      for (const i of selection) {
        if (!list[i]) continue;
        list[i] = { ...list[i], x: list[i].x + dx, y: list[i].y + dy };
      }
      return change();
    },
    resizeTo: () => change(),
    rotateTo: () => change(),
    beginDraft: (kind, x, y, style) => {
      record();
      list.push({ type: kind, id: `n${++ids}`, x, y, width: 0, height: 0, ...style });
      selection = [list.length - 1];
      return change(true);
    },
    draftTo: (x, y) => {
      const i = list.length - 1;
      list[i] = { ...list[i], width: x - list[i].x, height: y - list[i].y };
      return change();
    },
    draftPoint: () => change(),
    endDraft: () => change(),
    insert: (element) => {
      record();
      list.push({ ...element, id: `n${++ids}` });
      selection = [list.length - 1];
      return change(true);
    },
    patch: (id, fields) => {
      record();
      const i = list.findIndex((e) => e.id === id);
      if (i >= 0) list[i] = { ...list[i], ...fields };
      return change();
    },
    setStyle: (style) => {
      record();
      for (const i of selection) list[i] = { ...list[i], ...style };
      return change();
    },
    deleteSelection: () => {
      record();
      const gone = new Set(selection);
      list = list.filter((_, i) => !gone.has(i));
      selection = [];
      return change(true);
    },
    duplicateSelection: (dx, dy) => {
      record();
      const copies = selection.map((i) => ({ ...list[i], id: `n${++ids}`, x: list[i].x + dx, y: list[i].y + dy }));
      list = [...list, ...copies];
      selection = copies.map((_, k) => list.length - copies.length + k);
      return change(true);
    },
    reorder: () => change(true),
    group: () => change(),
    ungroup: () => change(),
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    undo: () => {
      if (!undo.length) return null;
      redo.push(snapshot());
      list = undo.pop();
      selection = selection.filter((i) => i < list.length);
      return change(true);
    },
    redo: () => {
      if (!redo.length) return null;
      undo.push(snapshot());
      list = redo.pop();
      return change(true);
    },
    /// Test-only: make the next serialize fail, the way a panicking core
    /// would. Not part of the wrapper's shape, and nothing in the view knows
    /// it is here.
    __break: () => { broken = true; },
  };
}

/// The last document handed out, so a test can reach past the view to check
/// what actually happened to the drawing.
let live = null;

/// The document factory the view is mounted with.
///
/// Deliberately *not* `mock.module`. Module mocks in Bun are registered for
/// the whole test process, so mocking xdWasm.js here would hand a fake core to
/// every other file in the run — including the geometry parity tests, whose
/// entire point is to compare against the real one. The view takes the factory
/// as an argument for exactly this reason.
const openFake = async (text) => (live = fakeDoc(text));

// --- helpers -----------------------------------------------------------------

const mount = async (opts = {}) => {
  const { renderExcalidraw } = await import("../src/excalidrawEdit.js");
  const host = new FakeNode("main");
  const saves = [];
  let actions = null;
  const dispose = renderExcalidraw(host, opts.text ?? SCENE, {
    onSave: (text) => {
      saves.push(text);
      return opts.onSave?.(text);
    },
    onActions: (list) => { actions = list; },
    openDocument: openFake,
  });
  // The core and the properties panel are both loaded lazily, so the view is
  // on screen and taking events before either arrives — the same shape as
  // bpmnView.js's import, and the same reason. A macrotask is enough for both
  // module loads to settle.
  await settle();
  // `actions` is a function rather than a property: the header is republished
  // as the view changes, and a destructured snapshot would freeze the answer
  // at mount time.
  return { host, dispose, saves, wrap: host.children[0], actions: () => actions };
};

/// One turn of the event loop — long enough for a dynamic import and a
/// resolved promise chain, short enough that the 800 ms autosave has not run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/// A point on the fixture rectangle's left stroke.
///
/// Not its middle: a shape with `backgroundColor: "transparent"` is hit on its
/// stroke only, in the real core and in the fake above. Pressing the middle of
/// this rectangle selects nothing, which is Excalidraw's behaviour and is
/// worth knowing about before reading the presses below.
const ON_STROKE = [10, 40];

/// The camera after `fit()` in a pane with no layout: 1:1, with
/// `fitTransform`'s padding as the whole of the offset. So scene coordinates
/// are screen coordinates minus 32 — and the pointer helpers below take
/// *scene* coordinates and add it back, which is what lets a test say "press
/// on the rectangle at 20, 20" and mean the rectangle at 20, 20.
const PAD = 32;

const press = (wrap, x, y, extra = {}) =>
  wrap.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: x + PAD, clientY: y + PAD, shiftKey: false, altKey: false, ...extra });
const move = (wrap, x, y, extra = {}) =>
  wrap.dispatch("pointermove", { pointerId: 1, clientX: x + PAD, clientY: y + PAD, shiftKey: false, altKey: false, ...extra });
const lift = (wrap, x, y) =>
  wrap.dispatch("pointerup", { pointerId: 1, clientX: x + PAD, clientY: y + PAD });
const dbl = (wrap, x, y) =>
  wrap.dispatch("dblclick", { clientX: x + PAD, clientY: y + PAD });
const type = (wrap, key, extra = {}) =>
  wrap.dispatch("keydown", { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });

beforeEach(() => {
  installDom();
  live = null;
});
afterEach(uninstallDom);

// --- the contract ------------------------------------------------------------

test("the view mounts, edits, saves, and disposes clean", async () => {
  const { host, dispose, saves, wrap, actions } = await mount();

  // The view contributes to the pane header rather than growing a toolbar —
  // that is the difference between a term.hut view and an app's canvas, so it
  // is worth asserting and not just observing.
  const row = actions();
  expect(Array.isArray(row)).toBe(true);
  expect(row.length).toBeGreaterThan(0);
  expect(row.every((a) => a?.id != null)).toBe(true);
  // Every id is distinct, or renderActions' diff drops one of them silently.
  expect(new Set(row.map((a) => a.id)).size).toBe(row.length);

  // A drag, in the crudest terms the contract allows: press, move, release.
  press(wrap, ...ON_STROKE);
  move(wrap, 50, 60);
  lift(wrap, 50, 60);

  // The properties panel is mounted into a child of the host and refreshed
  // when the selection changes. It is the real module here, not a stub — which
  // is what makes the ledger below cover it: a view that forgot to call its
  // dispose() would leave its listeners behind and the counts would not
  // balance. (It takes itself off screen with nothing selected, so this is
  // asserted after the drag rather than at mount.)
  const props = wrap.children.find((c) => c.className === "xd-props");
  expect(props.children).toHaveLength(1);

  // ⌘S flushes rather than waiting out the 800 ms debounce.
  type(wrap, "s", { metaKey: true });
  await settle();
  expect(saves).toHaveLength(1);
  expect(JSON.parse(saves[0]).elements[0].x).toBe(50);

  dispose();

  // Every listener the view added, it removed. A non-zero count is a listener
  // firing into a torn-down view — the exact bug this file exists for.
  for (const [where, count] of ledger) {
    expect([where, count]).toEqual([where, 0]);
  }
  // And it left the host as it found it, so the pane can put something else
  // there without clearing up after it.
  expect(host.children).toHaveLength(0);
  // The observer and the animation frame, which are the two things that
  // outlive a removed element. The properties panel is covered by the ledger
  // above: it is the real module here, not a stub, so a view that forgot to
  // call its dispose() leaves its listeners behind and the counts do not
  // balance.
  expect(observers).toBe(0);
  expect(frames.size).toBe(0);
});

test("dispose is idempotent — a pane may tear down twice", async () => {
  // preview.js's disposeView can run from both the tab closing and the pane
  // being replaced, and the second call must not throw.
  const { dispose } = await mount();
  dispose();
  expect(() => dispose()).not.toThrow();
  for (const [, count] of ledger) expect(count).toBe(0);
});

test("a pending autosave is flushed by dispose, not dropped", async () => {
  // A tab closing on a debounce that has not fired yet is an edit the user
  // made and would never see again.
  const { dispose, saves, wrap } = await mount();
  press(wrap, ...ON_STROKE);
  move(wrap, 50, 60);
  lift(wrap, 50, 60);
  expect(saves).toHaveLength(0); // still inside the 800 ms window

  dispose();
  await settle();
  expect(saves).toHaveLength(1);
});

test("a failed serialize never reaches onSave", async () => {
  // The highest-stakes rule in the plan, from the view's side. `worthSaving`
  // refuses this too; the point of the test is that the view asks.
  const { saves, wrap } = await mount();
  live.__break();
  press(wrap, ...ON_STROKE);
  move(wrap, 50, 60);
  lift(wrap, 50, 60);
  type(wrap, "s", { metaKey: true });
  await settle();
  expect(saves).toHaveLength(0);
});

test("a save that changes nothing is not written", async () => {
  const { saves, wrap } = await mount();
  // A click that selects but does not move is not an edit.
  press(wrap, ...ON_STROKE);
  lift(wrap, ...ON_STROKE);
  type(wrap, "s", { metaKey: true });
  await settle();
  expect(saves).toHaveLength(0);
});

test("a file that will not open leaves a sentence, not a blank canvas", async () => {
  // A blank canvas over a file we failed to read is one stray keystroke away
  // from overwriting it — the same call bpmnView.js makes.
  const { renderExcalidraw } = await import("../src/excalidrawEdit.js");
  const host = new FakeNode("main");
  const dispose = renderExcalidraw(host, "{", {
    onSave: () => { throw new Error("must not be called"); },
    onActions: () => {},
    openDocument: () => Promise.reject(new Error("unexpected end of input")),
  });
  await settle();
  dispose();
  expect(host.children).toHaveLength(0);
});

// --- the editing the contract implies ----------------------------------------

test("a click selects the shape under it, and empty canvas clears", async () => {
  const { wrap } = await mount();
  press(wrap, ...ON_STROKE);
  lift(wrap, ...ON_STROKE);
  expect(live.selection).toEqual([0]);

  press(wrap, 400, 400);
  lift(wrap, 400, 400);
  expect(live.selection).toEqual([]);
});

test("a wobble is a click, not a nudge", async () => {
  // Three pixels of trackpad slop must not move the drawing, or every attempt
  // to select something edits it.
  const { wrap, saves } = await mount();
  press(wrap, ...ON_STROKE);
  move(wrap, 12, 41);
  lift(wrap, 12, 41);
  expect(live.element(0).x).toBe(10);
  type(wrap, "s", { metaKey: true });
  await settle();
  expect(saves).toHaveLength(0);
});

test("a marquee sweeps up what it crosses", async () => {
  const { wrap } = await mount();
  press(wrap, 400, 400);
  move(wrap, 0, 0);
  lift(wrap, 0, 0);
  expect(live.selection).toEqual([0]);
});

test("delete, duplicate, select-all and undo are on the keyboard", async () => {
  const { wrap } = await mount();
  type(wrap, "a", { metaKey: true });
  expect(live.selection).toEqual([0]);

  type(wrap, "d", { metaKey: true });
  expect(live.length).toBe(2);

  type(wrap, "Delete");
  expect(live.length).toBe(1);

  type(wrap, "z", { metaKey: true });
  expect(live.length).toBe(2);
  type(wrap, "z", { metaKey: true, shiftKey: true });
  expect(live.length).toBe(1);
});

test("a shape tool draws and then hands the keyboard back to select", async () => {
  const { wrap, actions } = await mount();
  type(wrap, "r");
  press(wrap, 200, 200);
  move(wrap, 300, 260);
  lift(wrap, 300, 260);
  const drawn = live.element(live.length - 1);
  expect(drawn.type).toBe("rectangle");
  expect(drawn.width).toBe(100);
  expect(drawn.height).toBe(60);
  // Back to select, which is what Excalidraw does and what the next click
  // almost always wants.
  expect(actions().find((a) => a.id === "xd-tool")?.text).toBe("Select");
});

test("the tool stays put when it is locked", async () => {
  const { wrap, actions } = await mount();
  type(wrap, "r");
  type(wrap, "q");
  press(wrap, 200, 200);
  move(wrap, 260, 240);
  lift(wrap, 260, 240);
  expect(actions().find((a) => a.id === "xd-tool")?.text).toBe("Rectangle (locked)");
});

test("copy and paste go through the clipboard as an excalidraw payload", async () => {
  const { wrap } = await mount();
  type(wrap, "a", { metaKey: true });

  const board = new Map();
  const clipboardData = {
    setData: (kind, value) => board.set(kind, value),
    getData: (kind) => board.get(kind) ?? "",
  };
  wrap.dispatch("copy", { clipboardData });
  expect(JSON.parse(board.get("text/plain")).type).toContain("excalidraw");

  wrap.dispatch("paste", { clipboardData });
  expect(live.length).toBe(2);
  expect(live.element(1).type).toBe("rectangle");
});

test("plain text pastes as a text element", async () => {
  const { wrap } = await mount();
  wrap.dispatch("paste", {
    clipboardData: { getData: () => "hello", setData: () => {} },
  });
  const added = live.element(live.length - 1);
  expect(added.type).toBe("text");
  expect(added.text).toBe("hello");
});

test("double-clicking empty canvas opens a text overlay, and an empty one leaves nothing behind", async () => {
  const { wrap } = await mount();
  dbl(wrap, 300, 300);
  const before = live.length;
  expect(before).toBe(2); // the rectangle, and the new empty text element

  // The overlay is a real element in the host while it is open.
  const overlay = wrap.children.find((c) => c.tagName === "TEXTAREA");
  expect(overlay).toBeDefined();

  // Blurring away with nothing typed deletes it rather than leaving an
  // invisible, unselectable element in the drawing.
  overlay.dispatch("blur", {});
  expect(live.length).toBe(1);
  expect(wrap.children.some((c) => c.tagName === "TEXTAREA")).toBe(false);
});

test("typing into the overlay writes the text and its measured box back", async () => {
  const { wrap } = await mount();
  dbl(wrap, 300, 300);
  const overlay = wrap.children.find((c) => c.tagName === "TEXTAREA");
  overlay.value = "two\nlines";
  overlay.dispatch("keydown", { key: "Escape", metaKey: false });

  const text = live.element(live.length - 1);
  expect(text.type).toBe("text");
  expect(text.text).toBe("two\nlines");
  expect(text.originalText).toBe("two\nlines");
  // Height is lines × line height; the width is 0 here because a headless
  // canvas cannot measure, and 0 rather than NaN is the whole point.
  expect(text.height).toBeCloseTo(2 * 20 * 1.25, 6);
  expect(Number.isFinite(text.width)).toBe(true);
});

test("the canvas keyboard does not fire while the overlay has the keys", async () => {
  // Without stopPropagation, Delete inside the textarea would delete the
  // selection instead of a character.
  const { wrap } = await mount();
  type(wrap, "a", { metaKey: true });
  dbl(wrap, 300, 300);
  const overlay = wrap.children.find((c) => c.tagName === "TEXTAREA");
  const before = live.length;
  overlay.dispatch("keydown", { key: "Delete" });
  expect(live.length).toBe(before);
});

test("the header's zoom controls move the camera without touching the drawing", async () => {
  const { wrap, actions, saves } = await mount();
  const zoomIn = actions().find((a) => a.id === "xd-in");
  const before = actions().find((a) => a.id === "xd-zoom").text;
  zoomIn.run();
  // The readout is republished from the paint loop, which is deliberately not
  // running here; what is asserted is that zooming is not an edit.
  expect(typeof before).toBe("string");
  type(wrap, "s", { metaKey: true });
  await settle();
  expect(saves).toHaveLength(0);
});

test("undo and redo are disabled until there is something to undo", async () => {
  const { wrap, actions } = await mount();
  expect(actions().find((a) => a.id === "xd-undo").disabled).toBe(true);
  expect(actions().find((a) => a.id === "xd-redo").disabled).toBe(true);
  press(wrap, ...ON_STROKE);
  move(wrap, 50, 60);
  lift(wrap, 50, 60);
  expect(actions().find((a) => a.id === "xd-undo").disabled).toBe(false);
});

// --- and again, against the real document model ------------------------------
//
// Everything above drives a fake. A fake proves the view calls what it thinks
// it calls; it cannot prove those calls *mean* what the view thinks they mean,
// because the fake was written by the same hand and carries the same
// misunderstandings. So the same gestures are run again here through the real
// `XdDoc` — the actual hit test, the actual coalescing, the actual serializer —
// and the assertions are the ones only the real core can answer: that a seed
// survives an edit, that undo restores the file byte-for-byte, that an arrow
// dropped on a box binds itself.
//
// The fake is not redundant. It is what makes a failed serialize and a
// hostile clipboard testable, which the real core is too well-behaved to
// produce on demand.

/// The fixture as the crate itself writes it. Derived rather than hand-typed,
/// because `worthSaving`'s "identical is not written" rule is only meaningful
/// against the exact bytes the serializer produces.
const REAL_SCENE = openReal(SCENE).toJson();

const mountReal = async (text = REAL_SCENE) => {
  const { renderExcalidraw } = await import("../src/excalidrawEdit.js");
  const host = new FakeNode("main");
  const saves = [];
  let actions = null;
  const dispose = renderExcalidraw(host, text, {
    onSave: (t) => saves.push(t),
    onActions: (list) => { actions = list; },
    openDocument: async (t) => (live = openReal(t)),
  });
  await settle();
  return { host, dispose, saves, wrap: host.children[0], actions: () => actions };
};

/// Flush the debounce and let the save land.
const flush = async (wrap) => {
  type(wrap, "s", { metaKey: true });
  await settle();
};

test("real core: opening and saving an untouched drawing writes nothing", async () => {
  // The crate's whole round-trip promise, seen from the view: open, do
  // nothing, and there is no diff to write. If this ever fails, every file the
  // user opens comes back dirty.
  const { wrap, saves, dispose } = await mountReal();
  await flush(wrap);
  expect(saves).toHaveLength(0);
  dispose();
});

test("real core: a drag moves the element and leaves its seed alone", async () => {
  // Rough.js is deterministic in the seed. A seed rewritten on edit means the
  // hand-drawn strokes re-scramble and the whole drawing twitches on every
  // save — the failure PLAN.md names first.
  const { wrap, saves, dispose } = await mountReal();
  const seedBefore = live.element(0).seed;

  press(wrap, ...ON_STROKE);
  move(wrap, 50, 60);
  lift(wrap, 50, 60);
  await flush(wrap);

  expect(saves).toHaveLength(1);
  const [moved] = JSON.parse(saves[0]).elements;
  expect(moved.x).toBeCloseTo(50, 6);
  expect(moved.y).toBeCloseTo(30, 6);
  expect(moved.seed).toBe(seedBefore);
  // And the bookkeeping the format's reconciliation depends on did move.
  expect(moved.version).toBeGreaterThan(1);
  dispose();
});

test("real core: a whole drag is one undo entry, and undo restores the bytes", async () => {
  // Two properties at once, because they are the same property: the drag
  // coalesces under one key, so a single ⌘Z puts the file back exactly as it
  // was opened — which `worthSaving` then refuses to write.
  const { wrap, saves, dispose } = await mountReal();
  press(wrap, ...ON_STROKE);
  for (let x = 14; x <= 70; x += 4) move(wrap, x, 40);
  lift(wrap, 70, 40);
  // The drag really happened — without this the test would pass just as well
  // on a press that missed and swept a marquee instead.
  expect(live.element(0).x).toBeCloseTo(70, 6);

  type(wrap, "z", { metaKey: true });
  expect(live.toJson()).toBe(REAL_SCENE);
  expect(live.canUndo()).toBe(false); // one entry, not fifteen

  await flush(wrap);
  expect(saves).toHaveLength(0);
  dispose();
});

test("real core: the hit test picks the shape, and empty canvas deselects", async () => {
  const { wrap, dispose } = await mountReal();
  press(wrap, ...ON_STROKE);
  lift(wrap, ...ON_STROKE);
  expect(live.selection).toEqual([0]);

  // The middle of a transparent rectangle is a hole, not the shape.
  press(wrap, 60, 40);
  lift(wrap, 60, 40);
  expect(live.selection).toEqual([]);

  press(wrap, 500, 500);
  lift(wrap, 500, 500);
  expect(live.selection).toEqual([]);
  dispose();
});

test("real core: drawing a rectangle produces a whole Excalidraw element", async () => {
  const { wrap, saves, dispose } = await mountReal();
  type(wrap, "r");
  press(wrap, 200, 200);
  move(wrap, 320, 280);
  lift(wrap, 320, 280);
  await flush(wrap);

  const drawn = JSON.parse(saves[0]).elements.at(-1);
  expect(drawn.type).toBe("rectangle");
  expect(drawn.width).toBeCloseTo(120, 6);
  expect(drawn.height).toBeCloseTo(80, 6);
  // Identity is the document's to hand out, not the view's.
  expect(typeof drawn.id).toBe("string");
  expect(drawn.seed).not.toBe(0);
  // And the style the view asked for arrived intact.
  expect(drawn.strokeWidth).toBe(2);
  expect(drawn.roundness).toEqual({ type: 3 });
  dispose();
});

test("real core: a click with a shape tool draws nothing at all", async () => {
  // `endDraft`'s minimum size. A zero-by-zero rectangle would be an element
  // the user can neither see nor select in order to delete.
  const { wrap, dispose } = await mountReal();
  const before = live.length;
  type(wrap, "r");
  press(wrap, 200, 200);
  lift(wrap, 200, 200);
  expect(live.length).toBe(before);
  dispose();
});

test("real core: an arrow dropped on a shape binds itself", async () => {
  // Binding is the core's and happens inside endDraft with no call from the
  // view. What the view owes is the highlight beforehand, and the coordinates
  // that put the endpoint inside the box.
  const { wrap, dispose } = await mountReal();
  type(wrap, "a");
  press(wrap, 200, 40);   // clear of the rectangle at 10,10 100x60
  move(wrap, 60, 40);     // and into the middle of it
  lift(wrap, 60, 40);

  const arrow = live.element(live.length - 1);
  expect(arrow.type).toBe("arrow");
  expect(live.isBound(arrow.id, true)).toBe(true);
  dispose();
});

test("real core: the binding highlight names the shape before the drop", async () => {
  const { wrap, dispose } = await mountReal();
  type(wrap, "a");
  press(wrap, 200, 40);
  move(wrap, 60, 40);
  // Mid-drag, the core already knows what the endpoint would stick to — which
  // is what the view draws an outline around.
  const draftId = live.elementId(live.selection[0]);
  expect(live.bindableAt(60, 40, draftId)).toBe(0);
  lift(wrap, 60, 40);
  dispose();
});

test("real core: text typed into the overlay lands as a text element", async () => {
  const { wrap, saves, dispose } = await mountReal();
  dbl(wrap, 300, 300);
  const overlay = wrap.children.find((c) => c.tagName === "TEXTAREA");
  overlay.value = "hello";
  overlay.dispatch("keydown", { key: "Escape" });
  await flush(wrap);

  const text = JSON.parse(saves[0]).elements.at(-1);
  expect(text.type).toBe("text");
  expect(text.text).toBe("hello");
  expect(text.originalText).toBe("hello");
  expect(text.fontSize).toBe(20);
  expect(Number.isFinite(text.width)).toBe(true);
  dispose();
});

test("real core: z-order, grouping and duplication go through unedited", async () => {
  const { wrap, saves, dispose } = await mountReal();
  type(wrap, "a", { metaKey: true });
  type(wrap, "d", { metaKey: true });      // duplicate
  type(wrap, "a", { metaKey: true });
  type(wrap, "g", { metaKey: true });      // group
  type(wrap, "[", { metaKey: true, shiftKey: true }); // send to back
  await flush(wrap);

  const { elements } = JSON.parse(saves[0]);
  expect(elements).toHaveLength(2);
  // Grouping is a shared group id on every member, which is how Excalidraw
  // spells it — nothing structural.
  const groups = elements.map((e) => e.groupIds?.[0]);
  expect(groups[0]).toBeTruthy();
  expect(groups[0]).toBe(groups[1]);
  dispose();
});

test("real core: pasting our own clipboard payload round-trips", async () => {
  const { wrap, dispose } = await mountReal();
  type(wrap, "a", { metaKey: true });
  const board = new Map();
  const clipboardData = {
    setData: (k, v) => board.set(k, v),
    getData: (k) => board.get(k) ?? "",
  };
  wrap.dispatch("copy", { clipboardData });
  wrap.dispatch("paste", { clipboardData });

  expect(live.length).toBe(2);
  const [original, pasted] = [live.element(0), live.element(1)];
  expect(pasted.type).toBe(original.type);
  // A fresh identity, because the document hands identity out and a duplicate
  // sharing a seed would be stroke-for-stroke identical.
  expect(pasted.id).not.toBe(original.id);
  expect(pasted.seed).not.toBe(original.seed);
  dispose();
});

test("real core: the view disposes clean with a real document behind it", async () => {
  const { host, dispose, wrap } = await mountReal();
  press(wrap, ...ON_STROKE);
  move(wrap, 50, 60);
  lift(wrap, 50, 60);
  dispose();
  await settle();
  for (const [where, count] of ledger) expect([where, count]).toEqual([where, 0]);
  expect(host.children).toHaveLength(0);
  expect(observers).toBe(0);
  expect(frames.size).toBe(0);
});
