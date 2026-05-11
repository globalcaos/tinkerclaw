#!/usr/bin/env bash
# FORK 2026-05-11 — PII leak grep for the public tinkerclaw fork.
#
# Runs on every push (via git-hooks/pre-push). Greps the commits about to
# be pushed for the private-token regex from CLAUDE.md and the bible's
# pii-boundary.md. Blocks the push if any match.
#
# Bypass for genuine intentional inclusions (e.g. when the maintainer's
# full name is the byline being added):
#     PII_GUARD=off git push …
#
# Public-OK tokens (do not match):
#   - "Oscar Serra" (full name, OSS author byline allowed)
#   - "globalcaos" (the GitHub handle, already public on URL/badges/org)
#
# Private tokens (do match — block push):
#   - First-name narrative use: "the user said …", "the user wants …", etc.
#     Detected by the lookahead "the user(?! Serra)" so "Oscar Serra" passes.
#   - Family/contact first names ("Xavi", "Xavier", "REDACTED-NAME")
#   - Location ("Barcelona")
#   - Host paths (`/home/<user>/`)
#   - Business contact tokens, GitLab tokens, work email
#
# Exits 0 if clean, 1 if hits.

set -euo pipefail

if [[ "${PII_GUARD:-}" == "off" ]]; then
  echo "[pii-pre-push] PII_GUARD=off — skipping leak grep (bypass acknowledged)" >&2
  exit 0
fi

ROOT_DIR="$(git rev-parse --show-toplevel)"

# stdin from git pre-push has lines: <local_ref> <local_sha> <remote_ref> <remote_sha>
# We need the commit range for each ref being pushed.
declare -a ranges=()
while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ -z "${local_sha:-}" ]] || [[ "$local_sha" == "0000000000000000000000000000000000000000" ]]; then
    continue  # deletion
  fi
  if [[ -z "${remote_sha:-}" ]] || [[ "$remote_sha" == "0000000000000000000000000000000000000000" ]]; then
    # new branch — scan all commits not already on any other remote ref
    ranges+=("$local_sha")
    continue
  fi
  ranges+=("${remote_sha}..${local_sha}")
done

if [[ "${#ranges[@]}" -eq 0 ]]; then
  exit 0
fi

# Self-exclusion: this script intentionally documents the regex; the
# pii-boundary.md spec file does too. Exclude both from the diff scan.
declare -a exclude_paths=(
  ":(exclude)scripts/pii-pre-push.sh"
  ":(exclude)TINKER_UI_DESIGN_BIBLE/pii-boundary.md"
  ":(exclude)CLAUDE.md"
)

# Pattern: full name "Oscar Serra" is allowed (Perl lookahead). The other
# tokens are simple. ugrep is not used because not all dev hosts have it.
# Use grep -P (PCRE) which supports lookbehind/lookahead.
PII_RE='the user(?! Serra)|Xavi[er]?\b|REDACTED-NAME|Barcelona|/home/<user>|talleres serra|hikrobot|glpat-|oserra@'

hit_count=0
hit_buffer=""

for range in "${ranges[@]}"; do
  # diff produces unified diff; grep finds matches on ADDED lines only (lines starting with +).
  diff_output=$(git -C "$ROOT_DIR" log -p --no-merges "${range}" -- "${exclude_paths[@]}" 2>/dev/null) || true
  if [[ -z "$diff_output" ]]; then
    continue
  fi
  # Match only added lines (+) and skip diff hunk headers (+++)
  matches=$(echo "$diff_output" | grep -P "^\+[^+].*(${PII_RE})" || true)
  if [[ -n "$matches" ]]; then
    hit_count=$((hit_count + $(echo "$matches" | wc -l)))
    hit_buffer+="$matches"$'\n'
  fi
done

if [[ "$hit_count" -gt 0 ]]; then
  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "🛑 BLOCKED: Push contains $hit_count PII match(es)" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2
  echo "First 20 hits:" >&2
  echo "$hit_buffer" | head -20 >&2
  echo "" >&2
  echo "If this is intentional (e.g. adding 'Oscar Serra' byline), bypass with:" >&2
  echo "    PII_GUARD=off git push …" >&2
  echo "" >&2
  echo "See TINKER_UI_DESIGN_BIBLE/pii-boundary.md for the full rule." >&2
  exit 1
fi

exit 0
