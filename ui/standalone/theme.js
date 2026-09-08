// Appearance: dark, light, or whatever the system is doing.
//
// The app is standalone/, so this file is the app's and never ports (PLAN.md
// Phase 7): term.hut themes its own panes and a view that arrived carrying a
// second appearance setting would be the bug. What the *view* gets is the
// tokens — it reads --accent, --bg and --border through chromeTheme() and has
// no idea anything switched them.
//
// Three modes, in macOS' own order and with macOS' own names: Light, Dark and
// System. "System" is the default because an app that ignores the appearance
// the user set for every other window is an app that stands out for the wrong
// reason — and because macOS switches at sunset, which is exactly when a
// drawing app being the only bright window on screen is worst.
//
// The resolved theme lives on <html data-theme>, never the preference, so the
// stylesheet has two cases instead of three and never has to ask what the
// system is doing. The preference rides along in data-theme-pref for the
// buttons to read back.

import { el, div } from "../src/dom.js";

/// Where the choice is remembered. localStorage rather than a file through the
/// Rust side: it is a window preference, it is one word long, and it has to be
/// readable synchronously by the bootstrap script in index.html before the
/// first frame or the window flashes the wrong colour on every launch.
const KEY = "xd-appearance";

/// The three modes, in the order the segmented control shows them — which is
/// System Settings' order, so a hand that has set this before knows where to
/// aim.
export const MODES = ["light", "dark", "system"];

const isMode = (v) => MODES.includes(v);

/// The stored preference, or "system" when there is nothing stored, when the
/// stored value is something we no longer understand, or when localStorage
/// itself refuses (private windows, a file:// origin with storage disabled).
export function appearance() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (isMode(v)) return v;
  } catch { /* storage unavailable; the default is not worth an error */ }
  return "system";
}

/// What "system" currently means. Dark when the system says dark *and* when it
/// says nothing at all: this is a drawing app, and a bright shell around a
/// small canvas is a lamp pointed at the user.
function systemTheme() {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/// The theme a preference resolves to right now.
export const resolveTheme = (pref) => (pref === "system" ? systemTheme() : pref);

/// Put `pref` on screen. Everything that has to agree about the colours is set
/// from this one function, so they cannot drift:
///
///   data-theme       what the stylesheet switches on (never "system")
///   data-theme-pref  what the buttons show as chosen
///   theme-color      the strip of browser/OS chrome above our own titlebar
///   the native theme so the traffic lights, the menu bar and any OS-drawn
///                    sheet match the window they are attached to
function apply(pref) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.dataset.theme = resolveTheme(pref);
  root.dataset.themePref = pref;
  paintMeta(root);
  setNativeTheme(pref);
}

/// Tint the chrome above the window to the titlebar's own colour, so there is
/// no light seam over the app's. index.html ships a static value for the first
/// frame; this keeps it honest afterwards by reading the token rather than
/// repeating its hex here, where it would go stale the first time the palette
/// is touched.
function paintMeta(root) {
  const doc = root.ownerDocument;
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const view = doc.defaultView;
  const value = view?.getComputedStyle?.(root)?.getPropertyValue("--bg-alt")?.trim();
  if (value) meta.setAttribute("content", value);
}

/// Tell macOS which appearance this window has. Null means "follow the
/// system", which is the one case we must *not* pin: pinning it would freeze
/// the traffic lights at whatever the system was when the app launched.
///
/// Every part of this is optional — a plain browser has no __TAURI__ at all,
/// and an older window API may not have setTheme — so it is a best effort with
/// nothing riding on it. The page is already the right colour by the time this
/// runs; this is only about the pixels the OS draws.
function setNativeTheme(pref) {
  try {
    const win = globalThis.window?.__TAURI__?.window?.getCurrentWindow?.();
    win?.setTheme?.(pref === "system" ? null : pref)?.catch?.(() => {});
  } catch { /* not fatal: the window is already wearing the right colours */ }
}

/// Choose a mode. Exported because the keyboard should be able to reach this
/// without going through the buttons.
export function setAppearance(pref) {
  const next = isMode(pref) ? pref : "system";
  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch { /* the choice still applies to this session */ }
  apply(next);
  return next;
}

// --- the control -------------------------------------------------------------

/// Tabler icons, inline and static, exactly as viewActions.js and the tool
/// island do it. innerHTML is allowed here for the same reason it is there:
/// nothing is interpolated.
const ICONS = {
  light:
    '<path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 12h1" />'
    + '<path d="M12 3v1" /><path d="M20 12h1" /><path d="M12 20v1" />'
    + '<path d="M5.6 5.6l.7 .7" /><path d="M18.4 5.6l-.7 .7" />'
    + '<path d="M17.7 17.7l.7 .7" /><path d="M6.3 17.7l-.7 .7" />',
  dark:
    '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />',
  system:
    '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1z" />'
    + '<path d="M7 20h10" /><path d="M9 16v4" /><path d="M15 16v4" />',
};

const svg = (body) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
  + 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path stroke="none" d="M0 0h24v24H0z" fill="none" />' + body + "</svg>";

const LABEL = { light: "Light", dark: "Dark", system: "System" };

/// Mount the appearance control into `host`.
///
///   installAppearance(host) -> dispose
///
/// A segmented control of three, which is what macOS uses for exactly this
/// choice in System Settings. A radio group and not three toggles: the modes
/// are exclusive, and a screen reader saying "Dark, radio button, 2 of 3" is
/// the whole shape of the control in one phrase.
///
/// Also installs the system-preference listener, so a window left in System
/// mode follows the Mac into the evening without being touched. That listener
/// is live in every mode — cheap, and it means the resolved theme is never
/// stale at the moment someone switches *back* to System.
export function installAppearance(host) {
  const offs = [];
  const buttons = new Map();

  if (host) {
    const group = div("appearance");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Appearance");

    for (const mode of MODES) {
      const b = el("button", "appearance-btn");
      b.type = "button";
      b.setAttribute("role", "radio");
      const name = LABEL[mode];
      b.title = mode === "system" ? "Match the system appearance" : `${name} appearance`;
      b.setAttribute("aria-label", name);
      b.innerHTML = svg(ICONS[mode]);
      const click = () => {
        setAppearance(mode);
        paint();
      };
      b.addEventListener("click", click);
      offs.push(() => b.removeEventListener("click", click));
      group.appendChild(b);
      buttons.set(mode, b);
    }
    host.appendChild(group);
    offs.push(() => group.remove());
  }

  function paint() {
    const pref = appearance();
    for (const [mode, b] of buttons) {
      const on = mode === pref;
      b.setAttribute("aria-checked", String(on));
      b.classList.toggle("on", on);
      // Roving tabindex: a radio group is one tab stop, not three.
      b.tabIndex = on ? 0 : -1;
    }
  }

  // The system changing under a window that is following it. matchMedia's
  // change event is the only signal for this; there is no CSS-only way to
  // notice, because the resolved theme lives in an attribute.
  const mq = globalThis.matchMedia?.("(prefers-color-scheme: light)");
  const onSystem = () => {
    apply(appearance());
    paint();
  };
  if (mq?.addEventListener) {
    mq.addEventListener("change", onSystem);
    offs.push(() => mq.removeEventListener("change", onSystem));
  }

  // The bootstrap script in index.html has already set data-theme from the
  // same preference; this re-applies it to pick up the two things that script
  // cannot do before the stylesheet exists — the meta colour and the native
  // window theme.
  apply(appearance());
  paint();

  return function dispose() {
    for (const off of offs) off();
    offs.length = 0;
  };
}
