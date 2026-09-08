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

import { el } from "../src/dom.js";
import { renderExcalidraw } from "../src/excalidrawEdit.js";
import {
  basename, chooseOpenPath, chooseSavePath, emptyScene, installShortcuts,
  isApp, readFile, startupPath, writeFile,
} from "./files.js";
import { exportActions } from "./export.js";
import { installMenu } from "./menu.js";

// --- the mount ---------------------------------------------------------------
//
// One binding, and it is the seam. Swapping it from a read-only adapter to the
// editor was the whole of the change this file needed when excalidrawEdit.js
// landed, which is the point of having written that adapter to the *editor's*
// contract rather than to the painter's: the call shape
// `mountView(host, text, { onSave, onActions })` returning a dispose function
// is Phase 5's contract, and it was already what the rest of this file called.
//
// The adapter is gone rather than kept as a fallback. Dead code that shadows a
// live path is worse than no code — it invites someone to fix a bug in the
// copy nothing runs. `excalidrawView.js` still exports `renderExcalidrawCanvas`
// for anyone who wants a viewer, and git has the twenty lines that adapted it.
const mountView = renderExcalidraw;

// --- the document ------------------------------------------------------------

const host = document.getElementById("host");
const toolSlot = document.getElementById("tool-slot");
const statusEl = document.getElementById("app-status");
const nameEl = document.getElementById("doc-name");
const dirtyEl = document.getElementById("doc-dirty");

// --- the sidebar toggle ------------------------------------------------------
//
// The button is the app's and the panel is the view's, which is the same split
// as the tool island: the host decides where a control lives, the view decides
// what it means. The state is here rather than in the view because it has to
// outlive a mount — the view is torn down and rebuilt on every file that is
// opened, and a sidebar that reopened itself each time would be a preference
// the app kept forgetting.

/// Tabler's "layout-sidebar". Static markup, as everywhere else.
const SIDEBAR_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
  + 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path stroke="none" d="M0 0h24v24H0z" fill="none" />'
  + '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" />'
  + '<path d="M9 4v16" />'
  + "</svg>";

let sidebarOpen = true;

const sidebarBtn = el("button", "chrome-btn");
sidebarBtn.type = "button";
sidebarBtn.innerHTML = SIDEBAR_ICON;
document.getElementById("sidebar-slot")?.appendChild(sidebarBtn);

function paintSidebarBtn() {
  const name = sidebarOpen ? "Hide the properties sidebar" : "Show the properties sidebar";
  sidebarBtn.title = name;
  sidebarBtn.setAttribute("aria-label", name);
  sidebarBtn.setAttribute("aria-pressed", String(sidebarOpen));
  sidebarBtn.classList.toggle("on", sidebarOpen);
}

sidebarBtn.addEventListener("click", () => {
  sidebarOpen = !sidebarOpen;
  // `live` is the view's handle — the dispose function, with the view's
  // capabilities hung off it. A mount that failed leaves it null and the
  // button still flips, so the next mount opens in the state the user chose.
  live?.setSidebar?.(sidebarOpen);
  paintSidebarBtn();
});

paintSidebarBtn();

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

/// Everything that can be done, as viewActions.js descriptors: the view's
/// contributions first and the app's after.
///
/// The app's four are the ones the view cannot have — they are a filesystem
/// and a native dialog, which is exactly the line export.js's header draws.
/// Until now they existed only as ⌘N / ⌘O / ⌘S / ⇧⌘S, which is to say they
/// existed only for someone who had read files.js.
const allActions = () => [
  ...viewActions,
  {
    id: "app-new", group: "file", name: "New", shortcut: "⌘N",
    title: "Start an empty drawing", run: newDocument,
  },
  {
    id: "app-open", group: "file", name: "Open…", shortcut: "⌘O",
    title: "Open an .excalidraw file", run: openDocument,
  },
  {
    id: "app-save", group: "file", name: "Save", shortcut: "⌘S",
    // Save As when there is nowhere to save yet, which is what the shortcut
    // already does and what every other editor does.
    title: "Save this drawing", run: saveDocument,
  },
  {
    id: "app-save-as", group: "file", name: "Save As…", shortcut: "⇧⌘S",
    title: "Save this drawing to a new file", run: saveDocumentAs,
  },
  ...exportActions({
    getView: () => live,
    docPath: () => doc.path,
    report: setProblem,
  }),
];

/// The menu reads `allActions` every time it opens, so it is always describing
/// the document as it stands — Undo greyed when there is nothing to undo, the
/// zoom entries acting on the camera as it is now.
const menu = installMenu(document.getElementById("menu-slot"), { actions: allActions });

/// The one line of trouble in the titlebar.
///
/// The app's own problem if there is one, otherwise whatever the view is
/// reporting — the view publishes its failures as an error status among its
/// actions, and a save that failed inside the view is the user's problem
/// whichever half of the app noticed it.
function paintStatus() {
  const fromView = viewActions.find((a) => a?.kind === "status" && a.tone === "err");
  const text = problem || fromView?.text || "";
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

/// The view republishes on every frame of a pinch, so this is on the hot path.
/// Both halves are cheap by construction: the status is two string compares,
/// and the menu's refresh returns immediately unless it is open.
function paintActions() {
  paintStatus();
  menu.refresh();
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
    // Where the app would like the tool island: in the titlebar, beside the
    // document's name, which is where macOS puts a window's tools. The view
    // treats this as a suggestion it happens to be able to honour — mounted
    // without one, in a browser or in a term.hut pane, it floats the island
    // over the canvas as before. Handing over an element rather than asking
    // for the buttons keeps that decision the host's and the island the
    // view's.
    toolbarSlot: toolSlot,
    // The sidebar opens in whatever state the toggle is in, so opening a file
    // does not undo a choice the user made about the window.
    sidebar: sidebarOpen,
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
