// The tool state machine: pointer and key events in, intents out.
//
// This is a separate file for one reason, and it is worth stating plainly
// because it is the reason to keep putting things *here* rather than in
// excalidrawEdit.js: nothing in this module touches the DOM or the document,
// so it is the one part of the editor that can be unit-tested without a canvas
// and without wasm. Every decision that can live here should — which tool is
// active, what a pointerdown at a given position with given modifiers *means*,
// how far a drag has to go before it is a drag, whether shift constrains or
// extends in this context.
//
// The division of labour that falls out of that:
//
//   excalidrawEdit.js   asks the document what is under the pointer, hands the
//                       answer here, gets an intent back, and does it.
//   this file           decides. It is handed a `probe` — the answers, already
//                       fetched — rather than a document, because a module
//                       that can ask questions is a module a test has to build
//                       a document for.
//
// So `excalidrawEdit.js` reads as: get intent, call the document, repaint.
//
// The shortcuts are Excalidraw's own, including that a number key picks a
// tool. That is not a small thing to match: a hand that has used Excalidraw
// already knows this keyboard, and a nearly-right keyboard is worse than an
// unfamiliar one because the mistakes are silent.

import { HANDLE, HANDLE_CURSOR, REORDER } from "./xdWasm.js";

/// The tools, in Excalidraw's own order and with Excalidraw's own keys.
///
/// `shape` is what `beginDraft` is called with, and its absence is what marks
/// a tool that draws nothing. `label` is what the pane header says is active —
/// with no toolbar of its own, that readout is the only thing telling the user
/// which tool a keystroke just selected.
///
/// `alias` is a second letter for the same tool. Excalidraw's freedraw is
/// `letterKey: [KEYS.P, KEYS.X]` and both spellings are in the wild — P for
/// "pencil" and X for the position it holds on the toolbar — so a hand that
/// learned either one has to find the same tool here.
export const TOOLS = Object.freeze([
  { id: "select", key: "v", digit: "1", label: "Select", cursor: "default", shape: null },
  { id: "rectangle", key: "r", digit: "2", label: "Rectangle", cursor: "crosshair", shape: "rectangle" },
  { id: "diamond", key: "d", digit: "3", label: "Diamond", cursor: "crosshair", shape: "diamond" },
  { id: "ellipse", key: "o", digit: "4", label: "Ellipse", cursor: "crosshair", shape: "ellipse" },
  { id: "arrow", key: "a", digit: "5", label: "Arrow", cursor: "crosshair", shape: "arrow" },
  { id: "line", key: "l", digit: "6", label: "Line", cursor: "crosshair", shape: "line" },
  { id: "freedraw", key: "p", alias: "x", digit: "7", label: "Draw", cursor: "crosshair", shape: "freedraw" },
  { id: "text", key: "t", digit: "8", label: "Text", cursor: "text", shape: "text" },
  // No letter key, because Excalidraw's image tool has none — 9 is the whole of
  // it. `shape: null` for the same reason the eraser has none: an image is not
  // dragged out, it is placed, and the bytes arrive from a file picker rather
  // than from the pointer.
  { id: "image", key: "", digit: "9", label: "Image", cursor: "crosshair", shape: null },
  // The eraser draws nothing and inserts nothing: it sweeps, and what it
  // touches goes. `shape: null` is what says so, the same way the hand tool
  // says it.
  { id: "eraser", key: "e", digit: "0", label: "Eraser", cursor: "crosshair", shape: null },
  { id: "hand", key: "h", digit: "", label: "Hand", cursor: "grab", shape: null },
]);

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

/// How far the pointer must travel, in *screen* pixels, before a press on a
/// shape becomes a drag of it.
///
/// Screen rather than scene: the hand's wobble is a property of the hand, not
/// of the zoom, and a threshold in scene units would be unreachable at 8×
/// (every click a drag) and immovable at 5% (no drag ever starts). Three
/// pixels is about the slop in a click on a trackpad.
export const DRAG_THRESHOLD = 3;

/// The smallest a dragged-out shape may be before `endDraft` throws it away.
/// A click with the rectangle tool selected is a click, not a zero-by-zero
/// rectangle the user cannot see and cannot select to delete.
export const MIN_DRAW_SIZE = 2;

/// Rotation snaps to 15° with shift held — Excalidraw's own step, and the one
/// that makes 45° and 90° reachable without care. `rotateTo` wants radians.
export const ROTATE_SNAP = (15 * Math.PI) / 180;

/// How far an arrow key moves the selection, and how far with shift.
export const NUDGE = 1;
export const NUDGE_FAST = 10;

/// Stroke slop for hit-testing, in *screen* pixels. A one-pixel line is not a
/// one-pixel target; this is the width of the invisible band around a stroke
/// that still counts as touching it. The caller divides by the zoom.
export const HIT_SLOP = 10;

/// How many handle radii wide a selection has to be before its handles are
/// treated as grabbable from *inside* it.
///
/// The handle ring is measured in screen pixels and the box is not, so zooming
/// out shrinks the box while the ring stays put: at 50% zoom the grab radius is
/// 16 scene units, and a 25-unit-tall text element sits entirely inside its own
/// north and south handles. The second press of a double-click then reads as a
/// resize, and one pixel of jitter rescales the font — see
/// docs/audit/audit-text.md item 8. Three radii is the point at which the ring
/// has a body left in the middle of it to click on.
const HANDLE_COLLAPSE_RADII = 3;

/// True when a selection is too small at this zoom for its own handles to be
/// distinguishable from its body. `box` is a `{ minX, minY, maxX, maxY }` in
/// scene units and `radius` is the grab radius in the same units.
///
/// Both arguments are optional, and absent means "no": a caller that has not
/// measured anything gets the plain handle-beats-shape rule, which is the one
/// every test written before this stated.
export function handlesCollapsed(box, radius) {
  if (!box || !(radius > 0)) return false;
  const limit = radius * HANDLE_COLLAPSE_RADII;
  return (box.maxX - box.minX) < limit || (box.maxY - box.minY) < limit;
}

/// A fresh tool state. Not a class: it is three fields and a couple of pure
/// functions over them, and a class would be an object pretending it has
/// invariants to defend.
///
///   `tool`    the active tool's id
///   `locked`  Q — stay on this tool after drawing instead of snapping back
///   `space`   the space bar is down, so every drag is a pan
export function newToolState() {
  return { tool: "select", locked: false, space: false };
}

/// The tool a key selects, or null. Both spellings — the letter and the digit
/// — because Excalidraw has both and people's hands have picked one.
export function toolForKey(key) {
  const k = String(key ?? "").toLowerCase();
  if (k.length !== 1) return null;
  const hit = TOOLS.find((t) => t.key === k || t.alias === k || t.digit === k);
  return hit ? hit.id : null;
}

/// What the header says is active. The lock is a suffix rather than a separate
/// readout: it is a property of the tool, and two adjacent status pills saying
/// "Rectangle" and "locked" read as two unrelated facts.
export function toolLabel(state) {
  const tool = BY_ID.get(state?.tool) ?? TOOLS[0];
  return state?.locked ? `${tool.label} (locked)` : tool.label;
}

/// The tool to return to after a shape is drawn.
///
/// Excalidraw snaps back to select, which is right: the overwhelmingly common
/// next thing after drawing a box is to move or resize it. Q locks the tool
/// for the case where it is wrong — drawing twenty boxes in a row.
export function afterDraw(state) {
  return state?.locked ? state.tool : "select";
}

/// True once a press has travelled far enough to be a drag. Both deltas are in
/// screen pixels.
export const passedThreshold = (dx, dy) => Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;

/// True when the platform's "command" modifier is held. ⌘ on a Mac, Ctrl
/// everywhere else, and accepting both rather than sniffing the platform —
/// a webview reporting the wrong platform is a whole class of bug, and no
/// shortcut here means two different things under the two keys.
export const mod = (ev) => !!(ev?.metaKey || ev?.ctrlKey);

// --- the pointer -------------------------------------------------------------

/// What a pointerdown means.
///
/// `probe` is what the caller has *already* asked the document, so this
/// function needs no document of its own:
///
///   `point`        the linear point handle under the pointer, or -1
///   `midpoint`     the segment midpoint handle under the pointer, or -1
///   `handle`       the resize/rotate handle under the pointer, or -1
///   `hit`          the topmost element index under the pointer, or -1
///   `hitSelected`  whether that element is already in the selection
///   `hitType`      that element's `type`, or ""
///   `box`          the selection's bounds, in scene units, or null
///   `handleRadius` the handle grab radius, in scene units
///
/// The last three are only read by the collapsed-handle rule below; a caller
/// that does not measure them gets the behaviour that predates it.
///
/// Returns one of the intents below, or null for a press this editor has no
/// opinion about (the right button, which belongs to the context menu).
///
///   { kind: "pan" }                          drag the camera
///   { kind: "rotate" }                       drag the rotate handle
///   { kind: "resize", handle }               drag a resize handle
///   { kind: "move", index, extend }          select and drag elements
///   { kind: "marquee", extend, contain }     sweep a rubber band
///   { kind: "draw", shape }                  drag out a new shape
///   { kind: "freedraw" }                     start a pencil stroke
///   { kind: "text" }                         place a text element
///   { kind: "editText", index }              type into the text that is there
///   { kind: "erase" }                        sweep elements away
///   { kind: "point", index }                 drag one point of a line or arrow
///   { kind: "addPoint", index }              split a segment and drag the new point
///   { kind: "image" }                        place an image here
///
/// The ordering of the tests is the whole behaviour, and it is deliberate: a
/// pan wins over everything (space and the middle button are how you get out
/// of any state), then *point* handles, then box handles, then elements, then
/// empty canvas. A handle beats the element it belongs to, or a small selected
/// shape would be impossible to resize — every grab would land on the shape and
/// move it.
///
/// Point handles beating box handles is the load-bearing part of that order. On
/// a diagonal arrow the two endpoints sit exactly on opposite corners of the
/// bounding box, so the tie is not a rare case — it is every diagonal arrow, and
/// a box handle winning it is how dragging an endpoint silently becomes a scale.
export function pointerIntent(state, ev, probe = {}) {
  const button = ev?.button ?? 0;
  // The middle button pans in every canvas application there has ever been.
  if (button === 1) return { kind: "pan" };
  if (button !== 0) return null;
  if (state?.space || state?.tool === "hand") return { kind: "pan" };

  const tool = BY_ID.get(state?.tool) ?? TOOLS[0];

  if (tool.id === "select") {
    // A point of the selected line or arrow, before anything else looks. See the
    // note above about the diagonal-arrow tie.
    const point = probe.point ?? -1;
    if (point >= 0) return { kind: "point", index: point };
    const midpoint = probe.midpoint ?? -1;
    if (midpoint >= 0) return { kind: "addPoint", index: midpoint };

    const handle = probe.handle ?? -1;
    const hit = probe.hit ?? -1;
    // The one exception to handle-beats-shape: when the ring has closed over
    // the body (see HANDLE_COLLAPSE_RADII) a press *on the body* moves, so
    // that double-clicking a small element while zoomed out reaches its text
    // instead of rescaling it. A handle grabbed outside the body still
    // resizes, which is what keeps a small shape resizable at all.
    if (handle >= 0
      && !(hit >= 0 && probe.hitSelected && handlesCollapsed(probe.box, probe.handleRadius))) {
      return handle === HANDLE.ROTATE ? { kind: "rotate" } : { kind: "resize", handle };
    }
    if (hit >= 0) return { kind: "move", index: hit, extend: !!ev?.shiftKey, selected: !!probe.hitSelected };
    // Shift on empty canvas adds to the selection rather than replacing it —
    // the same meaning shift has on a shape, which is the only way the
    // modifier stays learnable. Alt narrows the band to what it *encloses*
    // rather than what it crosses, which is the mode xd-core has always
    // supported and nothing ever asked for.
    return { kind: "marquee", extend: !!ev?.shiftKey, contain: !!ev?.altKey };
  }

  if (tool.id === "text") {
    // Clicking text that is already there types into it. Without this the text
    // tool stacks a second element on top of the first, which reads as "my
    // text got duplicated and now I cannot edit either copy".
    //
    // TODO(labels): a *shape* under the pointer should bind a label to it
    // rather than drop a free text element over it, the way double-clicking
    // one already does — `editLabel` in excalidrawEdit.js is the whole of it,
    // and this is the one route that does not reach it.
    const hit = probe.hit ?? -1;
    if (hit >= 0 && probe.hitType === "text") return { kind: "editText", index: hit };
    return { kind: "text" };
  }
  if (tool.id === "eraser") return { kind: "erase" };
  // The click says *where*; the file picker it opens says *what*. Excalidraw
  // asks in the other order — picker first, then a click to place — and this way
  // round is one less state to be in for the same two decisions.
  if (tool.id === "image") return { kind: "image" };
  if (tool.id === "freedraw") return { kind: "freedraw" };
  if (tool.shape) return { kind: "draw", shape: tool.shape };
  return null;
}

/// The cursor for where the pointer currently is.
///
/// Hover feedback is the cheapest thing an editor does to say what a click
/// will do, and the one users read without knowing they are reading it. The
/// handle cursors come from xdWasm.js so the arrow points along the axis the
/// handle actually resizes.
export function cursorFor(state, probe = {}, dragging = false) {
  if (state?.space || state?.tool === "hand") return dragging ? "grabbing" : "grab";
  const tool = BY_ID.get(state?.tool) ?? TOOLS[0];
  if (tool.id !== "select") return tool.cursor;
  // Same order as `pointerIntent`, or the cursor describes a gesture the press
  // will not make.
  if ((probe.point ?? -1) >= 0 || (probe.midpoint ?? -1) >= 0) return "move";
  const handle = probe.handle ?? -1;
  const hit = probe.hit ?? -1;
  // The same exception `pointerIntent` makes, or the cursor promises a resize
  // and the click moves — which is worse than either behaviour on its own.
  if (handle >= 0
    && !(hit >= 0 && probe.hitSelected && handlesCollapsed(probe.box, probe.handleRadius))) {
    return HANDLE_CURSOR[handle] ?? "default";
  }
  return hit >= 0 ? "move" : "default";
}

/// The pressure to record for a pointer sample.
///
/// A mouse reports 0.5 while a button is down and 0 otherwise; a pen reports
/// what the nib is doing. Both are useful and only one of them is real, which
/// is why `simulatePressure` exists in the format — see `drawStyle` below.
export function pressureOf(ev) {
  const p = ev?.pressure;
  return typeof p === "number" && p > 0 ? p : 0.5;
}

/// True when the device is reporting real pressure rather than a constant.
///
/// Excalidraw writes `simulatePressure: false` for a pen and true for a mouse,
/// and perfect-freehand reads it: with simulation on it *invents* a pressure
/// profile from the stroke's speed and ignores the recorded numbers, which is
/// what makes a mouse stroke look hand-drawn instead of like a constant-width
/// tube. Recording a pen's real pressures and then telling the renderer to
/// ignore them would throw away the only reason to have a pen.
export const isPressureDevice = (ev) => ev?.pointerType === "pen";

// --- the keyboard ------------------------------------------------------------

/// What a keydown means, or null for one this editor does not claim.
///
/// Returning null matters as much as returning an intent: a key we do not
/// claim must reach the browser, or ⌘R stops reloading and ⌘Q stops quitting.
/// The caller calls `preventDefault` exactly when this returns something.
///
///   { kind: "tool", tool }
///   { kind: "lock" }                        Q — keep the tool after drawing
///   { kind: "escape" }
///   { kind: "delete" }
///   { kind: "nudge", dx, dy }
///   { kind: "selectAll" } { kind: "duplicate" }
///   { kind: "undo" } { kind: "redo" }
///   { kind: "reorder", how }
///   { kind: "group" } { kind: "ungroup" }
///   { kind: "zoom", factor } { kind: "zoomReset" }
///   { kind: "zoomFit" } { kind: "zoomSelection" }
///   { kind: "toggleLock" }                  ⌘⇧L — lock or unlock the selection
///   { kind: "flip", axis }                  ⇧H / ⇧V
///   { kind: "grid" }                        ⌘' — the grid, on or off
///   { kind: "help" }                        ? — the shortcut sheet
///   { kind: "save" }
///   { kind: "edit" }                        Enter — type into what is selected
///
/// Copy, cut and paste are absent on purpose. They arrive as `copy`/`cut`/
/// `paste` events with a `clipboardData` on them, which is the only way to
/// read the clipboard without asking for a permission — and the events fire
/// for the menu bar and the context menu too, which a keydown handler would
/// miss.
export function keyIntent(ev, state) {
  const key = ev?.key ?? "";
  const cmd = mod(ev);
  const shift = !!ev?.shiftKey;

  if (key === "Escape") return { kind: "escape" };

  if (cmd) {
    const lower = key.toLowerCase();
    if (lower === "a") return { kind: "selectAll" };
    if (lower === "d") return { kind: "duplicate" };
    if (lower === "z") return shift ? { kind: "redo" } : { kind: "undo" };
    if (lower === "y") return { kind: "redo" };
    if (lower === "s") return { kind: "save" };
    if (lower === "g") return shift ? { kind: "ungroup" } : { kind: "group" };
    if (lower === "l" && shift) return { kind: "toggleLock" };
    if (key === "]") return { kind: "reorder", how: shift ? REORDER.FRONT : REORDER.FORWARD };
    if (key === "[") return { kind: "reorder", how: shift ? REORDER.BACK : REORDER.BACKWARD };
    // ⌘⌥[ and ⌘⌥] are macOS's own send-to-back / bring-to-front, and they
    // cannot be matched on `key`: Option is a compose modifier there, so
    // ⌘⌥[ arrives as "“" and never equals "[". The physical key is what the
    // shortcut is about, so the physical key is what is tested.
    if (ev?.altKey && ev?.code === "BracketRight") return { kind: "reorder", how: REORDER.FRONT };
    if (ev?.altKey && ev?.code === "BracketLeft") return { kind: "reorder", how: REORDER.BACK };
    if (key === "'") return { kind: "grid" };
    if (key === "0") return { kind: "zoomReset" };
    if (key === "=" || key === "+") return { kind: "zoom", factor: 1.2 };
    if (key === "-" || key === "_") return { kind: "zoom", factor: 1 / 1.2 };
    return null;
  }

  if (key === "Delete" || key === "Backspace") return { kind: "delete" };
  if (key === "Enter") return { kind: "edit" };

  const step = shift ? NUDGE_FAST : NUDGE;
  if (key === "ArrowLeft") return { kind: "nudge", dx: -step, dy: 0 };
  if (key === "ArrowRight") return { kind: "nudge", dx: step, dy: 0 };
  if (key === "ArrowUp") return { kind: "nudge", dx: 0, dy: -step };
  if (key === "ArrowDown") return { kind: "nudge", dx: 0, dy: step };

  // The shortcut sheet. `?` is a shifted key on every layout, so it has to be
  // claimed before the shift guard below throws shifted keys away.
  if (key === "?") return { kind: "help" };

  // ⇧1 fits and ⇧2 zooms to the selection, which is where Excalidraw puts them
  // — and it tests `event.code`, because ⇧1 arrives as "!" and not as "1".
  // ⌘0, above, is *reset to 100%*: the three were one key here, which is the
  // silent-mistake failure this module's header is about.
  if (shift && !ev?.altKey) {
    if (ev?.code === "Digit1") return { kind: "zoomFit" };
    if (ev?.code === "Digit2") return { kind: "zoomSelection" };
    // ⇧H and ⇧V flip, which is Excalidraw's pair. Unshifted, H is the hand tool;
    // shift is what tells the two apart, so these have to be claimed here rather
    // than left to the guard below.
    const lower = key.toLowerCase();
    if (lower === "h") return { kind: "flip", axis: "horizontal" };
    if (lower === "v") return { kind: "flip", axis: "vertical" };
  }

  // Shift is the extend-selection modifier everywhere else in this editor, so
  // a shifted letter is not a tool pick — it is someone holding shift from the
  // click they just made.
  if (shift || ev?.altKey) return null;
  if (key.toLowerCase() === "q") return { kind: "lock" };
  const tool = toolForKey(key);
  return tool ? { kind: "tool", tool } : null;
}

/// What a wheel event means.
///
/// A trackpad pinch arrives as ctrlKey+wheel — that is the platform's
/// convention, not ours — and a plain wheel scrolls, which is what a wheel
/// does over every other document. Both are returned in screen units; the
/// caller knows where the pointer is.
export function wheelIntent(ev) {
  if (ev?.ctrlKey || ev?.metaKey) {
    return { kind: "zoom", factor: Math.exp(-(ev.deltaY ?? 0) / 100) };
  }
  return { kind: "pan", dx: -(ev?.deltaX ?? 0), dy: -(ev?.deltaY ?? 0) };
}

/// Re-exported so `excalidrawEdit.js` has one import for everything about
/// tools, rather than reaching past this module to the boundary for the two
/// constants it needs to talk about handles and z-order.
export { HANDLE, REORDER };
