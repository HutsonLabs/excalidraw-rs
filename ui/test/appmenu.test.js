// The macOS menu bar.
//
// Nothing here talks to macOS. What it checks is the half that can be wrong
// without anyone noticing until they are holding a Mac: which verb lands in
// which submenu, whether a printed shortcut survives the trip to an accelerator
// the Rust side will actually parse, and — the one this file exists for —
// whether Undo is the *drawing's* Undo.
//
// That last one was a real bug and an invisible one. Tauri installs a default
// menu when an app sets none, and its Edit menu is built from predefined items,
// which are the webview's own text-editing commands. So the app shipped with a
// menu bar in which ⌘Z asked WKWebView to undo some typing, ⌘A selected the
// page, and there was no File menu at all — a menu bar that looked complete and
// was wired to the wrong program.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { installDom, uninstallDom } from "./support/harness.js";
import { accelerator, canInstallAppMenu, installAppMenu } from "../standalone/appmenu.js";
import { appearance, setAppearance } from "../standalone/theme.js";

// --- a menu API that records instead of drawing -------------------------------

/// The `__TAURI__.menu` namespace, faked to the shape the real one has: every
/// constructor is `static async new(options)`, an item is a handle with `setText`
/// / `setEnabled` / `setChecked` on it, and a menu is installed by being asked
/// to become the app's.
///
/// The honesty rule from support/harness.js applies here too — the fake may be
/// incomplete but must not be easier to satisfy. So `new` is asynchronous like
/// the real one (the whole install is a chain of IPC round trips, and a bug that
/// only shows when one of them has not resolved yet is exactly the kind this
/// would otherwise hide), and `items` arrives already resolved, because the real
/// factory serialises whatever it is handed.
function fakeMenuApi() {
  const state = { appMenu: null, windowsMenuForNSApp: null, sets: [] };

  const handle = (kind, options = {}) => {
    const item = { kind, ...options };
    item.setEnabled = (value) => {
      item.enabled = value;
      state.sets.push([kind, options.id ?? options.text, "enabled", value]);
      return Promise.resolve();
    };
    item.setChecked = (value) => {
      item.checked = value;
      state.sets.push([kind, options.id ?? options.text, "checked", value]);
      return Promise.resolve();
    };
    return item;
  };

  const kind = (name) => ({ new: async (options) => handle(name, options) });

  const api = {
    MenuItem: kind("MenuItem"),
    CheckMenuItem: kind("Check"),
    PredefinedMenuItem: kind("Predefined"),
    Submenu: {
      async new(options) {
        const item = handle("Submenu", options);
        item.setAsWindowsMenuForNSApp = () => {
          state.windowsMenuForNSApp = item;
          return Promise.resolve();
        };
        return item;
      },
    },
    Menu: {
      async new(options) {
        const item = handle("Menu", options);
        item.setAsAppMenu = () => {
          state.appMenu = item;
          return Promise.resolve();
        };
        return item;
      },
    },
  };

  return { api, state };
}

/// The descriptors the shell and the view between them publish, trimmed to the
/// ones a menu can show plus two the menu must ignore.
const DESCRIPTORS = () => [
  { id: "xd-fit", name: "Fit to view", shortcut: "⇧1", group: "view", run() { ran.push("fit"); } },
  { id: "xd-out", name: "Zoom out", shortcut: "⌘−", group: "view", run() { ran.push("out"); } },
  // A readout, not a verb: no name, so no row anywhere.
  { id: "xd-zoom", kind: "status", text: "100%" },
  { id: "xd-in", name: "Zoom in", shortcut: "⌘+", group: "view", run() { ran.push("in"); } },
  { id: "xd-undo", name: "Undo", shortcut: "⌘Z", group: "edit", disabled: true, run() { ran.push("undo"); } },
  { id: "xd-redo", name: "Redo", shortcut: "⇧⌘Z", group: "edit", run() { ran.push("redo"); } },
  { id: "xd-select-all", name: "Select all", shortcut: "⌘A", group: "edit", run() { ran.push("all"); } },
  { id: "app-new", name: "New", shortcut: "⌘N", group: "file", run() { ran.push("new"); } },
  { id: "app-save", name: "Save", shortcut: "⌘S", group: "file", run() { ran.push("save"); } },
  { id: "app-export-png", name: "PNG…", group: "export", run() { ran.push("png"); } },
  // Named but with nothing to run: the view's save button is published this way
  // when there is no document, and a menu row that does nothing is worse than
  // none.
  { id: "app-broken", name: "Broken", group: "file" },
];

let ran = [];
let live = DESCRIPTORS();
let fake = null;

beforeEach(() => {
  installDom();
  ran = [];
  live = DESCRIPTORS();
  fake = fakeMenuApi();
  globalThis.window.__TAURI__ = { menu: fake.api };
});

afterEach(() => {
  uninstallDom();
});

const install = () => installAppMenu({ actions: () => live });

/// The submenu with this title, out of the installed bar.
const submenu = (title) => fake.state.appMenu.items.find((i) => i.text === title);

/// What a submenu's rows are, in order: a verb's text, a predefined item's kind,
/// a nested submenu's title with a marker.
const shapeOf = (menu) => menu.items.map((i) => {
  if (i.kind === "Submenu") return `▸${i.text}`;
  if (i.kind === "Predefined") return typeof i.item === "string" ? i.item : Object.keys(i.item)[0];
  return i.text;
});

// --- accelerators -------------------------------------------------------------

test("a printed shortcut becomes an accelerator the Rust side can parse", () => {
  // The names are muda's (accelerator.rs:151 for keys, :533 for modifiers). Every
  // one of these is a shortcut this app actually publishes.
  expect(accelerator("⌘N")).toBe("CmdOrCtrl+N");
  expect(accelerator("⌘S")).toBe("CmdOrCtrl+S");
  expect(accelerator("⇧⌘S")).toBe("Shift+CmdOrCtrl+S");
  expect(accelerator("⌘Z")).toBe("CmdOrCtrl+Z");
  expect(accelerator("⇧⌘Z")).toBe("Shift+CmdOrCtrl+Z");
  expect(accelerator("⌘0")).toBe("CmdOrCtrl+0");
  expect(accelerator("⇧1")).toBe("Shift+1");
  expect(accelerator("⌘A")).toBe("CmdOrCtrl+A");
});

test("the keys muda has no glyph for are spelled out", () => {
  // There is no "PLUS" in muda's key table, so ⌘+ binds the same physical key
  // unshifted — which is what every Mac app's zoom-in listens for anyway. The
  // minus is U+2212, the sign a shortcut is *printed* with, not a hyphen.
  expect(accelerator("⌘+")).toBe("CmdOrCtrl+Equal");
  expect(accelerator("⌘−")).toBe("CmdOrCtrl+Minus");
  expect(accelerator("⌫")).toBe("Backspace");
});

test("a shortcut nothing can parse is left off rather than guessed at", () => {
  // An unparseable accelerator does not degrade to a missing one — it rejects the
  // promise that is building the menu, and takes the whole bar with it. So the
  // doubt is resolved here, where the cost is a menu row without its shortcut
  // printed beside it.
  expect(accelerator(undefined)).toBeUndefined();
  expect(accelerator("")).toBeUndefined();
  expect(accelerator("⌘")).toBeUndefined();
  expect(accelerator("⌘⇧")).toBeUndefined();
  expect(accelerator("⌘⇧]")).toBe("CmdOrCtrl+Shift+]");
  expect(accelerator("⌘Home End")).toBeUndefined();
});

// --- installing ---------------------------------------------------------------

test("no native menu, no menu bar — and the caller is told", async () => {
  // Which is how the popover knows to keep carrying every verb. An app whose
  // only Save is in a menu bar that does not exist is an app you cannot save
  // from, and this runs in a plain browser during development.
  delete globalThis.window.__TAURI__;
  expect(canInstallAppMenu()).toBe(false);
  expect(await install()).toBe(null);

  // A namespace that is there but missing a class it needs is the same answer.
  globalThis.window.__TAURI__ = { menu: { Menu: fake.api.Menu } };
  expect(await install()).toBe(null);
});

test("the bar is the five submenus macOS expects, in macOS' order", async () => {
  await install();
  expect(fake.state.appMenu).not.toBe(null);
  expect(fake.state.appMenu.items.map((i) => i.text))
    .toEqual(["excalidraw-rs", "File", "Edit", "View", "Window"]);
});

test("File carries the app's file verbs, its exports, and Close Window", async () => {
  await install();
  expect(shapeOf(submenu("File"))).toEqual([
    "New", "Save", "Separator", "▸Export", "Separator", "CloseWindow",
  ]);
  // Export is a submenu rather than four more rows: "Export" names the choice
  // and PNG/SVG are the choice.
  const exports = submenu("File").items.find((i) => i.text === "Export");
  expect(exports.items.map((i) => i.text)).toEqual(["PNG…"]);
});

test("Undo in the Edit menu is the drawing's, not the webview's", async () => {
  // The bug this file was written for. Tauri's default Edit menu wires ⌘Z to a
  // predefined Undo — WKWebView's text-editing undo — so it did nothing to the
  // drawing while looking exactly as though it should.
  await install();
  const edit = submenu("Edit");
  expect(shapeOf(edit)).toEqual([
    "Undo", "Redo", "Select all", "Separator", "Cut", "Copy", "Paste",
  ]);
  const undo = edit.items[0];
  expect(undo.kind).toBe("MenuItem");
  expect(undo.accelerator).toBe("CmdOrCtrl+Z");
  undo.action();
  // Disabled in the descriptors, so the click is refused — the menu asks the
  // descriptor, it does not trust its own greying.
  expect(ran).toEqual([]);
  expect(undo.enabled).toBe(false);

  edit.items[2].action();
  expect(ran).toEqual(["all"]);
});

test("cut, copy and paste stay the native ones", async () => {
  // Deliberately not the app's own. The responder actions these invoke produce
  // the DOM cut/copy/paste events the view already listens for, carrying the
  // clipboard with them — where a menu item calling the async clipboard API
  // would be reading it without the user gesture permission is granted against.
  await install();
  const kinds = submenu("Edit").items.filter((i) => ["Cut", "Copy", "Paste"].includes(i.item));
  expect(kinds.map((i) => i.kind)).toEqual(["Predefined", "Predefined", "Predefined"]);
});

test("View carries the camera, the appearance and full screen", async () => {
  await install();
  expect(shapeOf(submenu("View"))).toEqual([
    "Fit to view", "Zoom out", "Zoom in", "Separator", "▸Appearance", "Separator", "Fullscreen",
  ]);
  const appearanceMenu = submenu("View").items.find((i) => i.text === "Appearance");
  expect(appearanceMenu.items.map((i) => i.text)).toEqual(["Light", "Dark", "System"]);
  expect(appearanceMenu.items.every((i) => i.kind === "Check")).toBe(true);
});

test("the application menu is wholly conventional", async () => {
  await install();
  expect(shapeOf(submenu("excalidraw-rs"))).toEqual([
    "About", "Separator", "Services", "Separator",
    "Hide", "HideOthers", "ShowAll", "Separator", "Quit",
  ]);
  // `{ About: null }` and not the string: the Rust side's About carries optional
  // metadata, and with none macOS fills the standard panel in from the bundle —
  // so the version number is not copied into JavaScript to go stale.
  const about = submenu("excalidraw-rs").items[0];
  expect(about.item).toEqual({ About: null });
});

test("macOS is handed the Window menu so it can keep the window list in it", async () => {
  await install();
  expect(fake.state.windowsMenuForNSApp).toBe(submenu("Window"));
});

test("a readout and a verb with nothing to run are not menu rows", async () => {
  await install();
  const every = fake.state.appMenu.items.flatMap((s) => shapeOf(s));
  expect(every).not.toContain("100%");
  expect(every).not.toContain("Broken");
});

// --- staying current ----------------------------------------------------------

test("a click runs the descriptor as it is now, not as it was at build time", async () => {
  // The list is rebuilt from scratch on every republish, and the view behind it
  // is torn down and replaced on every file the user opens. An item holding the
  // `run` it was built with would be calling into a view that no longer exists.
  await install();
  const save = submenu("File").items.find((i) => i.text === "Save");
  live = live.map((a) => (a.id === "app-save" ? { ...a, run() { ran.push("save-again"); } } : a));
  save.action();
  expect(ran).toEqual(["save-again"]);
});

test("refresh moves the enabled states and sends nothing else", async () => {
  const menu = await install();
  fake.state.sets.length = 0;

  // Nothing has changed, so nothing is sent: the view republishes on every frame
  // of a pinch, and each of these is an IPC round trip.
  menu.refresh();
  expect(fake.state.sets).toEqual([]);

  live = live.map((a) => (a.id === "xd-undo" ? { ...a, disabled: false } : a));
  menu.refresh();
  expect(fake.state.sets).toEqual([["MenuItem", "xd-undo", "enabled", true]]);

  fake.state.sets.length = 0;
  menu.refresh();
  expect(fake.state.sets).toEqual([]);
});

test("the appearance ticks follow the window, whichever control moved it", async () => {
  const menu = await install();
  const modes = submenu("View").items.find((i) => i.text === "Appearance").items;
  const checked = () => modes.filter((i) => i.checked).map((i) => i.text);

  // "system" with nothing stored, which is what a fresh window is.
  expect(appearance()).toBe("system");
  expect(checked()).toEqual(["System"]);

  // The segmented control in the popover, or anything else that sets it.
  setAppearance("dark");
  expect(checked()).toEqual(["Dark"]);

  // And through the menu's own item. macOS ticks a check item itself before the
  // event is sent, so the item that was clicked is already ticked whatever it
  // was — the others have to be unticked for the menu to be telling the truth.
  modes[0].action();
  expect(appearance()).toBe("light");
  expect(checked()).toEqual(["Light"]);

  menu.dispose();
  setAppearance("dark");
  expect(checked()).toEqual(["Light"]); // no longer listening
});
