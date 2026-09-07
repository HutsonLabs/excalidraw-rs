// The import allowlist, exercised — including the failing cases.
//
// scripts/check-imports.mjs is the guard PLAN.md leans on hardest, and it is
// also the guard most likely to rot unnoticed: it will pass every day for
// months while there is nothing to catch, and a regex that silently stopped
// matching would pass exactly the same way. So this drives it over fixtures
// that must fail, not only over the real tree that must pass.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-imports.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

const run = (root) =>
  spawnSync(process.execPath, root ? [SCRIPT, root] : [SCRIPT], { encoding: "utf8" });

/// A minimal tree shaped like the repo: an entry file, and whatever else the
/// case needs beside it.
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "xd-imports-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("the real tree passes", () => {
  // Green whether or not excalidrawEdit.js exists yet: before it does there is
  // nothing to walk, and that is the correct answer rather than a skip.
  const r = run(REPO);
  expect(r.status).toBe(0);
});

test("an absent editor is reported, not failed — the guard lands before the code", () => {
  const root = fixture({ "ui/src/dom.js": "export const x = 1;\n" });
  const r = run(root);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("not present yet");
  rmSync(root, { recursive: true, force: true });
});

test("a view that imports only what it may is allowed", () => {
  const root = fixture({
    "ui/src/excalidrawEdit.js":
      'import { drawElement } from "./excalidrawView.js";\n'
      + 'import rough from "../vendor/roughjs/rough.esm.js";\n'
      + "export const renderExcalidraw = () => drawElement;\n",
    "ui/src/excalidrawView.js": "export const drawElement = 1;\n",
    "ui/vendor/roughjs/rough.esm.js": "export default 1;\n",
  });
  const r = run(root);
  expect(r.status).toBe(0);
  rmSync(root, { recursive: true, force: true });
});

test("an edge into standalone/ fails, and says which line", () => {
  const root = fixture({
    "ui/src/excalidrawEdit.js":
      "// the view learning about the app\n"
      + 'import { writeFile } from "../standalone/files.js";\n'
      + "export const renderExcalidraw = () => writeFile;\n",
    "ui/standalone/files.js": "export const writeFile = 1;\n",
  });
  const r = run(root);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("ui/src/excalidrawEdit.js:2");
  expect(r.stderr).toContain("../standalone/files.js");
  rmSync(root, { recursive: true, force: true });
});

test("invoke() fails — term.hut's browser build has no Tauri either", () => {
  const root = fixture({
    "ui/src/excalidrawEdit.js": "export const save = (t) => invoke(\"xd_write_file\", t);\n",
  });
  const r = run(root);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("reaches the host");
  rmSync(root, { recursive: true, force: true });
});

test("window.__TAURI__ fails", () => {
  const root = fixture({
    "ui/src/excalidrawEdit.js": "export const app = () => window.__TAURI__;\n",
  });
  const r = run(root);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("reaches the host");
  rmSync(root, { recursive: true, force: true });
});

test("a comment may say the word — preview.js's \"no invoke() here on purpose\"", () => {
  // The rule is about calls, not about the ability to describe the rule.
  const root = fixture({
    "ui/src/excalidrawEdit.js":
      "// No invoke() here on purpose: this file is portable.\n"
      + "export const renderExcalidraw = () => null;\n",
  });
  const r = run(root);
  expect(r.status).toBe(0);
  rmSync(root, { recursive: true, force: true });
});

test("a violation two hops in is still caught", () => {
  // The walk is transitive, which is the only version of this check worth
  // having: the leak that matters arrives through a helper, not in the entry.
  const root = fixture({
    "ui/src/excalidrawEdit.js": 'import "./excalidrawTools.js";\n',
    "ui/src/excalidrawTools.js": "export const t = () => window.__TAURI__.core;\n",
  });
  const r = run(root);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("excalidrawTools.js");
  rmSync(root, { recursive: true, force: true });
});

test("a bare specifier fails — there is no bundler to resolve it", () => {
  const root = fixture({
    "ui/src/excalidrawEdit.js": 'import rough from "roughjs";\n',
  });
  const r = run(root);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("no bundler");
  rmSync(root, { recursive: true, force: true });
});
