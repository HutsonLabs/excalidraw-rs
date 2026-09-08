/**
 * What changed. Deliberately four scalars and two typed arrays: `dirty` and
 * `bbox` are `Uint32Array`/`Float64Array` views, not JSON, because this
 * crosses on every pointer move.
 */
export class Change {
    static __wrap(ptr) {
        const obj = Object.create(Change.prototype);
        obj.__wbg_ptr = ptr;
        ChangeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ChangeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_change_free(ptr, 0);
    }
    /**
     * `[minX, minY, maxX, maxY]` covering what moved, before and after, or
     * `undefined` when nothing did.
     * @returns {Float64Array | undefined}
     */
    get bbox() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.change_bbox(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The element indices to repaint.
     * @returns {Uint32Array}
     */
    get dirty() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.change_dirty(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get revision() {
        const ret = wasm.change_revision(this.__wbg_ptr);
        return ret;
    }
    /**
     * True when indices shifted — an insert, a delete, a reorder. JS must
     * drop its memo table and repaint everything; `dirty` cannot describe a
     * renumbering.
     * @returns {boolean}
     */
    get structural() {
        const ret = wasm.change_structural(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) Change.prototype[Symbol.dispose] = Change.prototype.free;

/**
 * A document, its undo stack, and the current selection.
 */
export class XdDoc {
    static __wrap(ptr) {
        const obj = Object.create(XdDoc.prototype);
        obj.__wbg_ptr = ptr;
        XdDocFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        XdDocFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_xddoc_free(ptr, 0);
    }
    /**
     * Line the selection up on one edge of its own box: `"left"`, `"centerH"`,
     * `"right"`, `"top"`, `"centerV"`, `"bottom"`. Needs two elements.
     *
     * Strings here, rather than the integer `reorder` takes, because these
     * arrive from a panel button whose own vocabulary is already these words —
     * an integer would put a translation table between the click and the model
     * for no gain on a path that runs once per press.
     * @param {string} edge
     * @returns {Change}
     */
    align(edge) {
        const ptr0 = passStringToWasm0(edge, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_align(this.__wbg_ptr, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * @returns {any}
     */
    appState() {
        const ret = wasm.xddoc_appState(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Start dragging out a new shape. The element joins the document
     * immediately — there is no separate "in progress" thing for the painter
     * to know about — and every subsequent `draftTo` folds into the same undo
     * entry.
     * @param {string} kind
     * @param {number} x
     * @param {number} y
     * @param {any} style
     * @returns {Change}
     */
    beginDraft(kind, x, y, style) {
        const ptr0 = passStringToWasm0(kind, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_beginDraft(this.__wbg_ptr, ptr0, len0, x, y, addHeapObject(style));
        return Change.__wrap(ret);
    }
    /**
     * Put a text element inside a container as its label, maintaining both
     * halves: `containerId` on the text and a `{id, type:"text"}` entry in the
     * container's `boundElements`.
     *
     * Separate from `bind`, which is arrow-endpoint-shaped. Refused unless the
     * text really is a text and the container is one of Excalidraw's
     * text-bindable shapes — rectangle, diamond, ellipse or arrow.
     * @param {string} container
     * @param {string} text
     * @returns {Change}
     */
    bindLabel(container, text) {
        const ptr0 = passStringToWasm0(container, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_bindLabel(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return Change.__wrap(ret);
    }
    /**
     * Bind an arrow's end to a shape, or clear it when `target` is empty.
     * Both sides are maintained by the command — the arrow's binding and the
     * shape's `boundElements` back-reference.
     * @param {string} arrow
     * @param {boolean} at_end
     * @param {string} target
     * @param {number} focus
     * @param {number} gap
     * @returns {Change}
     */
    bind(arrow, at_end, target, focus, gap) {
        const ptr0 = passStringToWasm0(arrow, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(target, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_bind(this.__wbg_ptr, ptr0, len0, at_end, ptr1, len1, focus, gap);
        return Change.__wrap(ret);
    }
    /**
     * The shape an arrow endpoint at this point would bind to, or -1. The
     * editor draws Excalidraw's highlight around it while an endpoint is
     * being dragged, so the binding is visible before it is committed.
     * @param {number} x
     * @param {number} y
     * @param {string} skip
     * @returns {number}
     */
    bindableAt(x, y, skip) {
        const ptr0 = passStringToWasm0(skip, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_bindableAt(this.__wbg_ptr, x, y, ptr0, len0);
        return ret;
    }
    /**
     * @returns {XdDoc}
     */
    static blank() {
        const ret = wasm.xddoc_blank();
        return XdDoc.__wrap(ret);
    }
    /**
     * @returns {boolean}
     */
    canRedo() {
        const ret = wasm.xddoc_canRedo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    canUndo() {
        const ret = wasm.xddoc_canUndo(this.__wbg_ptr);
        return ret !== 0;
    }
    clearSelection() {
        wasm.xddoc_clearSelection(this.__wbg_ptr);
    }
    /**
     * The corner radius Excalidraw would round this element's corners by.
     * @param {number} index
     * @returns {number}
     */
    cornerRadius(index) {
        const ret = wasm.xddoc_cornerRadius(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * @returns {Change}
     */
    deleteSelection() {
        const ret = wasm.xddoc_deleteSelection(this.__wbg_ptr);
        return Change.__wrap(ret);
    }
    /**
     * Space the selection evenly, `"horizontal"` or `"vertical"`, leaving the
     * outermost two where they are. Needs three elements.
     * @param {string} axis
     * @returns {Change}
     */
    distribute(axis) {
        const ptr0 = passStringToWasm0(axis, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_distribute(this.__wbg_ptr, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * Add a point to a freehand draft. Pressure is what the device reported,
     * or 0.5 when it reports nothing.
     * @param {number} x
     * @param {number} y
     * @param {number} pressure
     * @returns {Change}
     */
    draftPoint(x, y, pressure) {
        const ret = wasm.xddoc_draftPoint(this.__wbg_ptr, x, y, pressure);
        return Change.__wrap(ret);
    }
    /**
     * Drag the draft's far corner to a point. For a linear element this moves
     * its last point; for a box it sets the box.
     * @param {number} x
     * @param {number} y
     * @param {boolean} lock_aspect
     * @returns {Change}
     */
    draftTo(x, y, lock_aspect) {
        const ret = wasm.xddoc_draftTo(this.__wbg_ptr, x, y, lock_aspect);
        return Change.__wrap(ret);
    }
    /**
     * Drag the selection. `key` groups the whole drag into one undo entry.
     * @param {number} dx
     * @param {number} dy
     * @param {string} key
     * @returns {Change}
     */
    dragBy(dx, dy, key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_dragBy(this.__wbg_ptr, dx, dy, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * Take an entry out of the `files` map.
     * @param {string} id
     * @returns {Change}
     */
    dropFile(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_dropFile(this.__wbg_ptr, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * @param {number} dx
     * @param {number} dy
     * @returns {Change}
     */
    duplicateSelection(dx, dy) {
        const ret = wasm.xddoc_duplicateSelection(this.__wbg_ptr, dx, dy);
        return Change.__wrap(ret);
    }
    /**
     * @param {number} index
     * @returns {Float64Array | undefined}
     */
    elementBounds(index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_elementBounds(retptr, this.__wbg_ptr, index);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {number} index
     * @returns {string | undefined}
     */
    elementId(index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_elementId(retptr, this.__wbg_ptr, index);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1);
                wasm.__wbindgen_export4(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The memo key. JS caches paint data on `(index, version)`, and this is
     * how it asks whether the cache is still good — one number instead of a
     * serialized element.
     * @param {number} index
     * @returns {number}
     */
    elementVersion(index) {
        const ret = wasm.xddoc_elementVersion(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * One element as a plain JS object, in the file's own shape — camelCase
     * keys, unknown fields included. The painter takes this and draws it
     * without knowing Rust exists.
     * @param {number} index
     * @returns {any}
     */
    element(index) {
        const ret = wasm.xddoc_element(this.__wbg_ptr, index);
        return takeObject(ret);
    }
    /**
     * Finish the draft. A zero-sized shape — a click that never became a drag
     * — is removed rather than left as an invisible element the user cannot
     * see and cannot select.
     * @param {number} min_size
     * @returns {Change}
     */
    endDraft(min_size) {
        const ret = wasm.xddoc_endDraft(this.__wbg_ptr, min_size);
        return Change.__wrap(ret);
    }
    /**
     * @returns {any}
     */
    files() {
        const ret = wasm.xddoc_files(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * The scale and offset that fit the whole drawing into a viewport, as
     * `[scale, offsetX, offsetY]`.
     *
     * Exposed even though `excalidrawScene.js` still has its own copy,
     * because that duplication is the "two painters, one truth" risk PLAN.md
     * names — and a differential test can only pin the two against each other
     * if both are reachable from the same place.
     * @param {number} vw
     * @param {number} vh
     * @param {number} padding
     * @returns {Float64Array}
     */
    fitTransform(vw, vh, padding) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_fitTransform(retptr, this.__wbg_ptr, vw, vh, padding);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Mirror the selection about the centre line of its own box,
     * `"horizontal"` or `"vertical"`. One element flips in place.
     * @param {string} axis
     * @returns {Change}
     */
    flip(axis) {
        const ptr0 = passStringToWasm0(axis, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_flip(this.__wbg_ptr, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * @returns {Change}
     */
    group() {
        const ret = wasm.xddoc_group(this.__wbg_ptr);
        return Change.__wrap(ret);
    }
    /**
     * The resize/rotate handle under a point, as a `Handle` discriminant, or
     * -1. An integer, not a string: this runs on every hover.
     * `scene_per_px` is the reciprocal of the zoom. The rotate handle sits a
     * fixed distance above the box *on screen*, so it needs to know how big a
     * screen pixel currently is in scene units — otherwise the handle is
     * unreachable zoomed out and miles away zoomed in.
     * @param {number} x
     * @param {number} y
     * @param {number} radius
     * @param {number} scene_per_px
     * @returns {number}
     */
    handleAt(x, y, radius, scene_per_px) {
        const ret = wasm.xddoc_handleAt(this.__wbg_ptr, x, y, radius, scene_per_px);
        return ret;
    }
    /**
     * The nine handle positions as `[x0, y0, x1, y1, …]` in `Handle` order,
     * for the painter.
     * @param {number} scene_per_px
     * @returns {Float64Array | undefined}
     */
    handlePoints(scene_per_px) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_handlePoints(retptr, this.__wbg_ptr, scene_per_px);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The topmost element under a point, or -1. `threshold` is stroke slop in
     * scene units — the caller passes roughly 10 / zoom, so the grab area is
     * the same size on screen at every zoom.
     * @param {number} x
     * @param {number} y
     * @param {number} threshold
     * @returns {number}
     */
    hitTest(x, y, threshold) {
        const ret = wasm.xddoc_hitTest(this.__wbg_ptr, x, y, threshold);
        return ret;
    }
    /**
     * Add a point to the selected linear element, in the middle of segment
     * `index` — clicking a midpoint handle.
     *
     * `index` is a **segment** index, exactly as `midpointHandleAt` returns it:
     * segment `i` runs from point `i` to point `i + 1`, and the new point lands
     * between them. Acts on `selection[0]`, for the same reason `movePoint`
     * does.
     *
     * `key` is optional and folds the insert into a surrounding gesture's undo
     * entry — pass the drag's key when a click-and-drag adds a point and then
     * moves it, so the two are one press of ⌘Z.
     * @param {number} index
     * @param {number} x
     * @param {number} y
     * @param {string | null} [key]
     * @returns {Change}
     */
    insertPoint(index, x, y, key) {
        var ptr0 = isLikeNone(key) ? 0 : passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_insertPoint(this.__wbg_ptr, index, x, y, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * Insert a finished element from a plain JS object — the path text and
     * paste take, where the shape is known before it exists.
     *
     * `at` is the z-order index to land on; leave it off (or pass a negative
     * number) for "on top", which is where a drawing gesture puts a new shape.
     * Naming one is what "paste in place" and "paste behind" need — the
     * fractional index is keyed from where the element actually lands, so an
     * insert lower down is correctly ordered for excalidraw.com too.
     * @param {any} element
     * @param {number | null} [at]
     * @returns {Change}
     */
    insert(element, at) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_insert(retptr, this.__wbg_ptr, addHeapObject(element), isLikeNone(at) ? Number.MAX_SAFE_INTEGER : (at) >> 0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return Change.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Whether that end is bound now. Separate from `rebindEnd` because
     * wasm-bindgen has no tuple, and the editor wants the flag for its
     * highlight rather than for its model.
     * @param {string} arrow
     * @param {boolean} at_end
     * @returns {boolean}
     */
    isBound(arrow, at_end) {
        const ptr0 = passStringToWasm0(arrow, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_isBound(this.__wbg_ptr, ptr0, len0, at_end);
        return ret !== 0;
    }
    /**
     * The width a label bound to this container has to wrap inside.
     *
     * The split this export exists for: only JS can measure a string, and only
     * the model knows the container's per-kind budget. Rust says how much room
     * there is; JS wraps to it and patches the label's `text`, `width` and
     * `height`.
     * @param {number} index
     * @returns {number}
     */
    labelBudget(index) {
        const ret = wasm.xddoc_labelBudget(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * The index of the label inside this element, or -1 — how the editor finds
     * an existing label to reopen instead of stacking a second one on top.
     * @param {number} index
     * @returns {number}
     */
    labelOf(index) {
        const ret = wasm.xddoc_labelOf(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * @returns {number}
     */
    get length() {
        const ret = wasm.xddoc_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} x0
     * @param {number} y0
     * @param {number} x1
     * @param {number} y1
     * @param {boolean} contain
     * @returns {Uint32Array}
     */
    marquee(x0, y0, x1, y1, contain) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_marquee(retptr, this.__wbg_ptr, x0, y0, x1, y1, contain);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The index of the *segment* whose midpoint is within `radius` of
     * `(x, y)`, or -1. Segment `i` runs from point `i` to point `i + 1`.
     * @param {number} x
     * @param {number} y
     * @param {number} radius
     * @returns {number}
     */
    midpointHandleAt(x, y, radius) {
        const ret = wasm.xddoc_midpointHandleAt(this.__wbg_ptr, x, y, radius);
        return ret;
    }
    /**
     * The midpoint of each segment of the selected element, same shape as
     * `pointHandles`. Excalidraw shows these as the "add a point here" targets.
     * @returns {Float64Array | undefined}
     */
    midpointHandles() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_midpointHandles(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Drag one point of the selected linear element to `(x, y)`, keyed so the
     * whole drag is one undo entry.
     *
     * Acts on `selection[0]`: the per-point handles are a single-element
     * affordance (`pointHandles` returns nothing for a multi-selection), so the
     * element to edit is the selected one and there is no id to pass.
     *
     * Dragging a bound endpoint away from its shape unbinds it, which is what
     * makes the endpoint movable at all — see [`ops::move_point`]. Call
     * `rebindEnd` on pointer-up to attach it to whatever it was dropped on.
     * @param {number} index
     * @param {number} x
     * @param {number} y
     * @param {string} key
     * @returns {Change}
     */
    movePoint(index, x, y, key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_movePoint(this.__wbg_ptr, index, x, y, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * Parse a `.excalidraw` file. Throws the parse error as a string fit to
     * show in the pane — a half-written file mid-save is a normal thing to
     * open, not a crash.
     * @param {string} text
     * @returns {XdDoc}
     */
    static open(text) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.xddoc_open(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return XdDoc.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Patch one element by id — the escape hatch the text overlay uses when
     * it has measured a label and knows its real width.
     *
     * `key` is the coalesce key, as on `dragBy`: leave it off and the patch is
     * its own undo entry, pass one and every patch under it folds into a single
     * entry. That is what a sweep needs — an eraser crossing forty shapes is
     * one press of ⌘Z, not forty — and there is no other way to express it,
     * since each element needs its own `Patch`.
     * @param {string} id
     * @param {any} fields
     * @param {string | null} [key]
     * @returns {Change}
     */
    patch(id, fields, key) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(key) ? 0 : passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_patch(this.__wbg_ptr, ptr0, len0, addHeapObject(fields), ptr1, len1);
        return Change.__wrap(ret);
    }
    /**
     * The index of the point within `radius` of `(x, y)`, or -1. `radius` is in
     * scene units, like `handleAt`'s.
     * @param {number} x
     * @param {number} y
     * @param {number} radius
     * @returns {number}
     */
    pointHandleAt(x, y, radius) {
        const ret = wasm.xddoc_pointHandleAt(this.__wbg_ptr, x, y, radius);
        return ret;
    }
    /**
     * The selected element's own points as `[x0, y0, x1, y1, …]`, or
     * `undefined` when the selection is not exactly one element with a point
     * list.
     *
     * These are the grips an arrow's endpoints are dragged by — the gesture the
     * nine box handles cannot express, because an endpoint is not on the box.
     * A caller that finds a point handle here must prefer it over
     * `handleAt`: on a diagonal arrow the endpoints land on the box's corner
     * handles, and the endpoint has to win or it is ungrabbable.
     * @returns {Float64Array | undefined}
     */
    pointHandles() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_pointHandles(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Put an entry in the `files` map — the bytes an image element's `fileId`
     * names — as one undoable act.
     *
     * Excalidraw keys these by a hash of the content, so re-adding the same
     * image writes the same value and the command sees no change at all.
     * Nothing here inspects the entry: it is `{mimeType, id, dataURL, created}`
     * as far as the caller is concerned and raw JSON as far as this crate is.
     * @param {string} id
     * @param {any} entry
     * @returns {Change}
     */
    putFile(id, entry) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.xddoc_putFile(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(entry));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return Change.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Bind one end of an arrow to whatever is under it, or clear the binding
     * when there is nothing there, and re-aim the arrow either way.
     * @param {string} arrow
     * @param {boolean} at_end
     * @returns {Change}
     */
    rebindEnd(arrow, at_end) {
        const ptr0 = passStringToWasm0(arrow, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_rebindEnd(this.__wbg_ptr, ptr0, len0, at_end);
        return Change.__wrap(ret);
    }
    /**
     * @returns {Change | undefined}
     */
    redo() {
        const ret = wasm.xddoc_redo(this.__wbg_ptr);
        return ret === 0 ? undefined : Change.__wrap(ret);
    }
    /**
     * 0 front, 1 back, 2 forward, 3 backward.
     * @param {number} how
     * @returns {Change}
     */
    reorder(how) {
        const ret = wasm.xddoc_reorder(this.__wbg_ptr, how);
        return Change.__wrap(ret);
    }
    /**
     * Re-roll the selection's seeds and change nothing else — a fresh sketch
     * of the same shapes.
     * @returns {Change}
     */
    reseed() {
        const ret = wasm.xddoc_reseed(this.__wbg_ptr);
        return Change.__wrap(ret);
    }
    /**
     * @param {number} handle
     * @param {number} px
     * @param {number} py
     * @param {boolean} lock_aspect
     * @param {boolean} from_center
     * @param {string} key
     * @returns {Change}
     */
    resizeTo(handle, px, py, lock_aspect, from_center, key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_resizeTo(this.__wbg_ptr, handle, px, py, lock_aspect, from_center, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    get revision() {
        const ret = wasm.xddoc_revision(this.__wbg_ptr);
        return ret;
    }
    /**
     * Turn the selection so its rotate handle follows `(px, py)`.
     *
     * The first call under a given `key` captures the frame the gesture starts
     * in and every later call is a delta against it — see
     * [`ops::RotateAnchor`]. An empty key is a one-shot rotation and captures
     * afresh each time.
     * @param {number} px
     * @param {number} py
     * @param {number} snap
     * @param {string} key
     * @returns {Change}
     */
    rotateTo(px, py, snap, key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_rotateTo(this.__wbg_ptr, px, py, snap, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * @returns {Float64Array | undefined}
     */
    sceneBounds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_sceneBounds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Select everything a gesture could have selected — which excludes locked
     * elements, as Excalidraw's own select-all does. A ⌘A that pulled a locked
     * element in would make the next drag move the one thing the user said not
     * to move.
     */
    selectAll() {
        wasm.xddoc_selectAll(this.__wbg_ptr);
    }
    /**
     * The selection's shared rotation, or 0 when several elements are
     * selected — a multi-selection has no single angle, and its box is drawn
     * axis-aligned for the same reason.
     * @returns {number}
     */
    selectionAngle() {
        const ret = wasm.xddoc_selectionAngle(this.__wbg_ptr);
        return ret;
    }
    /**
     * The box the selection's handles are drawn on: one element's own
     * unrotated box, or the axis-aligned union of several. Paired with
     * `selectionAngle`, which says how to turn it.
     * @returns {Float64Array | undefined}
     */
    selectionBounds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_selectionBounds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The axis-aligned box that *contains* the selection, `[minX, minY, maxX,
     * maxY]`.
     *
     * Not the same question as `selectionBounds`, which answers "what box do
     * the handles belong on" and gives a single rotated element its own
     * unrotated box. This one is the union of the rotated boxes — where the
     * selection actually is on the canvas — which is what zoom-to-selection
     * and scroll-back-to-content need.
     * @returns {Float64Array | undefined}
     */
    selectionExtent() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_selectionExtent(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get selection() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_selection(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Merge keys into the scene's `appState` — the canvas background, the
     * theme, the grid size — as one undoable act.
     *
     * A shallow merge, and a `null` value removes a key. `appState` is held as
     * raw JSON on purpose (nothing in the core decides anything about it), and
     * this keeps that: keys it has never heard of pass straight through and
     * keys it is not given are left exactly as they were.
     * @param {any} fields
     * @returns {Change}
     */
    setAppState(fields) {
        const ret = wasm.xddoc_setAppState(this.__wbg_ptr, addHeapObject(fields));
        return Change.__wrap(ret);
    }
    /**
     * The host owns the clock: this crate compiles to wasm and must stay
     * deterministic under test, so there is no `SystemTime` anywhere in it.
     * @param {number} ms
     */
    setNow(ms) {
        wasm.xddoc_setNow(this.__wbg_ptr, ms);
    }
    /**
     * @param {Uint32Array} indices
     */
    setSelection(indices) {
        const ptr0 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.xddoc_setSelection(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * A style patch that also re-rolls the seed of everything it touches, as
     * one undo entry — what a sloppiness change is.
     *
     * Excalidraw draws a *different sketch* on every sloppiness click. Scaling
     * the same random draws by a larger roughness instead reads as the stroke
     * getting bolder rather than as a different hand, which is the reported
     * "smooth to bold". The two writes have to be one entry: undo landing
     * between them would leave the new roughness on the old seed.
     * @param {any} style
     * @returns {Change}
     */
    setStyleResketched(style) {
        const ret = wasm.xddoc_setStyleResketched(this.__wbg_ptr, addHeapObject(style));
        return Change.__wrap(ret);
    }
    /**
     * @param {any} style
     * @returns {Change}
     */
    setStyle(style) {
        const ret = wasm.xddoc_setStyle(this.__wbg_ptr, addHeapObject(style));
        return Change.__wrap(ret);
    }
    /**
     * @returns {string}
     */
    toJson() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_toJson(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} index
     */
    toggleSelection(index) {
        wasm.xddoc_toggleSelection(this.__wbg_ptr, index);
    }
    /**
     * Take a label out of its container, both halves. The text stays in the
     * scene, free-floating.
     * @param {string} text
     * @returns {Change}
     */
    unbindLabel(text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_unbindLabel(this.__wbg_ptr, ptr0, len0);
        return Change.__wrap(ret);
    }
    /**
     * @returns {Change | undefined}
     */
    undo() {
        const ret = wasm.xddoc_undo(this.__wbg_ptr);
        return ret === 0 ? undefined : Change.__wrap(ret);
    }
    /**
     * @returns {Change}
     */
    ungroup() {
        const ret = wasm.xddoc_ungroup(this.__wbg_ptr);
        return Change.__wrap(ret);
    }
}
if (Symbol.dispose) XdDoc.prototype[Symbol.dispose] = XdDoc.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_67e7344beaa85059: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(getObject(arg1));
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_b482365c149396c8: function(arg0, arg1) {
            const v = getObject(arg1);
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_7a12af2b3f899c5a: function(arg0) {
            const v = getObject(arg0);
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_0e68cf47c9cbd9b0: function(arg0, arg1) {
            const ret = debugString(getObject(arg1));
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_50072d4d6e45c193: function(arg0, arg1) {
            const ret = getObject(arg0) in getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_is_bigint_60fc0336cb14f5d7: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_fcda5e3902d732fe: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_edb6b15aa3afe12e: function(arg0) {
            const val = getObject(arg0);
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_c4f7cb494a2a21f1: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'string';
            return ret;
        },
        __wbg___wbindgen_jsval_eq_9fdcd3c0a860dd3b: function(arg0, arg1) {
            const ret = getObject(arg0) === getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_3c30021c243b64cd: function(arg0, arg1) {
            const ret = getObject(arg0) == getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_number_get_1dc732b810cb937c: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_269c5566fbede3eb: function() { return handleError(function (arg0, arg1) {
            const ret = getObject(arg0).call(getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_done_cffed884d87aa22e: function(arg0) {
            const ret = getObject(arg0).done;
            return ret;
        },
        __wbg_entries_972a87586902cf87: function(arg0) {
            const ret = Object.entries(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_get_6cf5a4d4d8ad3c5a: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(getObject(arg0), getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_get_b1f0ab13c737f856: function(arg0, arg1) {
            const ret = getObject(arg0)[arg1 >>> 0];
            return addHeapObject(ret);
        },
        __wbg_get_unchecked_363572bdd397d473: function(arg0, arg1) {
            const ret = getObject(arg0)[arg1 >>> 0];
            return addHeapObject(ret);
        },
        __wbg_instanceof_ArrayBuffer_d4ff01f8247925ae: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Map_1ff6a2b54c899f0d: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof Map;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_598adc0fef426aa8: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_5674713bb7b79043: function(arg0) {
            const ret = Array.isArray(getObject(arg0));
            return ret;
        },
        __wbg_isSafeInteger_8f51c743827d1ec5: function(arg0) {
            const ret = Number.isSafeInteger(getObject(arg0));
            return ret;
        },
        __wbg_iterator_22ddeb808cf55a6f: function() {
            const ret = Symbol.iterator;
            return addHeapObject(ret);
        },
        __wbg_length_31bdaf014f5fbde2: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_length_4e1adc0d42e23620: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_new_1da3429bc3c4541c: function(arg0) {
            const ret = new Uint8Array(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_new_8d36e20aa758e411: function() {
            const ret = new Map();
            return addHeapObject(ret);
        },
        __wbg_new_bebc3f4757acf305: function() {
            const ret = new Object();
            return addHeapObject(ret);
        },
        __wbg_new_ffa92086ea89f79c: function() {
            const ret = new Array();
            return addHeapObject(ret);
        },
        __wbg_next_95053e306b1c3aed: function(arg0) {
            const ret = getObject(arg0).next;
            return addHeapObject(ret);
        },
        __wbg_next_f31ecb8646d2c605: function() { return handleError(function (arg0) {
            const ret = getObject(arg0).next();
            return addHeapObject(ret);
        }, arguments); },
        __wbg_prototypesetcall_ae9f5e7459250748: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
        },
        __wbg_set_13d25b81ab403f5e: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
        },
        __wbg_set_bf6dde4923b9b059: function(arg0, arg1, arg2) {
            const ret = getObject(arg0).set(getObject(arg1), getObject(arg2));
            return addHeapObject(ret);
        },
        __wbg_value_c227f843d21da141: function(arg0) {
            const ret = getObject(arg0).value;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./xd_wasm_bg.js": import0,
    };
}

const ChangeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_change_free(ptr, 1));
const XdDocFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_xddoc_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export3(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('xd_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
