// The properties island — stroke, background, fill, width, style, sloppiness,
// edges, opacity, and the two text controls.
//
// This is the panel that floats over the left edge of the canvas in
// Excalidraw, and it is deliberately a *copy* of that panel rather than a
// design of our own. Every value below is one of Excalidraw's own: the five
// stroke colors, the five background colors, `strokeWidth` of 1/2/4,
// `roughness` of 0/1/2, `roundness: null` versus `{ type: 3 }`. The reason is
// the whole compatibility story — a file edited here and reopened at
// excalidraw.com must not look like it passed through a different app, and the
// cheapest way to guarantee that is to never offer a value Excalidraw cannot
// round-trip. Anything not in these tables is reachable only through the
// custom color picker, which writes a plain CSS color string, which the format
// already allows.
//
// Two structural decisions worth knowing before reading the code:
//
//   - The tables are exported. Everything decidable without a DOM — what the
//     values are, whether the fill group should be visible, whether the panel
//     should be on screen at all — lives in a pure function above the render
//     code, so `bun test` can pin it without standing up a browser. The rest
//     of ui/test/ already works that way (excalidrawChrome.test.js drives a
//     recording context; contract.test.js counts listeners on a stub) and this
//     follows the same habit rather than inventing a second one.
//
//   - The DOM is built once and then *synced*, never rebuilt. `refresh()` is
//     called on every selection change — potentially mid-drag — so it may not
//     take focus away from a button the keyboard is on, and it may not tear
//     down the swatch the open color picker is anchored to. Syncing attributes
//     on nodes that already exist is what makes both of those true for free.
import { openColorPicker, closeColorPicker } from "./colorpicker.js";
import { el, div } from "./dom.js";
import { setPressed } from "./a11y.js";

// --- The value tables --------------------------------------------------------
//
// Excalidraw's palettes, in Excalidraw's order. The hexes are lowercase and
// six-digit because that is what its own picker writes into the file, and a
// file that differs from Excalidraw's output only in the *spelling* of a color
// is a diff nobody wants to read.

export const TRANSPARENT = "transparent";

export const STROKE_COLORS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];

export const BACKGROUND_COLORS = [TRANSPARENT, "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];

/// Human names for the swatches. A row of unlabelled colored squares is
/// unusable with a screen reader and merely guessable with a mouse, so every
/// swatch gets one of these as its `title` and as part of its `aria-label`.
const COLOR_NAMES = {
  [TRANSPARENT]: "Transparent",
  "#1e1e1e": "Black", "#e03131": "Red", "#2f9e44": "Green",
  "#1971c2": "Blue", "#f08c00": "Orange",
  "#ffc9c9": "Pink", "#b2f2bb": "Mint", "#a5d8ff": "Sky", "#ffec99": "Butter",
};

export const FILL_STYLES = [
  { value: "hachure", label: "Hachure" },
  { value: "cross-hatch", label: "Cross-hatch" },
  { value: "solid", label: "Solid" },
];

export const STROKE_WIDTHS = [
  { value: 1, label: "Thin" },
  { value: 2, label: "Bold" },
  { value: 4, label: "Extra bold" },
];

export const STROKE_STYLES = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

/// `roughness`, which the UI has always called sloppiness because the numbers
/// mean nothing to anyone drawing a diagram.
export const SLOPPINESS = [
  { value: 0, label: "Architect" },
  { value: 1, label: "Artist" },
  { value: 2, label: "Cartoonist" },
];

/// `roundness` is the odd one out: not a scalar but `null` or an object, so the
/// buttons carry a key and `roundnessFor` turns it back into the field value.
/// `{ type: 3 }` is Excalidraw's ADAPTIVE_RADIUS — the one it writes for every
/// round-edged shape — and inventing a different type here would produce
/// corners that look right in our renderer and wrong in theirs.
export const EDGES = [
  { value: "sharp", label: "Sharp" },
  { value: "round", label: "Round" },
];

export const FONT_SIZES = [
  { value: 16, label: "S", title: "Small" },
  { value: 20, label: "M", title: "Medium" },
  { value: 28, label: "L", title: "Large" },
  { value: 36, label: "XL", title: "Extra large" },
];

/// Excalidraw's font family ids. 5 is Excalifont (the current hand-drawn
/// face), 2 Nunito, 3 Comic Shanns. The numbers are not sequential by design
/// and are not ours to renumber: they are what lands in the file.
export const FONT_FAMILIES = [
  { value: 5, label: "Hand-drawn" },
  { value: 2, label: "Normal" },
  { value: 3, label: "Code" },
];

/// What a missing key renders as. Excalidraw's own defaults for a fresh
/// document, so a style object with holes in it — a mixed multi-selection, or
/// an element from a file that predates a field — shows something sensible
/// rather than a row with nothing pressed.
export const DEFAULT_STYLE = {
  strokeColor: "#1e1e1e",
  backgroundColor: TRANSPARENT,
  fillStyle: "hachure",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  fontSize: 20,
  fontFamily: 5,
  roundness: null,
};

// --- The pure decisions ------------------------------------------------------

/// `backgroundColor` is "transparent" for the overwhelming majority of
/// elements, but a file written by another tool may spell it as a
/// fully-transparent color or leave it out entirely. All three mean the same
/// thing to a user looking at the shape, so all three answer true.
export function isTransparent(color) {
  if (color == null) return true;
  const c = String(color).trim().toLowerCase();
  return c === "" || c === TRANSPARENT || c === "#00000000" || c === "transparent";
}

/// Excalidraw's own rule: the fill group only exists when there is something to
/// fill. Hiding it is not decoration — a hachure/solid choice on a shape with
/// no background changes a field the user cannot see the effect of.
export function showsFill(style) {
  return !isTransparent(style?.backgroundColor);
}

export function edgeKey(roundness) {
  return roundness ? "round" : "sharp";
}

export function roundnessFor(key) {
  return key === "round" ? { type: 3 } : null;
}

/// Whether the island belongs on screen at all.
///
/// A properties panel over an empty canvas with the select tool active is a
/// panel about nothing, sitting on top of the drawing. So in that one case the
/// panel renders *nothing* — not a collapsed strip, not an empty island — and
/// gives the pane back to the picture. Every other combination shows it: a
/// selection has properties to edit, and a drawing tool has defaults to set
/// before the first drag.
///
/// `tool` is optional because the editor's contract does not carry it. When it
/// is absent the answer is "show", which is the safe direction: a panel that
/// is present when it could have been hidden is untidy, one that is missing
/// when the user has a shape selected is broken.
export function panelShown({ hasSelection, tool } = {}) {
  if (hasSelection) return true;
  return !isSelectTool(tool);
}

function isSelectTool(tool) {
  // "selection" is Excalidraw's own name for it; "select" is the shorter name
  // a tool state machine tends to reach for. Accept both rather than making
  // the caller guess which spelling this module wanted.
  return tool === "selection" || tool === "select";
}

// --- Icons -------------------------------------------------------------------
//
// Static inline SVG, set through innerHTML — the one exception to this
// codebase's textContent rule, and the same exception dom.js's CHECK_SVG and
// viewActions.js's ICON table already take. Nothing here is interpolated.
//
// The icons matter more than they look like they should: "thin/bold/extra
// bold" and "solid/dashed/dotted" are three-way choices where the label is
// longer than the thing it describes, and a drawn line says it instantly.
// Every button still carries the words in `title` and `aria-label`, so nothing
// is only available to someone who can see the glyph.

const svg = (body) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" ' +
  'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + "</svg>";

const ICONS = {
  fill: {
    hachure: svg('<rect x="3.5" y="3.5" width="13" height="13" rx="2" />'
      + '<path d="M5 12.5l7.5 -7.5M8 15.5l7 -7" />'),
    "cross-hatch": svg('<rect x="3.5" y="3.5" width="13" height="13" rx="2" />'
      + '<path d="M5 12.5l7.5 -7.5M8 15.5l7 -7M5 7.5l7.5 7.5M8 4.5l7 7" />'),
    solid: svg('<rect x="3.5" y="3.5" width="13" height="13" rx="2" fill="currentColor" />'),
  },
  width: {
    1: svg('<path d="M3.5 10h13" stroke-width="1" />'),
    2: svg('<path d="M3.5 10h13" stroke-width="2.5" />'),
    4: svg('<path d="M3.5 10h13" stroke-width="4" />'),
  },
  style: {
    solid: svg('<path d="M3.5 10h13" stroke-width="2" />'),
    dashed: svg('<path d="M3.5 10h13" stroke-width="2" stroke-dasharray="4.5 3" />'),
    dotted: svg('<path d="M3.5 10h13" stroke-width="2" stroke-dasharray="0.1 3.5" />'),
  },
  sloppiness: {
    0: svg('<path d="M3.5 12.5q6.5 -6 13 -4" />'),
    1: svg('<path d="M3.5 12.5q3 -4 6 -2.5t3.5 -2.5 3.5 1" />'),
    2: svg('<path d="M3.5 13q2 -5 4 -1.5t2.5 -5 2.5 4 3.5 -3.5" />'),
  },
  edges: {
    sharp: svg('<path d="M4 16.5v-13h12.5" />'),
    round: svg('<path d="M4 16.5v-7a6 6 0 0 1 6 -6h6.5" />'),
  },
  family: {
    5: svg('<path d="M4 16l1 -4 8.5 -8.5 3 3 -8.5 8.5z" /><path d="M12 5.5l3 3" />'),
    2: svg('<path d="M4 16.5l6 -13 6 13" /><path d="M6.5 11.5h7" />'),
    3: svg('<path d="M7 5.5l-4 4.5 4 4.5" /><path d="M13 5.5l4 4.5 -4 4.5" />'),
  },
};

// --- The panel ---------------------------------------------------------------

/// A drag on the picker's SV square emits on every pointermove. Each apply is
/// a command on the document's undo stack, so they are coalesced to this
/// window — enough for live feedback on the canvas, few enough that ⌘Z isn't a
/// hundred shades deep. Same number, and the same reason, as term.hut's
/// bpmnColors.js.
const APPLY_MS = 120;

/// The stylesheet lives beside this module rather than in the app's own, so
/// the port is a copy of two files instead of a copy of one plus a diff
/// against a stylesheet term.hut already owns. Injected once, keyed by id and
/// by href so a host that links it in its own HTML gets a no-op here, and
/// deliberately *not* removed on dispose: a second panel mounting after the
/// first tore down would otherwise arrive unstyled.
const STYLE_ID = "xd-props-css";

function ensureStylesheet() {
  const doc = globalThis.document;
  if (!doc?.head || typeof doc.createElement !== "function") return;
  if (doc.getElementById?.(STYLE_ID)) return;
  const href = new URL("./excalidrawProps.css", import.meta.url).href;
  for (const link of doc.querySelectorAll?.('link[rel="stylesheet"]') ?? []) {
    if (link.href === href) return;
  }
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = href;
  doc.head.appendChild(link);
}

/// Mount the properties island into `host`.
///
///   renderProps(host, { getStyle, setStyle, hasSelection, activeTool })
///     -> { refresh(), dispose() }
///
/// `getStyle()` returns the style to display, with any key possibly missing.
/// `setStyle(patch)` takes a *partial* style — exactly the keys that changed,
/// which is what lets the editor turn one click into one undo entry instead of
/// a wholesale overwrite of ten fields. `hasSelection()` only chooses the
/// heading; the controls are identical either way, because "the style of the
/// thing I have selected" and "the style of the next thing I draw" are the
/// same ten fields and a panel that reshuffled between them would be a panel
/// nobody could learn.
///
/// `activeTool` is optional and may be a string or a function returning one;
/// see `panelShown` for what it decides.
export function renderProps(host, { getStyle, setStyle, hasSelection, activeTool } = {}) {
  if (!host) return { refresh() {}, dispose() {} };
  ensureStylesheet();

  const offs = [];   // every listener added, paired with its removal
  const syncs = [];  // every control's "read the style, repaint yourself"
  let pickerOpen = false;
  let applyTimer = null;
  let disposed = false;

  /// addEventListener with its undo recorded at the same moment. The whole
  /// subtree is dropped on dispose so most of these die with their nodes, but
  /// the bookkeeping is the point — contract.test.js counts adds against
  /// removes, and a panel that leaked one would be indistinguishable from a
  /// panel that leaked ten.
  const on = (node, type, fn, opts) => {
    node.addEventListener(type, fn, opts);
    offs.push(() => node.removeEventListener(type, fn, opts));
  };

  const style = () => ({ ...DEFAULT_STYLE, ...(getStyle?.() ?? {}) });
  const emit = (patch) => setStyle?.(patch);

  // --- Group construction ----------------------------------------------------

  /// A labelled row. `role="group"` with `aria-labelledby` rather than a bare
  /// `<div>`, so a screen reader reading the third button in the fourth row
  /// says "Dashed, Stroke style" instead of "Dashed".
  let seq = 0;
  function group(label) {
    const node = div("xdp-group");
    node.setAttribute("role", "group");
    const title = div("xdp-label", label);
    title.id = `xdp-l${++seq}-${Math.random().toString(36).slice(2, 7)}`;
    node.setAttribute("aria-labelledby", title.id);
    const row = div("xdp-row");
    node.appendChild(title);
    node.appendChild(row);
    return { node, row };
  }

  /// One row of mutually-exclusive buttons over a single style field.
  ///
  /// `read` pulls the current key out of the style object and `write` turns a
  /// chosen key back into the patch, which is what lets `roundness` — the one
  /// field that is an object rather than a scalar — use the same code as the
  /// eight that aren't.
  function choiceGroup(label, field, options, {
    read = (s) => s[field],
    write = (value) => ({ [field]: value }),
    icons = null,
    text = false,
  } = {}) {
    const { node, row } = group(label);
    const buttons = options.map((opt) => {
      const b = el("button", "xdp-btn");
      b.type = "button";
      const name = opt.title ?? opt.label;
      b.title = name;
      b.setAttribute("aria-label", `${label}: ${name}`);
      if (text) b.textContent = opt.label;
      else if (icons) b.innerHTML = icons[opt.value];
      else b.textContent = opt.label;
      setPressed(b, false);
      on(b, "click", () => emit(write(opt.value)));
      row.appendChild(b);
      return b;
    });
    syncs.push((s) => {
      const current = read(s);
      options.forEach((opt, i) => {
        const active = opt.value === current;
        setPressed(buttons[i], active);
        buttons[i].classList.toggle("on", active);
      });
    });
    return node;
  }

  /// A row of color swatches plus the custom entry.
  ///
  /// The custom button hands off to `colorpicker.js` — the app's one color UI,
  /// the same popover the code editor opens on a hex literal — rather than
  /// growing a second one here. It stays open across changes on purpose: a
  /// drag on the SV square is a stream of colors and the user wants to see
  /// each on the canvas, which is what the debounce below is for.
  function colorGroup(label, field, presets) {
    const { node, row } = group(label);
    const swatches = presets.map((color) => {
      const b = el("button", "xdp-swatch");
      b.type = "button";
      const name = COLOR_NAMES[color] ?? color;
      b.title = name;
      b.setAttribute("aria-label", `${label}: ${name}`);
      if (isTransparent(color)) b.classList.add("xdp-none");
      else b.style.background = color;
      setPressed(b, false);
      on(b, "click", () => emit({ [field]: color }));
      row.appendChild(b);
      return b;
    });

    row.appendChild(div("xdp-sep"));

    const custom = el("button", "xdp-swatch xdp-custom");
    custom.type = "button";
    custom.title = "Custom…";
    custom.setAttribute("aria-label", `${label}: custom color`);
    on(custom, "click", () => {
      let pending = null;
      const flush = () => {
        applyTimer = null;
        if (pending != null) emit({ [field]: pending });
        pending = null;
      };
      pickerOpen = true;
      openColorPicker({
        anchor: custom.getBoundingClientRect(),
        color: isTransparent(style()[field]) ? "#ffffff" : style()[field],
        onChange: (text) => {
          pending = text;
          if (applyTimer == null) applyTimer = setTimeout(flush, APPLY_MS);
        },
        // The last move may still be sitting in the debounce when the picker
        // closes; without this the committed color isn't the one on screen.
        onClose: () => {
          pickerOpen = false;
          clearTimeout(applyTimer);
          flush();
        },
      });
    });
    row.appendChild(custom);

    syncs.push((s) => {
      const current = s[field];
      swatches.forEach((b, i) => {
        const active = presets[i] === current
          || (isTransparent(presets[i]) && isTransparent(current));
        setPressed(b, active);
        b.classList.toggle("on", active);
      });
      const preset = presets.some((c) => c === current
        || (isTransparent(c) && isTransparent(current)));
      custom.classList.toggle("on", !preset);
      if (isTransparent(current)) {
        custom.classList.add("xdp-none");
        custom.style.background = "";
      } else {
        custom.classList.remove("xdp-none");
        custom.style.background = current;
      }
    });
    return node;
  }

  /// Opacity, the one continuous field. A range rather than five buttons
  /// because it is the only style here whose in-between values are meaningful,
  /// and stepped by 10 because Excalidraw's own is — a file with opacity 37 in
  /// it is a file that came from somewhere else.
  function opacityGroup() {
    const { node, row } = group("Opacity");
    const input = el("input", "xdp-range");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "10";
    input.title = "Opacity";
    input.setAttribute("aria-label", "Opacity");
    // Live, on every drag frame: the value only means something against the
    // shape it is changing. The editor coalesces the commands.
    on(input, "input", () => emit({ opacity: Number(input.value) }));
    row.appendChild(input);
    syncs.push((s) => {
      const v = String(s.opacity);
      // Guarded, because writing `value` on the element the user is dragging
      // fights the drag — and refresh() runs on every selection change.
      if (input.value !== v) input.value = v;
      input.setAttribute("aria-valuetext", `${s.opacity}%`);
    });
    return node;
  }

  // --- The island ------------------------------------------------------------

  const root = div("xdp-island");
  root.setAttribute("role", "region");
  const heading = div("xdp-title");
  heading.id = `xdp-title-${Math.random().toString(36).slice(2, 8)}`;
  root.setAttribute("aria-labelledby", heading.id);
  root.appendChild(heading);

  root.appendChild(colorGroup("Stroke", "strokeColor", STROKE_COLORS));
  root.appendChild(colorGroup("Background", "backgroundColor", BACKGROUND_COLORS));

  // Held by name because it is the one group that comes and goes.
  const fillGroup = choiceGroup("Fill", "fillStyle", FILL_STYLES, { icons: ICONS.fill });
  root.appendChild(fillGroup);

  root.appendChild(choiceGroup("Stroke width", "strokeWidth", STROKE_WIDTHS, {
    icons: ICONS.width,
  }));
  root.appendChild(choiceGroup("Stroke style", "strokeStyle", STROKE_STYLES, {
    icons: ICONS.style,
  }));
  root.appendChild(choiceGroup("Sloppiness", "roughness", SLOPPINESS, {
    icons: ICONS.sloppiness,
  }));
  root.appendChild(choiceGroup("Edges", "roundness", EDGES, {
    read: (s) => edgeKey(s.roundness),
    write: (key) => ({ roundness: roundnessFor(key) }),
    icons: ICONS.edges,
  }));
  root.appendChild(opacityGroup());

  // The two text controls are always present, never conditional on the
  // selection being text. Hiding them would make the island change height
  // whenever the selection moved between a label and the box around it, and a
  // panel that jumps under the pointer is worse than two rows that are
  // occasionally inert. Setting a font size with a rectangle selected writes a
  // field Excalidraw itself is happy to carry.
  root.appendChild(choiceGroup("Font size", "fontSize", FONT_SIZES, { text: true }));
  root.appendChild(choiceGroup("Font family", "fontFamily", FONT_FAMILIES, {
    icons: ICONS.family,
  }));

  // --- Attach / sync / detach ------------------------------------------------

  let attached = false;

  function setAttached(want) {
    if (want === attached) return;
    if (want) host.appendChild(root);
    else {
      // Going away takes the picker with it: it is a fixed-position popover
      // anchored to a swatch that is no longer on screen.
      if (pickerOpen) closeColorPicker();
      root.remove?.();
      if (root.parentNode === host) host.removeChild(root);
    }
    attached = want;
  }

  function refresh() {
    if (disposed) return;
    const tool = typeof activeTool === "function" ? activeTool() : activeTool;
    const selected = !!hasSelection?.();
    if (!panelShown({ hasSelection: selected, tool })) {
      setAttached(false);
      return;
    }
    setAttached(true);
    // "Selected" and "New shape" are the only difference between the two
    // states, and it is worth having: without it, setting a default reads as
    // editing a shape that isn't there.
    heading.textContent = selected ? "Selected" : "New shape";
    const s = style();
    for (const sync of syncs) sync(s);
    fillGroup.hidden = !showsFill(s);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(applyTimer);
    applyTimer = null;
    if (pickerOpen) closeColorPicker();
    pickerOpen = false;
    for (const off of offs) off();
    offs.length = 0;
    setAttached(false);
  }

  refresh();
  return { refresh, dispose };
}
