// One top row per panel, whatever the panel is showing.
//
// A file that opens in a viewer used to stack toolbars: the pane header, the
// tab strip, the preview's own bar (the file name again, plus its buttons),
// and — for the two views that are really editors — a third bar of their own
// with "Fit" and "Save now" in it. Four rows of chrome above a diagram, three
// of them saying something the row above already said.
//
// So a view doesn't build a bar any more; it *contributes* to the header, and
// the header repaints when the tab in front changes. A contribution is a
// plain descriptor:
//
//   { id, icon, title, run, toggle, on, disabled }   an icon button
//   { id, label, title, run }                        a short text button ("1:1")
//   { id, kind: "status", text, tone }               a readout (zoom %, an error)
//
// `id` is what the row diffs against, so a view may republish on every frame
// — the canvas does, for its zoom readout — without churning the DOM or
// dropping the button the pointer is over.
import { el } from "./dom.js";
import { setPressed } from "./a11y.js";

/// Tabler icons, inline like every other icon in the app (index.html's header
/// buttons, tabstrip.js's close x). Static markup, so innerHTML is safe here.
const ICON = {
  fit:
    '<path d="M16 4l4 0l0 4" /><path d="M14 10l6 -6" /><path d="M8 20l-4 0l0 -4" />' +
    '<path d="M4 20l6 -6" /><path d="M16 20l4 0l0 -4" /><path d="M14 14l6 6" />' +
    '<path d="M8 4l-4 0l0 4" /><path d="M4 4l6 6" />',
  save:
    '<path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2" />' +
    '<path d="M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M14 4l0 4l-6 0l0 -4" />',
  external:
    '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" />' +
    '<path d="M11 13l9 -9" /><path d="M15 4h5v5" />',
  zoomIn:
    '<path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M7 10l6 0" />' +
    '<path d="M10 7l0 6" /><path d="M21 21l-6 -6" />',
  zoomOut:
    '<path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M7 10l6 0" />' +
    '<path d="M21 21l-6 -6" />',
  scripts:
    '<path d="M7 8l-4 4l4 4" /><path d="M17 8l4 4l-4 4" /><path d="M14 4l-4 16" />',
};

const svg = (paths) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none" />' +
  paths + "</svg>";

/// host -> Map(id -> element). Off the element, so a host that is emptied by
/// its owner starts clean and nothing here outlives the DOM it describes.
const rows = new WeakMap();

/// Paint `list` into `host`, reusing the elements already there. Descriptors
/// with no `id` are ignored — the diff has nothing to hold on to.
export function renderActions(host, list = []) {
  if (!host) return;
  let els = rows.get(host);
  if (!els) rows.set(host, (els = new Map()));
  const seen = new Set();
  for (const a of list) {
    if (a?.id == null || seen.has(a.id)) continue;
    seen.add(a.id);
    let e = els.get(a.id);
    if (!e) {
      e = make(a);
      els.set(a.id, e);
    }
    paint(e, a);
    host.appendChild(e); // append moves an existing element — re-orders in place
  }
  for (const [id, e] of els) {
    if (seen.has(id)) continue;
    e.remove();
    els.delete(id);
  }
  // An empty row must not eat the header's 0.5rem gap.
  host.hidden = !seen.size;
}

function make(a) {
  if (a.kind === "status") return el("span", "view-status");
  const b = el("button", "pane-btn view-act");
  // The handler reads the descriptor's current `run` off the element, so a
  // republish rebinds without a second listener.
  b.addEventListener("click", () => b._run?.());
  return b;
}

function paint(e, a) {
  if (a.kind === "status") {
    e.textContent = a.text ?? "";
    e.className = `view-status${a.tone ? ` ${a.tone}` : ""}`;
    return;
  }
  e._run = a.run;
  if (a.icon) {
    // Only when it changes: innerHTML re-parses, and this runs on every frame
    // the canvas paints.
    if (e.dataset.icon !== a.icon) {
      e.dataset.icon = a.icon;
      e.innerHTML = svg(ICON[a.icon] ?? "");
    }
  } else if (e.textContent !== a.label) {
    e.textContent = a.label ?? "";
  }
  const name = a.title ?? a.label ?? "";
  e.title = name;
  e.setAttribute("aria-label", name);
  e.disabled = !!a.disabled;
  e.classList.toggle("view-act-text", !a.icon);
  if (a.toggle) {
    e.classList.toggle("on", !!a.on);
    setPressed(e, !!a.on);
  }
}
