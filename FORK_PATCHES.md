# Fork Patches Registry

All fork-specific patches to upstream files. After ANY upstream merge, run:

```bash
bash scripts/merge-guardian.sh --fix --learn
```

## Renamed Functions

| Original (upstream)                  | Fork rename                       | Files affected                                                            | Date       |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------- | ---------- |
| `shouldSuppressHeartbeatBroadcast()` | `shouldHideHeartbeatChatOutput()` | `src/gateway/server-chat.ts` (3 call sites: emitChatDelta, emitChatFinal) | 2026-02-22 |

## Upstream File Patches

### 1. `src/agents/pi-embedded-runner/run/attempt.ts`

- **Patch:** Fork hook wiring (2 imports + 4 hook call sites)
- **What:** personaBlock injection, mid-context reinject, text-tool-call interception, onTurnComplete (context anatomy, ENGRAM, SyncScore, observations)
- **Guard strings:** `fork/attempt-hooks` (import), `getPersonaBlock` (hook 1), `applyMidContextReinjectHook` (hook 2), `interceptTextToolCalls` (hook 3), `onTurnComplete` (hook 4)
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchAttempt()` (imports + ALL 4 call sites)
- **Risk:** HIGH — upstream changes this file every release
- **Added:** 2026-02-19, **Updated:** 2026-03-04 (call sites now auto-applied)

### 2. `src/agents/system-prompt.ts`

- **Patch:** personaBlock parameter + isMinimal skills suppression + personaBlock injection into output
- **Guard strings:** `personaBlock` (param), `params.personaBlock` (injection into lines array)
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchSystemPrompt()` (param + injection)
- **Added:** 2026-02-19, **Updated:** 2026-03-04 (injection now auto-applied)

### 3. `src/auto-reply/reply/session-reset-prompt.ts`

- **Patch:** Read SESSION.md from workspace root, falling back to upstream default
- **What:** `resolveSessionPromptBase(workspaceDir)` reads `SESSION.md`; `buildBareSessionResetPrompt` accepts optional `workspaceDir` param
- **Guard string:** `resolveSessionPromptBase`
- **Auto-applied by:** Manual
- **Risk:** MEDIUM — upstream may add params or rename function
- **Added:** 2026-03-04

### 3b. `src/auto-reply/reply/get-reply-run.ts`

- **Patch:** Pass `workspaceDir` to `buildBareSessionResetPrompt`
- **Guard string:** `workspaceDir`
- **Auto-applied by:** Manual
- **Added:** 2026-03-04

### 3c. `src/gateway/server-methods/agent.ts`

- **Patch:** Import `DEFAULT_AGENT_WORKSPACE_DIR` + pass to `buildBareSessionResetPrompt`
- **Guard string:** `DEFAULT_AGENT_WORKSPACE_DIR`
- **Auto-applied by:** Manual
- **Added:** 2026-03-04

### 4. `src/gateway/server-methods/sessions.ts`

- **Patch:** Webchat delete bypass — allow `delete` action from webchat clients
- **Guard string:** `Allow webchat delete`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchSessions()`
- **Risk:** HIGH — upstream rewrites session gating logic
- **Added:** 2026-03-04

### 5. `package.json`

- **Patch:** Fork dependencies: `better-sqlite3` (^12.6.2), `bindings` (^1.5.0)
- **Guard string:** `better-sqlite3`
- **Auto-applied by:** `merge-upstream.sh` post-merge restoration
- **Risk:** HIGH — upstream changes deps ~72 commits/month, removes these deps
- **Added:** 2026-02-20

### 6. `tsdown.config.ts`

- **Patch:** Native addon externalization: `external: ["better-sqlite3", "bindings"]`
- **Guard string:** `better-sqlite3` in external array
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchTsdownConfig()`
- **Risk:** MEDIUM — upstream adds new entries periodically
- **Added:** 2026-03-03

### 7. `src/agents/pi-embedded-runner/run.ts`

- **Patch:** Per-profile fallback error events + emitAgentEvent import (4 emission sites)
- **Guard strings:** `fallback-profile-error` AND `agent-events`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchRun()` (import + 2 advanceAuthProfile emission sites)
- **Risk:** MEDIUM — advanceAuthProfile structure may change
- **Added:** 2026-03-03, **Updated:** 2026-03-04 (now auto-applied)

### 8. `src/auto-reply/reply/agent-runner-execution.ts` + `src/agents/model-fallback.ts`

- **Patch:** failedProfileId extraction in RuntimeFallbackAttempt and model-fallback attempts
- **Guard string:** `failedProfileId`
- **Auto-applied by:** Manual (type definition + extraction)
- **Note:** Was `followup-runner.ts` before upstream rename to `agent-runner.ts`
- **Added:** 2026-03-03, **Updated:** 2026-03-04 (file rename, moved to type+extraction approach)

### 9. `src/agents/pi-embedded-helpers/errors.ts` + `failover-matches.ts`

- **Patch:** Billing cap classification (`regain access|specified.*usage limits` → "billing") in both failover-matches.ts (pattern array) and errors.ts (early check in classifyFailoverReason)
- **Guard string:** `regain access`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchFailoverMatches()` + `patchErrors()`
- **Added:** 2026-03-03, **Updated:** 2026-03-04 (now auto-applied)

### 10. `src/web/auto-reply/monitor/process-message.ts`

- **Patch:** thinking-reaction + offline-recovery imports AND call sites from fork module
- **Guard strings:** `_annotateOfflineRecovery` (offline recovery call), `_createThinkingReaction` (thinking reaction call)
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchProcessMessage()` (imports + both call sites)
- **Added:** 2026-02-19, **Updated:** 2026-03-04 (call sites now auto-applied)

### 11. `src/web/outbound.ts`

- **Patch:** WhatsApp group/edit/delete/reply/sticker outbound wrappers (16 functions + `OutboundOptions` type)
- **Guard string:** `Group & Extended Message Operations`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchOutbound()`
- **Risk:** LOW — upstream may add its own wrappers eventually (check for duplicates)
- **Added:** 2026-03-04

### 12. `src/agents/pi-embedded-subscribe.types.ts`

- **Patch:** `authProfileId?: string` field in `SubscribeEmbeddedPiSessionParams`
- **Guard string:** `authProfileId`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchSubscribeTypes()`
- **Risk:** MEDIUM — upstream rewrites type definitions
- **Added:** 2026-03-04

### 13. `src/web/auto-reply/monitor.ts`

- **Patch:** `syncFullHistory` conditional spread + `ActiveWebListener` type cast
- **Guard strings:** `syncFullHistory != null` AND `unknown as ActiveWebListener`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchMonitor()`
- **Risk:** MEDIUM — upstream changes monitor initialization
- **Added:** 2026-03-04

### 14. `src/web/auto-reply/monitor/process-message.ts` (import path correction)

- **Patch:** Correct import depth — `../../../fork/` (3 levels), not `../../../../fork/` (4 levels)
- **Guard string:** `../../../fork/process-message-hooks`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchProcessMessage()` (fixed in 2026-03-04)
- **Risk:** LOW — only triggered if fork import was previously wrong
- **Added:** 2026-03-04

## Config Schema Patches

| Schema file                        | Fork key                   | Pattern           | Date       |
| ---------------------------------- | -------------------------- | ----------------- | ---------- |
| `zod-schema.agent-defaults.ts`     | engram compaction mode     | `engram`          | 2026-02-27 |
| `zod-schema.agent-defaults.ts`     | pointerMode                | `pointerMode`     | 2026-02-27 |
| `config/types.agent-defaults.ts`   | AgentCompactionMode engram | `engram`          | 2026-02-27 |
| `zod-schema.providers-whatsapp.ts` | triggerPrefix              | `triggerPrefix`   | 2026-02-27 |
| `zod-schema.providers-whatsapp.ts` | ackMessage                 | `ackMessage`      | 2026-02-27 |
| `zod-schema.providers-whatsapp.ts` | syncFullHistory            | `syncFullHistory` | 2026-02-27 |

## Fork-Only Directories (zero upstream collision)

These directories exist ONLY in the fork. Upstream has none of them:

- `src/fork/` — hook entry points (attempt-hooks.ts, process-message-hooks.ts, etc.)
- `src/memory/` — cortex, engram, limbic, synapse
- `src/whatsapp-history/` — WhatsApp history import
- `src/agents/pi-extensions/` — retrieval runtime, tools
- `src/agents/tools/` — whatsapp-history-tool, canvas-tool, gateway-tool, web-tools
- `extensions/manus/` — Manus extension
- `extensions/budget-panel/` — Budget panel
- `extensions/tinker/` — Tinker Command Center plugin
- `extensions/hippocampus/` — Hippocampus memory search hook
- `extensions/overseer/` — Overseer sub-agent monitor
- `tinker-ui/` — Tinker webchat UI (separate Vite+Lit app)

## Post-Merge Checklist

After every upstream merge, `merge-guardian.sh` auto-checks most entries above.
For build errors, see `scripts/post-merge-build-playbook.md`.

Manually verify these patterns (most are now auto-checked by guardian):

```bash
# Auto-checked by merge-guardian.sh Phase 2:
grep "getPersonaBlock"              src/agents/pi-embedded-runner/run/attempt.ts
grep "applyMidContextReinjectHook"  src/agents/pi-embedded-runner/run/attempt.ts
grep "interceptTextToolCalls"       src/agents/pi-embedded-runner/run/attempt.ts
grep "onTurnComplete"               src/agents/pi-embedded-runner/run/attempt.ts
grep "fallback-profile-error"       src/agents/pi-embedded-runner/run.ts
grep "agent-events"                 src/agents/pi-embedded-runner/run.ts
grep "params.personaBlock"          src/agents/system-prompt.ts
grep "regain access"                src/agents/pi-embedded-helpers/failover-matches.ts
grep "_annotateOfflineRecovery"     src/web/auto-reply/monitor/process-message.ts
grep "_createThinkingReaction"      src/web/auto-reply/monitor/process-message.ts

# Manual-only checks:
grep "failedProfileId"              src/auto-reply/reply/agent-runner-execution.ts
grep "external.*better-sqlite3"     tsdown.config.ts
grep "shouldHideHeartbeatChatOutput" src/gateway/server-chat.ts
```

**Key improvement (2026-03-04):** `apply-fork-wiring.mjs` now restores BOTH imports AND call sites for attempt.ts, system-prompt.ts, process-message.ts, run.ts, failover-matches.ts, and errors.ts. Future `--theirs` merges are self-healing via `node scripts/apply-fork-wiring.mjs`.
