#!/usr/bin/env bash
# cron-health-gate.sh — Self-healing cron health monitor.
#
# Detects issues AND fixes what it can automatically:
#   - memory_search broken (build-hash drift) → full gateway restart
#   - rate_limit errors → log + wait (self-resolving)
#   - consecutive errors → attempt diagnosis + fix
#
# Only escalates to LLM when it can't fix the problem itself.
#
# Usage: */3 * * * * ~/.openclaw/workspace/scripts/cron-health-gate.sh

set -euo pipefail

export PATH="$HOME/.local/share/pnpm:$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"

CRON_STORE="${HOME}/.openclaw/cron/jobs.json"
LOG_FILE="${HOME}/.openclaw/logs/cron-health-gate.log"
LOCK_FILE="/tmp/cron-health-gate.lock"
COOLDOWN_SECONDS=1800
COOLDOWN_FILE="/tmp/cron-health-gate.last-alert"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_HEAL_LOG="${HOME}/.openclaw/logs/self-heal.log"

log() { echo "$(date -Iseconds) $*" >> "$LOG_FILE"; }
heal_log() { echo "$(date -Iseconds) HEAL: $*" >> "$SELF_HEAL_LOG"; }

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$SELF_HEAL_LOG")"

# ── Phase 0: Gateway liveness check (P0 — prevents multi-hour outages) ──
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
if ! curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
  # Double-check with process list
  if ! pgrep -f 'openclaw.*gateway' > /dev/null 2>&1; then
    log "CRITICAL: Gateway process not running — starting"
    heal_log "Gateway dead — auto-starting via systemctl"
    systemctl --user start openclaw-gateway 2>/dev/null || true
    sleep 5
    if pgrep -f 'openclaw.*gateway' > /dev/null 2>&1; then
      heal_log "Gateway auto-started successfully"
      log "HEALED: Gateway auto-started"
    else
      heal_log "Gateway auto-start FAILED"
      log "CRITICAL: Gateway auto-start failed"
    fi
    exit 0
  else
    log "WARN: Gateway process exists but HTTP not responding (may be starting up)"
  fi
fi

if [ ! -f "$CRON_STORE" ]; then
  log "ERROR: cron store not found at $CRON_STORE"
  exit 1
fi

# ── Phase 1: Detect issues ──

ISSUES=$(python3 -c "
import json, sys

with open('$CRON_STORE') as f:
    data = json.load(f)

issues = []
for job in data.get('jobs', []):
    if not job.get('enabled', False):
        continue
    name = job.get('name', job['id'])
    state = job.get('state', {})
    cons_err = state.get('consecutiveErrors', 0)
    last_status = state.get('lastRunStatus', 'ok')
    last_error = state.get('lastError', '')

    if cons_err > 0 or last_status == 'error':
        issues.append(json.dumps({
            'name': name,
            'id': job['id'],
            'consecutiveErrors': cons_err,
            'lastStatus': last_status,
            'lastError': last_error
        }))

if issues:
    for i in issues:
        print(i)
    sys.exit(0)
else:
    sys.exit(1)
" 2>/dev/null) || {
  log "OK: all cron jobs healthy"
  exit 0
}

# ── Phase 2: Classify and self-heal ──

fixed_count=0
escalate_issues=""

while IFS= read -r issue_json; do
  name=$(echo "$issue_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
  last_error=$(echo "$issue_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['lastError'])")
  cons_err=$(echo "$issue_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['consecutiveErrors'])")
  
  # ── Pattern: rate_limit / rate-overlimit ──
  if echo "$last_error" | grep -qi "rate.limit\|rate-overlimit\|429\|too many requests"; then
    log "SELF-RESOLVE: $name — rate limit (will clear on next successful run)"
    heal_log "$name — rate limit detected, cons_err=$cons_err. Self-resolving."
    # Rate limits are transient. Don't escalate unless persistent (>10 consecutive).
    if [ "$cons_err" -gt 10 ]; then
      escalate_issues="$escalate_issues\n- $name: rate limit for $cons_err consecutive runs — may need model change"
    fi
    continue
  fi
  
  # ── Pattern: MODULE_NOT_FOUND (build-hash drift) ──
  if echo "$last_error" | grep -qi "MODULE_NOT_FOUND\|Cannot find module\|manager-runtime\|search-manager"; then
    log "SELF-HEAL: $name — build-hash drift detected. Triggering full restart."
    heal_log "$name — build-hash drift. Running full restart."
    
    if [ -x "$SCRIPT_DIR/gateway-full-restart.sh" ]; then
      if bash "$SCRIPT_DIR/gateway-full-restart.sh" >> "$SELF_HEAL_LOG" 2>&1; then
        heal_log "Full restart succeeded"
        fixed_count=$((fixed_count + 1))
      else
        escalate_issues="$escalate_issues\n- $name: build-hash drift — full restart FAILED"
      fi
    elif systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
      systemctl --user restart openclaw-gateway
      sleep 5
      heal_log "systemd restart issued"
      fixed_count=$((fixed_count + 1))
    else
      escalate_issues="$escalate_issues\n- $name: build-hash drift — no restart mechanism available"
    fi
    # Only restart once even if multiple jobs have this issue
    break
  fi
  
  # ── Pattern: model not allowed / thinking level ──
  if echo "$last_error" | grep -qi "model not allowed\|thinking.*low\|thinking.*not supported"; then
    log "SELF-HEAL-NEEDED: $name — model/thinking config issue: $last_error"
    heal_log "$name — model/thinking config issue. Needs cron prompt update."
    escalate_issues="$escalate_issues\n- $name: model config issue — $last_error"
    continue
  fi
  
  # ── Pattern: script/path not found ──
  if echo "$last_error" | grep -qi "no such file\|ENOENT\|not found\|does not exist"; then
    log "ESCALATE: $name — missing file/script: $last_error"
    escalate_issues="$escalate_issues\n- $name: missing file — $last_error"
    continue
  fi
  
  # ── Unknown pattern ──
  if [ "$cons_err" -gt 2 ]; then
    escalate_issues="$escalate_issues\n- $name: $cons_err consecutive errors — $last_error"
  else
    log "WATCH: $name — $cons_err errors, will wait: $last_error"
  fi
  
done <<< "$ISSUES"

# ── Phase 3: Escalate only what couldn't be self-healed ──

if [ "$fixed_count" -gt 0 ]; then
  log "HEALED: fixed $fixed_count issue(s) automatically"
fi

if [ -z "$escalate_issues" ]; then
  log "All issues handled (fixed=$fixed_count)"
  exit 0
fi

# Check cooldown before LLM escalation
if [ -f "$COOLDOWN_FILE" ]; then
  last_alert=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  elapsed=$(( now - last_alert ))
  if [ "$elapsed" -lt "$COOLDOWN_SECONDS" ]; then
    log "COOLDOWN: escalation deferred (${elapsed}s/${COOLDOWN_SECONDS}s)"
    exit 0
  fi
fi

ISSUE_COUNT=$(echo -e "$escalate_issues" | grep -c '[^[:space:]]' || true)
log "ESCALATE: $ISSUE_COUNT issue(s) need LLM attention"

PROMPT="CRON HEALTH — Self-Heal Report

FIXED automatically: $fixed_count issue(s)
NEEDS ATTENTION:
$(echo -e "$escalate_issues")

For each issue above:
1. Diagnose the root cause
2. Fix it if you can (edit cron prompts, update model, fix paths)
3. If you can't fix it, explain what Oscar needs to do

Be concrete. Fix things, don't just describe them."

date +%s > "$COOLDOWN_FILE"

openclaw agent -m "$PROMPT" 2>>"$LOG_FILE" || log "WARNING: LLM escalation failed"
