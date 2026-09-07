// The only module in this app that knows wasm-bindgen exists.
//
// Everything above this file sees a plain JavaScript object with plain
// methods. That is not tidiness: it is what keeps the boundary swappable (the
// typed-array escape hatch in PLAN.md Phase 4 changes this file and nothing
// else) and what makes excalidrawEdit.js unit-testable against a fake — a
// three-line stub object satisfies the same shape.
//
// The memo is the other half of Phase 4's rule, "never serialize the whole
// scene per frame". Rust hands JS an element as a real JS object, which costs
// a serialization; so each one is cached on (index, version) and an unchanged
// element crosses the boundary exactly once no matter how many frames it is
// painted in. `version` is a single number Rust can answer without building
// anything, which is why the memo key is that and not a hash.

/// Resize handles, in the order `geometry::Handle` discriminates them. The
/// boundary passes an integer rather than a string because handleAt runs on
/// every hover.
export const HANDLE = {
  NW: 0, N: 1, NE: 2, E: 3, SE: 4, S: 5, SW: 6, W: 7, ROTATE: 8,
};

/// The cursor each handle wants, indexed by the constants above. Rotated
/// selections are left alone: naming eight cursors for a shape at 37° is
/// precision the platform's cursor set can't express anyway.
export const HANDLE_CURSOR = [
  "nwse-resize", "ns-resize", "nesw-resize", "ew-resize",
  "nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "grab",
];

/// Z-order moves, as `XdDoc.reorder` numbers them.
export const REORDER = { FRONT: 0, BACK: 1, FORWARD: 2, BACKWARD: 3 };

let modulePromise = null;

/// Load the WASM core, once per page. Lazy on purpose: the same lazy-import
/// precedent as bpmn-js in term.hut, and a session that never opens a drawing
/// never pays for it.
export function loadXd() {
  if (!modulePromise) {
    modulePromise = import("../vendor/xd-wasm/xd_wasm.js").then(async (mod) => {
      await mod.default();
      return mod;
    });
  }
  return modulePromise;
}

/// Wrap a document from a file's text. Throws with the parse error as a
/// sentence fit to show in the pane.
export async function openDoc(text) {
  const mod = await loadXd();
  return wrap(mod.XdDoc.open(String(text ?? "")));
}

/// A new, empty drawing.
export async function blankDoc() {
  const mod = await loadXd();
  return wrap(mod.XdDoc.blank());
}

/// The plain-object face of an `XdDoc`.
///
/// Methods that mutate return a change descriptor — `{ revision, dirty, bbox,
/// structural }` — and the wrapper uses it to keep the element memo honest
/// before handing it on, so no caller has to remember to invalidate.
export function wrap(inner) {
  // index -> { version, element }
  let memo = new Map();

  const invalidate = (change) => {
    if (!change) return change;
    if (change.structural) memo = new Map();
    else for (const i of change.dirty) memo.delete(i);
    return change;
  };

  /// An element as the painter wants it. Cached on (index, version): a repaint
  /// of a hundred elements where one moved costs one serialization, not a
  /// hundred.
  const element = (index) => {
    const version = inner.elementVersion(index);
    if (version < 0) return null;
    const hit = memo.get(index);
    if (hit && hit.version === version) return hit.element;
    const el = inner.element(index);
    memo.set(index, { version, element: el });
    return el;
  };

  /// Every element, in z-order. The painter walks this; it is memoized
  /// element-by-element, so the array is the only allocation per frame.
  const elements = () => {
    const out = new Array(inner.length);
    for (let i = 0; i < inner.length; i++) out[i] = element(i);
    return out;
  };

  const boundsOf = (arr) =>
    arr ? { minX: arr[0], minY: arr[1], maxX: arr[2], maxY: arr[3] } : null;

  return {
    // --- reading ---
    get length() { return inner.length; },
    get revision() { return inner.revision; },
    element,
    elements,
    elementId: (i) => inner.elementId(i),
    elementBounds: (i) => boundsOf(inner.elementBounds(i)),
    sceneBounds: () => boundsOf(inner.sceneBounds()),
    /// `{ scale, offsetX, offsetY }` fitting the drawing into a viewport.
    fitTransform: (width, height, padding = 32) => {
      const [scale, offsetX, offsetY] = inner.fitTransform(width, height, padding);
      return { scale, offsetX, offsetY };
    },
    cornerRadius: (i) => inner.cornerRadius(i),
    appState: () => inner.appState(),
    files: () => inner.files(),
    toJson: () => inner.toJson(),
    setNow: (ms) => inner.setNow(ms),

    // --- hit-testing ---
    hitTest: (x, y, threshold) => inner.hitTest(x, y, threshold),
    marquee: (x0, y0, x1, y1, contain) => Array.from(inner.marquee(x0, y0, x1, y1, !!contain)),

    // --- selection ---
    get selection() { return Array.from(inner.selection); },
    selectionBounds: () => boundsOf(inner.selectionBounds()),
    selectionAngle: () => inner.selectionAngle(),
    setSelection: (indices) => inner.setSelection(Uint32Array.from(indices)),
    toggleSelection: (i) => inner.toggleSelection(i),
    selectAll: () => inner.selectAll(),
    clearSelection: () => inner.clearSelection(),
    handleAt: (x, y, radius) => inner.handleAt(x, y, radius),
    /// The nine handles as [{ x, y }], or null when nothing is selected.
    handlePoints: () => {
      const flat = inner.handlePoints();
      if (!flat) return null;
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
      return out;
    },

    // --- editing. Every one of these returns a change descriptor. ---
    dragBy: (dx, dy, key = "") => invalidate(inner.dragBy(dx, dy, key)),
    resizeTo: (handle, px, py, lockAspect, fromCenter, key = "") =>
      invalidate(inner.resizeTo(handle, px, py, !!lockAspect, !!fromCenter, key)),
    rotateTo: (px, py, snap, key = "") => invalidate(inner.rotateTo(px, py, snap, key)),
    beginDraft: (kind, x, y, style) => invalidate(inner.beginDraft(kind, x, y, style ?? {})),
    draftTo: (x, y, lockAspect) => invalidate(inner.draftTo(x, y, !!lockAspect)),
    draftPoint: (x, y, pressure) => invalidate(inner.draftPoint(x, y, pressure)),
    endDraft: (minSize = 2) => invalidate(inner.endDraft(minSize)),
    insert: (element) => invalidate(inner.insert(element)),
    patch: (id, fields) => invalidate(inner.patch(id, fields)),
    setStyle: (style) => invalidate(inner.setStyle(style)),
    deleteSelection: () => invalidate(inner.deleteSelection()),
    duplicateSelection: (dx = 10, dy = 10) => invalidate(inner.duplicateSelection(dx, dy)),
    reorder: (how) => invalidate(inner.reorder(how)),
    group: () => invalidate(inner.group()),
    ungroup: () => invalidate(inner.ungroup()),
    bind: (arrow, atEnd, target, focus, gap) =>
      invalidate(inner.bind(arrow, !!atEnd, target ?? "", focus, gap)),
    /// The shape an arrow endpoint here would bind to, or -1 — what the
    /// binding highlight is drawn around while an endpoint is being dragged.
    bindableAt: (x, y, skip = "") => inner.bindableAt(x, y, skip),
    rebindEnd: (arrow, atEnd) => invalidate(inner.rebindEnd(arrow, !!atEnd)),
    isBound: (arrow, atEnd) => inner.isBound(arrow, !!atEnd),

    // --- history ---
    canUndo: () => inner.canUndo(),
    canRedo: () => inner.canRedo(),
    undo: () => invalidate(inner.undo()),
    redo: () => invalidate(inner.redo()),
  };
}
