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
     * Insert a finished element from a plain JS object — the path text and
     * paste take, where the shape is known before it exists.
     * @param {any} element
     * @returns {Change}
     */
    insert(element) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.xddoc_insert(retptr, this.__wbg_ptr, addHeapObject(element));
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
     * @param {string} id
     * @param {any} fields
     * @returns {Change}
     */
    patch(id, fields) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xddoc_patch(this.__wbg_ptr, ptr0, len0, addHeapObject(fields));
        return Change.__wrap(ret);
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
