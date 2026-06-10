#!/usr/bin/env bash
# ORCA cross-session file-lease hook.
#
# Ships as part of the tinkerclaw-orca extension (tracked + public). Activate it
# by wiring it into a Claude Code settings file (e.g. .claude/settings.local.json,
# which is gitignored — so activation is per-machine, the tool itself is shared):
#   • PreToolUse on Edit|Write|MultiEdit — claim a per-file lease before an edit.
#   • Stop                               — release everything this session held.
# (Do NOT wire SubagentStop — see the Stop branch below.)
#
# Goal: when several Claude Code sessions (or Jarvis, or ORCA runs) work the SAME
# tree, serialize edits PER FILE with fast handoff — no branches, no merges. The
# source of truth is atomic on-disk leases (lease-core.mjs, co-located, run here
# as a CLI); the gateway is never in the path, so a down gateway never blocks an edit.
#
# Modes (env ORCA_LEASE_MODE, default "warn"):
#   off      — do nothing; allow every edit.
#   warn     — allow every edit, but print a warning when another live session
#              already holds the file (safe rollout: never surprises a peer).
#   enforce  — DENY (exit 2) an edit to a file another live session holds.
#
# FAIL-OPEN by construction: any error (no git repo, missing node/lease-core,
# unparsable input, usage error) allows the edit. The lease system makes editing
# SAFER; it must never make editing IMPOSSIBLE.
#
# Knobs: ORCA_LEASE_TTL_MS (default 120000), ORCA_LEASE_ROOT (override lease dir).
set -uo pipefail

MODE="${ORCA_LEASE_MODE:-warn}"
[ "$MODE" = "off" ] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEASE_CORE="$HOOK_DIR/lease-core.mjs"
TTL_MS="${ORCA_LEASE_TTL_MS:-120000}"

# Optional isolated lease root (tests / alternate location).
ROOT_ARGS=()
[ -n "${ORCA_LEASE_ROOT:-}" ] && ROOT_ARGS=(--root "$ORCA_LEASE_ROOT")

INPUT="$(cat)"

# Pull the fields we need as NUL-delimited values, so a field that itself contains
# spaces OR newlines (e.g. an exotic file_path) can never desync the parse. Each
# `read -r -d ''` consumes up to the next NUL. Fail-open on any parse error.
EVENT=""
TOOL=""
SESSION=""
FILE=""
CWD=""
{
  IFS= read -r -d '' EVENT
  IFS= read -r -d '' TOOL
  IFS= read -r -d '' SESSION
  IFS= read -r -d '' FILE
  IFS= read -r -d '' CWD
} < <(
  printf '%s' "$INPUT" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ev = d.get("hook_event_name") or ""
tool = d.get("tool_name") or ""
sess = d.get("session_id") or ""
fp = (d.get("tool_input") or {}).get("file_path") or ""
cwd = d.get("cwd") or ""
sys.stdout.write("\0".join([ev, tool, sess, fp, cwd]))
' 2>/dev/null
) || true
[ -z "$EVENT" ] && [ -z "$SESSION" ] && exit 0 # parse produced nothing → fail-open

# Common preconditions: we need node + the lease core, else fail-open.
command -v node >/dev/null 2>&1 || exit 0
[ -f "$LEASE_CORE" ] || exit 0

# ── Stop: release every lease this session still holds ────────────────────────
# Only the top-level session Stop releases. NOT SubagentStop: a Task subagent
# finishing does not mean the session is done editing, and subagents may share
# the parent's session_id — releasing on SubagentStop would free the parent's
# LIVE leases mid-flight. A subagent's own leases are reclaimed by TTL instead.
if [ "$EVENT" = "Stop" ]; then
  [ -z "${SESSION:-}" ] && exit 0
  node "$LEASE_CORE" release-all --owner "$SESSION" "${ROOT_ARGS[@]}" >/dev/null 2>&1 || true
  exit 0
fi
# A SubagentStop (or any non-PreToolUse event that slipped through) is a no-op.
if [ "$EVENT" != "PreToolUse" ]; then exit 0; fi

# ── PreToolUse(Edit|Write|MultiEdit): claim the file before the edit ───────────
[ -z "${SESSION:-}" ] && exit 0 # no owner key → can't lease → allow
[ -z "${FILE:-}" ] && exit 0    # nothing to lease → allow

# Anchor the git lookup at the nearest EXISTING ancestor DIRECTORY of FILE — a
# Write/MultiEdit may be CREATING the file (and even its parent dirs), so dirname
# may not exist yet. Fall back to the session cwd. realpath -m resolves a target
# whose path does not exist yet.
ANCHOR="$(dirname "$FILE")"
while [ -n "$ANCHOR" ] && [ ! -d "$ANCHOR" ] && [ "$ANCHOR" != "/" ]; do
  ANCHOR="$(dirname "$ANCHOR")"
done
[ -d "$ANCHOR" ] || ANCHOR="${CWD:-$PWD}"
REPO="$(git -C "$ANCHOR" rev-parse --show-toplevel 2>/dev/null)" || REPO=""
[ -z "$REPO" ] && exit 0 # not in a git repo → fail-open
REL="$(realpath -m --relative-to="$REPO" "$FILE" 2>/dev/null)" || REL=""
[ -z "$REL" ] && exit 0

OUT="$(node "$LEASE_CORE" acquire \
  --repo "$REPO" --path "$REL" --owner "$SESSION" \
  --intent "${TOOL:-edit}" --ttl "$TTL_MS" "${ROOT_ARGS[@]}" 2>/dev/null)"
RC=$?

# Exit 0 = we hold the lease (won or refreshed) → allow.
[ "$RC" -eq 0 ] && exit 0

# Exit 3 = DENIED: another live session holds this file.
if [ "$RC" -eq 3 ]; then
  HOLDER="$(
    printf '%s' "$OUT" | python3 -c '
import sys, json, re
try:
    h = (json.load(sys.stdin).get("holder") or {})
    who = h.get("owner") or "?"
    intent = h.get("intent") or ""
    s = who + (" ("+intent+")" if intent else "")
    # Holder fields are untrusted (any process can write a lease file). Strip
    # ASCII control chars (incl. ESC) so a crafted owner/intent cannot inject
    # terminal escape sequences into this banner; cap the length.
    s = re.sub(r"[\x00-\x1f\x7f]", "", s)[:200]
    sys.stdout.write(s or "another session")
except Exception:
    sys.stdout.write("another session")
' 2>/dev/null
  )"
  [ -z "$HOLDER" ] && HOLDER="another session"
  if [ "$MODE" = "enforce" ]; then
    {
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "🔒 [orca-lease] BLOCKED: $REL is held by $HOLDER"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "Another live session is editing this file. Wait for it to release"
      echo "(its lease expires after ${TTL_MS}ms of inactivity, or on its Stop),"
      echo "then retry. To override for this shell: export ORCA_LEASE_MODE=warn"
    } >&2
    exit 2
  fi
  echo "⚠️  [orca-lease] $REL is also held by $HOLDER — editing anyway (warn mode)." >&2
  exit 0
fi

# RC == 1 or anything else → infra/usage error → FAIL OPEN.
exit 0
