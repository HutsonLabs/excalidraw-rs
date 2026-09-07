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
});

/// Every key the panel may set. A patch is filtered through this rather than
/// spread blindly: `setStyle` reaches the document, and a typo'd key would be
/// written onto every selected element and then saved.
export const STYLE_KEYS = Object.freeze(Object.keys(DEFAULT_STYLE));

/// Fold a partial style into a whole one, ignoring anything not a style key.
export function mergeStyle(style, patch) {
  const out = { ...style };
  if (!patch || typeof patch !== "object") return out;
  for (const key of STYLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
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
  };
}

/// Shapes that have corners to round. Excalidraw writes `roundness` on these
/// two and `null` on everything else.
const ROUNDABLE = new Set(["rectangle", "diamond"]);

/// Text carries the font keys; nothing else does.
const TEXTUAL = new Set(["text"]);

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
    strokeWidth: s.strokeWidth,
    strokeStyle: s.strokeStyle,
    roughness: s.roughness,
    opacity: s.opacity,
  };
  if (ROUNDABLE.has(kind)) out.roundness = s.roundness ?? null;
  if (TEXTUAL.has(kind)) {
    out.fontSize = s.fontSize;
    out.fontFamily = s.fontFamily;
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
export function stylePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of STYLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
  }
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
const DROPPED = ["id", "seed", "version", "versionNonce", "updated", "boundElements", "startBinding", "endBinding"];

/// The clipboard payload for a set of elements.
export function clipboardText(elements) {
  const list = (Array.isArray(elements) ? elements : []).filter(
    (e) => e && typeof e === "object" && typeof e.type === "string",
  );
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
      files: {},
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
export function parseClipboard(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.type !== "string" || !payload.type.startsWith("excalidraw")) return null;
  if (!Array.isArray(payload.elements)) return null;
  const elements = payload.elements
    .filter((e) => e && typeof e === "object" && typeof e.type === "string")
    .map((e) => {
      const copy = { ...e };
      for (const key of DROPPED) delete copy[key];
      return copy;
    });
  return elements.length ? { elements } : null;
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
