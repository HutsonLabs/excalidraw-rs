// Pure decisions for the .excalidraw editor: what a blank drawing is, what
// style a new shape gets, what the clipboard carries — and, the one that
// matters, whether a serialization is safe to write over a real file.
//
// This is bpmnDoc.js's job in this project, and it exists for bpmnDoc.js's
// reason. The editor is live: every drag fires a change, and the tempting
// wiring is "on change, serialize, write". That is how a failed serialize
// truncates someone's drawing to zero bytes, and a drawing is not a thing
// people keep a second copy of. PLAN.md calls `worthSaving` the highest-stakes
// rule in the plan; it is four lines long and it is here rather than inline in
// the view precisely so it can be read on its own and tested on its own.
//
// No DOM, no canvas, no wasm. ui/test/excalidrawDoc.test.js pins all of it.

/// A minimal, valid `.excalidraw` scene.
///
/// `type` and `version` are what tell Excalidraw — and our own parser — that
/// this is a scene rather than a shape library, and `appState` carries the
/// canvas colour a drawing is composited onto. Without the last one a new
/// drawing opens on whatever the painter's fallback happens to be, which is
/// not the same thing as the file saying white.
const BLANK = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-rs",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  },
  null,
  2,
);

/// True when there is nothing in the file to open. Creating `sketch.excalidraw`
/// in a file tree makes a 0-byte file, and a parser handed "" should not have
/// to have an opinion about it.
export const isEmptyDrawing = (text) => !String(text ?? "").trim();

/// The JSON to hand the core for a file's contents — the file itself, or a
/// blank scene when there is nothing there yet.
export const drawingSource = (text) => (isEmptyDrawing(text) ? BLANK : String(text));

/// Whether `next` should be written over `prev`.
///
/// Three refusals, and each one is a way a real drawing gets destroyed:
///
///   - **Empty.** The serialize failed, or the core handed back nothing. The
///     file on disk is the only surviving copy at that moment; writing "" over
///     it is the single worst thing this program can do.
///   - **Unparseable, or not a scene.** Same reasoning one step further in: a
///     string that isn't JSON with an `elements` array is not a drawing, so
///     whatever produced it was broken and its output is not evidence about
///     what the user wanted.
///   - **Identical to what we loaded.** Not dangerous, just pointless — and
///     not-pointless matters, because an autosave that rewrites the file on
///     every open shows up as a dirty working tree the user has to explain to
///     themselves.
///
/// Note what is *not* refused: a scene with zero elements. "Select all,
/// delete" is a thing people mean, and refusing to save it would be an editor
/// that quietly declines to let you empty a drawing.
export function worthSaving(prev, next) {
  const out = String(next ?? "").trim();
  if (!out) return false;
  let scene;
  try {
    scene = JSON.parse(out);
  } catch {
    return false;
  }
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) return false;
  return out !== String(prev ?? "").trim();
}

/// A failure to open, as a sentence for the pane. The core throws its parse
/// error as a string; anything else still has to read as an explanation rather
/// than as "[object Object]".
export function openMessage(err) {
  const detail = (
    err instanceof Error ? err.message : typeof err === "string" ? err : ""
  ).trim();
  return detail ? `This file isn't a drawing we can open: ${detail}` : "This file isn't a drawing we can open.";
}

// --- style -------------------------------------------------------------------
//
// The style object is the properties panel's vocabulary (excalidrawProps.js's
// `renderProps`) and it is the file's own vocabulary too — the ten keys are
// spelled and valued exactly as they land in the JSON, `roundness` included,
// which is `null` or `{ type: 3 }` rather than a boolean. Keeping one spelling
// means no translation layer to get wrong, and it means a style read off an
// element can be handed straight back to the panel.
//
// The one thing that is *not* pass-through: not every key means something for
// every shape. A rectangle has no font size and an ellipse has no corners, and
// writing those keys anyway puts fields on elements that Excalidraw never
// writes there — which survives a round trip but shows up as noise in a diff
// against a file it authored.

/// What a new shape is drawn with until the user says otherwise.
///
/// Excalidraw's own defaults, and deliberately the same values `xd-core`'s
/// `new_element` uses: a shape drawn with untouched defaults should look the
/// same whether or not a style was applied over it.
export const DEFAULT_STYLE = Object.freeze({
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  fontSize: 20,
  fontFamily: 5,
  roundness: { type: 3 },
  // Bound text's own two fields. Excalidraw's defaults for *free* text, which
  // is the only kind this editor authors; a bound label is centre/middle, and
  // that is `editLabel`'s business rather than a default.
  textAlign: "left",
  verticalAlign: "top",
  // A new arrow gets a head at the far end and nothing at the near one
  // (`DEFAULT_ELEMENT_PROPS`), and "none" is `null` in the file rather than the
  // string — an element carrying `"none"` is one Excalidraw would never write.
  startArrowhead: null,
  endArrowhead: "arrow",
});

// --- roundness ---------------------------------------------------------------

/// Excalidraw's two roundness types (`typeChecks.ts:309-316`).
///
/// Not a preference: which one a shape gets is a property of its *kind*.
/// `ADAPTIVE_RADIUS` caps the radius at 32px and is what a rectangle, image,
/// iframe or embeddable carries; `PROPORTIONAL_RADIUS` is a quarter of the
/// shorter side and is what a line, arrow or diamond carries. Writing the wrong
/// one produces a file that looks right here and wrong there — a diamond
/// authored with type 3 re-renders at excalidraw.com with a flat 32px corner
/// instead of `0.25 × min(w, h)`.
export const ROUNDNESS = Object.freeze({ PROPORTIONAL: 2, ADAPTIVE: 3 });

/// The type each kind carries, and by omission the kinds that carry none.
/// This is the list `ROUNDABLE` used to be, with the type attached — the two
/// were always the same question asked twice.
const ROUNDNESS_TYPE = Object.freeze({
  rectangle: ROUNDNESS.ADAPTIVE,
  image: ROUNDNESS.ADAPTIVE,
  iframe: ROUNDNESS.ADAPTIVE,
  embeddable: ROUNDNESS.ADAPTIVE,
  diamond: ROUNDNESS.PROPORTIONAL,
  line: ROUNDNESS.PROPORTIONAL,
  arrow: ROUNDNESS.PROPORTIONAL,
});

/// The `roundness` a shape of `kind` carries, given whether round edges are
/// wanted. `null` for a kind with no corners, and for "sharp".
///
/// `wanted` is the style's own descriptor rather than a boolean because that is
/// what the panel and the file both speak: `null` or `{ type }`, where
/// truthiness is the answer to "round?" and the type is not the caller's to
/// choose. A descriptor that already names this kind's type passes through
/// untouched, so a `value` an older file carried is not thrown away.
export function roundnessFor(kind, wanted) {
  const type = ROUNDNESS_TYPE[kind];
  if (!type || !wanted) return null;
  if (typeof wanted === "object" && wanted.type === type) return wanted;
  return { type };
}

/// Whether a kind has corners to round at all.
export const isRoundable = (kind) => ROUNDNESS_TYPE[kind] !== undefined;

// --- stroke width ------------------------------------------------------------

/// Excalidraw's `STROKE_WIDTH` and `FREEDRAW_STROKE_WIDTH` tables
/// (`constants.ts:430-446`), as one map from the key to what each kind wants.
///
/// The px is not the setting; the *key* is. Excalidraw's width buttons carry
/// `thin`/`medium`/`bold` and resolve through `getStrokeWidthByKey`, which
/// halves them for freedraw — a pencil stroke is drawn at `strokeWidth * 4.25`,
/// so 1/2/4 comes out twice as thick as it should.
///
/// Remembering the px instead of the key is what made "Extra bold" picked on a
/// pencil stroke (2) come back as "Bold" (2) on the next rectangle. The px alone
/// cannot say which: 1 and 2 each appear in both tables.
export const STROKE_WIDTH_PX = Object.freeze({
  thin: Object.freeze({ shape: 1, freedraw: 0.5 }),
  medium: Object.freeze({ shape: 2, freedraw: 1 }),
  bold: Object.freeze({ shape: 4, freedraw: 2 }),
});

/// The px a key means for a kind.
export function strokeWidthPx(key, kind) {
  const row = STROKE_WIDTH_PX[key];
  if (!row) return DEFAULT_STYLE.strokeWidth;
  return kind === "freedraw" ? row.freedraw : row.shape;
}

/// The key a px value came from, given the kinds it was written for.
///
/// `kinds` is the selection the patch landed on. Every one of them has to be a
/// freedraw for the halved table to be the right reading — one patch reaches a
/// whole mixed selection, so it cannot be both, and 1/2/4 is right for more of
/// it. Undefined for a width that is in neither table, which is a file saying
/// something Excalidraw's buttons cannot say and which we leave alone.
export function strokeWidthKeyOf(px, kinds = []) {
  const n = Number(px);
  if (!Number.isFinite(n)) return undefined;
  const list = Array.isArray(kinds) ? kinds : [];
  const freehand = list.length > 0 && list.every((k) => k === "freedraw");
  const field = freehand ? "freedraw" : "shape";
  for (const [key, row] of Object.entries(STROKE_WIDTH_PX)) {
    if (row[field] === n) return key;
  }
  return undefined;
}

/// Every key the panel may set. A patch is filtered through this rather than
/// spread blindly: `setStyle` reaches the document, and a typo'd key would be
/// written onto every selected element and then saved.
export const STYLE_KEYS = Object.freeze(Object.keys(DEFAULT_STYLE));

/// Fold a partial style into a whole one, ignoring anything not a style key.
///
/// `kinds` is what the patch was applied to, and it exists for exactly one
/// field. The panel resolves a stroke-width *key* to px against the current
/// selection before it emits the patch, so what arrives here is 2 with no way to
/// tell bold-on-a-rectangle apart from extra-bold-on-a-pencil-stroke. Recording
/// the key alongside is what lets `styleFor` resolve it again per kind, so the
/// next rectangle after an extra-bold pencil stroke is extra bold too.
///
/// `strokeWidthKey` is deliberately *not* a style key: `STYLE_KEYS` is derived
/// from `DEFAULT_STYLE` and `stylePatch` filters against it, so a field in there
/// would be written onto every selected element and then saved. This one is the
/// editor's memory, not the file's vocabulary.
export function mergeStyle(style, patch, kinds = []) {
  const out = { ...style };
  if (!patch || typeof patch !== "object") return out;
  for (const key of STYLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "strokeWidth")) {
    const key = strokeWidthKeyOf(patch.strokeWidth, kinds);
    if (key) out.strokeWidthKey = key;
    else delete out.strokeWidthKey; // a width no button can express
  }
  return out;
}

/// The style an element is currently drawn with — what the panel shows when
/// there is a selection.
export function styleFrom(element) {
  if (!element || typeof element !== "object") return { ...DEFAULT_STYLE };
  const pick = (key) => (element[key] === undefined ? DEFAULT_STYLE[key] : element[key]);
  return {
    strokeColor: pick("strokeColor"),
    backgroundColor: pick("backgroundColor"),
    fillStyle: pick("fillStyle"),
    strokeWidth: pick("strokeWidth"),
    strokeStyle: pick("strokeStyle"),
    roughness: pick("roughness"),
    opacity: pick("opacity"),
    fontSize: pick("fontSize"),
    fontFamily: pick("fontFamily"),
    // Absent and explicitly null both mean "sharp corners", and the panel
    // reads truthiness — so the descriptor passes through as it is.
    roundness: element.roundness ?? null,
    textAlign: pick("textAlign"),
    verticalAlign: pick("verticalAlign"),
    // `?? null` rather than `pick`, because an *absent* start arrowhead and an
    // explicitly null one mean the same thing, while the default for the end is
    // "arrow" and an arrow that says `null` there means it.
    startArrowhead: element.startArrowhead ?? null,
    endArrowhead: element.endArrowhead === undefined
      ? DEFAULT_STYLE.endArrowhead
      : element.endArrowhead,
  };
}

/// Text carries the font keys and the two alignments; nothing else does.
const TEXTUAL = new Set(["text"]);

/// What carries arrowheads. Excalidraw's `newLinearElement` writes them for an
/// arrow and `null` for a plain line, so a line drawn here does not inherit the
/// head the last arrow was drawn with.
const ARROWLIKE = new Set(["arrow"]);

/// The style to draw a new shape of `kind` with.
///
/// Filtered by kind. Passing the whole style straight through would work — the
/// format tolerates it — but it would write `fontSize` onto rectangles and
/// `roundness` onto ellipses, and a file we wrote should be indistinguishable
/// from one Excalidraw wrote.
export function styleFor(kind, style) {
  const s = { ...DEFAULT_STYLE, ...(style ?? {}) };
  const out = {
    strokeColor: s.strokeColor,
    backgroundColor: s.backgroundColor,
    fillStyle: s.fillStyle,
    // The remembered *key* wins over the remembered px, because only the key
    // knows what "bold" means for the kind about to be drawn — a pencil stroke
    // wants half what a rectangle wants. Without a key (a style read off an
    // element, or a width no button can express) the px stands as it is.
    strokeWidth: s.strokeWidthKey ? strokeWidthPx(s.strokeWidthKey, kind) : s.strokeWidth,
    strokeStyle: s.strokeStyle,
    roughness: s.roughness,
    opacity: s.opacity,
  };
  // Every kind that has corners, with the type its kind carries rather than one
  // type for all of them. Lines and arrows are in here now: Excalidraw's
  // `currentItemRoundness` defaults to "round", so a new arrow there gets
  // `{type: 2}` — and until something wrote it, a curved line could not exist,
  // because the renderer reads `roundness` to decide curve from polyline.
  if (isRoundable(kind)) out.roundness = roundnessFor(kind, s.roundness);
  if (TEXTUAL.has(kind)) {
    out.fontSize = s.fontSize;
    out.fontFamily = s.fontFamily;
    out.textAlign = s.textAlign;
    out.verticalAlign = s.verticalAlign;
  }
  if (ARROWLIKE.has(kind)) {
    out.startArrowhead = s.startArrowhead ?? null;
    out.endArrowhead = s.endArrowhead === undefined ? DEFAULT_STYLE.endArrowhead : s.endArrowhead;
  }
  return out;
}

/// A patch from the properties panel, on its way to a selection whose kinds we
/// do not know.
///
/// Only the filter, on purpose: a `fontSize` set with a rectangle selected is
/// the user asking for it, not us guessing, and Excalidraw is happy to carry
/// the field. What is refused is a key that is not a style key at all — the
/// patch reaches `setStyle`, which writes it onto every selected element and
/// then saves it, so a typo would be permanent.
export function stylePatch(patch, kinds = []) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of STYLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
  }
  // The panel emits one roundness descriptor for the whole selection and cannot
  // know that the type belongs to the kind. Where every target agrees on a type,
  // write the right one; where they disagree, one patch cannot have it both
  // ways, so what the panel asked for stands.
  if (Object.prototype.hasOwnProperty.call(out, "roundness")) {
    const list = (Array.isArray(kinds) ? kinds : []).filter(isRoundable);
    const settled = list.map((kind) => roundnessFor(kind, out.roundness));
    const types = new Set(settled.map((r) => r?.type ?? null));
    if (types.size === 1) out.roundness = settled[0];
  }
  return out;
}

/// A remembered style as the file's own vocabulary: every style key, and nothing
/// else.
///
/// The editor's `style` object carries one field the format has never heard of —
/// `strokeWidthKey`, see `mergeStyle` — and anything that speaks only the format
/// should not have to know that. Holes are filled from `DEFAULT_STYLE`, so what
/// comes back is a whole style rather than a partial one.
export function fileStyle(style) {
  const s = { ...DEFAULT_STYLE, ...(style ?? {}) };
  const out = {};
  for (const key of STYLE_KEYS) out[key] = s[key];
  return out;
}

// --- the clipboard -----------------------------------------------------------

/// Excalidraw's own clipboard marker. Using its string rather than one of our
/// own is the whole point: copy here, paste into excalidraw.com, and it works.
export const CLIPBOARD_TYPE = "excalidraw/clipboard";

/// Fields that must not travel. Identity is the document's to hand out
/// (`XdDoc.insert` overwrites `id` and `seed` regardless), and a binding names
/// an element by id — pasted into another drawing those ids point at nothing,
/// and pasted into this one they point at the *original*, so an arrow copied
/// from a bound pair would drag the shape it was copied from.
///
/// `containerId` and `frameId` are the same hazard one step out: a label whose
/// container is not in the payload, or a shape claiming membership of a frame
/// the target document has never heard of, is a dangling reference in a saved
/// file — the failure `Doc::detach_references`' own doc comment calls "the
/// classic hand-edited-.excalidraw failure, and it does not announce itself".
/// Excalidraw regenerates all of these on paste.
const DROPPED = [
  "id", "seed", "version", "versionNonce", "updated",
  "boundElements", "startBinding", "endBinding",
  "containerId", "frameId",
];

/// A fresh group id.
///
/// Not the element ids' generator: those are the document's to hand out, and
/// `XdDoc.insert` overwrites whatever arrives. Group ids have no such owner —
/// nothing in the core mints one on insert — so the clipboard has to, and it
/// only has to be unique within a drawing.
export const newGroupId = () =>
  `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/// Re-mint the `groupIds` of a pasted set, keeping its shape.
///
/// `groupIds` is *not* on the dropped list, and the difference matters. Dropped,
/// a copied group pastes as loose shapes and the grouping is gone. Carried
/// through unchanged — which is what happened before this — the copies join the
/// **original's** group, so moving the original drags the copy across the
/// canvas. Excalidraw's answer, and this one, is to rewrite each distinct id to
/// a fresh one: the pasted set is grouped exactly as it was copied, with
/// itself, and with nothing outside the payload.
///
/// Nesting survives for free, because the rewrite is per-id and the order of
/// the array — innermost first — is untouched.
function regroup(elements, mint = newGroupId) {
  const fresh = new Map();
  return elements.map((e) => {
    if (!Array.isArray(e.groupIds) || !e.groupIds.length) return e;
    return {
      ...e,
      groupIds: e.groupIds.map((id) => {
        if (!fresh.has(id)) fresh.set(id, mint());
        return fresh.get(id);
      }),
    };
  });
}

/// The clipboard payload for a set of elements.
///
/// `files` is the document's whole file map; only the entries the copied
/// elements actually name go on the clipboard. Without them an image copied out
/// of this editor arrives anywhere else as a `fileId` resolving to nothing —
/// a permanent grey placeholder — which is the one real cross-document data
/// loss in this build (audit-tools.md D1). Sending the whole map instead would
/// put every image in the drawing on the clipboard to copy one rectangle.
export function clipboardText(elements, files = null) {
  const list = (Array.isArray(elements) ? elements : []).filter(
    (e) => e && typeof e === "object" && typeof e.type === "string",
  );
  const wanted = {};
  if (files && typeof files === "object") {
    for (const e of list) {
      const id = e.fileId;
      if (typeof id === "string" && files[id] !== undefined) wanted[id] = files[id];
    }
  }
  return JSON.stringify(
    {
      type: CLIPBOARD_TYPE,
      version: 2,
      source: "excalidraw-rs",
      elements: list.map((e) => {
        const copy = { ...e };
        for (const key of DROPPED) delete copy[key];
        return copy;
      }),
      files: wanted,
    },
    null,
    2,
  );
}

/// Elements out of a clipboard payload, or null when the text is not one.
///
/// Deliberately loose about the marker: Excalidraw has written more than one
/// spelling of it over the years, and anything that says "excalidraw" and
/// carries an elements array is a paste we can honour. Anything else is plain
/// text, and the caller turns that into a text element instead.
///
/// The drop list is applied on the way in as well as on the way out, because a
/// payload written by Excalidraw carries all of it and this side is the one that
/// has to be safe. `files` comes back alongside the elements so an image's
/// bytes can be put into the document once something can write the file map;
/// until then the caller ignores it and the image lands as a placeholder, which
/// is what it does today anyway.
export function parseClipboard(text, mint = newGroupId) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.type !== "string" || !payload.type.startsWith("excalidraw")) return null;
  if (!Array.isArray(payload.elements)) return null;
  const elements = regroup(
    payload.elements
      .filter((e) => e && typeof e === "object" && typeof e.type === "string")
      .map((e) => {
        const copy = { ...e };
        for (const key of DROPPED) delete copy[key];
        return copy;
      }),
    mint,
  );
  if (!elements.length) return null;
  const files = payload.files && typeof payload.files === "object" ? payload.files : {};
  return { elements, files };
}

// --- text measurement --------------------------------------------------------

/// The box a run of text occupies, given the width of each line.
///
/// The *measuring* needs a canvas and lives in the view; the arithmetic on top
/// of it does not, and is here so it can be pinned. Height is lines × line
/// height rather than anything font-metric, which is exactly what
/// excalidrawScene.js's `textLayout` assumes when it lays the lines back out —
/// the two have to agree or text jumps the moment the overlay closes.
///
/// An empty run still has one line, and therefore still has height: a text
/// element with height 0 cannot be clicked, and the user has just been typing
/// in it.
export function textBox(widths, lineHeight, lines) {
  const list = Array.isArray(widths) ? widths.filter((w) => Number.isFinite(w)) : [];
  const count = Math.max(1, Number.isFinite(lines) ? lines : list.length);
  const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 25;
  return {
    width: Math.max(0, ...list),
    height: count * lh,
  };
}
