// The app: a window, a document, and a host for a view.
//
// The discipline this whole project rests on (PLAN.md, "Layout") is that the
// standalone app is a *host for a term.hut view*, not an app with a view
// bolted on. This file is the host. It owns the window title, the dirty
// marker, which file is open and what happens to ⌘S — and it owns none of the
// drawing, none of the scene and none of the editing, because all three of
// those are the view's and the view has to be liftable out whole.
//
// So the shape here is deliberately thin: open a document, hand its *text* to
// a mount function, take back a dispose function, and put whatever the view
// contributes into the header. That is the same relationship term.hut's
// preview.js has with bpmnView.js, down to the argument names, and it is the
// reason Phase 8 is a copy and a small diff rather than an unpicking.
//
// Nothing under src/ may import this file, or anything else in standalone/.
// scripts/check-imports.mjs enforces that; see its header for why the rule
// needed mechanising rather than remembering.

import { div } from "../src/dom.js";
import { renderActions } from "../src/viewActions.js";
import { parseScene } from "../src/excalidrawScene.js";
import { renderExcalidrawCanvas } from "../src/excalidrawView.js";
import {
  basename, chooseOpenPath, chooseSavePath, emptyScene, installShortcuts,
  isApp, readFile, startupPath, writeFile,
} from "./files.js";
import { exportActions } from "./export.js";

// --- the mount ---------------------------------------------------------------
//
// One binding, and it is the seam. Today it is an adapter over the read-only
// painter, so the app runs and draws a real file end to end before the editor
// exists — which is worth a lot: the window, the dialogs, the header, the
// theming and the teardown all get exercised against something real instead of
// being written blind and debugged all at once later.
//
// When excalidrawEdit.js lands, this becomes:
//
//   import { renderExcalidraw } from "../src/excalidrawEdit.js";
//   const mountView = renderExcalidraw;
//
// and nothing else in this file changes. That is the point of writing the
// adapter to the editor's contract rather than to the painter's: the call
// shape below — `mountView(host, text, { onSave, onActions })` returning a
// dispose function — is Phase 5's contract, and it is already what the rest of
// this file calls.
const mountView = mountReadOnlyPainter;

/// The adapter. Takes the editor's arguments and drives the viewer with them.
///
/// Two things it does *not* do, both on purpose:
///
/// `onSave` is accepted and never called. The painter cannot edit, so there is
/// nothing to save, and inventing a save path here would mean writing one that
/// the editor then has to replace. A document opened today is never dirty.
///
/// A file that doesn't parse gets a sentence in the pane, not a blank canvas.
/// That distinction is the same one bpmnView.js makes and for the same reason:
/// a blank canvas over a file we failed to read is one stray keystroke away
/// from overwriting a real drawing with nothing.
function mountReadOnlyPainter(host, text, { onSave, onActions } = {}) {
  void onSave;
  const parsed = parseScene(text);
  if (!parsed.ok) {
    const note = div("preview-note err", parsed.error);
    host.appendChild(note);
    onActions?.([]);
    return () => note.remove();
  }
  return renderExcalidrawCanvas(host, parsed, { onActions });
}

// --- the document ------------------------------------------------------------

const host = document.getElementById("host");
const actionsHost = document.getElementById("view-actions");
const nameEl = document.getElementById("doc-name");
const dirtyEl = document.getElementById("doc-dirty");

/// Everything the shell knows. Not a class: there is exactly one of these, and
/// a singleton with a constructor is a class pretending it might be two.
const doc = {
  path: null,
  /// What is on disk, as far as we know. The dirty flag is derived from this
  /// rather than from an "edited" boolean, so an edit that is undone back to
  /// the saved state correctly stops being dirty.
  saved: "",
  text: "",
};

let dispose = null;
/// The view's handle. It is the dispose function — a function is what the
/// contract returns, and what term.hut's preview.js stores — and the editor
/// may hang capabilities off it (`exportPNG`, `exportSVG`; see export.js).
let live = null;
/// The view's own header contributions, remembered so the shell can republish
/// the row when *its* entries change without asking the view to repaint.
let viewActions = [];
/// One line of trouble, shown in the header. "" is the resting state.
let problem = "";

const dirty = () => doc.text !== doc.saved;

/// The window title and the marker beside the name. Both derived, both painted
/// from the same place, so they cannot disagree about whether there are
/// unsaved changes.
function paintChrome() {
  const name = basename(doc.path);
  nameEl.textContent = name;
  // The full path as a tooltip: the name alone is ambiguous the moment two
  // projects both have a "flow.excalidraw".
  nameEl.title = doc.path ?? "Not saved yet";
  dirtyEl.hidden = !dirty();
  const title = `${dirty() ? "• " : ""}${name} — excalidraw-rs`;
  document.title = title;
  // The native title too: with titleBarStyle "Overlay" the OS title is hidden
  // in the window itself but still shows in Mission Control and the Window
  // menu, and a window called "excalidraw-rs" among four others is useless.
  try {
    window.__TAURI__?.window?.getCurrentWindow?.().setTitle(title);
  } catch { /* not fatal; the in-page title is the one being read */ }
}

/// Repaint the header. The view's contributions come first and the app's
/// after, so the things that change with what is on screen stay next to each
/// other and the app's own entries don't jump around as the view republishes.
///
/// renderActions diffs by id, so this may be called on every frame — and is,
/// because the canvas republishes its zoom readout as you pinch.
function paintActions() {
  renderActions(actionsHost, [
    ...viewActions,
    ...exportActions({
      getView: () => live,
      docPath: () => doc.path,
      report: setProblem,
    }),
    ...(problem ? [{ id: "app-problem", kind: "status", text: problem, tone: "err" }] : []),
  ]);
}

function setProblem(message) {
  problem = message ?? "";
  paintActions();
}

/// Tear down whatever is mounted and put `text` on screen.
///
/// The teardown is unconditional and comes first. A view left running in a
/// host that has been emptied keeps its ResizeObserver, its window listeners
/// and its animation frame — the hazard excalidrawView.js's own header calls
/// out, learned the hard way by term.hut's preview panes.
function mount(text) {
  dispose?.();
  dispose = null;
  live = null;
  viewActions = [];
  host.textContent = "";
  problem = "";
  live = mountView(host, text, {
    onSave: onViewSave,
    onActions: (list) => {
      viewActions = Array.isArray(list) ? list : [];
      paintActions();
    },
  });
  dispose = typeof live === "function" ? live : null;
  paintActions();
  paintChrome();
}

/// The view autosaves through this. It is the only way text gets from the view
/// back to disk, and the only place the shell learns that the document
/// changed.
///
/// It throws on failure rather than swallowing: bpmnView.js's contract is that
/// a failed write is reported in the view's own header, next to the save
/// button the user is looking at, and swallowing it here would take that away.
async function onViewSave(text) {
  doc.text = String(text ?? "");
  paintChrome();
  if (!doc.path) {
    // Nowhere to put it yet. Not an error — a new drawing is expected to be
    // unsaved — so the autosave stays quiet and ⌘S will ask for a path.
    return;
  }
  await writeFile(doc.path, doc.text);
  doc.saved = doc.text;
  paintChrome();
}

// --- the file menu, without a menu -------------------------------------------

async function openPath(path) {
  const text = await readFile(path);
  doc.path = path;
  doc.saved = String(text ?? "");
  doc.text = doc.saved;
  mount(doc.text);
}

/// Every entry point funnels through this so a failure has exactly one place
/// to land, and so a cancelled dialog — which returns null and is not a
/// failure — never reaches the error path.
function attempt(work) {
  return Promise.resolve()
    .then(work)
    .then(() => setProblem(""))
    .catch((e) => setProblem(String(e?.message ?? e)));
}

const newDocument = () =>
  attempt(() => {
    doc.path = null;
    doc.saved = emptyScene();
    doc.text = doc.saved;
    mount(doc.text);
  });

const openDocument = () =>
  attempt(async () => {
    const path = await chooseOpenPath();
    if (!path) return;
    await openPath(path);
  });

/// ⌘S. A document with a path is written where it already lives; one without
/// falls through to Save As, which is what every other editor does and what
/// the finger expects.
const saveDocument = () =>
  attempt(async () => {
    if (!doc.path) return saveDocumentAs();
    await writeFile(doc.path, doc.text);
    doc.saved = doc.text;
    paintChrome();
  });

const saveDocumentAs = () =>
  attempt(async () => {
    const path = await chooseSavePath(basename(doc.path));
    if (!path) return;
    await writeFile(path, doc.text);
    doc.path = path;
    doc.saved = doc.text;
    paintChrome();
  });

installShortcuts({
  onNew: newDocument,
  onOpen: openDocument,
  onSave: saveDocument,
  onSaveAs: saveDocumentAs,
});

// --- boot ---------------------------------------------------------------------
//
// A double-clicked .excalidraw arrives as a startup path, not as an argv entry
// (macOS sends an open-document event), so it is asked for rather than parsed.
// Anything that goes wrong reading it degrades to an empty document with the
// reason in the header: the app opening is more important than the file
// opening, and a window that refuses to appear is a window with nowhere to
// show you what went wrong.

attempt(async () => {
  const path = await startupPath();
  if (path) {
    await openPath(path);
    return;
  }
  doc.saved = emptyScene();
  doc.text = doc.saved;
  mount(doc.text);
  if (!isApp()) {
    // Running from a plain file:// or dev server. Worth saying once: every
    // dialog in this session will refuse, and the reason isn't obvious.
    setProblem("No app host — open and save are unavailable.");
  }
});
