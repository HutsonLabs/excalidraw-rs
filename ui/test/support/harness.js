// The fakes the tests share: a recording canvas context, and a DOM that can be
// counted.
//
// Not a `*.test.js`, so `bun test` does not try to run it.
//
// It exists because there were three of these. `excalidrawChrome.test.js` had
// a recording context, `contract.test.js` had a DOM stub with a listener
// tally, and a third was about to be written for the paint loop. Three fakes
// of the same thing drift, and when they drift the tests stop agreeing about
// what the browser does — which is worse than having no fake at all, because
// each suite goes on passing while describing a different platform.
//
// The honesty rule for everything in here: **a fake may be incomplete, but it
// may not be easier to satisfy than the real thing.** A `hitTest` that hits the
// whole box when the real one hits only the stroke is not a simplification, it
// is a lie that hides the bug the test was written to catch. When the two
// disagree, this file changes.

// --- a canvas context that remembers -----------------------------------------

/// A 2D context that records what it was told to do.
///
/// A Proxy rather than a hand-written double: the canvas API is large, the
/// painter uses an unpredictable slice of it, and Rough.js — a real vendored
/// module that runs for real against this — uses another slice again. A stub
/// with a fixed method list would fail as a `TypeError` the first time either
/// reached for something it did not have, which reads as a bug in the painter.
///
/// `calls` lives on the target, not assigned through the proxy afterwards —
/// going through the setter would record the recorder's own wiring as the
/// first call every context ever made.
export function recorder() {
  const calls = [];
  const target = {
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    calls,
    /// Real enough to be useful: the editor measures text through this on its
    /// way to writing a width into the file, and a `measureText` that returned
    /// a recorded call would put NaN there.
    measureText(text) {
      calls.push(["measureText", text]);
      return { width: String(text ?? "").length * 8 };
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => calls.push([prop, ...args]);
    },
    set(t, prop, value) {
      t[prop] = value;
      calls.push([`set:${String(prop)}`, value]);
      return true;
    },
  });
}

/// Every call of one name, for asserting against.
export const callsOf = (ctx, name) => ctx.calls.filter((c) => c[0] === name);

// --- a DOM, to the extent the tests need one ---------------------------------

// --- the lazily-loaded modules, warmed before any test runs -------------------

// `renderEditor` reaches its properties panel through `import()`, so the panel
// mounts a turn or more after the view does. The tests wait that turn out with
// a single `setTimeout(0)`, which is long enough for a module already in the
// registry and *not* long enough for the first, cold load: on a loaded machine
// the read and compile outrun the macrotask, and the panel's listeners land in
// whichever test happens to be running when the import finally resolves. The
// ledger below is cleared per test, so those adds are counted against a test
// that never made them — and the view that did make them belongs to a test
// that has already ended and will never dispose it.
//
// That is the whole of the intermittent `contract.test.js` failure: not a leak
// in the view, but a cold import outrunning the barrier the tests use. It
// showed as `BUTTON:click` 75 and `INPUT:input` 1 — a whole panel — appearing
// in a test that mounts one view and disposes it.
//
// Importing it here, once, makes every later `import()` of the same specifier
// a registry hit that settles in a microtask, and `setTimeout(0)` is always
// after those. Top-level await, so no file that imports this harness can start
// a test before the warm-up has finished.
await import("../../src/excalidrawProps.js");

/// Every add and remove of a listener, anywhere, as one net tally.
///
/// A view that removed nine of its ten listeners fails against this, and so
/// does one that removed a listener it never added. Keyed by tag and type
/// rather than by node so the failure message says *what* leaked.
export const ledger = new Map();

const tally = (node, type, delta) => {
  const key = `${node.tagName ?? "window"}:${type}`;
  ledger.set(key, (ledger.get(key) ?? 0) + delta);
};

/// What `installDom` was told to hand back from `getContext`, and how big an
/// element claims to be. Module state because the nodes are created by
/// `document.createElement` deep inside the code under test, which has no way
/// to be passed anything.
let contextFactory = () => null;
let defaultWidth = 0;
let defaultHeight = 0;

export class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    // A style object with the two shapes the code under test uses: plain
    // property assignment (`style.background = ...`) and the custom-property
    // API (`setProperty("--x", v)`), which is how the panel hands the swatches
    // the filter their colour preview goes through. Setting a property to ""
    // removes it, as the real CSSOM does.
    this.style = {
      setProperty(name, value) {
        if (value === "" || value == null) delete this[name];
        else this[name] = String(value);
      },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] ?? ""; },
    };
    this.dataset = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };
    this.handlers = new Map(); // type -> Set(fn)
    this.clientWidth = defaultWidth;
    this.clientHeight = defaultHeight;
    this.value = "";
    this.textContent = "";
    this.context = null;
  }

  addEventListener(type, fn) {
    tally(this, type, 1);
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    tally(this, type, -1);
    this.handlers.get(type)?.delete(fn);
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    if (child.parentNode === this) child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  /// Empty this node and put `nodes` in it. A real method, and the one the
  /// menu uses to rebuild itself, so the fake owes it rather than forcing the
  /// code under test into a loop it would not otherwise write.
  replaceChildren(...nodes) {
    for (const c of this.children) {
      if (c.parentNode === this) c.parentNode = null;
    }
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }

  /// Deliver an event to whatever is listening, with the two methods every
  /// handler calls on it. Does not bubble: nothing under test relies on it,
  /// and a fake that bubbled would have to model capture and stopPropagation
  /// too.
  /// Dispatch an event at this node.
  ///
  /// `target` defaults to the node dispatched on, because that is what a
  /// browser does and a fake that left it undefined was *easier to satisfy
  /// than the real thing* — the rule this file is written around. The editor
  /// ignores events that came from the chrome by checking `ev.target`, so an
  /// event with no target at all sailed through a check that a real one failed:
  /// every double-click test passed against a handler that, in a browser,
  /// returned on its first line. A test that means "this came from a tool
  /// button" still says so by passing `target` itself.
  dispatch(type, ev = {}) {
    const list = [...(this.handlers.get(type) ?? [])];
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of list) fn(event);
    return event;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  /// The same context object every time, because the painter asks for one per
  /// frame and Rough.js asks for its own — and a recorder that reset between
  /// those two would record half a drawing.
  getContext() {
    if (!this.context) this.context = contextFactory();
    return this.context;
  }

  // The element methods the code under test pokes. All no-ops: none of them
  // decides anything, and a stub that did something would be inventing
  // behaviour to then assert.
  focus() {}
  blur() {}
  select() {}
  setSelectionRange() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  getElementById() { return null; }
  querySelectorAll() { return []; }
}

/// Queued animation frames, by id. Nothing runs unless `flushFrames` is called
/// — a frame that had already fired would prove nothing about whether it was
/// cancelled.
const pendingFrames = new Map();
let frameSeq = 0;
let observers = 0;

class FakeResizeObserver {
  constructor() { observers++; }
  observe() {}
  disconnect() { observers--; }
}

/// Install `document`, `window`, `ResizeObserver` and the animation-frame pair
/// as globals, and reset every counter.
///
///   `width` / `height`  what an element claims its layout is. Zero — a host
///                       that has not been laid out, which a detached one has
///                       not — makes `fitTransform` degenerate to 1:1 with its
///                       padding as the whole offset, which is what makes
///                       coordinates predictable in a test that needs them.
///   `context`           a factory for `getContext("2d")`. The default returns
///                       null, which is the honest headless answer and makes
///                       the painter bail out early; pass `recorder` to make
///                       the paint loop actually run.
export function installDom({ width = 0, height = 0, context = () => null } = {}) {
  ledger.clear();
  pendingFrames.clear();
  frameSeq = 0;
  observers = 0;
  contextFactory = context;
  defaultWidth = width;
  defaultHeight = height;

  const head = new FakeNode("head");
  // The document listens too — a popover dismisses itself on a press anywhere
  // else, and that listener is on `document`. Delegated to a node rather than
  // stubbed with no-ops so it lands in the same ledger as every other
  // listener: one that outlived its menu is exactly the leak this file counts.
  const docNode = new FakeNode("document");
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    head,
    body: new FakeNode("body"),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn, opts) => docNode.addEventListener(type, fn, opts),
    removeEventListener: (type, fn, opts) => docNode.removeEventListener(type, fn, opts),
    dispatch: (type, ev) => docNode.dispatch(type, ev),
  };
  const win = new FakeNode("window");
  win.devicePixelRatio = 1;
  globalThis.window = win;
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.requestAnimationFrame = (fn) => {
    const id = ++frameSeq;
    pendingFrames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => pendingFrames.delete(id);
}

export function uninstallDom() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.ResizeObserver;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
}

/// Run every queued frame once. Anything they schedule stays queued for the
/// next call, which is what makes "did dispose cancel the pending frame?"
/// answerable.
export function flushFrames() {
  const due = [...pendingFrames.values()];
  pendingFrames.clear();
  for (const fn of due) fn();
  return due.length;
}

export const frameCount = () => pendingFrames.size;
export const observerCount = () => observers;

/// Assert-friendly view of the listener tally: the entries that did not
/// balance, as `[name, count]` pairs.
export const leakedListeners = () => [...ledger].filter(([, n]) => n !== 0);
