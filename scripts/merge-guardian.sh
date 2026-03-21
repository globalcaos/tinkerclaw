#!/usr/bin/env bash
# merge-guardian.sh — Post-merge fork integrity checker.
# Run after every upstream merge to detect and fix damage to fork-only patches.
#
# Usage: bash scripts/merge-guardian.sh [--fix] [--learn] [--no-build]
#   --fix      Auto-fix detected issues (restore from git, patch schemas)
#   --learn    Update the blueprint with new conflict patterns
#   --no-build Skip the build check (useful when called from safe-cron-merge.sh which builds separately)
#
# Exit codes:
#   0 = all checks passed
#   1+ = number of issues detected

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly LOG="/tmp/merge-guardian.log"
readonly BUILD_LOG="/tmp/merge-guardian-build.log"

# ── Argument parsing ───────────────────────────────────────────────────────────

fix_mode=false
learn_mode=false
no_build=false
issues=0

for arg in "$@"; do
  case "$arg" in
    --fix)      fix_mode=true ;;
    --learn)    learn_mode=true ;;
    --no-build) no_build=true ;;
  esac
done

# ── Logging helpers ────────────────────────────────────────────────────────────

log()  { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
warn() { log "⚠️  $*"; issues=$(( issues + 1 )); }
ok()   { log "✅ $*"; }

# ── Check functions ────────────────────────────────────────────────────────────

# Verify a pattern exists in a file — missing patterns indicate upstream overwrote a fork patch.
check_wiring() {
  local file="$1" pattern="$2" label="$3"
  if [[ -f "$ROOT/$file" ]]; then
    if ! grep -q "$pattern" "$ROOT/$file" 2>/dev/null; then
      warn "$label missing in $file"
    else
      ok "$label"
    fi
  else
    warn "$file does not exist"
  fi
}

check_fork_directories() {
  log "--- Phase 1: Fork file existence ---"

  local fork_dirs=(
    "src/fork"
    "src/memory/cortex"
    "src/memory/engram"
    "src/memory/limbic"
    "src/memory/synapse"
    "src/whatsapp-history"
    "extensions/manus"
    "extensions/budget-panel"
  )

  local fork_files=(
    "extensions/hippocampus/index.ts"
    "extensions/whatsapp/src/auto-reply/monitor/thinking-reaction.ts"
    "src/auto-reply/reply/jarvis-voice-markup.ts"
    "src/agents/context-anatomy-db.ts"
    "src/agents/tools/whatsapp-history-tool.ts"
  )

  for dir in "${fork_dirs[@]}"; do
    if [[ ! -d "$ROOT/$dir" ]]; then
      warn "MISSING directory: $dir"
    else
      ok "$dir ($(ls "$ROOT/$dir" | wc -l) files)"
    fi
  done

  for f in "${fork_files[@]}"; do
    if [[ ! -f "$ROOT/$f" ]]; then
      warn "MISSING file: $f"
    fi
  done
}

check_hook_wiring() {
  log "--- Phase 2: Hook wiring ---"

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
  check_wiring "src/agents/auth-profiles/credential-file.ts" "resolveCredentialFilePath" "Generic credential path resolver in credential-file.ts"
  check_wiring "src/agents/auth-profiles/credential-file.ts" "readCredentialFile" "Generic credential reader in credential-file.ts"
  check_wiring "src/agents/auth-profiles/credential-file.ts" "writeCredentialFile" "Generic credential writer in credential-file.ts"
  # Negative checks — these SV/GM-specific constants must NOT exist in oauth.ts after refactor
  if grep -q "CLAUDE_CLI_PROFILE_ID\|CLAUDE_CLI_SV_PROFILE_ID" "$ROOT/src/agents/auth-profiles/oauth.ts" 2>/dev/null; then
    warn "oauth.ts still contains removed CLAUDE_CLI_PROFILE_ID / CLAUDE_CLI_SV_PROFILE_ID constants"
  else
    ok "oauth.ts: removed SV/GM-specific profile ID constants (expected absent)"
  fi
  check_wiring "src/agents/auth-profiles/proactive-refresh.ts" "credential-file" "proactive-refresh imports from credential-file (not cli-credentials)"
  check_wiring "extensions/whatsapp/src/auto-reply/monitor/process-message.ts" "process-message-hooks" "Fork hooks import in process-message.ts"
  check_wiring "extensions/whatsapp/src/auto-reply/monitor/process-message.ts" "_annotateOfflineRecovery" "Offline recovery annotation CALL in process-message.ts"
  check_wiring "extensions/whatsapp/src/auto-reply/monitor/process-message.ts" "_createThinkingReaction" "Thinking reaction CALL in process-message.ts"
  check_wiring "src/gateway/server-methods/sessions.ts" "Allow webchat delete" "Webchat session delete bypass in sessions.ts"
}

check_import_depth() {
  # Upstream merges sometimes deepen import paths by one level — catches a common rebase artifact.
  local pm="$ROOT/extensions/whatsapp/src/auto-reply/monitor/process-message.ts"
  if [[ -f "$pm" ]]; then
    if grep -q 'fork/process-message-hooks' "$pm" 2>/dev/null; then
      ok "Correct fork import in process-message.ts"
    else
      warn "Fork hooks import missing in process-message.ts"
    fi
  fi
}

check_extended_wirings() {
  # Added 2026-03-04 — second batch of wiring checks after fork expansion
  check_wiring "src/auto-reply/reply/session-reset-prompt.ts" "resolveSessionPromptBase" "SESSION.md reader in session-reset-prompt.ts"
  check_wiring "src/auto-reply/reply/get-reply-run.ts" "workspaceDir" "workspaceDir passed to buildBareSessionResetPrompt"
  check_wiring "src/gateway/server-methods/agent.ts" "DEFAULT_AGENT_WORKSPACE_DIR" "Workspace dir import in agent.ts"
  check_wiring "extensions/whatsapp/src/send.ts" "Group & Extended Message Operations" "WhatsApp group wrappers in send.ts"
  check_wiring "src/browser/extension-relay.ts" "ExtensionConnection" "FORK: multi-extension relay in extension-relay.ts"
  check_wiring "src/browser/extension-relay.ts" "extensionConnections" "FORK: extensionConnections Map in extension-relay.ts"
  check_wiring "src/browser/extension-relay.ts" "ownedSessions" "FORK: per-extension session ownership in extension-relay.ts"
  check_wiring "src/agents/pi-embedded-subscribe.types.ts" "authProfileId" "authProfileId in SubscribeEmbeddedPiSessionParams"
  check_wiring "src/agents/openclaw-tools.ts" "createWhatsAppHistoryTool" "WhatsApp history tool in openclaw-tools.ts"
  check_wiring "src/agents/pi-embedded-runner/run.ts" "resolveSessionLane" "Per-session lane (no cross-session serialization)"

  # Thinking block preservation (2026-03-15)
  check_wiring "src/agents/pi-embedded-subscribe.handlers.messages.ts" "phase.*end" "thinking-end agent event in emitReasoningEnd"
  check_wiring "src/gateway/server-chat.ts" "thinking_delta" "thinking_delta chat broadcast in server-chat.ts"
  check_wiring "src/gateway/server-chat.ts" "thinking_end" "thinking_end chat broadcast in server-chat.ts"

  # Thinking/response separation (2026-03-16) — 6 fixes, all must survive upstream merges
  check_wiring "src/auto-reply/reply/get-reply-directives.ts" "thinkingActive" "Auto-enable reasoning stream when thinking active"
  check_wiring "src/agents/pi-embedded-subscribe.ts" 'streamReasoning:.*reasoningMode' "streamReasoning not gated on callback"
  check_wiring "src/agents/pi-embedded-subscribe.handlers.types.ts" "currentThinkingBlock" "Per-round thinking state field"
  check_wiring "src/agents/pi-embedded-subscribe.handlers.messages.ts" "currentThinkingBlock" "Per-round thinking tracking in message handler"
  # Timeline SQLite persistence (2026-03-16)
  check_wiring "src/fork/attempt-hooks.ts" "insertAnatomyEvent" "SQLite anatomy insert in attempt-hooks"
  check_wiring "src/fork/attempt-hooks.ts" "updateAnatomyResponse" "SQLite anatomy update in attempt-hooks"
  check_wiring "src/agents/pi-embedded-subscribe.handlers.types.ts" "responseBreakdown" "Response breakdown state type"
  check_wiring "src/agents/pi-embedded-subscribe.handlers.messages.ts" "thinkingChars\|textChars\|toolCallChars" "Response breakdown char accumulators"

  check_wiring "tinker-ui/src/app.ts" "isThinkingMsg" "Thinking temps preserved in finalization"
  check_wiring "tinker-ui/src/app.ts" "hasRunTemps" "Stable isCurrentRun check (no style flicker)"

  # Session resume bypass (2026-03-18) — must use agentCommand, NOT heartbeat
  check_wiring "src/gateway/server-startup.ts" "agentCommand" "FORK: session resume via agentCommand (not heartbeat)"

  if [[ -f "$ROOT/src/web/auto-reply/monitor.ts" ]]; then
    if grep -q "unknown as.*ActiveWebListener\|unknown as import" "$ROOT/src/web/auto-reply/monitor.ts" 2>/dev/null; then
      ok "ActiveWebListener cast in monitor.ts"
    else
      warn "ActiveWebListener cast missing in monitor.ts"
    fi
  fi
}

check_bundler_deps() {
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

  check_wiring "extensions/budget-panel/index.ts" "resolveApiKeyForProfile" "Budget-panel live OAuth token resolution"
  check_wiring "extensions/budget-panel/index.ts" "ensureAuthProfileStore" "Budget-panel auth store access"
  check_wiring "extensions/budget-panel/index.ts" "writeCredentialFile" "Budget-panel generic credential write-back"

  # live-capture must be a named import (not default) for tsdown bundling
  if grep -q 'import _liveCapture from' "$ROOT/extensions/whatsapp/src/session.ts" 2>/dev/null; then
    warn "session.ts still uses default import _liveCapture (breaks tsdown bundling)"
  else
    ok "session.ts uses named import for bindHistoryCapture"
  fi
}

check_config_schemas() {
  log "--- Phase 3: Config schemas ---"

  check_wiring "src/config/zod-schema.agent-defaults.ts" "engram" "engram compaction mode"
  check_wiring "src/config/zod-schema.providers-whatsapp.ts" "triggerPrefix" "WhatsApp triggerPrefix"
  check_wiring "src/config/zod-schema.providers-whatsapp.ts" "ackMessage\|ackMessage" "WhatsApp ackMessage"
  check_wiring "src/config/zod-schema.providers-whatsapp.ts" "syncFullHistory" "WhatsApp syncFullHistory"
  check_wiring "src/config/zod-schema.agent-defaults.ts" "pointerMode" "Engram pointerMode in compaction schema"
  check_wiring "src/config/types.agent-defaults.ts" "engram" "Engram in AgentCompactionMode type"
}

check_ui_integrity() {
  log "--- Phase 4: UI integrity ---"

  if [[ -f "$ROOT/tinker-ui/src/app.ts" ]]; then
    local dupe_md_imports
    dupe_md_imports=$(grep -c "import.*MarkdownIt\|import.*markdown-it" "$ROOT/tinker-ui/src/app.ts" 2>/dev/null || echo 0)
    if [[ "$dupe_md_imports" -gt 1 ]]; then
      warn "Duplicate MarkdownIt imports in tinker-ui/src/app.ts ($dupe_md_imports occurrences)"
      if [[ "$fix_mode" == true ]]; then
        awk '/import.*[Mm]arkdown.?[Ii]t/{c++; if(c>1) next}1' "$ROOT/tinker-ui/src/app.ts" > "$ROOT/tinker-ui/src/app.ts.tmp" \
          && mv "$ROOT/tinker-ui/src/app.ts.tmp" "$ROOT/tinker-ui/src/app.ts"
        ok "Removed duplicate MarkdownIt imports"
      fi
    else
      ok "No duplicate MarkdownIt imports in tinker-ui"
    fi

    check_wiring "tinker-ui/src/app.ts" "getModelUsage" "Usage bar helper in tinker-ui app.ts"
    check_wiring "tinker-ui/src/app.ts" "claudeProfiles" "Per-profile usage routing in tinker-ui app.ts"
  fi
}

check_debug_artifacts() {
  log "--- Phase 5: Debug artifacts ---"

  local debug_count
  debug_count=$(grep -rn "console\.log.*DEBUG" "$ROOT/src/" --include="*.ts" 2>/dev/null \
    | grep -v node_modules | grep -v dist | grep -v "\.test\." | wc -l || true)

  if [[ "$debug_count" -gt 0 ]]; then
    warn "$debug_count debug console.log lines in src/"
    if [[ "$fix_mode" == true ]]; then
      grep -rl "console\.log.*DEBUG" "$ROOT/src/" --include="*.ts" 2>/dev/null \
        | grep -v node_modules | grep -v dist | grep -v "\.test\." \
        | while read -r f; do
            sed -i '/console\.log.*DEBUG/d' "$f"
          done
      ok "Cleaned debug console.logs"
    fi
  else
    ok "No debug artifacts"
  fi
}

check_systemd_service() {
  log "--- Phase 5b: Systemd service customizations ---"

  local svc="$HOME/.config/systemd/user/openclaw-gateway.service"
  if [[ ! -f "$svc" ]]; then
    ok "No systemd service file (not installed as service)"
    return
  fi

  # ExecStartPre stale lock cleanup — prevents restart loops after unclean shutdown
  if ! grep -q 'ExecStartPre.*gateway.*lock' "$svc"; then
    warn "Missing ExecStartPre stale lock cleanup in systemd service"
    if [[ "$fix_mode" == true ]]; then
      # Insert ExecStartPre before ExecStart
      sed -i '/^ExecStart=/i ExecStartPre=/bin/bash -c '\''rm -f /tmp/openclaw-$(id -u)/gateway.*.lock'\''' "$svc"
      ok "Added ExecStartPre lock cleanup to systemd service"
    fi
  else
    ok "ExecStartPre lock cleanup present"
  fi

  # KillMode=control-group — prevents orphan processes across restarts
  if ! grep -q 'KillMode=control-group' "$svc"; then
    warn "KillMode is not control-group in systemd service (orphan risk)"
    if [[ "$fix_mode" == true ]]; then
      if grep -q 'KillMode=' "$svc"; then
        sed -i 's/KillMode=.*/KillMode=control-group/' "$svc"
      else
        sed -i '/^\[Service\]/a KillMode=control-group' "$svc"
      fi
      ok "Set KillMode=control-group in systemd service"
    fi
  else
    ok "KillMode=control-group present"
  fi

  # OPENCLAW_NO_RESPAWN=1 — forces in-process restart via SIGUSR1 (1s vs 120s+)
  if ! grep -q 'OPENCLAW_NO_RESPAWN=1' "$svc"; then
    warn "Missing OPENCLAW_NO_RESPAWN=1 in systemd service (restart will be slow)"
    if [[ "$fix_mode" == true ]]; then
      sed -i '/^\[Service\]/a Environment=OPENCLAW_NO_RESPAWN=1' "$svc"
      ok "Added OPENCLAW_NO_RESPAWN=1 to systemd service"
    fi
  else
    ok "OPENCLAW_NO_RESPAWN=1 present"
  fi

  # TimeoutStartSec=300 — don't kill during cold boot (57MB ESM parse takes ~120s)
  if ! grep -q 'TimeoutStartSec=300' "$svc"; then
    warn "TimeoutStartSec is not 300 in systemd service (cold boot may be killed)"
    if [[ "$fix_mode" == true ]]; then
      if grep -q 'TimeoutStartSec=' "$svc"; then
        sed -i 's/TimeoutStartSec=.*/TimeoutStartSec=300/' "$svc"
      else
        sed -i '/^\[Service\]/a TimeoutStartSec=300' "$svc"
      fi
      ok "Set TimeoutStartSec=300 in systemd service"
    fi
  else
    ok "TimeoutStartSec=300 present"
  fi
}

check_oauth_trycatch() {
  log "--- Phase 5c: OAuth try-catch around getOAuthApiKey ---"
  local oauth_file="$ROOT/src/agents/auth-profiles/oauth.ts"
  if [[ ! -f "$oauth_file" ]]; then
    warn "oauth.ts not found at expected path"
    return
  fi

  # Check that getOAuthApiKey calls (GM + SV refresh blocks) are wrapped in try-catch
  # Context: without try-catch, stale refresh tokens throw instead of falling through to Claude Code fallback
  local trycatch_count
  trycatch_count=$(grep -B5 "getOAuthApiKey" "$oauth_file" | grep -c "try" || true)
  if [[ "$trycatch_count" -lt 2 ]]; then
    warn "oauth.ts: getOAuthApiKey missing try-catch wrapper (found $trycatch_count, need ≥2). Stale refresh tokens will throw instead of falling through. See 2026-03-17 postmortem."
  else
    ok "oauth.ts: getOAuthApiKey calls wrapped in try-catch ($trycatch_count found)"
  fi
}

check_credential_refresh_scope() {
  log "--- Phase 5d: credential-file.ts — no scope in OAuth refresh ---"
  local cred_file="$ROOT/src/agents/auth-profiles/credential-file.ts"
  if [[ ! -f "$cred_file" ]]; then
    warn "credential-file.ts not found at expected path"
    return
  fi

  # The refresh body must NOT include scope: "user:inference" — it downscopes tokens, breaking usage API
  # Match actual code assignment, not comments
  if grep -vE '^\s*//' "$cred_file" | grep -qE 'scope.*user:inference'; then
    warn "credential-file.ts: found 'scope.*user:inference' in refresh body. This downscopes tokens and breaks /api/oauth/usage (403). See 2026-03-20 incident."
  else
    ok "credential-file.ts: no scope restriction in OAuth refresh body"
  fi
}

run_build_check() {
  if [[ "$no_build" == true ]]; then
    log "--- Phase 6: Build (skipped — --no-build) ---"
    return 0
  fi

  log "--- Phase 6: Build ---"

  if cd "$ROOT" && pnpm build &>"$BUILD_LOG"; then
    ok "Build passes"
    return 0
  else
    warn "BUILD FAILED"
    grep -E "error TS|Module not found|Cannot find" "$BUILD_LOG" 2>/dev/null | head -10 >> "$LOG"
    return 1
  fi
}

# Write a structured post-mortem file capturing guardian findings and build error classification.
# Used to grow the playbook with newly encountered failure patterns.
write_postmortem() {
  local build_failed="$1"
  local postmortem_file="$HOME/.openclaw/workspace/memory/knowledge/merge-postmortem-$(date +%Y-%m-%d).md"

  if [[ ! -f "$postmortem_file" ]]; then
    {
      echo "# Merge Post-Mortem: $(date +%Y-%m-%d)"
      echo ""
      echo "Auto-generated by \`merge-guardian.sh --learn\`"
      echo ""
    } > "$postmortem_file"
  fi

  {
    echo "## Run at $(date '+%H:%M:%S') — $issues issues"
    echo ""
  } >> "$postmortem_file"

  if [[ "$issues" -gt 0 ]]; then
    {
      echo "### Guardian Findings"
      echo ""
      grep "⚠️" "$LOG" | sed 's/^/- /'
      echo ""
    } >> "$postmortem_file"
  fi

  classify_build_errors "$build_failed" "$postmortem_file"

  if [[ "$issues" -gt 0 ]] || [[ "$build_failed" == true ]]; then
    {
      echo "### Action Items"
      echo ""
      echo "1. For each unknown error above, add a new category to \`scripts/post-merge-build-playbook.md\`"
      echo "2. Add corresponding guard + fix to \`scripts/apply-fork-wiring.mjs\`"
      echo "3. Add check to \`scripts/merge-guardian.sh\` Phase 2"
      echo "4. Update \`FORK_PATCHES.md\` with the new entry"
      echo ""
    } >> "$postmortem_file"
  fi

  log "📝 Postmortem written to $postmortem_file"
}

# Classify build errors against known playbook categories for trend tracking.
classify_build_errors() {
  local build_failed="$1"
  local postmortem_file="$2"

  if [[ "$build_failed" == false ]]; then
    echo "### Build: PASSED" >> "$postmortem_file"
    echo "" >> "$postmortem_file"
    return 0
  fi

  {
    echo "### Build Error Classification"
    echo ""
    echo "| # | Category | Detected |"
    echo "|---|----------|----------|"
  } >> "$postmortem_file"

  local known=0
  local pattern_pairs=(
    "1|__filename ESM|__filename is not defined"
    "2|Wrong import depth|Cannot find.*fork/"
    "3|MessageKey missing|has no exported member.*MessageKey"
    "4|syncFullHistory type|syncFullHistory.*does not exist"
    "5|ActiveWebListener cast|not assignable to type.*ActiveWebListener"
    "6|authProfileId missing|authProfileId.*does not exist"
    "7|Fork hooks wiped|Cannot find name.*forkAttemptHooks"
    "8|Missing deps|Cannot find module.*better-sqlite3"
  )

  for pattern_pair in "${pattern_pairs[@]}"; do
    local num name pat
    num=$(echo "$pattern_pair" | cut -d'|' -f1)
    name=$(echo "$pattern_pair" | cut -d'|' -f2)
    pat=$(echo "$pattern_pair" | cut -d'|' -f3)
    if grep -qE "$pat" "$BUILD_LOG" 2>/dev/null; then
      echo "| $num | $name | YES |" >> "$postmortem_file"
      (( known++ )) || true
    else
      echo "| $num | $name | no |" >> "$postmortem_file"
    fi
  done

  local total_ts unknown_count
  total_ts=$(grep -cE "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null || echo 0)
  unknown_count=$(( total_ts - known ))
  [[ "$unknown_count" -lt 0 ]] && unknown_count=0

  {
    echo ""
    echo "**Total TS errors:** $total_ts | **Known:** $known | **Unknown:** $unknown_count"
    echo ""
  } >> "$postmortem_file"

  if [[ "$unknown_count" -gt 0 ]]; then
    {
      echo "### Unknown Error Signatures (NEW — add to playbook)"
      echo ""
      echo '```'
      grep -E "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null | \
        grep -vE '__filename|fork/|MessageKey|syncFullHistory|ActiveWebListener|authProfileId|forkAttemptHooks|better-sqlite3' | \
        sort -u | head -20
      echo '```'
      echo ""
    } >> "$postmortem_file"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────────

echo "=== Merge Guardian — $(date) ===" > "$LOG"

check_fork_directories
check_hook_wiring
check_import_depth
check_extended_wirings
check_bundler_deps
check_config_schemas
check_ui_integrity
check_debug_artifacts
check_systemd_service
check_oauth_trycatch
check_credential_refresh_scope

build_failed=false
run_build_check || build_failed=true

echo ""
if [[ "$issues" -eq 0 ]]; then
  log "🟢 All checks passed — fork integrity verified"
else
  log "🔴 $issues issues detected"
fi

if [[ "$learn_mode" == true ]]; then
  write_postmortem "$build_failed"
fi

exit "$issues"
