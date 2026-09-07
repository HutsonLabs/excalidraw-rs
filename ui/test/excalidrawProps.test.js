// The properties island, driven from both ends.
//
// Two halves, for the same reason excalidrawChrome.test.js has two halves: the
// interesting failures are of two different kinds and they want different
// instruments.
//
//   - The value tables and the visibility rules are pure, and are the half
//     where being wrong is *silent*. A `roundness` of `{ type: 2 }` instead of
//     `{ type: 3 }` renders perfectly here and draws the wrong corners at
//     excalidraw.com; a font family of 1 instead of 5 is a diagram that
//     changes typeface when someone else opens it. Nothing but an assertion
//     against the known-good numbers catches either.
//
//   - The panel itself needs a DOM. `bun test` has none, and this repo has no
//     happy-dom preload — ui/test/contract.test.js says so in its header and
//     answers it with a hand-built stub that is "deliberately just enough to
//     count listeners and observers". This file takes the same answer, one
//     size up: enough of `document` to build the panel, click a button, and
//     ask afterwards whether anything was left behind. A panel that passes
//     against this stub passes against a browser, because the questions asked
//     are about bookkeeping — which button carries aria-pressed, what setStyle
//     was handed, whether the host is empty — and those look identical either
//     way.
//
// The alternative was adding happy-dom as a dependency, which would make this
// the only file in ui/test/ that needs node_modules to exist. A no-bundler,
// no-dependency ui/ is a stated property of this project (package.json says
// so), and one test file is not a good enough reason to spend it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  renderProps, STROKE_COLORS, BACKGROUND_COLORS, FILL_STYLES, STROKE_WIDTHS,
  STROKE_STYLES, SLOPPINESS, EDGES, FONT_SIZES, FONT_FAMILIES, DEFAULT_STYLE,
  TRANSPARENT, isTransparent, showsFill, edgeKey, roundnessFor, panelShown,
} from "../src/excalidrawProps.js";

// --- The values Excalidraw actually writes -----------------------------------

test("the stroke and background palettes are Excalidraw's, exactly", () => {
  // Spelled out rather than derived, because the point of the assertion is to
  // be a second copy of the numbers: a table that checked itself against
  // itself would agree with any typo.
  expect(STROKE_COLORS).toEqual(["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"]);
  expect(BACKGROUND_COLORS).toEqual(["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"]);
});

test("the enumerations match Excalidraw's own value sets", () => {
  expect(FILL_STYLES.map((o) => o.value)).toEqual(["hachure", "cross-hatch", "solid"]);
  expect(STROKE_WIDTHS.map((o) => o.value)).toEqual([1, 2, 4]);
  expect(STROKE_STYLES.map((o) => o.value)).toEqual(["solid", "dashed", "dotted"]);
  expect(SLOPPINESS.map((o) => o.value)).toEqual([0, 1, 2]);
  expect(FONT_SIZES.map((o) => o.value)).toEqual([16, 20, 28, 36]);
  // Not 1/2/3: 5 is Excalifont, and the ids are not ours to renumber.
  expect(FONT_FAMILIES.map((o) => o.value)).toEqual([5, 2, 3]);
  expect(EDGES.map((o) => o.value)).toEqual(["sharp", "round"]);
});

test("round edges are ADAPTIVE_RADIUS, and sharp ones are null rather than absent", () => {
  expect(roundnessFor("round")).toEqual({ type: 3 });
  expect(roundnessFor("sharp")).toBe(null);
  expect(edgeKey(null)).toBe("sharp");
  expect(edgeKey(undefined)).toBe("sharp");
  expect(edgeKey({ type: 3 })).toBe("round");
});

test("a missing key renders a default rather than a blank row", () => {
  // The panel is handed the style of whatever is selected, and a mixed
  // selection or a file from an older schema will have holes in it.
  expect(DEFAULT_STYLE.strokeColor).toBe("#1e1e1e");
  expect(DEFAULT_STYLE.backgroundColor).toBe(TRANSPARENT);
  expect(DEFAULT_STYLE.roundness).toBe(null);
  expect(DEFAULT_STYLE.opacity).toBe(100);
});

// --- The visibility rules ----------------------------------------------------

test("transparent has more than one spelling, and they all mean transparent", () => {
  expect(isTransparent("transparent")).toBe(true);
  expect(isTransparent("TRANSPARENT")).toBe(true);
  expect(isTransparent("#00000000")).toBe(true);
  expect(isTransparent(null)).toBe(true);
  expect(isTransparent(undefined)).toBe(true);
  expect(isTransparent("")).toBe(true);
  expect(isTransparent("#ffc9c9")).toBe(false);
});

test("fill is offered only when there is something to fill", () => {
  expect(showsFill({ backgroundColor: "#ffc9c9" })).toBe(true);
  expect(showsFill({ backgroundColor: TRANSPARENT })).toBe(false);
  expect(showsFill({})).toBe(false);
});

test("an empty selection with the select tool gets no panel at all", () => {
  // The one case where the drawing wins the space outright.
  expect(panelShown({ hasSelection: false, tool: "selection" })).toBe(false);
  expect(panelShown({ hasSelection: false, tool: "select" })).toBe(false);
  // A drawing tool has defaults to set before the first drag.
  expect(panelShown({ hasSelection: false, tool: "rectangle" })).toBe(true);
  // A selection always has properties to edit, whatever the tool.
  expect(panelShown({ hasSelection: true, tool: "selection" })).toBe(true);
  // No tool reported: show, because a missing panel is worse than an untidy one.
  expect(panelShown({ hasSelection: false })).toBe(true);
});

// --- The DOM stub ------------------------------------------------------------

/// Every element ever created, so a test can ask the global question — "is
/// there a live listener anywhere?" — without knowing where the panel put its
/// nodes.
let made = [];

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.id = "";
    this.title = "";
    this.type = "";
    this.value = "";
    this.style = {};
    this.attributes = new Map();
    this.handlers = new Map(); // type -> [fn]
    this.classes = new Set();
    made.push(this);
  }

  get className() {
    return [...this.classes].join(" ");
  }

  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const s = this.classes;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
      toggle: (c, on) => (on ? s.add(c) : s.delete(c)),
    };
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }

  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.handlers.get(type);
    if (list) this.handlers.set(type, list.filter((f) => f !== fn));
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

/// Fire a listener the way a click would. No bubbling: nothing in the panel
/// relies on it, and a stub that faked propagation would be asserting its own
/// behaviour rather than the panel's.
const fire = (node, type, ev = {}) => {
  for (const fn of [...(node.handlers.get(type) ?? [])]) fn(ev);
};

/// Depth-first over a subtree, including the root.
function* walk(node) {
  yield node;
  for (const child of node.children) yield* walk(child);
}

const byClass = (root, cls) => [...walk(root)].filter((n) => n.classes.has(cls));

/// The label -> its sibling row of controls, which is how every assertion
/// below names a group: the visible text is the thing a user would point at.
function groupNamed(root, label) {
  for (const node of walk(root)) {
    if (!node.classes.has("xdp-group")) continue;
    const title = node.children.find((c) => c.classes.has("xdp-label"));
    if (title?.textContent === label) return node;
  }
  return null;
}

const controlsOf = (group) => group?.children.find((c) => c.classes.has("xdp-row"))?.children ?? [];

/// A button by its aria-label, which is the string the panel promises to a
/// screen reader — worth selecting on precisely because it is load-bearing.
function byLabel(root, label) {
  return [...walk(root)].find((n) => n.getAttribute("aria-label") === label);
}

let host;

beforeEach(() => {
  made = [];
  // Assigned rather than merged: `document.head` is deliberately absent, which
  // is what makes the module's stylesheet injection a no-op here. Testing the
  // panel should not require a document to link a file into.
  globalThis.document = { createElement: (tag) => new FakeEl(tag) };
  host = new FakeEl("div");
});

afterEach(() => {
  delete globalThis.document;
});

/// A panel over a mutable style, which is what every DOM test below wants:
/// somewhere to see the patches land, and something for refresh() to re-read.
function mount(initial = {}, { selection = true, tool = "rectangle" } = {}) {
  let style = { ...initial };
  const patches = [];
  const panel = renderProps(host, {
    getStyle: () => style,
    setStyle: (patch) => {
      patches.push(patch);
      style = { ...style, ...patch };
    },
    hasSelection: () => selection,
    activeTool: () => tool,
  });
  return {
    panel,
    patches,
    style: () => style,
    set: (next) => {
      style = { ...style, ...next };
    },
    select: (on) => {
      selection = on;
    },
    setTool: (t) => {
      tool = t;
    },
    root: () => host.children[0],
  };
}

// --- The panel ---------------------------------------------------------------

test("the island renders every group, in Excalidraw's order", () => {
  const m = mount({ backgroundColor: "#ffc9c9" });
  const root = m.root();
  const labels = byClass(root, "xdp-label").map((n) => n.textContent);
  expect(labels).toEqual([
    "Stroke", "Background", "Fill", "Stroke width", "Stroke style",
    "Sloppiness", "Edges", "Opacity", "Font size", "Font family",
  ]);
  m.panel.dispose();
});

test("each colour row is five presets, a separator, and the custom entry", () => {
  const m = mount();
  const row = controlsOf(groupNamed(m.root(), "Stroke"));
  expect(row.filter((n) => n.classes.has("xdp-swatch"))).toHaveLength(6);
  expect(row.filter((n) => n.classes.has("xdp-sep"))).toHaveLength(1);
  expect(byLabel(m.root(), "Stroke: custom color")).toBeTruthy();
  m.panel.dispose();
});

test("every control is named, titled, and reachable by keyboard", () => {
  // A row of coloured squares with no accessible name is unusable with a
  // screen reader, and `type=\"button\"` is what keeps a button in a form from
  // submitting one.
  const m = mount({ backgroundColor: "#ffc9c9" });
  for (const b of [...walk(m.root())].filter(
    (n) => n.tagName === "BUTTON",
  )) {
    expect(b.type).toBe("button");
    expect(b.title).toBeTruthy();
    expect(b.getAttribute("aria-label")).toBeTruthy();
  }
  m.panel.dispose();
});

test("clicking a swatch sets exactly one key", () => {
  // The panel is handed setStyle for *partial* styles. A click that sent the
  // whole style object back would turn one undo entry into an overwrite of ten
  // fields, and would flatten a mixed multi-selection to whatever the panel
  // happened to be showing.
  const m = mount();
  fire(byLabel(m.root(), "Stroke: Red"), "click");
  expect(m.patches).toEqual([{ strokeColor: "#e03131" }]);
  expect(Object.keys(m.patches[0])).toHaveLength(1);
  m.panel.dispose();
});

test("each group writes its own field and nothing else", () => {
  const m = mount({ backgroundColor: "#ffc9c9" });
  fire(byLabel(m.root(), "Background: Sky"), "click");
  fire(byLabel(m.root(), "Fill: Solid"), "click");
  fire(byLabel(m.root(), "Stroke width: Extra bold"), "click");
  fire(byLabel(m.root(), "Stroke style: Dotted"), "click");
  fire(byLabel(m.root(), "Sloppiness: Cartoonist"), "click");
  fire(byLabel(m.root(), "Font size: Large"), "click");
  fire(byLabel(m.root(), "Font family: Code"), "click");
  expect(m.patches).toEqual([
    { backgroundColor: "#a5d8ff" },
    { fillStyle: "solid" },
    { strokeWidth: 4 },
    { strokeStyle: "dotted" },
    { roughness: 2 },
    { fontSize: 28 },
    { fontFamily: 3 },
  ]);
  m.panel.dispose();
});

test("edges write the object the format wants, not the key the button carries", () => {
  const m = mount();
  fire(byLabel(m.root(), "Edges: Round"), "click");
  expect(m.patches).toEqual([{ roundness: { type: 3 } }]);
  fire(byLabel(m.root(), "Edges: Sharp"), "click");
  expect(m.patches[1]).toEqual({ roundness: null });
  m.panel.dispose();
});

test("opacity emits a number, not the input's string", () => {
  const m = mount();
  const range = byLabel(m.root(), "Opacity");
  range.value = "40";
  fire(range, "input");
  expect(m.patches).toEqual([{ opacity: 40 }]);
  m.panel.dispose();
});

test("the active value is marked, and only one of them is", () => {
  const m = mount({ strokeColor: "#1971c2", strokeWidth: 2 });
  const pressed = (label) => byLabel(m.root(), label).getAttribute("aria-pressed");
  expect(pressed("Stroke: Blue")).toBe("true");
  expect(pressed("Stroke: Red")).toBe("false");
  expect(pressed("Stroke width: Bold")).toBe("true");
  expect(pressed("Stroke width: Thin")).toBe("false");
  const on = controlsOf(groupNamed(m.root(), "Stroke width"))
    .filter((b) => b.classes.has("on"));
  expect(on).toHaveLength(1);
  m.panel.dispose();
});

test("a colour outside the palette marks the custom swatch instead", () => {
  const m = mount({ strokeColor: "#123456" });
  const custom = byLabel(m.root(), "Stroke: custom color");
  expect(custom.classes.has("on")).toBe(true);
  expect(custom.style.background).toBe("#123456");
  // And none of the presets claims it — a swatch that lit up for a colour it
  // does not hold would be a lie about what clicking it would do.
  const presets = controlsOf(groupNamed(m.root(), "Stroke"))
    .filter((n) => n.classes.has("xdp-swatch") && !n.classes.has("xdp-custom"));
  expect(presets).toHaveLength(STROKE_COLORS.length);
  expect(presets.filter((b) => b.classes.has("on"))).toHaveLength(0);
  m.panel.dispose();
});

test("the fill group appears only when the background is not transparent", () => {
  const m = mount({ backgroundColor: TRANSPARENT });
  const fill = groupNamed(m.root(), "Fill");
  expect(fill.hidden).toBe(true);

  m.set({ backgroundColor: "#b2f2bb" });
  m.panel.refresh();
  expect(fill.hidden).toBe(false);

  // And back — it is a live rule, not a decision taken once at mount.
  m.set({ backgroundColor: TRANSPARENT });
  m.panel.refresh();
  expect(fill.hidden).toBe(true);
  m.panel.dispose();
});

test("refresh() reflects a changed getStyle()", () => {
  const m = mount({ strokeColor: "#1e1e1e", roughness: 0, roundness: null });
  expect(byLabel(m.root(), "Sloppiness: Architect").getAttribute("aria-pressed")).toBe("true");

  m.set({ strokeColor: "#f08c00", roughness: 2, roundness: { type: 3 } });
  m.panel.refresh();

  expect(byLabel(m.root(), "Stroke: Orange").getAttribute("aria-pressed")).toBe("true");
  expect(byLabel(m.root(), "Stroke: Black").getAttribute("aria-pressed")).toBe("false");
  expect(byLabel(m.root(), "Sloppiness: Cartoonist").getAttribute("aria-pressed")).toBe("true");
  expect(byLabel(m.root(), "Sloppiness: Architect").getAttribute("aria-pressed")).toBe("false");
  expect(byLabel(m.root(), "Edges: Round").getAttribute("aria-pressed")).toBe("true");
  m.panel.dispose();
});

test("refresh() syncs in place — the nodes are the same ones", () => {
  // The editor calls refresh() on every selection change, possibly mid-drag.
  // Rebuilding the DOM there would drop the focused button and would tear the
  // swatch out from under an open colour picker.
  const m = mount();
  const before = byLabel(m.root(), "Stroke: Red");
  m.set({ strokeColor: "#2f9e44" });
  m.panel.refresh();
  expect(byLabel(m.root(), "Stroke: Red")).toBe(before);
  m.panel.dispose();
});

test("the heading is the only thing that changes between the two states", () => {
  const m = mount({}, { selection: true });
  const title = byClass(m.root(), "xdp-title")[0];
  expect(title.textContent).toBe("Selected");
  const groupsBefore = byClass(m.root(), "xdp-group").length;

  m.select(false);
  m.panel.refresh();
  expect(title.textContent).toBe("New shape");
  expect(byClass(m.root(), "xdp-group")).toHaveLength(groupsBefore);
  m.panel.dispose();
});

test("nothing selected and the select tool active renders nothing at all", () => {
  // Not a collapsed strip and not an empty island — the drawing gets the pane.
  const m = mount({}, { selection: false, tool: "selection" });
  expect(host.children).toHaveLength(0);

  m.select(true);
  m.panel.refresh();
  expect(host.children).toHaveLength(1);

  m.select(false);
  m.panel.refresh();
  expect(host.children).toHaveLength(0);
  m.panel.dispose();
});

test("dispose() leaves the host empty and no listener alive", () => {
  const m = mount({ backgroundColor: "#ffc9c9" });
  const live = () => made.reduce(
    (n, el) => n + [...el.handlers.values()].reduce((k, l) => k + l.length, 0), 0,
  );
  expect(live()).toBeGreaterThan(0);

  m.panel.dispose();

  expect(host.children).toHaveLength(0);
  expect(live()).toBe(0);
});

test("dispose() is idempotent, and refresh() after it does nothing", () => {
  // A pane can tear down twice (preview.js's disposeView runs from both the
  // tab closing and the pane being replaced), and a debounced apply can land
  // after the view is gone.
  const m = mount();
  m.panel.dispose();
  expect(() => m.panel.dispose()).not.toThrow();
  expect(() => m.panel.refresh()).not.toThrow();
  expect(host.children).toHaveLength(0);
});
