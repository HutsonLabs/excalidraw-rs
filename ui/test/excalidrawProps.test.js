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
  renderProps, STROKE_COLORS, BACKGROUND_COLORS, CANVAS_COLORS, FILL_STYLES,
  STROKE_WIDTHS, STROKE_STYLES, SLOPPINESS, EDGES, FONT_SIZES, FONT_FAMILIES,
  TEXT_ALIGNS, VERTICAL_ALIGNS, ARROWHEADS, DEFAULT_STYLE,
  TRANSPARENT, MIXED, isTransparent, showsFill, edgeKey, edgeRoundness, panelShown,
  foldStyles, sectionsFor, freehandOnly, strokeWidthFor, strokeWidthKey,
  arrowheadFor, arrowheadKey,
} from "../src/excalidrawProps.js";
import { THEME_FILTER } from "../src/excalidrawScene.js";

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
  expect(TEXT_ALIGNS.map((o) => o.value)).toEqual(["left", "center", "right"]);
  expect(VERTICAL_ALIGNS.map((o) => o.value)).toEqual(["top", "middle", "bottom"]);
  // Excalidraw's canvas picks, which are not element colours and not in either
  // element palette.
  expect(CANVAS_COLORS).toEqual(["#ffffff", "#f8f9fa", "#f5faff", "#fffce8", "#fdf8f6"]);
});

test("the arrowhead kinds are the ones the renderer can actually draw", () => {
  // Excalidraw offers 13. Offering one we cannot paint would be a control that
  // does nothing here and something else at excalidraw.com.
  expect(ARROWHEADS.map((o) => o.value))
    .toEqual(["none", "arrow", "bar", "dot", "triangle", "diamond"]);
});

test("an arrowhead writes null for none, and reads Excalidraw's two spellings", () => {
  expect(arrowheadFor("none")).toBe(null);
  expect(arrowheadFor("triangle")).toBe("triangle");
  // Absent means different things at the two ends: the renderer draws an arrow
  // for a missing endArrowhead and nothing for a missing startArrowhead.
  expect(arrowheadKey(undefined, true)).toBe("arrow");
  expect(arrowheadKey(null, true)).toBe("arrow");
  expect(arrowheadKey(undefined, false)).toBe("none");
  // `circle` is Excalidraw's newer name for the head we write as `dot`.
  expect(arrowheadKey("circle", true)).toBe("dot");
  expect(arrowheadKey(MIXED, true)).toBe(MIXED);
});

test("a stroke-width key resolves to half as much on a freedraw", () => {
  // The schema-2.0 back-compat halving (`FREEDRAW_STROKE_WIDTH`). Skipping it
  // drew every pencil stroke twice as thick as Excalidraw's.
  expect(STROKE_WIDTHS.map((o) => o.key)).toEqual(["thin", "medium", "bold"]);
  expect(["thin", "medium", "bold"].map((k) => strokeWidthFor(k, false))).toEqual([1, 2, 4]);
  expect(["thin", "medium", "bold"].map((k) => strokeWidthFor(k, true))).toEqual([0.5, 1, 2]);

  // And back: a freedraw imported from Excalidraw at 0.5/1/2 has to light a
  // button up, where before it matched none of 1/2/4.
  expect(strokeWidthKey(1, true)).toBe("medium");
  expect(strokeWidthKey(0.5, true)).toBe("thin");
  expect(strokeWidthKey(1, false)).toBe("thin");
  // Even without knowing it is a freedraw, 0.5 is recognisable — the other
  // table is the fallback rather than nothing pressed.
  expect(strokeWidthKey(0.5, false)).toBe("thin");
  expect(strokeWidthKey(MIXED, false)).toBeUndefined();
  expect(strokeWidthKey(3, false)).toBeUndefined();
});

test("the freedraw table applies only when everything selected is a freedraw", () => {
  // One patch reaches the whole selection, so a mixed pencil-and-box selection
  // cannot have it both ways.
  expect(freehandOnly({ kinds: ["freedraw"] })).toBe(true);
  expect(freehandOnly({ kinds: ["freedraw", "freedraw"] })).toBe(true);
  expect(freehandOnly({ kinds: ["freedraw", "rectangle"] })).toBe(false);
  expect(freehandOnly({ kinds: [], tool: "freedraw" })).toBe(true);
  expect(freehandOnly({ kinds: [], tool: "rectangle" })).toBe(false);
  expect(freehandOnly({})).toBe(false);
});

test("the edges row answers round or sharp, and leaves the type to the doc layer", () => {
  // Not named roundnessFor: excalidrawDoc.js owns that name and maps a *kind* to
  // its roundness type (rectangle 3, diamond and line 2). This panel cannot —
  // one click reaches a whole selection — so it emits the answer and `stylePatch`
  // re-types it against the actual targets. The 3 is the placeholder that
  // survives the one case stylePatch leaves alone: kinds wanting different types.
  expect(edgeRoundness("round")).toEqual({ type: 3 });
  expect(edgeRoundness("sharp")).toBe(null);
  expect(edgeKey(null)).toBe("sharp");
  expect(edgeKey(undefined)).toBe("sharp");
  expect(edgeKey({ type: 3 })).toBe("round");
});

test("a missing key renders a default rather than a blank row", () => {
  // The panel is handed the style of whatever is selected, and a file from an
  // older schema will have holes in it.
  expect(DEFAULT_STYLE.strokeColor).toBe("#1e1e1e");
  expect(DEFAULT_STYLE.backgroundColor).toBe(TRANSPARENT);
  expect(DEFAULT_STYLE.roundness).toBe(null);
  expect(DEFAULT_STYLE.opacity).toBe(100);
  // Excalidraw's DEFAULT_ELEMENT_PROPS, and the same numbers excalidrawDoc.js's
  // DEFAULT_STYLE and xd-core's new_element use. The two tables disagreed on
  // these two, and a fallback that disagrees with the real default is a trap.
  expect(DEFAULT_STYLE.strokeWidth).toBe(2);
  expect(DEFAULT_STYLE.fillStyle).toBe("solid");
  // An absent endArrowhead is drawn as an arrow, so that is what the row shows.
  expect(DEFAULT_STYLE.endArrowhead).toBe("arrow");
  expect(DEFAULT_STYLE.startArrowhead).toBe(null);
  expect(DEFAULT_STYLE.textAlign).toBe("left");
  expect(DEFAULT_STYLE.verticalAlign).toBe("top");
});

// --- The mixed multi-selection fold ------------------------------------------

test("styles that disagree fold to MIXED, and ones that agree do not", () => {
  const red = { strokeColor: "#e03131", strokeWidth: 2, opacity: 100 };
  const blue = { strokeColor: "#1971c2", strokeWidth: 2, opacity: 100 };
  const folded = foldStyles([red, blue]);
  expect(folded.strokeColor).toBe(MIXED);
  expect(folded.strokeWidth).toBe(2);
  expect(folded.opacity).toBe(100);

  // One element is not a disagreement with itself.
  expect(foldStyles([red])).toEqual(red);
  expect(foldStyles([])).toEqual({});
  expect(foldStyles(null)).toEqual({});
});

test("the fold compares roundness by value, and treats absent as null", () => {
  // roundness is the one field that is an object, so identity is not enough.
  expect(foldStyles([{ roundness: { type: 3 } }, { roundness: { type: 3 } }]).roundness)
    .toEqual({ type: 3 });
  expect(foldStyles([{ roundness: { type: 3 } }, { roundness: null }]).roundness).toBe(MIXED);
  // Absent and explicitly-null both mean "not set" for every field here.
  expect(foldStyles([{ roundness: null }, {}]).roundness).toBe(null);
});

test("a key only some elements carry is a disagreement, not a value", () => {
  // A text element with fontSize 28 and a rectangle with none do not share a
  // font size, and pressing 28 would claim they did.
  expect(foldStyles([{ fontSize: 28 }, { strokeColor: "#e03131" }]).fontSize).toBe(MIXED);
  expect(foldStyles([{ strokeColor: "#e03131" }, { fontSize: 28 }]).fontSize).toBe(MIXED);
});

test("edgeKey passes a disagreement through rather than calling it sharp", () => {
  // MIXED is truthy, so without this the Edges row would show "Round" pressed
  // for a selection that does not agree about its corners.
  expect(edgeKey(MIXED)).toBe(MIXED);
});

// --- Which sections apply ----------------------------------------------------

test("a text element gets no background, fill, stroke style, sloppiness or edges", () => {
  const on = sectionsFor({ kinds: ["text"] });
  expect(on.background).toBe(false);
  expect(on.fill).toBe(false);
  expect(on.strokeStyle).toBe(false);
  expect(on.sloppiness).toBe(false);
  expect(on.edges).toBe(false);
  expect(on.strokeWidth).toBe(false);
  // What it does get: its colour, its opacity, and the four text rows.
  expect(on.stroke).toBe(true);
  expect(on.opacity).toBe(true);
  expect(on.text).toBe(true);
});

test("edges are offered only on the shapes that can round", () => {
  // canChangeRoundness: rectangle, diamond, line, image, iframe, embeddable.
  // Notably not ellipse — a circle has no corners.
  for (const kind of ["rectangle", "diamond", "line", "image"]) {
    expect(sectionsFor({ kinds: [kind] }).edges).toBe(true);
  }
  for (const kind of ["ellipse", "arrow", "freedraw", "text"]) {
    expect(sectionsFor({ kinds: [kind] }).edges).toBe(false);
  }
});

test("sloppiness is offered only where there is a sketched outline", () => {
  // hasStrokeStyle. A freedraw is a captured path, not a sketched one.
  expect(sectionsFor({ kinds: ["rectangle"] }).sloppiness).toBe(true);
  expect(sectionsFor({ kinds: ["arrow"] }).sloppiness).toBe(true);
  expect(sectionsFor({ kinds: ["freedraw"] }).sloppiness).toBe(false);
  expect(sectionsFor({ kinds: ["image"] }).sloppiness).toBe(false);
});

test("arrowheads are offered on arrows and nothing else", () => {
  expect(sectionsFor({ kinds: ["arrow"] }).arrowheads).toBe(true);
  // A line with an arrowhead is an arrow — canHaveArrowheads is arrow-only.
  expect(sectionsFor({ kinds: ["line"] }).arrowheads).toBe(false);
  expect(sectionsFor({ kinds: ["rectangle"] }).arrowheads).toBe(false);
});

test("an image has no stroke colour of its own", () => {
  expect(sectionsFor({ kinds: ["image"] }).stroke).toBe(false);
  expect(sectionsFor({ kinds: ["frame"] }).stroke).toBe(false);
  expect(sectionsFor({ kinds: ["rectangle"] }).stroke).toBe(true);
});

test("a section applies if any selected element has it", () => {
  // `some`, not `every`: the fill row still applies to the rectangle, and hiding
  // it would take away the only way to reach it.
  const on = sectionsFor({ kinds: ["rectangle", "text"] });
  expect(on.fill).toBe(true);
  expect(on.text).toBe(true);
  expect(on.edges).toBe(true);
});

test("with nothing selected the active tool decides, and an unknown one shows all", () => {
  expect(sectionsFor({ kinds: [], tool: "text" }).edges).toBe(false);
  expect(sectionsFor({ kinds: [], tool: "text" }).text).toBe(true);
  expect(sectionsFor({ kinds: [], tool: "ellipse" }).edges).toBe(false);
  expect(sectionsFor({ kinds: [], tool: "rectangle" }).edges).toBe(true);
  // Neither reported, or a tool that draws nothing: show everything, the same
  // safe direction panelShown takes.
  expect(sectionsFor({})).toEqual(sectionsFor({ kinds: [], tool: "selection" }));
  expect(sectionsFor({}).sloppiness).toBe(true);
  expect(sectionsFor({ kinds: [], tool: "hand" }).text).toBe(true);
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
    this.disabled = false;
    this.id = "";
    this.title = "";
    this.type = "";
    this.value = "";
    // A style object with the two shapes the code under test uses: plain
    // property assignment (`style.background = ...`) and the custom-property
    // API (`setProperty("--x", v)`), which is how the panel hands the swatches
    // the filter their colour preview goes through. Setting a property to ""
    // removes it, as the real CSSOM does.
    this.style = {
      setProperty(name, value) {
        if (value === "" || value == null) delete this[name];
        else this[name] = String(value);
      },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] ?? ""; },
    };
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

/// The colour a swatch is actually showing. It lives on a child element rather
/// than on the button because that child is what the preview filter is applied
/// to — see `.xdp-fill` in excalidrawProps.css.
const fillOf = (swatch) => swatch?.children.find((c) => c.classes.has("xdp-fill"));

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
///
/// `styles` (plural) mounts the panel over a *list* of styles, which is the
/// contract for a multi-selection: the panel folds them itself. `kinds` is what
/// the selection is made of, and drives which groups are on screen.
function mount(initial = {}, {
  selection = true, tool = "rectangle", styles = null, kinds = null,
  actions = undefined, canvas = null, reseed = undefined, theme = null,
} = {}) {
  let style = { ...initial };
  let list = styles;
  const patches = [];
  const opts = [];
  let canvasColor = canvas;
  let themeNow = theme;
  const panel = renderProps(host, {
    getStyle: () => list ?? style,
    setStyle: (patch, o) => {
      patches.push(patch);
      opts.push(o);
      style = { ...style, ...patch };
    },
    hasSelection: () => selection,
    // Null rather than absent when a test does not care: the panel treats
    // "not an array" as "cannot tell", which is what an unwired host gives it.
    getKinds: () => kinds,
    activeTool: () => tool,
    reseed,
    ...(canvas == null ? {} : {
      getCanvasBackground: () => canvasColor,
      setCanvasBackground: (c) => {
        canvasColor = c;
      },
    }),
    // Read-only, as the panel's contract is: the theme belongs to the host and
    // the panel only previews colours through it.
    ...(theme == null ? {} : { getTheme: () => themeNow }),
    actions,
  });
  return {
    panel,
    patches,
    /// The second argument of each setStyle call, parallel to `patches`.
    opts,
    style: () => style,
    canvas: () => canvasColor,
    theme: () => themeNow,
    setTheme: (t) => {
      themeNow = t;
    },
    set: (next) => {
      style = { ...style, ...next };
      list = null;
    },
    setStyles: (next) => {
      list = next;
    },
    select: (on) => {
      selection = on;
    },
    setKinds: (next) => {
      kinds = next;
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
    "Sloppiness", "Edges", "Arrow start", "Arrow end", "Opacity",
    "Font size", "Font family", "Text align", "Vertical align",
  ]);
  m.panel.dispose();
});

test("the verb rows and the canvas row exist only once the host wires them", () => {
  // A row of buttons that do nothing is worse than no row: it teaches the user
  // the feature is broken rather than absent.
  const bare = mount();
  expect(byClass(bare.root(), "xdp-label").map((n) => n.textContent))
    .not.toContain("Layers");
  expect(byClass(bare.root(), "xdp-label").map((n) => n.textContent))
    .not.toContain("Canvas");
  bare.panel.dispose();

  const wired = mount({}, {
    canvas: "#ffffff",
    actions: {
      reorder() {}, align() {}, distribute() {}, flip() {}, group() {}, ungroup() {},
    },
  });
  const labels = byClass(wired.root(), "xdp-label").map((n) => n.textContent);
  expect(labels).toEqual([
    "Stroke", "Background", "Canvas", "Fill", "Stroke width", "Stroke style",
    "Sloppiness", "Edges", "Arrow start", "Arrow end", "Opacity",
    "Font size", "Font family", "Text align", "Vertical align",
    "Layers", "Align", "Flip", "Grouping",
  ]);
  wired.panel.dispose();
});

test("a half-wired actions object drops only the buttons it lacks", () => {
  // The align row is align + distribute; a host with one and not the other gets
  // the six buttons it can honour and none of the two it cannot.
  const m = mount({}, { actions: { align() {} } });
  const labels = byClass(m.root(), "xdp-label").map((n) => n.textContent);
  expect(labels).toContain("Align");
  expect(labels).not.toContain("Layers");
  expect(labels).not.toContain("Flip");
  expect(controlsOf(groupNamed(m.root(), "Align"))).toHaveLength(6);
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
  expect(fillOf(custom).style.background).toBe("#123456");
  // And none of the presets claims it — a swatch that lit up for a colour it
  // does not hold would be a lie about what clicking it would do.
  const presets = controlsOf(groupNamed(m.root(), "Stroke"))
    .filter((n) => n.classes.has("xdp-swatch") && !n.classes.has("xdp-custom"));
  expect(presets).toHaveLength(STROKE_COLORS.length);
  expect(presets.filter((b) => b.classes.has("on"))).toHaveLength(0);
  m.panel.dispose();
});

test("a swatch shows its colour on a child, not on the button", () => {
  // The button carries the border and the selected ring; the child carries the
  // colour, and only the child goes through the preview filter. Filtering the
  // button would invert the ring along with the colour.
  const m = mount();
  const red = byLabel(m.root(), "Stroke: Red");
  expect(fillOf(red).style.background).toBe("#e03131");
  expect(red.style.background).toBeUndefined();
  // Transparent has no colour to show, so the button's checkerboard — which is
  // a pattern for "nothing here", not a colour — shows through unfiltered.
  const none = byLabel(m.root(), "Background: Transparent");
  expect(none.classes.has("xdp-none")).toBe(true);
  expect(fillOf(none).style.background).toBeUndefined();
  m.panel.dispose();
});

test("a dark-themed drawing previews its colours the way it will paint them", () => {
  // The value written to the file does not change — #1e1e1e is still #1e1e1e,
  // which is what Excalidraw writes — but a dark theme paints every colour
  // through invert/hue-rotate, so a swatch showing the raw value advertises a
  // colour that appears nowhere on the canvas.
  const m = mount({}, { theme: "dark" });
  expect(m.root().style.getPropertyValue("--xd-doc-filter")).toBe(THEME_FILTER);
  expect(fillOf(byLabel(m.root(), "Stroke: Black")).style.background).toBe("#1e1e1e");

  // The host switching theme under the panel — which is the only way it ever
  // changes, since the panel has no control for it.
  m.setTheme("light");
  m.panel.refresh();
  expect(m.root().style.getPropertyValue("--xd-doc-filter")).toBe("");
  m.panel.dispose();
});

test("a panel with no theme to read asks for no preview filter", () => {
  const m = mount();
  expect(m.root().style.getPropertyValue("--xd-doc-filter")).toBe("");
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

// --- Mixed multi-selection ---------------------------------------------------

test("a mixed selection presses nothing rather than the first element's value", () => {
  // The whole bug: a red rectangle and a blue one showed red pressed, so the
  // button was already "on" and clicking it silently rewrote both.
  const m = mount({}, {
    styles: [
      { strokeColor: "#e03131", strokeWidth: 2, roughness: 1, roundness: { type: 3 } },
      { strokeColor: "#1971c2", strokeWidth: 4, roughness: 1, roundness: null },
    ],
  });
  const root = m.root();
  const pressed = (label) => byLabel(root, label).getAttribute("aria-pressed");

  expect(pressed("Stroke: Red")).toBe("false");
  expect(pressed("Stroke: Blue")).toBe("false");
  expect(pressed("Stroke width: Bold")).toBe("false");
  expect(pressed("Stroke width: Extra bold")).toBe("false");
  expect(pressed("Edges: Round")).toBe("false");
  expect(pressed("Edges: Sharp")).toBe("false");
  // And what they agree on still shows.
  expect(pressed("Sloppiness: Artist")).toBe("true");

  const anyOn = (label) => controlsOf(groupNamed(root, label))
    .filter((b) => b.classes.has("on")).length;
  expect(anyOn("Stroke width")).toBe(0);
  expect(anyOn("Edges")).toBe(0);
  m.panel.dispose();
});

test("a mixed colour does not light up the custom swatch either", () => {
  // It used to light up for any non-preset value, so a disagreement looked like
  // a deliberate custom colour — and showed whatever the first element had.
  const m = mount({}, {
    styles: [{ strokeColor: "#e03131" }, { strokeColor: "#1971c2" }],
  });
  const custom = byLabel(m.root(), "Stroke: custom color");
  expect(custom.classes.has("on")).toBe(false);
  expect(custom.classes.has("xdp-none")).toBe(true);
  expect(fillOf(custom).style.background).toBe("");
  m.panel.dispose();
});

test("a mixed opacity says so, since a slider has nowhere indeterminate to sit", () => {
  const m = mount({}, { styles: [{ opacity: 30 }, { opacity: 100 }] });
  const range = byLabel(m.root(), "Opacity");
  expect(range.getAttribute("aria-valuetext")).toBe("Mixed");
  expect(range.value).toBe(String(DEFAULT_STYLE.opacity));
  m.panel.dispose();
});

test("one style in the list is not a disagreement with itself", () => {
  const m = mount({}, { styles: [{ strokeColor: "#2f9e44" }] });
  expect(byLabel(m.root(), "Stroke: Green").getAttribute("aria-pressed")).toBe("true");
  m.panel.dispose();
});

test("a key absent from the style still falls back to the default", () => {
  // Two things that both arrive as "no value" and mean opposite things: a hole
  // in the source object falls back, a disagreement does not.
  const m = mount({});
  expect(byLabel(m.root(), "Stroke width: Bold").getAttribute("aria-pressed")).toBe("true");
  m.setStyles([{ strokeWidth: 2 }, { strokeWidth: 4 }]);
  m.panel.refresh();
  expect(byLabel(m.root(), "Stroke width: Bold").getAttribute("aria-pressed")).toBe("false");
  m.panel.dispose();
});

// --- Per-type gating ---------------------------------------------------------

test("a text selection hides the rows that would do nothing to it", () => {
  const m = mount({ backgroundColor: "#ffc9c9" }, { kinds: ["text"] });
  const root = m.root();
  const hidden = (label) => groupNamed(root, label).hidden;
  expect(hidden("Sloppiness")).toBe(true);
  expect(hidden("Edges")).toBe(true);
  expect(hidden("Stroke style")).toBe(true);
  expect(hidden("Stroke width")).toBe(true);
  expect(hidden("Background")).toBe(true);
  expect(hidden("Fill")).toBe(true);
  expect(hidden("Font size")).toBe(false);
  expect(hidden("Text align")).toBe(false);
  expect(hidden("Vertical align")).toBe(false);
  expect(hidden("Stroke")).toBe(false);
  expect(hidden("Opacity")).toBe(false);

  // Live, not decided once at mount: selecting a rectangle brings them back.
  m.setKinds(["rectangle"]);
  m.panel.refresh();
  expect(hidden("Sloppiness")).toBe(false);
  expect(hidden("Edges")).toBe(false);
  expect(hidden("Font size")).toBe(true);
  expect(hidden("Text align")).toBe(true);
  m.panel.dispose();
});

test("the arrowhead rows appear only for an arrow", () => {
  const m = mount({}, { kinds: ["rectangle"] });
  expect(groupNamed(m.root(), "Arrow end").hidden).toBe(true);
  m.setKinds(["arrow"]);
  m.panel.refresh();
  expect(groupNamed(m.root(), "Arrow end").hidden).toBe(false);
  expect(groupNamed(m.root(), "Arrow start").hidden).toBe(false);
  // An arrow has no corners to round and no background to fill.
  expect(groupNamed(m.root(), "Edges").hidden).toBe(true);
  m.panel.dispose();
});

test("fill needs both a fillable kind and a background", () => {
  const m = mount({ backgroundColor: "#ffc9c9" }, { kinds: ["ellipse"] });
  expect(groupNamed(m.root(), "Fill").hidden).toBe(false);
  m.set({ backgroundColor: TRANSPARENT });
  m.panel.refresh();
  expect(groupNamed(m.root(), "Fill").hidden).toBe(true);
  m.panel.dispose();
});

test("a host that cannot say what is selected still sees every row", () => {
  // The select tool with a selection and no getKinds: nothing tells the panel
  // what it is looking at, so it shows everything rather than guessing.
  const m = mount({ backgroundColor: "#ffc9c9" }, { tool: "selection" });
  for (const label of ["Sloppiness", "Edges", "Font size", "Arrow end", "Fill"]) {
    expect(groupNamed(m.root(), label).hidden).toBe(false);
  }
  m.panel.dispose();
});

// --- Arrowheads, text align, freedraw width ---------------------------------

test("the arrowhead rows write the field the format wants", () => {
  const m = mount({}, { kinds: ["arrow"] });
  fire(byLabel(m.root(), "Arrow end: Triangle"), "click");
  fire(byLabel(m.root(), "Arrow start: None"), "click");
  fire(byLabel(m.root(), "Arrow end: Diamond"), "click");
  expect(m.patches).toEqual([
    { endArrowhead: "triangle" },
    // Not the string "none" — an element carrying that is one Excalidraw would
    // never write.
    { startArrowhead: null },
    { endArrowhead: "diamond" },
  ]);
  m.panel.dispose();
});

test("an arrow with no endArrowhead shows the arrow the renderer draws", () => {
  const m = mount({}, { kinds: ["arrow"] });
  expect(byLabel(m.root(), "Arrow end: Arrow").getAttribute("aria-pressed")).toBe("true");
  expect(byLabel(m.root(), "Arrow start: None").getAttribute("aria-pressed")).toBe("true");
  m.panel.dispose();
});

test("the text align rows emit the keys the pipeline has to carry", () => {
  const m = mount({}, { kinds: ["text"] });
  fire(byLabel(m.root(), "Text align: Center"), "click");
  fire(byLabel(m.root(), "Vertical align: Middle"), "click");
  expect(m.patches).toEqual([{ textAlign: "center" }, { verticalAlign: "middle" }]);
  m.panel.dispose();
});

test("the width buttons halve themselves for a freedraw selection", () => {
  const m = mount({ strokeWidth: 1 }, { kinds: ["freedraw"] });
  // 1 px on a freedraw is Excalidraw's "medium", not its "thin".
  expect(byLabel(m.root(), "Stroke width: Bold").getAttribute("aria-pressed")).toBe("true");
  expect(byLabel(m.root(), "Stroke width: Thin").getAttribute("aria-pressed")).toBe("false");

  fire(byLabel(m.root(), "Stroke width: Extra bold"), "click");
  expect(m.patches).toEqual([{ strokeWidth: 2 }]);

  // And a rectangle gets the ordinary table from the same buttons.
  m.setKinds(["rectangle"]);
  m.panel.refresh();
  fire(byLabel(m.root(), "Stroke width: Extra bold"), "click");
  expect(m.patches[1]).toEqual({ strokeWidth: 4 });
  m.panel.dispose();
});

// --- Sloppiness re-seed ------------------------------------------------------

test("a sloppiness change asks for a new sketch, as one undo entry", () => {
  // Without the re-roll, rough.js multiplies the same random draws by the new
  // roughness: one sketch at three weights rather than three different hands.
  // The hint rides with the patch so the roughness and the seed land together —
  // an undo between them would leave the new roughness on the old seed.
  const m = mount();
  fire(byLabel(m.root(), "Sloppiness: Cartoonist"), "click");
  expect(m.patches).toEqual([{ roughness: 2 }]);
  expect(m.opts[0]).toEqual({ resketch: true });

  // With nothing selected this is a preference for the next shape, and that
  // shape is minted with a fresh seed anyway.
  m.select(false);
  m.setTool("rectangle");
  m.panel.refresh();
  fire(byLabel(m.root(), "Sloppiness: Artist"), "click");
  expect(m.opts[1]).toEqual({ resketch: false });
  m.panel.dispose();
});

test("only the sloppiness row asks to re-sketch", () => {
  const m = mount();
  fire(byLabel(m.root(), "Stroke width: Thin"), "click");
  expect(m.opts[0]).toBeUndefined();
  m.panel.dispose();
});

test("a host with a reseed callback gets that instead of the hint", () => {
  // Suppressed rather than sent as well, so the seed is never re-rolled twice.
  let seeds = 0;
  const m = mount({}, { reseed: () => { seeds += 1; } });
  fire(byLabel(m.root(), "Sloppiness: Cartoonist"), "click");
  expect(seeds).toBe(1);
  expect(m.opts[0]).toEqual({ resketch: false });

  m.select(false);
  m.panel.refresh();
  fire(byLabel(m.root(), "Sloppiness: Artist"), "click");
  expect(seeds).toBe(1);
  m.panel.dispose();
});

// --- The verbs ---------------------------------------------------------------

test("the layers row calls reorder with the four directions", () => {
  const calls = [];
  const m = mount({}, { actions: { reorder: (how) => calls.push(how) } });
  for (const label of ["Send to back", "Send backward", "Bring forward", "Bring to front"]) {
    fire(byLabel(m.root(), `Layers: ${label}`), "click");
  }
  expect(calls).toEqual(["back", "backward", "forward", "front"]);
  m.panel.dispose();
});

test("align, distribute and flip pass the edge and the axis through", () => {
  // These exact strings are what `ops::Edge::parse` and `ops::Axis::parse`
  // accept (`crates/xd-core/src/ops.rs:277-282`). An unknown one is a deliberate
  // no-op in the core rather than a scrambled drawing, which makes a typo here
  // silent — hence pinning them.
  const calls = [];
  const m = mount({}, {
    kinds: ["rectangle", "ellipse", "diamond"],
    actions: {
      align: (e) => calls.push(["align", e]),
      distribute: (a) => calls.push(["distribute", a]),
      flip: (a) => calls.push(["flip", a]),
    },
  });
  fire(byLabel(m.root(), "Align: Align left"), "click");
  fire(byLabel(m.root(), "Align: Center vertically"), "click");
  fire(byLabel(m.root(), "Align: Distribute horizontally"), "click");
  fire(byLabel(m.root(), "Flip: Flip vertically"), "click");
  expect(calls).toEqual([
    ["align", "left"], ["align", "centerV"],
    ["distribute", "horizontal"], ["flip", "vertical"],
  ]);
  m.panel.dispose();
});

test("align wants two elements and distribute wants three", () => {
  // The core's own guards: `ops::align` returns no_change below 2 and
  // `ops::distribute` below 3 (`crates/xd-core/src/ops.rs:349,385`), and
  // `ops::flip` takes one — a single element flips in place. Enabling a button
  // the model will refuse is a button that does nothing. Dimmed rather than
  // absent, so the row keeps its shape and the user learns what it wants.
  const m = mount({}, {
    kinds: ["rectangle"],
    actions: { align() {}, distribute() {}, group() {}, ungroup() {} },
  });
  const btn = (label) => byLabel(m.root(), label);
  expect(btn("Align: Align left").disabled).toBe(true);
  expect(btn("Align: Distribute horizontally").disabled).toBe(true);
  expect(btn("Grouping: Group").disabled).toBe(true);
  // Ungroup takes one, because clicking inside a group selects a single member.
  expect(btn("Grouping: Ungroup").disabled).toBe(false);

  m.setKinds(["rectangle", "ellipse"]);
  m.panel.refresh();
  expect(btn("Align: Align left").disabled).toBe(false);
  expect(btn("Align: Distribute horizontally").disabled).toBe(true);
  expect(btn("Grouping: Group").disabled).toBe(false);

  m.setKinds(["rectangle", "ellipse", "diamond"]);
  m.panel.refresh();
  expect(btn("Align: Distribute horizontally").disabled).toBe(false);
  m.panel.dispose();
});

test("a disabled verb does nothing when clicked", () => {
  const calls = [];
  const m = mount({}, { kinds: ["rectangle"], actions: { align: () => calls.push(1) } });
  fire(byLabel(m.root(), "Align: Align left"), "click");
  expect(calls).toEqual([]);
  m.panel.dispose();
});

test("the verb rows are hidden with nothing selected", () => {
  // The panel is showing defaults for the next shape; there is nothing to
  // reorder or flip.
  const m = mount({}, {
    selection: false, tool: "rectangle", kinds: [],
    actions: { reorder() {}, flip() {} },
  });
  expect(groupNamed(m.root(), "Layers").hidden).toBe(true);
  expect(groupNamed(m.root(), "Flip").hidden).toBe(true);
  m.select(true);
  m.setKinds(["rectangle"]);
  m.panel.refresh();
  expect(groupNamed(m.root(), "Layers").hidden).toBe(false);
  m.panel.dispose();
});

test("every verb button is named and reachable, like every other control", () => {
  const m = mount({}, {
    canvas: "#ffffff",
    actions: { reorder() {}, align() {}, distribute() {}, flip() {}, group() {}, ungroup() {} },
  });
  for (const b of [...walk(m.root())].filter((n) => n.tagName === "BUTTON")) {
    expect(b.type).toBe("button");
    expect(b.title).toBeTruthy();
    expect(b.getAttribute("aria-label")).toBeTruthy();
  }
  m.panel.dispose();
});

// --- Canvas background -------------------------------------------------------

test("the canvas row writes through its own callback, not setStyle", () => {
  // viewBackgroundColor is appState, not a field on any element, so a patch
  // through setStyle would be written onto every selected shape.
  const m = mount({}, { canvas: "#ffffff" });
  fire(byLabel(m.root(), "Canvas: Pale yellow"), "click");
  expect(m.canvas()).toBe("#fffce8");
  expect(m.patches).toEqual([]);
  m.panel.dispose();
});

test("the canvas row marks the colour the drawing currently has", () => {
  const m = mount({}, { canvas: "#f5faff" });
  expect(byLabel(m.root(), "Canvas: Pale blue").getAttribute("aria-pressed")).toBe("true");
  expect(byLabel(m.root(), "Canvas: White").getAttribute("aria-pressed")).toBe("false");
  m.panel.dispose();
});

test("the canvas row survives a selection that hides everything else", () => {
  // It is a property of the drawing, so nothing about the selection can hide it.
  const m = mount({}, { canvas: "#ffffff", kinds: ["text"] });
  expect(groupNamed(m.root(), "Canvas").hidden).toBe(false);
  m.panel.dispose();
});

// --- Theme -------------------------------------------------------------------

test("the panel offers no theme control, however much it knows about the theme", () => {
  // A theme is a property of who is looking, so the window owns it and there is
  // one control for it — the appearance segment in the app's menu. A second one
  // down here could only ever disagree with the first, and did: the sidebar wrote
  // `appState.theme` while the window filtered the canvas in CSS, so a drawing
  // could be dark twice over. The panel reads the theme and shows no row for it.
  for (const theme of [null, "light", "dark"]) {
    const m = mount({}, theme == null ? {} : { theme, kinds: ["rectangle"] });
    expect(byClass(m.root(), "xdp-label").map((n) => n.textContent)).not.toContain("Theme");
    m.panel.dispose();
  }
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
