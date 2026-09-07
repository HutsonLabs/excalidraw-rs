# The `xd-core` API contract

Pinned up front so the pieces of this build can be written in parallel without
agreeing about anything twice. **Do not change a signature listed here without
saying so** — three other modules and the WASM boundary are written against it.

`crates/xd-core/src/scene.rs` (`Element`, `Scene`, `ElementKind`, `Binding`,
`BoundElement`, `Roundness`, `Point`) and the `Bounds` primitives at the top of
`geometry.rs` are **already written and are the fixed part**. Extend them
additively if a real file needs a field; never rename or retype what is there.

## `geometry.rs` — Phase 2

```rust
pub fn element_bounds(e: &Element) -> Option<Bounds>;          // unrotated; port of JS elementBounds
pub fn element_bounds_rotated(e: &Element) -> Option<Bounds>;  // AABB of the rotated shape
pub fn scene_bounds(elements: &[Element]) -> Option<Bounds>;   // port of JS sceneBounds

pub struct FitTransform { pub scale: f64, pub offset_x: f64, pub offset_y: f64 }
pub fn fit_transform(bounds: Option<&Bounds>, vw: f64, vh: f64, padding: f64) -> FitTransform;

pub fn corner_radius(e: &Element) -> f64;                      // port of JS cornerRadius

/// Scene point -> element-local point, undoing the element's rotation.
pub fn to_local(e: &Element, x: f64, y: f64) -> (f64, f64);

/// Is this point on/in the element? `threshold` is the stroke-proximity slop
/// in scene units (the caller passes ~10 / zoom). Filled shapes hit on their
/// interior; transparent ones only near their outline — that is Excalidraw's
/// own rule and users rely on clicking "through" an unfilled rectangle.
pub fn hit_test(e: &Element, x: f64, y: f64, threshold: f64) -> bool;

/// Topmost element under the point (last in z-order wins), by index.
pub fn hit_test_scene(elements: &[Element], x: f64, y: f64, threshold: f64) -> Option<usize>;

/// Indices intersecting a marquee. `contain = true` requires full containment.
pub fn marquee_hits(elements: &[Element], area: &Bounds, contain: bool) -> Vec<usize>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Handle { Nw, N, Ne, E, Se, S, Sw, W, Rotate }
impl Handle { pub fn as_u32(self) -> u32; pub fn from_u32(v: u32) -> Option<Handle>; }

/// The nine handle positions for a selection box drawn at `angle`, in scene
/// coordinates, in `Handle` order.
pub fn handle_points(b: &Bounds, angle: f64) -> [(f64, f64); 9];
pub fn handle_at(b: &Bounds, angle: f64, x: f64, y: f64, radius: f64) -> Option<Handle>;

/// The new box when `handle` is dragged to `(px, py)`. `lock_aspect` keeps the
/// ratio; `from_center` resizes about the centre (alt-drag).
pub fn resize_bounds(b: &Bounds, angle: f64, handle: Handle, px: f64, py: f64,
                     lock_aspect: bool, from_center: bool) -> Bounds;

/// The angle a rotation handle dragged to `(px, py)` implies, snapped to
/// `snap` radians when `snap > 0`.
pub fn rotation_angle(b: &Bounds, px: f64, py: f64, snap: f64) -> f64;
```

Transforms return values; they never mutate an `Element`. `doc.rs` turns the
result into a `Command::Patch`, which is what makes every edit undoable and
every version bump automatic.

## `command.rs` / `doc.rs` — Phase 3

```rust
pub enum Reorder { Front, Back, Forward, Backward }
pub enum End { Start, End }

pub enum Command {
    Insert { at: Option<usize>, element: Box<Element> },
    Delete { ids: Vec<String> },
    /// camelCase JSON keys applied over the element, exactly the shape the
    /// file uses. `null` removes a key.
    Patch { id: String, fields: serde_json::Map<String, Value> },
    Reorder { ids: Vec<String>, how: Reorder },
    Group { ids: Vec<String> },
    Ungroup { ids: Vec<String> },
    Bind { arrow: String, end: End, binding: Option<Binding> },
    /// Several of the above as one undo entry (a drag of a multi-selection).
    Batch(Vec<Command>),
}

pub struct Change {
    pub revision: u64,
    pub dirty: Vec<u32>,        // element indices to repaint
    pub bbox: Option<Bounds>,   // union of what moved, before and after
    pub structural: bool,       // insert/delete/reorder: indices shifted, repaint all
}

impl Doc {
    pub fn blank() -> Doc;
    pub fn from_json(text: &str) -> Result<Doc, String>;   // error is a sentence for the pane
    pub fn to_json(&self) -> String;                        // 2-space, as excalidraw.com writes
    pub fn scene(&self) -> &Scene;
    pub fn elements(&self) -> &[Element];
    pub fn index_of(&self, id: &str) -> Option<usize>;
    pub fn revision(&self) -> u64;

    pub fn apply(&mut self, cmd: Command) -> Change;
    /// Same, but folded into the previous entry when the key matches and it
    /// landed within the coalesce window. One drag is one undo entry.
    pub fn apply_keyed(&mut self, cmd: Command, key: &str, now_ms: i64) -> Change;

    pub fn can_undo(&self) -> bool;
    pub fn can_redo(&self) -> bool;
    pub fn undo(&mut self) -> Option<Change>;
    pub fn redo(&mut self) -> Option<Change>;

    /// A fresh element: new id, new seed, version 1, a fresh nonce, `updated`
    /// set. The *only* place a seed is ever written.
    pub fn new_element(&mut self, kind: ElementKind, b: &Bounds) -> Element;
    pub fn set_now(&mut self, now_ms: i64);   // the host supplies the clock; no I/O in here
}
```

**Every mutation goes through `apply`**, and `apply` does the version
bookkeeping itself: `version += 1`, a fresh `version_nonce`, `updated = now`.
No caller can forget, because no caller may write a field directly.

`seed` is never rewritten by a patch. If a `Patch` carries `seed`, drop it.

**Acceptance (fuzz):** a random valid command sequence, then undo everything —
the scene must equal the original including every `rest` map.

## The clock

There is no `SystemTime` in this crate: it compiles to wasm and must stay
deterministic under test. The host calls `set_now(ms)` before applying; the
default is 0.
