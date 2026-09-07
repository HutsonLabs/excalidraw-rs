// The `.excalidraw` editor, as a portable view.
//
//   renderExcalidraw(host, text, { onSave, onActions }) -> dispose
//
// That signature is `bpmnView.js`'s, deliberately and down to the argument
// names, because term.hut already has a preview pane that speaks it and the
// whole point of PLAN.md's ordering is that Phase 8 is a copy rather than an
// unpicking. Everything that follows is shaped to fit it: an 800 ms idle
// autosave, a `worthSaving` guard in front of every write, Fit and Save
// contributed to the pane's header instead of a toolbar of our own, and a
// dispose that leaves nothing running.
//
// **This file may not know where it is.** No import from `standalone/`, no
// `invoke`, no `window.__TAURI__`, and nothing outside the `host` element it
// was handed. That is not a style rule — it is the reason the port is cheap,
// and `scripts/check-imports.mjs` fails the build on any of the three. If it
// ever fails and the fix looks like widening the allowlist, PLAN.md's risk
// list is about exactly that moment.
//
// ## How the pieces divide
//
//   xdWasm.js           the document. The *only* thing that mutates a
//                       drawing, and the only thing that knows where an
//                       element is. This file holds no model.
//   excalidrawTools.js  the decisions. What a pointerdown means, what a key
//                       means, how far a drag has to travel. No DOM, no
//                       document, so it is testable on its own.
//   excalidrawView.js   the paintbrush. Shapes and chrome, both.
//   excalidrawDoc.js    whether a serialization is safe to write, and what a
//                       new shape is styled with.
//   this file           events in, intents out of the tools, calls into the
//                       document, a repaint on the next frame. It should read
//                       as glue, and where it stops reading as glue there is
//                       usually a decision that belongs in one of the four.
//
// ## Two rules the painting obeys
//
// **Never repaint synchronously in an event handler.** Every path ends in
// `schedule()`, which coalesces to one `requestAnimationFrame`. A pointermove
// that painted inline would paint three times per frame on a fast trackpad and
// the drag would feel *slower* for it.
//
// **Never re-fetch the whole scene.** `doc.elements()` looks like it does
// that; it does not. xdWasm.js memoizes each element on `(index, version)`, so
// a frame in which one shape moved costs one serialization across the wasm
// boundary and not a hundred. The way to break that is to keep our own copy of
// the elements and let it go stale, so we keep none.
//
// ## Where the model wins
//
// Anywhere the painter and `xd-core` could disagree about a coordinate, the
// model is right. Handles are hit-tested with `doc.handleAt` and drawn from
// `doc.selectionBounds()` with no padding, so the thing you can grab and the
// thing you can see are derived from one number. The one place they measure
// differently is called out where it happens.

import rough from "../vendor/roughjs/rough.esm.js";
import { div, el } from "./dom.js";
import { openDoc } from "./xdWasm.js";
import {
  chromeTheme, drawElement, drawHandles, drawMarquee, drawSelectionOutline,
  HANDLE_SIZE,
} from "./excalidrawView.js";
import { fontString, imageDataUrl, lineHeightPx, opacityOf } from "./excalidrawScene.js";
import {
  clipboardText, drawingSource, openMessage, parseClipboard, stylePatch, styleFor,
  styleFrom, textBox, worthSaving, DEFAULT_STYLE, mergeStyle,
} from "./excalidrawDoc.js";
import {
  afterDraw, cursorFor, isPressureDevice, keyIntent, newToolState, passedThreshold,
  pointerIntent, pressureOf, toolLabel, wheelIntent, HIT_SLOP, MIN_DRAW_SIZE, ROTATE_SNAP,
} from "./excalidrawTools.js";

/// The same idle window as `bpmnView.js`, and the same one `xd-core` coalesces
/// undo entries on. A pause long enough to end an undo step is a pause long
/// enough to save, so the two feel like one app because they are timed like
/// one app.
const AUTOSAVE_MS = 800;

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

/// Where a paste lands relative to where it was copied from. Enough that the
/// copy is visibly not the original, matching `duplicateSelection`'s default.
const PASTE_OFFSET = 10;

/// Mount the editor for `text` into `host`.
///
/// `onSave(text)` persists; it may throw, and a throw is reported in the pane
/// header next to the save button rather than swallowed. `onActions(list)`
/// takes this view's contributions to that header. Both are optional — a
/// caller that passes neither gets a working editor that cannot save, which is
/// exactly what the contract test wants.
///
/// `openDocument` is the document factory, and it is here for one reason: it
/// is the seam ui/test/contract.test.js drives the whole editor through
/// against a plain-object fake. That is not a testing trick bolted on — it is
/// the thing xdWasm.js's wrapper shape was designed to allow, in its own
/// words, and having it as an argument is cheaper and more honest than a
/// module mock, which in a shared test process leaks into everyone else's
/// files. No caller in the app passes it.
///
/// Returns a dispose function. Call it twice if it is convenient; the second
/// call does nothing.
export function renderExcalidraw(host, text, { onSave, onActions, openDocument = openDoc } = {}) {
  // --- the surface ---------------------------------------------------------
  //
  // Three elements and no stylesheet. The class names match term.hut's so the
  // pane styles them on arrival, but everything load-bearing is set inline:
  // the view has to look right in a host that has never heard of it, and the
  // text overlay's font and position are per-element anyway.

  const wrap = div("xd-wrap");
  const canvas = el("canvas", "xd-canvas");
  const panelHost = div("xd-props");
  wrap.style.position = "relative";
  wrap.style.overflow = "hidden";
  wrap.style.touchAction = "none";
  wrap.style.flex = "1";
  wrap.style.minHeight = "0";
  canvas.style.display = "block";
  // The panel's container is deliberately unstyled and unpositioned. The
  // island inside it places itself absolutely with a `max-height: 100%`, and
  // "100%" resolves against the nearest *positioned* ancestor — so giving this
  // div a position of its own would make the island measure itself against a
  // zero-height box and offset it twice. Left static, it collapses to nothing
  // and the island measures against `wrap`, which is what it wants.
  wrap.appendChild(canvas);
  wrap.appendChild(panelHost);
  // Focusable, or the keyboard — which is how tools are chosen — never
  // reaches us.
  wrap.tabIndex = 0;
  host.appendChild(wrap);

  const colors = chromeTheme(wrap);

  // --- state ---------------------------------------------------------------

  /// The document, once the WASM core has loaded. Null before that and after a
  /// file that would not open, and every handler checks: the view is on screen
  /// from the first frame and the pointer does not wait for a download.
  let doc = null;
  /// Set the instant dispose runs. Nothing may paint, listen or edit after it.
  let detached = false;
  /// Set once the view is finished *including* its last save. The two are
  /// separate so a pending autosave can still land after the listeners are
  /// gone — an edit made a moment before a tab closed is an edit the user
  /// would never see again.
  let disposed = false;
  let frame = 0;
  let timer = null;

  /// What is on disk, as far as we know.
  let saved = String(text ?? "");
  let inFlight = false;
  /// What the header's save button says about itself. "" is the resting state.
  let state = "";
  let error = "";
  let zoomText = "100%";
  /// The undo/redo pair, as a two-character signature, so the header is
  /// republished when they change and not on every frame of a drag.
  let historyKey = "";
  /// The selection, as a signature, for the same reason.
  let selectionKey = "";

  const camera = { scale: 1, x: 0, y: 0 };
  const tools = newToolState();
  let style = { ...DEFAULT_STYLE };
  /// The in-flight pointer gesture, or null. One object rather than a handful
  /// of booleans: a gesture has exactly one kind at a time, and the field that
  /// says which is the field that says what pointermove does.
  let gesture = null;
  let gestureSeq = 0;
  /// The rubber band, in scene coordinates, while one is being swept.
  let marquee = null;
  /// The element index an arrow endpoint would bind to right now, or -1.
  ///
  /// Binding itself is the core's — `endDraft` binds both ends to whatever is
  /// under them, and every later move re-aims the arrow, with no call from
  /// here. What the core cannot do is *say so before it happens*, and that
  /// promise is the whole of the feature: an arrow you are about to drop on a
  /// box should have told you it was going to stick to it.
  let bindTarget = -1;
  /// The properties panel, once it loads. Optional by construction — the
  /// editor works without it, which is what lets it be written in parallel.
  let panel = null;
  /// `{ id, created }` while the text overlay is open.
  let editing = null;

  /// The `scene` argument `drawElement` wants. It reads `files` off it for
  /// image elements and nothing else, so it is refreshed when the file map
  /// could have changed rather than on every frame.
  const scene = { files: {}, appState: {} };
  const images = new Map(); // fileId -> HTMLImageElement, or null while decoding

  // --- coordinates ---------------------------------------------------------
  //
  // One pair of functions, used everywhere. Screen space is CSS pixels
  // relative to the canvas's top-left corner; scene space is the file's own
  // coordinates. Every mixed-up-units bug in a canvas editor comes from having
  // two of these.

  const localOf = (ev) => {
    const r = wrap.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  const toScene = (sx, sy) => [(sx - camera.x) / camera.scale, (sy - camera.y) / camera.scale];
  const toScreen = (x, y) => [x * camera.scale + camera.x, y * camera.scale + camera.y];
  const scenePoint = (ev) => toScene(...localOf(ev));
  const centre = () => [wrap.clientWidth / 2, wrap.clientHeight / 2];

  // --- painting ------------------------------------------------------------

  const schedule = () => {
    if (frame || detached) return;
    frame = requestAnimationFrame(paint);
  };

  function paint() {
    frame = 0;
    if (detached || !doc) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return; // laid out but not shown yet
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // The scene's own background, not the app's: a drawing authored on white
    // is unreadable composited onto a dark pane.
    ctx.fillStyle = scene.appState?.viewBackgroundColor || "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.scale, camera.scale);

    const rc = rough.canvas(canvas);
    for (const element of doc.elements()) {
      if (!element) continue;
      // The element being dragged out is a real element in the document from
      // the first pixel (see xd-wasm's `beginDraft`), so there is no separate
      // in-progress thing to draw here.
      try {
        drawElement(ctx, rc, element, scene, images);
      } catch {
        // One malformed element must not blank the whole drawing.
      }
    }
    paintChrome(ctx);
    ctx.restore();

    const pct = `${Math.round(camera.scale * 100)}%`;
    if (pct !== zoomText) {
      zoomText = pct;
      publish();
    }
  }

  /// Selection outlines, handles and the marquee.
  ///
  /// Drawn inside the scene transform but measured in screen pixels, which is
  /// what every `{ scale }` below is for: a handle that shrank as you zoomed
  /// out would be a handle you could not grab.
  function paintChrome(ctx) {
    if (marquee) drawMarquee(ctx, marquee, { scale: camera.scale, colors });

    // The shape an arrow endpoint is about to bind to. Dashed and in the guide
    // colour rather than the accent, because it is a prediction about what is
    // going to happen and not a statement about what is selected.
    if (bindTarget >= 0) {
      const box = doc.elementBounds(bindTarget);
      if (box) {
        drawSelectionOutline(ctx, box, {
          scale: camera.scale, dashed: true, padding: 6, lineWidth: 2,
          colors: { accent: colors.guide },
        });
      }
    }

    // A shape being dragged out is not a shape you are about to resize, and
    // handles around a rectangle that is still growing read as a glitch.
    if (gesture && (gesture.kind === "draw" || gesture.kind === "freedraw")) return;

    const selection = doc.selection;
    if (!selection.length) return;
    const box = doc.selectionBounds();
    if (!box) return;
    const angle = doc.selectionAngle();

    // Several elements: each one gets a thin dashed outline of its own, so it
    // is obvious *which* things are in the set, and the union box below then
    // carries the handles.
    if (selection.length > 1) {
      const each = selection.map((i) => doc.elementBounds(i)).filter(Boolean);
      drawSelectionOutline(ctx, each, { scale: camera.scale, colors, dashed: true, padding: 2 });
    }
    drawSelectionOutline(ctx, box, { scale: camera.scale, angle, colors });

    // All nine handles, with **no padding**. Padding would look slightly
    // better and would be a lie: `doc.handleAt` looks for them on the box
    // itself, and a handle drawn a few pixels away from the one you can grab
    // is the exact bug this whole boundary exists to prevent.
    //
    // The rotate handle lands in the right place for free, because both sides
    // now measure it the same way: `geometry::ROTATE_HANDLE_OFFSET_PX` and
    // this file's `ROTATE_OFFSET` are the same twenty *screen* pixels, and the
    // crate's own comment says the two are one handle. It was not always so —
    // the crate used to place it a fixed distance in scene units, which put it
    // six pixels above the box at 25% zoom and ninety-six at 400%.
    drawHandles(ctx, box, { scale: camera.scale, angle, colors, padding: 0 });
  }

  // --- the camera ----------------------------------------------------------

  /// Fit the drawing to the pane.
  ///
  /// The arithmetic is the model's, not ours. `excalidrawScene.js` still has a
  /// `fitTransform` and it is still correct, but PLAN.md Phase 2 is explicit
  /// that geometry belongs to xd-core precisely so the painter and the model
  /// cannot drift — and the editor is the place that drift would show, because
  /// it is the only thing that both fits a view and hit-tests inside it.
  const fit = () => {
    if (!doc) return;
    const t = doc.fitTransform(wrap.clientWidth, wrap.clientHeight);
    camera.scale = t.scale;
    camera.x = t.offsetX;
    camera.y = t.offsetY;
    placeOverlay();
    schedule();
  };

  /// Zoom about a point in *screen* space, so the pixel under the cursor stays
  /// under the cursor.
  const zoomAt = (factor, sx, sy) => {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, camera.scale * factor));
    const k = next / camera.scale;
    camera.x = sx - (sx - camera.x) * k;
    camera.y = sy - (sy - camera.y) * k;
    camera.scale = next;
    placeOverlay();
    schedule();
  };

  // --- the pane header -----------------------------------------------------

  /// This view's contributions to the header. Rebuilt rather than mutated:
  /// `renderActions` diffs by id, so republishing costs nothing on screen and
  /// the zoom readout can be republished on every frame of a pinch.
  ///
  /// Undo and redo are text glyphs rather than icons because viewActions.js's
  /// icon set has no undo in it, and reaching into that file to add one would
  /// be this view growing a dependency term.hut does not have.
  const publish = () => {
    if (detached) return;
    onActions?.([
      { id: "xd-fit", icon: "fit", title: "Fit the drawing to the pane (⌘0)", run: fit },
      { id: "xd-out", icon: "zoomOut", title: "Zoom out (⌘−)", run: () => zoomAt(1 / 1.2, ...centre()) },
      { id: "xd-zoom", kind: "status", text: zoomText },
      { id: "xd-in", icon: "zoomIn", title: "Zoom in (⌘+)", run: () => zoomAt(1.2, ...centre()) },
      { id: "xd-one", label: "1:1", title: "Actual size", run: () => zoomAt(1 / camera.scale, ...centre()) },
      { id: "xd-undo", label: "↶", title: "Undo (⌘Z)", run: () => history("undo"), disabled: !doc?.canUndo() },
      { id: "xd-redo", label: "↷", title: "Redo (⌘⇧Z)", run: () => history("redo"), disabled: !doc?.canRedo() },
      // Which tool is live. With no toolbar of its own this readout is the
      // only thing that says a keystroke changed the tool, and a drawing app
      // whose next click does something unexpected is an infuriating one.
      { id: "xd-tool", kind: "status", text: toolLabel(tools) },
      {
        id: "xd-save",
        icon: "save",
        title: state === "editing" ? "Save now (⌘S)" : state === "saving" ? "Saving…" : "Saved",
        run: saveNow,
        disabled: state !== "editing",
      },
      ...(error ? [{ id: "xd-error", kind: "status", text: error, tone: "err" }] : []),
    ]);
  };

  const setStatus = (next, message = "") => {
    state = next;
    error = message;
    publish();
  };

  // --- saving --------------------------------------------------------------
  //
  // The rule PLAN.md calls the highest-stakes one in the plan: a failed
  // serialize must never overwrite a real drawing. Every path to `onSave` goes
  // through `worthSaving`, and the two ways to get an empty write — a throw
  // out of `toJson`, and a document that never loaded — are both refused here
  // before it is even asked.

  const serialize = () => {
    try {
      return doc ? doc.toJson() : "";
    } catch {
      return "";
    }
  };

  const save = async () => {
    if (disposed || !onSave || inFlight || !doc) return;
    const out = serialize();
    if (!out.trim()) {
      // Nothing to write, and the file stays exactly as it was — the only safe
      // outcome. `worthSaving` would refuse this too; saying so in the header
      // is the difference between a bug and a silent one.
      setStatus("editing", "couldn't serialize the drawing");
      return;
    }
    if (!worthSaving(saved, out)) {
      setStatus("");
      return;
    }
    inFlight = true;
    setStatus("saving");
    try {
      await onSave(out);
      saved = out;
      setStatus("");
    } catch (e) {
      setStatus("editing", `save failed: ${e?.message ?? e}`);
    } finally {
      inFlight = false;
    }
  };

  const saveNow = () => {
    clearTimeout(timer);
    timer = null;
    save();
  };

  const scheduleSave = () => {
    if (disposed) return;
    setStatus("editing");
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save();
    }, AUTOSAVE_MS);
  };

  // --- reacting to the document -------------------------------------------

  /// After anything that may have changed the drawing.
  const edited = (change) => {
    if (!change) return;
    schedule();
    scheduleSave();
    syncHistory();
  };

  /// After anything that may have changed what is selected. Guarded on a
  /// signature because a marquee drag calls this on every frame and the
  /// properties panel has nothing to say about a selection that did not move.
  const reselected = () => {
    schedule();
    if (!doc) return;
    const key = doc.selection.join(",");
    if (key === selectionKey) return;
    selectionKey = key;
    panel?.refresh?.();
  };

  /// After the active tool changes. The header's readout is the obvious half;
  /// the properties panel is the other, because it takes itself off screen
  /// entirely when the select tool is live with nothing selected (see
  /// `panelShown`) and has to be told the tool moved.
  const toolChanged = () => {
    publish();
    panel?.refresh?.();
    setCursor(cursorFor(tools, {}, !!gesture));
  };

  const syncHistory = () => {
    const key = `${doc?.canUndo() ? 1 : 0}${doc?.canRedo() ? 1 : 0}`;
    if (key === historyKey) return;
    historyKey = key;
    publish();
  };

  const history = (which) => {
    if (!doc) return;
    closeOverlay(true);
    edited(which === "undo" ? doc.undo() : doc.redo());
    // Undo can bring elements back, images among them, and can restore a file
    // map entry the paint loop has never seen.
    syncFiles();
    // Undo renumbers, so the same indices can mean different elements. The
    // signature cannot tell, so it is dropped rather than trusted.
    selectionKey = "";
    reselected();
  };

  /// Re-read the file map and start decoding anything new.
  ///
  /// Called at open and after history and paste — the only three ways an image
  /// can appear that this view did not already know about. Not on every
  /// structural change: `doc.files()` builds an object across the boundary,
  /// and drawing a rectangle cannot add a file.
  function syncFiles() {
    if (!doc) return;
    try {
      scene.files = doc.files() ?? {};
      scene.appState = doc.appState() ?? {};
    } catch {
      return;
    }
    if (typeof Image === "undefined") return; // headless; nothing can decode
    for (let i = 0; i < doc.length; i++) {
      const element = doc.element(i);
      if (!element || element.type !== "image" || images.has(element.fileId)) continue;
      const url = imageDataUrl(element, scene.files);
      if (!url) continue;
      const img = new Image();
      // The slot is claimed before the decode finishes so a repaint mid-decode
      // does not queue a second one. `drawElement` draws a placeholder box for
      // a null, which is what an image that has not arrived should look like.
      images.set(element.fileId, null);
      img.src = url;
      img.decode().then(
        () => {
          if (detached) return;
          images.set(element.fileId, img);
          schedule();
        },
        () => {}, // an undecodable embed keeps its placeholder
      );
    }
  }

  /// The index of an element by id. Linear, and deliberately not cached: it is
  /// called when a text overlay closes and when a paste lands, never in a
  /// loop, and a cache of indices is a cache that goes stale on every insert.
  const indexOfId = (id) => {
    if (!doc || !id) return -1;
    for (let i = 0; i < doc.length; i++) if (doc.elementId(i) === id) return i;
    return -1;
  };

  const selectedElements = () =>
    (doc ? doc.selection : []).map((i) => doc.element(i)).filter(Boolean);

  const hasSelection = () => !!doc && doc.selection.length > 0;

  // --- the pointer ---------------------------------------------------------

  /// What the document says is under a screen point. Two integer round trips
  /// across the boundary and no allocation, which is what makes it cheap
  /// enough to run on every hover.
  ///
  /// Two screen-measured quantities go in, in different units, because the
  /// pointer is already in scene coordinates by the time it gets here: the
  /// grab radius divided by the zoom, and the zoom's reciprocal itself — which
  /// is what places the rotate handle a constant distance above the box on
  /// screen (`geometry::handle_at`). The fourth argument is harmlessly ignored
  /// by a wrapper that does not take it yet.
  const probeAt = (x, y) => {
    const hit = doc.hitTest(x, y, HIT_SLOP / camera.scale);
    return {
      handle: doc.handleAt(x, y, HANDLE_SIZE / camera.scale, 1 / camera.scale),
      hit,
      hitSelected: hit >= 0 && doc.selection.includes(hit),
    };
  };

  const setCursor = (value) => {
    if (wrap.style.cursor !== value) wrap.style.cursor = value;
  };

  const onPointerDown = (ev) => {
    if (detached || !doc) return;
    // A click anywhere on the canvas is the end of a text edit. Committing
    // before the hit test matters: the commit resizes the element, and a
    // pointerdown that tested against its old box would select the wrong
    // thing.
    closeOverlay();
    const [sx, sy] = localOf(ev);
    const [x, y] = toScene(sx, sy);
    const intent = pointerIntent(tools, ev, probeAt(x, y));
    if (!intent) return;
    ev.preventDefault?.();
    wrap.focus?.();
    try {
      wrap.setPointerCapture?.(ev.pointerId);
    } catch {
      // A synthetic event with no pointer id; the window listeners still work.
    }
    gesture = { ...intent, id: ++gestureSeq, sx, sy, ox: sx, oy: sy, x, y, lastX: x, lastY: y, moved: false };

    switch (intent.kind) {
      case "move":
        // Shift toggles; an unselected shape replaces the selection; an
        // already-selected one is left alone so a drag moves the whole set.
        if (intent.extend) doc.toggleSelection(intent.index);
        else if (!intent.selected) doc.setSelection([intent.index]);
        reselected();
        break;
      case "marquee":
        if (!intent.extend) doc.clearSelection();
        gesture.base = doc.selection;
        marquee = { minX: x, minY: y, maxX: x, maxY: y };
        reselected();
        break;
      case "draw":
        edited(doc.beginDraft(intent.shape, x, y, styleFor(intent.shape, style)));
        // The draft's own id, so `bindableAt` can be told to ignore the arrow
        // being dragged — without it every arrow binds to itself.
        gesture.draftId = doc.elementId(doc.selection[0]) ?? "";
        reselected();
        break;
      case "freedraw":
        edited(doc.beginDraft("freedraw", x, y, {
          ...styleFor("freedraw", style),
          // perfect-freehand ignores recorded pressures when this is true and
          // invents a profile from the stroke's speed instead — which is what
          // makes a mouse stroke look drawn rather than extruded. A pen has
          // real numbers and must not have them thrown away.
          simulatePressure: !isPressureDevice(ev),
        }));
        reselected();
        break;
      case "text":
        createText(x, y);
        gesture = null; // the overlay owns the keyboard now
        break;
      default:
        break;
    }
    setCursor(cursorFor(tools, {}, true));
    schedule();
  };

  const onPointerMove = (ev) => {
    if (detached || !doc) return;
    const [sx, sy] = localOf(ev);
    if (!gesture) {
      const [x, y] = toScene(sx, sy);
      setCursor(cursorFor(tools, probeAt(x, y), false));
      return;
    }
    const [x, y] = toScene(sx, sy);

    switch (gesture.kind) {
      case "pan":
        camera.x += sx - gesture.sx;
        camera.y += sy - gesture.sy;
        gesture.sx = sx;
        gesture.sy = sy;
        schedule();
        break;

      case "move": {
        // The threshold is only on a move, and only on the first one. A press
        // that wobbles three pixels is a click; a resize or a draw that
        // wobbles three pixels is a resize or a draw, and making those wait
        // would make the shape lag the pointer at the start of every gesture.
        if (!gesture.moved && !passedThreshold(sx - gesture.ox, sy - gesture.oy)) break;
        gesture.moved = true;
        edited(doc.dragBy(x - gesture.lastX, y - gesture.lastY, `drag:${gesture.id}`));
        gesture.lastX = x;
        gesture.lastY = y;
        break;
      }

      case "resize":
        // Absolute, not incremental: the handle follows the pointer exactly,
        // so a resize cannot drift away from the cursor over a long drag.
        // Shift locks the aspect ratio, alt resizes about the centre.
        edited(doc.resizeTo(gesture.handle, x, y, ev.shiftKey, ev.altKey, `resize:${gesture.id}`));
        break;

      case "rotate":
        edited(doc.rotateTo(x, y, ev.shiftKey ? ROTATE_SNAP : 0, `rotate:${gesture.id}`));
        break;

      case "marquee": {
        marquee = { minX: gesture.x, minY: gesture.y, maxX: x, maxY: y };
        const swept = doc.marquee(gesture.x, gesture.y, x, y, false);
        doc.setSelection(gesture.base.length ? [...new Set([...gesture.base, ...swept])] : swept);
        reselected();
        break;
      }

      case "draw":
        edited(doc.draftTo(x, y, ev.shiftKey));
        // Only for arrows: a rectangle dragged over a box binds to nothing, so
        // highlighting one would be a promise the core is not going to keep.
        if (gesture.shape === "arrow") bindTarget = doc.bindableAt(x, y, gesture.draftId);
        break;

      case "freedraw":
        // Coalesced events are the samples the browser collected between two
        // frames. On a trackpad that is the difference between a stroke and a
        // polygon, and asking for them costs nothing when there are none.
        for (const sample of coalesced(ev)) {
          const [px, py] = toScene(...localOf(sample));
          edited(doc.draftPoint(px, py, pressureOf(sample)));
        }
        break;

      default:
        break;
    }
  };

  const onPointerUp = (ev) => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    try {
      wrap.releasePointerCapture?.(ev.pointerId);
    } catch {
      // Never captured; nothing to release.
    }
    bindTarget = -1;
    if (doc) {
      switch (g.kind) {
        case "draw":
        case "freedraw":
          edited(doc.endDraft(g.kind === "freedraw" ? 0 : MIN_DRAW_SIZE));
          tools.tool = afterDraw(tools);
          selectionKey = ""; // endDraft may have dropped the draft entirely
          reselected();
          toolChanged();
          break;
        case "marquee":
          marquee = null;
          reselected();
          break;
        case "move":
          // A click — not a drag — on a shape that was already part of a
          // multi-selection narrows to it. Without this there is no way to
          // pick one shape out of a group you have just swept up except by
          // clicking somewhere empty first.
          if (!g.moved && !g.extend && doc.selection.length > 1) {
            doc.setSelection([g.index]);
            reselected();
          }
          break;
        default:
          break;
      }
      // A pointercancel carries no position; the cursor is left as it was
      // rather than probed against NaN.
      if (Number.isFinite(ev?.clientX)) {
        const [x, y] = scenePoint(ev);
        setCursor(cursorFor(tools, probeAt(x, y), false));
      }
    }
    schedule();
  };

  /// The samples between this frame and the last, or just this one.
  const coalesced = (ev) => {
    const list = ev.getCoalescedEvents?.();
    return list && list.length ? list : [ev];
  };

  const onWheel = (ev) => {
    if (detached) return;
    ev.preventDefault?.();
    const intent = wheelIntent(ev);
    if (intent.kind === "zoom") {
      const [sx, sy] = localOf(ev);
      zoomAt(intent.factor, sx, sy);
      return;
    }
    camera.x += intent.dx;
    camera.y += intent.dy;
    placeOverlay();
    schedule();
  };

  const onDoubleClick = (ev) => {
    if (detached || !doc) return;
    ev.preventDefault?.();
    const [x, y] = scenePoint(ev);
    const hit = doc.hitTest(x, y, HIT_SLOP / camera.scale);
    const element = hit >= 0 ? doc.element(hit) : null;
    if (element?.type === "text") {
      doc.setSelection([hit]);
      reselected();
      openOverlay(element, false);
      return;
    }
    if (hit < 0) createText(x, y);
  };

  // --- the keyboard --------------------------------------------------------

  const onKeyDown = (ev) => {
    if (detached || !doc) return;
    // Space is a modifier, not a command: held down it turns every drag into a
    // pan, which is how you get out of any tool without leaving it.
    if (ev.key === " " || ev.code === "Space") {
      if (!tools.space) {
        tools.space = true;
        setCursor(cursorFor(tools, {}, !!gesture));
      }
      ev.preventDefault();
      return;
    }
    const intent = keyIntent(ev, tools);
    if (!intent) return;
    ev.preventDefault();

    switch (intent.kind) {
      case "tool":
        tools.tool = intent.tool;
        toolChanged();
        break;
      case "lock":
        tools.locked = !tools.locked;
        publish();
        break;
      case "escape":
        doc.clearSelection();
        tools.tool = "select";
        marquee = null;
        reselected();
        toolChanged();
        break;
      case "delete":
        edited(doc.deleteSelection());
        reselected();
        break;
      case "nudge":
        // One undo entry per burst of arrow keys, the same way a drag is one
        // entry: the coalesce key is constant, and xd-core's 800 ms window
        // closes it when the fingers stop.
        edited(doc.dragBy(intent.dx, intent.dy, "nudge"));
        break;
      case "selectAll":
        doc.selectAll();
        reselected();
        break;
      case "duplicate":
        edited(doc.duplicateSelection(PASTE_OFFSET, PASTE_OFFSET));
        selectionKey = "";
        reselected();
        break;
      case "undo":
      case "redo":
        history(intent.kind);
        break;
      case "reorder":
        edited(doc.reorder(intent.how));
        break;
      case "group":
        edited(doc.group());
        break;
      case "ungroup":
        edited(doc.ungroup());
        break;
      case "zoom":
        zoomAt(intent.factor, ...centre());
        break;
      case "zoomReset":
        fit();
        break;
      case "save":
        saveNow();
        break;
      case "edit": {
        // Enter types into the selected text element, which is the one thing
        // Enter could sensibly mean with a shape selected and is what
        // Excalidraw does.
        const index = doc.selection[0];
        const element = index == null ? null : doc.element(index);
        if (element?.type === "text") openOverlay(element, false);
        break;
      }
      default:
        break;
    }
  };

  const onKeyUp = (ev) => {
    if (ev.key === " " || ev.code === "Space") {
      tools.space = false;
      setCursor(cursorFor(tools, {}, false));
    }
  };

  /// Alt-tabbing away with space held would otherwise leave the editor
  /// convinced the space bar is still down, because the keyup lands in another
  /// window. The listener is on `window` and is one of the things dispose has
  /// to remember.
  const onBlur = () => {
    tools.space = false;
    if (gesture) {
      gesture = null;
      marquee = null;
      schedule();
    }
    setCursor(cursorFor(tools, {}, false));
  };

  // --- the clipboard -------------------------------------------------------
  //
  // Clipboard *events*, not `navigator.clipboard`: the event carries the data
  // synchronously and needs no permission prompt, and it fires for the menu
  // bar and the context menu as well as for the keystroke. `keyIntent`
  // deliberately does not claim ⌘C/⌘X/⌘V for that reason.

  const onCopy = (ev) => {
    if (detached || !doc || editing) return;
    const elements = selectedElements();
    if (!elements.length) return;
    ev.preventDefault();
    ev.clipboardData?.setData("text/plain", clipboardText(elements));
  };

  const onCut = (ev) => {
    if (detached || !doc || editing) return;
    if (!doc.selection.length) return;
    onCopy(ev);
    edited(doc.deleteSelection());
    reselected();
  };

  const onPaste = (ev) => {
    if (detached || !doc || editing) return;
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    ev.preventDefault();
    const payload = parseClipboard(text);
    if (payload) {
      pasteElements(payload.elements);
      return;
    }
    // Plain text becomes a text element, which is what Excalidraw does and is
    // most of what anyone actually pastes into a diagram.
    pasteText(text);
  };

  function pasteElements(elements) {
    const before = doc.length;
    let added = 0;
    for (const element of elements) {
      try {
        doc.insert({ ...element, x: (element.x ?? 0) + PASTE_OFFSET, y: (element.y ?? 0) + PASTE_OFFSET });
        added++;
      } catch {
        // One element the core will not take must not lose the rest of the
        // paste; the format drifts and a clipboard is the likeliest place to
        // meet a shape from a newer Excalidraw.
      }
    }
    if (!added) return;
    // `insert` appends, so the new elements are the last `added` indices.
    doc.setSelection(Array.from({ length: added }, (_, k) => before + k));
    syncFiles();
    selectionKey = "";
    edited({ structural: true });
    reselected();
  }

  function pasteText(text) {
    const [x, y] = toScene(...centre());
    const value = String(text).replace(/\r\n?/g, "\n");
    const measured = measure(value, { fontSize: style.fontSize, fontFamily: style.fontFamily });
    try {
      doc.insert({
        type: "text",
        x,
        y,
        width: measured.width,
        height: measured.height,
        angle: 0,
        text: value,
        originalText: value,
        textAlign: "left",
        verticalAlign: "top",
        lineHeight: 1.25,
        ...styleFor("text", style),
      });
    } catch {
      return;
    }
    selectionKey = "";
    edited({ structural: true });
    reselected();
  }

  // --- text ----------------------------------------------------------------
  //
  // A positioned `<textarea>`, which is what Excalidraw itself does and for
  // the same reason: a text engine is carets, selection, IME, bidi, undo and
  // autocorrect, and the platform has one. What JS contributes that Rust
  // cannot is the *measurement* — `ctx.measureText` is the only way to know
  // how wide a run of text is in a given font — and that is exactly the one
  // thing this section sends back into the document.

  const overlay = el("textarea", "xd-text-overlay");
  overlay.spellcheck = false;
  overlay.autocapitalize = "off";
  overlay.wrap = "off";

  /// Measure a run of text as it will be drawn.
  ///
  /// The height is lines × line height rather than anything font-metric,
  /// because that is precisely what `excalidrawScene.js`'s `textLayout`
  /// assumes when it lays the lines back out. If these two ever disagree the
  /// text jumps the moment the overlay closes, which is the single most
  /// noticeable bug this editor could have.
  function measure(value, element) {
    const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
    const ctx = canvas.getContext("2d");
    const widths = [];
    if (ctx?.measureText) {
      const previous = ctx.font;
      ctx.font = fontString(element);
      for (const line of lines) widths.push(ctx.measureText(line).width);
      ctx.font = previous;
    }
    return textBox(widths, lineHeightPx(element), lines.length);
  }

  /// Put the overlay where its element is, at the current zoom, wearing the
  /// element's own font and colour. Called on open, on every keystroke, and
  /// after any camera move — so the text does not shift when the overlay
  /// closes and the painter takes over.
  function placeOverlay() {
    if (!editing || !doc) return;
    const index = indexOfId(editing.id);
    const element = index >= 0 ? doc.element(index) : null;
    if (!element) return;
    const scale = camera.scale;
    const box = measure(overlay.value, element);
    const [sx, sy] = toScreen(element.x, element.y);
    // The element's own width is what the alignment is measured against; a new
    // element has none yet, in which case it grows from the caret.
    const outer = Math.max(element.width || 0, box.width) * scale;
    const width = Math.max(box.width * scale, 8);
    const align = element.textAlign === "center" ? "center" : element.textAlign === "right" ? "right" : "left";
    const left = align === "center" ? sx + (outer - width) / 2 : align === "right" ? sx + outer - width : sx;
    overlay.style.cssText = [
      "position:absolute",
      `left:${left}px`,
      `top:${sy}px`,
      `width:${width}px`,
      `height:${box.height * scale}px`,
      `font:${fontString({ ...element, fontSize: (element.fontSize ?? 20) * scale })}`,
      `line-height:${lineHeightPx(element) * scale}px`,
      `color:${element.strokeColor || "#1e1e1e"}`,
      `text-align:${align}`,
      `opacity:${opacityOf(element)}`,
      "background:transparent",
      "border:0",
      "outline:0",
      "padding:0",
      "margin:0",
      "resize:none",
      "overflow:hidden",
      "white-space:pre",
      "z-index:3",
    ].join(";");
  }

  /// Open the overlay on an existing element.
  function openOverlay(element, created) {
    if (!element?.id) return;
    editing = { id: element.id, created };
    overlay.value = element.originalText ?? element.text ?? "";
    wrap.appendChild(overlay);
    placeOverlay();
    overlay.focus?.();
    overlay.setSelectionRange?.(overlay.value.length, overlay.value.length);
    schedule();
  }

  /// A new text element at a scene point, with the overlay already open.
  ///
  /// The element joins the document first and is typed into second, which is
  /// the same shape as a dragged-out rectangle: there is no half-existing
  /// thing for the painter or for undo to know about. `endDraft(0)` is what
  /// keeps it — the usual minimum size would throw away a text element that is
  /// zero by zero because nothing has been typed yet.
  function createText(x, y) {
    if (!doc) return;
    const lh = (style.fontSize ?? 20) * 1.25;
    // Dropped by half a line so the caret lands where the pointer did rather
    // than with its top there.
    edited(doc.beginDraft("text", x, y - lh / 2, styleFor("text", style)));
    edited(doc.endDraft(0));
    const index = doc.selection[0];
    const element = index == null ? null : doc.element(index);
    if (!element) return;
    tools.tool = afterDraw(tools);
    selectionKey = "";
    reselected();
    toolChanged();
    openOverlay(element, true);
  }

  /// Close the overlay, writing what was typed back into the document.
  ///
  /// `discard` skips the write — used when the document is about to change
  /// underneath us (an undo) and the element the overlay is editing may not
  /// survive.
  function closeOverlay(discard = false) {
    if (!editing) return;
    const { id, created } = editing;
    const value = overlay.value;
    editing = null;
    overlay.remove();
    if (discard || !doc) return;

    const index = indexOfId(id);
    if (index < 0) return;
    // An empty text element is invisible and unselectable — the user would
    // have no way to get rid of it, and no way to know it was there. So a text
    // edit that ends empty deletes the element rather than leaving one.
    if (!value.trim()) {
      doc.setSelection([index]);
      edited(doc.deleteSelection());
      selectionKey = "";
      reselected();
      return;
    }
    const element = doc.element(index);
    const box = measure(value, element);
    // The measurement is the one thing JS knows that Rust does not.
    edited(doc.patch(id, { text: value, originalText: value, width: box.width, height: box.height }));
    const again = indexOfId(id);
    if (again >= 0) doc.setSelection([again]);
    selectionKey = created ? "" : selectionKey;
    reselected();
  }

  const onOverlayInput = () => {
    placeOverlay();
  };

  const onOverlayKeyDown = (ev) => {
    // Escape and ⌘Enter both commit. Excalidraw commits on Escape too — a text
    // edit has no "cancel", because every keystroke was already visible.
    if (ev.key === "Escape" || (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey))) {
      ev.preventDefault();
      ev.stopPropagation();
      closeOverlay();
      wrap.focus?.();
      return;
    }
    // Everything else belongs to the textarea. Without this the canvas's own
    // handler would read Delete as "delete the selection" while the user is
    // deleting a character.
    ev.stopPropagation();
  };

  const onOverlayBlur = () => closeOverlay();

  // --- the properties panel ------------------------------------------------
  //
  // Loaded lazily and tolerated absent. The panel is a separate module written
  // against a contract; this view has to work while it does not exist yet, and
  // has to keep working if it ever fails to load.

  const applyStyle = (patch) => {
    style = mergeStyle(style, patch);
    // With a selection, the patch is an edit; without one it is a preference
    // for the next shape. Both, always — otherwise drawing a red box, clicking
    // away and drawing another gets you a black one.
    if (hasSelection()) edited(doc.setStyle(stylePatch(patch)));
    panel?.refresh?.();
    schedule();
  };

  import("./excalidrawProps.js")
    .then((mod) => {
      if (detached || typeof mod.renderProps !== "function") return;
      panel = mod.renderProps(panelHost, {
        getStyle: () => (hasSelection() ? styleFrom(doc.element(doc.selection[0])) : { ...style }),
        setStyle: applyStyle,
        hasSelection,
        // A live function rather than a value: the panel takes itself off
        // screen over an empty canvas with the select tool active, and the
        // tool changes on a keystroke it never sees.
        activeTool: () => tools.tool,
      });
    })
    .catch(() => {
      // The editor is fully usable from the keyboard without it; a missing
      // panel is a missing convenience, not a broken view.
    });

  // --- wiring --------------------------------------------------------------

  const listeners = [
    [wrap, "pointerdown", onPointerDown, undefined],
    [wrap, "pointermove", onPointerMove, undefined],
    [wrap, "pointerup", onPointerUp, undefined],
    [wrap, "pointercancel", onPointerUp, undefined],
    [wrap, "dblclick", onDoubleClick, undefined],
    [wrap, "wheel", onWheel, { passive: false }],
    [wrap, "keydown", onKeyDown, undefined],
    [wrap, "keyup", onKeyUp, undefined],
    [wrap, "copy", onCopy, undefined],
    [wrap, "cut", onCut, undefined],
    [wrap, "paste", onPaste, undefined],
    [overlay, "input", onOverlayInput, undefined],
    [overlay, "keydown", onOverlayKeyDown, undefined],
    [overlay, "blur", onOverlayBlur, undefined],
    [typeof window === "undefined" ? null : window, "blur", onBlur, undefined],
  ];
  for (const [target, type, fn, opts] of listeners) target?.addEventListener(type, fn, opts);

  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    placeOverlay();
    schedule();
  });
  ro?.observe(wrap);

  publish();

  // --- opening -------------------------------------------------------------
  //
  // Asynchronous because the WASM core is loaded lazily — the same precedent
  // as bpmn-js in term.hut, and a session that never opens a drawing never
  // pays for it. The view is already on screen and already contributing to the
  // header by the time this starts.

  let note = null;
  // Wrapped in a resolved promise so a factory that throws synchronously
  // lands on the same path as one whose promise rejects — the pane says what
  // is wrong either way.
  Promise.resolve()
    .then(() => openDocument(drawingSource(text)))
    .then(
      (opened) => {
        if (detached) return;
        doc = opened;
        // The host owns the clock: xd-core has no `SystemTime` because it
        // compiles to wasm, so `updated` stamps come from here.
        doc.setNow(Date.now());
        syncFiles();
        fit();
        publish();
        reselected();
        schedule();
      },
      (err) => {
        if (detached) return;
        // A file we cannot parse must not be silently replaced by a blank
        // canvas: that would be one stray keystroke away from overwriting it.
        // The same call bpmnView.js makes, for the same reason.
        wrap.remove();
        note = div("preview-note err", openMessage(err));
        host.appendChild(note);
        onActions?.([]);
      },
    );

  // --- teardown ------------------------------------------------------------

  return function dispose() {
    if (detached) return;
    detached = true;

    // Everything that could fire into a torn-down view goes first, and goes
    // synchronously. bpmnView.js defers its teardown behind a pending save;
    // here the listeners cannot wait for that, because a pointer event landing
    // during the flush would edit a document nobody is watching.
    for (const [target, type, fn, opts] of listeners) target?.removeEventListener(type, fn, opts);
    ro?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    editing = null;
    overlay.remove();
    panel?.dispose?.();
    panel = null;
    // The decoded images are held only by this map and were never in the
    // document, and their sources are data: URLs, so there is no fetch left in
    // flight to abort.
    images.clear();
    wrap.remove();
    note?.remove();
    note = null;

    // A tab closing on a debounce that has not fired yet is an edit the user
    // made and would never see again, so the pending save is flushed —
    // `disposed` stays false until it lands, which is what lets `save()` run
    // at all.
    const pending = timer != null;
    clearTimeout(timer);
    timer = null;
    const finish = () => {
      disposed = true;
      doc = null;
    };
    if (pending) save().then(finish, finish);
    else finish();
  };
}
