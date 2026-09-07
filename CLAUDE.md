# CLAUDE.md

## Commit authorship — non-negotiable

Commits in this repository are authored by the human running the session, and by
nobody else. When you write a commit message:

- **No co-author trailer.** Never add a `Co-Authored-By:` line, for Claude or any
  other assistant.
- **No generator line.** Never add "Generated with Claude Code", a robot emoji, or a link
  to claude.ai / claude.com.
- **No assistant identity.** Never set `user.name`, `user.email`, or `--author`
  to Claude or Anthropic.
- **No `--no-verify` / `-n`.** The hooks below are the enforcement; do not
  bypass them. If a hook rejects a message, fix the message.

Write the commit message as the description of the change itself: what changed
and why. Nothing about how it was produced.

## How this is enforced

Four independent layers, so no single failure lets attribution through:

| Layer | File | What it does |
| --- | --- | --- |
| Claude Code PreToolUse | `.claude/hooks/guard-git-attribution.sh` | Blocks the `git commit` tool call before it runs if the message carries attribution, if `--no-verify` is present, or if the author identity is being set to an assistant. |
| Claude Code PostToolUse | `.claude/hooks/verify-last-commit.sh` | Re-reads `HEAD` after every commit and tells Claude to `--amend` if anything survived. |
| Git hooks | `.githooks/*` | `prepare-commit-msg` and `commit-msg` strip attribution lines out of the message file; `commit-msg` and `pre-commit` then reject the commit if attribution or an assistant identity remains; `pre-push` scans every outgoing commit; `applypatch-msg` covers `git am`. |
| CI | `.github/workflows/no-ai-attribution.yml` | Fails the build on any pushed or PR commit whose message, author, or committer names an assistant. |

The `PreToolUse` guard also covers `gh pr` / `gh issue` / `gh release` bodies —
a pull request description is as public as a commit.

The stripping logic lives in exactly one place: `scripts/claude-scrub.sh`.

Verify all of it at any time (also runs in CI):

```sh
scripts/selftest-hooks.sh
```

## Setup

The git hooks live in `.githooks/` and are activated by
`git config core.hooksPath .githooks`. Run once per clone:

```sh
scripts/install-hooks.sh
```

The `SessionStart` hook in `.claude/settings.json` runs this automatically, so a
Claude Code session always has the gates active.

## Fixing history

If attribution already landed in a commit:

```sh
scripts/scrub-history.sh origin/main..HEAD   # rewrites messages + identities
scripts/check-no-ai-attribution.sh HEAD      # verify
```

## Escape hatch

A commit that legitimately needs to *name* Claude in prose (e.g. "add Claude API
client") is rejected by default, because the check cannot tell prose from
attribution. Allow it deliberately:

```sh
ALLOW_CLAUDE_MENTION=1 git commit -m "add Claude API client"
```

This never permits attribution trailers or generator lines — those are stripped
unconditionally.
