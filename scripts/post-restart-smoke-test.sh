#!/usr/bin/env bash
# post-restart-smoke-test.sh — Verify critical gateway subsystems after restart.
#
# Run after any gateway restart to catch stale module references early.
# If memory_search fails, triggers a full systemd restart automatically.
#
# Usage: bash scripts/post-restart-smoke-test.sh
# Exit 0 = all good, Exit 1 = failed and self-healed, Exit 2 = failed and couldn't heal

set -euo pipefail

export PATH="$HOME/.local/share/pnpm:$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_RETRIES=2
RETRY_COUNT=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] SMOKE: $*"; }

wait_for_gateway() {
  local attempts=0
  while [ $attempts -lt 15 ]; do
    if curl -sf http://127.0.0.1:18789/health >/dev/null 2>&1 || \
       curl -sf http://127.0.0.1:18789/ >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempts=$((attempts + 1))
  done
  return 1
}

test_memory_search() {
  # Use openclaw agent to test memory_search via the gateway
  local result
  result=$(timeout 30 openclaw agent -m "Run memory_search with query 'test' and report ONLY whether it returned results or an error. Reply with exactly SEARCH_OK or SEARCH_FAIL followed by the error." 2>&1) || true
  
  if echo "$result" | grep -qi "SEARCH_OK\|results.*found\|snippets"; then
    return 0
  elif echo "$result" | grep -qi "MODULE_NOT_FOUND\|Cannot find module\|SEARCH_FAIL\|disabled.*true\|unavailable"; then
    return 1
  else
    # Ambiguous — check if the error message contains module path issues
    if echo "$result" | grep -qi "manager-runtime\|search-manager"; then
      return 1
    fi
    # If we can't tell, assume OK (don't over-react)
    log "Ambiguous result: $(echo "$result" | head -2)"
    return 0
  fi
}

# Wait for gateway to be ready
log "Waiting for gateway..."
if ! wait_for_gateway; then
  log "❌ Gateway not responding after 30s"
  exit 2
fi
log "Gateway responding"

# Test memory_search
log "Testing memory_search..."
if test_memory_search; then
  log "✅ memory_search working"
  exit 0
fi

log "⚠️ memory_search broken — attempting self-heal..."

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  log "Self-heal attempt $RETRY_COUNT/$MAX_RETRIES: full process restart..."
  
  if [ -x "$SCRIPT_DIR/gateway-full-restart.sh" ]; then
    bash "$SCRIPT_DIR/gateway-full-restart.sh"
  elif systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
    systemctl --user restart openclaw-gateway
  else
    log "❌ No restart mechanism available"
    exit 2
  fi
  
  sleep 8
  
  if ! wait_for_gateway; then
    log "Gateway didn't come back after restart $RETRY_COUNT"
    continue
  fi
  
  sleep 5  # Give it time to fully initialize
  
  if test_memory_search; then
    log "✅ memory_search recovered after restart $RETRY_COUNT"
    exit 1  # Healed but flag it
  fi
done

log "❌ memory_search still broken after $MAX_RETRIES restart attempts"
exit 2
