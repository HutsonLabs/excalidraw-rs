#!/bin/sh
# Self-test for the attribution gates. Builds a throwaway repo in a temp dir,
# installs this repo's hooks into it, and asserts each gate behaves.
#   scripts/selftest-hooks.sh
set -u
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cd "$T" || exit 1

git init -q .
git config user.name "Test Human"
git config user.email "human@example.com"
mkdir -p .githooks scripts
cp "$SRC"/.githooks/* .githooks/
cp "$SRC"/scripts/*.sh scripts/
chmod +x .githooks/* scripts/*.sh
git config core.hooksPath .githooks
echo hi >a.txt
git add -A

pass=0
fail=0
ok() {
	printf "  PASS  %s\n" "$1"
	pass=$((pass + 1))
}
no() {
	printf "  FAIL  %s\n" "$1"
	fail=$((fail + 1))
}

echo "1. attribution trailer is stripped, commit still succeeds"
MSG=$(printf 'Add scene bounds cache\n\nSpeeds up fit-to-view.\n\n\xF0\x9F\xA4\x96 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n')
if git commit -q -m "$MSG" >/dev/null 2>&1; then
	body=$(git log -1 --format=%B)
	case "$body" in
	*laude* | *nthropic*) no "attribution survived: $body" ;;
	*) ok "scrubbed to \"$(git log -1 --format=%s)\"" ;;
	esac
else
	no "commit was rejected outright"
fi

echo "2. bare mention is rejected by default"
echo x >>a.txt
git add -A
if git commit -q -m "wire up claude api client" >/dev/null 2>&1; then
	no "bare mention slipped through"
else
	ok "rejected"
fi

echo "3. bare mention is allowed with ALLOW_CLAUDE_MENTION=1"
if ALLOW_CLAUDE_MENTION=1 git commit -q -m "wire up claude api client" >/dev/null 2>&1; then
	ok "allowed"
else
	no "escape hatch did not work"
fi

echo "4. assistant author identity is rejected"
echo y >>a.txt
git add -A
if GIT_AUTHOR_NAME=Claude GIT_AUTHOR_EMAIL=noreply@anthropic.com git commit -q -m "normal message" >/dev/null 2>&1; then
	no "assistant author accepted"
else
	ok "rejected"
fi

echo "5. range check catches a commit made with the hooks disabled"
git -c core.hooksPath=/dev/null commit -q --no-verify \
	-m "$(printf 'Bad commit\n\nCo-authored-by: Claude <noreply@anthropic.com>\n')" >/dev/null 2>&1
if scripts/claude-scrub.sh check-revs HEAD~1..HEAD >/dev/null 2>&1; then
	no "range check (pre-push / CI gate) missed it"
else
	ok "caught it"
fi

echo "6. scrub-history rewrites that commit clean"
yes | scripts/scrub-history.sh HEAD~1..HEAD >/dev/null 2>&1
if scripts/claude-scrub.sh check-revs HEAD~1..HEAD >/dev/null 2>&1; then
	ok "clean after rewrite"
else
	no "still dirty after scrub-history"
fi

echo "7. an ordinary human message survives verbatim"
echo z >>a.txt
git add -A
M=$(printf 'Add hit-testing for freedraw\n\nPoints are sampled at 4px; tolerance follows stroke width so thin\nstrokes stay selectable.\n\nRefs #12')
git commit -q -m "$M" >/dev/null 2>&1
got=$(git log -1 --format=%B | sed -e '$ {/^$/d;}')
if [ "$got" = "$M" ]; then
	ok "preserved verbatim"
else
	printf "  got:  [%s]\n  want: [%s]\n" "$got" "$M"
	no "message was altered"
fi

echo "8. Claude Code PreToolUse guard blocks / allows the right commands"
G="$SRC/.claude/hooks/guard-git-attribution.sh"
if [ -x "$G" ] && command -v jq >/dev/null 2>&1; then
	probe() { # <expected-exit> <label> <command>
		exp=$1
		lbl=$2
		c=$3
		got=0
		printf '%s' "$c" | jq -Rs '{tool_name:"Bash",tool_input:{command:.}}' | "$G" >/dev/null 2>&1 || got=$?
		if [ "$got" = "$exp" ]; then ok "$lbl"; else no "$lbl (exit $got, wanted $exp)"; fi
	}
	probe 2 "blocks a commit carrying a co-author trailer" 'git commit -m "Add cache

Co-Authored-By: Claude <noreply@anthropic.com>"'
	probe 2 "blocks --no-verify" 'git commit --no-verify -m "Add cache"'
	probe 2 "blocks an assistant author identity" 'git -c user.email=noreply@anthropic.com commit -m "Add cache"'
	probe 2 "blocks moving core.hooksPath away" 'git config core.hooksPath /dev/null'
	probe 0 "allows an ordinary commit" 'git commit -m "Add hit-testing for freedraw"'
	probe 0 "allows unrelated git commands" 'git status && git log --oneline -5'
	probe 2 "blocks a gh pr body with attribution" 'gh pr create --title x --body "Adds a cache

Co-Authored-By: Claude <noreply@anthropic.com>"'
	probe 0 "allows an ordinary gh pr body" 'gh pr create --title x --body "Adds a bounds cache."'
else
	echo "  SKIP  guard hook or jq unavailable"
fi

echo "9. Claude Code PostToolUse verifier flags a dirty HEAD"
V="$SRC/.claude/hooks/verify-last-commit.sh"
if [ -x "$V" ] && command -v jq >/dev/null 2>&1; then
	# HEAD is currently clean
	rc=0
	jq -n --arg c "git commit -m x" --arg d "$T" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' | "$V" >/dev/null 2>&1 || rc=$?
	[ "$rc" = "0" ] && ok "quiet on a clean HEAD" || no "false positive on a clean HEAD (exit $rc)"

	echo w >>a.txt
	git add -A
	git -c core.hooksPath=/dev/null commit -q --no-verify \
		-m "$(printf 'Dirty head\n\nCo-authored-by: Claude <noreply@anthropic.com>\n')" >/dev/null 2>&1
	rc=0
	jq -n --arg c "git commit -m x" --arg d "$T" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' | "$V" >/dev/null 2>&1 || rc=$?
	[ "$rc" = "2" ] && ok "blocks and reports a dirty HEAD" || no "missed a dirty HEAD (exit $rc)"
	git reset -q --hard HEAD~1
else
	echo "  SKIP  verifier hook or jq unavailable"
fi

echo ""
if [ $fail -eq 0 ]; then
	echo "all $pass checks passed"
else
	echo "$fail of $((pass + fail)) checks FAILED"
	exit 1
fi
