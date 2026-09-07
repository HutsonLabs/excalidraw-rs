#!/bin/sh
# claude-scrub.sh — single source of truth for removing AI-assistant attribution
# from commit messages, and for detecting it when it slips through.
#
# Usage:
#   claude-scrub.sh scrub-file <path>        rewrite a commit-message file in place
#   claude-scrub.sh check-file <path>        exit 1 if the file still mentions Claude
#   claude-scrub.sh check-text               same, reading the message on stdin
#   claude-scrub.sh check-identity <n> <e>   exit 1 if an author/committer looks like Claude
#   claude-scrub.sh check-commit <rev>       message + author + committer for one commit
#   claude-scrub.sh check-revs <rev-list...> check-commit over `git rev-list <args>`
#
# Escape hatch: ALLOW_CLAUDE_MENTION=1 permits prose that legitimately names
# Claude (e.g. "add Claude API client"). It never permits attribution trailers —
# those are always stripped by scrub-file regardless.

set -eu

PERL=${PERL:-perl}

# Lines that are pure attribution. Always removed, never negotiable.
scrub_stream() {
	$PERL -CSD -e '
		my @in = <STDIN>;
		my @head = @in;
		my $tail = "";
		# Preserve everything from a scissors line onward verbatim (git commit -v).
		for my $i (0 .. $#in) {
			if ($in[$i] =~ /^\s*#?\s*-+\s*>8\s*-+/) {
				@head = @in[0 .. $i - 1];
				$tail = join("", @in[$i .. $#in]);
				last;
			}
		}

		my @drop = (
			qr/^\s*(?:co-authored-by|co-committed-by|signed-off-by|assisted-by|helped-by|generated-by|created-by|written-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|author)\s*:\s*.*(?:claude|anthropic)/i,
			qr/^\s*\S{0,4}\s*(?:generated|authored|written|created|produced)\s+(?:with|by|using)\b.{0,40}claude/i,
			qr/claude\.ai\/code/i,
			qr/claude\.com\/claude-code/i,
			qr/anthropic\.com/i,
			qr/^\s*\x{1F916}.*(?:claude|generated|anthropic)/i,
			qr/^\s*(?:via|with|using|by)\s+claude(?:\s+code)?\s*[.!]?\s*$/i,
			qr/^\s*\[?claude(?:\s+code)?\]?\s*$/i,
		);

		my @kept;
		LINE: for my $l (@head) {
			if ($l !~ /^#/) {
				for my $re (@drop) { next LINE if $l =~ $re; }
			}
			push @kept, $l;
		}

		my $text = join("", @kept);
		$text =~ s/\n{3,}/\n\n/g;             # collapse gaps left by removals
		$text =~ s/\s+\z/\n/;                 # trim trailing whitespace
		$text = "" if $text =~ /^\s*\z/;
		print $text, $tail;
	'
}

# Non-comment, non-scissors body only — what git will actually store.
message_body() {
	$PERL -e '
		while (my $l = <STDIN>) {
			last if $l =~ /^\s*#?\s*-+\s*>8\s*-+/;
			next if $l =~ /^#/;
			print $l;
		}
	'
}

report() {
	printf "%s\n" "$1" >&2
}

check_text() {
	body=$(message_body)
	rc=0

	# Attribution is fatal, always.
	hits=$(printf "%s\n" "$body" | grep -inE \
		'^[[:space:]]*(co-authored-by|co-committed-by|signed-off-by|assisted-by|helped-by|generated-by|created-by|written-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|author)[[:space:]]*:.*(claude|anthropic)|generated with.*claude|claude\.ai/code|claude\.com/claude-code|anthropic\.com' \
		|| true)
	if [ -n "$hits" ]; then
		report "  AI attribution found in commit message:"
		printf "%s\n" "$hits" | sed 's/^/    /' >&2
		rc=1
	fi

	# Bare mentions are fatal unless explicitly allowed.
	if [ "${ALLOW_CLAUDE_MENTION:-0}" != "1" ]; then
		mentions=$(printf "%s\n" "$body" | grep -inE 'claude|anthropic' || true)
		if [ -n "$mentions" ] && [ -z "$hits" ]; then
			report "  Commit message mentions Claude/Anthropic:"
			printf "%s\n" "$mentions" | sed 's/^/    /' >&2
			report "  If the mention is a genuine part of the change, re-run with ALLOW_CLAUDE_MENTION=1."
			rc=1
		fi
	fi

	return $rc
}

check_identity() {
	name=${1:-}
	email=${2:-}
	label=${3:-identity}
	if printf "%s %s" "$name" "$email" | grep -iqE 'claude|anthropic'; then
		report "  $label is attributed to Claude: $name <$email>"
		return 1
	fi
	return 0
}

check_commit() {
	rev=$1
	rc=0
	subject=$(git log -1 --format='%h %s' "$rev")
	out=$(git log -1 --format='%B' "$rev" | check_text 2>&1) || rc=1
	an=$(git log -1 --format='%an' "$rev"); ae=$(git log -1 --format='%ae' "$rev")
	cn=$(git log -1 --format='%cn' "$rev"); ce=$(git log -1 --format='%ce' "$rev")
	idout=""
	idout="$idout$(check_identity "$an" "$ae" "Author" 2>&1)" || rc=1
	idout="$idout$(check_identity "$cn" "$ce" "Committer" 2>&1)" || rc=1
	if [ $rc -ne 0 ]; then
		report "commit $subject"
		[ -n "$out" ] && printf "%s\n" "$out" >&2
		[ -n "$idout" ] && printf "%s\n" "$idout" >&2
	fi
	return $rc
}

cmd=${1:-}
[ $# -gt 0 ] && shift

case "$cmd" in
scrub-file)
	f=$1
	tmp="$f.claude-scrub.$$"
	scrub_stream <"$f" >"$tmp"
	mv "$tmp" "$f"
	;;
check-file)
	check_text <"$1"
	;;
check-text)
	check_text
	;;
check-identity)
	check_identity "${1:-}" "${2:-}" "${3:-Identity}"
	;;
check-commit)
	check_commit "$1"
	;;
check-revs)
	rc=0
	revs=$(git rev-list "$@" 2>/dev/null || true)
	for r in $revs; do
		check_commit "$r" || rc=1
	done
	exit $rc
	;;
*)
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit 2
	;;
esac
