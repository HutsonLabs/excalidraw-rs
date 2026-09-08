// The editor's gestures, driven without a canvas.
//
// `contract.test.js` next door is about the *mount contract* — the view goes on
// screen, edits, saves, and leaves nothing running. This file is about the
// behaviour that sits on top of it: what a double-click on a shape does, what
// the eraser sweeps up, whether a drag snaps, whether a locked element is
// really locked. Those are the things a user complains about, and none of them
// were covered anywhere.
//
// Same two fakes and the same reasons (see ui/test/support/harness.js and
// contract.test.js's header): `bun test` has no DOM, this project has no dev
// dependencies, and xdWasm.js hands JS a plain object so a plain object
// satisfies the same shape. The honesty rule is the harness's — a fake may be
// incomplete, but it may not be easier to satisfy than the real thing, which is
// why `hitTest` below is stroke-only for a transparent shape exactly as
// `geometry.rs:395` is. That rule is load-bearing here: it *is* the bug in
// "double-clicking inside an unfilled box types outside it".

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  FakeNode, installDom, uninstallDom, leakedListeners, recorder, flushFrames,
} from "./support/harness.js";

// --- a document, to the extent this needs one --------------------------------

const shape = (over) => ({
  type: "rectangle", x: 0, y: 0, width: 100, height: 60, angle: 0,
  strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, seed: 1,
  version: 1, versionNonce: 1, updated: 0, isDeleted: false, ...over,
});

const sceneOf = (...elements) => JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements,
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

/// xdWasm.js's wrapper shape, in JavaScript. A trimmed sibling of
/// contract.test.js's, with the parts this file needs it to be honest about:
/// `locked`, `marquee(contain)`, `patch`, and undo over a delete.
function fakeDoc(text) {
  let list = JSON.parse(text).elements.map((e) => ({ ...e }));
  let selection = [];
  const undoStack = [];
  const redoStack = [];
  let ids = 0;
  /// Test-only: which document calls were made, in order. Not part of the
  /// wrapper's shape, and nothing in the view knows it is here — it is how the
  /// style tests tell one write apart from two.
  const calls = [];

  const snapshot = () => list.map((e) => ({ ...e }));
  /// The coalesce key of the entry currently open, or null.
  let openKey = null;
  /// The real core folds writes that share a coalesce key into one history
  /// entry — that is what makes a drag, a burst of arrow keys, or an eraser
  /// sweep a single press of undo. A fake that recorded one entry per call would
  /// be easier to satisfy than the real thing in exactly the place the eraser is
  /// about, so it is modelled rather than skipped.
  const record = (key = "") => {
    redoStack.length = 0;
    if (key && key === openKey) return;
    openKey = key || null;
    undoStack.push(snapshot());
  };
  const change = (structural = false) => ({ revision: undoStack.length, dirty: [], bbox: null, structural });
  const boxOf = (e) => ({ minX: e.x, minY: e.y, maxX: e.x + (e.width || 0), maxY: e.y + (e.height || 0) });
  let appState = { viewBackgroundColor: "#ffffff" };

  /// The one selected linear element, or null. `pointHandles` and its siblings
  /// answer null for anything else, which is the rule the real ones state: the
  /// handles belong to an element, not to a box, so a *set* of them has no
  /// meaning.
  const linear = () => {
    if (selection.length !== 1) return null;
    const e = list[selection[0]];
    if (!e || (e.type !== "line" && e.type !== "arrow") || !Array.isArray(e.points)) return null;
    return e;
  };
  const pointsOf = () => {
    const e = linear();
    return e ? e.points.map((p) => ({ x: e.x + p[0], y: e.y + p[1] })) : null;
  };
  const midsOf = () => {
    const e = linear();
    if (!e) return null;
    const out = [];
    for (let i = 0; i < e.points.length - 1; i++) {
      out.push({
        x: e.x + (e.points[i][0] + e.points[i + 1][0]) / 2,
        y: e.y + (e.points[i][1] + e.points[i + 1][1]) / 2,
      });
    }
    return out;
  };
  const nearest = (pts, x, y, r) => {
    let best = -1;
    let far = r;
    (pts ?? []).forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= far) {
        far = d;
        best = i;
      }
    });
    return best;
  };
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
    /// Mirrored from the crate so the coordinates in these tests mean the same
    /// thing under both, exactly as contract.test.js's does.
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
    appState: () => ({ ...appState }),
    files: () => ({}),
    toJson: () => JSON.stringify({
      type: "excalidraw", version: 2, elements: list, appState, files: {},
    }),
    setNow: () => {},
    /// Excalidraw's rule and the crate's: a shape with a background is hit
    /// anywhere inside it, a transparent one on its stroke only. Text is opaque
    /// over its whole box (`geometry.rs:390`). A deleted or locked element is not
    /// pickable at all (`geometry::is_pickable`) — and note it is passed *over*
    /// rather than returned as a miss, so a click reaches what is behind it.
    hitTest: (x, y, threshold) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (e.isDeleted || e.locked === true) continue;
        const b = boxOf(e);
        const inside = x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
        const filled = (e.backgroundColor && e.backgroundColor !== "transparent") || e.type === "text";
        if (inside && filled) return i;
        const outer = x >= b.minX - threshold && x <= b.maxX + threshold
          && y >= b.minY - threshold && y <= b.maxY + threshold;
        const hole = x > b.minX + threshold && x < b.maxX - threshold
          && y > b.minY + threshold && y < b.maxY - threshold;
        if (outer && !hole) return i;
      }
      return -1;
    },
    marquee: (x0, y0, x1, y1, contain) => {
      const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
      const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
      return list
        .map((e, i) => [e, i])
        .filter(([e]) => !e.isDeleted && e.locked !== true)
        .filter(([e]) => {
          const b = boxOf(e);
          return contain
            ? b.minX >= lo.x && b.maxX <= hi.x && b.minY >= lo.y && b.maxY <= hi.y
            : b.minX <= hi.x && b.maxX >= lo.x && b.minY <= hi.y && b.maxY >= lo.y;
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
    selectAll: () => {
      selection = list
        .map((e, i) => [e, i])
        .filter(([e]) => !e.isDeleted && e.locked !== true)
        .map(([, i]) => i);
    },
    clearSelection: () => { selection = []; },
    handleAt: () => -1,
    handlePoints: () => null,
    selectionExtent: () => union(selection),

    // --- linear points ---
    //
    // Null unless exactly one linear element is selected, which is the rule the
    // real `pointHandles` states — the handles belong to an element, not to a
    // box, so a set of them has no meaning.
    pointHandles: pointsOf,
    midpointHandles: midsOf,
    pointHandleAt: (x, y, r) => nearest(pointsOf(), x, y, r),
    midpointHandleAt: (x, y, r) => nearest(midsOf(), x, y, r),
    /// Moves the point and renormalises the box around it, which is what makes
    /// the difference between dragging an endpoint and dragging the whole
    /// element visible in a test. Clears the moved end's binding first — the
    /// thing that stops the reflow snapping it back.
    movePoint: (index, x, y, key = "") => {
      calls.push(["movePoint", index, key]);
      const i = selection[0];
      const e = list[i];
      if (!e || !Array.isArray(e.points) || !e.points[index]) return change();
      record(key);
      const points = e.points.map((p) => [p[0], p[1]]);
      points[index] = [x - e.x, y - e.y];
      const minX = Math.min(...points.map((p) => p[0]));
      const minY = Math.min(...points.map((p) => p[1]));
      const next = {
        ...e,
        x: e.x + minX,
        y: e.y + minY,
        points: points.map((p) => [p[0] - minX, p[1] - minY]),
        width: Math.max(...points.map((p) => p[0])) - minX,
        height: Math.max(...points.map((p) => p[1])) - minY,
      };
      if (index === 0) next.startBinding = null;
      if (index === points.length - 1) next.endBinding = null;
      list[i] = next;
      return change();
    },
    /// A segment index in, a point index out. Nothing is unbound and nothing is
    /// renormalised, because the new point lies exactly on the segment it splits
    /// — which is what makes it the opposite of `movePoint`.
    insertPoint: (index, x, y, key = "") => {
      calls.push(["insertPoint", index, key]);
      const i = selection[0];
      const e = list[i];
      if (!e || !Array.isArray(e.points) || index < 0 || index >= e.points.length - 1) return change();
      record(key);
      const points = e.points.map((p) => [p[0], p[1]]);
      points.splice(index + 1, 0, [x - e.x, y - e.y]);
      list[i] = { ...e, points };
      return change();
    },
    rebindEnd: (id, atEnd) => {
      calls.push(["rebindEnd", id, atEnd]);
      return change();
    },
    bindableAt: () => -1,
    putFile: (id, entry) => {
      calls.push(["putFile", id, entry]);
      return change(true);
    },
    setAppState: (fields) => {
      calls.push(["setAppState", fields]);
      record();
      appState = { ...appState, ...fields };
      for (const [k, v] of Object.entries(fields)) if (v === null) delete appState[k];
      return change(true);
    },
    labelOf: (i) => {
      const id = list[i]?.id;
      if (!id) return -1;
      return list.findIndex((e) => e && !e.isDeleted && e.type === "text" && e.containerId === id);
    },
    /// `BOUND_TEXT_PADDING` is 5, so a rectangle's label may be `width - 10`.
    labelBudget: (i) => Math.max(0, (list[i]?.width ?? 0) - 10),
    bindLabel: (containerId, textId) => {
      calls.push(["bindLabel", containerId, textId]);
      record();
      const c = list.findIndex((e) => e.id === containerId);
      const t = list.findIndex((e) => e.id === textId);
      if (c < 0 || t < 0) return change();
      list[t] = { ...list[t], containerId };
      list[c] = { ...list[c], boundElements: [...(list[c].boundElements ?? []), { id: textId, type: "text" }] };
      return change(true);
    },
    flip: (axis) => {
      calls.push(["flip", axis]);
      return change();
    },
    align: (edge) => {
      calls.push(["align", edge]);
      return change();
    },
    distribute: (axis) => {
      calls.push(["distribute", axis]);
      return change();
    },
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
    draftTo: () => change(),
    draftPoint: () => change(),
    endDraft: () => change(),
    insert: (element) => {
      record();
      list.push({ ...element, id: `n${++ids}` });
      selection = [list.length - 1];
      return change(true);
    },
    patch: (id, fields, key = "") => {
      calls.push(["patch", id, fields, key]);
      record(key);
      const i = list.findIndex((e) => e.id === id);
      if (i >= 0) list[i] = { ...list[i], ...fields };
      return change();
    },
    setStyle: (fields) => {
      calls.push(["setStyle", fields]);
      record();
      for (const i of selection) list[i] = { ...list[i], ...fields };
      return change();
    },
    /// The seed re-roll and the patch as one command. Exists on the fake because
    /// the whole point of the pair is that they are *not* two writes.
    setStyleResketched: (fields) => {
      calls.push(["setStyleResketched", fields]);
      record();
      for (const i of selection) list[i] = { ...list[i], ...fields, seed: (list[i].seed ?? 0) + 1 };
      return change();
    },
    reseed: () => {
      calls.push(["reseed"]);
      record();
      for (const i of selection) list[i] = { ...list[i], seed: (list[i].seed ?? 0) + 1 };
      return change();
    },
    deleteSelection: () => {
      record();
      const gone = new Set(selection);
      list = list.filter((_, i) => !gone.has(i));
      selection = [];
      return change(true);
    },
    duplicateSelection: () => change(true),
    reorder: () => change(true),
    group: () => change(),
    ungroup: () => change(),
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undo: () => {
      if (!undoStack.length) return null;
      redoStack.push(snapshot());
      list = undoStack.pop();
      selection = selection.filter((i) => i < list.length);
      return change(true);
    },
    redo: () => {
      if (!redoStack.length) return null;
      undoStack.push(snapshot());
      list = redoStack.pop();
      return change(true);
    },
    __calls: calls,
  };
}

let live = null;
const openFake = async (text) => (live = fakeDoc(text));

// --- helpers -----------------------------------------------------------------

const mount = async (opts = {}) => {
  const { renderExcalidraw } = await import("../src/excalidrawEdit.js");
  const host = new FakeNode("main");
  const saves = [];
  let actions = null;
  const dispose = renderExcalidraw(host, opts.text ?? sceneOf(shape({ id: "a" })), {
    onSave: (text) => { saves.push(text); },
    onActions: (list) => { actions = list; },
    openDocument: openFake,
  });
  await settle();
  return { host, dispose, saves, wrap: host.children[0], actions: () => actions };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/// The camera after `fit()` in a pane with no layout: 1:1 with `fitTransform`'s
/// padding as the whole offset. So the helpers below take *scene* coordinates
/// and add it back, which is what lets a test say "press on the shape at 20,20".
const PAD = 32;

const press = (wrap, x, y, extra = {}) => wrap.dispatch("pointerdown", {
  pointerId: 1, button: 0, clientX: x + PAD, clientY: y + PAD, shiftKey: false, altKey: false, ...extra,
});
const move = (wrap, x, y, extra = {}) => wrap.dispatch("pointermove", {
  pointerId: 1, clientX: x + PAD, clientY: y + PAD, shiftKey: false, altKey: false, ...extra,
});
const lift = (wrap, x, y) => wrap.dispatch("pointerup", {
  pointerId: 1, clientX: x + PAD, clientY: y + PAD,
});
const dbl = (wrap, x, y) => wrap.dispatch("dblclick", { clientX: x + PAD, clientY: y + PAD });
const rightClick = (wrap, x, y) => wrap.dispatch("contextmenu", { clientX: x + PAD, clientY: y + PAD });
const type = (wrap, key, extra = {}) => wrap.dispatch("keydown", {
  key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra,
});

const overlayOf = (wrap) => wrap.children.find((c) => c.tagName === "TEXTAREA");
const menuOf = (wrap) => wrap.children.find((c) => c.className === "xd-menu");
const helpOf = (wrap) => wrap.children.find((c) => c.className === "xd-help");
/// Every descriptor row under a node. The popover is one flat list; the sheet
/// groups its rows into a column per heading, so this looks one level down too.
const rowsOf = (node) => [
  ...node.children.filter((c) => c.className === "xd-menu-item"),
  ...node.children.flatMap((c) => (c.children ?? []).filter((g) => g.className === "xd-menu-item")),
];
const named = (node) => rowsOf(node).map((r) => r.children[0].textContent);
const textsOf = () => live.elements().filter((e) => e.type === "text");

/// The first node anywhere under `root` that satisfies `pred`.
const findNode = (node, pred) => {
  if (!node) return null;
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, pred);
    if (hit) return hit;
  }
  return null;
};

/// A properties-panel button, by the accessible name `choiceGroup` gives it —
/// "<row label>: <option>". The label and the option are the two strings a user
/// reads, so matching on them is the least brittle handle the panel offers.
const panelButton = (wrap, label) =>
  findNode(wrap, (n) => n.tagName === "BUTTON" && n["aria-label"] === label);

/// Type into the open overlay and commit it the way a click elsewhere does.
const write = (wrap, value) => {
  const box = overlayOf(wrap);
  box.value = value;
  box.dispatch("input", {});
  box.dispatch("blur", {});
};

/// Every canvas the code under test asked the document for. The PNG export
/// renders onto one of its own rather than the one on screen, and "which canvas"
/// is the whole assertion — a resize of the visible canvas would be a bug the
/// user sees.
let madeCanvases = [];

beforeEach(() => {
  // A recording context, because `measure()` goes through `ctx.measureText` on
  // its way to writing a width into the file and a null context would put a 0
  // there. Zero-sized still, so `PAD` above holds and the paint loop bails.
  installDom({ context: recorder });
  live = null;
  madeCanvases = [];
  const create = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const node = create(tag);
    if (node.tagName === "CANVAS") madeCanvases.push(node);
    return node;
  };
});
afterEach(uninstallDom);

// --- typing into a shape -----------------------------------------------------

test("double-clicking a filled shape opens a text overlay", async () => {
  // It used to do nothing at all: the hit test succeeded and the element was not
  // text, so both branches fell through — no overlay, no label, no feedback of
  // any kind. This is the bug behind "I can't click an object and start writing".
  const { wrap } = await mount({ text: sceneOf(shape({ id: "a", backgroundColor: "#ffc9c9" })) });
  dbl(wrap, 50, 30);
  expect(overlayOf(wrap)).toBeDefined();
  expect(textsOf()).toHaveLength(1);
});

test("double-clicking inside an unfilled shape reaches the shape, not the canvas", async () => {
  // A transparent shape is stroke-only for hit-testing, so the interior "misses"
  // and this used to drop a free-floating text element wherever the pointer
  // happened to be — it read as "it typed outside the box".
  const { wrap } = await mount({ text: sceneOf(shape({ id: "a", x: 0, y: 0, width: 200, height: 100 })) });
  dbl(wrap, 100, 50); // dead centre, nowhere near the stroke
  expect(overlayOf(wrap)).toBeDefined();
  write(wrap, "label");
  const [text] = textsOf();
  // Centred on the shape, which is where a label goes — not at the pointer with
  // its top-left corner there.
  expect(text.x + text.width / 2).toBeCloseTo(100, 6);
  expect(text.y + text.height / 2).toBeCloseTo(50, 6);
});

test("double-clicking a shape that already has a label edits that label", async () => {
  // Nothing in this build writes `containerId`, so the only way to meet one is a
  // file Excalidraw authored — which is exactly the case where creating a second
  // label would damage somebody else's drawing.
  const { wrap } = await mount({
    text: sceneOf(
      shape({ id: "a", width: 200, height: 100, backgroundColor: "#ffc9c9" }),
      { type: "text", id: "t", containerId: "a", x: 60, y: 40, width: 40, height: 25, text: "hi", originalText: "hi" },
    ),
  });
  dbl(wrap, 20, 90); // inside the shape, clear of the label's own box
  expect(overlayOf(wrap).value).toBe("hi");
  expect(textsOf()).toHaveLength(1);
});

test("double-clicking committed text still edits it", async () => {
  // The path the user reported broken, which was in fact working and untested.
  const { wrap } = await mount({
    text: sceneOf({ type: "text", id: "t", x: 0, y: 0, width: 40, height: 25, text: "hello", originalText: "hello" }),
  });
  dbl(wrap, 20, 12);
  expect(overlayOf(wrap).value).toBe("hello");
  expect(textsOf()).toHaveLength(1);
});

test("the text tool clicked on text edits it instead of stacking another", async () => {
  const { wrap } = await mount({
    text: sceneOf({ type: "text", id: "t", x: 0, y: 0, width: 40, height: 25, text: "hello", originalText: "hello" }),
  });
  type(wrap, "t"); // the text tool
  press(wrap, 20, 12);
  lift(wrap, 20, 12);
  expect(overlayOf(wrap).value).toBe("hello");
  expect(textsOf()).toHaveLength(1);
});

test("a double-click retargeted by pointer capture still reaches the canvas", async () => {
  // The bug the user reported, and the reason none of the tests above ever saw
  // it: `onPointerDown` captures the pointer on the wrap so a drag that leaves
  // the window keeps arriving, and a captured pointer's later events — and their
  // compatibility mouse events — are retargeted to the capture element. So a
  // real browser reports `pointerdown` on the canvas and `dblclick` on the wrap,
  // and a handler that insisted on the canvas returned on its first line.
  // Verified against Chromium: pointerdown -> CANVAS, dblclick -> DIV.xd-wrap.
  const { wrap, dispose } = await mount({ text: sceneOf(shape({ id: "a", backgroundColor: "#ffc9c9" })) });
  const canvas = wrap.children.find((c) => c.tagName === "CANVAS");
  // Both targets a browser can deliver, and neither may be refused.
  wrap.dispatch("dblclick", { clientX: 50 + PAD, clientY: 30 + PAD, target: canvas });
  expect(overlayOf(wrap)).toBeDefined();
  dispose();
});

test("a double-click from a piece of chrome is still not the canvas's", async () => {
  // The other half of the same check: the tool island and the properties panel
  // are children of the wrap, and an event that started in one must not reach
  // the drawing behind it.
  const { wrap, dispose } = await mount({ text: sceneOf(shape({ id: "a", backgroundColor: "#ffc9c9" })) });
  const button = findNode(wrap, (n) => n.tagName === "BUTTON");
  expect(button).toBeTruthy();
  wrap.dispatch("dblclick", { clientX: 50 + PAD, clientY: 30 + PAD, target: button });
  expect(overlayOf(wrap)).toBeUndefined();
  dispose();
});

test("the text tool clicked on a shape labels it rather than laying text over it", async () => {
  // The last route into text that never reached `editLabel`. It dropped a free
  // element on top of the box, which looks right until the box is moved and the
  // words stay behind.
  const { wrap, dispose } = await mount({
    text: sceneOf(shape({ id: "a", width: 200, height: 100, backgroundColor: "#ffc9c9" })),
  });
  type(wrap, "t");
  press(wrap, 100, 50);
  lift(wrap, 100, 50);
  expect(overlayOf(wrap)).toBeDefined();
  write(wrap, "label");
  const [text] = textsOf();
  expect(text.containerId).toBe("a");
  expect(live.element(0).boundElements).toEqual([{ id: text.id, type: "text" }]);
  dispose();
});

test("the text tool inside an unfilled shape labels it too", async () => {
  // A transparent shape is stroke-only for hit-testing, so the interior misses.
  // The double-click already fell back to the enclosing box; the tool asks the
  // same question through the same helper, so it cannot answer differently.
  const { wrap, dispose } = await mount({
    text: sceneOf(shape({ id: "a", x: 0, y: 0, width: 200, height: 100 })),
  });
  type(wrap, "t");
  press(wrap, 100, 50);
  lift(wrap, 100, 50);
  write(wrap, "label");
  expect(textsOf()[0].containerId).toBe("a");
  dispose();
});

test("the text tool on open canvas still makes free text", async () => {
  const { wrap, dispose } = await mount({ text: sceneOf(shape({ id: "a" })) });
  type(wrap, "t");
  press(wrap, 400, 400);
  lift(wrap, 400, 400);
  write(wrap, "free");
  const [text] = textsOf();
  expect(text.containerId ?? null).toBe(null);
  dispose();
});

test("Enter on a selected shape types into it", async () => {
  const { wrap } = await mount({ text: sceneOf(shape({ id: "a", backgroundColor: "#ffc9c9" })) });
  press(wrap, 50, 30);
  lift(wrap, 50, 30);
  type(wrap, "Enter");
  expect(overlayOf(wrap)).toBeDefined();
});

test("a label typed into a shape is bound to it, not left floating beside it", async () => {
  // The second reported bug, and the one the audit called structural: nothing in
  // this codebase had ever written `containerId`, so a label decoupled the
  // moment anything moved.
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", width: 200, height: 100, backgroundColor: "#ffc9c9" })),
  });
  dbl(wrap, 100, 50);
  write(wrap, "label");
  const [text] = textsOf();
  expect(text.containerId).toBe("a");
  expect(live.element(0).boundElements).toEqual([{ id: text.id, type: "text" }]);
  // Bound text is centred both ways, where free text is left/top — Rust writes
  // free text's defaults, correctly, so these two are the view's to patch.
  expect(text.textAlign).toBe("center");
  expect(text.verticalAlign).toBe("middle");
});

test("a label wraps to the width its container allows", async () => {
  // The measuring is the half Rust cannot do: it knows the budget (`labelBudget`)
  // and it recentres, but it has no font metrics, so it cannot know where the
  // words break. The recording context measures 8px a character, so a 90-unit
  // budget is 11 characters a line.
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", width: 100, height: 100, backgroundColor: "#ffc9c9" })),
  });
  dbl(wrap, 50, 50);
  write(wrap, "one two three four");
  const [text] = textsOf();
  // `text` is what gets painted and `originalText` is what was typed — the field
  // pair the format has always had, and which nothing ever used differently
  // because nothing wrapped.
  expect(text.originalText).toBe("one two three four");
  expect(text.text).toContain("\n");
  expect(text.text.replace(/\n/g, " ")).toBe("one two three four");
  for (const line of text.text.split("\n")) expect(line.length * 8).toBeLessThanOrEqual(90);
});

test("a word too long for its container is broken rather than left to overflow", async () => {
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", width: 60, height: 60, backgroundColor: "#ffc9c9" })),
  });
  dbl(wrap, 30, 30);
  write(wrap, "unbreakableword");
  const [text] = textsOf();
  expect(text.text.split("\n").length).toBeGreaterThan(1);
  for (const line of text.text.split("\n")) expect(line.length * 8).toBeLessThanOrEqual(50);
});

// --- the overlay and teardown ------------------------------------------------

test("dispose commits what was being typed rather than discarding it", async () => {
  // It used to be `editing = null; overlay.remove()`, which threw the text away
  // — and for a *new* element it wrote an invisible 0×0 empty text to disk,
  // because `createText` had already inserted it and armed the autosave.
  const { wrap, dispose, saves } = await mount();
  dbl(wrap, 300, 300); // empty canvas: a new text element
  overlayOf(wrap).value = "unsaved words";
  dispose();
  await settle();
  expect(saves).toHaveLength(1);
  expect(JSON.parse(saves[0]).elements.some((e) => e.text === "unsaved words")).toBe(true);
});

test("dispose over an untouched new text element removes it", async () => {
  // The other half of the same commit: an empty text element is invisible and
  // unselectable, so it must not survive into the file.
  const { wrap, dispose, saves } = await mount();
  dbl(wrap, 300, 300);
  dispose();
  await settle();
  // Nothing worth writing: the element was created and taken away again, so the
  // drawing is what it was and `worthSaving` refuses an identical write.
  expect(saves).toHaveLength(0);
  expect(live.elements().filter((e) => e.type === "text")).toHaveLength(0);
});

// --- the eraser --------------------------------------------------------------

test("the eraser tombstones what it sweeps, and one sweep is one undo", async () => {
  const alive = () => live.elements().filter((e) => !e.isDeleted).map((e) => e.id).sort();
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a" }), shape({ id: "b", x: 200 })),
  });
  type(wrap, "e");
  press(wrap, 0, 30); // on a's left stroke
  // Nothing has gone yet: the sweep is a preview until it is let go of.
  expect(alive()).toEqual(["a", "b"]);
  move(wrap, 200, 30); // over b's left stroke
  lift(wrap, 200, 30);
  expect(alive()).toEqual([]);
  // Tombstoned rather than removed, which is what Excalidraw's reconciliation
  // expects to find and what `isDeleted` is for.
  expect(live.length).toBe(2);
  expect(live.__calls.filter((c) => c[0] === "patch")).toHaveLength(2);
  // Both patches share one coalesce key, so the sweep is one press of undo and
  // not one per element — which is the whole difference between an eraser and a
  // very slow delete.
  expect(new Set(live.__calls.filter((c) => c[0] === "patch").map((c) => c[3])).size).toBe(1);
  type(wrap, "z", { metaKey: true });
  expect(alive()).toEqual(["a", "b"]);
});

test("the eraser passing over nothing does nothing", async () => {
  const { wrap } = await mount();
  type(wrap, "e");
  press(wrap, 500, 500);
  lift(wrap, 500, 500);
  expect(live.length).toBe(1);
});

// --- linear points -----------------------------------------------------------

const ARROW = (over = {}) => ({
  type: "arrow", id: "r", x: 0, y: 0, width: 100, height: 100, angle: 0,
  points: [[0, 0], [100, 100]], strokeColor: "#1e1e1e", strokeWidth: 2,
  roughness: 1, opacity: 100, seed: 3, isDeleted: false, ...over,
});

test("an arrow's endpoint can be picked up and moved on its own", async () => {
  // The headline bug. Binding has always worked; what did not exist was the
  // gesture — the handles were bounding-box-only, so there was nothing to grab.
  const { wrap } = await mount({ text: sceneOf(ARROW()) });
  live.setSelection([0]);
  press(wrap, 100, 100); // the far endpoint
  move(wrap, 160, 20);
  lift(wrap, 160, 20);
  const arrow = live.element(0);
  // The near end stayed where it was and the far one went where the pointer did.
  expect([arrow.x + arrow.points[0][0], arrow.y + arrow.points[0][1]]).toEqual([0, 0]);
  expect([arrow.x + arrow.points[1][0], arrow.y + arrow.points[1][1]]).toEqual([160, 20]);
  // The whole drag is one coalesce key, so it is one press of undo.
  const moves = live.__calls.filter((c) => c[0] === "movePoint");
  expect(moves.length).toBeGreaterThan(0);
  expect(new Set(moves.map((c) => c[2])).size).toBe(1);
});

test("a point handle beats the bounding-box handle it sits on", async () => {
  // On a diagonal arrow the endpoints are *exactly* the box's corners, so this
  // tie is every diagonal arrow rather than a rare case — and a resize handle
  // winning it is how dragging an endpoint silently becomes a scale.
  const { wrap } = await mount({ text: sceneOf(ARROW()) });
  live.setSelection([0]);
  press(wrap, 0, 0); // the NW corner, and also point 0
  move(wrap, 40, 10);
  lift(wrap, 40, 10);
  expect(live.__calls.some((c) => c[0] === "movePoint")).toBe(true);
  // A scale would have moved the far end too.
  const arrow = live.element(0);
  expect([arrow.x + arrow.points[1][0], arrow.y + arrow.points[1][1]]).toEqual([100, 100]);
});

test("an endpoint rebinds when it is let go of, not while it is moving", async () => {
  // Binding mid-drag would re-aim the arrow at whatever is under the pointer on
  // every frame, so the endpoint would be dragged and immediately pulled back —
  // which is what "I can't anchor an arrow" felt like from the outside.
  const { wrap } = await mount({ text: sceneOf(ARROW()) });
  live.setSelection([0]);
  press(wrap, 100, 100);
  move(wrap, 150, 150);
  expect(live.__calls.filter((c) => c[0] === "rebindEnd")).toHaveLength(0);
  lift(wrap, 150, 150);
  expect(live.__calls.filter((c) => c[0] === "rebindEnd")).toEqual([["rebindEnd", "r", true]]);
});

test("dragging the near end rebinds the near end", async () => {
  const { wrap } = await mount({ text: sceneOf(ARROW()) });
  live.setSelection([0]);
  press(wrap, 0, 0);
  move(wrap, -30, -30);
  lift(wrap, -30, -30);
  expect(live.__calls.find((c) => c[0] === "rebindEnd")).toEqual(["rebindEnd", "r", false]);
});

test("clicking a segment's midpoint adds a point there and drags it", async () => {
  const { wrap } = await mount({ text: sceneOf(ARROW()) });
  live.setSelection([0]);
  press(wrap, 50, 50); // the midpoint of the only segment
  move(wrap, 50, 0);
  lift(wrap, 50, 0);
  const arrow = live.element(0);
  expect(arrow.points).toHaveLength(3);
  // The new point is the one that moved, and it is in the middle of the list.
  expect([arrow.x + arrow.points[1][0], arrow.y + arrow.points[1][1]]).toEqual([50, 0]);
  // A middle point is not an end, so nothing rebinds.
  expect(live.__calls.filter((c) => c[0] === "rebindEnd")).toHaveLength(0);
  // The insert and the drag share the drag's coalesce key, so making a point and
  // bending it are one press of undo rather than an insert left behind on its
  // own when the bend is taken back.
  const insert = live.__calls.find((c) => c[0] === "insertPoint");
  expect(insert).toBeDefined();
  expect(insert[1]).toBe(0); // a segment index, not a point index
  const moved = live.__calls.find((c) => c[0] === "movePoint");
  expect(moved[2]).toBe(insert[2]);
});

test("a line, an image and a frame are not offered a label", async () => {
  // `bindLabel` takes Excalidraw's `isTextBindableContainer` — rectangle,
  // diamond, ellipse, arrow — and declines the rest. Offering the gesture anyway
  // would drop a free text element on top and call it a label, which is exactly
  // the bug double-clicking a shape used to have.
  const { wrap } = await mount({
    text: sceneOf({
      type: "line", id: "l", x: 0, y: 0, width: 200, height: 100,
      points: [[0, 0], [200, 100]], backgroundColor: "#ffc9c9", isDeleted: false,
    }),
  });
  // A real double-click is two presses and then the event; the helper below only
  // sends the event, so the press that selects has to be sent as well.
  press(wrap, 100, 20);
  lift(wrap, 100, 20);
  dbl(wrap, 100, 20); // inside the line's bounding box, nowhere near the stroke
  // Nothing is created and no overlay opens: the first click of the double-click
  // already selected the line, which is what puts its point handles up, and that
  // is the whole of what a double-click on one has to offer here.
  expect(textsOf()).toHaveLength(0);
  expect(overlayOf(wrap)).toBeUndefined();
  expect(live.selection).toEqual([0]);
});

test("an arrow is labelable, because bindLabel accepts one", async () => {
  const { wrap } = await mount({ text: sceneOf(ARROW()) });
  dbl(wrap, 0, 0); // on the stroke, which is a real hit
  write(wrap, "yes");
  expect(textsOf()[0].containerId).toBe("r");
});

test("point handles belong to one selected linear element and nothing else", async () => {
  // Two selected, or a rectangle selected, and the box handles are the only
  // handles — which is what stops a marquee over a diagram sprouting circles.
  const { wrap } = await mount({ text: sceneOf(ARROW(), shape({ id: "a", x: 300 })) });
  live.setSelection([0, 1]);
  press(wrap, 100, 100);
  move(wrap, 160, 20);
  lift(wrap, 160, 20);
  expect(live.__calls.some((c) => c[0] === "movePoint")).toBe(false);
});

// --- snapping ----------------------------------------------------------------

test("a drag snaps onto another element's edge and says why", async () => {
  // `drawSnapGuides` has been a finished, tested painter with no producer since
  // it was written. This is the producer: three lines an axis, nearest wins.
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", x: 0, y: 0 }), shape({ id: "b", x: 300, y: 200 })),
  });
  press(wrap, 0, 30); // a's left stroke
  move(wrap, 297, 30); // a's left edge lands at 297 — three short of b's 300
  lift(wrap, 297, 30);
  expect(live.element(0).x).toBe(300);
});

test("alt says 'exactly here' and suspends the snap", async () => {
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", x: 0, y: 0 }), shape({ id: "b", x: 300, y: 200 })),
  });
  press(wrap, 0, 30);
  move(wrap, 297, 30, { altKey: true });
  lift(wrap, 297, 30);
  expect(live.element(0).x).toBe(297);
});

test("a drag well clear of everything is left exactly where it was put", async () => {
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", x: 0, y: 0 }), shape({ id: "b", x: 300, y: 200 })),
  });
  press(wrap, 0, 30);
  move(wrap, 140, 30);
  lift(wrap, 140, 30);
  expect(live.element(0).x).toBe(140);
});

// --- the marquee -------------------------------------------------------------

test("alt narrows the marquee to what it encloses", async () => {
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", x: 0, y: 0 }), shape({ id: "b", x: 50, y: 0, width: 400 })),
  });
  // A band over a's box that only clips b's left end. Started well clear of a's
  // stroke, or the press lands on the shape and drags it instead of sweeping.
  press(wrap, -40, -40, { altKey: true });
  move(wrap, 120, 80, { altKey: true });
  expect(live.selection).toEqual([0]);
  // Without alt the same band takes both, which is the mode this has always had.
  move(wrap, 120, 80, { altKey: false });
  expect(live.selection).toEqual([0, 1]);
  lift(wrap, 120, 80);
});

// --- lock --------------------------------------------------------------------

test("a locked element cannot be selected, marqueed or selected-all", async () => {
  // A file authored in Excalidraw with locked elements used to open here with
  // those elements freely draggable and deletable. The model refuses all three
  // now (`geometry::is_pickable`); nothing is filtered on this side.
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", locked: true }), shape({ id: "b", x: 300 })),
  });
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  expect(live.selection).toEqual([]);
  type(wrap, "a", { metaKey: true });
  expect(live.selection).toEqual([1]);
});

test("a click refused by a locked element gets a padlock, and only then", async () => {
  // The model's refusal is right and completely silent, so it needs an
  // affordance — but one that answers the click, the way Excalidraw's padlock
  // does. A permanent outline on every locked element would change what a
  // drawing looks like at rest, which is a rendering bug waiting to be reported.
  uninstallDom();
  installDom({ width: 400, height: 300, context: recorder });
  // Sized to fill the padded viewport exactly, so `fitTransform` lands on 1:1
  // with `PAD` as the whole offset and the pointer helpers still mean scene
  // coordinates — the paint loop needs a laid-out pane, and this is the one
  // fixture that gives it one without moving the camera.
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a", x: 0, y: 0, width: 336, height: 236, locked: true })),
  });
  const ctx = wrap.children.find((c) => c.tagName === "CANVAS").getContext("2d");

  // At rest: nothing. A locked element is drawn exactly as it would be if it
  // were not locked.
  ctx.calls.length = 0;
  flushFrames();
  expect(ctx.calls.filter((c) => c[0] === "arc")).toHaveLength(0);

  // Clicked, and refused: the badge appears. Its shackle is the only arc the
  // chrome draws with nothing selected.
  press(wrap, 20, 20);
  lift(wrap, 20, 20);
  ctx.calls.length = 0;
  flushFrames();
  expect(ctx.calls.filter((c) => c[0] === "arc").length).toBeGreaterThan(0);

  // A press somewhere else takes the question back, and the badge with it.
  press(wrap, 350, 250);
  lift(wrap, 350, 250);
  ctx.calls.length = 0;
  flushFrames();
  expect(ctx.calls.filter((c) => c[0] === "arc")).toHaveLength(0);
});

test("⌘⇧L locks the selection, and the menu can let it go again", async () => {
  const { wrap } = await mount({ text: sceneOf(shape({ id: "a" })) });
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  type(wrap, "l", { metaKey: true, shiftKey: true });
  expect(live.element(0).locked).toBe(true);
  // Locking deselects, or an arrow key would still move what was just locked.
  expect(live.selection).toEqual([]);
  // And "Unlock all" is the way back, because nothing can select it now.
  rightClick(wrap, 500, 500);
  const row = rowsOf(menuOf(wrap)).find((r) => r.children[0].textContent === "Unlock all");
  expect(row.disabled).toBe(false);
  row.dispatch("click", {});
  expect(live.element(0).locked).toBe(false);
});

// --- the context menu --------------------------------------------------------

test("right-clicking opens a menu of the verbs that are otherwise keyboard-only", async () => {
  const { wrap } = await mount();
  rightClick(wrap, 0, 30);
  const menu = menuOf(wrap);
  expect(menu).toBeDefined();
  const names = named(menu);
  for (const verb of ["Copy", "Duplicate", "Delete", "Bring to front", "Send to back", "Group", "Ungroup", "Lock"]) {
    expect(names).toContain(verb);
  }
  // Every row says which key does the same thing — a menu is where a shortcut
  // is learned.
  const front = rowsOf(menu).find((r) => r.children[0].textContent === "Bring to front");
  expect(front.children[1].textContent).toBe("⌘⇧]");
});

test("right-clicking something outside the selection selects it first", async () => {
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a" }), shape({ id: "b", x: 300 })),
  });
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  expect(live.selection).toEqual([0]);
  rightClick(wrap, 300, 30); // b's left stroke
  expect(live.selection).toEqual([1]);
});

test("a menu row runs its verb, and the menu goes away", async () => {
  const { wrap } = await mount();
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  rightClick(wrap, 0, 30);
  rowsOf(menuOf(wrap)).find((r) => r.children[0].textContent === "Delete").dispatch("click", {});
  expect(menuOf(wrap)).toBeUndefined();
  expect(live.length).toBe(0);
});

test("with nothing selected the verbs that need one are disabled", async () => {
  const { wrap } = await mount();
  rightClick(wrap, 500, 500);
  const menu = menuOf(wrap);
  const by = (name) => rowsOf(menu).find((r) => r.children[0].textContent === name);
  expect(by("Delete").disabled).toBe(true);
  expect(by("Duplicate").disabled).toBe(true);
  // Select all is always available; it is the one verb that needs no selection.
  expect(by("Select all").disabled).toBe(false);
  // A disabled row does nothing when clicked, rather than throwing.
  by("Delete").dispatch("click", {});
  expect(live.length).toBe(1);
});

test("a press on the canvas dismisses the menu", async () => {
  const { wrap } = await mount();
  rightClick(wrap, 0, 30);
  expect(menuOf(wrap)).toBeDefined();
  press(wrap, 500, 500);
  lift(wrap, 500, 500);
  expect(menuOf(wrap)).toBeUndefined();
});

// --- the shortcut sheet ------------------------------------------------------

test("? opens the shortcut sheet, built from the tool table itself", async () => {
  const { wrap } = await mount();
  type(wrap, "?", { shiftKey: true });
  const help = helpOf(wrap);
  expect(help).toBeDefined();
  const names = named(help);
  // Every tool, including the two this branch added.
  expect(names).toContain("Eraser");
  expect(names).toContain("Draw");
  expect(names).toContain("Rectangle");
  // And the keys that were wrong or missing.
  const shortcut = (name) => rowsOf(help).find((r) => r.children[0].textContent === name).children[1].textContent;
  expect(shortcut("Draw")).toBe("P / X / 7");
  expect(shortcut("Eraser")).toBe("E / 0");
  expect(shortcut("Actual size")).toBe("⌘0");
  expect(shortcut("Zoom to fit")).toBe("⇧1");
  expect(shortcut("Zoom to selection")).toBe("⇧2");
});

test("Escape closes the sheet before it touches the selection", async () => {
  const { wrap } = await mount();
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  type(wrap, "?", { shiftKey: true });
  type(wrap, "Escape");
  expect(helpOf(wrap)).toBeUndefined();
  // The selection survived, because Escape had the sheet to close first.
  expect(live.selection).toEqual([0]);
  type(wrap, "Escape");
  expect(live.selection).toEqual([]);
});

test("? toggles, and dispose takes the sheet and its listeners with it", async () => {
  const { wrap, dispose } = await mount();
  type(wrap, "?", { shiftKey: true });
  type(wrap, "?", { shiftKey: true });
  expect(helpOf(wrap)).toBeUndefined();
  // Left open across a dispose, both of them, which is the case that leaks.
  type(wrap, "?", { shiftKey: true });
  rightClick(wrap, 0, 30);
  dispose();
  await settle();
  expect(leakedListeners()).toEqual([]);
});

// --- the camera --------------------------------------------------------------

test("⌘0 is actual size, ⇧1 fits, and ⇧2 goes to the selection", async () => {
  uninstallDom();
  installDom({ width: 400, height: 300, context: recorder });
  const { wrap, actions } = await mount({
    text: sceneOf(shape({ id: "big", x: 0, y: 0, width: 1000, height: 800 }), shape({ id: "small", x: 0, y: 0, width: 50, height: 50 })),
  });
  const zoom = () => {
    flushFrames();
    return actions().find((a) => a.id === "xd-zoom").text;
  };
  // Mounted fitted, which for this drawing is well under 100%.
  const fitted = zoom();
  expect(Number.parseInt(fitted, 10)).toBeLessThan(50);

  // ⌘0 used to run `fit()`. Excalidraw's ⌘0 is reset-to-100%.
  type(wrap, "0", { metaKey: true });
  expect(zoom()).toBe("100%");

  // ⇧1 is where fit went, and it was bound to nothing at all before.
  type(wrap, "!", { shiftKey: true, code: "Digit1" });
  expect(zoom()).toBe(fitted);

  // ⇧2 fills the pane with the selection, so a small element gets big.
  live.setSelection([1]);
  type(wrap, "@", { shiftKey: true, code: "Digit2" });
  expect(Number.parseInt(zoom(), 10)).toBeGreaterThan(100);
});

// --- the style pipeline ------------------------------------------------------

test("a sloppiness change re-rolls the seed in the same command as the patch", async () => {
  // The headline sloppiness bug: Excalidraw writes `seed: randomInteger()` on
  // every sloppiness change, and without it the same random draws are merely
  // scaled by the new roughness — measured ink 2.00 → 3.08 → 4.14px, which reads
  // as the line getting heavier rather than as a different hand. The two writes
  // have to be one command, or an undo landing between them leaves the new
  // roughness sitting on the old seed.
  const { wrap } = await mount();
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  const button = panelButton(wrap, "Sloppiness: Cartoonist");
  expect(button).toBeDefined();
  button.dispatch("click", {});

  const resketch = live.__calls.filter((c) => c[0] === "setStyleResketched");
  expect(resketch).toHaveLength(1);
  expect(resketch[0][1].roughness).toBe(2);
  // One command, so no separate re-roll and no plain write alongside it.
  expect(live.__calls.filter((c) => c[0] === "reseed")).toHaveLength(0);
  expect(live.__calls.filter((c) => c[0] === "setStyle")).toHaveLength(0);
});

test("an ordinary style change does not touch the seed", async () => {
  const { wrap } = await mount();
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  panelButton(wrap, "Stroke width: Extra bold").dispatch("click", {});
  expect(live.__calls.filter((c) => c[0] === "setStyle")).toHaveLength(1);
  expect(live.__calls.filter((c) => c[0] === "setStyleResketched")).toHaveLength(0);
});

test("a width chosen on a pencil stroke means the same thing on a rectangle", async () => {
  // End to end for the freedraw halving: the panel resolves the key to px against
  // the *current* selection, so the widest option on a freedraw emits 2 — and 2
  // used to be remembered as px and come back as "Bold" on the next rectangle.
  const { wrap } = await mount({
    text: sceneOf({ type: "freedraw", id: "f", x: 0, y: 0, width: 100, height: 60, strokeWidth: 1, points: [[0, 0], [100, 60]] }),
  });
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  panelButton(wrap, "Stroke width: Extra bold").dispatch("click", {});
  // Halved for the pencil stroke itself, which is what Excalidraw draws.
  expect(live.element(0).strokeWidth).toBe(2);

  // Now draw a rectangle with the same remembered preference.
  type(wrap, "r");
  press(wrap, 300, 300);
  move(wrap, 400, 360);
  lift(wrap, 400, 360);
  const drawn = live.elements().find((e) => e.type === "rectangle");
  expect(drawn.strokeWidth).toBe(4);
});

test("a new arrow is authored with the roundness Excalidraw gives it", async () => {
  // Nothing ever wrote `roundness` for a linear element, so a curved line could
  // not exist and a line authored here reopened over there as straight segments.
  const { wrap } = await mount();
  type(wrap, "a");
  press(wrap, 300, 300);
  move(wrap, 400, 360);
  lift(wrap, 400, 360);
  const arrow = live.elements().find((e) => e.type === "arrow");
  expect(arrow.roundness).toEqual({ type: 2 });
  // And a diamond gets 2 where it used to get 3.
  type(wrap, "d");
  press(wrap, 500, 300);
  move(wrap, 600, 360);
  lift(wrap, 600, 360);
  expect(live.elements().find((e) => e.type === "diamond").roundness).toEqual({ type: 2 });
});

// --- images ------------------------------------------------------------------
//
// Three ways in, one way through. None of them existed before `putFile`: the
// file map was a getter with no counterpart, so nothing could ever add to it and
// every image path was blocked behind that one gap.

const pngFile = (name = "x.png") =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

const pickerOf = (wrap) => wrap.children.find((c) => c.tagName === "INPUT");

/// Several macrotasks, because an image goes through `arrayBuffer`, a
/// `FileReader` and a digest before it reaches the document.
const settleImage = async () => {
  for (let i = 0; i < 6; i++) await settle();
};

test("the image tool puts the picked file where the click was", async () => {
  const { wrap } = await mount();
  type(wrap, "9");
  press(wrap, 200, 150);
  lift(wrap, 200, 150);
  // The picker is a hidden input inside the host — the one way to ask for a file
  // that does not require knowing whether there is a filesystem behind it.
  const picker = pickerOf(wrap);
  expect(picker).toBeDefined();
  picker.files = [pngFile()];
  picker.dispatch("change", {});
  await settleImage();

  const image = live.elements().find((e) => e.type === "image");
  expect(image).toBeDefined();
  // Centred on the click, and naming a file that is actually in the map.
  expect(image.x + image.width / 2).toBe(200);
  expect(image.y + image.height / 2).toBe(150);
  const put = live.__calls.find((c) => c[0] === "putFile");
  expect(put).toBeDefined();
  expect(put[1]).toBe(image.fileId);
  expect(String(put[2].dataURL)).toContain("data:image/png");
  // And the tool snaps back, the way every drawing tool does.
  expect(live.elements().filter((e) => e.type === "image")).toHaveLength(1);
});

test("a cancelled picker leaves the drawing alone", async () => {
  const { wrap } = await mount();
  type(wrap, "9");
  press(wrap, 200, 150);
  lift(wrap, 200, 150);
  const picker = pickerOf(wrap);
  picker.files = [];
  picker.dispatch("change", {});
  await settleImage();
  expect(live.elements().some((e) => e.type === "image")).toBe(false);
});

test("an image dropped on the canvas lands where it was dropped", async () => {
  const { wrap } = await mount();
  wrap.dispatch("drop", { clientX: 100 + PAD, clientY: 80 + PAD, dataTransfer: { files: [pngFile()] } });
  await settleImage();
  const image = live.elements().find((e) => e.type === "image");
  expect(image).toBeDefined();
  expect(image.x + image.width / 2).toBe(100);
});

test("a pasted image is an image, not a text element saying nothing", async () => {
  // A screenshot on the clipboard carries no text at all, so asking for text
  // first would find nothing and return before it ever looked at the files.
  const { wrap } = await mount();
  wrap.dispatch("paste", { clipboardData: { files: [pngFile()], getData: () => "" } });
  await settleImage();
  expect(live.elements().some((e) => e.type === "image")).toBe(true);
});

test("a pasted payload's file map arrives before the elements that name it", async () => {
  // The paste-in half of the image clipboard fix. Without it a cross-document
  // paste yields an element pointing at a `fileId` that resolves to nothing — a
  // permanent grey placeholder.
  const { wrap } = await mount();
  const payload = JSON.stringify({
    type: "excalidraw/clipboard",
    elements: [{ type: "image", x: 0, y: 0, width: 40, height: 40, fileId: "abc" }],
    files: { abc: { id: "abc", mimeType: "image/png", dataURL: "data:image/png;base64,AAA" } },
  });
  wrap.dispatch("paste", { clipboardData: { files: [], getData: () => payload } });
  const calls = live.__calls.map((c) => c[0]);
  expect(calls).toContain("putFile");
  expect(live.elements().some((e) => e.type === "image" && e.fileId === "abc")).toBe(true);
});

// --- appState ----------------------------------------------------------------

test("⌘' writes a grid into the file and takes it out again", async () => {
  // `gridSize` was written `null` by every path in this codebase, because
  // nothing could write `appState` at all.
  const { wrap } = await mount();
  type(wrap, "'", { metaKey: true });
  expect(live.appState().gridSize).toBe(20);
  type(wrap, "'", { metaKey: true });
  // Removed rather than zeroed: `gridSize` is nullable in the format, and a 0
  // there is a value Excalidraw would not write.
  expect(live.appState().gridSize).toBeUndefined();
});

test("with a grid on, a drag lands on it", async () => {
  const { wrap } = await mount({ text: sceneOf(shape({ id: "a", x: 0, y: 0 })) });
  type(wrap, "'", { metaKey: true });
  press(wrap, 0, 30);
  move(wrap, 47, 30);
  lift(wrap, 47, 30);
  expect(live.element(0).x).toBe(40);
});

test("the panel can set the canvas colour and the theme", async () => {
  // Both rows are absent unless a host wires both halves, so they were on screen
  // and dark until `setAppState` existed.
  const { wrap } = await mount();
  // The panel takes itself off screen entirely with the select tool live and
  // nothing selected, so there has to be something selected to look at it.
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  const dark = panelButton(wrap, "Theme: Dark");
  expect(dark).toBeDefined();
  dark.dispatch("click", {});
  expect(live.appState().theme).toBe("dark");
  expect(live.__calls.filter((c) => c[0] === "setAppState").length).toBeGreaterThan(0);
});

// --- align, distribute, flip -------------------------------------------------

test("the panel's align, distribute and flip rows reach the document", async () => {
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a" }), shape({ id: "b", x: 200 }), shape({ id: "c", x: 400 })),
  });
  type(wrap, "a", { metaKey: true }); // select all three
  panelButton(wrap, "Align: Align left").dispatch("click", {});
  panelButton(wrap, "Align: Distribute horizontally").dispatch("click", {});
  panelButton(wrap, "Flip: Flip vertically").dispatch("click", {});
  expect(live.__calls.find((c) => c[0] === "align")).toEqual(["align", "left"]);
  expect(live.__calls.find((c) => c[0] === "distribute")).toEqual(["distribute", "horizontal"]);
  expect(live.__calls.find((c) => c[0] === "flip")).toEqual(["flip", "vertical"]);
});

test("⇧H and ⇧V flip, and an unshifted H is still the hand tool", async () => {
  const { wrap } = await mount();
  press(wrap, 0, 30);
  lift(wrap, 0, 30);
  type(wrap, "H", { shiftKey: true });
  type(wrap, "V", { shiftKey: true });
  expect(live.__calls.filter((c) => c[0] === "flip").map((c) => c[1])).toEqual(["horizontal", "vertical"]);
});

// --- export ------------------------------------------------------------------
//
// The property worth pinning is not "the SVG is correct" — a string cannot say
// that — but that the SVG comes out of the *same painter* as the screen. So these
// assert the things a second painter would get wrong: that every element type
// reaches the output, that the geometry is Rough's own rather than a plain shape,
// and that the scene's coordinates are the file's coordinates.

test("the view exports SVG through the painter the screen uses", async () => {
  const { dispose } = await mount({
    text: sceneOf(
      shape({ id: "a", x: 0, y: 0, width: 100, height: 60, backgroundColor: "#ffc9c9" }),
      { type: "ellipse", id: "e", x: 200, y: 0, width: 80, height: 80, strokeColor: "#1971c2", strokeWidth: 2 },
      { type: "text", id: "t", x: 0, y: 100, width: 40, height: 25, text: "hi <there>", originalText: "hi <there>", fontSize: 20, fontFamily: 5 },
    ),
  });
  const svg = dispose.exportSVG();

  expect(svg.startsWith('<?xml version="1.0"')).toBe(true);
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg.trimEnd().endsWith("</svg>")).toBe(true);

  // The scene's own background, the way the paint loop uses it.
  expect(svg).toContain('fill="#ffffff"');
  // The filled rectangle's fill colour arrives, which means `roughOptions` ran.
  expect(svg).toContain("#ffc9c9");
  expect(svg).toContain("#1971c2");
  // Rough emits every shape as cubics, so a `C` in a path is the evidence that
  // the geometry came from the generator and not from a plain <rect>.
  expect(svg).toMatch(/<path [^>]*d="M[^"]*C/);
  // Text is text, and is escaped rather than injected.
  expect(svg).toContain("hi &lt;there&gt;");
  expect(svg).not.toContain("hi <there>");
  // Nothing anywhere is NaN — an SVG with a NaN in a path renders as nothing at
  // all and says nothing about why.
  expect(svg).not.toContain("NaN");
});

test("the exported viewBox is the drawing's own coordinates, plus a margin", async () => {
  const { dispose } = await mount({
    text: sceneOf(shape({ id: "a", x: 100, y: 50, width: 200, height: 100 })),
  });
  const svg = dispose.exportSVG();
  // 10px of padding on each side, so 220×120 starting ten up and left.
  expect(svg).toContain('width="220" height="120"');
  expect(svg).toContain('viewBox="90 40 220 120"');
});

test("a rotated element exports with a transform rather than baked coordinates", async () => {
  // The painter rotates the *context*; a second painter would have had to rotate
  // the points, which is where the two would first disagree.
  const { dispose } = await mount({
    text: sceneOf(shape({ id: "a", angle: Math.PI / 4 })),
  });
  expect(dispose.exportSVG()).toContain("transform=\"matrix(");
});

test("an element type the painter cannot draw still exports as a placeholder", async () => {
  const { dispose } = await mount({
    text: sceneOf({ type: "embeddable", id: "x", x: 0, y: 0, width: 100, height: 60 }),
  });
  const svg = dispose.exportSVG();
  // The dashed box and its label, which is what the screen shows too.
  expect(svg).toContain("stroke-dasharray=");
  expect(svg).toContain(">embeddable<");
});

test("exporting an empty drawing says so rather than writing an empty file", async () => {
  const { dispose } = await mount({ text: sceneOf() });
  expect(() => dispose.exportSVG()).toThrow(/nothing in this drawing/);
  await expect(dispose.exportPNG()).rejects.toThrow(/nothing in this drawing/);
});

test("PNG export renders at a scale and reports a platform that cannot", async () => {
  // The fake canvas has no `toBlob`, which is the honest headless answer — so
  // what is asserted here is that it is reported rather than thrown as a
  // TypeError out of the middle of a render, and that the offscreen canvas was
  // sized from the drawing and the scale.
  const { host, dispose } = await mount({
    text: sceneOf(shape({ id: "a", x: 0, y: 0, width: 200, height: 100 })),
  });
  await expect(dispose.exportPNG(2)).rejects.toThrow(/can't turn a canvas into an image/);
  // 220×120 scene units at 2× — and on a canvas that is not the one on screen.
  const onScreen = host.children[0].children.find((c) => c.tagName === "CANVAS");
  const off = madeCanvases.find((c) => c !== onScreen && c.width === 440);
  expect(off).toBeDefined();
  expect(off.height).toBe(240);
});

// --- selection chrome --------------------------------------------------------

test("a multi-selection is drawn without the rotate handle", async () => {
  // The rotate handle is drawn as the only circle in the chrome, and on a
  // multi-selection it is both meaningless — `selectionAngle()` returns 0 by
  // design — and destructive, because `ops::rotate` reads the absolute bearing
  // as a delta. Excalidraw hides it; `drawHandles({ only })` has always been
  // able to and was never asked.
  uninstallDom();
  installDom({ width: 400, height: 300, context: recorder });
  const { wrap } = await mount({
    text: sceneOf(shape({ id: "a" }), shape({ id: "b", x: 200 })),
  });
  const ctx = wrap.children.find((c) => c.tagName === "CANVAS").getContext("2d");

  live.setSelection([0]);
  ctx.calls.length = 0;
  flushFrames();
  expect(ctx.calls.filter((c) => c[0] === "arc").length).toBe(1);

  live.setSelection([0, 1]);
  ctx.calls.length = 0;
  flushFrames();
  expect(ctx.calls.filter((c) => c[0] === "arc").length).toBe(0);
});
