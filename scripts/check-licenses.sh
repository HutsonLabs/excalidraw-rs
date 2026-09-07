#!/usr/bin/env bash
# The licence split only holds if the dependency arrow does (PLAN.md Phase 0):
# the PolyForm app may depend on the permissive crates, and nothing permissive
# may depend on anything PolyForm.
#
# One direction is checkable mechanically and that is the one that matters —
# an accidental `use excalidraw_rs_lib::` inside xd-core would relicense the
# crate by import.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

for crate in xd-core xd-wasm; do
  manifest="crates/$crate/Cargo.toml"
  grep -q 'license = "MIT OR Apache-2.0"' "$manifest" || {
    echo "$manifest: expected license = \"MIT OR Apache-2.0\"" >&2
    fail=1
  }
  for f in LICENSE-MIT LICENSE-APACHE; do
    [ -f "crates/$crate/$f" ] || { echo "crates/$crate/$f is missing" >&2; fail=1; }
  done
  if grep -rqE '^\s*(excalidraw-rs|excalidraw_rs_lib|tauri)\b' "$manifest"; then
    echo "$manifest: a permissive crate must not depend on the app" >&2
    fail=1
  fi
done

grep -q 'license = "PolyForm-Noncommercial-1.0.0"' src-tauri/Cargo.toml || {
  echo "src-tauri/Cargo.toml: expected license = \"PolyForm-Noncommercial-1.0.0\"" >&2
  fail=1
}

exit $fail
