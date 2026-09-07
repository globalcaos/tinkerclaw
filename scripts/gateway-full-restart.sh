#!/usr/bin/env bash
# gateway-full-restart.sh — Full process restart (not in-process SIGUSR1).
#
# SIGUSR1 does an in-process restart: same PID, same module cache.
# After a dist rebuild with new content hashes, lazy imports reference
# filenames that no longer exist on disk → ERR_MODULE_NOT_FOUND.
#
# This script does a real systemd restart: kill old process, start fresh.
# Use this after ANY build that touches dist/.
#
# Usage:
#   gateway-full-restart.sh                          # Just restart
#   gateway-full-restart.sh --note "deploy X"        # Same restart, note echoed into the log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --note is accepted for interface compatibility (scripts/deploy-worktree.sh passes it)
# and is echoed into the log so the deploy annotation stays visible.
WAKE_NOTE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --note) WAKE_NOTE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# FORK 2026-07-31 — the wake-note sentinel was REMOVED.
# It used to write $HOME/.openclaw/session-resume.json with a hardcoded main-agent session
# key, so a restart triggered by ANY other session (e.g. a Tinker UI dashboard tab that
# deployed the gateway) pointed the resume at the wrong session. It also wrote the v1
# single-payload shape with `cat >`, clobbering the v2 multi-session file owned by
# src/infra/session-resume.ts. And nothing ever read it: writeSessionResume /
# consumeAllSessionResumes have zero callers in src/.
# Per-session resume is owned by src/agents/main-session-restart-recovery.ts, which at boot
# enumerates every status:"running" session and resumes each one on its own key — no
# sentinel, no hardcoded key. --note is retained for log legibility only.
# The stop-then-start dance stays: a full stop/start (not SIGUSR1) is the whole point of
# this script after a dist rebuild.
if [ -n "$WAKE_NOTE" ]; then
  log "Stop-start with note: $WAKE_NOTE"

  systemctl --user stop openclaw-gateway 2>/dev/null || true

  # Start fresh
  systemctl --user start openclaw-gateway
  sleep 3
  if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
    log "✅ Gateway restarted with wake note"
    exit 0
  fi
  log "❌ Gateway failed to start"
  exit 1
fi

# No wake note — simple restart
#
# FORK 2026-08-24 — this asked `is-active`, which is the WRONG QUESTION, and it took the gateway
# down three times in one afternoon.
#
# `is-active` asks "is the service running RIGHT NOW". The only caller that matters —
# deploy-worktree.sh phase 4 — reaches here immediately after phase 3 has DELIBERATELY stopped the
# service to swap dist underneath it. So the answer is always "no", this branch was always skipped,
# and the direct-process fallback below started an unsupervised gateway that grabbed :18789.
# systemd then could not start its own: EADDRINUSE, unit fails, Restart= kicks in, and the unit
# thrashes in a restart loop while a stray process serves the port. The deploy's own phase-4 check
# then correctly reports `is-active=inactive` and exits rc=40.
#
# The question this branch actually wants is "does a systemd unit EXIST" — if one does, systemd
# must own the process. `is-active` and "exists" only agree when the service happens to be up,
# which is precisely the case this script is never called in.
if systemctl --user cat openclaw-gateway.service >/dev/null 2>&1; then
  log "Restarting via systemctl..."
  # `restart` and not `start`: it is correct for a unit that is already up AND for one that phase 3
  # just stopped, so this single call covers both callers.
  systemctl --user restart openclaw-gateway
  sleep 3
  if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
    log "✅ Gateway restarted (systemd)"
    exit 0
  else
    log "⚠️ systemd restart didn't come back — checking..."
    sleep 5
    if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
      log "✅ Gateway restarted (delayed)"
      exit 0
    fi
    log "❌ Gateway failed to restart"
    exit 1
  fi
fi

# Fallback: direct process kill + restart
log "No systemd service — killing process directly..."
PID=$(pgrep -f 'openclaw.*gateway' | head -1 || true)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
  sleep 2
  # Double-check it's dead
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
  sleep 1
fi

log "Starting gateway..."
nohup openclaw gateway --port "${OPENCLAW_GATEWAY_PORT:-18789}" > /tmp/openclaw-gateway-restart.log 2>&1 &
sleep 3

if pgrep -f 'openclaw.*gateway' > /dev/null 2>&1; then
  log "✅ Gateway restarted (direct)"
  exit 0
fi

log "❌ Gateway failed to start"
exit 1
