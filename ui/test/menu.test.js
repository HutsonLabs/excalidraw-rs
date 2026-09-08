// The menu, which is now the only way to reach a file.
//
// New / Open / Save / Save As were reachable by keyboard and by nothing else
// for as long as the app has existed — ⌘N and ⌘O with no menu bar to discover
// them from. Then the titlebar's row of eleven icons became one button and
// this became the whole of the app's visible file handling. A menu entry that
// silently stopped rendering, or one whose `run` stopped being wired, would be
// indistinguishable from a feature that was never built.
//
// Driven against ui/test/support/harness.js's DOM the same way the contract
// suite is, and for the same reason: no dev dependencies, and the questions
// here are counting questions — is the row there, does it run, does the
// listener come back off.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeNode, installDom, uninstallDom, leakedListeners } from "./support/harness.js";
import { installMenu } from "../standalone/menu.js";

beforeEach(() => installDom());
afterEach(uninstallDom);

/// The app's own entries, in the shape shell.js builds them.
const FILE_ACTIONS = (ran) => [
  { id: "app-new", group: "file", name: "New", shortcut: "⌘N", title: "Start an empty drawing", run: () => ran.push("new") },
  { id: "app-open", group: "file", name: "Open…", shortcut: "⌘O", title: "Open an .excalidraw file", run: () => ran.push("open") },
  { id: "app-save", group: "file", name: "Save", shortcut: "⌘S", run: () => ran.push("save") },
  { id: "app-save-as", group: "file", name: "Save As…", shortcut: "⇧⌘S", run: () => ran.push("saveAs") },
];

const open = (host) => {
  const button = host.children.find((c) => c.tagName === "BUTTON");
  button.dispatch("click", {});
  return button;
};

/// The popover goes into document.body, not into the host: it is positioned
/// against the window so a 52px titlebar cannot clip it.
const popover = () => globalThis.document.body.children.find((c) => c.className === "menu-pop");

const rowsOf = (pop) => pop.children.filter((c) => c.className === "menu-item");
const labelOf = (row) => row.children.find((c) => c.className === "menu-label")?.textContent;
const keyOf = (row) => row.children.find((c) => c.className === "menu-key")?.textContent;
const sections = (pop) =>
  pop.children.filter((c) => c.className === "menu-section").map((c) => c.textContent);

test("the file commands are all in the menu, with their shortcuts", () => {
  const ran = [];
  const host = new FakeNode("div");
  const menu = installMenu(host, { actions: () => FILE_ACTIONS(ran) });

  // Closed to start: a menu that is already open on launch is a menu covering
  // the drawing.
  expect(popover()).toBeUndefined();

  open(host);
  const pop = popover();
  expect(pop).toBeDefined();
  expect(rowsOf(pop).map(labelOf)).toEqual(["New", "Open…", "Save", "Save As…"]);
  expect(rowsOf(pop).map(keyOf)).toEqual(["⌘N", "⌘O", "⌘S", "⇧⌘S"]);

  menu.dispose();
});

test("choosing an entry runs it and puts the menu away", () => {
  const ran = [];
  const host = new FakeNode("div");
  const menu = installMenu(host, { actions: () => FILE_ACTIONS(ran) });

  open(host);
  rowsOf(popover()).find((r) => labelOf(r) === "Open…").dispatch("click", {});

  expect(ran).toEqual(["open"]);
  // Gone before the dialog it opened has a chance to appear behind it.
  expect(popover()).toBeUndefined();

  menu.dispose();
});

test("the menu describes the document as it is when it opens", () => {
  // Undo is greyed until there is something to undo, and the menu is built on
  // open rather than at install — a stale Undo is a menu that lies about the
  // document, which is worse than one that is a frame behind.
  let canUndo = false;
  const host = new FakeNode("div");
  const menu = installMenu(host, {
    actions: () => [
      { id: "xd-undo", group: "edit", name: "Undo", shortcut: "⌘Z", run: () => {}, disabled: !canUndo },
    ],
  });

  open(host);
  expect(rowsOf(popover())[0].disabled).toBe(true);
  open(host); // closes

  canUndo = true;
  open(host);
  expect(rowsOf(popover())[0].disabled).toBe(false);

  menu.dispose();
});

test("a descriptor with no name is not a menu entry", () => {
  // The opt-in from viewActions.js's header: the view offers "Save now" for a
  // pane header, and the app leaves it out because its own File section has a
  // Save that also knows what to do when there is no path yet.
  const host = new FakeNode("div");
  const menu = installMenu(host, {
    actions: () => [
      { id: "xd-save", icon: "save", title: "Save now (⌘S)", run: () => {} },
      { id: "xd-zoom", kind: "status", text: "100%" },
      { id: "app-new", group: "file", name: "New", run: () => {} },
    ],
  });

  open(host);
  expect(rowsOf(popover()).map(labelOf)).toEqual(["New"]);

  menu.dispose();
});

test("entries are sorted into sections, in the menu's own order", () => {
  const host = new FakeNode("div");
  const menu = installMenu(host, {
    actions: () => [
      { id: "a", group: "export", name: "PNG…", run: () => {} },
      { id: "b", group: "file", name: "New", run: () => {} },
      { id: "c", group: "view", name: "Fit to view", run: () => {} },
      // A group the menu has never heard of lands under Other rather than
      // vanishing — a misfiled entry is a bug report, a missing one is not.
      { id: "d", group: "wat", name: "Mystery", run: () => {} },
    ],
  });

  open(host);
  const pop = popover();
  expect(sections(pop)).toEqual(["File", "View", "Export", "Other"]);
  expect(rowsOf(pop).map(labelOf)).toEqual(["New", "Fit to view", "PNG…", "Mystery"]);
  // Appearance is last and is a control rather than a section of rows, so it
  // is a row of its own with the segmented switch in it.
  const appearance = pop.children.at(-1);
  expect(appearance.className).toBe("menu-appearance");

  menu.dispose();
});

test("a press anywhere else closes it", () => {
  const host = new FakeNode("div");
  const menu = installMenu(host, { actions: () => FILE_ACTIONS([]) });
  open(host);
  expect(popover()).toBeDefined();

  globalThis.document.dispatch("pointerdown", { target: new FakeNode("canvas") });
  expect(popover()).toBeUndefined();

  menu.dispose();
});

test("dispose takes every listener with it", () => {
  const host = new FakeNode("div");
  const menu = installMenu(host, { actions: () => FILE_ACTIONS([]) });
  open(host);
  menu.dispose();

  // Including the one on `document` and the one on `window`, which are the two
  // that outlive their own DOM if they are forgotten.
  expect(leakedListeners()).toEqual([]);
  expect(popover()).toBeUndefined();
  expect(host.children).toHaveLength(0);
});
