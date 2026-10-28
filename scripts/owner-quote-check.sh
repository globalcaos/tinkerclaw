#!/usr/bin/env bash
# FORK 2026-10-28 — refuse added lines that paste the owner's words into the repo (CLAUDE.md § "Never
# paste the owner's words into the repo"). The repo is public and the sanitizer only swaps names, so a
# quoted prompt ships its content as is. Reads a unified diff on stdin; exits 1 and lists the lines on a hit.
# Bypass for a deliberate, reviewed case: OWNER_QUOTE_GUARD=off.
set -euo pipefail
# Drain stdin before leaving: the hook pipes `git diff` in under pipefail, and an unread pipe fails it.
if [[ "${OWNER_QUOTE_GUARD:-}" == "off" ]]; then cat >/dev/null; exit 0; fi
WHO='(?:the architect|[Tt]he principal|\(principal|[Tt]he architect|[Tt]he owner|\(owner|\(the user|[Tt]he user, 20[0-9-]+)'
# "the user" only in the possessive form: upstream prompts legitimately say 'Ask the user: "…"'.
RE="${WHO}(?:'s)?(?: (?:said|asked|wrote|wants?|requested|insisted|noted|added|on [0-9-]+))?[^\"\\n]{0,60}[:,]\\s*[*_]*[\"“]|in (?:the architect|the architect|the owner|the user)'s (?:own )?words"
diff_lines=$(awk '
  /^\+\+\+ / { f = substr($0, 7); next }
  /^\+/ && f != "CLAUDE.md" && f != "AGENTS.md" && f !~ /owner-quote-check/ { print f ": " substr($0, 2) }
')
hits=$(printf '%s\n' "$diff_lines" | grep -P -- "$RE" || true)
# FORK 2026-10-28: an unnamed quote is still the owner's words. In docs and comment lines, refuse a
# quoted sentence spoken in first or second person.
SPOKEN='["“](?:I|I'"'"'m|I'"'"'ve|I'"'"'d|My|We|You|Let'"'"'s|Please|Why|Can you|Make|Don'"'"'t)\b[^"”]{12,}'
spoken=$(printf '%s\n' "$diff_lines" | awk -F': ' '{f=$1; l=substr($0, length(f)+3); if (f ~ /\.(md|txt)$/ || l ~ /^[[:space:]]*(\/\/|\*|#|<!--)/) print}' | grep -P -- "$SPOKEN" || true)
hits=$(printf '%s\n%s' "$hits" "$spoken" | sed '/^$/d')
if [[ -n "$hits" ]]; then
  echo "🛑 owner-quote-check: these added lines paste the owner's words; describe the need in neutral words instead:" >&2
  echo "$hits" | head -20 >&2
  exit 1
fi
