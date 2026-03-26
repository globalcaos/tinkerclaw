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
#   gateway-full-restart.sh --note "resume X work"   # Write wake note, then restart

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Handle --note flag: write HEARTBEAT.md so agent resumes after restart
WAKE_NOTE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --note) WAKE_NOTE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

STATE_DIR="${HOME}/.openclaw"
RESUME_FILE="${STATE_DIR}/session-resume.json"

# If wake note provided, use stop-write-start pattern to prevent heartbeat overwriting sentinel
if [ -n "$WAKE_NOTE" ]; then
  log "Stop-write-start with wake note: $WAKE_NOTE"
  
  # Stop first (kills all in-flight get-reply calls that could overwrite sentinel)
  systemctl --user stop openclaw-gateway 2>/dev/null || true
  sleep 1
  
  # Write sentinel while gateway is dead
  cat > "$RESUME_FILE" << EOF
{
  "version": 1,
  "payload": {
    "ts": $(date +%s000),
    "sessionKey": "agent:main:main",
    "userMessage": "$WAKE_NOTE",
    "deliveryContext": { "channel": "webchat" }
  }
}
EOF
  log "Sentinel written"
  
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
if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
  log "Restarting via systemctl..."
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
