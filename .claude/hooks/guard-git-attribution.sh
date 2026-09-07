#!/bin/sh
# Claude Code PreToolUse(Bash) gate.
# Blocks git commands that would credit an AI assistant, or that would bypass
# the repo's git hooks. Exit 2 = block the tool call, stderr goes back to Claude.
#
# Heredoc bodies are excluded from the scan: writing a file that *documents* the
# policy is not the same as committing with it. Commit messages fed through a
# heredoc are still caught by .githooks/commit-msg, which sees the real message.
set -eu

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')
raw=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')

[ "$tool" = "Bash" ] || exit 0
printf '%s' "$raw" | grep -qE '(^|[[:space:]])(git|gh)([[:space:]]|$)' || exit 0

cmd=$(printf '%s' "$raw" | perl -0777 -pe 's/<<-?\s*([\x27"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$//gms')

deny() {
	echo "BLOCKED by .claude/hooks/guard-git-attribution.sh" >&2
	echo "$1" >&2
	exit 2
}

is_git() { printf '%s' "$cmd" | grep -qE "(^|[;&|(]|&&|\|\|)[[:space:]]*(sudo[[:space:]]+)?git[[:space:]]+([-a-zA-Z=/.]+[[:space:]]+)*($1)([[:space:]]|$)"; }

# 1. Attribution embedded in a commit/tag/merge/revert message.
if is_git 'commit|tag|merge|revert|cherry-pick|am|notes'; then
	if printf '%s' "$cmd" | grep -qiE 'co-authored-by|co-committed-by|generated with.*claude|claude\.ai/code|claude\.com/claude-code|noreply@anthropic\.com|🤖'; then
		deny "This commit message credits Claude as a co-author or generator.
Commit messages in this repo carry no AI attribution: no co-author trailer, no
'Generated with Claude Code' line, no robot emoji, no anthropic address.
Rewrite the message with only the human-authored description of the change."
	fi
fi

# 2. Hook bypass — the git hooks are the enforcement, so they stay on.
if is_git 'commit|push|merge'; then
	if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(--no-verify|-n)([[:space:]]|$)'; then
		deny "--no-verify / -n bypasses the commit-msg and pre-push attribution gates.
Run the command without it; if a hook rejects the commit, fix the message."
	fi
fi

# 3. Identity tampering.
if printf '%s' "$cmd" | grep -qiE '(--author|user\.name|user\.email|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL)[^|;]*(claude|anthropic)'; then
	deny "Refusing to set a Claude/Anthropic author or committer identity.
Commits must be authored by the human running this session."
fi

# 4. Disabling the hooks themselves.
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+config[^|;]*core\.hooksPath'; then
	printf '%s' "$cmd" | grep -q '\.githooks' || deny "Refusing to move core.hooksPath away from .githooks — that disables the
attribution gates. Run scripts/install-hooks.sh to restore it."
fi

# 5. GitHub surfaces — a PR body or release note is just as public as a commit.
if printf '%s' "$cmd" | grep -qE "(^|[;&|(]|&&|\\|\\|)[[:space:]]*gh[[:space:]]+(pr|issue|release|gist)[[:space:]]"; then
	if printf '%s' "$cmd" | grep -qiE 'co-authored-by|co-committed-by|generated with.*claude|claude\.ai/code|claude\.com/claude-code|noreply@anthropic\.com|🤖'; then
		deny "This GitHub body credits Claude as an author or generator.
Pull requests, issues and releases in this repo carry no AI attribution.
Describe the change itself, not how it was produced."
	fi
fi

exit 0
