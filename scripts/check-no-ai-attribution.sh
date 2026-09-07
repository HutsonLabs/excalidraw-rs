#!/bin/sh
# CI / manual gate. Checks a range of commits (default: everything reachable).
#   scripts/check-no-ai-attribution.sh [rev-range]
set -eu
root=$(git rev-parse --show-toplevel)
range=${1:-HEAD}
echo "Checking commits in: $range"
if "$root/scripts/claude-scrub.sh" check-revs "$range"; then
	echo "No AI attribution found."
else
	echo "" >&2
	echo "Found AI attribution in commit metadata. Rewrite with:" >&2
	echo "  scripts/scrub-history.sh $range" >&2
	exit 1
fi
