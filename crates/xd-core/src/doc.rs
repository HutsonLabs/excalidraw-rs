//! `Doc` — a scene, an undo stack, and the rule that nothing else may touch
//! either one.
//!
//! Everything a user does to a drawing arrives here as a [`Command`], and
//! `Doc` is the only thing in the crate that owns a `&mut Element`. Two
//! properties fall out of that, and both are the point:
//!
//! - **Bookkeeping cannot be forgotten.** `apply` bumps `version`, draws a
//!   fresh `versionNonce` and stamps `updated` for every element a command
//!   touched. Excalidraw's own reconciliation reads those three fields; a
//!   single edit path that skips them is a collaboration bug that will not
//!   surface for a year.
//! - **History cannot be bypassed.** Because every mutation goes through one
//!   function, that function can record the exact inverse of every mutation.
//!   There is no "and also we set this flag over here" to forget.
//!
//! `seed` is the field this module is most careful about, and it is careful by
//! *refusing*: a `Patch` carrying a `seed` key has it dropped on the floor.
//! Rough.js is deterministic in the seed, so rewriting one re-scrambles the
//! hand-drawn strokes — the whole diagram twitches after every keystroke.
//! [`Doc::new_element`] is the only place in the crate that ever writes one.
//!
//! ## Undo is a restore, not an inverse edit
//!
//! A decision worth stating because the alternative is defensible and wrong
//! for us: undo puts the previous *bytes* back, including `version`,
//! `versionNonce` and `updated`. It does not bump the version again as though
//! it were a fresh edit.
//!
//! The reason is the acceptance test, and the acceptance test is the reason
//! because it is what a user means. "Undo everything" must leave the file
//! byte-identical to the one that was opened — otherwise every open/undo cycle
//! rewrites bookkeeping fields, an unedited file comes back dirty, and
//! `worthSaving` (PLAN.md, Phase 5) starts writing diffs nobody asked for. The
//! counter-argument — that a collaborator's version counter must only ever go
//! up — is real, and is the thing to revisit if Decision 6 (collaboration)
//! ever opens. It does not apply to a single-writer document.
//!
//! ## The clock and the random stream
//!
//! No `SystemTime` and no entropy: this compiles to wasm, where both are host
//! imports, and it has to stay deterministic under test. The host calls
//! [`Doc::set_now`] before applying and [`Doc::set_seed`] once after opening a
//! document. Defaults are 0 and a hash of the file's text respectively, so a
//! `Doc` is reproducible from its input alone — which is what makes the fuzz
//! test in `tests/history.rs` shrinkable.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::command::{json_num, Command, End, Reorder};
use crate::geometry::{element_bounds_rotated, Bounds};
use crate::ids::Rng;
use crate::scene::{Binding, BoundElement, Element, ElementKind, Roundness, Scene};

/// How long after an edit a same-keyed edit still counts as part of it.
///
/// A drag delivers pointer events at 60–120 Hz. Recording one undo entry each
/// would mean four hundred presses of ⌘Z to get back to where the shape
/// started, which is not undo, it is punishment. So commands carry a coalesce
/// key — `"drag:<id>"`, `"resize:se"` — and consecutive edits under the same
/// key inside this window fold into one entry that keeps the *original*
/// before-state and the *newest* after-state.
///
/// 800 ms is not arbitrary: it is the idle debounce `bpmnView.js` autosaves
/// on, and reusing the number means a pause long enough to trigger a save is
/// also a pause long enough to end an undo step. The two feel like one app
/// because they are timed like one app.
pub const COALESCE_WINDOW_MS: i64 = 800;

/// What a repaint needs to know, and nothing more.
///
/// Phase 4's rule is that the whole scene never crosses the WASM boundary per
/// frame. `Change` is the shape that makes that possible: a revision to
/// memoize against, the indices that actually moved, and one box to clip to.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// Bumped once per applied command, undo or redo. JS memoizes element
    /// paint data on `(index, version)`; `revision` is the coarse "did
    /// anything at all happen" signal above that.
    pub revision: u64,
    /// Element indices to repaint. Meaningless when `structural` is set,
    /// because the indices have moved under it.
    pub dirty: Vec<u32>,
    /// The union of every touched element's bounds, before *and* after — a
    /// move has to erase where the thing was as well as draw where it went.
    pub bbox: Option<Bounds>,
    /// An insert, delete or reorder happened, so every index after the change
    /// point shifted and the caller should repaint the lot.
    pub structural: bool,
}

/// A key a command wrote, and what it wrote there.
///
/// `None` is "no such key" — on the way in it means *remove this key*, and in
/// an undo record it means *the key did not exist before, so undo must remove
/// it again*. Encoding absence as `None` rather than as `Value::Null` is what
/// lets a patch that adds a brand-new field to `Element::rest` be undone
/// cleanly instead of leaving a null behind.
type KeyEdit = (String, Option<Value>);

/// One reversible primitive. An undo entry is a list of these, replayed
/// backwards to undo and forwards to redo.
///
/// Everything a command does decomposes into these four, which is why undo
/// needs no knowledge of commands at all — `Bind` maintaining both sides of a
/// binding is just three `Patched` records, and it inverts because they do.
#[derive(Debug, Clone)]
enum Edit {
    /// Keys written on one element, with what was there before. Both
    /// directions are stored because a coalesced drag's newest after-state is
    /// not recomputable from the before-state.
    Patched {
        id: String,
        prev: Vec<KeyEdit>,
        next: Vec<KeyEdit>,
        /// The order `Element::rest` was in before the write, recorded only
        /// when the write removed a key.
        ///
        /// Re-adding a key puts it on the end of the map, so without this an
        /// unmodelled field that was deleted and then undone comes back in a
        /// different place in the file. Nothing about the *drawing* changes,
        /// but the save is a diff the user has to read and a merge conflict
        /// they have to resolve — the thing `format.rs` refuses to do on the
        /// way out, refused here on the way back.
        rest_order: Option<Vec<String>>,
    },
    /// An element added at a z-order index.
    Inserted { index: usize, element: Box<Element> },
    /// An element taken out, kept whole so undo can put back exactly what
    /// left — including the bindings that were cleared off it on the way out.
    Removed { index: usize, element: Box<Element> },
    /// A z-order change, as the full id order on each side. Storing the whole
    /// order rather than a move-list costs a few hundred bytes and removes an
    /// entire category of off-by-one.
    Reordered { prev: Vec<String>, next: Vec<String> },
}

/// One press of undo.
#[derive(Debug, Clone)]
struct Entry {
    edits: Vec<Edit>,
}

/// The open coalescing window: what key we are folding under, and when the
/// last edit under it landed.
#[derive(Debug, Clone)]
struct Coalesce {
    key: String,
    at: i64,
}

/// A scene plus its history.
#[derive(Debug, Clone)]
pub struct Doc {
    scene: Scene,
    rng: Rng,
    now: i64,
    revision: u64,
    undo: Vec<Entry>,
    redo: Vec<Entry>,
    /// `None` whenever the next edit must start a fresh entry — after an
    /// unkeyed `apply`, and after any undo or redo. Without this, a keyed
    /// edit arriving straight after an undo would fold itself into the entry
    /// the undo just moved onto the redo stack.
    coalesce: Option<Coalesce>,
}

// ---------------------------------------------------------------------------
// Element <-> JSON
//
// Patches are expressed in the file's own vocabulary — camelCase keys, exactly
// what `.excalidraw` holds — and applied by round-tripping the element through
// its JSON form. That is not laziness. It means a key this crate has never
// heard of is patchable *today*: `Element::rest` catches it on the way back in
// and it round-trips like any other unknown field. A `match` over known field
// names would have to grow every time Excalidraw's schema drifts, and would
// silently drop everything it had not grown for.
// ---------------------------------------------------------------------------

/// Write `changes` into `e`, returning the previous value of every key
/// touched. `None` on the way out means the resulting object was not a legal
/// element (a patch removed `id`, say) — in which case `e` is left untouched
/// and the caller drops the edit rather than committing a corrupt element.
fn write_keys(e: &mut Element, changes: &[KeyEdit]) -> Option<Vec<KeyEdit>> {
    let mut map = match serde_json::to_value(&*e) {
        Ok(Value::Object(m)) => m,
        _ => return None,
    };
    let mut prev = Vec::with_capacity(changes.len());
    for (key, value) in changes {
        prev.push((key.clone(), map.get(key).cloned()));
        match value {
            Some(v) => {
                map.insert(key.clone(), v.clone());
            }
            None => {
                // `shift_remove`, not `remove`: with `preserve_order` on —
                // and it is on, because `rest` has to come back out in the
                // order it went in — `Map::remove` is a *swap* remove that
                // drops the last key into the hole. Clearing one field would
                // then silently reshuffle an element's unknown fields, and
                // the file would come back with its keys in a different
                // order than it went in for no reason a reader could see.
                map.shift_remove(key);
            }
        }
    }
    let rebuilt: Element = serde_json::from_value(Value::Object(map)).ok()?;
    *e = rebuilt;
    Some(prev)
}

/// A patch's JSON object as a key-edit list, with the keys no patch may carry
/// filtered out. See [`Command::Patch`] for why `seed` and `id` are refused.
fn sanitise(fields: &Map<String, Value>) -> Vec<KeyEdit> {
    fields
        .iter()
        .filter(|(k, _)| k.as_str() != "seed" && k.as_str() != "id")
        .map(|(k, v)| {
            let value = if v.is_null() { None } else { Some(v.clone()) };
            (k.clone(), value)
        })
        .collect()
}

/// Put `rest` back in the order it was in, for the keys that are still there.
/// Anything the recorded order does not name keeps its relative position on
/// the end. See [`Edit::Patched::rest_order`].
fn restore_rest_order(e: &mut Element, order: &[String]) {
    if e.rest.len() < 2 {
        return;
    }
    let mut out = Map::with_capacity(e.rest.len());
    for key in order {
        if let Some(v) = e.rest.get(key) {
            out.insert(key.clone(), v.clone());
        }
    }
    for (key, v) in e.rest.iter() {
        if !out.contains_key(key) {
            out.insert(key.clone(), v.clone());
        }
    }
    e.rest = out;
}

/// A JSON array of strings, without going through `serde_json::to_value` and
/// its unreachable error case.
fn json_strings(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

/// What accumulates while a command runs: the repaint rectangle, the elements
/// that need redrawing, and whether indices moved.
#[derive(Default)]
struct Acc {
    bbox: Option<Bounds>,
    dirty: Vec<String>,
    structural: bool,
}

impl Acc {
    /// Fold an element's current bounds into the repaint box. Called once
    /// before a mutation and once after, which is how a move ends up erasing
    /// its old position as well as painting its new one.
    fn touch(&mut self, e: &Element) {
        if let Some(b) = element_bounds_rotated(e) {
            self.bbox = Some(match self.bbox {
                Some(cur) => cur.union(&b),
                None => b,
            });
        }
        if !self.dirty.iter().any(|d| d == &e.id) {
            self.dirty.push(e.id.clone());
        }
    }
}

impl Doc {
    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// An empty document.
    pub fn blank() -> Doc {
        Doc::from_scene(crate::format::blank_scene(), 0)
    }

    /// Parse a `.excalidraw` file. The error is a sentence, not a debug dump:
    /// it goes straight into the preview pane where a human reads it.
    pub fn from_json(text: &str) -> Result<Doc, String> {
        let scene = crate::format::parse(text)?;
        // Seeding the id stream from the file's own text gives two different
        // documents two different streams — so ids minted while editing one
        // never collide with ids minted in another — while staying a pure
        // function of the input, which keeps tests reproducible. A host with
        // real entropy should still call `set_seed`.
        Ok(Doc::from_scene(scene, seed_from(text)))
    }

    fn from_scene(scene: Scene, seed: u64) -> Doc {
        Doc {
            scene,
            rng: Rng::new(seed),
            now: 0,
            revision: 0,
            undo: Vec::new(),
            redo: Vec::new(),
            coalesce: None,
        }
    }

    /// Serialize, 2-space indented, the way excalidraw.com writes it.
    pub fn to_json(&self) -> String {
        crate::format::serialize(&self.scene)
    }

    // -----------------------------------------------------------------------
    // Reading
    // -----------------------------------------------------------------------

    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    pub fn elements(&self) -> &[Element] {
        &self.scene.elements
    }

    /// A linear scan, deliberately. An index map would have to be invalidated
    /// on every insert, delete and reorder, and getting *that* wrong is a
    /// silent corruption rather than a slow frame. If a profile ever shows
    /// this, the fix is a map rebuilt in one place — the three functions that
    /// change the element vector's shape.
    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.scene.elements.iter().position(|e| e.id == id)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// The host supplies the clock; there is no `SystemTime` in this crate.
    pub fn set_now(&mut self, now_ms: i64) {
        self.now = now_ms;
    }

    /// The clock the host last set. `ops.rs` reads it to key a gesture
    /// without having to thread the timestamp through every verb.
    pub fn now(&self) -> i64 {
        self.now
    }

    /// A `Change` that says nothing happened — for the operations that decide,
    /// after looking, that there is nothing to do. Returning this rather than
    /// applying an empty command keeps `revision` still, which is what JS
    /// memoizes against.
    pub fn no_change(&self) -> Change {
        Change {
            revision: self.revision,
            dirty: Vec::new(),
            bbox: None,
            structural: false,
        }
    }

    /// A new element identity: a fresh id and a fresh seed.
    ///
    /// **The only place in the crate that mints a seed.** Rough.js is
    /// deterministic in it — that is what makes a diagram render identically
    /// on every open and identically to Excalidraw proper — so a seed may be
    /// created for something that does not have one yet and may never, ever
    /// be rewritten for something that does. [`Doc::new_element`] and
    /// duplication both come through here; nothing else has cause to.
    pub fn fresh_identity(&mut self) -> (String, i64) {
        (self.rng.next_id(), self.rng.next_nonce())
    }

    /// The host supplies the entropy, for the same reason it supplies the
    /// clock. Call once after opening a document; ids minted before this are
    /// still perfectly valid, they are just predictable.
    pub fn set_seed(&mut self, seed: u64) {
        self.rng = Rng::new(seed);
    }

    // -----------------------------------------------------------------------
    // Applying
    // -----------------------------------------------------------------------

    /// Apply a command as its own undo entry.
    pub fn apply(&mut self, cmd: Command) -> Change {
        let (edits, acc) = self.execute(&cmd);
        self.commit(edits, None, acc)
    }

    /// Apply a command, folding it into the previous undo entry when `key`
    /// matches the previous keyed apply and it landed within
    /// [`COALESCE_WINDOW_MS`]. One drag is one undo entry.
    ///
    /// An empty key never coalesces — it is the "this is not part of a
    /// gesture" spelling, and is clearer at a call site than reaching for
    /// `apply` half the time.
    pub fn apply_keyed(&mut self, cmd: Command, key: &str, now_ms: i64) -> Change {
        self.now = now_ms;
        let (edits, acc) = self.execute(&cmd);
        let fold = match &self.coalesce {
            Some(c) => !key.is_empty() && c.key == key && now_ms - c.at <= COALESCE_WINDOW_MS,
            None => false,
        };
        let coalesce = if key.is_empty() {
            None
        } else {
            Some(Coalesce {
                key: key.to_string(),
                at: now_ms,
            })
        };
        self.commit_folding(edits, coalesce, acc, fold)
    }

    fn commit(&mut self, edits: Vec<Edit>, coalesce: Option<Coalesce>, acc: Acc) -> Change {
        self.commit_folding(edits, coalesce, acc, false)
    }

    fn commit_folding(
        &mut self,
        edits: Vec<Edit>,
        coalesce: Option<Coalesce>,
        acc: Acc,
        fold: bool,
    ) -> Change {
        if edits.is_empty() {
            // A command that changed nothing is not history and is not a
            // repaint. Leaving `revision` alone keeps JS's memoization warm.
            return self.change(acc);
        }
        // Any new edit forfeits the redo branch. This is the standard linear
        // history and it is what users expect: the future you abandoned is
        // gone the moment you do something else.
        self.redo.clear();
        match self.undo.last_mut() {
            Some(entry) if fold => fold_edits(&mut entry.edits, edits),
            _ => self.undo.push(Entry { edits }),
        }
        self.coalesce = coalesce;
        self.revision += 1;
        self.change(acc)
    }

    fn change(&self, acc: Acc) -> Change {
        let dirty = acc
            .dirty
            .iter()
            .filter_map(|id| self.index_of(id).map(|i| i as u32))
            .collect();
        Change {
            revision: self.revision,
            dirty,
            bbox: acc.bbox,
            structural: acc.structural,
        }
    }

    // -----------------------------------------------------------------------
    // Undo / redo
    // -----------------------------------------------------------------------

    pub fn undo(&mut self) -> Option<Change> {
        let entry = self.undo.pop()?;
        let mut acc = Acc::default();
        for edit in entry.edits.iter().rev() {
            self.play(edit, false, &mut acc);
        }
        self.redo.push(entry);
        self.coalesce = None;
        self.revision += 1;
        Some(self.change(acc))
    }

    pub fn redo(&mut self) -> Option<Change> {
        let entry = self.redo.pop()?;
        let mut acc = Acc::default();
        for edit in &entry.edits {
            self.play(edit, true, &mut acc);
        }
        self.undo.push(entry);
        self.coalesce = None;
        self.revision += 1;
        Some(self.change(acc))
    }

    /// Replay one recorded primitive in either direction.
    ///
    /// Note what is *not* here: no version bump, no clock read, no new nonce.
    /// The bookkeeping fields were recorded as ordinary keys when the command
    /// ran, so replaying restores them — see the module header on why undo is
    /// a restore rather than a second edit.
    fn play(&mut self, edit: &Edit, forward: bool, acc: &mut Acc) {
        match edit {
            Edit::Patched {
                id,
                prev,
                next,
                rest_order,
            } => {
                // Only the reverse direction needs the key order put back:
                // replaying forwards removes the same keys again, from the
                // same map, and lands in the same place.
                let (keys, order) = if forward {
                    (next, None)
                } else {
                    (prev, rest_order.as_deref())
                };
                self.write_raw(id, keys, order, acc);
            }
            Edit::Inserted { index, element } => {
                if forward {
                    self.insert_at(*index, (**element).clone(), acc);
                } else {
                    self.remove_at(*index, acc);
                }
                acc.structural = true;
            }
            Edit::Removed { index, element } => {
                if forward {
                    self.remove_at(*index, acc);
                } else {
                    self.insert_at(*index, (**element).clone(), acc);
                }
                acc.structural = true;
            }
            Edit::Reordered { prev, next } => {
                let order = if forward { next } else { prev };
                self.set_order(order);
                acc.structural = true;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Primitives. Everything above and below goes through these four.
    // -----------------------------------------------------------------------

    /// Write keys onto an element without adding bookkeeping — the history
    /// replay path, where the bookkeeping is already in `keys`.
    fn write_raw(
        &mut self,
        id: &str,
        keys: &[KeyEdit],
        rest_order: Option<&[String]>,
        acc: &mut Acc,
    ) -> Option<Vec<KeyEdit>> {
        let i = self.index_of(id)?;
        let e = &mut self.scene.elements[i];
        let before = element_bounds_rotated(e);
        let prev = write_keys(e, keys)?;
        if let Some(order) = rest_order {
            restore_rest_order(e, order);
        }
        let e = &self.scene.elements[i];
        if let Some(b) = before {
            acc.bbox = Some(match acc.bbox {
                Some(cur) => cur.union(&b),
                None => b,
            });
        }
        acc.touch(e);
        Some(prev)
    }

    /// Write keys onto an element *as an edit*: the Phase 1 bookkeeping is
    /// appended here, in the one place every command's writes funnel through,
    /// so there is no path that can skip it.
    fn write(&mut self, id: &str, mut keys: Vec<KeyEdit>, out: &mut Vec<Edit>, acc: &mut Acc) {
        let Some(i) = self.index_of(id) else { return };
        // Only a write that removes a key can disturb the order of `rest`;
        // everything else either overwrites in place or appends.
        let rest_order = keys
            .iter()
            .any(|(_, v)| v.is_none())
            .then(|| self.scene.elements[i].rest.keys().cloned().collect());
        let version = self.scene.elements[i].version.saturating_add(1);
        let nonce = self.rng.next_nonce();
        keys.push(("version".to_string(), Some(Value::from(version))));
        keys.push(("versionNonce".to_string(), Some(Value::from(nonce))));
        keys.push(("updated".to_string(), Some(Value::from(self.now))));
        if let Some(prev) = self.write_raw(id, &keys, None, acc) {
            out.push(Edit::Patched {
                id: id.to_string(),
                prev,
                next: keys,
                rest_order,
            });
        }
    }

    fn insert_at(&mut self, index: usize, element: Element, acc: &mut Acc) {
        let at = index.min(self.scene.elements.len());
        acc.touch(&element);
        self.scene.elements.insert(at, element);
    }

    fn remove_at(&mut self, index: usize, acc: &mut Acc) -> Option<Element> {
        if index >= self.scene.elements.len() {
            return None;
        }
        let e = self.scene.elements.remove(index);
        acc.touch(&e);
        Some(e)
    }

    /// The fractional index an element landing at array position `pos` should
    /// carry, or `None` if we cannot produce one.
    ///
    /// **What a missing neighbour means.** The scan walks outwards past any
    /// element whose `index` is absent or unreadable, and treats "nothing
    /// found in that direction" as unbounded. It does not backfill: a file
    /// that arrived with no indices at all keeps none except on the elements
    /// we actually touch.
    ///
    /// That is safe because of what Excalidraw does on load — it walks the
    /// array and regenerates the index of every element whose key is missing
    /// or not greater than its predecessor's, using the array order as the
    /// truth. So an unindexed file already round-trips correctly through the
    /// array alone, and a partly-indexed one has its gaps filled in a way that
    /// agrees with the keys we did write. Backfilling every element here would
    /// mean touching, and bumping the version of, elements the user never
    /// edited — churn in the diff and churn in anyone's reconciliation.
    fn index_for_position(&self, pos: usize) -> Option<String> {
        let usable = |e: &Element| -> Option<String> {
            match &e.index {
                Some(k) if valid_key(k) => Some(k.clone()),
                _ => None,
            }
        };
        let lower = self.scene.elements[..pos.min(self.scene.elements.len())]
            .iter()
            .rev()
            .find_map(usable);
        let upper = self.scene.elements[pos.min(self.scene.elements.len())..]
            .iter()
            .find_map(usable);
        index_between(lower.as_deref(), upper.as_deref())
    }

    /// Rebuild the element vector in the given id order. Anything the order
    /// does not name keeps its relative position on the end, which cannot
    /// happen from our own records but keeps a hand-built order from
    /// destroying a scene.
    fn set_order(&mut self, order: &[String]) {
        let mut by_id: HashMap<String, Element> = HashMap::with_capacity(order.len());
        let mut leftovers = Vec::new();
        for e in self.scene.elements.drain(..) {
            by_id.insert(e.id.clone(), e);
        }
        let mut out = Vec::with_capacity(order.len());
        for id in order {
            if let Some(e) = by_id.remove(id) {
                out.push(e);
            }
        }
        leftovers.extend(by_id.into_values());
        leftovers.sort_by(|a, b| a.id.cmp(&b.id));
        out.append(&mut leftovers);
        self.scene.elements = out;
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    fn execute(&mut self, cmd: &Command) -> (Vec<Edit>, Acc) {
        let mut out = Vec::new();
        let mut acc = Acc::default();
        self.run(cmd, &mut out, &mut acc);
        (out, acc)
    }

    fn run(&mut self, cmd: &Command, out: &mut Vec<Edit>, acc: &mut Acc) {
        match cmd {
            Command::Batch(cmds) => {
                for c in cmds {
                    self.run(c, out, acc);
                }
            }

            Command::Insert { at, element } => {
                // The element arrives complete. `new_element` stamped its id,
                // seed, version and `updated`; restamping here would make
                // every new element arrive at version 2 for no reason, and
                // would rewrite the seed of a pasted element — the one thing
                // this module exists to refuse.
                let n = self.scene.elements.len();
                let index = at.unwrap_or(n).min(n);
                let mut el = (**element).clone();
                // The fractional index comes from where the element actually
                // lands, not from whatever it arrived carrying. `new_element`
                // guesses "on top" because that is where a freshly drawn shape
                // goes, and a duplicate arrives holding a *copy* of the
                // original's key — two elements with one index is exactly the
                // ambiguity the scheme exists to prevent, so this overwrites
                // unconditionally rather than filling in a blank.
                if let Some(key) = self.index_for_position(index) {
                    el.index = Some(key);
                }
                self.insert_at(index, el.clone(), acc);
                out.push(Edit::Inserted {
                    index,
                    element: Box::new(el),
                });
                acc.structural = true;
            }

            Command::Delete { ids } => {
                self.detach_references(ids, out, acc);
                // Descending, so each index is still valid as we go and so
                // the reversed replay reinserts in ascending order.
                let mut indices: Vec<usize> =
                    ids.iter().filter_map(|id| self.index_of(id)).collect();
                indices.sort_unstable();
                indices.dedup();
                for index in indices.into_iter().rev() {
                    if let Some(e) = self.remove_at(index, acc) {
                        out.push(Edit::Removed {
                            index,
                            element: Box::new(e),
                        });
                        acc.structural = true;
                    }
                }
            }

            Command::Patch { id, fields } => {
                let keys = sanitise(fields);
                if keys.is_empty() {
                    return;
                }
                self.write(id, keys, out, acc);
            }

            Command::Reorder { ids, how } => self.reorder(ids, *how, out, acc),

            Command::Group { ids } => {
                let gid = self.rng.next_id();
                for id in ids {
                    let Some(i) = self.index_of(id) else { continue };
                    let mut groups = self.scene.elements[i].group_ids.clone();
                    if groups.contains(&gid) {
                        continue;
                    }
                    groups.push(gid.clone());
                    self.write(
                        id,
                        vec![("groupIds".to_string(), Some(json_strings(&groups)))],
                        out,
                        acc,
                    );
                }
            }

            Command::Ungroup { ids } => {
                for id in ids {
                    let Some(i) = self.index_of(id) else { continue };
                    let mut groups = self.scene.elements[i].group_ids.clone();
                    if groups.pop().is_none() {
                        continue;
                    }
                    self.write(
                        id,
                        vec![("groupIds".to_string(), Some(json_strings(&groups)))],
                        out,
                        acc,
                    );
                }
            }

            Command::Bind {
                arrow,
                end,
                binding,
            } => self.bind(arrow, *end, binding.as_ref(), out, acc),
        }
    }

    /// Z-order. `Front`/`Back` move the selection as a block, preserving its
    /// internal order; `Forward`/`Backward` step one place but refuse to step
    /// over another selected element, so repeated presses keep the selection
    /// together instead of shuffling it.
    ///
    /// A reorder moves array positions *and* rewrites the fractional `index`
    /// of the elements that moved, because excalidraw.com re-sorts by `index`
    /// on load and would otherwise put the drawing straight back the way it
    /// was — a reorder that appears to work here and does not travel.
    ///
    /// Only the elements that actually changed position are reindexed, and
    /// they are reindexed a run at a time between the keys of the neighbours
    /// that did not move. Rewriting every element's index on every reorder is
    /// precisely the churn fractional indexing exists to avoid.
    ///
    /// **These writes do bump the version.** The earlier rule — that a
    /// reorder touches no element field, so no version moves — was true when
    /// z-order lived only in the array. `index` is a field, and a collaborator
    /// that does not see the version move keeps the stale key and puts the
    /// drawing back in the old order. Elements that merely shifted position
    /// because something moved past them keep their key and their version:
    /// nothing about them changed.
    fn reorder(&mut self, ids: &[String], how: Reorder, out: &mut Vec<Edit>, acc: &mut Acc) {
        let prev: Vec<String> = self.scene.elements.iter().map(|e| e.id.clone()).collect();
        let n = prev.len();
        let selected: Vec<bool> = prev.iter().map(|id| ids.iter().any(|s| s == id)).collect();
        if !selected.iter().any(|s| *s) {
            return;
        }
        let mut next = prev.clone();
        match how {
            Reorder::Front | Reorder::Back => {
                let (mut moved, mut rest): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
                for (i, id) in prev.iter().enumerate() {
                    if selected[i] {
                        moved.push(id.clone());
                    } else {
                        rest.push(id.clone());
                    }
                }
                next = if how == Reorder::Front {
                    rest.into_iter().chain(moved).collect()
                } else {
                    moved.into_iter().chain(rest).collect()
                };
            }
            Reorder::Forward => {
                let mut sel = selected.clone();
                for i in (0..n).rev() {
                    if sel[i] && i + 1 < n && !sel[i + 1] {
                        next.swap(i, i + 1);
                        sel.swap(i, i + 1);
                    }
                }
            }
            Reorder::Backward => {
                let mut sel = selected.clone();
                for i in 0..n {
                    if sel[i] && i > 0 && !sel[i - 1] {
                        next.swap(i, i - 1);
                        sel.swap(i, i - 1);
                    }
                }
            }
        }
        if next == prev {
            return;
        }
        self.set_order(&next);
        for e in &self.scene.elements {
            if ids.contains(&e.id) {
                acc.touch(e);
            }
        }
        acc.structural = true;

        // The elements whose position genuinely changed. An unselected element
        // that shifted along because the selection went past it has not moved
        // relative to the others that stayed, so its key is still correct.
        let moved: Vec<String> = next
            .iter()
            .filter(|id| {
                ids.contains(id)
                    && prev.iter().position(|p| p == *id) != next.iter().position(|p| p == *id)
            })
            .cloned()
            .collect();
        out.push(Edit::Reordered { prev, next: next.clone() });

        // Walk the new order, reindexing each maximal run of moved elements
        // between the keys on either side of it. Runs are handled left to
        // right, so anything before the run has its final key already;
        // anything after that is itself still waiting is skipped, because its
        // key is the stale one we are about to replace.
        let mut i = 0;
        while i < next.len() {
            if !moved.contains(&next[i]) {
                i += 1;
                continue;
            }
            let start = i;
            while i < next.len() && moved.contains(&next[i]) {
                i += 1;
            }
            let run = &next[start..i];
            let lower = self.scene.elements[..start]
                .iter()
                .rev()
                .find_map(|e| e.index.as_deref().filter(|k| valid_key(k)).map(String::from));
            let upper = self.scene.elements[i..]
                .iter()
                .filter(|e| !moved.contains(&e.id))
                .find_map(|e| e.index.as_deref().filter(|k| valid_key(k)).map(String::from));
            let keys = indices_between(lower.as_deref(), upper.as_deref(), run.len());
            if keys.len() != run.len() {
                // The space between the neighbours is exhausted, or one of
                // them is a key we do not understand. The array order is still
                // right; leaving the indices alone is the honest failure.
                continue;
            }
            for (id, key) in run.iter().cloned().zip(keys) {
                self.write(
                    &id,
                    vec![("index".to_string(), Some(Value::String(key)))],
                    out,
                    acc,
                );
            }
        }
    }

    /// Attach or detach one end of an arrow, maintaining both halves.
    ///
    /// The format states a binding twice — the arrow names the shape, the
    /// shape names the arrow back in `boundElements` — and Excalidraw trusts
    /// both. Write only the arrow's half and the shape never moves the arrow
    /// with it; write only the shape's half and the arrow never follows. So
    /// this is the one command with real bookkeeping of its own: drop the
    /// back-reference on whatever the arrow was bound to, add it to whatever
    /// it is bound to now.
    fn bind(
        &mut self,
        arrow: &str,
        end: End,
        binding: Option<&Binding>,
        out: &mut Vec<Edit>,
        acc: &mut Acc,
    ) {
        let Some(ai) = self.index_of(arrow) else { return };
        let a = &self.scene.elements[ai];
        let old_target = match end {
            End::Start => a.start_binding.as_ref(),
            End::End => a.end_binding.as_ref(),
        }
        .map(|b| b.element_id.clone());
        let new_target = binding.map(|b| b.element_id.clone());
        // The arrow's *other* end may hold the same shape. If it does, the
        // back-reference has to stay — one `boundElements` entry covers both
        // ends, and removing it here would silently unbind the other end.
        let other_target = match end {
            End::Start => a.end_binding.as_ref(),
            End::End => a.start_binding.as_ref(),
        }
        .map(|b| b.element_id.clone());

        let value = match binding {
            Some(b) => match serde_json::to_value(b) {
                Ok(v) => Some(v),
                // A binding whose `rest` holds something unserializable is not
                // reachable from this crate's own types, but refusing beats
                // writing half a binding.
                Err(_) => return,
            },
            None => None,
        };
        self.write(arrow, vec![(end.key().to_string(), value)], out, acc);

        if let Some(old) = &old_target {
            let still_bound =
                other_target.as_deref() == Some(old.as_str()) || new_target.as_deref() == Some(old.as_str());
            if !still_bound {
                self.set_bound_element(old, arrow, false, out, acc);
            }
        }
        if let Some(new) = &new_target {
            self.set_bound_element(new, arrow, true, out, acc);
        }
    }

    /// Add or remove `{ id: <arrow>, type: "arrow" }` in a shape's
    /// `boundElements`.
    ///
    /// Removing from a shape that never had the key is a no-op rather than a
    /// write of `[]` — a file that did not carry `boundElements` should not
    /// gain it because an arrow brushed past.
    fn set_bound_element(
        &mut self,
        shape: &str,
        arrow: &str,
        add: bool,
        out: &mut Vec<Edit>,
        acc: &mut Acc,
    ) {
        let Some(i) = self.index_of(shape) else { return };
        let current = self.scene.elements[i].bound_elements.clone();
        let mut list = match (&current, add) {
            (None, false) => return,
            (None, true) => Vec::new(),
            (Some(v), _) => v.clone(),
        };
        let present = list.iter().any(|b| b.id == arrow);
        if add {
            if present {
                return;
            }
            list.push(BoundElement {
                id: arrow.to_string(),
                kind: "arrow".to_string(),
            });
        } else {
            if !present {
                return;
            }
            list.retain(|b| b.id != arrow);
        }
        let Ok(value) = serde_json::to_value(&list) else {
            return;
        };
        self.write(
            shape,
            vec![("boundElements".to_string(), Some(value))],
            out,
            acc,
        );
    }

    /// Before elements are removed, take every reference to them off the
    /// elements that survive: arrows bound to a doomed shape lose the
    /// binding, shapes lose the doomed arrow from `boundElements`.
    ///
    /// A file that names an element it does not contain is the classic
    /// hand-edited-`.excalidraw` failure, and it does not announce itself —
    /// Excalidraw opens the file and then behaves oddly around the ghost.
    /// Elements that are themselves being deleted are skipped: they go out
    /// whole, so undo puts them back whole, bindings and all.
    fn detach_references(&mut self, doomed: &[String], out: &mut Vec<Edit>, acc: &mut Acc) {
        let survivors: Vec<String> = self
            .scene
            .elements
            .iter()
            .filter(|e| !doomed.contains(&e.id))
            .map(|e| e.id.clone())
            .collect();
        for id in survivors {
            let Some(i) = self.index_of(&id) else { continue };
            let e = &self.scene.elements[i];
            let mut keys: Vec<KeyEdit> = Vec::new();
            for end in [End::Start, End::End] {
                let bound = match end {
                    End::Start => e.start_binding.as_ref(),
                    End::End => e.end_binding.as_ref(),
                };
                if let Some(b) = bound {
                    if doomed.contains(&b.element_id) {
                        keys.push((end.key().to_string(), None));
                    }
                }
            }
            if let Some(list) = &e.bound_elements {
                if list.iter().any(|b| doomed.contains(&b.id)) {
                    let kept: Vec<BoundElement> = list
                        .iter()
                        .filter(|b| !doomed.contains(&b.id))
                        .cloned()
                        .collect();
                    if let Ok(value) = serde_json::to_value(&kept) {
                        keys.push(("boundElements".to_string(), Some(value)));
                    }
                }
            }
            if !keys.is_empty() {
                self.write(&id, keys, out, acc);
            }
        }
    }

    // -----------------------------------------------------------------------
    // New elements
    // -----------------------------------------------------------------------

    /// A fresh element: new id, new seed, version 1, a fresh nonce, `updated`
    /// stamped from the host's clock.
    ///
    /// The seed comes from [`Doc::fresh_identity`], which is the one place in
    /// the crate that mints one; no patch may ever rewrite it afterwards.
    ///
    /// The element is *returned*, not inserted — hand it to
    /// [`Command::Insert`]. An in-progress shape being dragged out is not in
    /// the document yet and must not be in its history either.
    pub fn new_element(&mut self, kind: ElementKind, b: &Bounds) -> Element {
        let (id, seed) = self.fresh_identity();
        let version_nonce = self.rng.next_nonce();
        // A fresh shape goes on top, which is where a drawing gesture puts it.
        // `Command::Insert` recomputes this from where the element actually
        // lands, so an element inserted lower down is still keyed correctly;
        // setting it here means an element is well-formed the moment it exists,
        // including for a caller that inspects it before inserting.
        let index = self.index_for_position(self.scene.elements.len());
        let width = b.width();
        let height = b.height();

        // Two points on the diagonal is what Excalidraw creates a line or
        // arrow with; one point is a freedraw stroke that has been started but
        // not yet dragged.
        let points = match &kind {
            k if k.is_linear() => Some(vec![[0.0, 0.0], [width, height]]),
            ElementKind::Freedraw => Some(vec![[0.0, 0.0]]),
            _ => None,
        };
        let is_text = kind == ElementKind::Text;

        Element {
            id,
            // Rounded corners on the two shapes that have corners. `type: 3`
            // is the adaptive scheme, which is what Excalidraw's default
            // "round edges" setting produces.
            roundness: match kind {
                ElementKind::Rectangle | ElementKind::Diamond => Some(Roundness {
                    kind: 3,
                    value: None,
                }),
                _ => None,
            },
            kind,
            x: b.min_x,
            y: b.min_y,
            width,
            height,
            angle: 0.0,
            seed,
            version: 1,
            version_nonce,
            updated: Some(self.now),

            stroke_color: Some("#1e1e1e".to_string()),
            background_color: Some("transparent".to_string()),
            fill_style: Some("solid".to_string()),
            stroke_width: Some(2.0),
            stroke_style: Some("solid".to_string()),
            roughness: Some(1.0),
            opacity: Some(100.0),

            group_ids: Vec::new(),
            frame_id: None,
            index,
            link: None,
            is_deleted: false,
            locked: Some(false),
            bound_elements: None,

            points,
            pressures: None,
            last_committed_point: None,
            start_binding: None,
            end_binding: None,

            text: is_text.then(String::new),
            original_text: is_text.then(String::new),
            font_size: is_text.then_some(20.0),
            font_family: is_text.then_some(1),
            text_align: is_text.then(|| "left".to_string()),
            vertical_align: is_text.then(|| "top".to_string()),
            container_id: None,
            line_height: is_text.then_some(1.25),

            file_id: None,
            rest: Map::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Fractional indexing
//
// Excalidraw orders elements by a base-62 fractional index string — "a0", then
// "a1", and between those two, "a0V". The array order in the file is expected
// to agree with it, and excalidraw.com re-sorts by `index` on load. That is
// why a reorder that only moved array positions was invisible over there: the
// file said one thing in its ordering and another in its keys, and Excalidraw
// believed the keys.
//
// This is a port of the `fractional-indexing` algorithm Excalidraw uses,
// written out rather than pulled in as a dependency: the crate compiles to
// wasm against a 586 KB budget (PLAN.md, Phase 4), and this is two hundred
// lines of string arithmetic with no allocation to speak of.
//
// A key is an integer part followed by a fractional part. The integer part's
// first character encodes both its sign and its length — 'a' means two
// characters total, 'b' three, up to 'z'; 'Z' means two counting down through
// 'A' for the negatives. That is what lets keys of different magnitudes still
// compare correctly as plain strings, which is the whole trick: ordering is
// `<` on a String, in any language, with no parsing.
//
// Nothing here panics or asserts. A file in the wild can carry an `index` that
// is not a valid key at all, and the answer to that is to decline to generate
// (return `None`) and leave the element's index alone — never to bring down
// the editor over a field we did not write.
// ---------------------------------------------------------------------------

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// The one key with no predecessor. Excalidraw refuses it as an input for the
/// same reason: there is nothing to generate below it.
const SMALLEST_INTEGER: &str = "A00000000000000000000000000";

fn digit_value(c: u8) -> Option<usize> {
    DIGITS.iter().position(|d| *d == c)
}

/// How many characters this key's integer part occupies, read out of its first
/// character. `None` for a character that is not a legal head.
fn integer_length(head: u8) -> Option<usize> {
    match head {
        b'a'..=b'z' => Some((head - b'a') as usize + 2),
        b'A'..=b'Z' => Some((b'Z' - head) as usize + 2),
        _ => None,
    }
}

fn integer_part(key: &str) -> Option<&str> {
    let len = integer_length(*key.as_bytes().first()?)?;
    if len > key.len() || !key.is_char_boundary(len) {
        return None;
    }
    Some(&key[..len])
}

/// Is this a key we can generate against? Anything else in a file's `index` is
/// something we did not write and will not reason about.
fn valid_key(key: &str) -> bool {
    if key == SMALLEST_INTEGER {
        return false;
    }
    match integer_part(key) {
        // A trailing '0' in the fractional part would make the key ambiguous:
        // "a01" and "a010" name the same position.
        Some(i) => !key[i.len()..].ends_with('0'),
        None => false,
    }
}

fn from_bytes(head: u8, digs: Vec<u8>) -> Option<String> {
    let mut out = Vec::with_capacity(digs.len() + 1);
    out.push(head);
    out.extend(digs);
    String::from_utf8(out).ok()
}

fn increment_integer(x: &str) -> Option<String> {
    let head = *x.as_bytes().first()?;
    if integer_length(head)? != x.len() {
        return None;
    }
    let mut digs: Vec<u8> = x.as_bytes()[1..].to_vec();
    let mut carry = true;
    let mut i = digs.len();
    while carry && i > 0 {
        i -= 1;
        let d = digit_value(digs[i])? + 1;
        if d == DIGITS.len() {
            digs[i] = b'0';
        } else {
            digs[i] = DIGITS[d];
            carry = false;
        }
    }
    if !carry {
        return from_bytes(head, digs);
    }
    // The digits wrapped, so the integer part grows a character — or crosses
    // from negative to positive, which is what "Z" -> "a0" is.
    if head == b'Z' {
        return Some("a0".to_string());
    }
    if head == b'z' {
        return None;
    }
    let h = head + 1;
    if h > b'a' {
        digs.push(b'0');
    } else {
        digs.pop();
    }
    from_bytes(h, digs)
}

fn decrement_integer(x: &str) -> Option<String> {
    let head = *x.as_bytes().first()?;
    if integer_length(head)? != x.len() {
        return None;
    }
    let last = *DIGITS.last()?;
    let mut digs: Vec<u8> = x.as_bytes()[1..].to_vec();
    let mut borrow = true;
    let mut i = digs.len();
    while borrow && i > 0 {
        i -= 1;
        let d = digit_value(digs[i])?;
        if d == 0 {
            digs[i] = last;
        } else {
            digs[i] = DIGITS[d - 1];
            borrow = false;
        }
    }
    if !borrow {
        return from_bytes(head, digs);
    }
    if head == b'a' {
        return Some(format!("Z{}", last as char));
    }
    if head == b'A' {
        return None;
    }
    let h = head - 1;
    if h < b'Z' {
        digs.push(last);
    } else {
        digs.pop();
    }
    from_bytes(h, digs)
}

/// A fractional part strictly between `a` and `b`, where `b` unbounded means
/// "anything larger". Both are fractional parts, not whole keys.
fn midpoint(a: &str, b: Option<&str>) -> Option<String> {
    if let Some(b) = b {
        if a >= b || b.ends_with('0') {
            return None;
        }
    }
    if a.ends_with('0') {
        return None;
    }
    if let Some(bs) = b {
        // Share the longest common prefix and recurse on what is left; a
        // missing character on the `a` side reads as '0', because a shorter
        // key is the same key with zeros after it.
        let ab = a.as_bytes();
        let bb = bs.as_bytes();
        let mut n = 0;
        while n < bb.len() && *ab.get(n).unwrap_or(&b'0') == bb[n] {
            n += 1;
        }
        if n > 0 {
            let rest = midpoint(&a[n.min(a.len())..], Some(&bs[n..]))?;
            return Some(format!("{}{}", &bs[..n], rest));
        }
    }
    let digit_a = match a.as_bytes().first() {
        Some(c) => digit_value(*c)?,
        None => 0,
    };
    let digit_b = match b {
        Some(bs) => digit_value(*bs.as_bytes().first()?)?,
        None => DIGITS.len(),
    };
    if digit_b <= digit_a {
        // Only reachable from a malformed input that slipped the checks above.
        return None;
    }
    if digit_b - digit_a > 1 {
        // Room between them: take the middle digit and stop.
        let mid = (digit_a + digit_b).div_ceil(2);
        return Some((DIGITS[mid] as char).to_string());
    }
    // The digits are adjacent, so the answer has to be longer than one of them.
    match b {
        Some(bs) if bs.len() > 1 => Some(bs[..1].to_string()),
        _ => {
            let tail = midpoint(a.get(1..).unwrap_or(""), None)?;
            Some(format!("{}{}", DIGITS[digit_a] as char, tail))
        }
    }
}

/// A fractional index strictly between `a` and `b`. `None` for either side
/// means unbounded — "before everything" or "after everything".
///
/// Returns `None` when a neighbour is not a key we recognise, when they are
/// out of order, or when the space between them is exhausted. Every caller
/// treats that as "leave the index alone".
pub fn index_between(a: Option<&str>, b: Option<&str>) -> Option<String> {
    if a.is_some_and(|k| !valid_key(k)) || b.is_some_and(|k| !valid_key(k)) {
        return None;
    }
    match (a, b) {
        (None, None) => Some("a0".to_string()),
        (None, Some(b)) => {
            let ib = integer_part(b)?;
            if ib == SMALLEST_INTEGER {
                return Some(format!("{ib}{}", midpoint("", Some(&b[ib.len()..]))?));
            }
            // `b` has a fractional part, so its bare integer part already
            // sorts below it and is the cheapest answer.
            if ib < b {
                return Some(ib.to_string());
            }
            decrement_integer(ib)
        }
        (Some(a), None) => {
            let ia = integer_part(a)?;
            match increment_integer(ia) {
                Some(i) => Some(i),
                None => Some(format!("{ia}{}", midpoint(&a[ia.len()..], None)?)),
            }
        }
        (Some(a), Some(b)) => {
            if a >= b {
                return None;
            }
            let ia = integer_part(a)?;
            let ib = integer_part(b)?;
            if ia == ib {
                return Some(format!(
                    "{ia}{}",
                    midpoint(&a[ia.len()..], Some(&b[ib.len()..]))?
                ));
            }
            let i = increment_integer(ia)?;
            if i.as_str() < b {
                return Some(i);
            }
            Some(format!("{ia}{}", midpoint(&a[ia.len()..], None)?))
        }
    }
}

/// `n` ascending indices strictly between `a` and `b`.
///
/// Bisecting rather than chaining matters: generating a run of keys by
/// repeatedly asking for one more after the last would make each key a
/// character longer than the one before when the range is bounded, and a
/// multi-select sent to the back would leave a trail of ever-growing strings
/// in the file. Splitting the range keeps them short.
///
/// Returns an empty vector if it cannot produce all `n`; callers check the
/// length rather than trusting a partial answer.
pub fn indices_between(a: Option<&str>, b: Option<&str>, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return index_between(a, b).into_iter().collect();
    }
    // Unbounded on one side: walking outwards is already cheap there, because
    // each step just increments the integer part.
    if b.is_none() {
        let mut out: Vec<String> = Vec::with_capacity(n);
        let mut cur = match index_between(a, None) {
            Some(k) => k,
            None => return Vec::new(),
        };
        out.push(cur.clone());
        for _ in 1..n {
            cur = match index_between(Some(&cur), None) {
                Some(k) => k,
                None => return Vec::new(),
            };
            out.push(cur.clone());
        }
        return out;
    }
    if a.is_none() {
        let mut out: Vec<String> = Vec::with_capacity(n);
        let mut cur = match index_between(None, b) {
            Some(k) => k,
            None => return Vec::new(),
        };
        out.push(cur.clone());
        for _ in 1..n {
            cur = match index_between(None, Some(&cur)) {
                Some(k) => k,
                None => return Vec::new(),
            };
            out.push(cur.clone());
        }
        out.reverse();
        return out;
    }
    let mid = n / 2;
    let Some(c) = index_between(a, b) else {
        return Vec::new();
    };
    let mut out = indices_between(a, Some(&c), mid);
    if out.len() != mid {
        return Vec::new();
    }
    out.push(c.clone());
    let tail = indices_between(Some(&c), b, n - mid - 1);
    if tail.len() != n - mid - 1 {
        return Vec::new();
    }
    out.extend(tail);
    out
}

/// Fold `src` into `dst`, keeping the original before-state and the newest
/// after-state.
///
/// The compaction is what makes coalescing worth doing: four hundred pointer
/// moves become one `Patched` record per element, not four hundred. A patch
/// only merges backwards into another patch on the same element with no
/// structural edit in between — an element that was removed and reinserted
/// mid-gesture is not the same element as far as history is concerned, and
/// merging across that would replay the keys against the wrong state.
fn fold_edits(dst: &mut Vec<Edit>, src: Vec<Edit>) {
    for edit in src {
        let Edit::Patched {
            id,
            prev,
            next,
            rest_order,
        } = edit
        else {
            dst.push(edit);
            continue;
        };
        let barrier = dst
            .iter()
            .rposition(|e| !matches!(e, Edit::Patched { .. }))
            .map_or(0, |i| i + 1);
        let slot = dst[barrier..]
            .iter()
            .position(|e| matches!(e, Edit::Patched { id: other, .. } if *other == id))
            .map(|i| i + barrier);
        match slot {
            Some(i) => {
                let Edit::Patched {
                    prev: p0,
                    next: n0,
                    rest_order: r0,
                    ..
                } = &mut dst[i]
                else {
                    continue;
                };
                // Earliest capture wins: the key order we put back is the one
                // from the start of the gesture. A later capture would name
                // keys the folded undo is about to remove — harmless, since
                // the restore only orders keys that are still there — but the
                // earliest is the one that is right by construction.
                if r0.is_none() {
                    *r0 = rest_order;
                }
                // First write wins on the way back: the before-state we keep
                // is the one from the start of the gesture.
                for (k, v) in prev {
                    if !p0.iter().any(|(k0, _)| *k0 == k) {
                        p0.push((k, v));
                    }
                }
                // Last write wins on the way forward.
                for (k, v) in next {
                    match n0.iter_mut().find(|(k0, _)| *k0 == k) {
                        Some(existing) => existing.1 = v,
                        None => n0.push((k, v)),
                    }
                }
            }
            None => dst.push(Edit::Patched {
                id,
                prev,
                next,
                rest_order,
            }),
        }
    }
}

/// FNV-1a over the file's text. Not a hash with any security property — it is
/// here so two open documents get two different id streams from a pure
/// function of their contents.
fn seed_from(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Re-exported so callers building a `Patch` by hand do not have to think
/// about NaN. See [`crate::command::Command::move_to`].
pub fn number(v: f64) -> Value {
    json_num(v)
}
