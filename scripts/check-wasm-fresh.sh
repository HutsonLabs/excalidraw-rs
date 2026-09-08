#!/usr/bin/env bash
# Is the vendored WASM still the artifact its sources describe?
#
# ui/ is served straight off disk with no bundler, so ui/vendor/xd-wasm is not
# a build output that CI regenerates — it is *what ships*. A copy that has
# drifted from the crates it was built from is worse than no copy at all: the
# app runs code nobody can find the source of, and the drift is invisible
# because the file is binary.
#
# ## Why this is not a diff
#
# The obvious check is to rebuild and `git diff --exit-code` the result, and
# that is what this repo did until it was run on a machine other than the one
# that produced the commit. A release WASM build is not byte-reproducible
# across toolchains: rustc, wasm-bindgen and wasm-opt all put their own
# fingerprints in the output, and CI tracks `stable`, which moves. So the diff
# failed for a build that was perfectly current, said "stale — run
# build-wasm.sh and commit it", and would have gone on failing after you did.
# A check that cries wolf on a green tree is a check people learn to push past,
# which is worse than not having it.
#
# So this asks the question the byte diff was standing in for: **has anything
# the artifact is built from changed since the artifact was last committed?**
# That is answerable from history exactly, on any machine, with no toolchain at
# all. What it gives up is catching a hand-edited or truncated blob — nobody
# hand-edits a .wasm, and the size budget in build-wasm.sh already runs in CI
# against a fresh build, so a build that stopped working still fails there.

set -euo pipefail
cd "$(dirname "$0")/.."

VENDORED="ui/vendor/xd-wasm"

# Everything that decides the bytes.
#
# `Cargo.lock` is in the list and it is the debatable one: this is a workspace,
# so the lock also moves when the Tauri app's dependencies do, and a bump that
# touches nothing the WASM uses will still ask for a rebuild. That is the
# direction to be wrong in. A rebuild nobody needed costs a command; a
# dependency bump that silently invalidated the artifact ships code whose
# source is not in the tree.
#
# The root `Cargo.toml` is here for its `[profile.release]` block — opt-level,
# lto, panic, codegen-units and strip are what buy the size budget — and
# build-wasm.sh for its flags.
SOURCES=(crates Cargo.toml Cargo.lock scripts/build-wasm.sh)

# A shallow clone has no history to ask, and would answer "nothing changed" to
# everything. Said plainly, because the alternative is a check that passes for
# the wrong reason — the one failure mode this file exists to avoid.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "check-wasm-fresh: this is a shallow clone, so there is no history to check." >&2
  echo "  In CI: actions/checkout needs 'with: { fetch-depth: 0 }'." >&2
  exit 1
fi

built=$(git log -1 --format=%H -- "$VENDORED")
if [ -z "$built" ]; then
  echo "check-wasm-fresh: $VENDORED has never been committed." >&2
  echo "  Run scripts/build-wasm.sh and commit what it writes." >&2
  exit 1
fi

drift=$(git rev-list "$built..HEAD" -- "${SOURCES[@]}")

if [ -n "$drift" ]; then
  echo "$VENDORED is older than the sources it was built from." >&2
  echo "" >&2
  echo "  last rebuilt:  $(git log -1 --format='%h %s' "$built")" >&2
  echo "" >&2
  echo "  changed since:" >&2
  git log --format='    %h %s' "$built..HEAD" -- "${SOURCES[@]}" >&2
  echo "" >&2
  echo "  Run scripts/build-wasm.sh and commit ui/vendor/xd-wasm." >&2
  exit 1
fi

echo "ui/vendor/xd-wasm: current as of $(git log -1 --format='%h %s' "$built")"
