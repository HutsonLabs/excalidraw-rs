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
    /// The rotation in progress, under the coalesce key that identifies it.
    ///
    /// Rotation is the one gesture that cannot be computed from the scene as it
    /// stands — see [`ops::RotateAnchor`] — so the frame it started in lives
    /// here for the life of the gesture, exactly as the draft does. The key is
    /// part of the value rather than a separate flag because it is what says
    /// "this is the same gesture": the editor mints a fresh one per pointer-down
    /// (`rotate:<n>`), so a new drag can never inherit the previous drag's
    /// pivot.
    rotate: Option<(String, ops::RotateAnchor)>,
}

#[wasm_bindgen]
impl XdDoc {
    /// Parse a `.excalidraw` file. Throws the parse error as a string fit to
    /// show in the pane — a half-written file mid-save is a normal thing to
    /// open, not a crash.
    pub fn open(text: &str) -> Result<XdDoc, JsValue> {
        Doc::from_json(text)
            .map(|doc| XdDoc { doc, selection: Vec::new(), draft: None, rotate: None })
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn blank() -> XdDoc {
        XdDoc { doc: Doc::blank(), selection: Vec::new(), draft: None, rotate: None }
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

    /// Put an entry in the `files` map — the bytes an image element's `fileId`
    /// names — as one undoable act.
    ///
    /// Excalidraw keys these by a hash of the content, so re-adding the same
    /// image writes the same value and the command sees no change at all.
    /// Nothing here inspects the entry: it is `{mimeType, id, dataURL, created}`
    /// as far as the caller is concerned and raw JSON as far as this crate is.
    #[wasm_bindgen(js_name = putFile)]
    pub fn put_file(&mut self, id: &str, entry: JsValue) -> Result<Change, JsValue> {
        let entry = serde_wasm_bindgen::from_value::<Value>(entry)
            .map_err(|e| JsValue::from_str(&format!("that isn't a file entry: {e}")))?;
        Ok(self.doc.apply(Command::PutFile { id: id.to_string(), entry }).into())
    }

    /// Take an entry out of the `files` map.
    #[wasm_bindgen(js_name = dropFile)]
    pub fn drop_file(&mut self, id: &str) -> Change {
        self.doc.apply(Command::DropFile { id: id.to_string() }).into()
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

    /// The box the selection's handles are drawn on: one element's own
    /// unrotated box, or the axis-aligned union of several. Paired with
    /// `selectionAngle`, which says how to turn it.
    #[wasm_bindgen(js_name = selectionBounds)]
    pub fn selection_bounds(&self) -> Option<Vec<f64>> {
        ops::selection_frame(&self.doc, &self.selection).map(|f| f.bounds.to_array().to_vec())
    }

    /// The axis-aligned box that *contains* the selection, `[minX, minY, maxX,
    /// maxY]`.
    ///
    /// Not the same question as `selectionBounds`, which answers "what box do
    /// the handles belong on" and gives a single rotated element its own
    /// unrotated box. This one is the union of the rotated boxes — where the
    /// selection actually is on the canvas — which is what zoom-to-selection
    /// and scroll-back-to-content need.
    #[wasm_bindgen(js_name = selectionExtent)]
    pub fn selection_extent(&self) -> Option<Vec<f64>> {
        ops::selection_bounds(&self.doc, &self.selection).map(|b| b.to_array().to_vec())
    }

    /// The selection's shared rotation, or 0 when several elements are
    /// selected — a multi-selection has no single angle, and its box is drawn
    /// axis-aligned for the same reason.
    #[wasm_bindgen(js_name = selectionAngle)]
    pub fn selection_angle(&self) -> f64 {
        ops::selection_frame(&self.doc, &self.selection).map(|f| f.angle).unwrap_or(0.0)
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

    /// Select everything a gesture could have selected — which excludes locked
    /// elements, as Excalidraw's own select-all does. A ⌘A that pulled a locked
    /// element in would make the next drag move the one thing the user said not
    /// to move.
    #[wasm_bindgen(js_name = selectAll)]
    pub fn select_all(&mut self) {
        self.selection = self
            .doc
            .elements()
            .iter()
            .filter(|e| !e.is_deleted && e.locked != Some(true))
            .map(|e| e.id.clone())
            .collect();
    }

    #[wasm_bindgen(js_name = clearSelection)]
    pub fn clear_selection(&mut self) {
        self.selection.clear();
    }

    /// The resize/rotate handle under a point, as a `Handle` discriminant, or
    /// -1. An integer, not a string: this runs on every hover.
    /// `scene_per_px` is the reciprocal of the zoom. The rotate handle sits a
    /// fixed distance above the box *on screen*, so it needs to know how big a
    /// screen pixel currently is in scene units — otherwise the handle is
    /// unreachable zoomed out and miles away zoomed in.
    #[wasm_bindgen(js_name = handleAt)]
    pub fn handle_at(&self, x: f64, y: f64, radius: f64, scene_per_px: f64) -> i32 {
        let Some(f) = ops::selection_frame(&self.doc, &self.selection) else { return -1 };
        geometry::handle_at(&f.bounds, f.angle, x, y, radius, scene_per_px)
            .map(|h| h.as_u32() as i32)
            .unwrap_or(-1)
    }

    /// The nine handle positions as `[x0, y0, x1, y1, …]` in `Handle` order,
    /// for the painter.
    #[wasm_bindgen(js_name = handlePoints)]
    pub fn handle_points(&self, scene_per_px: f64) -> Option<Vec<f64>> {
        let f = ops::selection_frame(&self.doc, &self.selection)?;
        let pts = geometry::handle_points(&f.bounds, f.angle, scene_per_px);
        Some(pts.iter().flat_map(|(x, y)| [*x, *y]).collect())
    }

    /// The selected element's own points as `[x0, y0, x1, y1, …]`, or
    /// `undefined` when the selection is not exactly one element with a point
    /// list.
    ///
    /// These are the grips an arrow's endpoints are dragged by — the gesture the
    /// nine box handles cannot express, because an endpoint is not on the box.
    /// A caller that finds a point handle here must prefer it over
    /// `handleAt`: on a diagonal arrow the endpoints land on the box's corner
    /// handles, and the endpoint has to win or it is ungrabbable.
    #[wasm_bindgen(js_name = pointHandles)]
    pub fn point_handles(&self) -> Option<Vec<f64>> {
        let e = self.sole_selection()?;
        let pts = geometry::point_handles(e);
        (!pts.is_empty()).then(|| pts.iter().flat_map(|(x, y)| [*x, *y]).collect())
    }

    /// The midpoint of each segment of the selected element, same shape as
    /// `pointHandles`. Excalidraw shows these as the "add a point here" targets.
    #[wasm_bindgen(js_name = midpointHandles)]
    pub fn midpoint_handles(&self) -> Option<Vec<f64>> {
        let e = self.sole_selection()?;
        let pts = geometry::segment_midpoints(e);
        (!pts.is_empty()).then(|| pts.iter().flat_map(|(x, y)| [*x, *y]).collect())
    }

    /// The index of the point within `radius` of `(x, y)`, or -1. `radius` is in
    /// scene units, like `handleAt`'s.
    #[wasm_bindgen(js_name = pointHandleAt)]
    pub fn point_handle_at(&self, x: f64, y: f64, radius: f64) -> i32 {
        self.sole_selection()
            .and_then(|e| geometry::point_handle_at(e, x, y, radius))
            .map(|i| i as i32)
            .unwrap_or(-1)
    }

    /// The index of the *segment* whose midpoint is within `radius` of
    /// `(x, y)`, or -1. Segment `i` runs from point `i` to point `i + 1`.
    #[wasm_bindgen(js_name = midpointHandleAt)]
    pub fn midpoint_handle_at(&self, x: f64, y: f64, radius: f64) -> i32 {
        self.sole_selection()
            .and_then(|e| geometry::segment_midpoint_at(e, x, y, radius))
            .map(|i| i as i32)
            .unwrap_or(-1)
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

    /// Turn the selection so its rotate handle follows `(px, py)`.
    ///
    /// The first call under a given `key` captures the frame the gesture starts
    /// in and every later call is a delta against it — see
    /// [`ops::RotateAnchor`]. An empty key is a one-shot rotation and captures
    /// afresh each time.
    #[wasm_bindgen(js_name = rotateTo)]
    pub fn rotate_to(&mut self, px: f64, py: f64, snap: f64, key: &str) -> Change {
        let fresh = match &self.rotate {
            Some((k, _)) => key.is_empty() || k != key,
            None => true,
        };
        if fresh {
            self.rotate = ops::RotateAnchor::new(&self.doc, &self.selection)
                .map(|a| (key.to_string(), a));
        }
        let Some((_, anchor)) = self.rotate.take() else { return self.doc.no_change().into() };
        let change = ops::rotate(&mut self.doc, &anchor, px, py, snap, some(key));
        self.rotate = Some((key.to_string(), anchor));
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
        //
        // An *arrow*, not any linear element: Excalidraw's `isBindingElement`
        // admits arrows only, so binding a `line` writes a `startBinding`
        // excalidraw.com will not act on — a diagram that re-routes here and is
        // inert there.
        if e.kind.is_binding_element() {
            let (a, _) = ops::rebind_end(&mut self.doc, &id, false);
            let (b, _) = ops::rebind_end(&mut self.doc, &id, true);
            return merge(a, b).into();
        }

        // A box dragged up and to the left has negative extents, which is
        // legal in the format but makes every later comparison work harder.
        // Point-list geometry is exempt: its extent is derived from the points,
        // so rewriting x/y here would move the origin out from under them.
        let (x, y, w, h) = (e.x, e.y, e.width, e.height);
        if !e.kind.has_points() && (w < 0.0 || h < 0.0) {
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
    ///
    /// `at` is the z-order index to land on; leave it off (or pass a negative
    /// number) for "on top", which is where a drawing gesture puts a new shape.
    /// Naming one is what "paste in place" and "paste behind" need — the
    /// fractional index is keyed from where the element actually lands, so an
    /// insert lower down is correctly ordered for excalidraw.com too.
    pub fn insert(&mut self, element: JsValue, at: Option<i32>) -> Result<Change, JsValue> {
        let mut value: Map<String, Value> =
            from_js_map(&element).ok_or_else(|| JsValue::from_str("insert expects an object"))?;
        // The caller may not name an id or a seed, and must not be trusted
        // with either: identity is the Doc's to hand out.
        let (id, seed) = self.doc.fresh_identity();
        value.insert("id".into(), Value::String(id.clone()));
        value.insert("seed".into(), serde_json::json!(seed));
        let el: xd_core::scene::Element = serde_json::from_value(Value::Object(value))
            .map_err(|e| JsValue::from_str(&format!("that isn't an element: {e}")))?;
        let at = at.filter(|i| *i >= 0).map(|i| i as usize);
        let change = self.doc.apply(Command::Insert { at, element: Box::new(el) });
        self.selection = vec![id];
        Ok(change.into())
    }

    /// Patch one element by id — the escape hatch the text overlay uses when
    /// it has measured a label and knows its real width.
    ///
    /// `key` is the coalesce key, as on `dragBy`: leave it off and the patch is
    /// its own undo entry, pass one and every patch under it folds into a single
    /// entry. That is what a sweep needs — an eraser crossing forty shapes is
    /// one press of ⌘Z, not forty — and there is no other way to express it,
    /// since each element needs its own `Patch`.
    pub fn patch(&mut self, id: &str, fields: JsValue, key: Option<String>) -> Change {
        let Some(fields) = from_js_map(&fields) else { return self.doc.no_change().into() };
        let cmd = Command::Patch { id: id.to_string(), fields };
        match key.as_deref().filter(|k| !k.is_empty()) {
            Some(key) => self.doc.apply_keyed(cmd, key, self.doc.now()).into(),
            None => self.doc.apply(cmd).into(),
        }
    }

    /// Merge keys into the scene's `appState` — the canvas background, the
    /// theme, the grid size — as one undoable act.
    ///
    /// A shallow merge, and a `null` value removes a key. `appState` is held as
    /// raw JSON on purpose (nothing in the core decides anything about it), and
    /// this keeps that: keys it has never heard of pass straight through and
    /// keys it is not given are left exactly as they were.
    #[wasm_bindgen(js_name = setAppState)]
    pub fn set_app_state(&mut self, fields: JsValue) -> Change {
        match from_js_map(&fields) {
            Some(fields) => self.doc.apply(Command::SetAppState { fields }).into(),
            None => self.doc.no_change().into(),
        }
    }

    #[wasm_bindgen(js_name = setStyle)]
    pub fn set_style(&mut self, style: JsValue) -> Change {
        match from_js_map(&style) {
            Some(style) => ops::set_style(&mut self.doc, &self.selection, &style, false).into(),
            None => self.doc.no_change().into(),
        }
    }

    /// A style patch that also re-rolls the seed of everything it touches, as
    /// one undo entry — what a sloppiness change is.
    ///
    /// Excalidraw draws a *different sketch* on every sloppiness click. Scaling
    /// the same random draws by a larger roughness instead reads as the stroke
    /// getting bolder rather than as a different hand, which is the reported
    /// "smooth to bold". The two writes have to be one entry: undo landing
    /// between them would leave the new roughness on the old seed.
    #[wasm_bindgen(js_name = setStyleResketched)]
    pub fn set_style_resketched(&mut self, style: JsValue) -> Change {
        match from_js_map(&style) {
            Some(style) => ops::set_style(&mut self.doc, &self.selection, &style, true).into(),
            None => self.doc.no_change().into(),
        }
    }

    /// Re-roll the selection's seeds and change nothing else — a fresh sketch
    /// of the same shapes.
    pub fn reseed(&mut self) -> Change {
        ops::reseed(&mut self.doc, &self.selection, None).into()
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

    /// Line the selection up on one edge of its own box: `"left"`, `"centerH"`,
    /// `"right"`, `"top"`, `"centerV"`, `"bottom"`. Needs two elements.
    ///
    /// Strings here, rather than the integer `reorder` takes, because these
    /// arrive from a panel button whose own vocabulary is already these words —
    /// an integer would put a translation table between the click and the model
    /// for no gain on a path that runs once per press.
    pub fn align(&mut self, edge: &str) -> Change {
        let Some(edge) = ops::Edge::parse(edge) else { return self.doc.no_change().into() };
        let ids = self.selection.clone();
        let key = self.verb_key();
        let change = ops::align(&mut self.doc, &ids, edge, Some(&key));
        self.with_reflow(change, &key)
    }

    /// Space the selection evenly, `"horizontal"` or `"vertical"`, leaving the
    /// outermost two where they are. Needs three elements.
    pub fn distribute(&mut self, axis: &str) -> Change {
        let Some(axis) = ops::Axis::parse(axis) else { return self.doc.no_change().into() };
        let ids = self.selection.clone();
        let key = self.verb_key();
        let change = ops::distribute(&mut self.doc, &ids, axis, Some(&key));
        self.with_reflow(change, &key)
    }

    /// Mirror the selection about the centre line of its own box,
    /// `"horizontal"` or `"vertical"`. One element flips in place.
    pub fn flip(&mut self, axis: &str) -> Change {
        let Some(axis) = ops::Axis::parse(axis) else { return self.doc.no_change().into() };
        let ids = self.selection.clone();
        let key = self.verb_key();
        let change = ops::flip(&mut self.doc, &ids, axis, Some(&key));
        self.with_reflow(change, &key)
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

    /// Drag one point of the selected linear element to `(x, y)`, keyed so the
    /// whole drag is one undo entry.
    ///
    /// Acts on `selection[0]`: the per-point handles are a single-element
    /// affordance (`pointHandles` returns nothing for a multi-selection), so the
    /// element to edit is the selected one and there is no id to pass.
    ///
    /// Dragging a bound endpoint away from its shape unbinds it, which is what
    /// makes the endpoint movable at all — see [`ops::move_point`]. Call
    /// `rebindEnd` on pointer-up to attach it to whatever it was dropped on.
    #[wasm_bindgen(js_name = movePoint)]
    pub fn move_point(&mut self, index: usize, x: f64, y: f64, key: &str) -> Change {
        let Some(id) = self.selection.first().cloned() else {
            return self.doc.no_change().into();
        };
        let change = ops::move_point(&mut self.doc, &id, index, x, y, some(key));
        self.with_reflow(change, key)
    }

    /// Add a point to the selected linear element, in the middle of segment
    /// `index` — clicking a midpoint handle.
    ///
    /// `index` is a **segment** index, exactly as `midpointHandleAt` returns it:
    /// segment `i` runs from point `i` to point `i + 1`, and the new point lands
    /// between them. Acts on `selection[0]`, for the same reason `movePoint`
    /// does.
    ///
    /// `key` is optional and folds the insert into a surrounding gesture's undo
    /// entry — pass the drag's key when a click-and-drag adds a point and then
    /// moves it, so the two are one press of ⌘Z.
    #[wasm_bindgen(js_name = insertPoint)]
    pub fn insert_point(&mut self, index: usize, x: f64, y: f64, key: Option<String>) -> Change {
        let Some(id) = self.selection.first().cloned() else {
            return self.doc.no_change().into();
        };
        let key = key.unwrap_or_default();
        let change = ops::insert_point(&mut self.doc, &id, index, x, y, some(&key));
        self.with_reflow(change, &key)
    }

    // --- container-bound labels ---------------------------------------------

    /// Put a text element inside a container as its label, maintaining both
    /// halves: `containerId` on the text and a `{id, type:"text"}` entry in the
    /// container's `boundElements`.
    ///
    /// Separate from `bind`, which is arrow-endpoint-shaped. Refused unless the
    /// text really is a text and the container is one of Excalidraw's
    /// text-bindable shapes — rectangle, diamond, ellipse or arrow.
    #[wasm_bindgen(js_name = bindLabel)]
    pub fn bind_label(&mut self, container: &str, text: &str) -> Change {
        self.doc
            .apply(Command::BindLabel {
                container: container.to_string(),
                text: text.to_string(),
            })
            .into()
    }

    /// Take a label out of its container, both halves. The text stays in the
    /// scene, free-floating.
    #[wasm_bindgen(js_name = unbindLabel)]
    pub fn unbind_label(&mut self, text: &str) -> Change {
        self.doc.apply(Command::UnbindLabel { text: text.to_string() }).into()
    }

    /// The index of the label inside this element, or -1 — how the editor finds
    /// an existing label to reopen instead of stacking a second one on top.
    #[wasm_bindgen(js_name = labelOf)]
    pub fn label_of(&self, index: usize) -> i32 {
        self.doc
            .elements()
            .get(index)
            .and_then(|e| self.doc.bound_text_of(&e.id))
            .and_then(|id| self.doc.index_of(id))
            .map(|i| i as i32)
            .unwrap_or(-1)
    }

    /// The width a label bound to this container has to wrap inside.
    ///
    /// The split this export exists for: only JS can measure a string, and only
    /// the model knows the container's per-kind budget. Rust says how much room
    /// there is; JS wraps to it and patches the label's `text`, `width` and
    /// `height`.
    #[wasm_bindgen(js_name = labelBudget)]
    pub fn label_budget(&self, index: usize) -> f64 {
        self.doc.elements().get(index).map(geometry::label_budget).unwrap_or(0.0)
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
    /// Also puts the label of anything that moved back inside it, for the same
    /// reason and in the same entry: a container dragged out from under its
    /// label has visibly come apart.
    fn with_reflow(&mut self, change: xd_core::doc::Change, key: &str) -> Change {
        let ids = self.selection.clone();
        let labels = ops::reflow_labels(&mut self.doc, &ids, some(key));
        let extra = ops::reflow_bindings(&mut self.doc, &ids, some(key));
        merge(merge(change, labels), extra).into()
    }

    /// A coalesce key unique to this call.
    ///
    /// A verb that writes more than once — the move, plus the binding and label
    /// reflow it forces — has to fold into a single undo entry, and folding is
    /// keyed. The revision makes the key: it is the same for every write inside
    /// one call, because the first of them is what advances it, and different for
    /// the next press of the same button.
    fn verb_key(&self) -> String {
        format!("verb:{}", self.doc.revision())
    }

    /// The one selected element, or `None` for an empty or multiple selection —
    /// the per-point handles are a single-element affordance.
    fn sole_selection(&self) -> Option<&xd_core::scene::Element> {
        match self.selection.as_slice() {
            [id] => self.doc.index_of(id).map(|i| &self.doc.elements()[i]),
            _ => None,
        }
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
