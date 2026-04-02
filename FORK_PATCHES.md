# Fork Patches Registry

This file is read by merge-upstream.sh to determine which files to auto-resolve
and how to handle them during upstream merges.

For detailed patch descriptions, guard strings, and post-merge checklists,
see `~/.openclaw/fork-scripts/FORK_PATCHES.md` (the comprehensive reference).

## Resolution Cascade (6 layers)

When a conflict occurs during upstream merge, it passes through these resolvers in order:

1. **TIER1 merge driver** — `.gitattributes` routes TIER1 files to `tier1-driver.sh` (accept upstream + re-wire)
2. **Git rerere** — auto-applies recorded resolutions from past merges (168 cached as of 2026-03-28)
3. **PRESERVE paths** — `merge-upstream.sh` keeps `--ours` for fork-only directories
4. **Mergiraf** — syntax-aware merge for TS/JS files (NOT INSTALLED: no cargo, no binary available)
5. **Wiring script** — `apply-fork-wiring.mjs` re-applies fork hooks post-merge
6. **LLM agent** — cron agent (opus, 60min) resolves remaining conflicts

## Post-Modularization Audit (2026-03-28)

| Metric                                               | Count | Notes                                                    |
| ---------------------------------------------------- | ----- | -------------------------------------------------------- |
| FORK: marker files (src/, excl. src/fork/ and tests) | 57    | Upstream-touching files with fork modifications          |
| FORK: marker occurrences total                       | 119   | Across 63 files (incl. src/fork/)                        |
| Patch functions (apply-fork-wiring.mjs)              | 14    | Auto-applied after --theirs merge                        |
| Guardian checks (merge-guardian.sh)                  | 50    | Wiring + build verification points                       |
| TIER1 files                                          | 14    | Accept upstream + re-wire (matches patch function count) |
| MANUAL files                                         | 10    | Require human review                                     |
| PRESERVE paths                                       | 13    | Always keep fork version                                 |

Cognitive extraction status:

- `src/memory/synapse/`, `src/memory/cortex/`, `src/memory/limbic/` — DELETED (extracted to extensions)
- `src/memory/**` PRESERVE rule — still valid for remaining files (embeddings-ollama.ts, embedding-model-limits.ts)
- `src/agents/system-prompt.ts` — STILL IN TIER1 (personaBlock injection remains inline, gated by feature flag)
- `src/agents/pi-embedded-runner/run.ts` — STILL IN TIER1 (per-profile fallback events not extracted)

Dry-run merge (2026-03-28): 185 commits behind upstream, 4 conflicts, no tags pending.

## TIER1 — Accept Upstream + Re-Wire

These files are resolved with `--theirs` (accept upstream version), then
`apply-fork-wiring.mjs` re-applies fork hooks.

| File                                                          | Patch Function            | Notes                                                                                         |
| ------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| src/agents/pi-embedded-runner/run/attempt.ts                  | patchAttempt              | 2 imports + 4 hook call sites (persona, reinject, intercept, onTurnComplete)                  |
| src/agents/system-prompt.ts                                   | patchSystemPrompt         | personaBlock parameter + injection                                                            |
| src/agents/pi-embedded-runner/run.ts                          | patchRun                  | Per-profile fallback error events (4 emission sites)                                          |
| src/agents/pi-embedded-subscribe.types.ts                     | patchSubscribeTypes       | authProfileId field                                                                           |
| src/agents/pi-embedded-helpers/errors.ts                      | patchErrors               | Billing cap classification                                                                    |
| src/agents/pi-embedded-helpers/failover-matches.ts            | patchFailoverMatches      | Billing pattern in failover array                                                             |
| src/gateway/server-methods/sessions.ts                        | patchSessions             | Webchat delete bypass                                                                         |
| extensions/whatsapp/src/auto-reply/monitor.ts                 | patchMonitor              | syncFullHistory + ActiveWebListener                                                           |
| extensions/whatsapp/src/auto-reply/monitor/process-message.ts | patchProcessMessage       | Thinking reaction + offline recovery hooks                                                    |
| extensions/whatsapp/src/send.ts                               | patchOutbound             | WhatsApp group/edit/delete/reply/sticker wrappers                                             |
| extensions/whatsapp/src/session.ts                            | patchWhatsAppSession      | Baileys 515 error handling (credsSaveQueues)                                                  |
| src/gateway/server/ws-connection/message-handler.ts           | patchMessageHandlerScopes | Extension relay scopes — ⚠️ ALSO MANUAL: scope clearing policy for device-less auth (B014 #5) |
| tsdown.config.ts                                              | patchTsdownConfig         | Native addon externals — ⚠️ `external` replaced by `deps.neverBundle` upstream (B014 #1)      |
| package.json                                                  | patchDevDeps              | Fork dev dependencies                                                                         |

## PRESERVE — Always Keep Fork Version

These paths are always resolved with `--ours` during merge.

| Path                          | Reason                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| src/fork/\*\*                 | Fork hook implementations                                                         |
| src/memory/\*\*               | Embeddings (ollama, model-limits) — cortex/limbic/synapse extracted to extensions |
| src/whatsapp-history/\*\*     | WhatsApp history import                                                           |
| src/agents/pi-extensions/\*\* | Retrieval runtime + tools                                                         |
| src/agents/tools/\*\*         | Fork custom tools                                                                 |
| extensions/manus/\*\*         | Manus extension                                                                   |
| extensions/budget-panel/\*\*  | Budget panel extension                                                            |
| extensions/tinker/\*\*        | Tinker Command Center plugin                                                      |
| extensions/hippocampus/\*\*   | Hippocampus memory search                                                         |
| extensions/overseer/\*\*      | Overseer sub-agent monitor                                                        |
| tinker-ui/\*\*                | Fork webchat UI (Vite+Lit)                                                        |
| FORK_PATCHES.md               | This file                                                                         |
| TINKER_UI_DESIGN_BIBLE.md     | Fork documentation                                                                |

## MANUAL — Require Human Review After Merge

These files have fork patches that cannot be auto-applied by regex.

| File                                           | Guard String                      | Notes                                                              |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| src/auto-reply/reply/session-reset-prompt.ts   | resolveSessionPromptBase          | SESSION.md workspace read                                          |
| src/auto-reply/reply/get-reply-run.ts          | workspaceDir                      | Pass workspaceDir to session reset                                 |
| src/gateway/server-methods/agent.ts            | DEFAULT_AGENT_WORKSPACE_DIR       | Workspace dir import + pass                                        |
| src/auto-reply/reply/agent-runner-execution.ts | failedProfileId                   | Profile ID extraction                                              |
| src/browser/extension-relay.ts                 | ExtensionConnection               | Multi-extension relay (structural)                                 |
| src/agents/auth-profiles/credential-file.ts    | refreshAnthropicOAuthToken        | No scope in OAuth refresh body                                     |
| src/agents/auth-profiles/oauth.ts              | getOAuthApiKey                    | try-catch around OAuth key resolution                              |
| src/cli/daemon-cli/restart-health.ts           | DEFAULT_RESTART_HEALTH_TIMEOUT_MS | 60s->10s health timeout                                            |
| src/agents/model-fallback.ts                   | billing gate                      | 4 FORK markers: billing gate, fallback notify, profileId tracking  |
| extensions/whatsapp/src/inbound/monitor.ts     | whatsmeow                         | 5 FORK markers: whatsmeow backend, E164 group fix, triggerPrefix   |
| src/agents/auth-profiles/store.ts              | resolveRuntimeStoreKey            | runtimeKey must be declared — upstream assumes local var (B014 #2) |
| tinker-ui/vite.config.ts                       | **BUNDLED_DEV**                   | Vite 8 requires define: { **BUNDLED_DEV**: 'false' } (B014 #4)     |

## IGNORE — Skip During Merge

These files are generated or local-only.

| Path              | Reason       |
| ----------------- | ------------ |
| dist/\*\*         | Build output |
| .cache/\*\*       | Build cache  |
| node_modules/\*\* | Dependencies |
