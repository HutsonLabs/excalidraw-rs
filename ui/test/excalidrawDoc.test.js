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
  clipboardText, drawingSource, isEmptyDrawing, mergeStyle, openMessage,
  parseClipboard, stylePatch, styleFor, styleFrom, textBox, worthSaving,
  CLIPBOARD_TYPE, DEFAULT_STYLE, STYLE_KEYS,
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
