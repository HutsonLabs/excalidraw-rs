#!/bin/sh
# Rewrite existing commit messages to remove AI attribution.
#
#   scripts/scrub-history.sh <rev-range>     e.g. origin/main..HEAD, or HEAD~5..HEAD
#
# This rewrites history: every commit in the range gets a new SHA. Only do this
# on commits you have not shared, or coordinate the force-push with your team.
set -eu
root=$(git rev-parse --show-toplevel)
scrub="$root/scripts/claude-scrub.sh"
range=${1:-}

if [ -z "$range" ]; then
	echo "usage: scripts/scrub-history.sh <rev-range>" >&2
	exit 2
fi

if [ -n "$(git status --porcelain)" ]; then
	echo "working tree is dirty — commit or stash first" >&2
	exit 1
fi

count=$(git rev-list --count "$range")
echo "Rewriting $count commit(s) in $range."
printf "This changes commit SHAs. Continue? [y/N] "
read -r reply
case "$reply" in y | Y | yes | YES) ;; *)
	echo "aborted"
	exit 1
	;;
esac

FILTER_BRANCH_SQUELCH_WARNING=1 \
	git filter-branch -f \
	--msg-filter "tmp=\$(mktemp); cat > \"\$tmp\"; '$scrub' scrub-file \"\$tmp\"; cat \"\$tmp\"; rm -f \"\$tmp\"" \
	--env-filter '
		case "$GIT_AUTHOR_NAME$GIT_AUTHOR_EMAIL" in
		*[Cc]laude* | *[Aa]nthropic*)
			GIT_AUTHOR_NAME=$(git config user.name)
			GIT_AUTHOR_EMAIL=$(git config user.email)
			export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
			;;
		esac
		case "$GIT_COMMITTER_NAME$GIT_COMMITTER_EMAIL" in
		*[Cc]laude* | *[Aa]nthropic*)
			GIT_COMMITTER_NAME=$(git config user.name)
			GIT_COMMITTER_EMAIL=$(git config user.email)
			export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
			;;
		esac
	' \
	-- "$range"

echo ""
echo "Done. Verifying:"
"$scrub" check-revs "$range" && echo "  clean."
