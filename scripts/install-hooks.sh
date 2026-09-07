#!/bin/sh
# Point this clone at the tracked hooks in .githooks/.
# Idempotent — safe to run on every session start or from CI setup.
set -eu
root=$(git rev-parse --show-toplevel)
current=$(git config --get core.hooksPath || echo "")
if [ "$current" != ".githooks" ]; then
	git config core.hooksPath .githooks
	echo "core.hooksPath -> .githooks"
fi
chmod +x "$root/.githooks/"* "$root/scripts/"*.sh 2>/dev/null || true
