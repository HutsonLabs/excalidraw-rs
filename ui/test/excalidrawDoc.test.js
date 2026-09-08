// The editor's pure decisions, and mostly the one that matters.
//
// `worthSaving` is the guard PLAN.md calls the highest-stakes rule in the
// whole plan, because the failure it prevents is destroying a drawing rather
// than annoying its author. It is four lines long, which is exactly why it
// needs a test: nothing about reading it tells you whether it was ever wired
// up to refuse the case it exists for.
//
// Everything here is pure — no DOM, no canvas, no wasm.

import { test, expect } from "bun:test";
import {
  clipboardText, drawingSource, fileStyle, isEmptyDrawing, isRoundable, mergeStyle,
  openMessage, parseClipboard, roundnessFor, strokeWidthKeyOf, strokeWidthPx, stylePatch,
  styleFor, styleFrom, textBox, worthSaving,
  CLIPBOARD_TYPE, DEFAULT_STYLE, ROUNDNESS, STYLE_KEYS,
} from "../src/excalidrawDoc.js";

const scene = (elements = []) =>
  JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });

const REAL = scene([{ type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 }]);

// --- worthSaving -------------------------------------------------------------

test("an empty serialization is never written over anything", () => {
  // The one that matters. A throw out of the core, a document that never
  // loaded, a truncated write — all of them arrive here as "" or whitespace,
  // and the file on disk is the only surviving copy at that moment.
  for (const bad of ["", "   ", "\n\n", null, undefined]) {
    expect(worthSaving(REAL, bad)).toBe(false);
  }
});

test("output that isn't JSON is never written", () => {
  expect(worthSaving(REAL, "{not json")).toBe(false);
  expect(worthSaving(REAL, "null")).toBe(false);
  expect(worthSaving(REAL, "42")).toBe(false);
  expect(worthSaving(REAL, '"a string"')).toBe(false);
});

test("output that isn't a scene is never written", () => {
  // Parses, and is still not a drawing. An object with no elements array is
  // whatever the failure produced, not evidence about what the user wanted.
  expect(worthSaving(REAL, JSON.stringify({ type: "excalidraw" }))).toBe(false);
  expect(worthSaving(REAL, JSON.stringify({ elements: "lots" }))).toBe(false);
});

test("output identical to what was loaded is not written", () => {
  expect(worthSaving(REAL, REAL)).toBe(false);
  // Trailing whitespace is not an edit.
  expect(worthSaving(REAL, `${REAL}\n`)).toBe(false);
});

test("a real change is written", () => {
  const moved = scene([{ type: "rectangle", id: "a", x: 5, y: 0, width: 10, height: 10 }]);
  expect(worthSaving(REAL, moved)).toBe(true);
});

test("emptying a drawing is saved — that is a thing people mean", () => {
  // The conservative direction everywhere else, but not here: refusing to save
  // a scene with no elements would be an editor that quietly declines to let
  // you select all and delete.
  expect(worthSaving(REAL, scene([]))).toBe(true);
});

test("the first save of a blank file is written", () => {
  expect(worthSaving("", REAL)).toBe(true);
});

// --- opening -----------------------------------------------------------------

test("an empty file opens as a blank drawing rather than as a parse error", () => {
  expect(isEmptyDrawing("")).toBe(true);
  expect(isEmptyDrawing("  \n ")).toBe(true);
  expect(isEmptyDrawing(REAL)).toBe(false);
  const blank = JSON.parse(drawingSource(""));
  expect(blank.type).toBe("excalidraw");
  expect(blank.elements).toEqual([]);
  expect(typeof blank.appState.viewBackgroundColor).toBe("string");
});

test("a file with contents is handed over untouched", () => {
  expect(drawingSource(REAL)).toBe(REAL);
});

test("an open failure reads as a sentence, not as [object Object]", () => {
  expect(openMessage(new Error("trailing comma at line 4"))).toContain("trailing comma at line 4");
  expect(openMessage("expected `elements`")).toContain("expected `elements`");
  expect(openMessage({})).toBe("This file isn't a drawing we can open.");
  expect(openMessage(undefined)).not.toContain("undefined");
});

// --- style -------------------------------------------------------------------

test("a style patch is filtered to style keys", () => {
  // The patch reaches setStyle, which writes it onto every selected element
  // and then saves it, so a key that isn't a style key would be permanent.
  const out = stylePatch({ strokeColor: "#e03131", isDeleted: true, id: "nope" });
  expect(out).toEqual({ strokeColor: "#e03131" });
});

test("merging a partial style leaves the rest alone", () => {
  const merged = mergeStyle(DEFAULT_STYLE, { strokeWidth: 4, nonsense: 1 });
  expect(merged.strokeWidth).toBe(4);
  expect(merged.strokeColor).toBe(DEFAULT_STYLE.strokeColor);
  expect(merged.nonsense).toBeUndefined();
  // And does not mutate what it was handed.
  expect(DEFAULT_STYLE.strokeWidth).toBe(2);
});

test("roundness keeps the file's own spelling all the way through", () => {
  // The properties panel reads truthiness and writes `{ type: 3 }` or null,
  // which is exactly what lands in the JSON. One spelling, no translation.
  expect(styleFor("rectangle", { roundness: { type: 3 } }).roundness).toEqual({ type: 3 });
  expect(styleFor("rectangle", { roundness: null }).roundness).toBe(null);
  expect(styleFrom({ roundness: { type: 3 } }).roundness).toEqual({ type: 3 });
  expect(styleFrom({}).roundness).toBe(null);
});

test("a shape is only given the keys its kind has", () => {
  const rect = styleFor("rectangle", DEFAULT_STYLE);
  expect(rect).toHaveProperty("roundness");
  expect(rect).not.toHaveProperty("fontSize");

  const ellipse = styleFor("ellipse", DEFAULT_STYLE);
  // Excalidraw writes `roundness: null` on an ellipse and never a descriptor;
  // writing one would be a field it has no meaning for.
  expect(ellipse).not.toHaveProperty("roundness");

  const text = styleFor("text", DEFAULT_STYLE);
  expect(text.fontSize).toBe(DEFAULT_STYLE.fontSize);
  expect(text.fontFamily).toBe(DEFAULT_STYLE.fontFamily);
  expect(text).not.toHaveProperty("roundness");
});

test("each kind gets the roundness type Excalidraw writes for it", () => {
  // `ADAPTIVE_RADIUS` (3) is a 32px cap and belongs to rectangles and images;
  // `PROPORTIONAL_RADIUS` (2) is a quarter of the short side and belongs to
  // diamonds, lines and arrows (`typeChecks.ts:309-316`). Everything used to get
  // 3, so a diamond authored here re-rendered at excalidraw.com with a flat 32px
  // corner instead of a proportional one.
  const round = { roundness: { type: 3 } };
  expect(styleFor("rectangle", round).roundness).toEqual({ type: ROUNDNESS.ADAPTIVE });
  expect(styleFor("diamond", round).roundness).toEqual({ type: ROUNDNESS.PROPORTIONAL });
  expect(styleFor("line", round).roundness).toEqual({ type: ROUNDNESS.PROPORTIONAL });
  expect(styleFor("arrow", round).roundness).toEqual({ type: ROUNDNESS.PROPORTIONAL });
  // And sharp is still sharp, for every one of them.
  expect(styleFor("diamond", { roundness: null }).roundness).toBe(null);
  expect(styleFor("arrow", { roundness: null }).roundness).toBe(null);
});

test("new lines and arrows carry a roundness at all, so a curve can exist", () => {
  // The renderer reads `roundness` to choose a curve over a polyline, and nothing
  // ever wrote it for a linear element — so a curved line was unreachable, and a
  // line authored here reopened in Excalidraw as straight segments.
  expect(isRoundable("line")).toBe(true);
  expect(isRoundable("arrow")).toBe(true);
  expect(styleFor("line", DEFAULT_STYLE)).toHaveProperty("roundness");
  expect(styleFor("arrow", DEFAULT_STYLE).roundness).toEqual({ type: 2 });
  // Kinds with no corners still get nothing rather than null noise.
  expect(isRoundable("ellipse")).toBe(false);
  expect(isRoundable("freedraw")).toBe(false);
  expect(styleFor("ellipse", DEFAULT_STYLE)).not.toHaveProperty("roundness");
});

test("a descriptor already naming the right type keeps whatever else it carries", () => {
  const carried = { type: 2, value: 12 };
  expect(roundnessFor("diamond", carried)).toBe(carried);
  // The wrong type is replaced rather than corrected in place.
  expect(roundnessFor("diamond", { type: 3, value: 12 })).toEqual({ type: 2 });
  expect(roundnessFor("freedraw", carried)).toBe(null);
});

test("a patch's roundness type is settled against what it will land on", () => {
  // The panel emits one descriptor for the whole selection and cannot know the
  // type belongs to the kind.
  expect(stylePatch({ roundness: { type: 3 } }, ["diamond"]).roundness).toEqual({ type: 2 });
  expect(stylePatch({ roundness: { type: 3 } }, ["rectangle"]).roundness).toEqual({ type: 3 });
  // A mixed selection cannot have it both ways from one patch, so what the panel
  // asked for stands rather than half the selection being quietly wrong.
  expect(stylePatch({ roundness: { type: 3 } }, ["rectangle", "diamond"]).roundness)
    .toEqual({ type: 3 });
  // And with nothing to go on, nothing changes.
  expect(stylePatch({ roundness: null }, ["diamond"]).roundness).toBe(null);
});

test("a stroke width is remembered as a key, so it means the same on every kind", () => {
  // Excalidraw's buttons carry thin/medium/bold and `getStrokeWidthByKey` halves
  // them for freedraw, because a pencil stroke is drawn at `strokeWidth * 4.25`.
  expect(strokeWidthPx("bold", "rectangle")).toBe(4);
  expect(strokeWidthPx("bold", "freedraw")).toBe(2);
  // 2 is "medium" for a shape and "bold" for a pencil stroke, which is exactly
  // why the px alone cannot be remembered.
  expect(strokeWidthKeyOf(2, ["rectangle"])).toBe("medium");
  expect(strokeWidthKeyOf(2, ["freedraw"])).toBe("bold");
  // One patch reaches a whole selection, so a mixed one reads as the shape table.
  expect(strokeWidthKeyOf(2, ["freedraw", "rectangle"])).toBe("medium");
  // A width no button can express is left alone rather than rounded to one.
  expect(strokeWidthKeyOf(3, ["rectangle"])).toBeUndefined();
});

test("extra bold on a pencil stroke is extra bold on the next rectangle", () => {
  // The bug this fixes: the panel resolves the key to px against the *current*
  // selection, so picking the widest option on a freedraw emitted 2 — and 2 read
  // back as "Bold" on the rectangle drawn next.
  const remembered = mergeStyle(DEFAULT_STYLE, { strokeWidth: 2 }, ["freedraw"]);
  expect(remembered.strokeWidthKey).toBe("bold");
  expect(styleFor("freedraw", remembered).strokeWidth).toBe(2);
  expect(styleFor("rectangle", remembered).strokeWidth).toBe(4);
  // The key is the editor's memory, not a field: it must never reach an element.
  expect(STYLE_KEYS).not.toContain("strokeWidthKey");
  expect(stylePatch(remembered)).not.toHaveProperty("strokeWidthKey");
  expect(fileStyle(remembered)).not.toHaveProperty("strokeWidthKey");
  expect(Object.keys(fileStyle(remembered)).sort()).toEqual([...STYLE_KEYS].sort());
});

test("a width in neither table is carried as it is, and forgets the key", () => {
  const odd = mergeStyle(mergeStyle(DEFAULT_STYLE, { strokeWidth: 2 }, ["freedraw"]), { strokeWidth: 3 }, ["rectangle"]);
  expect(odd.strokeWidthKey).toBeUndefined();
  expect(styleFor("rectangle", odd).strokeWidth).toBe(3);
});

test("the alignment and arrowhead keys reach the document", () => {
  // Four panel rows were landing patches that `stylePatch` filtered out — the
  // exact trap the text audit warned about: a control that looks live and is not.
  for (const key of ["textAlign", "verticalAlign", "startArrowhead", "endArrowhead"]) {
    expect(STYLE_KEYS).toContain(key);
  }
  expect(stylePatch({ textAlign: "center" })).toEqual({ textAlign: "center" });
  expect(stylePatch({ endArrowhead: null })).toEqual({ endArrowhead: null });
});

test("alignment lands on text and arrowheads on arrows, and not the other way", () => {
  const text = styleFor("text", DEFAULT_STYLE);
  expect(text.textAlign).toBe("left");
  expect(text.verticalAlign).toBe("top");
  expect(text).not.toHaveProperty("endArrowhead");

  const arrow = styleFor("arrow", DEFAULT_STYLE);
  expect(arrow.startArrowhead).toBe(null);
  expect(arrow.endArrowhead).toBe("arrow");
  expect(arrow).not.toHaveProperty("textAlign");

  // A plain line does not inherit the head the last arrow was drawn with —
  // Excalidraw's `newLinearElement` writes arrowheads for an arrow only.
  expect(styleFor("line", DEFAULT_STYLE)).not.toHaveProperty("endArrowhead");
  expect(styleFor("rectangle", DEFAULT_STYLE)).not.toHaveProperty("textAlign");
});

test("the style read off an element falls back rather than showing holes", () => {
  const s = styleFrom({ type: "rectangle", strokeColor: "#e03131" });
  expect(s.strokeColor).toBe("#e03131");
  expect(s.opacity).toBe(DEFAULT_STYLE.opacity);
  expect(Object.keys(s).sort()).toEqual([...STYLE_KEYS].sort());
});

// --- the clipboard -----------------------------------------------------------

test("the clipboard carries Excalidraw's own marker, so a paste there works", () => {
  const payload = JSON.parse(clipboardText([{ type: "rectangle", id: "a", x: 0, y: 0 }]));
  expect(payload.type).toBe(CLIPBOARD_TYPE);
  expect(payload.type.startsWith("excalidraw")).toBe(true);
  expect(payload.elements).toHaveLength(1);
});

test("identity and bindings do not travel", () => {
  // A binding names an element by id. Pasted into another drawing those ids
  // point at nothing; pasted into this one they point at the *original*, so a
  // copied arrow would drag the shape it was copied from.
  const payload = JSON.parse(clipboardText([{
    type: "arrow", id: "a", seed: 7, version: 3, versionNonce: 9, updated: 1,
    startBinding: { elementId: "b" }, endBinding: { elementId: "c" },
    boundElements: [{ id: "d", type: "text" }],
    x: 0, y: 0,
  }]));
  const [el] = payload.elements;
  for (const key of ["id", "seed", "version", "versionNonce", "updated", "startBinding", "endBinding", "boundElements"]) {
    expect(el).not.toHaveProperty(key);
  }
  expect(el.type).toBe("arrow");
});

test("plain text is not a clipboard payload", () => {
  expect(parseClipboard("just some words")).toBe(null);
  expect(parseClipboard("")).toBe(null);
  expect(parseClipboard(JSON.stringify({ type: "something-else", elements: [] }))).toBe(null);
  // Parses, says excalidraw, and carries nothing — there is nothing to paste.
  expect(parseClipboard(JSON.stringify({ type: CLIPBOARD_TYPE, elements: [] }))).toBe(null);
});

test("a payload round-trips through the clipboard", () => {
  const elements = [
    { type: "rectangle", x: 1, y: 2, width: 3, height: 4 },
    { type: "ellipse", x: 5, y: 6, width: 7, height: 8 },
  ];
  const parsed = parseClipboard(clipboardText(elements));
  expect(parsed.elements).toHaveLength(2);
  expect(parsed.elements[0].x).toBe(1);
  expect(parsed.elements[1].type).toBe("ellipse");
});

test("a container id and a frame id do not travel either", () => {
  // Both are references into the document they were copied from. A pasted label
  // claiming a `containerId` that names a foreign element, or a shape claiming
  // membership of a frame the target has never heard of, is a dangling
  // reference in a saved file — the failure that does not announce itself.
  const payload = JSON.parse(clipboardText([{
    type: "text", id: "t", containerId: "r", frameId: "f", text: "hi", x: 0, y: 0,
  }]));
  expect(payload.elements[0]).not.toHaveProperty("containerId");
  expect(payload.elements[0]).not.toHaveProperty("frameId");
  // And they are stripped on the way *in* as well, because a payload written by
  // Excalidraw carries them and this side is the one that has to be safe.
  const parsed = parseClipboard(JSON.stringify({
    type: CLIPBOARD_TYPE,
    elements: [{ type: "text", containerId: "r", frameId: "f", text: "hi", x: 0, y: 0 }],
  }));
  expect(parsed.elements[0]).not.toHaveProperty("containerId");
  expect(parsed.elements[0]).not.toHaveProperty("frameId");
});

test("a pasted group is grouped with itself, not with the original", () => {
  // Carried through unchanged — which is what used to happen — the copies join
  // the *original's* group, so moving the original drags the copy across the
  // canvas. Dropped entirely, the grouping is simply lost. Excalidraw re-mints.
  const elements = [
    { type: "rectangle", x: 0, y: 0, groupIds: ["g1"] },
    { type: "ellipse", x: 9, y: 9, groupIds: ["g1"] },
    { type: "diamond", x: 4, y: 4, groupIds: ["g2", "g1"] },
  ];
  const parsed = parseClipboard(clipboardText(elements));
  const [a, b, c] = parsed.elements;
  // Nothing points at what it was copied from…
  expect(a.groupIds).not.toContain("g1");
  expect(c.groupIds).not.toContain("g2");
  // …the two that shared a group still share one…
  expect(a.groupIds[0]).toBe(b.groupIds[0]);
  // …and the nesting is intact, innermost first, with a distinct inner id.
  expect(c.groupIds).toHaveLength(2);
  expect(c.groupIds[1]).toBe(a.groupIds[0]);
  expect(c.groupIds[0]).not.toBe(c.groupIds[1]);
});

test("a copied image carries its bytes, and only its own", () => {
  // `files` was hard-coded to {}, so the copied element kept its `fileId` and
  // the bytes stayed behind: pasting into another document — the whole point of
  // using Excalidraw's own clipboard marker — gave a permanent grey placeholder.
  const files = {
    wanted: { mimeType: "image/png", dataURL: "data:image/png;base64,AAA" },
    unrelated: { mimeType: "image/png", dataURL: "data:image/png;base64,BBB" },
  };
  const payload = JSON.parse(clipboardText([{ type: "image", fileId: "wanted", x: 0, y: 0 }], files));
  expect(payload.files.wanted.dataURL).toBe("data:image/png;base64,AAA");
  // Copying one rectangle must not put every image in the drawing on the
  // clipboard.
  expect(payload.files).not.toHaveProperty("unrelated");
  expect(parseClipboard(JSON.stringify(payload)).files.wanted).toBeDefined();
});

test("a drawing with no file map still copies", () => {
  const payload = JSON.parse(clipboardText([{ type: "rectangle", x: 0, y: 0 }]));
  expect(payload.files).toEqual({});
  expect(parseClipboard(JSON.stringify(payload)).files).toEqual({});
});

test("a payload from a newer Excalidraw keeps its unknown fields", () => {
  // Same reason `Element::rest` exists in the crate: a key we have never heard
  // of has to survive, or we quietly downgrade what someone pasted.
  const parsed = parseClipboard(JSON.stringify({
    type: "excalidraw/clipboard",
    elements: [{ type: "rectangle", x: 0, y: 0, elbowed: true }],
  }));
  expect(parsed.elements[0].elbowed).toBe(true);
});

// --- text measurement --------------------------------------------------------

test("a text box is as wide as its widest line and as tall as its lines", () => {
  // Height is lines × line height and nothing font-metric, because that is
  // exactly what excalidrawScene.js's textLayout assumes when it lays the
  // lines back out. If the two disagreed the text would jump the moment the
  // overlay closed.
  expect(textBox([40, 90, 12], 25, 3)).toEqual({ width: 90, height: 75 });
});

test("an empty run still has one line's height", () => {
  // A text element with height 0 cannot be clicked, and the user has just been
  // typing in it.
  const box = textBox([], 25, 0);
  expect(box.width).toBe(0);
  expect(box.height).toBe(25);
});

test("a measurement that failed does not produce NaN", () => {
  // `measureText` is absent in a headless context and the widths come back
  // empty; a NaN width would be written into the file.
  const box = textBox([undefined, NaN], undefined, 2);
  expect(Number.isFinite(box.width)).toBe(true);
  expect(Number.isFinite(box.height)).toBe(true);
});
