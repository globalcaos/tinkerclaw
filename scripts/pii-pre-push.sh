#!/usr/bin/env bash
# FORK 2026-05-11 / hardened 2026-05-13 — PII leak grep for the public
# tinkerclaw fork.
#
# Runs on every push (via git-hooks/pre-push). Greps the commits about to
# be pushed for the private-token regex from CLAUDE.md and the bible's
# pii-boundary.md. Blocks the push if any match.
#
# Two scopes (BOTH must be clean — design-principle #17 made this load-bearing):
#   1. push-range: every commit being pushed (catches the obvious case).
#   2. accumulated-drift: every commit on the pushed branch that is not
#      yet on origin/main (catches PII that was already on develop and
#      would advance to main on a future merge).
#
# The accumulated-drift scope is what caught the 2026-05-13 incident —
# 16 PII hits had landed on origin/develop across earlier pushes (each
# of which was individually clean within its own push-range). Hardening
# now scans against `origin/main` whenever pushing to develop, so the
# accumulated state is checked at every push.
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
#   - First-name narrative use: "<FirstName> said …", "<FirstName> wants …", etc.
#     Detected by the lookahead "the user(?! Serra)" so "Oscar Serra" passes.
#   - Family/contact first names
#   - Location strings
#   - Host paths
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

# Self-exclusion: files that intentionally document the regex (or use
# `<FirstName>` placeholder patterns to illustrate the rule) are excluded
# from the diff scan.
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

scan_range() {
  local range="$1"
  local label="$2"
  local mode="${3:-log}"  # "log" = per-commit additions; "diff" = cumulative net state
  local diff_output
  if [[ "$mode" == "diff" ]]; then
    # Cumulative net diff: what changes if we merge `range`-end into `range`-base?
    # Add-then-remove cancels out. This is the correct semantics for "advancing
    # main"-style checks — we only care about the new public state, not the
    # transient history of PII inside develop.
    local base_ref="${range%%..*}"
    local tip_ref="${range##*..}"
    diff_output=$(git -C "$ROOT_DIR" diff "$base_ref" "$tip_ref" -- "${exclude_paths[@]}" 2>/dev/null) || true
  else
    diff_output=$(git -C "$ROOT_DIR" log -p --no-merges "${range}" -- "${exclude_paths[@]}" 2>/dev/null) || true
  fi
  if [[ -z "$diff_output" ]]; then
    return 0
  fi
  # Match only added lines (+) and skip diff hunk headers (+++)
  local matches
  matches=$(echo "$diff_output" | grep -P "^\+[^+].*(${PII_RE})" || true)
  if [[ -n "$matches" ]]; then
    local n
    n=$(echo "$matches" | wc -l)
    hit_count=$((hit_count + n))
    hit_buffer+="--- ${label} (range: ${range}, mode: ${mode}) — ${n} hits ---"$'\n'
    hit_buffer+="$matches"$'\n'
  fi
}

# Scope 1 — push range (every commit being pushed).
for range in "${ranges[@]}"; do
  scan_range "$range" "push-range"
done

# Scope 2 — accumulated drift against origin/main (FORK 2026-05-13).
# When pushing to develop, what would the NET cumulative state look like
# if main merged this snapshot? Use `git diff origin/main HEAD` semantics
# (mode=diff) so add-then-remove cancels out: a leak that was introduced
# in commit A and removed in commit B (both within the develop history)
# is NOT a regression — main inherits the clean state. The earlier
# attempt used `git log -p` which conflates "history" with "destination
# state" and false-positives on cleaned-up historical leaks.
if git -C "$ROOT_DIR" rev-parse --verify origin/main >/dev/null 2>&1; then
  for range in "${ranges[@]}"; do
    local_sha="${range##*..}"
    drift_range="origin/main..${local_sha}"
    # Skip if local_sha is already at or behind origin/main (the merge
    # would be a no-op anyway).
    if git -C "$ROOT_DIR" merge-base --is-ancestor "$local_sha" origin/main 2>/dev/null; then
      continue
    fi
    scan_range "$drift_range" "accumulated-drift-vs-origin/main" "diff"
  done
fi

if [[ "$hit_count" -gt 0 ]]; then
  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "🛑 BLOCKED: Push contains $hit_count PII match(es)" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2
  echo "First 30 hits (across scopes):" >&2
  echo "$hit_buffer" | head -30 >&2
  echo "" >&2
  echo "Scopes checked:" >&2
  echo "  1. push-range (commits being pushed now)" >&2
  echo "  2. accumulated-drift vs origin/main (catches earlier-merged PII)" >&2
  echo "" >&2
  echo "If this is intentional (e.g. adding 'Oscar Serra' byline), bypass with:" >&2
  echo "    PII_GUARD=off git push …" >&2
  echo "" >&2
  echo "See TINKER_UI_DESIGN_BIBLE/pii-boundary.md for the full rule and" >&2
  echo "design-principles.md #17 for why this gate is load-bearing." >&2
  exit 1
fi

exit 0
