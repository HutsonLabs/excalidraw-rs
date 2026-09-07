#!/usr/bin/env node
// The import allowlist. PLAN.md calls this the highest-leverage thing in the
// plan, so it is worth saying plainly what it is for.
//
// `ui/src/excalidrawEdit.js` is the portable unit: the whole editor, written
// to term.hut's contract, meant to be lifted across at Phase 8 as a copy. For
// most of this project's life its only consumer is an app that has every
// incentive to reach into it — the app is right there, its files are one
// directory over, and `invoke` would solve whatever is in the way today. A
// rule remembered will not survive that for months. So the rule is a build
// step instead.
//
// Three things fail it, and each is a specific way the port stops being a
// copy:
//
//   an import outside the allowlist  — the view grew a dependency term.hut
//                                      does not have
//   an edge into standalone/         — the view learned about the app
//   invoke() or window.__TAURI__     — the view learned about Tauri, which
//                                      term.hut's browser build doesn't have
//                                      either
//
// If this ever fails and the fix looks like "widen the allowlist", that is the
// moment PLAN.md's risk list is about: stop and look at what is actually being
// asked for.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/// The repository, or a tree shaped like one. The argument exists so
/// ui/test/imports.test.js can point this at a fixture and watch it fail — a
/// guard that has only ever been seen to pass is a guard nobody has checked
/// the wiring of, and this is the one guard the plan says everything else
/// rests on.
const ROOT = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const ENTRY = resolve(ROOT, "ui/src/excalidrawEdit.js");
const SRC = resolve(ROOT, "ui/src");
const VENDOR = resolve(ROOT, "ui/vendor");

/// What the portable unit may reach.
///
/// PLAN.md names nine files. Two more are here — `excalidrawDoc.js` (the
/// "is this safe to save" decisions, mirroring bpmnDoc.js) and
/// `excalidrawProps.js` (the shape properties panel). Both were added
/// deliberately and both are *portable*: they live in `ui/src`, import nothing
/// outside this list, and go across in the same copy the rest of the view
/// does.
///
/// That distinction is the whole point of the check. PLAN.md's own risk list
/// says that if this guard ever fails and the fix is "widen the allowlist",
/// that is the moment to stop and look at what is actually being asked for.
/// So: widening it for a new module that is part of the view is fine.
/// Widening it for anything under `standalone/`, or for a host capability, is
/// the bug the guard exists to catch — do not.
///
/// `a11y.js` is on the list because viewActions.js imports it.
const ALLOWED = new Set([
  "excalidrawEdit.js", "excalidrawTools.js", "excalidrawView.js",
  "excalidrawScene.js", "excalidrawDoc.js", "excalidrawProps.js",
  "xdWasm.js", "dom.js", "viewActions.js", "colorpicker.js", "a11y.js",
]);

// Static `import`/`export … from`, bare `import "x"`, and `import("x")` with a
// literal — a dynamic import is still an edge, and is exactly how a lazy
// dependency would slip past a check that only looked at static ones.
const EDGE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
// A call, not the word: a file is allowed to *say* "no invoke() here on
// purpose", the way term.hut's preview.js does, and comment lines are skipped
// below so it can.
const HOST = /\binvoke\s*\(|__TAURI__/;

if (!existsSync(ENTRY)) {
  // The editor is written after this check, on purpose: the guard lands in
  // Phase 5 "before there is anything to catch". A green run over nothing is
  // the correct result, not a skipped test.
  console.log("check-imports: ui/src/excalidrawEdit.js is not present yet — nothing to check.");
  process.exit(0);
}

const problems = [];
const seen = new Set();
const queue = [ENTRY];

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  if (!existsSync(file)) {
    problems.push(`${rel(file)}: imported but missing`);
    continue;
  }
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = `${rel(file)}:${i + 1}`;
    const code = line.trim();
    const comment = code.startsWith("//") || code.startsWith("*") || code.startsWith("/*");
    if (!comment && HOST.test(line)) {
      problems.push(`${at}: reaches the host — ${code}`);
    }
    for (const [, spec] of line.matchAll(EDGE)) {
      if (!spec.startsWith(".")) {
        problems.push(`${at}: bare specifier "${spec}" — there is no bundler to resolve it`);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (target.startsWith(VENDOR + "/")) continue; // ../vendor/* is allowed, not walked
      if (dirname(target) === SRC && ALLOWED.has(target.split("/").pop())) {
        queue.push(target);
        continue;
      }
      problems.push(`${at}: not on the allowlist — ${spec}`);
    }
  });
}

function rel(p) {
  return relative(ROOT, p);
}

if (problems.length) {
  console.error("check-imports: the portable unit reached outside itself.\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nThe view must be liftable into term.hut as a copy (PLAN.md Phase 8).",
  );
  process.exit(1);
}

console.log(`check-imports: ${seen.size} files, all inside the line.`);
