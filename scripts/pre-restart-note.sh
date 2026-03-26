#!/usr/bin/env bash
# pre-restart-note.sh — Instant wake after gateway restart.
#
# Uses systemd-run --user --scope to spawn restart in a SEPARATE cgroup.
# This survives the gateway's KillMode=control-group.
#
# Flow:
#   1. Write sentinel to temp file
#   2. systemd-run spawns transient scope (separate cgroup)
#   3. Scope: stop gateway → copy sentinel → start gateway
#   4. server-startup.ts reads sentinel at +2.5s → agentCommand → instant wake
#
# Usage:
#   bash scripts/pre-restart-note.sh "Resume: fixing WhatsApp"
#   bash scripts/pre-restart-note.sh --clear

set -euo pipefail

STATE_DIR="${HOME}/.openclaw"
RESUME_FILE="${STATE_DIR}/session-resume.json"

if [ "${1:-}" = "--clear" ]; then
  rm -f "$RESUME_FILE"
  rm -f "${HOME}/.openclaw/workspace/memory/restart-state.json"
  echo "Cleared"
  exit 0
fi

NOTE="${1:?Usage: pre-restart-note.sh \"resume note\"}"
SESSION_KEY="${2:-agent:main:main}"
CHANNEL="${3:-webchat}"
TS="$(date +%s)000"

# Write sentinel to temp (scope copies it while gateway is dead)
SENTINEL_TMP="/tmp/openclaw-resume-sentinel.json"
cat > "$SENTINEL_TMP" << EOF
{
  "version": 1,
  "payload": {
    "ts": $TS,
    "sessionKey": "$SESSION_KEY",
    "userMessage": "$NOTE",
    "deliveryContext": {
      "channel": "$CHANNEL"
    }
  }
}
EOF

# Also write work context for richer resume
cat > "${HOME}/.openclaw/workspace/memory/restart-state.json" << EOF
{
  "note": $(python3 -c "import json; print(json.dumps('''$NOTE'''))"),
  "timestamp": "$(date -Iseconds)",
  "sessionKey": "$SESSION_KEY"
}
EOF

# Spawn restart in separate systemd scope (survives cgroup kill)
systemd-run --user --scope --unit=openclaw-restart-wake \
  bash -c "
    sleep 1
    systemctl --user stop openclaw-gateway 2>/dev/null || true
    sleep 2
    cp '$SENTINEL_TMP' '$RESUME_FILE'
    systemctl --user start openclaw-gateway
    echo \"\$(date): Restarted with sentinel\" >> /tmp/pre-restart-note.log
  " >> /tmp/pre-restart-note.log 2>&1 &

echo "Restart in separate scope — gateway stops in ~2s, wakes in ~6s"
