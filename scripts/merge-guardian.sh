#!/bin/bash
# merge-guardian.sh — Post-merge fork integrity checker
# Run after every upstream merge to detect and fix damage.
#
# Usage: bash scripts/merge-guardian.sh [--fix] [--learn] [--no-build]
#   --fix      Auto-fix detected issues (restore from git, patch schemas)
#   --learn    Update the blueprint with new conflict patterns
#   --no-build Skip the build check (useful when called from safe-cron-merge.sh which builds separately)
#
# Exit codes:
#   0 = all checks passed
#   1+ = number of issues detected

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/merge-guardian.log"
FIX=false
LEARN=false
NO_BUILD=false
ISSUES=0

for arg in "$@"; do
  case "$arg" in
    --fix) FIX=true ;;
    --learn) LEARN=true ;;
    --no-build) NO_BUILD=true ;;
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
  "extensions/hippocampus/index.ts"
  "src/web/auto-reply/monitor/thinking-reaction.ts"
  "src/auto-reply/reply/jarvis-voice-markup.ts"
  "src/agents/tools/whatsapp-history-tool.ts"
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
# Call-site checks (not just import checks) — added 2026-03-04
check_wiring "src/agents/pi-embedded-runner/run/attempt.ts" "getPersonaBlock" "personaBlock hook CALL in attempt.ts"
check_wiring "src/agents/pi-embedded-runner/run/attempt.ts" "applyMidContextReinjectHook" "mid-context reinject hook CALL in attempt.ts"
check_wiring "src/agents/pi-embedded-runner/run/attempt.ts" "interceptTextToolCalls" "text-tool-call hook CALL in attempt.ts"
check_wiring "src/agents/pi-embedded-runner/run/attempt.ts" "onTurnComplete" "onTurnComplete hook CALL in attempt.ts"
check_wiring "src/agents/system-prompt.ts" "personaBlock" "personaBlock param in system-prompt.ts"
check_wiring "src/agents/system-prompt.ts" "params.personaBlock" "personaBlock INJECTION in system-prompt.ts output"
check_wiring "src/agents/pi-embedded-runner/run.ts" "fallback-profile-error" "Per-profile fallback events in run.ts"
check_wiring "src/agents/pi-embedded-runner/run.ts" "agent-events" "emitAgentEvent import in run.ts"
check_wiring "src/agents/pi-embedded-helpers/failover-matches.ts" "regain access" "Anthropic billing pattern in failover-matches.ts"
check_wiring "src/agents/pi-embedded-helpers/errors.ts" "regain access" "Early billing check in errors.ts"
check_wiring "src/agents/auth-profiles/store.ts" "diskCred.expires > memCred.expires" "OAuth refresh token preservation in saveAuthProfileStore"
check_wiring "src/agents/auth-profiles/external-cli-sync.ts" "readClaudeCliCredentialsCached" "Claude Code CLI GM credential sync in external-cli-sync.ts"
check_wiring "src/agents/auth-profiles/external-cli-sync.ts" "readClaudeCliSvCredentialsCached" "Claude Code CLI SV credential sync in external-cli-sync.ts"
check_wiring "src/agents/auth-profiles/oauth.ts" "CLAUDE_CLI_PROFILE_ID" "Claude CLI GM refresh guard in oauth.ts"
check_wiring "src/agents/auth-profiles/oauth.ts" "CLAUDE_CLI_SV_PROFILE_ID" "Claude CLI SV refresh guard in oauth.ts"
check_wiring "src/web/auto-reply/monitor/process-message.ts" "process-message-hooks" "Fork hooks import in process-message.ts"
check_wiring "src/web/auto-reply/monitor/process-message.ts" "_annotateOfflineRecovery" "Offline recovery annotation CALL in process-message.ts"
check_wiring "src/web/auto-reply/monitor/process-message.ts" "_createThinkingReaction" "Thinking reaction CALL in process-message.ts"
check_wiring "src/web/inbound/monitor.ts" "fromMe" "fromMe propagation in monitor.ts"
check_wiring "src/gateway/server-methods/sessions.ts" "Allow webchat delete" "Webchat session delete bypass in sessions.ts"

# New Phase 2 checks (2026-03-04)
# Correct import depth (3 levels, not 4)
if [ -f "$ROOT/src/web/auto-reply/monitor/process-message.ts" ]; then
  if grep -q '../../../../fork/process-message-hooks' "$ROOT/src/web/auto-reply/monitor/process-message.ts" 2>/dev/null; then
    warn "Wrong import depth (4 levels) in process-message.ts — should be ../../../fork/"
    if $FIX; then
      sed -i 's|../../../../fork/process-message-hooks|../../../fork/process-message-hooks|g' "$ROOT/src/web/auto-reply/monitor/process-message.ts"
      ok "Fixed import depth in process-message.ts"
    fi
  else
    ok "Correct import depth in process-message.ts"
  fi
fi
check_wiring "src/auto-reply/reply/session-reset-prompt.ts" "resolveSessionPromptBase" "SESSION.md reader in session-reset-prompt.ts"
check_wiring "src/auto-reply/reply/get-reply-run.ts" "workspaceDir" "workspaceDir passed to buildBareSessionResetPrompt"
check_wiring "src/gateway/server-methods/agent.ts" "DEFAULT_AGENT_WORKSPACE_DIR" "Workspace dir import in agent.ts"
check_wiring "src/web/outbound.ts" "Group & Extended Message Operations" "WhatsApp group wrappers in outbound.ts"
check_wiring "src/agents/pi-embedded-subscribe.types.ts" "authProfileId" "authProfileId in SubscribeEmbeddedPiSessionParams"
if [ -f "$ROOT/src/web/auto-reply/monitor.ts" ]; then
  if grep -q "unknown as.*ActiveWebListener\|unknown as import" "$ROOT/src/web/auto-reply/monitor.ts" 2>/dev/null; then
    ok "ActiveWebListener cast in monitor.ts"
  else
    warn "ActiveWebListener cast missing in monitor.ts"
  fi
fi

check_wiring "src/agents/openclaw-tools.ts" "createWhatsAppHistoryTool" "WhatsApp history tool in openclaw-tools.ts"

# ─── 2b. Bundler & dependency integrity ───
log "--- Phase 2b: Bundler & dependency checks ---"
check_wiring "tsdown.config.ts" "better-sqlite3" "better-sqlite3 in tsdown.config.ts external array"
if ! grep -q '"better-sqlite3"' "$ROOT/package.json" 2>/dev/null; then
  warn "better-sqlite3 missing from package.json dependencies"
else
  ok "better-sqlite3 in package.json"
fi
if ! grep -q '"bindings"' "$ROOT/package.json" 2>/dev/null; then
  warn "bindings missing from package.json dependencies"
else
  ok "bindings in package.json"
fi
if ! grep -q '"@types/better-sqlite3"' "$ROOT/package.json" 2>/dev/null; then
  warn "@types/better-sqlite3 missing from package.json devDependencies"
else
  ok "@types/better-sqlite3 in package.json"
fi

# ─── 3. Config schema fork additions ───
log "--- Phase 3: Config schemas ---"
check_wiring "src/config/zod-schema.agent-defaults.ts" "engram" "engram compaction mode"
check_wiring "src/config/zod-schema.providers-whatsapp.ts" "triggerPrefix" "WhatsApp triggerPrefix"
check_wiring "src/config/zod-schema.providers-whatsapp.ts" "ackMessage\|ackMessage" "WhatsApp ackMessage"
check_wiring "src/config/zod-schema.providers-whatsapp.ts" "syncFullHistory" "WhatsApp syncFullHistory"
check_wiring "src/config/zod-schema.agent-defaults.ts" "pointerMode" "Engram pointerMode in compaction schema"
check_wiring "src/config/types.agent-defaults.ts" "engram" "Engram in AgentCompactionMode type"

# ─── 4. UI integrity ───
log "--- Phase 4: UI integrity ---"
if [ -f "$ROOT/tinker-ui/src/app.ts" ]; then
  DUPE_MD_IMPORTS=$(grep -c "import.*MarkdownIt\|import.*markdown-it" "$ROOT/tinker-ui/src/app.ts" 2>/dev/null || echo 0)
  if [ "$DUPE_MD_IMPORTS" -gt 1 ]; then
    warn "Duplicate MarkdownIt imports in tinker-ui/src/app.ts ($DUPE_MD_IMPORTS occurrences)"
    if $FIX; then
      # Keep only the first import, remove duplicates
      awk '/import.*[Mm]arkdown.?[Ii]t/{c++; if(c>1) next}1' "$ROOT/tinker-ui/src/app.ts" > "$ROOT/tinker-ui/src/app.ts.tmp" && mv "$ROOT/tinker-ui/src/app.ts.tmp" "$ROOT/tinker-ui/src/app.ts"
      ok "Removed duplicate MarkdownIt imports"
    fi
  else
    ok "No duplicate MarkdownIt imports in tinker-ui"
  fi
fi

# ─── 5. Debug artifacts ───
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
BUILD_LOG="/tmp/merge-guardian-build.log"
BUILD_FAILED=false
if $NO_BUILD; then
  log "--- Phase 6: Build (skipped — --no-build) ---"
else
  log "--- Phase 6: Build ---"
  if cd "$ROOT" && pnpm build &>"$BUILD_LOG"; then
    ok "Build passes"
  else
    BUILD_FAILED=true
    warn "BUILD FAILED"
    grep -E "error TS|Module not found|Cannot find" "$BUILD_LOG" 2>/dev/null | head -10 >> "$LOG"
  fi
fi

# ─── Summary ───
echo ""
if [ "$ISSUES" -eq 0 ]; then
  log "🟢 All checks passed — fork integrity verified"
else
  log "🔴 $ISSUES issues detected"
fi

# ─── Learning mode: record failures + classify build errors ───
if $LEARN; then
  POSTMORTEM="$HOME/.openclaw/workspace/memory/knowledge/merge-postmortem-$(date +%Y-%m-%d).md"

  # Always write postmortem header if file is new
  if [ ! -f "$POSTMORTEM" ]; then
    {
      echo "# Merge Post-Mortem: $(date +%Y-%m-%d)"
      echo ""
      echo "Auto-generated by \`merge-guardian.sh --learn\`"
      echo ""
    } > "$POSTMORTEM"
  fi

  {
    echo "## Run at $(date '+%H:%M:%S') — $ISSUES issues"
    echo ""
  } >> "$POSTMORTEM"

  # Record guardian findings
  if [ "$ISSUES" -gt 0 ]; then
    {
      echo "### Guardian Findings"
      echo ""
      grep "⚠️" "$LOG" | sed 's/^/- /'
      echo ""
    } >> "$POSTMORTEM"
  fi

  # Classify build errors against playbook categories (even if build passed — for tracking)
  if $BUILD_FAILED; then
    {
      echo "### Build Error Classification"
      echo ""
      echo "| # | Category | Detected |"
      echo "|---|----------|----------|"
    } >> "$POSTMORTEM"

    KNOWN=0
    for pattern_pair in \
      "1|__filename ESM|__filename is not defined" \
      "2|Wrong import depth|Cannot find.*fork/" \
      "3|MessageKey missing|has no exported member.*MessageKey" \
      "4|syncFullHistory type|syncFullHistory.*does not exist" \
      "5|ActiveWebListener cast|not assignable to type.*ActiveWebListener" \
      "6|authProfileId missing|authProfileId.*does not exist" \
      "7|Fork hooks wiped|Cannot find name.*forkAttemptHooks" \
      "8|Missing deps|Cannot find module.*better-sqlite3"
    do
      NUM=$(echo "$pattern_pair" | cut -d'|' -f1)
      NAME=$(echo "$pattern_pair" | cut -d'|' -f2)
      PAT=$(echo "$pattern_pair" | cut -d'|' -f3)
      if grep -qE "$PAT" "$BUILD_LOG" 2>/dev/null; then
        echo "| $NUM | $NAME | YES |" >> "$POSTMORTEM"
        ((KNOWN++)) || true
      else
        echo "| $NUM | $NAME | no |" >> "$POSTMORTEM"
      fi
    done

    TOTAL_TS=$(grep -cE "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null || echo 0)
    UNKNOWN=$((TOTAL_TS - KNOWN))
    [ "$UNKNOWN" -lt 0 ] && UNKNOWN=0

    {
      echo ""
      echo "**Total TS errors:** $TOTAL_TS | **Known:** $KNOWN | **Unknown:** $UNKNOWN"
      echo ""
    } >> "$POSTMORTEM"

    # Capture unknown error signatures for future playbook expansion
    if [ "$UNKNOWN" -gt 0 ]; then
      {
        echo "### Unknown Error Signatures (NEW — add to playbook)"
        echo ""
        echo '```'
        grep -E "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null | \
          grep -vE '__filename|fork/|MessageKey|syncFullHistory|ActiveWebListener|authProfileId|forkAttemptHooks|better-sqlite3' | \
          sort -u | head -20
        echo '```'
        echo ""
      } >> "$POSTMORTEM"
    fi
  else
    echo "### Build: PASSED" >> "$POSTMORTEM"
    echo "" >> "$POSTMORTEM"
  fi

  # Evolution recommendations
  if [ "$ISSUES" -gt 0 ] || $BUILD_FAILED; then
    {
      echo "### Action Items"
      echo ""
      echo "1. For each unknown error above, add a new category to \`scripts/post-merge-build-playbook.md\`"
      echo "2. Add corresponding guard + fix to \`scripts/apply-fork-wiring.mjs\`"
      echo "3. Add check to \`scripts/merge-guardian.sh\` Phase 2"
      echo "4. Update \`FORK_PATCHES.md\` with the new entry"
      echo ""
    } >> "$POSTMORTEM"
  fi

  log "📝 Postmortem written to $POSTMORTEM"
fi

exit "$ISSUES"
