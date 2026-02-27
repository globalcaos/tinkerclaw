#!/bin/bash
# merge-guardian.sh — Post-merge fork integrity checker
# Run after every upstream merge to detect and fix damage.
#
# Usage: bash scripts/merge-guardian.sh [--fix] [--learn]
#   --fix   Auto-fix detected issues (restore from git, patch schemas)
#   --learn Update the blueprint with new conflict patterns
#
# Exit codes:
#   0 = all checks passed
#   1+ = number of issues detected

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/merge-guardian.log"
FIX=false
LEARN=false
ISSUES=0

for arg in "$@"; do
  case "$arg" in
    --fix) FIX=true ;;
    --learn) LEARN=true ;;
  esac
done

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
warn() { log "⚠️  $*"; ISSUES=$((ISSUES + 1)); }
ok() { log "✅ $*"; }

echo "=== Merge Guardian — $(date) ===" > "$LOG"

# ─── 1. Fork-only directories ───
FORK_DIRS=(
  "src/fork"
  "src/memory/cortex"
  "src/memory/engram"
  "src/memory/limbic"
  "src/memory/synapse"
  "src/whatsapp-history"
  "src/agents/continuous-compact"
  "extensions/manus"
  "extensions/budget-panel"
)

log "--- Phase 1: Fork file existence ---"
for d in "${FORK_DIRS[@]}"; do
  if [ ! -d "$ROOT/$d" ]; then
    warn "MISSING directory: $d"
  else
    ok "$d ($(ls "$ROOT/$d" | wc -l) files)"
  fi
done

# Fork-only files
FORK_FILES=(
  "src/plugins/cognitive-hooks.ts"
  "src/plugins/hippocampus-hook.ts"
  "src/web/auto-reply/monitor/thinking-reaction.ts"
  "src/infra/token-usage-tracker.ts"
  "src/auto-reply/reply/jarvis-voice-markup.ts"
  "src/agents/tools/hippocampus-bridge.ts"
  "src/agents/tools/whatsapp-history-tool.ts"
  "src/web/auto-reply/monitor/ack-message.ts"
  "ui/src/styles/chat/fork-overrides.css"
  "ui/src/styles/chat/tool-compact.css"
  "ui/src/ui/chat/tool-compact.ts"
  "ui/src/ui/controllers/provider-usage.ts"
)

for f in "${FORK_FILES[@]}"; do
  if [ ! -f "$ROOT/$f" ]; then
    warn "MISSING file: $f"
  fi
done

# ─── 2. Hook wiring integrity ───
log "--- Phase 2: Hook wiring ---"
check_wiring() {
  local file="$1" pattern="$2" label="$3"
  if [ -f "$ROOT/$file" ]; then
    if ! grep -q "$pattern" "$ROOT/$file" 2>/dev/null; then
      warn "$label missing in $file"
    else
      ok "$label"
    fi
  else
    warn "$file does not exist"
  fi
}

check_wiring "src/agents/pi-embedded-runner/run/attempt.ts" "fork/attempt-hooks" "Fork hooks import in attempt.ts"
check_wiring "src/agents/system-prompt.ts" "personaBlock" "personaBlock param in system-prompt.ts"
check_wiring "src/web/auto-reply/monitor/process-message.ts" "thinking-reaction" "Thinking reaction in process-message.ts"
check_wiring "src/web/auto-reply/monitor/process-message.ts" "ack-message" "Ack message in process-message.ts"
check_wiring "src/web/inbound/monitor.ts" "fromMe.*selfE164\|selfE164.*fromMe" "fromMe fallback in monitor.ts"

# ─── 3. Config schema fork additions ───
log "--- Phase 3: Config schemas ---"
check_wiring "src/config/zod-schema.agent-defaults.ts" "engram" "engram compaction mode"
check_wiring "src/config/zod-schema.providers-whatsapp.ts" "triggerPrefix" "WhatsApp triggerPrefix"
check_wiring "src/config/zod-schema.providers-whatsapp.ts" "ackMessage\|ackMessage" "WhatsApp ackMessage"
check_wiring "src/config/zod-schema.providers-whatsapp.ts" "syncFullHistory" "WhatsApp syncFullHistory"

# ─── 4. UI fork hooks ───
log "--- Phase 4: UI hooks ---"
check_wiring "ui/src/styles/chat.css" "fork-overrides" "Fork CSS override import"
check_wiring "ui/src/styles/chat.css" "tool-compact" "Tool compact CSS import"
check_wiring "ui/src/ui/chat/grouped-render.ts" "tool-compact" "Compact tool import in grouped-render"
check_wiring "ui/src/ui/chat/tool-cards.ts" "tool-compact" "Compact tool import in tool-cards"
check_wiring "ui/src/ui/markdown.ts" "jarvis" "Jarvis voice in markdown.ts"

# ─── 5. Debug artifact scan ───
log "--- Phase 5: Debug artifacts ---"
DEBUG_COUNT=$(grep -rn "console\.log.*DEBUG" "$ROOT/src/" --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v "\.test\." | wc -l)
if [ "$DEBUG_COUNT" -gt 0 ]; then
  warn "$DEBUG_COUNT debug console.log lines in src/"
  if $FIX; then
    grep -rl "console\.log.*DEBUG" "$ROOT/src/" --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v "\.test\." | while read -r f; do
      sed -i '/console\.log.*DEBUG/d' "$f"
    done
    ok "Cleaned debug console.logs"
  fi
else
  ok "No debug artifacts"
fi

# ─── 6. Build check ───
log "--- Phase 6: Build ---"
if cd "$ROOT" && pnpm build &>/tmp/merge-guardian-build.log; then
  ok "Build passes"
else
  warn "BUILD FAILED"
  grep -E "error TS|Module not found|Cannot find" /tmp/merge-guardian-build.log 2>/dev/null | head -10 >> "$LOG"
fi

# ─── Summary ───
echo ""
if [ "$ISSUES" -eq 0 ]; then
  log "🟢 All checks passed — fork integrity verified"
else
  log "🔴 $ISSUES issues detected"
fi

exit "$ISSUES"

# ─── Learning mode: record failures for the merge agent ───
if $LEARN && [ "$ISSUES" -gt 0 ]; then
  POSTMORTEM="$HOME/.openclaw/workspace/memory/knowledge/merge-postmortem-$(date +%Y-%m-%d).md"
  if [ ! -f "$POSTMORTEM" ]; then
    {
      echo "# Merge Post-Mortem: $(date +%Y-%m-%d)"
      echo ""
      echo "## Guardian Findings"
      echo ""
      echo "Auto-generated by \`merge-guardian.sh --learn\`"
      echo ""
      echo "### Issues Detected"
      echo ""
    } > "$POSTMORTEM"
  fi
  
  # Append today's findings
  {
    echo "#### Run at $(date '+%H:%M:%S')"
    echo ""
    grep "⚠️" "$LOG" | sed 's/^/- /'
    echo ""
    echo "### Evolution Needed"
    echo ""
    echo "The merge agent should:"
    echo "1. Add new checks to merge-guardian.sh for each failure class above"
    echo "2. Update Schema/UI/Wiring registries in merge-workflow.md"
    echo "3. Evaluate if broken code can move to extensions/"
    echo ""
  } >> "$POSTMORTEM"
  
  log "📝 Postmortem written to $POSTMORTEM"
fi
