#!/usr/bin/env bash
#
# rebuild-and-restart.sh — the full rebuild behind the Tinker restart button (next to ▶ in the
# SESSIONS header) and the agent skill `tinker-rebuild full`.
#
#   1. build the committed `develop` in a clean detached worktree and gate it
#      (scripts/deploy-worktree.sh --dry-run --keep-worktree);
#   2. build that worktree's Tinker UI;
#   3. stage both for the next gateway start (the ExecStartPre staged-build hook swaps the gateway
#      first, then the UI);
#   4. restart through the host's gateway-restart skill (freeze-thaw), which drains every live
#      turn to its next model call first and continues it afterwards (bible lifecycles.md L4b).
#
# Nothing touches the running gateway until the build has passed its gates. Where the restart
# skill is not installed, the classic deploy (deploy-worktree.sh without --dry-run) swaps and
# restarts by itself.
#
# USAGE
#   scripts/rebuild-and-restart.sh [--reason <text>] [--origin <sessionKey>]
#                                  [--requester <text>] [--force] [--no-wait]
#     --reason     shown in the restart notice of every chat the restart pauses
#     --origin     the chat that asked: the restart waits for its turn to end, then reports to it
#     --requester  who asked, in words a person reads; recorded in the disruption ledger and the
#                  restart history (2026-10-03: many restarts could not be pinned on anyone)
#     --force      skip the skill's restart-loop guard (a click on the page is the owner's own hand;
#                  an agent never passes it: the guard stops a resumed chat restarting in a loop)
#     --no-wait    return once the restart is handed to its own systemd unit
#
# Progress lines "── phase N: … ──" are what the button's hover shows as "Now:".
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}"
SKILL="${TINKER_FREEZE_THAW_SCRIPT:-$HOME/.openclaw/workspace/skills/freeze-thaw/scripts/freeze_thaw.py}"
REASON="rebuild from Tinker"
ORIGIN=""
REQUESTER=""
FORCE=()
WAIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --reason) REASON="${2:-}"; shift 2 ;;
    --origin) ORIGIN="${2:-}"; shift 2 ;;
    --requester) REQUESTER="${2:-}"; shift 2 ;;
    --force) FORCE=(--force); shift ;;
    --no-wait) WAIT=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
say() { echo "[rebuild] $(date '+%H:%M:%S') $*"; }

SHA="$(git -C "$REPO" rev-parse --verify develop 2>/dev/null)" || { say "no develop branch"; exit 2; }
SHORT="${SHA:0:11}"
REASON="$REASON (develop $SHORT)"

if [ ! -f "$SKILL" ]; then
  say "the gateway-restart skill is not installed here: classic deploy (build, gates, swap, restart)"
  exec bash "$REPO/scripts/deploy-worktree.sh" --sha "$SHA"
fi

BUILD_LOG="$(mktemp)"
trap 'rm -f "$BUILD_LOG"' EXIT
bash "$REPO/scripts/deploy-worktree.sh" --sha "$SHA" --dry-run --keep-worktree 2>&1 | tee "$BUILD_LOG"
rc=${PIPESTATUS[0]}
if [ "$rc" -ne 0 ]; then
  say "build FAILED (deploy-worktree exit $rc); the running gateway was not touched"
  exit "$rc"
fi
WT="$(grep -oE 'keeping worktree at [^ ]+' "$BUILD_LOG" | tail -1 | awk '{print $4}')"
if [ -z "$WT" ] || [ ! -d "$WT" ]; then
  say "could not find the kept build worktree in the build log"
  exit 3
fi

echo "── phase 3: build the Tinker UI of $SHORT ──"
if ! (cd "$WT/tinker-ui" && npx vite build 2>&1 | tail -4); then
  say "UI build FAILED; the running gateway was not touched (build kept at $WT)"
  exit 4
fi
if [ ! -f "$WT/tinker-ui/dist/index.html" ]; then
  say "UI build left no index.html; the running gateway was not touched"
  exit 4
fi

echo "── phase 4: stage $SHORT for the next gateway start ──"
mkdir -p "$STATE/tinkerclaw"
printf '%s\n%s\n' "$WT" "$SHA" > "$STATE/tinkerclaw/staged-build"
say "staged $WT"

echo "── phase 5: restart through the gateway-restart skill ──"
FT_LOG="$STATE/freeze-thaw/freeze-thaw.log"
FROM=$(stat -c %s "$FT_LOG" 2>/dev/null || echo 0)
START=$FROM
ORIGIN_ARG=()
[ -n "$ORIGIN" ] && ORIGIN_ARG=(--origin "$ORIGIN")
REQUESTER_ARG=()
[ -n "$REQUESTER" ] && REQUESTER_ARG=(--requester "$REQUESTER")
HANDOFF="$(python3 "$SKILL" restart --detach "${FORCE[@]}" "${ORIGIN_ARG[@]}" "${REQUESTER_ARG[@]}" --reason "$REASON" 2>&1)"
hrc=$?
echo "$HANDOFF"
UNIT="$(grep -oE 'gateway-restart-[0-9]+' <<<"$HANDOFF" | head -1)"
if [ "$hrc" -ne 0 ] || [ -z "$UNIT" ]; then
  say "the restart skill did not start (exit $hrc); the build stays staged for the next gateway start"
  exit 5
fi
if [ "$WAIT" -eq 0 ]; then
  say "restart handed to $UNIT; the build is staged and goes live with it"
  exit 0
fi

# Follow the skill's log until its unit ends: every line it writes is progress for the hover.
follow() {
  local size
  size=$(stat -c %s "$FT_LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$FROM" ]; then
    tail -c +"$((FROM + 1))" "$FT_LOG" | head -c "$((size - FROM))"
    FROM=$size
  fi
}
for _ in $(seq 1 900); do
  follow
  state="$(systemctl --user is-active "$UNIT" 2>/dev/null)"
  [ "$state" = active ] || [ "$state" = activating ] || break
  sleep 2
done
follow
VERDICT="$(tail -c +"$((START + 1))" "$FT_LOG" 2>/dev/null | grep -E "restarted [0-9-]+: |restart FAILED" | tail -1)"
if grep -q "did NOT apply" <<<"$VERDICT"; then
  say "the gateway came back, but NOT on the new build: ${VERDICT#* restarted }"
  exit 7
fi
if grep -q "Gateway healthy" <<<"$VERDICT"; then
  say "done: ${VERDICT#* restarted }"
  exit 0
fi
say "restart did not report healthy: ${VERDICT:-no verdict in the skill log}"
exit 6
