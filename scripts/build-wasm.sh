#!/usr/bin/env bash
# Build xd-wasm and vendor it into ui/vendor/xd-wasm/.
#
# `--target web` gives a plain ES module with no bundler and no npm package
# around it, which is the only thing ui/ can load: every dependency there is a
# vendored .esm.js served straight off disk.
#
# The size budget is 586 KB — the size of bpmn-js in term.hut, which is
# dynamically imported on first .bpmn open. Matching a precedent that already
# ships means the WASM core is not a regression; exceeding it means it is. CI
# runs this script and fails on the number.
set -euo pipefail
cd "$(dirname "$0")/.."

BUDGET_BYTES=$((586 * 1024))

wasm-pack build crates/xd-wasm \
  --target web \
  --release \
  --out-dir "$PWD/ui/vendor/xd-wasm" \
  --out-name xd_wasm \
  --no-typescript

# wasm-pack writes a package.json describing an npm package that nothing here
# installs; leaving it would make `ui/` look like a node project it is not.
rm -f ui/vendor/xd-wasm/package.json ui/vendor/xd-wasm/.gitignore

size=$(wc -c < ui/vendor/xd-wasm/xd_wasm_bg.wasm | tr -d ' ')
printf 'xd_wasm_bg.wasm: %s bytes (%s KB) of %s KB budget\n' \
  "$size" "$((size / 1024))" "$((BUDGET_BYTES / 1024))"
if [ "$size" -gt "$BUDGET_BYTES" ]; then
  echo "over the 586 KB budget — see PLAN.md Phase 4 before widening it" >&2
  exit 1
fi
