// The macOS menu bar.
//
// Same descriptors as menu.js, a different place to put them — and the place is
// the point. A Mac application's verbs live in the menu bar; a popover hanging
// off a button in the titlebar is where a web application puts them because it
// has no menu bar to reach. This app has one, so the popover was the wrong
// answer to the right question, and menu.js's own header says as much about the
// row it replaced.
//
// What was actually on screen before this file existed was worse than "the
// verbs are in a popover". Tauri installs a default menu when an app sets none
// (tauri/src/menu/menu.rs:142), and that default is a plausible-looking Edit
// menu built from *predefined* items — the ones that go to the webview's own
// text editing. So ⌘Z was wired to WKWebView's undo and not to the drawing's,
// ⌘A to the page's select-all and not to the canvas's, and the app had no File
// menu at all. Every one of those is a keystroke that looks like it works.
//
// The split with menu.js: this file owns *where a Mac puts things* — which
// submenu, in which order, with which separators, and the standard items macOS
// expects to find in the application and Window menus. menu.js owns the popover
// and, once this menu is up, is left with the one control that is genuinely a
// window preference rather than a verb: Appearance. Both read the same
// descriptor list, so neither can offer a verb the other has never heard of.
//
// Nothing here is imported by anything under src/. It is the app's, like
// everything else in standalone/, and scripts/check-imports.mjs enforces it.

import { MODES, appearance, onAppearanceChange, setAppearance } from "./theme.js";

/// The modifier glyphs a descriptor's `shortcut` is written with, and the
/// modifier names `muda` parses (muda/src/accelerator.rs:533).
///
/// Descriptors print their shortcut for a human — "⇧⌘S" — because that is what
/// the key caps say and what a popover row should show. A native accelerator is
/// parsed rather than printed, so it has to be spelled out. This is the one
/// translation between the two, and it is a table rather than a regex so that a
/// glyph nobody has taught it is a shortcut that is quietly absent from the menu
/// rather than an exception that takes the whole menu bar down with it.
const MODIFIERS = {
  "⌘": "CmdOrCtrl",
  "⇧": "Shift",
  "⌥": "Alt",
  "⌃": "Control",
};

/// The key glyphs that are not their own name.
///
/// `muda` has no name for a plus sign at all — its key table stops at "EQUAL"
/// and "MINUS" (accelerator.rs:169, :196) — so ⌘+ is bound as ⌘= , which is the
/// same physical key unshifted and what every Mac app's zoom-in actually
/// listens for. ⌫ is spelled "Backspace" for the same reason: the glyph is the
/// key cap, the name is what the parser knows.
const KEYS = {
  "+": "Equal",
  "=": "Equal",
  "−": "Minus", // U+2212, the minus sign a shortcut is printed with
  "-": "Minus",
  "⌫": "Backspace",
  "⌦": "Delete",
  "⏎": "Enter",
  "⎋": "Escape",
};

/// A descriptor's printed shortcut as a `muda` accelerator, or undefined.
///
/// Undefined rather than "" for a descriptor with no shortcut, because that is
/// what `MenuItem.new` wants for "no accelerator" — an empty string is a parse
/// error, and a parse error rejects the promise that is building the menu.
export function accelerator(shortcut) {
  const s = String(shortcut ?? "").trim();
  if (!s) return undefined;
  const mods = [];
  let at = 0;
  for (; at < s.length; at++) {
    const mod = MODIFIERS[s[at]];
    if (!mod) break;
    if (!mods.includes(mod)) mods.push(mod);
  }
  const rest = s.slice(at);
  // One key, and it has to be a key this parser knows. A two-character
  // remainder is a glyph pair we have no name for, and guessing would be an
  // accelerator on the wrong key rather than a missing one.
  if (!rest || (rest.length > 1 && !KEYS[rest])) return undefined;
  return [...mods, KEYS[rest] ?? rest.toUpperCase()].join("+");
}

/// The Appearance submenu's three rows, in the segmented control's order — which
/// is System Settings' order, so a hand that has set this before knows where to
/// aim. Ids are namespaced so they cannot collide with a descriptor's.
const APPEARANCE = {
  light: { id: "app-appearance-light", text: "Light" },
  dark: { id: "app-appearance-dark", text: "Dark" },
  system: { id: "app-appearance-system", text: "System" },
};

/// Whether a native menu bar can be built at all.
///
/// False in a plain browser and on a `file://` page, which is where the popover
/// has to keep carrying everything — an app whose only Save was in a menu bar
/// that does not exist is an app you cannot save from.
export const canInstallAppMenu = () => !!globalThis.window?.__TAURI__?.menu;

/// Put the menu bar up.
///
///   await installAppMenu({ actions, appName }) -> { refresh(), dispose() } | null
///
/// `actions()` returns the current descriptor list — the view's contributions
/// and the app's, already merged, exactly as menu.js takes it. Null comes back
/// when there is no native menu to install into, and the caller reads that as
/// "keep the popover complete".
///
/// The menu is built once. What changes afterwards is which items are enabled —
/// Undo greys out when there is nothing to undo — and that is a property set on
/// a live item rather than a rebuilt menu bar: rebuilding one on every republish
/// would mean rebuilding it on every frame of a pinch, and a menu bar that is
/// being replaced is a menu bar that closes under the pointer.
export async function installAppMenu({ actions, appName = "excalidraw-rs" } = {}) {
  const api = globalThis.window?.__TAURI__?.menu;
  const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } = api ?? {};
  if (!Menu || !Submenu || !MenuItem || !CheckMenuItem || !PredefinedMenuItem) return null;

  /// The descriptors that can be a menu row: named, and with something to run.
  /// The same filter menu.js applies, and for the same reason — the view
  /// publishes status readouts (the zoom percentage, the tool name) in the same
  /// list, and a menu is not where a readout goes.
  const named = () => (actions?.() ?? []).filter((a) => a && a.name && typeof a.run === "function");
  const inGroup = (group) => named().filter((a) => (a.group ?? "other") === group);

  /// Every verb item built, by descriptor id, so `refresh` can find the one
  /// whose enabled state changed.
  const items = new Map();
  /// What each of those was last told, so a refresh that changes nothing costs
  /// nothing. `setEnabled` is an IPC round trip; the view republishes on every
  /// frame of a pinch.
  const enabled = new Map();
  const checks = new Map();

  const sep = () => PredefinedMenuItem.new({ item: "Separator" });
  const std = (item) => PredefinedMenuItem.new({ item });

  /// Run the descriptor with this id *as it is now*.
  ///
  /// By id rather than by closure because the list is rebuilt from scratch on
  /// every republish: the descriptor this item was built from is a stale object
  /// whose `run` may close over a view that has since been torn down and
  /// replaced by the next file the user opened.
  const run = (id) => {
    const a = named().find((x) => x.id === id);
    if (a && !a.disabled) a.run();
  };

  const verb = async (a) => {
    const item = await MenuItem.new({
      id: a.id,
      text: a.name,
      accelerator: accelerator(a.shortcut),
      enabled: !a.disabled,
      action: () => run(a.id),
    });
    items.set(a.id, item);
    enabled.set(a.id, !a.disabled);
    return item;
  };

  /// Every descriptor in a group, as menu items, in the order they were
  /// published. An empty group contributes nothing — not a heading with nothing
  /// under it, and not a separator with nothing on one side of it.
  const verbs = (group) => Promise.all(inGroup(group).map(verb));

  const appearanceItem = async (mode) => {
    const { id, text } = APPEARANCE[mode];
    const item = await CheckMenuItem.new({
      id,
      text,
      checked: appearance() === mode,
      // macOS ticks a check item on click before the event is sent
      // (muda/src/platform_impl/macos/mod.rs:1126), so a click always leaves it
      // ticked whatever it was. `paintAppearance` is what makes that true or
      // undoes it, and it runs for a change made anywhere.
      action: () => setAppearance(mode),
    });
    checks.set(mode, item);
    return item;
  };

  const paintAppearance = () => {
    const now = appearance();
    for (const [mode, item] of checks) item.setChecked?.(mode === now)?.catch?.(() => {});
  };

  // --- the bar ---------------------------------------------------------------
  //
  // Five submenus, in the order macOS expects them and with the items macOS
  // expects in each. The application menu and the Window menu are wholly
  // conventional and wholly predefined; File, Edit and View are the app's own
  // verbs with the conventional items around them.

  const app = await Submenu.new({
    text: appName,
    items: [
      // `{ About: null }` and not the string "About": the Rust side's About
      // carries optional metadata (tauri/src/menu/plugin.rs:92), and with none
      // muda opens the standard panel, which macOS fills in from the bundle's
      // own Info.plist. Passing metadata from here would mean a second copy of
      // the version number, in JavaScript, going stale.
      await PredefinedMenuItem.new({ item: { About: null } }),
      await sep(),
      await std("Services"),
      await sep(),
      await std("Hide"),
      await std("HideOthers"),
      await std("ShowAll"),
      await sep(),
      await std("Quit"),
    ],
  });

  const exports = await verbs("export");
  const file = await Submenu.new({
    text: "File",
    items: [
      ...await verbs("file"),
      ...(exports.length
        // A submenu rather than four more rows in File: "Export" names what the
        // choice is between, and PNG and SVG are the choice.
        ? [await sep(), await Submenu.new({ text: "Export", items: exports })]
        : []),
      await sep(),
      await std("CloseWindow"),
    ],
  });

  const edit = await Submenu.new({
    text: "Edit",
    items: [
      // The app's Undo and Redo, not the predefined pair. That substitution is
      // the whole bug: a predefined Undo goes to the webview's text editing,
      // which in a canvas application means ⌘Z did nothing to the drawing and
      // looked like it should have.
      ...await verbs("edit"),
      await sep(),
      // Cut, Copy and Paste stay predefined, and deliberately. They are the one
      // group where the native item is the *better* wiring: the responder
      // actions they invoke produce the DOM `cut`/`copy`/`paste` events the view
      // already listens for, carrying the clipboard's contents with them, where
      // a menu item calling the async clipboard API would be reading it without
      // the user gesture that permission is granted against.
      await std("Cut"),
      await std("Copy"),
      await std("Paste"),
    ],
  });

  const view = await Submenu.new({
    text: "View",
    items: [
      ...await verbs("view"),
      await sep(),
      await Submenu.new({
        text: "Appearance",
        items: await Promise.all(MODES.map(appearanceItem)),
      }),
      await sep(),
      await std("Fullscreen"),
    ],
  });

  const window = await Submenu.new({
    text: "Window",
    items: [await std("Minimize"), await std("Maximize"), await sep(), await std("BringAllToFront")],
  });
  // Hand the Window menu to macOS so it keeps the window list in it and the
  // standard items behave. Optional: an older API has no such method, and a
  // Window menu that is merely a Window menu is still a correct one.
  await window.setAsWindowsMenuForNSApp?.()?.catch?.(() => {});

  const bar = await Menu.new({ items: [app, file, edit, view, window] });
  await bar.setAsAppMenu();

  const offAppearance = onAppearanceChange(paintAppearance);
  paintAppearance();

  return {
    /// Bring the enabled states up to date. Cheap by construction: a set that
    /// matches what the item was last told is not sent.
    refresh() {
      for (const a of named()) {
        const item = items.get(a.id);
        if (!item) continue;
        const next = !a.disabled;
        if (enabled.get(a.id) === next) continue;
        enabled.set(a.id, next);
        item.setEnabled?.(next)?.catch?.(() => {});
      }
    },
    /// Only the appearance subscription. The menu bar itself is the
    /// application's for as long as it is running — there is no second one to
    /// put back, and macOS is not left holding a menu whose items are gone
    /// because nothing here is ever torn down and rebuilt.
    dispose() {
      offAppearance();
    },
  };
}
