# Fork Patches Registry

This file is read by merge-upstream.sh to determine which files to auto-resolve
and how to handle them during upstream merges.

For detailed patch descriptions, guard strings, and post-merge checklists,
see `~/.openclaw/fork-scripts/FORK_PATCHES.md` (the comprehensive reference).

## TIER1 — Accept Upstream + Re-Wire
These files are resolved with `--theirs` (accept upstream version), then
`apply-fork-wiring.mjs` re-applies fork hooks.

| File | Patch Function | Notes |
|------|---------------|-------|
| src/agents/pi-embedded-runner/run/attempt.ts | patchAttempt | 2 imports + 4 hook call sites (persona, reinject, intercept, onTurnComplete) |
| src/agents/system-prompt.ts | patchSystemPrompt | personaBlock parameter + injection |
| src/agents/pi-embedded-runner/run.ts | patchRun | Per-profile fallback error events (4 emission sites) |
| src/agents/pi-embedded-subscribe.types.ts | patchSubscribeTypes | authProfileId field |
| src/agents/pi-embedded-helpers/errors.ts | patchErrors | Billing cap classification |
| src/agents/pi-embedded-helpers/failover-matches.ts | patchFailoverMatches | Billing pattern in failover array |
| src/agents/model-fallback.ts | patchBillingGate | Billing gate import + pre-flight check |
| src/gateway/server-methods/sessions.ts | patchSessions | Webchat delete bypass |
| src/web/auto-reply/monitor.ts | patchMonitor | syncFullHistory + ActiveWebListener |
| src/web/auto-reply/monitor/process-message.ts | patchProcessMessage | Thinking reaction + offline recovery hooks |
| src/web/outbound.ts | patchOutbound | WhatsApp group/edit/delete/reply/sticker wrappers |
| tsdown.config.ts | patchTsdownConfig | Native addon externals (better-sqlite3, bindings) |
| extensions/whatsapp/src/inbound/monitor.ts | patchMonitor | syncFullHistory + ActiveWebListener |

## PRESERVE — Always Keep Fork Version
These paths are always resolved with `--ours` during merge.

| Path | Reason |
|------|--------|
| src/fork/** | Fork hook implementations |
| src/memory/** | Cortex, engram, limbic, synapse |
| src/whatsapp-history/** | WhatsApp history import |
| src/agents/pi-extensions/** | Retrieval runtime + tools |
| src/agents/tools/** | Fork custom tools |
| extensions/manus/** | Manus extension |
| extensions/budget-panel/** | Budget panel extension |
| extensions/tinker/** | Tinker Command Center plugin |
| extensions/hippocampus/** | Hippocampus memory search |
| extensions/overseer/** | Overseer sub-agent monitor |
| tinker-ui/** | Fork webchat UI (Vite+Lit) |
| FORK_PATCHES.md | This file |
| TINKER_UI_DESIGN_BIBLE.md | Fork documentation |

## MANUAL — Require Human Review After Merge
These files have fork patches that cannot be auto-applied by regex.

| File | Guard String | Notes |
|------|-------------|-------|
| src/auto-reply/reply/session-reset-prompt.ts | resolveSessionPromptBase | SESSION.md workspace read |
| src/auto-reply/reply/get-reply-run.ts | workspaceDir | Pass workspaceDir to session reset |
| src/gateway/server-methods/agent.ts | DEFAULT_AGENT_WORKSPACE_DIR | Workspace dir import + pass |
| src/auto-reply/reply/agent-runner-execution.ts | failedProfileId | Profile ID extraction |
| src/browser/extension-relay.ts | ExtensionConnection | Multi-extension relay (structural) |
| src/agents/auth-profiles/credential-file.ts | refreshAnthropicOAuthToken | No scope in OAuth refresh body |
| src/agents/auth-profiles/oauth.ts | getOAuthApiKey | try-catch around OAuth key resolution |
| src/cli/daemon-cli/restart-health.ts | DEFAULT_RESTART_HEALTH_TIMEOUT_MS | 60s->10s health timeout |
| extensions/whatsapp/src/session.ts | credsSaveQueues | Baileys 515 error handling |

## IGNORE — Skip During Merge
These files are generated or local-only.

| Path | Reason |
|------|--------|
| dist/** | Build output |
| .cache/** | Build cache |
| node_modules/** | Dependencies |
