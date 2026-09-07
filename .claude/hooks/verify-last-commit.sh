#!/bin/sh
# Claude Code PostToolUse(Bash) verification.
# After any git commit, re-read HEAD and complain if attribution survived.
set -eu

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""')

[ "$tool" = "Bash" ] || exit 0
printf '%s' "$cmd" | grep -qE 'git[[:space:]]+([-a-zA-Z=/.]+[[:space:]]+)*commit' || exit 0
[ -n "$cwd" ] && cd "$cwd" 2>/dev/null || exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
scrub="$root/scripts/claude-scrub.sh"
[ -x "$scrub" ] || exit 0
git rev-parse --verify HEAD >/dev/null 2>&1 || exit 0

if ! out=$("$scrub" check-commit HEAD 2>&1); then
	echo "HEAD still carries AI attribution:" >&2
	printf '%s\n' "$out" >&2
	echo "" >&2
	echo "Fix it now: git commit --amend  (rewrite the message, drop the trailer)" >&2
	exit 2
fi
exit 0
