// The properties island — stroke, background, fill, width, style, sloppiness,
// edges, arrowheads, opacity, the four text controls, and the manipulation
// rows (layers, align, distribute, flip, group).
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
//     A group that does not apply to the current selection is `hidden`, not
//     removed, for exactly that reason.
//
// Three things this panel does that are not about style fields at all — the
// layers row, the align/distribute rows and the flip row — are here because
// there is no context menu in this app. Without them every one of z-order,
// group and flip is reachable only from the keyboard, which for a mouse-only
// user means not reachable. They are wired through `actions`, not `setStyle`,
// because none of them is a field on an element.
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

/// Excalidraw's five canvas-background picks (`colors.ts` `canvasColors`). Not
/// a property of any element — `appState.viewBackgroundColor` — which is why it
/// is written through its own callback rather than through `setStyle`.
export const CANVAS_COLORS = ["#ffffff", "#f8f9fa", "#f5faff", "#fffce8", "#fdf8f6"];

/// Human names for the swatches. A row of unlabelled colored squares is
/// unusable with a screen reader and merely guessable with a mouse, so every
/// swatch gets one of these as its `title` and as part of its `aria-label`.
const COLOR_NAMES = {
  [TRANSPARENT]: "Transparent",
  "#1e1e1e": "Black", "#e03131": "Red", "#2f9e44": "Green",
  "#1971c2": "Blue", "#f08c00": "Orange",
  "#ffc9c9": "Pink", "#b2f2bb": "Mint", "#a5d8ff": "Sky", "#ffec99": "Butter",
  "#ffffff": "White", "#f8f9fa": "Off white", "#f5faff": "Pale blue",
  "#fffce8": "Pale yellow", "#fdf8f6": "Pale pink",
};

export const FILL_STYLES = [
  { value: "hachure", label: "Hachure" },
  { value: "cross-hatch", label: "Cross-hatch" },
  { value: "solid", label: "Solid" },
];

/// Stroke width carries a *key* as well as a px value, because the px a key
/// resolves to depends on what is selected. Excalidraw's buttons are keyed and
/// go through `getStrokeWidthByKey` (`constants.ts:430-446`), which maps
/// freedraw to half the usual number — the schema-2.0 back-compat halving. Two
/// things go wrong if you skip it, and both did: every pencil stroke drawn here
/// was twice as thick as Excalidraw's, and a freedraw element imported *from*
/// Excalidraw (0.5/1/2) matched none of 1/2/4, so the row showed nothing
/// pressed.
///
/// `value` stays the px for an ordinary shape so the icon table and the
/// value-set assertions can stay keyed on it.
export const STROKE_WIDTHS = [
  { value: 1, key: "thin", label: "Thin" },
  { value: 2, key: "medium", label: "Bold" },
  { value: 4, key: "bold", label: "Extra bold" },
];

/// `FREEDRAW_STROKE_WIDTH` (`constants.ts:440-446`).
const FREEDRAW_STROKE_WIDTHS = { thin: 0.5, medium: 1, bold: 2 };

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
/// buttons carry a key and `edgeRoundness` turns it back into the field value.
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

/// `appState.theme`, the two values the renderer reads
/// (`excalidrawView.js`'s `scene?.appState?.theme === "dark"`).
///
/// A document property, not a chrome preference, and the distinction is the
/// whole reason it belongs on something that can write `appState`: Excalidraw's
/// dark theme is a per-colour transform of the *same* file rather than a second
/// palette, so `theme` records which way round the colours in the file are meant
/// to be read. Getting it wrong does not merely look wrong here — it re-inverts
/// on the way out.
export const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export const TEXT_ALIGNS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

export const VERTICAL_ALIGNS = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
];

/// The arrowhead kinds this renderer can actually draw. Excalidraw offers 13,
/// including outlined variants and crowfoot cardinality; offering one we cannot
/// paint would be a control that silently does nothing locally and something
/// else entirely at excalidraw.com.
///
/// Like `roundness`, the field value is not always the button's key: "none" is
/// `null` in the file, so these go through `arrowheadFor` / `arrowheadKey`.
export const ARROWHEADS = [
  { value: "none", label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "bar", label: "Bar" },
  { value: "dot", label: "Dot" },
  { value: "triangle", label: "Triangle" },
  { value: "diamond", label: "Diamond" },
];

/// What a missing key renders as. Excalidraw's `DEFAULT_ELEMENT_PROPS`
/// (`constants.ts:459-468`) and the same values `excalidrawDoc.js`'s
/// `DEFAULT_STYLE` and `xd-core`'s `new_element` use, so a style object with
/// holes in it — an element from a file that predates a field — shows what a
/// freshly drawn shape would show rather than a row with nothing pressed. The
/// two tables disagreed on `strokeWidth` and `fillStyle` until now; only the
/// doc's was live, but this one is the fallback and a fallback that disagrees
/// with the real default is a trap.
///
/// `endArrowhead` is `"arrow"` because that is what the renderer draws for an
/// absent key (`excalidrawView.js`'s `?? "arrow"`) and what Excalidraw defaults
/// it to; `startArrowhead` is `null` for the same reason in reverse.
export const DEFAULT_STYLE = {
  strokeColor: "#1e1e1e",
  backgroundColor: TRANSPARENT,
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  fontSize: 20,
  fontFamily: 5,
  roundness: null,
  textAlign: "left",
  verticalAlign: "top",
  startArrowhead: null,
  endArrowhead: "arrow",
};

// --- The pure decisions ------------------------------------------------------

/// "The selected elements disagree about this field."
///
/// A symbol rather than `undefined` or a string, because it has to be a value
/// no style field can ever hold: `undefined` already means "the source object
/// has no such key", which is a different question with a different answer (the
/// key falls back to `DEFAULT_STYLE`), and every string is a legal color.
///
/// Excalidraw's `getFormValue` returns `null` here and its buttons compare
/// against it, so nothing is pressed (`actionProperties.tsx:687-693`). Ours
/// compares against this and nothing is pressed for the same reason. It matters
/// more than it sounds: the panel used to show the *first* selected element's
/// values as pressed, so selecting a red rectangle and a blue one showed red
/// pressed — a button already in its "on" state that, when clicked, silently
/// rewrote both.
export const MIXED = Symbol("mixed");

/// Two field values agree. `roundness` is an object, so identity is not enough;
/// and absent and explicitly-null both mean "not set" for every field here, so
/// they agree with each other.
function same(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a == null && b == null;
}

/// Fold one style per selected element into the one style the panel shows,
/// marking every key they disagree on `MIXED`.
///
/// A key that only *some* of them carry counts as a disagreement: an element
/// with no `fontSize` and one with `fontSize: 28` do not share a font size, and
/// pressing 28 would claim they did.
export function foldStyles(list) {
  const styles = (Array.isArray(list) ? list : []).filter(
    (s) => s && typeof s === "object",
  );
  if (!styles.length) return {};
  const out = { ...styles[0] };
  for (const s of styles.slice(1)) {
    for (const key of Object.keys(out)) {
      if (out[key] === MIXED) continue;
      if (!same(out[key], s[key])) out[key] = MIXED;
    }
    for (const key of Object.keys(s)) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = MIXED;
    }
  }
  return out;
}

/// `backgroundColor` is "transparent" for the overwhelming majority of
/// elements, but a file written by another tool may spell it as a
/// fully-transparent color or leave it out entirely. All three mean the same
/// thing to a user looking at the shape, so all three answer true.
export function isTransparent(color) {
  if (color == null) return true;
  // A disagreement is not a color, and in particular is not "no color": some
  // of the selection has a background, so the fill row still applies.
  if (color === MIXED) return false;
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
  // Absent and null are both "sharp"; a disagreement is neither, and has to
  // stay a disagreement all the way to the button sync.
  if (roundness === MIXED) return MIXED;
  return roundness ? "round" : "sharp";
}

/// The descriptor the Edges row emits — the *answer*, not the type.
///
/// Deliberately not called `roundnessFor`: `excalidrawDoc.js` owns a function of
/// that name which maps a kind to its roundness *type* (rectangle → 3, diamond
/// and line → 2), and it is the layer that can, because it knows what the patch
/// is landing on. This panel does not: one click reaches a whole selection, and
/// a row of two buttons cannot say "adaptive for the rectangle, proportional for
/// the diamond". So all it answers is round or sharp, and `stylePatch` re-types
/// the descriptor against the actual targets.
///
/// The 3 is therefore a placeholder, and it is 3 rather than 2 because that is
/// what survives the one case `stylePatch` leaves alone — a selection whose kinds
/// want different types — and rectangle, the default shape, is an adaptive one.
export function edgeRoundness(key) {
  return key === "round" ? { type: 3 } : null;
}

/// The px a stroke-width key resolves to. `freehand` is true when every element
/// the patch will land on is a freedraw, which is the only case where the halved
/// table is the right answer for all of them.
export function strokeWidthFor(key, freehand = false) {
  const table = freehand ? FREEDRAW_STROKE_WIDTHS : null;
  if (table && key in table) return table[key];
  return STROKE_WIDTHS.find((o) => o.key === key)?.value ?? DEFAULT_STYLE.strokeWidth;
}

/// Which button a px width lights up. The applicable table first, then the
/// other one — so a freedraw imported from Excalidraw at 0.5 reads as "thin"
/// even before we know it is a freedraw, which is better than a row with
/// nothing pressed.
export function strokeWidthKey(px, freehand = false) {
  if (px === MIXED || px == null) return undefined;
  const n = Number(px);
  const first = freehand ? FREEDRAW_STROKE_WIDTHS : null;
  if (first) {
    for (const [key, value] of Object.entries(first)) if (value === n) return key;
  }
  const plain = STROKE_WIDTHS.find((o) => o.value === n);
  if (plain) return plain.key;
  if (!first) {
    for (const [key, value] of Object.entries(FREEDRAW_STROKE_WIDTHS)) {
      if (value === n) return key;
    }
  }
  return undefined;
}

/// The field value an arrowhead button writes. "none" is `null` in the file,
/// not the string — an element carrying `endArrowhead: "none"` is one
/// Excalidraw would never write.
export function arrowheadFor(key) {
  return key === "none" ? null : key;
}

/// Which arrowhead button a field value lights up. `end` says which end this
/// is, because the two ends have different meanings for an absent key: an arrow
/// with no `endArrowhead` draws one anyway (`excalidrawView.js`'s `?? "arrow"`,
/// matching `shape.ts:915-916`), and one with no `startArrowhead` draws none.
///
/// `circle` is Excalidraw's newer spelling of the head we write as `dot`; both
/// paint the same, so an imported `circle` presses the Dot button rather than
/// leaving the row blank.
export function arrowheadKey(value, end = false) {
  if (value === MIXED) return MIXED;
  if (value == null) return end ? "arrow" : "none";
  const v = String(value);
  if (v === "circle") return "dot";
  return v;
}

// --- Which sections apply to what --------------------------------------------
//
// Ports of Excalidraw's `comparisons.ts` predicates, which is what
// `shapeActionPredicates.ts` gates each panel section on. Every set below is
// one of those functions, spelled as data. Element kinds this build cannot
// create but can load (`iframe`, `embeddable`, `frame`, `image`) are included
// because a file can contain them and the panel is what a user reaches for
// after selecting one.
//
// The point is not tidiness. Sloppiness on a text element and Edges on an
// ellipse are controls with no effect whatsoever: they write a field the
// renderer never consults, and the user is left believing they changed
// something.

/// `hasBackground` — and therefore the fill style too.
const HAS_BACKGROUND = new Set([
  "rectangle", "ellipse", "diamond", "line", "freedraw", "iframe", "embeddable",
]);

/// `hasStrokeWidth`. Not text (its weight comes from the font) and not image.
const HAS_STROKE_WIDTH = new Set([
  "rectangle", "ellipse", "diamond", "line", "arrow", "freedraw", "iframe", "embeddable",
]);

/// `hasStrokeStyle` — dash pattern, and the sloppiness row with it. A freedraw
/// has neither: it is a captured path, not a sketched outline.
const HAS_STROKE_STYLE = new Set([
  "rectangle", "ellipse", "diamond", "line", "arrow", "iframe", "embeddable",
]);

/// `canChangeRoundness`. Notably *not* ellipse — a circle has no corners — and
/// not arrow or freedraw.
///
/// Deliberately narrower than `excalidrawDoc.js`'s `ROUNDNESS_TYPE`, which does
/// include `arrow`. The two answer different questions: that one is "what type
/// does this kind's roundness field use", which an arrow has an answer to,
/// and this one is "does the Edges control apply", which upstream's
/// `canChangeRoundness` says it does not. Not a drift to be reconciled.
const ROUNDABLE = new Set([
  "rectangle", "diamond", "line", "image", "iframe", "embeddable",
]);

/// The three kinds with no stroke colour of their own.
const NO_STROKE_COLOR = new Set(["image", "frame", "magicframe"]);

/// `canHaveArrowheads` — arrows only. A line with an arrowhead is an arrow.
const ARROWLIKE = new Set(["arrow"]);

const TEXTUAL = new Set(["text"]);

/// Every section, on. What an unknown selection gets: the same direction
/// `panelShown` takes, because a control that is present when it could have been
/// hidden is untidy and one that is missing when the user needs it is broken.
const ALL_SECTIONS = Object.freeze({
  stroke: true,
  background: true,
  fill: true,
  strokeWidth: true,
  strokeStyle: true,
  sloppiness: true,
  edges: true,
  arrowheads: true,
  opacity: true,
  text: true,
});

/// The kinds a patch from this panel would land on, or null when we cannot
/// tell. Excalidraw's `forToolOrSelection`: the selection when there is one,
/// otherwise the kind the active tool would draw.
function targetKinds({ kinds, tool } = {}) {
  const list = (Array.isArray(kinds) ? kinds : []).filter((k) => typeof k === "string");
  if (list.length) return [...new Set(list)];
  if (typeof tool === "string" && !isSelectTool(tool) && tool !== "hand") return [tool];
  return null;
}

/// Which groups apply. `some`, not `every`, matching `forToolOrSelection`: with
/// a rectangle and a text element selected, the fill row still applies to one
/// of them, and hiding it would take away the only way to reach it.
export function sectionsFor({ kinds, tool } = {}) {
  const list = targetKinds({ kinds, tool });
  if (list == null) return ALL_SECTIONS;
  const any = (set) => list.some((k) => set.has(k));
  return {
    stroke: list.some((k) => !NO_STROKE_COLOR.has(k)),
    background: any(HAS_BACKGROUND),
    fill: any(HAS_BACKGROUND),
    strokeWidth: any(HAS_STROKE_WIDTH),
    strokeStyle: any(HAS_STROKE_STYLE),
    sloppiness: any(HAS_STROKE_STYLE),
    edges: any(ROUNDABLE),
    arrowheads: any(ARROWLIKE),
    opacity: true,
    text: any(TEXTUAL),
  };
}

/// Whether a stroke-width click should resolve through the freedraw table.
/// Every target has to be a freedraw: one patch reaches the whole selection, so
/// a mixed pencil-and-rectangle selection cannot have it both ways, and 1/2/4
/// is the answer that is right for more of it.
export function freehandOnly({ kinds, tool } = {}) {
  const list = targetKinds({ kinds, tool });
  return !!list?.length && list.every((k) => k === "freedraw");
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
  // Each arrowhead is drawn on the same shaft so the row reads as one arrow
  // with six different tips rather than six unrelated glyphs.
  arrowhead: {
    none: svg('<path d="M3 10h14" />'),
    arrow: svg('<path d="M3 10h14" /><path d="M11.5 6l5 4 -5 4" />'),
    bar: svg('<path d="M3 10h13.5" /><path d="M16.5 5.5v9" />'),
    dot: svg('<path d="M3 10h9.5" /><circle cx="15" cy="10" r="2.5" fill="currentColor" />'),
    triangle: svg('<path d="M3 10h10" /><path d="M13 6.5l4.5 3.5 -4.5 3.5z" fill="currentColor" />'),
    diamond: svg('<path d="M3 10h8.5" /><path d="M14.5 6l3 4 -3 4 -3 -4z" fill="currentColor" />'),
  },
  theme: {
    light: svg('<circle cx="10" cy="10" r="3.5" />'
      + '<path d="M10 2.5v1.5M10 16v1.5M2.5 10h1.5M16 10h1.5" />'
      + '<path d="M4.7 4.7l1 1M14.3 14.3l1 1M15.3 4.7l-1 1M5.7 14.3l-1 1" />'),
    dark: svg('<path d="M15.5 11.8a6 6 0 0 1 -7.3 -7.3a6.2 6.2 0 1 0 7.3 7.3z" />'),
  },
  textAlign: {
    left: svg('<path d="M4 6h12M4 10h8M4 14h11" />'),
    center: svg('<path d="M4 6h12M6 10h8M4.5 14h11" />'),
    right: svg('<path d="M4 6h12M8 10h8M5 14h11" />'),
  },
  // The rule is where the text sits against; the two short lines are the text.
  verticalAlign: {
    top: svg('<path d="M3.5 4h13" /><path d="M6.5 8.5h7M6.5 12.5h4" />'),
    middle: svg('<path d="M3.5 10h13" /><path d="M6.5 6h7M6.5 14h4" />'),
    bottom: svg('<path d="M3.5 16h13" /><path d="M6.5 7.5h7M6.5 11.5h4" />'),
  },
  // Layers: an arrow towards the far edge, with a floor or ceiling on the two
  // that go all the way.
  layer: {
    back: svg('<path d="M10 3v10" /><path d="M6 9l4 4 4 -4" /><path d="M3.5 16.5h13" />'),
    backward: svg('<path d="M10 5v8" /><path d="M6 9l4 4 4 -4" />'),
    forward: svg('<path d="M10 15v-8" /><path d="M6 11l4 -4 4 4" />'),
    front: svg('<path d="M10 17v-10" /><path d="M6 11l4 -4 4 4" /><path d="M3.5 3.5h13" />'),
  },
  // Align: the rule is the edge, the two boxes are what moves onto it.
  align: {
    left: svg('<path d="M3.5 3v14" /><rect x="6" y="4.5" width="10" height="4" rx="1" />'
      + '<rect x="6" y="11.5" width="6.5" height="4" rx="1" />'),
    centerH: svg('<path d="M10 3v14" /><rect x="4" y="4.5" width="12" height="4" rx="1" />'
      + '<rect x="6.5" y="11.5" width="7" height="4" rx="1" />'),
    right: svg('<path d="M16.5 3v14" /><rect x="4" y="4.5" width="10" height="4" rx="1" />'
      + '<rect x="7.5" y="11.5" width="6.5" height="4" rx="1" />'),
    top: svg('<path d="M3 3.5h14" /><rect x="4.5" y="6" width="4" height="10" rx="1" />'
      + '<rect x="11.5" y="6" width="4" height="6.5" rx="1" />'),
    centerV: svg('<path d="M3 10h14" /><rect x="4.5" y="4" width="4" height="12" rx="1" />'
      + '<rect x="11.5" y="6.5" width="4" height="7" rx="1" />'),
    bottom: svg('<path d="M3 16.5h14" /><rect x="4.5" y="4" width="4" height="10" rx="1" />'
      + '<rect x="11.5" y="7.5" width="4" height="6.5" rx="1" />'),
  },
  distribute: {
    horizontal: svg('<path d="M3.5 4v12" /><path d="M16.5 4v12" />'
      + '<rect x="8.5" y="6" width="3" height="8" rx="1" />'),
    vertical: svg('<path d="M4 3.5h12" /><path d="M4 16.5h12" />'
      + '<rect x="6" y="8.5" width="8" height="3" rx="1" />'),
  },
  // Two solid triangles reflected across the dashed axis they flip about.
  flip: {
    horizontal: svg('<path d="M10 3v14" stroke-dasharray="2 2" />'
      + '<path d="M7.5 6l-4.5 4 4.5 4z" fill="currentColor" />'
      + '<path d="M12.5 6l4.5 4 -4.5 4z" fill="currentColor" />'),
    vertical: svg('<path d="M3 10h14" stroke-dasharray="2 2" />'
      + '<path d="M6 7.5l4 -4.5 4 4.5z" fill="currentColor" />'
      + '<path d="M6 12.5l4 4.5 4 -4.5z" fill="currentColor" />'),
  },
  // Grouped is one dashed box around both; ungrouped is corner marks only.
  group: {
    group: svg('<rect x="3.5" y="3.5" width="13" height="13" rx="1.5" stroke-dasharray="2.5 2" />'
      + '<rect x="6" y="6" width="4.5" height="4.5" fill="currentColor" />'
      + '<rect x="10" y="10" width="4.5" height="4.5" fill="currentColor" />'),
    ungroup: svg('<path d="M3.5 6.5v-3h3M13.5 3.5h3v3M16.5 13.5v3h-3M6.5 16.5h-3v-3" />'
      + '<rect x="6" y="6" width="4.5" height="4.5" fill="currentColor" />'
      + '<rect x="10" y="10" width="4.5" height="4.5" fill="currentColor" />'),
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
/// `getStyle()` returns the style to display, with any key possibly missing. It
/// may also return an *array* of styles, one per selected element, in which case
/// the panel folds them itself and presses nothing for the keys they disagree on
/// — see `foldStyles`. An array is the better contract, because "what is the
/// current value" has no answer for a mixed selection and a single object cannot
/// say so.
///
/// `setStyle(patch)` takes a *partial* style — exactly the keys that changed,
/// which is what lets the editor turn one click into one undo entry instead of
/// a wholesale overwrite of ten fields. `hasSelection()` chooses the heading.
///
/// `getKinds()` returns the element types the patch would land on — the selected
/// elements' `type` fields, or nothing when there is no selection. It is what
/// decides which groups are on screen (`sectionsFor`) and how a stroke-width key
/// resolves to px (`freehandOnly`). Absent, every group shows, which is what the
/// panel did before it could ask.
///
/// `activeTool` is optional and may be a string or a function returning one;
/// see `panelShown` for what it decides, and `sectionsFor` for the rest.
///
/// Sloppiness has to re-roll the seed, or it is not sloppiness. Excalidraw
/// writes `seed: randomInteger()` alongside `roughness` on every click
/// (`actionProperties.tsx:711`); with a pinned seed rough.js multiplies the
/// *same* random draws by the new roughness, so Artist and Cartoonist are one
/// sketch at two weights rather than two different hands. That is the reported
/// "smooth to bold".
///
/// Two ways to ask for it, and a host wires exactly one:
///
///   - `setStyle(patch, { resketch: true })` — the second argument, which is
///     what the core's `setStyleResketched` exists for. Preferred, because the
///     roughness and the seed land as *one* undo entry; an undo between them
///     would leave the new roughness sitting on the old seed.
///   - `reseed()` — a separate call after the patch, for a host whose
///     `setStyle` ignores its second argument. Supplying it suppresses the
///     `resketch` hint, so the seed is never re-rolled twice.
///
/// Either way it only fires with a selection: with none, the click is a
/// preference for the next shape, and that shape is minted with a fresh seed.
///
/// `getCanvasBackground()` / `setCanvasBackground(color)` are the canvas colour,
/// and `getTheme()` / `setTheme(theme)` the light/dark one. Both pairs are
/// `appState`, not a property of any element, and each row is absent unless both
/// its accessors are supplied — a host may well prefer to put either in its own
/// chrome (Excalidraw keeps theme in its hamburger menu), and the panel should
/// not be the reason there are two of them.
///
/// `actions` holds the verbs that are not style fields. Each is optional and its
/// row is absent unless at least one member of the row is supplied, so a host
/// that has not wired them shows no dead buttons:
///
///   reorder(how)     "back" | "backward" | "forward" | "front"
///   align(edge)      "left" | "centerH" | "right" | "top" | "centerV" | "bottom"
///   distribute(axis) "horizontal" | "vertical"
///   flip(axis)       "horizontal" | "vertical"
///   group() / ungroup()
///
/// Strings rather than the numeric `REORDER` the wasm layer uses, because this
/// module deliberately does not import the wasm layer — it is a DOM module that
/// `bun test` can mount without loading a `.wasm`.
///
/// `shown` is optional and, when it has an answer, *replaces* that rule: it is
/// a function returning whether the panel should be on screen at all. It
/// exists because a host may put the panel behind a sidebar toggle, and a
/// toggle the user just pressed that leaves the panel hidden — because the
/// select tool happens to be active with nothing selected — is a broken
/// button, not a tidy one.
///
/// Returning null or undefined means "no opinion", and the rule above applies.
/// That is what a host gets before it has expressed one, so a view mounted in
/// a pane that never drew a toggle behaves exactly as it did before there was
/// one to draw.
export function renderProps(host, {
  getStyle, setStyle, hasSelection, getKinds, activeTool, shown, reseed,
  getCanvasBackground, setCanvasBackground, getTheme, setTheme, actions,
} = {}) {
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

  /// The style to display. A `MIXED` from the fold has to survive the default
  /// fill-in — it *is* the answer — while a key the source object simply does
  /// not carry falls back, which is what `DEFAULT_STYLE` is for. So the merge is
  /// key by key rather than a spread: `{ ...a, ...b }` cannot tell a key that is
  /// absent apart from one that is present and undefined, and here those two
  /// mean opposite things.
  const style = () => {
    const got = getStyle?.();
    const src = Array.isArray(got) ? foldStyles(got) : (got ?? {});
    const out = { ...DEFAULT_STYLE };
    for (const key of Object.keys(src)) {
      if (src[key] !== undefined) out[key] = src[key];
    }
    return out;
  };
  /// `opts` is how a row asks for something beyond the field it writes. Only
  /// sloppiness uses it, and only for `{ resketch: true }`.
  const emit = (patch, opts) => setStyle?.(patch, opts);

  /// The kinds a patch would land on, and how many things are selected. Both
  /// come from the same accessor: an entry per selected element, so its length
  /// is the selection size. `hasSelection` is the fallback for a host that has
  /// not wired `getKinds` yet — it can still tell one from none.
  const kinds = () => (Array.isArray(getKinds?.()) ? getKinds() : null);
  const selectionSize = () => kinds()?.length ?? (hasSelection?.() ? 1 : 0);
  const toolNow = () => (typeof activeTool === "function" ? activeTool() : activeTool);
  const target = () => ({ kinds: kinds() ?? undefined, tool: toolNow() });

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
  /// eight that aren't. `opts` and `after` are the two halves of the one row
  /// (sloppiness) that has a consequence beyond the field it writes: `opts`
  /// rides along with the patch, `after` runs once it has been emitted.
  /// `send` is where the result goes, and defaults to `setStyle`. The theme row
  /// overrides it: `appState.theme` is not a style field, and a patch carrying it
  /// through `setStyle` would be written onto every selected element.
  function choiceGroup(label, field, options, {
    read = (s) => s[field],
    write = (value) => ({ [field]: value }),
    send = (patch, o) => emit(patch, o),
    opts = null,
    after = null,
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
      on(b, "click", () => {
        send(write(opt.value), opts?.(opt.value));
        after?.(opt.value);
      });
      row.appendChild(b);
      return b;
    });
    syncs.push((s) => {
      const current = read(s);
      options.forEach((opt, i) => {
        // A disagreement matches nothing, so a mixed selection leaves the whole
        // row unpressed. Stated rather than left to `===` failing on a symbol,
        // because it is the behaviour, not an accident of the comparison.
        const active = current !== MIXED && opt.value === current;
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
  /// `read`/`write` default to the style field of the same name, and are
  /// overridden by the canvas-background row — which is a colour row in every
  /// respect except that its value does not live on an element.
  function colorGroup(label, field, presets, {
    read = (s) => s[field],
    write = (color) => emit({ [field]: color }),
  } = {}) {
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
      on(b, "click", () => write(color));
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
        if (pending != null) write(pending);
        pending = null;
      };
      pickerOpen = true;
      const current = read(style());
      openColorPicker({
        anchor: custom.getBoundingClientRect(),
        // A mixed selection has no colour to open on, and a symbol is not one:
        // start from white, the same place a transparent background starts from.
        color: current === MIXED || isTransparent(current) ? "#ffffff" : current,
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
      const current = read(s);
      // The custom swatch used to light up for any non-preset value, `undefined`
      // included, which made a mixed selection look like a deliberate custom
      // colour. Nothing is pressed now, and the swatch shows the checkerboard —
      // "no single value here" rather than a colour it does not have.
      const mixed = current === MIXED;
      swatches.forEach((b, i) => {
        const active = !mixed && (presets[i] === current
          || (isTransparent(presets[i]) && isTransparent(current)));
        setPressed(b, active);
        b.classList.toggle("on", active);
      });
      const preset = !mixed && presets.some((c) => c === current
        || (isTransparent(c) && isTransparent(current)));
      custom.classList.toggle("on", !mixed && !preset);
      if (mixed || isTransparent(current)) {
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
      // The one control with no indeterminate position: a slider thumb is
      // somewhere. So a mixed selection shows the default and *says* it is
      // mixed, which is what Excalidraw does too — `actionChangeOpacity` falls
      // back to `currentItemOpacity` when `getFormValue` returns null.
      const mixed = s.opacity === MIXED;
      const shownValue = mixed ? DEFAULT_STYLE.opacity : s.opacity;
      const v = String(shownValue);
      // Guarded, because writing `value` on the element the user is dragging
      // fights the drag — and refresh() runs on every selection change.
      if (input.value !== v) input.value = v;
      input.setAttribute("aria-valuetext", mixed ? "Mixed" : `${shownValue}%`);
    });
    return node;
  }

  /// A row of one-shot buttons — the verbs, not the fields.
  ///
  /// Not toggles: none of these has a state to be in, so none carries
  /// `aria-pressed`. What they do carry is `disabled`, because "align left"
  /// with one element selected is not a thing that can happen, and a button
  /// that silently does nothing teaches the user it is broken. `min` is how
  /// many elements the verb needs — Excalidraw's own thresholds: align wants
  /// two, distribute wants more than two.
  ///
  /// `items` whose `run` is absent are dropped, and a row left with no items
  /// returns null. That is what keeps a host that has not wired `actions` from
  /// showing rows of dead buttons.
  function actionGroup(label, items) {
    const live = items.filter((it) => typeof it.run === "function");
    if (!live.length) return null;
    const { node, row } = group(label);
    const buttons = live.map((it) => {
      const b = el("button", "xdp-btn");
      b.type = "button";
      b.title = it.label;
      b.setAttribute("aria-label", `${label}: ${it.label}`);
      b.innerHTML = it.icon ?? "";
      on(b, "click", () => {
        if (b.disabled) return;
        it.run();
      });
      row.appendChild(b);
      return b;
    });
    syncs.push(() => {
      const n = selectionSize();
      live.forEach((it, i) => {
        const ok = n >= (it.min ?? 1);
        buttons[i].disabled = !ok;
        // Both, because `disabled` alone is invisible to a user reading the
        // panel with a screen reader that skips disabled controls entirely.
        buttons[i].setAttribute("aria-disabled", String(!ok));
      });
    });
    return node;
  }

  // --- The island ------------------------------------------------------------
  //
  // Every group is held by name. It used to be only Fill, because Fill was the
  // only one that came and went; now each row is gated on whether it applies to
  // what is selected (`sectionsFor`), so all of them are.

  const root = div("xdp-island");
  root.setAttribute("role", "region");
  const heading = div("xdp-title");
  heading.id = `xdp-title-${Math.random().toString(36).slice(2, 8)}`;
  root.setAttribute("aria-labelledby", heading.id);
  root.appendChild(heading);

  const groups = {};

  /// Append a group and remember it under `name`. A null group (an action row
  /// with nothing wired) is skipped, and `refresh` tolerates the gap.
  const add = (name, node) => {
    if (!node) return;
    groups[name] = node;
    root.appendChild(node);
  };

  add("stroke", colorGroup("Stroke", "strokeColor", STROKE_COLORS));
  add("background", colorGroup("Background", "backgroundColor", BACKGROUND_COLORS));

  // The canvas colour, which is `appState.viewBackgroundColor` rather than a
  // field on anything — hence its own pair of callbacks. It sits beside the two
  // element colour rows because that is where a user looks for "the colour of
  // the thing behind my drawing", even though the value lives somewhere else
  // entirely.
  if (getCanvasBackground && setCanvasBackground) {
    add("canvas", colorGroup("Canvas", "viewBackgroundColor", CANVAS_COLORS, {
      read: () => getCanvasBackground(),
      write: (color) => setCanvasBackground(color),
    }));
  }

  // Beside the canvas colour because the two answer the same question — what
  // the drawing sits on — and because they are the two things in this panel that
  // are properties of the file rather than of anything in it. Nothing writes
  // `appState.theme` today, so a document authored in dark mode reopens light
  // and every colour in it is re-inverted.
  if (getTheme && setTheme) {
    add("theme", choiceGroup("Theme", "theme", THEMES, {
      read: () => getTheme() ?? "light",
      write: (value) => value,
      send: (value) => setTheme(value),
      icons: ICONS.theme,
    }));
  }

  add("fill", choiceGroup("Fill", "fillStyle", FILL_STYLES, { icons: ICONS.fill }));

  add("strokeWidth", choiceGroup("Stroke width", "strokeWidth", STROKE_WIDTHS, {
    // Keys, not px: freedraw resolves to half the usual number, both ways.
    read: (s) => {
      const key = strokeWidthKey(s.strokeWidth, freehandOnly(target()));
      return STROKE_WIDTHS.find((o) => o.key === key)?.value;
    },
    write: (value) => ({
      strokeWidth: strokeWidthFor(
        STROKE_WIDTHS.find((o) => o.value === value)?.key,
        freehandOnly(target()),
      ),
    }),
    icons: ICONS.width,
  }));
  add("strokeStyle", choiceGroup("Stroke style", "strokeStyle", STROKE_STYLES, {
    icons: ICONS.style,
  }));
  add("sloppiness", choiceGroup("Sloppiness", "roughness", SLOPPINESS, {
    icons: ICONS.sloppiness,
    // The seed has to be re-rolled or this is one sketch at three weights. The
    // hint rides with the patch so the two writes are one undo entry; `reseed`
    // is the fallback for a host that cannot take it, and having it suppresses
    // the hint so nothing re-rolls twice.
    opts: () => ({ resketch: !reseed && !!hasSelection?.() }),
    after: () => {
      if (hasSelection?.()) reseed?.();
    },
  }));
  add("edges", choiceGroup("Edges", "roundness", EDGES, {
    read: (s) => edgeKey(s.roundness),
    write: (key) => ({ roundness: edgeRoundness(key) }),
    icons: ICONS.edges,
  }));

  add("arrowheadStart", choiceGroup("Arrow start", "startArrowhead", ARROWHEADS, {
    read: (s) => arrowheadKey(s.startArrowhead, false),
    write: (key) => ({ startArrowhead: arrowheadFor(key) }),
    icons: ICONS.arrowhead,
  }));
  add("arrowheadEnd", choiceGroup("Arrow end", "endArrowhead", ARROWHEADS, {
    read: (s) => arrowheadKey(s.endArrowhead, true),
    write: (key) => ({ endArrowhead: arrowheadFor(key) }),
    icons: ICONS.arrowhead,
  }));

  add("opacity", opacityGroup());

  // The text rows used to be unconditional, on the argument that hiding them
  // would make the island change height as the selection moved between a label
  // and the box around it. That was defensible with two rows and is not with
  // four: a Sloppiness row on a text element and a vertical-align row on a
  // rectangle are controls that write a field nothing reads, which is worse
  // than a panel that resizes. The island scrolls and is flush to the edge, so
  // its height was never load-bearing anyway.
  add("fontSize", choiceGroup("Font size", "fontSize", FONT_SIZES, { text: true }));
  add("fontFamily", choiceGroup("Font family", "fontFamily", FONT_FAMILIES, {
    icons: ICONS.family,
  }));
  add("textAlign", choiceGroup("Text align", "textAlign", TEXT_ALIGNS, {
    icons: ICONS.textAlign,
  }));
  add("verticalAlign", choiceGroup("Vertical align", "verticalAlign", VERTICAL_ALIGNS, {
    icons: ICONS.verticalAlign,
  }));

  // --- The verbs -------------------------------------------------------------
  //
  // z-order, align, distribute, flip and group are all reachable *only* from
  // here for a mouse-only user: there is no context menu in this app, and the
  // tool island deliberately holds nothing but tools. The keyboard has ⌘[ / ⌘]
  // and ⌘G, and had nothing at all for align, distribute or flip.

  const reorder = actions?.reorder;
  add("layers", actionGroup("Layers", [
    { label: "Send to back", icon: ICONS.layer.back, run: reorder && (() => reorder("back")) },
    { label: "Send backward", icon: ICONS.layer.backward, run: reorder && (() => reorder("backward")) },
    { label: "Bring forward", icon: ICONS.layer.forward, run: reorder && (() => reorder("forward")) },
    { label: "Bring to front", icon: ICONS.layer.front, run: reorder && (() => reorder("front")) },
  ]));

  const align = actions?.align;
  const distribute = actions?.distribute;
  add("align", actionGroup("Align", [
    { label: "Align left", icon: ICONS.align.left, min: 2, run: align && (() => align("left")) },
    { label: "Center horizontally", icon: ICONS.align.centerH, min: 2, run: align && (() => align("centerH")) },
    { label: "Align right", icon: ICONS.align.right, min: 2, run: align && (() => align("right")) },
    { label: "Align top", icon: ICONS.align.top, min: 2, run: align && (() => align("top")) },
    { label: "Center vertically", icon: ICONS.align.centerV, min: 2, run: align && (() => align("centerV")) },
    { label: "Align bottom", icon: ICONS.align.bottom, min: 2, run: align && (() => align("bottom")) },
    // Excalidraw's own threshold: distributing two things is what aligning them
    // already did.
    {
      label: "Distribute horizontally", icon: ICONS.distribute.horizontal, min: 3,
      run: distribute && (() => distribute("horizontal")),
    },
    {
      label: "Distribute vertically", icon: ICONS.distribute.vertical, min: 3,
      run: distribute && (() => distribute("vertical")),
    },
  ]));

  const flip = actions?.flip;
  add("flip", actionGroup("Flip", [
    { label: "Flip horizontally", icon: ICONS.flip.horizontal, run: flip && (() => flip("horizontal")) },
    { label: "Flip vertically", icon: ICONS.flip.vertical, run: flip && (() => flip("vertical")) },
  ]));

  add("grouping", actionGroup("Grouping", [
    { label: "Group", icon: ICONS.group.group, min: 2, run: actions?.group },
    // Ungroup takes one, because a single click inside a group selects one
    // member today (groups are not yet expanded on selection) and refusing the
    // verb there would make it unreachable.
    { label: "Ungroup", icon: ICONS.group.ungroup, min: 1, run: actions?.ungroup },
  ]));

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
    const tool = toolNow();
    const selected = !!hasSelection?.();
    const say = shown?.();
    const want = say == null ? panelShown({ hasSelection: selected, tool }) : !!say;
    if (!want) {
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

    const applies = sectionsFor(target());
    const show = (name, on) => {
      if (groups[name]) groups[name].hidden = !on;
    };
    show("stroke", applies.stroke);
    show("background", applies.background);
    show("fill", applies.fill && showsFill(s));
    show("strokeWidth", applies.strokeWidth);
    show("strokeStyle", applies.strokeStyle);
    show("sloppiness", applies.sloppiness);
    show("edges", applies.edges);
    show("arrowheadStart", applies.arrowheads);
    show("arrowheadEnd", applies.arrowheads);
    show("opacity", applies.opacity);
    show("fontSize", applies.text);
    show("fontFamily", applies.text);
    show("textAlign", applies.text);
    show("verticalAlign", applies.text);
    // The canvas colour and the theme are properties of the drawing, not of the
    // selection, so they are the rows nothing about the selection can hide.
    show("canvas", true);
    show("theme", true);
    // The verbs need something to act on. With nothing selected the panel is
    // showing defaults for the next shape, and there is nothing to reorder.
    for (const name of ["layers", "align", "flip", "grouping"]) show(name, selected);
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
