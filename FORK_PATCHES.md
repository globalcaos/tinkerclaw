# Fork Patches Registry

All fork-specific patches to upstream files. After ANY upstream merge, run:

```bash
bash scripts/merge-guardian.sh --fix --learn
```

## Renamed Functions

| Original (upstream)                  | Fork rename                       | Files affected                                                                   | Date       |
| ------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------- | ---------- |
| `shouldSuppressHeartbeatBroadcast()` | `shouldHideHeartbeatChatOutput()` | `src/web/auto-reply/server-chat.ts` (3 call sites: emitChatDelta, emitChatFinal) | 2026-02-22 |

## Upstream File Patches

### 1. `src/agents/pi-embedded-runner/run/attempt.ts`

- **Patch:** Fork hook wiring (4 imports + 6 code blocks)
- **What:** Forensic dump, persona block, retrieval pack, mid-context reinject, text-tool-call interception, onTurnComplete, contextAnatomy
- **Guard string:** `fork/attempt-hooks`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchAttempt()`
- **Risk:** HIGH — upstream changes this file every release
- **Added:** 2026-02-19

### 2. `src/agents/system-prompt.ts`

- **Patch:** personaBlock parameter + isMinimal skills suppression
- **Guard string:** `personaBlock`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchSystemPrompt()`
- **Added:** 2026-02-19

### 3. `src/auto-reply/reply/get-reply-run.ts`

- **Patch:** getSessionResetPrompt import
- **Guard string:** `session-reset-prompt`
- **Auto-applied by:** `apply-fork-wiring.mjs` → `patchGetReplyRun()`
- **Added:** 2026-03-03

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
- **Auto-applied by:** Manual (config format varies)
- **Risk:** MEDIUM — upstream adds new entries periodically
- **Added:** 2026-03-03

### 7. `src/agents/pi-embedded-runner/run.ts`

- **Patch:** Per-profile fallback error events + emitAgentEvent import
- **Guard string:** `fallback-profile-error` AND `agent-events`
- **Auto-applied by:** Manual (complex conditional logic)
- **Added:** 2026-03-03

### 8. `src/auto-reply/reply/followup-runner.ts`

- **Patch:** failedProfileId in fallback-error event
- **Guard string:** `failedProfileId`
- **Auto-applied by:** Manual
- **Added:** 2026-03-03

### 9. `src/agents/pi-embedded-helpers/errors.ts`

- **Patch:** Billing cap classification (`regain access|specified.*usage limits` → "billing")
- **Guard string:** `regain access`
- **Auto-applied by:** Manual
- **Added:** 2026-03-03

### 10. `src/web/auto-reply/monitor/process-message.ts`

- **Patch:** thinking-reaction + ack-message imports from fork module
- **Guard string:** `thinking-reaction` AND `ack-message`
- **Auto-applied by:** Manual (section 3 in apply-fork-wiring.mjs is empty — TODO)
- **Added:** 2026-02-19

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
- `src/agents/continuous-compact/` — continuous compaction
- `src/agents/pi-extensions/` — retrieval runtime, tools
- `src/agents/tools/` — hippocampus-bridge, whatsapp-history-tool
- `extensions/manus/` — Manus extension
- `extensions/budget-panel/` — Budget panel
- `extensions/tinker/` — Tinker Command Center plugin
- `extensions/overseer/` — Overseer sub-agent monitor
- `tinker-ui/` — Tinker webchat UI (separate Vite+Lit app)

## Post-Merge Checklist

After every upstream merge, `merge-guardian.sh` auto-checks most entries above.
Manually verify these patterns that are NOT auto-fixed by the guardian:

```bash
grep "fallback-profile-error" src/agents/pi-embedded-runner/run.ts
grep "failedProfileId" src/auto-reply/reply/followup-runner.ts
grep "regain access" src/agents/pi-embedded-helpers/errors.ts
grep "external.*better-sqlite3" tsdown.config.ts
grep "shouldHideHeartbeatChatOutput" src/web/auto-reply/server-chat.ts
```
