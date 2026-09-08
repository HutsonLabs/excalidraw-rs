// One button, and everything the app can do behind it.
//
// The titlebar used to carry the whole of it in a row: fit, zoom out, a zoom
// readout, zoom in, 1:1, undo, redo, the live tool's name, save, PNG, SVG, and
// an appearance control — thirteen things, in icons, next to a file name and a
// tool island. Which is how a Mac window does *not* look. A Mac window puts
// three things in its titlebar and its verbs in a menu.
//
// So the row is gone from the app and this is what replaced it. The row itself
// is not gone from the codebase: ui/src/viewActions.js still renders one, for
// term.hut, which has a pane header with room in it. Both read the same
// descriptors — the view contributes what it can do and neither host has to
// ask it for anything different — and that is the whole reason this file can
// exist without the view knowing it does. See viewActions.js's header for the
// three optional fields (`name`, `shortcut`, `group`) a menu reads and a row
// ignores.
//
// A descriptor with no `name` is not shown here. It is the opt-in that lets
// the view keep offering "Save now" to a pane header while the app leaves it
// out in favour of the File section's own Save, which also knows what to do
// when the document has never been written anywhere.

import { el, div } from "../src/dom.js";
import { installAppearance } from "./theme.js";

/// The sections, in order, and what each is called.
///
/// "Other" is last and is where a descriptor with an unrecognised group ends
/// up. It exists so that a view which grows a new group gets a visibly
/// misfiled entry rather than a missing one: an entry nobody can reach is the
/// worse of the two failures, and the wrong heading is a bug report.
const GROUPS = [
  ["file", "File"],
  ["edit", "Edit"],
  ["view", "View"],
  ["export", "Export"],
  ["other", "Other"],
];

const FALLBACK = "other";
const known = (group) => (GROUPS.some(([g]) => g === group) ? group : FALLBACK);

/// Tabler's "dots" — three of them, horizontal. Static markup, as everywhere
/// else in this codebase that draws an icon.
const MENU_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
  + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path stroke="none" d="M0 0h24v24H0z" fill="none" />'
  + '<path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />'
  + '<path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />'
  + '<path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />'
  + "</svg>";

/// Mount the menu into `host`.
///
///   installMenu(host, { actions }) -> { refresh(), dispose() }
///
/// `actions()` returns the current descriptor list — the view's contributions
/// and the app's own, already merged. It is called every time the menu opens,
/// so what is on screen is what is true now: Undo is greyed when there is
/// nothing to undo, and the zoom entries act on the camera as it stands.
///
/// `refresh()` rebuilds the open menu in place. The shell calls it when the
/// view republishes, which happens on every frame of a pinch — so it is a
/// no-op while the menu is closed, which is nearly always.
export function installMenu(host, { actions } = {}) {
  if (!host) return { refresh() {}, dispose() {} };

  const offs = [];
  const on = (node, type, fn, opts) => {
    if (!node) return;
    node.addEventListener(type, fn, opts);
    offs.push(() => node.removeEventListener(type, fn, opts));
  };

  const button = el("button", "menu-btn");
  button.type = "button";
  button.title = "Menu";
  button.setAttribute("aria-label", "Menu");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = MENU_ICON;
  host.appendChild(button);

  const pop = div("menu-pop");
  pop.setAttribute("role", "menu");
  pop.setAttribute("aria-label", "Menu");
  pop.hidden = true;

  // The appearance control is built once and moved into each rebuild, rather
  // than rebuilt with the rows: it owns a listener on the system preference,
  // and tearing that down and re-installing it every time the menu opens would
  // be three lines of leak waiting to happen.
  const appearanceRow = div("menu-appearance");
  const appearanceLabel = div("menu-section", "Appearance");
  const appearanceHost = div("menu-appearance-host");
  appearanceRow.appendChild(appearanceLabel);
  appearanceRow.appendChild(appearanceHost);
  const disposeAppearance = installAppearance(appearanceHost);
  offs.push(disposeAppearance);

  let open = false;

  /// Every enabled row, in the order they are on screen. The arrow keys walk
  /// this; a disabled entry is skipped rather than being a stop that does
  /// nothing when you press Return on it.
  let items = [];

  /// The rows' own listeners, undone before each rebuild and again on dispose.
  ///
  /// A real DOM would collect these with the elements they are on, so this is
  /// not a leak anyone would ever see. It is bookkeeping, and the bookkeeping
  /// is the point: ui/test/support/harness.js counts every add against every
  /// remove, and a module that let its own count drift would be
  /// indistinguishable from one that had genuinely forgotten something.
  let rowOffs = [];

  function clearRows() {
    for (const off of rowOffs) off();
    rowOffs = [];
  }

  function build() {
    clearRows();
    const list = (actions?.() ?? []).filter((a) => a && a.name && typeof a.run === "function");
    const rows = [];
    pop.replaceChildren();
    items = [];

    for (const [group, title] of GROUPS) {
      const mine = list.filter((a) => known(a.group) === group);
      if (!mine.length) continue;
      if (rows.length) pop.appendChild(div("menu-sep"));
      pop.appendChild(div("menu-section", title));
      for (const a of mine) {
        const row = el("button", "menu-item");
        row.type = "button";
        row.setAttribute("role", "menuitem");
        row.appendChild(el("span", "menu-label", a.name));
        // The shortcut is printed, never parsed: it is a reminder of a binding
        // that lives in files.js and in the view's own keydown handler, and a
        // menu that bound its own would be a third place for them to disagree.
        if (a.shortcut) row.appendChild(el("span", "menu-key", a.shortcut));
        row.disabled = !!a.disabled;
        // The full sentence the row renderer would have used as a tooltip.
        if (a.title) row.title = a.title;
        if (!row.disabled) {
          const choose = () => {
            close();
            a.run();
          };
          row.addEventListener("click", choose);
          rowOffs.push(() => row.removeEventListener("click", choose));
          items.push(row);
        }
        pop.appendChild(row);
        rows.push(row);
      }
    }

    if (rows.length) pop.appendChild(div("menu-sep"));
    pop.appendChild(appearanceRow);
  }

  /// Under the button and aligned to its trailing edge. Fixed rather than
  /// absolute so the popover is measured against the window and cannot be
  /// clipped by the titlebar's own overflow — a menu that opens inside a 52px
  /// bar is a menu with one row of itself visible.
  function place() {
    const r = button.getBoundingClientRect?.();
    if (!r) return;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.round((globalThis.innerWidth ?? 0) - r.right)}px`;
  }

  function openMenu() {
    if (open) return;
    open = true;
    build();
    (globalThis.document?.body ?? host).appendChild(pop);
    pop.hidden = false;
    place();
    button.setAttribute("aria-expanded", "true");
    button.classList.toggle("on", true);
    items[0]?.focus?.();
  }

  function close() {
    if (!open) return;
    open = false;
    pop.hidden = true;
    pop.remove();
    button.setAttribute("aria-expanded", "false");
    button.classList.toggle("on", false);
  }

  on(button, "click", (ev) => {
    ev.stopPropagation?.();
    if (open) close();
    else openMenu();
  });

  // Anywhere else. `pointerdown` rather than `click`, so the menu is gone
  // before the press lands on the canvas underneath — otherwise closing the
  // menu by clicking the drawing also starts a marquee in it.
  on(globalThis.document, "pointerdown", (ev) => {
    if (!open) return;
    let node = ev.target;
    while (node) {
      if (node === pop || node === button) return;
      node = node.parentNode;
    }
    close();
  }, true);

  on(globalThis.window, "keydown", (ev) => {
    if (!open) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      button.focus?.();
      return;
    }
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    const at = items.indexOf(globalThis.document?.activeElement);
    const step = ev.key === "ArrowDown" ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next]?.focus?.();
  }, true);

  // A window that moved or resized under an open menu leaves it pointing at
  // where the button used to be.
  on(globalThis.window, "resize", () => { if (open) place(); });

  return {
    refresh() {
      if (!open) return;
      build();
      place();
    },
    dispose() {
      close();
      clearRows();
      for (const off of offs) off();
      offs.length = 0;
      button.remove();
    },
  };
}
