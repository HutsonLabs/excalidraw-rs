// Shared accessibility primitives.
//
// The app already had two components done properly — the file tree (role=tree
// with a roving tabindex, tree.js) and the question card (role=radio/checkbox,
// questionCard.js) — and nothing else. This module holds the pieces those two
// had to invent locally, so the rest of the UI can adopt them without each
// module hand-rolling its own focus loop.
//
// Three jobs:
//   asDialog  — the four overlays become real dialogs that hold the keyboard.
//   asButton  — a <div> that behaves like a button actually behaves like one.
//   announce  — state that changes without a click gets said out loud.

/// What can take focus inside a panel. Deliberately queried fresh on every Tab
/// rather than cached: the settings modal rebuilds its whole body on "Reset to
/// defaults", and the SSH modal grows and drops a fix step in place.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

let seq = 0;

/// Visible focusables in DOM order. `offsetParent` is null for anything
/// `display: none`, which is how the SSH modal's collapsed fix steps and the
/// settings modal's hidden rows drop out without bookkeeping.
function focusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter(
    (e) => e.offsetParent !== null || e === document.activeElement,
  );
}

/// Turn an overlay + panel pair into a modal dialog: named, announced as modal,
/// and holding the keyboard until it closes.
///
/// Every overlay in the app already handled Escape and backdrop clicks — what
/// none of them did was contain Tab. Without that, tabbing past the last
/// control walks into the terminal and the file tree *behind* the backdrop,
/// which the mouse can't reach. On the confirm dialog that meant "Move to
/// Trash" was on screen while focus was somewhere underneath it.
///
/// Returns a release function; call it from the caller's own close path.
export function asDialog(overlay, panel, { label } = {}) {
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  // The panel must be able to hold focus itself: it's where focus starts on
  // the modals that open without a field to land in, and where the focusin
  // guard below puts it back.
  if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;

  // Prefer the panel's own heading as the accessible name — it's the visible
  // title, so the two can't drift apart.
  const title = panel.querySelector(".modal-title");
  if (title) {
    if (!title.id) title.id = `dlg-title-${++seq}`;
    panel.setAttribute("aria-labelledby", title.id);
  } else if (label) {
    panel.setAttribute("aria-label", label);
  }

  const restoreTo = document.activeElement;

  const onKey = (e) => {
    if (e.key !== "Tab") return;
    // A dialog stacked on top of this one owns the keyboard (the confirm that
    // the SSH modal's fixes raise). Same guard the Escape handlers use.
    if (panel.closest(".modal-overlay") !== topOverlay()) return;
    const items = focusables(panel);
    if (!items.length) {
      e.preventDefault(); // nothing to move to; don't leak focus to the page
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    // The panel itself holds focus on open (tabIndex -1), so the first Tab has
    // no member of `items` to move from — send it to either end explicitly.
    if (!panel.contains(at) || at === panel) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && at === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Clicking the backdrop, or anything else that moves focus out from under
  // us, gets pulled back. Cheaper and more robust than trying to enumerate
  // every way focus can leave.
  const onFocusIn = (e) => {
    if (panel.contains(e.target)) return;
    if (panel.closest(".modal-overlay") !== topOverlay()) return;
    panel.focus();
  };

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocusIn, true);

  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocusIn, true);
    // Put the caret back where it came from, so closing settings with ⌘,
    // returns to the terminal rather than dumping focus on <body>.
    if (restoreTo?.isConnected) restoreTo.focus();
  };
}

/// The last-opened overlay still on screen. Overlays append to <body>, so DOM
/// order is stacking order.
function topOverlay() {
  const all = document.querySelectorAll(".modal-overlay");
  return all[all.length - 1] ?? null;
}

/// Make a non-button element behave like one: named, focusable, and activated
/// by Enter and Space the way every real button is.
///
/// Used for the rows that are semantically buttons but are built as divs
/// because they carry their own layout and a nested action control (drawer
/// sessions and agents, bell notifications, workspace chips, running-work
/// entries). The nested buttons stay real buttons — this only promotes the row
/// around them.
export function asButton(el, { label, expanded } = {}) {
  el.setAttribute("role", "button");
  if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
  if (label) el.setAttribute("aria-label", label);
  if (expanded != null) el.setAttribute("aria-expanded", String(expanded));
  // Idempotent: a tool row can be promoted again when its block is re-rendered,
  // and a second keydown listener would toggle the disclosure twice per press.
  if (el.dataset.a11yBtn) return el;
  el.dataset.a11yBtn = "1";
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Space scrolls the nearest scroller otherwise, which in a drawer means
    // the list jumps out from under the row you were about to activate.
    e.preventDefault();
    e.stopPropagation();
    el.click();
  });
  return el;
}

/// Reflect a two-state toggle button. The app paints these with an `.active` /
/// `.on` class, which says nothing to anything but the eye.
export function setPressed(el, on) {
  el?.setAttribute("aria-pressed", String(!!on));
}

// --- Announcements -------------------------------------------------------

/// One shared polite region for messages with no on-screen home of their own.
/// Toasts are the case: they appear in a fixed corner, unrelated to whatever
/// the user was doing, and vanish on a timer.
let liveEl = null;

function liveRegion() {
  if (liveEl) return liveEl;
  liveEl = document.createElement("div");
  liveEl.className = "sr-only";
  liveEl.setAttribute("role", "status");
  liveEl.setAttribute("aria-live", "polite");
  document.body.appendChild(liveEl);
  return liveEl;
}

/// Say something once. `assertive` interrupts — reserve it for failures the
/// user needs before their next action.
export function announce(message, assertive = false) {
  const region = liveRegion();
  region.setAttribute("aria-live", assertive ? "assertive" : "polite");
  // Re-setting identical text is a no-op to a screen reader, so clear first —
  // two failures in a row must both be heard.
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = String(message);
  });
}

/// Mark an element that updates in place as a live region. Used for the status
/// readouts that change on their own: the editor's saved/editing status line.
export function asStatus(el, assertive = false) {
  if (!el) return;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", assertive ? "assertive" : "polite");
  el.setAttribute("aria-atomic", "true");
}
