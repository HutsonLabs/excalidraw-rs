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

  /// A flat [x, y, x, y, …] from Rust as [{ x, y }]. Flat because a
  /// `Float64Array` crosses the boundary as one copy, where an array of
  /// objects would be one allocation per point on every hover.
  const pairsOf = (flat) => {
    if (!flat) return null;
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
    return out;
  };

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
    /// The text element bound to element `i` as a label, or -1. Lets the view
    /// re-enter a label that arrived in an Excalidraw-authored file without
    /// scanning every element for a matching `containerId`.
    labelOf: (i) => inner.labelOf(i),
    /// How wide a label inside element `i` is allowed to be. Rust recentres a
    /// label but cannot re-wrap it — it has no font metrics — so the view
    /// measures against this and patches `text`/`width`/`height` itself.
    labelBudget: (i) => inner.labelBudget(i),
    toJson: () => inner.toJson(),
    setNow: (ms) => inner.setNow(ms),

    // --- hit-testing ---
    hitTest: (x, y, threshold) => inner.hitTest(x, y, threshold),
    marquee: (x0, y0, x1, y1, contain) => Array.from(inner.marquee(x0, y0, x1, y1, !!contain)),

    // --- selection ---
    get selection() { return Array.from(inner.selection); },
    selectionBounds: () => boundsOf(inner.selectionBounds()),
    /// The *containment* box of the selection, as distinct from
    /// `selectionBounds`, which is the drawn selection frame. This is the one
    /// "zoom to selection" and "scroll back to content" want.
    selectionExtent: () => boundsOf(inner.selectionExtent()),
    selectionAngle: () => inner.selectionAngle(),
    setSelection: (indices) => inner.setSelection(Uint32Array.from(indices)),
    toggleSelection: (i) => inner.toggleSelection(i),
    selectAll: () => inner.selectAll(),
    clearSelection: () => inner.clearSelection(),
    /// `scenePerPx` is the reciprocal of the zoom. The rotate handle sits a
    /// fixed distance above the selection *on screen*, so the model has to
    /// know how big a screen pixel currently is in scene units — otherwise the
    /// handle drifts out of reach as the drawing is zoomed.
    handleAt: (x, y, radius, scenePerPx = 1) => inner.handleAt(x, y, radius, scenePerPx),
    /// The nine handles as [{ x, y }], or null when nothing is selected.
    handlePoints: (scenePerPx = 1) => pairsOf(inner.handlePoints(scenePerPx)),
    /// A linear element's own points, as [{ x, y }] — the handles that let an
    /// arrow endpoint be grabbed, which the bounding box cannot express.
    /// Null unless exactly one linear element is selected.
    ///
    /// Probe this *before* `handleAt`: on a diagonal arrow the endpoints sit
    /// exactly on the bounding box's corners, and a bbox resize handle winning
    /// that tie is how dragging an endpoint turns into a scale.
    pointHandles: () => pairsOf(inner.pointHandles()),
    /// The midpoint of each segment — where a click adds a new point.
    midpointHandles: () => pairsOf(inner.midpointHandles()),
    pointHandleAt: (x, y, radius) => inner.pointHandleAt(x, y, radius),
    midpointHandleAt: (x, y, radius) => inner.midpointHandleAt(x, y, radius),

    // --- editing. Every one of these returns a change descriptor. ---
    dragBy: (dx, dy, key = "") => invalidate(inner.dragBy(dx, dy, key)),
    resizeTo: (handle, px, py, lockAspect, fromCenter, key = "") =>
      invalidate(inner.resizeTo(handle, px, py, !!lockAspect, !!fromCenter, key)),
    rotateTo: (px, py, snap, key = "") => invalidate(inner.rotateTo(px, py, snap, key)),
    beginDraft: (kind, x, y, style) => invalidate(inner.beginDraft(kind, x, y, style ?? {})),
    draftTo: (x, y, lockAspect) => invalidate(inner.draftTo(x, y, !!lockAspect)),
    draftPoint: (x, y, pressure) => invalidate(inner.draftPoint(x, y, pressure)),
    endDraft: (minSize = 2) => invalidate(inner.endDraft(minSize)),
    /// `at` is a z-order index; undefined or negative means on top, so the
    /// one-argument call this replaced still means what it did.
    insert: (element, at) => invalidate(inner.insert(element, at)),
    /// `key` is a coalesce key: patches sharing one fold into a single undo
    /// entry, which is what makes an eraser sweep one press of undo rather
    /// than one per element. Absent or "" means its own entry.
    patch: (id, fields, key = "") => invalidate(inner.patch(id, fields, key)),
    setStyle: (style) => invalidate(inner.setStyle(style)),
    /// Apply a style *and* re-roll the affected seeds, as one command.
    ///
    /// Two calls would be wrong rather than merely slower: an undo landing
    /// between them leaves the new roughness sitting on the old seed, and
    /// Sloppiness would read as one sketch scaled up instead of three hands.
    setStyleResketched: (style) => invalidate(inner.setStyleResketched(style)),
    /// Re-roll the seed of everything selected. Takes no arguments — it acts
    /// on the current selection.
    reseed: () => invalidate(inner.reseed()),
    /// Drag one point of the selected linear element. Clears that end's
    /// binding first, which is what stops the reflow from snapping the
    /// endpoint back to the shape it was tied to.
    movePoint: (index, x, y, key = "") => invalidate(inner.movePoint(index, x, y, key)),
    /// Add a point to the selected linear element. `index` is a *segment*
    /// index as `midpointHandleAt` returns it — segment i runs from point i to
    /// point i+1, and the new point lands at i+1.
    ///
    /// Unlike `movePoint`, no binding is cleared: an insert is strictly
    /// between two existing points, so neither endpoint moves and both stay
    /// bound. Pass the drag's coalesce key when a click adds a point and then
    /// moves it, so the pair is one undo entry.
    insertPoint: (index, x, y, key = "") => invalidate(inner.insertPoint(index, x, y, key)),
    /// The `files` map — image bytes, keyed by `fileId`. `putFile` throws if
    /// the entry is not an object, because a malformed entry is a broken image
    /// that would only be discovered on the next open.
    putFile: (id, entry) => invalidate(inner.putFile(id, entry)),
    dropFile: (id) => invalidate(inner.dropFile(id)),
    /// Bind a text element into a container as its label, and the inverse.
    /// Sets `containerId` and the container's `boundElements` together, so the
    /// two halves cannot drift apart the way a hand-written pair would.
    ///
    /// Both arguments are ids, not indices — every other id-taking export
    /// (`bind`, `rebindEnd`, `isBound`, `patch`) is the same, and a mixed pair
    /// would be the only one in the API.
    bindLabel: (containerId, textId) => invalidate(inner.bindLabel(containerId, textId)),
    unbindLabel: (textId) => invalidate(inner.unbindLabel(textId)),
    /// Write into `appState`, merging shallowly; a `null` value removes a key.
    /// Reports `structural`, because a theme change repaints everything.
    setAppState: (fields) => invalidate(inner.setAppState(fields)),
    /// "left" | "centerH" | "right" | "top" | "centerV" | "bottom". A no-op
    /// below two elements, matching where upstream enables the control.
    align: (edge) => invalidate(inner.align(edge)),
    /// "horizontal" | "vertical". Equalises gaps rather than centres, and is a
    /// no-op below three elements.
    distribute: (axis) => invalidate(inner.distribute(axis)),
    /// "horizontal" | "vertical". Negates `angle` and mirrors point lists
    /// within themselves, so a flipped arrow turns around rather than just
    /// moving.
    flip: (axis) => invalidate(inner.flip(axis)),
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
