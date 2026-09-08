// The tool island — the row of shapes that floats over the top of the canvas.
//
// This exists because the editor was, for a while, unusable without knowing
// nine keyboard shortcuts. The shortcuts are the right primary interface and
// they are all still there; what was missing was any way to *discover* them,
// or to draw a rectangle at all if you had never read the source. The first
// thing anyone does with a drawing app is open it and try to draw a box.
//
// It is not a toolbar in the pane-header sense and must never become one. Fit,
// zoom, undo, redo and Save belong to the host's header (viewActions.js) and
// are contributed there by excalidrawEdit.js; duplicating any of them here
// would be the second row of chrome saying what the first row already said.
// This island says exactly one thing the header cannot: which tool the next
// click uses.
//
// Structurally it is excalidrawProps.js's island, deliberately: same mount
// contract, same stylesheet-beside-the-module habit, same build-once-then-sync
// discipline. Two islands that were nearly the same shape would be worse than
// either, and at PLAN.md Phase 8 both are lifted into term.hut as a copy of a
// module and a copy of its stylesheet.
//
// The tool *table* is not here. It is `TOOLS` in excalidrawTools.js, where the
// state machine that acts on it lives, so a tool cannot exist on screen
// without a key that selects it or exist as a key without a button. What is
// here is what a button looks like and what order the buttons come in — the
// two things that are genuinely about the view.
import { el, div } from "./dom.js";
import { setPressed } from "./a11y.js";
import { TOOLS } from "./excalidrawTools.js";

/// Excalidraw's own order, which is not the order the state machine happens to
/// declare them in. Select and hand first because they are the two that do not
/// draw anything, then the shapes roughly in order of how often they are used.
/// Matching it matters for the same reason matching the shortcuts does: a hand
/// that has used Excalidraw reaches for the third button without looking.
/// The eraser sits last among the drawing tools, where Excalidraw puts it —
/// after text, past everything that makes a mark. It is the one entry here that
/// is not a shape, and it belongs on this side of the divider rather than beside
/// select and hand: it changes the document, which is what the tools below the
/// divider have in common and what select and hand do not.
const ORDER = [
  "select", "hand",
  "rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text",
  "image", "eraser",
];

/// Where the divider goes — after the two tools that do not draw.
const GROUP_BREAK = 2;

/// Tabler icons, inline, exactly as viewActions.js does it: static markup with
/// nothing interpolated, which is the one place this codebase allows innerHTML.
/// Every button also carries its name in `title` and `aria-label`, so nothing
/// here is only available to someone who can see the glyph.
const ICONS = {
  select:
    '<path d="M7.904 17.563a1.2 1.2 0 0 0 2.228 .308l2.09 -3.093l4.907 4.907a1.067 1.067 0 0 0 '
    + '1.509 0l1.047 -1.047a1.067 1.067 0 0 0 0 -1.509l-4.907 -4.907l3.113 -2.09a1.2 1.2 0 0 0 '
    + '-.309 -2.228l-13.582 -3.904l3.904 13.563z" />',
  hand:
    '<path d="M8 13v-8.5a1.5 1.5 0 0 1 3 0v7.5" />'
    + '<path d="M11 11.5v-2a1.5 1.5 0 0 1 3 0v2.5" />'
    + '<path d="M14 10.5a1.5 1.5 0 0 1 3 0v1.5" />'
    + '<path d="M17 11.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1 -6 6h-2a6 6 0 0 1 -5 -2.7l-.2 -.3'
    + 'c-.3 -.5 -1.4 -2.4 -3.3 -5.7a1.5 1.5 0 0 1 .5 -2a1.9 1.9 0 0 1 2.3 .3l1.5 1.4" />',
  rectangle:
    '<path d="M3 5m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z" />',
  diamond:
    '<path d="M10.5 20.4l-6.9 -6.9c-.781 -.781 -.781 -2.219 0 -3l6.9 -6.9c.781 -.781 2.219 '
    + '-.781 3 0l6.9 6.9c.781 .781 .781 2.219 0 3l-6.9 6.9c-.781 .781 -2.219 .781 -3 0z" />',
  ellipse:
    '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />',
  arrow:
    '<path d="M5 12l14 0" /><path d="M13 18l6 -6" /><path d="M13 6l6 6" />',
  line:
    '<path d="M6 18l12 -12" />'
    + '<path d="M4 20m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />'
    + '<path d="M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />',
  freedraw:
    '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />'
    + '<path d="M13.5 6.5l4 4" />',
  text:
    '<path d="M4 6v-1h16v1" /><path d="M12 5v14" /><path d="M9 19h6" />',
  image:
    '<path d="M15 8h.01" />'
    + '<path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12z" />'
    + '<path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5" />'
    + '<path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3" />',
  eraser:
    '<path d="M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 '
    + '0 1.41l-9.2 9.3" />'
    + '<path d="M18 13.3l-6.3 -6.3" />',
  lock:
    '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z" />'
    + '<path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0" />'
    + '<path d="M8 11v-4a4 4 0 1 1 8 0v4" />',
};

const svg = (body) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
  + 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path stroke="none" d="M0 0h24v24H0z" fill="none" />' + body + "</svg>";

/// A tool's shortcuts as a sentence: "R or 2", "H" for the one tool without a
/// digit, "9" for the one without a letter. The title is where a shortcut is
/// actually learned — the little numeral on the button is a reminder for someone
/// who already knows.
///
/// `alias` is listed too ("P, X or 7"). Draw is the only tool with one, and both
/// spellings are in the wild upstream, so a hand that learned X finds nothing
/// telling it X works unless this says so.
///
/// Built from whatever the tool has rather than from a fixed shape, because the
/// table has grown a tool with no letter (image, digit only) and would otherwise
/// have got a title reading "Image — ".
const shortcutOf = (tool) => {
  const keys = [tool.key, tool.alias].filter(Boolean).map((k) => k.toUpperCase());
  if (tool.digit) keys.push(tool.digit);
  if (keys.length === 1) return keys[0];
  return `${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]}`;
};

/// The stylesheet lives beside this module rather than in the app's own, so
/// the port is a copy of two files instead of a copy of one plus a diff
/// against a stylesheet term.hut already owns. Injected once, keyed by id and
/// by href so a host that links it in its own HTML gets a no-op here, and
/// deliberately *not* removed on dispose: a second island mounting after the
/// first tore down would otherwise arrive unstyled.
const STYLE_ID = "xd-toolbar-css";

function ensureStylesheet() {
  const doc = globalThis.document;
  if (!doc?.head || typeof doc.createElement !== "function") return;
  if (doc.getElementById?.(STYLE_ID)) return;
  const href = new URL("./excalidrawToolbar.css", import.meta.url).href;
  for (const link of doc.querySelectorAll?.('link[rel="stylesheet"]') ?? []) {
    if (link.href === href) return;
  }
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = href;
  doc.head.appendChild(link);
}

/// Mount the tool island into `host`.
///
///   renderToolbar(host, { getTool, setTool, getLocked, setLocked, inline })
///     -> { refresh(), dispose() }
///
/// `inline` says the host is putting the tools in a bar of its own — the app's
/// titlebar, a pane header — rather than letting them float over the canvas.
/// It changes nothing about what the island *is*; it drops the card (the
/// absolute placement, the panel fill, the border and the shadow) so the
/// buttons sit in the host's row as if they had always been there. A card
/// nested inside a bar is the second piece of chrome saying what the first one
/// already said, which is the thing this file's header swears off.
///
/// `getTool()` and `getLocked()` read the editor's tool state; `setTool(id)`
/// and `setLocked(on)` write it. The island holds none of it — the state
/// machine in excalidrawTools.js is the only copy, so the keyboard and the
/// buttons cannot disagree about which tool is live. `refresh()` is how the
/// editor says one of them changed, and it is called after every keystroke
/// that touches the tool as well as after every click here.
///
/// The same shape as `renderProps`, and the same reasons: the DOM is built
/// once and then synced, never rebuilt, because `refresh()` may be called
/// while the keyboard is on one of these buttons.
export function renderToolbar(host, { getTool, setTool, getLocked, setLocked, inline } = {}) {
  if (!host) return { refresh() {}, dispose() {} };
  ensureStylesheet();

  const offs = [];
  const on = (node, type, fn) => {
    node.addEventListener(type, fn);
    offs.push(() => node.removeEventListener(type, fn));
  };

  const root = div(inline ? "xdt-island xdt-inline" : "xdt-island");
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Drawing tools");
  // Not in the tab order as nine separate stops: a toolbar is one stop, and
  // the arrow keys inside it belong to the canvas (they nudge the selection).
  // So the buttons are reachable by tab, which is what a toolbar of plain
  // buttons already gives, and nothing here intercepts a key.

  const buttons = new Map(); // tool id -> button

  ORDER.forEach((id, i) => {
    const tool = TOOLS.find((t) => t.id === id);
    if (!tool) return; // a tool renamed in the state machine and not here
    if (i === GROUP_BREAK) root.appendChild(div("xdt-sep"));

    const b = el("button", "xdt-btn");
    b.type = "button";
    const name = `${tool.label} — ${shortcutOf(tool)}`;
    b.title = name;
    b.setAttribute("aria-label", name);
    b.innerHTML = svg(ICONS[id] ?? "");
    // The numeral Excalidraw prints in the corner of each tool. It is the
    // reason anyone ever learns that 2 is the rectangle.
    if (tool.digit) b.appendChild(el("span", "xdt-key", tool.digit));
    setPressed(b, false);
    on(b, "click", () => setTool?.(id));
    root.appendChild(b);
    buttons.set(id, b);
  });

  root.appendChild(div("xdt-sep"));

  const lock = el("button", "xdt-btn xdt-lock");
  lock.type = "button";
  const lockName = "Keep the selected tool after drawing — Q";
  lock.title = lockName;
  lock.setAttribute("aria-label", lockName);
  lock.innerHTML = svg(ICONS.lock);
  setPressed(lock, false);
  on(lock, "click", () => setLocked?.(!getLocked?.()));
  root.appendChild(lock);

  host.appendChild(root);

  let disposed = false;

  function refresh() {
    if (disposed) return;
    const active = getTool?.();
    for (const [id, b] of buttons) {
      const isOn = id === active;
      setPressed(b, isOn);
      b.classList.toggle("on", isOn);
    }
    const locked = !!getLocked?.();
    setPressed(lock, locked);
    lock.classList.toggle("on", locked);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of offs) off();
    offs.length = 0;
    root.remove?.();
    if (root.parentNode === host) host.removeChild(root);
  }

  refresh();
  return { refresh, dispose };
}
