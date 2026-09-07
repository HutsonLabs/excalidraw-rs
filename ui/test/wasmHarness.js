// One WASM instance for the whole test run.
//
// Not a convenience. wasm-bindgen's init replaces the module-level `wasm`
// binding, so a second `mod.default(...)` in a second test file silently
// invalidates every pointer handed out by the first — an `XdDoc` created
// before it keeps its handle and reads someone else's linear memory. The
// symptom is the worst kind: each test file passes alone and fails in the
// suite, with wrong numbers rather than an error.
//
// So initialisation lives here, behind ESM's own module cache, which
// guarantees it happens once. Every test that needs the document model
// imports from this file and never calls `default()` itself.
import { readFileSync } from "node:fs";
import { wrap } from "../src/xdWasm.js";

export const mod = await import("../vendor/xd-wasm/xd_wasm.js");
await mod.default({
  module_or_path: readFileSync(new URL("../vendor/xd-wasm/xd_wasm_bg.wasm", import.meta.url)),
});

/// A new empty document, wrapped in the same facade the editor uses.
export const blankDoc = () => wrap(mod.XdDoc.blank());

/// A document from a file's text. Throws the parse error as a sentence.
export const openDoc = (text) => wrap(mod.XdDoc.open(text));
