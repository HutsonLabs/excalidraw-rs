//! The WASM boundary — and the one place this design can fail on performance.
//!
//! The rule, from PLAN.md Phase 4: **never serialize the whole scene per
//! frame.** The `Doc` lives in linear memory and JS holds no model. A pointer
//! event returns a [`Change`] — a revision, the indices that moved, and a
//! bounding box — and JS repaints only those indices, fetching each one's
//! paint data through an accessor it memoizes on `(index, version)`. An
//! unchanged element therefore crosses the boundary exactly once.
//!
//! Two things live here that are not in `xd-core`, and both are deliberate:
//!
//! - **The selection.** It is view state, but keeping it on this side means a
//!   drag does not marshal an id array across the boundary sixty times a
//!   second. JS names elements by index; Rust keeps the ids.
//! - **The draft.** A shape being dragged out is a real element in the
//!   document from the first pixel, patched under one coalesce key, so it is
//!   one undo entry and the painter has nothing special to draw.
//!
//! If profiling ever demands more, the escape hatch is a flat typed-array
//! scene buffer JS reads straight out of `memory.buffer`. Design for it; do
//! not build it yet.

use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;

use xd_core::command::{Command, End, Reorder};
use xd_core::doc::Doc;
use xd_core::geometry::{self, Bounds, Handle};
use xd_core::ops;
use xd_core::scene::{Binding, ElementKind};

/// What changed. Deliberately four scalars and two typed arrays: `dirty` and
/// `bbox` are `Uint32Array`/`Float64Array` views, not JSON, because this
/// crosses on every pointer move.
#[wasm_bindgen]
pub struct Change {
    revision: f64,
    dirty: Vec<u32>,
    bbox: Option<Vec<f64>>,
    structural: bool,
}

#[wasm_bindgen]
impl Change {
    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> f64 {
        self.revision
    }

    /// The element indices to repaint.
    #[wasm_bindgen(getter)]
    pub fn dirty(&self) -> Vec<u32> {
        self.dirty.clone()
    }

    /// `[minX, minY, maxX, maxY]` covering what moved, before and after, or
    /// `undefined` when nothing did.
    #[wasm_bindgen(getter)]
    pub fn bbox(&self) -> Option<Vec<f64>> {
        self.bbox.clone()
    }

    /// True when indices shifted — an insert, a delete, a reorder. JS must
    /// drop its memo table and repaint everything; `dirty` cannot describe a
    /// renumbering.
    #[wasm_bindgen(getter)]
    pub fn structural(&self) -> bool {
        self.structural
    }
}

impl From<xd_core::doc::Change> for Change {
    fn from(c: xd_core::doc::Change) -> Self {
        Change {
            revision: c.revision as f64,
            dirty: c.dirty,
            bbox: c.bbox.map(|b| b.to_array().to_vec()),
            structural: c.structural,
        }
    }
}

/// A document, its undo stack, and the current selection.
#[wasm_bindgen]
pub struct XdDoc {
    doc: Doc,
    /// Selected element **ids**, not indices: an insert or a reorder renumbers
    /// every index after it, and a selection that silently jumped to a
    /// different shape after an undo would be the worst kind of bug to chase.
    selection: Vec<String>,
    /// The element currently being dragged out, if any.
    draft: Option<String>,
}

#[wasm_bindgen]
impl XdDoc {
    /// Parse a `.excalidraw` file. Throws the parse error as a string fit to
    /// show in the pane — a half-written file mid-save is a normal thing to
    /// open, not a crash.
    pub fn open(text: &str) -> Result<XdDoc, JsValue> {
        Doc::from_json(text)
            .map(|doc| XdDoc { doc, selection: Vec::new(), draft: None })
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn blank() -> XdDoc {
        XdDoc { doc: Doc::blank(), selection: Vec::new(), draft: None }
    }

    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> String {
        self.doc.to_json()
    }

    /// The host owns the clock: this crate compiles to wasm and must stay
    /// deterministic under test, so there is no `SystemTime` anywhere in it.
    #[wasm_bindgen(js_name = setNow)]
    pub fn set_now(&mut self, ms: f64) {
        self.doc.set_now(ms as i64);
    }

    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> f64 {
        self.doc.revision() as f64
    }

    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.doc.elements().len()
    }

    // --- reading ------------------------------------------------------------

    /// One element as a plain JS object, in the file's own shape — camelCase
    /// keys, unknown fields included. The painter takes this and draws it
    /// without knowing Rust exists.
    pub fn element(&self, index: usize) -> JsValue {
        match self.doc.elements().get(index) {
            Some(e) => to_js(e),
            None => JsValue::UNDEFINED,
        }
    }

    /// The memo key. JS caches paint data on `(index, version)`, and this is
    /// how it asks whether the cache is still good — one number instead of a
    /// serialized element.
    #[wasm_bindgen(js_name = elementVersion)]
    pub fn element_version(&self, index: usize) -> f64 {
        self.doc.elements().get(index).map(|e| e.version as f64).unwrap_or(-1.0)
    }

    #[wasm_bindgen(js_name = elementId)]
    pub fn element_id(&self, index: usize) -> Option<String> {
        self.doc.elements().get(index).map(|e| e.id.clone())
    }

    #[wasm_bindgen(js_name = elementBounds)]
    pub fn element_bounds(&self, index: usize) -> Option<Vec<f64>> {
        self.doc
            .elements()
            .get(index)
            .and_then(geometry::element_bounds_rotated)
            .map(|b| b.to_array().to_vec())
    }

    /// The scale and offset that fit the whole drawing into a viewport, as
    /// `[scale, offsetX, offsetY]`.
    ///
    /// Exposed even though `excalidrawScene.js` still has its own copy,
    /// because that duplication is the "two painters, one truth" risk PLAN.md
    /// names — and a differential test can only pin the two against each other
    /// if both are reachable from the same place.
    #[wasm_bindgen(js_name = fitTransform)]
    pub fn fit_transform(&self, vw: f64, vh: f64, padding: f64) -> Vec<f64> {
        let bounds = geometry::scene_bounds(self.doc.elements());
        let t = geometry::fit_transform(bounds.as_ref(), vw, vh, padding);
        vec![t.scale, t.offset_x, t.offset_y]
    }

    /// The corner radius Excalidraw would round this element's corners by.
    #[wasm_bindgen(js_name = cornerRadius)]
    pub fn corner_radius(&self, index: usize) -> f64 {
        self.doc.elements().get(index).map(geometry::corner_radius).unwrap_or(0.0)
    }

    #[wasm_bindgen(js_name = sceneBounds)]
    pub fn scene_bounds(&self) -> Option<Vec<f64>> {
        geometry::scene_bounds(self.doc.elements()).map(|b| b.to_array().to_vec())
    }

    #[wasm_bindgen(js_name = appState)]
    pub fn app_state(&self) -> JsValue {
        to_js(&self.doc.scene().app_state)
    }

    pub fn files(&self) -> JsValue {
        to_js(&self.doc.scene().files)
    }

    // --- hit-testing --------------------------------------------------------

    /// The topmost element under a point, or -1. `threshold` is stroke slop in
    /// scene units — the caller passes roughly 10 / zoom, so the grab area is
    /// the same size on screen at every zoom.
    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&self, x: f64, y: f64, threshold: f64) -> i32 {
        geometry::hit_test_scene(self.doc.elements(), x, y, threshold)
            .map(|i| i as i32)
            .unwrap_or(-1)
    }

    pub fn marquee(&self, x0: f64, y0: f64, x1: f64, y1: f64, contain: bool) -> Vec<u32> {
        let area = Bounds::from_corners(x0, y0, x1, y1);
        geometry::marquee_hits(self.doc.elements(), &area, contain)
            .into_iter()
            .map(|i| i as u32)
            .collect()
    }

    // --- selection ----------------------------------------------------------

    #[wasm_bindgen(getter)]
    pub fn selection(&self) -> Vec<u32> {
        self.selection
            .iter()
            .filter_map(|id| self.doc.index_of(id))
            .map(|i| i as u32)
            .collect()
    }

    #[wasm_bindgen(js_name = selectionBounds)]
    pub fn selection_bounds(&self) -> Option<Vec<f64>> {
        ops::selection_bounds(&self.doc, &self.selection).map(|b| b.to_array().to_vec())
    }

    /// The selection's shared rotation, or 0 when several elements are
    /// selected — a multi-selection has no single angle, and its box is drawn
    /// axis-aligned for the same reason.
    #[wasm_bindgen(js_name = selectionAngle)]
    pub fn selection_angle(&self) -> f64 {
        if self.selection.len() != 1 {
            return 0.0;
        }
        self.doc
            .index_of(&self.selection[0])
            .map(|i| self.doc.elements()[i].angle)
            .unwrap_or(0.0)
    }

    #[wasm_bindgen(js_name = setSelection)]
    pub fn set_selection(&mut self, indices: Vec<u32>) {
        self.selection = indices
            .into_iter()
            .filter_map(|i| self.doc.elements().get(i as usize))
            .map(|e| e.id.clone())
            .collect();
    }

    #[wasm_bindgen(js_name = toggleSelection)]
    pub fn toggle_selection(&mut self, index: usize) {
        let Some(id) = self.doc.elements().get(index).map(|e| e.id.clone()) else { return };
        match self.selection.iter().position(|s| *s == id) {
            Some(at) => {
                self.selection.remove(at);
            }
            None => self.selection.push(id),
        }
    }

    #[wasm_bindgen(js_name = selectAll)]
    pub fn select_all(&mut self) {
        self.selection = self
            .doc
            .elements()
            .iter()
            .filter(|e| !e.is_deleted)
            .map(|e| e.id.clone())
            .collect();
    }

    #[wasm_bindgen(js_name = clearSelection)]
    pub fn clear_selection(&mut self) {
        self.selection.clear();
    }

    /// The resize/rotate handle under a point, as a `Handle` discriminant, or
    /// -1. An integer, not a string: this runs on every hover.
    #[wasm_bindgen(js_name = handleAt)]
    pub fn handle_at(&self, x: f64, y: f64, radius: f64) -> i32 {
        let Some(b) = ops::selection_bounds(&self.doc, &self.selection) else { return -1 };
        geometry::handle_at(&b, self.selection_angle(), x, y, radius)
            .map(|h| h.as_u32() as i32)
            .unwrap_or(-1)
    }

    /// The nine handle positions as `[x0, y0, x1, y1, …]` in `Handle` order,
    /// for the painter.
    #[wasm_bindgen(js_name = handlePoints)]
    pub fn handle_points(&self) -> Option<Vec<f64>> {
        let b = ops::selection_bounds(&self.doc, &self.selection)?;
        let pts = geometry::handle_points(&b, self.selection_angle());
        Some(pts.iter().flat_map(|(x, y)| [*x, *y]).collect())
    }

    // --- editing ------------------------------------------------------------

    /// Drag the selection. `key` groups the whole drag into one undo entry.
    #[wasm_bindgen(js_name = dragBy)]
    pub fn drag_by(&mut self, dx: f64, dy: f64, key: &str) -> Change {
        let change = ops::translate(&mut self.doc, &self.selection, dx, dy, some(key));
        self.with_reflow(change, key)
    }

    #[wasm_bindgen(js_name = resizeTo)]
    pub fn resize_to(
        &mut self,
        handle: u32,
        px: f64,
        py: f64,
        lock_aspect: bool,
        from_center: bool,
        key: &str,
    ) -> Change {
        let Some(handle) = Handle::from_u32(handle) else { return self.doc.no_change().into() };
        let change = ops::resize(
            &mut self.doc,
            &self.selection,
            handle,
            px,
            py,
            lock_aspect,
            from_center,
            some(key),
        );
        self.with_reflow(change, key)
    }

    #[wasm_bindgen(js_name = rotateTo)]
    pub fn rotate_to(&mut self, px: f64, py: f64, snap: f64, key: &str) -> Change {
        let change = ops::rotate(&mut self.doc, &self.selection, px, py, snap, some(key));
        self.with_reflow(change, key)
    }

    /// Start dragging out a new shape. The element joins the document
    /// immediately — there is no separate "in progress" thing for the painter
    /// to know about — and every subsequent `draftTo` folds into the same undo
    /// entry.
    #[wasm_bindgen(js_name = beginDraft)]
    pub fn begin_draft(&mut self, kind: &str, x: f64, y: f64, style: JsValue) -> Change {
        let kind = kind_of(kind);
        let b = Bounds::new(x, y, x, y);
        let mut element = self.doc.new_element(kind, &b);
        if let Some(style) = from_js_map(&style) {
            apply_style(&mut element, &style);
        }
        let id = element.id.clone();
        let change = self.doc.apply(Command::Insert { at: None, element: Box::new(element) });
        self.selection = vec![id.clone()];
        self.draft = Some(id);
        change.into()
    }

    /// Drag the draft's far corner to a point. For a linear element this moves
    /// its last point; for a box it sets the box.
    #[wasm_bindgen(js_name = draftTo)]
    pub fn draft_to(&mut self, x: f64, y: f64, lock_aspect: bool) -> Change {
        let Some(id) = self.draft.clone() else { return self.doc.no_change().into() };
        let Some(i) = self.doc.index_of(&id) else { return self.doc.no_change().into() };
        let e = &self.doc.elements()[i];
        let mut fields = Map::new();
        if e.kind.is_linear() {
            let pts = vec![[0.0, 0.0], [x - e.x, y - e.y]];
            fields.insert("points".into(), serde_json::json!(pts));
            fields.insert("width".into(), serde_json::json!((x - e.x).abs()));
            fields.insert("height".into(), serde_json::json!((y - e.y).abs()));
        } else {
            let (mut w, mut h) = (x - e.x, y - e.y);
            if lock_aspect {
                let side = w.abs().max(h.abs());
                w = side.copysign(w);
                h = side.copysign(h);
            }
            fields.insert("width".into(), serde_json::json!(w));
            fields.insert("height".into(), serde_json::json!(h));
        }
        self.doc
            .apply_keyed(Command::Patch { id, fields }, "draft", self.doc.now())
            .into()
    }

    /// Add a point to a freehand draft. Pressure is what the device reported,
    /// or 0.5 when it reports nothing.
    #[wasm_bindgen(js_name = draftPoint)]
    pub fn draft_point(&mut self, x: f64, y: f64, pressure: f64) -> Change {
        let Some(id) = self.draft.clone() else { return self.doc.no_change().into() };
        let Some(i) = self.doc.index_of(&id) else { return self.doc.no_change().into() };
        let e = &self.doc.elements()[i];
        let mut points = e.points.clone().unwrap_or_default();
        let mut pressures = e.pressures.clone().unwrap_or_default();
        // A freedraw element is seeded with its first point and no pressure
        // for it, so the two arrays start one apart and stay that way for the
        // life of the stroke. perfect-freehand indexes them together: with
        // `simulatePressure` on nothing shows, but a pen reports real values
        // and every one of them lands on the wrong point. Pad to the points
        // already there before adding this one.
        while pressures.len() < points.len() {
            pressures.push(pressure);
        }
        points.push([x - e.x, y - e.y]);
        pressures.push(pressure);
        let (mut w, mut h) = (0.0f64, 0.0f64);
        for p in &points {
            w = w.max(p[0].abs());
            h = h.max(p[1].abs());
        }
        let mut fields = Map::new();
        fields.insert("points".into(), serde_json::json!(points));
        fields.insert("pressures".into(), serde_json::json!(pressures));
        fields.insert("width".into(), serde_json::json!(w));
        fields.insert("height".into(), serde_json::json!(h));
        self.doc
            .apply_keyed(Command::Patch { id, fields }, "draft", self.doc.now())
            .into()
    }

    /// Finish the draft. A zero-sized shape — a click that never became a drag
    /// — is removed rather than left as an invisible element the user cannot
    /// see and cannot select.
    #[wasm_bindgen(js_name = endDraft)]
    pub fn end_draft(&mut self, min_size: f64) -> Change {
        let Some(id) = self.draft.take() else { return self.doc.no_change().into() };
        let Some(i) = self.doc.index_of(&id) else { return self.doc.no_change().into() };
        let e = &self.doc.elements()[i];
        // Text is committed by the overlay, not by the drag that created it:
        // it is 0×0 until the editor has measured what was typed. Sending it
        // through the empty-draft rule below would delete it before the user
        // could type a character, and the only thing standing between that and
        // the current behaviour is a `<` rather than a `<=`. Say so instead.
        if e.kind == ElementKind::Text {
            return self.doc.no_change().into();
        }
        let empty = match &e.points {
            Some(p) => p.len() < 2,
            None => e.width.abs() < min_size && e.height.abs() < min_size,
        };
        if empty {
            self.selection.clear();
            return self.doc.apply(Command::Delete { ids: vec![id] }).into();
        }
        // An arrow drawn from one shape to another binds to both, the moment
        // it is finished. Excalidraw does this and people rely on it without
        // knowing it has a name — an arrow you have to explicitly attach is an
        // arrow that will be left unattached.
        if e.kind.is_linear() {
            let (a, _) = ops::rebind_end(&mut self.doc, &id, false);
            let (b, _) = ops::rebind_end(&mut self.doc, &id, true);
            return merge(a, b).into();
        }

        // A box dragged up and to the left has negative extents, which is
        // legal in the format but makes every later comparison work harder.
        let (x, y, w, h) = (e.x, e.y, e.width, e.height);
        if w < 0.0 || h < 0.0 {
            let mut fields = Map::new();
            fields.insert("x".into(), serde_json::json!(if w < 0.0 { x + w } else { x }));
            fields.insert("y".into(), serde_json::json!(if h < 0.0 { y + h } else { y }));
            fields.insert("width".into(), serde_json::json!(w.abs()));
            fields.insert("height".into(), serde_json::json!(h.abs()));
            return self.doc.apply(Command::Patch { id, fields }).into();
        }
        self.doc.no_change().into()
    }

    /// Insert a finished element from a plain JS object — the path text and
    /// paste take, where the shape is known before it exists.
    pub fn insert(&mut self, element: JsValue) -> Result<Change, JsValue> {
        let mut value: Map<String, Value> =
            from_js_map(&element).ok_or_else(|| JsValue::from_str("insert expects an object"))?;
        // The caller may not name an id or a seed, and must not be trusted
        // with either: identity is the Doc's to hand out.
        let (id, seed) = self.doc.fresh_identity();
        value.insert("id".into(), Value::String(id.clone()));
        value.insert("seed".into(), serde_json::json!(seed));
        let el: xd_core::scene::Element = serde_json::from_value(Value::Object(value))
            .map_err(|e| JsValue::from_str(&format!("that isn't an element: {e}")))?;
        let change = self.doc.apply(Command::Insert { at: None, element: Box::new(el) });
        self.selection = vec![id];
        Ok(change.into())
    }

    /// Patch one element by id — the escape hatch the text overlay uses when
    /// it has measured a label and knows its real width.
    pub fn patch(&mut self, id: &str, fields: JsValue) -> Change {
        match from_js_map(&fields) {
            Some(fields) => self.doc.apply(Command::Patch { id: id.to_string(), fields }).into(),
            None => self.doc.no_change().into(),
        }
    }

    #[wasm_bindgen(js_name = setStyle)]
    pub fn set_style(&mut self, style: JsValue) -> Change {
        match from_js_map(&style) {
            Some(style) => ops::set_style(&mut self.doc, &self.selection, &style).into(),
            None => self.doc.no_change().into(),
        }
    }

    #[wasm_bindgen(js_name = deleteSelection)]
    pub fn delete_selection(&mut self) -> Change {
        let ids = std::mem::take(&mut self.selection);
        self.doc.apply(Command::Delete { ids }).into()
    }

    #[wasm_bindgen(js_name = duplicateSelection)]
    pub fn duplicate_selection(&mut self, dx: f64, dy: f64) -> Change {
        let ids = self.selection.clone();
        let (change, new_ids) = ops::duplicate(&mut self.doc, &ids, dx, dy);
        if !new_ids.is_empty() {
            self.selection = new_ids;
        }
        change.into()
    }

    /// 0 front, 1 back, 2 forward, 3 backward.
    pub fn reorder(&mut self, how: u32) -> Change {
        let how = match how {
            0 => Reorder::Front,
            1 => Reorder::Back,
            2 => Reorder::Forward,
            _ => Reorder::Backward,
        };
        self.doc.apply(Command::Reorder { ids: self.selection.clone(), how }).into()
    }

    pub fn group(&mut self) -> Change {
        self.doc.apply(Command::Group { ids: self.selection.clone() }).into()
    }

    pub fn ungroup(&mut self) -> Change {
        self.doc.apply(Command::Ungroup { ids: self.selection.clone() }).into()
    }

    /// Bind an arrow's end to a shape, or clear it when `target` is empty.
    /// Both sides are maintained by the command — the arrow's binding and the
    /// shape's `boundElements` back-reference.
    pub fn bind(&mut self, arrow: &str, at_end: bool, target: &str, focus: f64, gap: f64) -> Change {
        let end = if at_end { End::End } else { End::Start };
        let binding = (!target.is_empty()).then(|| Binding {
            element_id: target.to_string(),
            focus,
            gap,
            rest: Map::new(),
        });
        self.doc.apply(Command::Bind { arrow: arrow.to_string(), end, binding }).into()
    }

    /// The shape an arrow endpoint at this point would bind to, or -1. The
    /// editor draws Excalidraw's highlight around it while an endpoint is
    /// being dragged, so the binding is visible before it is committed.
    #[wasm_bindgen(js_name = bindableAt)]
    pub fn bindable_at(&self, x: f64, y: f64, skip: &str) -> i32 {
        xd_core::binding::bindable_at(self.doc.elements(), x, y, skip)
            .map(|i| i as i32)
            .unwrap_or(-1)
    }

    /// Bind one end of an arrow to whatever is under it, or clear the binding
    /// when there is nothing there, and re-aim the arrow either way.
    #[wasm_bindgen(js_name = rebindEnd)]
    pub fn rebind_end(&mut self, arrow: &str, at_end: bool) -> Change {
        let (change, _bound) = ops::rebind_end(&mut self.doc, arrow, at_end);
        change.into()
    }

    /// Whether that end is bound now. Separate from `rebindEnd` because
    /// wasm-bindgen has no tuple, and the editor wants the flag for its
    /// highlight rather than for its model.
    #[wasm_bindgen(js_name = isBound)]
    pub fn is_bound(&self, arrow: &str, at_end: bool) -> bool {
        self.doc
            .index_of(arrow)
            .map(|i| &self.doc.elements()[i])
            .is_some_and(|e| if at_end { e.end_binding.is_some() } else { e.start_binding.is_some() })
    }

    // --- history ------------------------------------------------------------

    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.doc.can_undo()
    }

    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.doc.can_redo()
    }

    pub fn undo(&mut self) -> Option<Change> {
        let change = self.doc.undo()?;
        self.prune_selection();
        Some(change.into())
    }

    pub fn redo(&mut self) -> Option<Change> {
        let change = self.doc.redo()?;
        self.prune_selection();
        Some(change.into())
    }

    /// Re-aim every arrow bound to anything that just moved, folded into the
    /// same undo entry by the same coalesce key.
    ///
    /// Done here rather than left to the caller for the same reason the
    /// version bookkeeping is done inside `apply`: a drag that forgets to
    /// reflow leaves the diagram visibly coming apart, and "remember to call
    /// this" is not a mechanism.
    fn with_reflow(&mut self, change: xd_core::doc::Change, key: &str) -> Change {
        let ids = self.selection.clone();
        let extra = ops::reflow_bindings(&mut self.doc, &ids, some(key));
        merge(change, extra).into()
    }

    /// Undo can delete what was selected. Dropping the ids that no longer
    /// resolve is cheaper than teaching every reader to tolerate a selection
    /// that points at nothing.
    fn prune_selection(&mut self) {
        let doc = &self.doc;
        self.selection.retain(|id| doc.index_of(id).is_some());
    }
}

/// `""` means "no coalescing" at the JS boundary, because an optional string
/// argument costs a `JsValue` round trip on every pointer move.
fn some(key: &str) -> Option<&str> {
    (!key.is_empty()).then_some(key)
}

/// Two changes as one. The revision is the later of the two; the dirty sets
/// and boxes are unions.
fn merge(a: xd_core::doc::Change, b: xd_core::doc::Change) -> xd_core::doc::Change {
    let mut dirty = a.dirty;
    for i in b.dirty {
        if !dirty.contains(&i) {
            dirty.push(i);
        }
    }
    xd_core::doc::Change {
        revision: a.revision.max(b.revision),
        dirty,
        bbox: match (a.bbox, b.bbox) {
            (Some(x), Some(y)) => Some(x.union(&y)),
            (Some(x), None) | (None, Some(x)) => Some(x),
            (None, None) => None,
        },
        structural: a.structural || b.structural,
    }
}

fn kind_of(kind: &str) -> ElementKind {
    match kind {
        "rectangle" => ElementKind::Rectangle,
        "diamond" => ElementKind::Diamond,
        "ellipse" => ElementKind::Ellipse,
        "line" => ElementKind::Line,
        "arrow" => ElementKind::Arrow,
        "freedraw" => ElementKind::Freedraw,
        "text" => ElementKind::Text,
        "image" => ElementKind::Image,
        "frame" => ElementKind::Frame,
        other => ElementKind::Other(other.to_string()),
    }
}

/// Style keys the draft carries in from the toolbar. Applied by name so a new
/// style property needs no change here.
fn apply_style(element: &mut xd_core::scene::Element, style: &Map<String, Value>) {
    let mut value = serde_json::to_value(&*element).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut value {
        for (k, v) in style {
            map.insert(k.clone(), v.clone());
        }
        if let Ok(patched) = serde_json::from_value(value) {
            *element = patched;
        }
    }
}

/// Serialize for JS as a plain object rather than as a `Map`. The painter
/// reads `element.strokeColor`; a `Map` would make it `element.get(…)` and the
/// port to term.hut would stop being a copy.
fn to_js<T: serde::Serialize>(value: &T) -> JsValue {
    let ser = serde_wasm_bindgen::Serializer::json_compatible();
    value.serialize(&ser).unwrap_or(JsValue::UNDEFINED)
}

fn from_js_map(value: &JsValue) -> Option<Map<String, Value>> {
    match serde_wasm_bindgen::from_value::<Value>(value.clone()) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}
