// Files: the dialogs and the disk, for the standalone app only.
//
// Everything in standalone/ is the app's own surface and none of it ports into
// term.hut (PLAN.md Phase 7) — term.hut already has its own file tree, its own
// open path and its own save hook, and a view that arrived carrying a second
// one would be the bug. This module is the clearest case of that: a portable
// view is handed *text* and hands text back, and has no idea where either came
// from. Only this file knows there is a filesystem.
//
// Which is also why nothing here is imported by anything under src/. That is
// not a convention to remember; scripts/check-imports.mjs fails the build over
// it, and it is the reason Phase 8 can be a copy.
//
// The Rust side is three commands, deliberately small:
//
//   xd_read_file(path)              -> String
//   xd_write_file(path, contents)   -> ()
//   xd_startup_path()               -> Option<String>
//
// `xd_startup_path` is how a double-clicked .excalidraw arrives: macOS hands
// the app an open-document event, not an argv entry, so the path has to be
// collected on the Rust side and asked for once the webview is up.

/// The Tauri globals, or null when there aren't any.
///
/// `withGlobalTauri: true` in tauri.conf.json puts `invoke` and the dialog
/// plugin on `window.__TAURI__` before any page script runs — there is no
/// bundler here, so `import { invoke } from "@tauri-apps/api"` has nothing to
/// resolve it and this is the supported shape rather than a shortcut.
///
/// Null is a real state, not an error: ui/ opens in a plain browser too, which
/// is how the painter gets exercised without building the app. Every function
/// below degrades to a clear message rather than throwing on `undefined`.
const tauri = () => (typeof window !== "undefined" ? window.__TAURI__ ?? null : null);

/// True when this page is running inside the app rather than a browser.
export const isApp = () => tauri() != null;

/// What to say when it isn't. One sentence, one place, so the four callers
/// can't drift into four different phrasings of the same fact.
const NO_HOST = "This build is running in a plain browser, which has no files.";

function invoke(command, args) {
  const t = tauri();
  if (!t) return Promise.reject(new Error(NO_HOST));
  return t.core.invoke(command, args);
}

/// Read a file's text. Rejects with whatever the Rust side said — a missing
/// file and a permission error are different problems and the user gets to see
/// which one they have.
export function readFile(path) {
  return invoke("xd_read_file", { path });
}

/// Write text to a file.
///
/// Callers must have decided the contents are worth writing *before* getting
/// here (PLAN.md Phase 5's `worthSaving` rule). This function will faithfully
/// write an empty string over an hour of someone's drawing, because that is
/// what it was asked to do; the judgement belongs one level up, where there is
/// enough context to make it.
export function writeFile(path, contents) {
  return invoke("xd_write_file", { path, contents });
}

/// Write bytes to a file — the export path, not the save path.
///
/// A separate command from `writeFile` for the reason `export.js` documents at
/// length: a PNG routed through a `String` is corrupted at every byte that is
/// not valid UTF-8. `Uint8Array` is normalised to a plain array because that is
/// what Tauri's IPC serialises into a Rust `Vec<u8>`.
export function writeBytes(path, contents) {
  return invoke("xd_write_bytes", {
    path,
    contents: Array.from(contents instanceof Uint8Array ? contents : new Uint8Array(contents)),
  });
}

/// The file the app was launched with — a double-clicked document, or a path
/// on the command line. Null when it was launched on its own.
export async function startupPath() {
  if (!isApp()) return null;
  try {
    return (await invoke("xd_startup_path")) ?? null;
  } catch {
    // Not knowing how the app was launched is not worth refusing to start
    // over; the user gets an empty document and can open one themselves.
    return null;
  }
}

/// The dialog filter, defined once. `excalidraw` first and `json` after it, so
/// the picker defaults to the specific type but a scene someone saved as .json
/// is still reachable without switching to "All files".
const FILTERS = [
  { name: "Excalidraw", extensions: ["excalidraw", "json"] },
];

/// Ask for a file to open. Null when the user cancelled — which is a normal
/// outcome and must not look like a failure anywhere upstream.
export async function chooseOpenPath() {
  const t = tauri();
  if (!t) throw new Error(NO_HOST);
  const picked = await t.dialog.open({ multiple: false, directory: false, filters: FILTERS });
  // The plugin returns a string, or an array when `multiple` is set, or null.
  // We never set multiple, but normalising costs one line and means a future
  // "open several" doesn't silently hand a caller an array.
  if (Array.isArray(picked)) return picked[0] ?? null;
  return typeof picked === "string" ? picked : null;
}

/// Ask where to save. `suggested` seeds the name field; the extension is added
/// when the user didn't type one, because a scene saved as "diagram" with no
/// extension won't open by double-click and the file association is most of
/// what Phase 7 is for.
export async function chooseSavePath(suggested = "Untitled.excalidraw") {
  const t = tauri();
  if (!t) throw new Error(NO_HOST);
  const picked = await t.dialog.save({ defaultPath: suggested, filters: FILTERS });
  if (typeof picked !== "string") return null;
  return /\.[A-Za-z0-9]+$/.test(picked) ? picked : `${picked}.excalidraw`;
}

/// The file menu's keyboard, without a menu.
///
/// The app has no menu bar of its own yet (Phase 7), so these are the only way
/// to reach New / Open / Save / Save As. Bound on the window at the capture
/// phase so they beat anything the mounted view has bound on its own host —
/// ⌘S must save the document no matter what has focus, and a canvas that
/// swallowed it would be a canvas that quietly discarded work.
///
/// The one thing deliberately *not* intercepted is a keystroke inside a text
/// field: Phase 6 gives the editor a positioned <textarea> for text elements,
/// and ⌘A inside it is "select this text", not "select every shape". ⌘S stays
/// intercepted even there, because saving is never the field's business.
///
/// Returns a dispose function. The app is one window with one shell today, so
/// nothing calls it — but a listener on `window` that outlives its owner is
/// exactly the hazard term.hut's preview hosts learned the hard way, and a
/// module that can't be torn down teaches the next caller the wrong lesson.
export function installShortcuts({ onNew, onOpen, onSave, onSaveAs } = {}) {
  const onKey = (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
    const key = ev.key.toLowerCase();
    const typing = /^(input|textarea)$/i.test(ev.target?.tagName ?? "")
      || ev.target?.isContentEditable === true;
    let run = null;
    if (key === "s") run = ev.shiftKey ? onSaveAs : onSave;
    else if (typing) return;
    else if (key === "n" && !ev.shiftKey) run = onNew;
    else if (key === "o" && !ev.shiftKey) run = onOpen;
    if (!run) return;
    ev.preventDefault();
    // Stopped as well as prevented: in the app these are also the browser's
    // own shortcuts, and WebKit will act on one it still sees.
    ev.stopPropagation();
    run();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

/// The display name for a path — the last segment, or "Untitled" for a
/// document that has never been saved.
export function basename(path) {
  if (!path) return "Untitled";
  const parts = String(path).split("/");
  return parts[parts.length - 1] || String(path);
}

/// An empty scene, in the shape Excalidraw itself writes.
///
/// `source` is the field Excalidraw uses to say which client wrote a file, and
/// it is worth being honest in: a scene that claims to have come from
/// excalidraw.com when it didn't makes a bug report harder to read for
/// everyone downstream.
export function emptyScene() {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "excalidraw-rs",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff", gridSize: null },
      files: {},
    },
    null,
    2,
  );
}
