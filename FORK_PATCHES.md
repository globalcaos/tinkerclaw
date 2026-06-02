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

## 2026-04-17 — Claude Code bridge (Enchanted Mountain)

New fork-only plugin `extensions/tinkerclaw-cc-bridge/` registers a provider
`claude-code` that drives the real `claude` CLI as a persistent subprocess
per session. Inherits the Claude Code OAuth at `~/.claude/.credentials.json`
— flat-rate entitlement, no API key.

Why: Anthropic blocks non-Claude-Code OAuth server-side (bans since 2026-01-05
for spoofed clients; third-party harnesses dropped from subscription coverage
2026-04-04). Using the real binary legitimately, in a session-keyed worker
pool, avoids both the policy landmine and the Agent SDK's 12-second per-turn
cold start (SDK spawns fresh `claude` per `query()`; we keep it warm).

Plugin contents (all fork-only, so no merge collisions expected):

- `index.ts` — registers provider `claude-code`
- `src/worker.ts` — one persistent `claude --input-format stream-json --output-format stream-json` subprocess
- `src/worker-pool.ts` — `Map<sessionKey, Worker>`, killAll on gateway shutdown
- `src/stream.ts` — NDJSON events → pi-ai `AssistantMessageEvent` shim
- `src/protocol.ts` — reverse-engineered stream-json stdin/stdout schema (isolated for future Anthropic protocol drift)
- `src/auth.ts` — validates `~/.claude/.credentials.json`

Config additions in `~/.openclaw/openclaw.json`:

- `plugins.allow` += `"tinkerclaw-cc-bridge"`
- `plugins.entries.tinkerclaw-cc-bridge.enabled = true`
- `auth.profiles.claude-code:oauth`
- `auth.order.claude-code = ["claude-code:oauth"]`
- `models.providers.claude-code` (baseUrl `local://claude-cli`, 3 models)
- `agents.defaults.model.primary = "claude-code/claude-opus-4-7"`

Fallbacks kept: Ollama gemma4:26b for emergency only. `anthropic:cli-gm`
and `anthropic:api` profiles left in auth store but out of main rotation.

Risks / known-gaps:

- stream-json stdin schema is undocumented (issue anthropics/claude-code#24594
  closed "not planned"). Schema isolated in `src/protocol.ts` for easy update.
- First turn per session still pays ~12s cold spawn; every subsequent turn
  within the session reuses the warm worker (~network latency only).
- ToS gray zone — Anthropic explicitly disallows subscription OAuth from
  non-CC code (including the Agent SDK). Personal single-user use has not
  been banned in the wild but is policy-forbidden. Accepted risk.

No core files modified. No new fork patch functions needed in the wiring
script. Plugin lives entirely under `extensions/tinkerclaw-cc-bridge/`.

## 2026-04-15 — Silent-failure trio

Three independent root causes surfaced while debugging "Jarvis silent after
prompts" during the session on 2026-04-15. All three are source-patched
**and** wired so the next upstream merge auto-restores them.

| #   | File                                                       | Fix summary                                                         | Patch fn                       |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| 1   | src/agents/embedded-agent-runner/run/assistant-failover.ts | `surface_error` must throw a FailoverError, not fall through to     | patchSurfaceErrorThrow         |
|     |                                                            | `continue_normal`. Original branch logs the decision and returns,   |                                |
|     |                                                            | leaving the UI with no error bubble when no profile rotation or     |                                |
|     |                                                            | fallback model is available. Mirrors the existing fallback_model    |                                |
|     |                                                            | error-construction path.                                            |                                |
| 2   | src/agents/auth-profiles/proactive-refresh.ts              | Always consult the credential file FIRST when present, before       | patchProactiveRefreshDriftSync |
|     |                                                            | checking the store's own `expires`. Claude Code is single-writer    |                                |
|     |                                                            | for the credential file and rotates tokens independently of the     |                                |
|     |                                                            | 15-minute tick; trusting store expiry alone lets a server-revoked   |                                |
|     |                                                            | access token sit in the store looking valid, producing 60-second    |                                |
|     |                                                            | hangs on API calls instead of clean 401s.                           |                                |
| 3   | scripts/stage-bundled-plugin-runtime.mjs                   | `shouldCopyRuntimeFile` now also copies `.md`/`.txt`/`.yaml`/`.yml` | patchStagingRuntimeAssets      |
|     |                                                            | runtime assets alongside manifest files. Without this, extensions   |                                |
|     |                                                            | that ship text assets via `readFileSync(join(extensionDir, …))` —   |                                |
|     |                                                            | such as tinkerclaw-fractal-reflection reading `fractal-prompt.md` — |                                |
|     |                                                            | silently lose them in dist-runtime and fall back to hard-coded      |                                |
|     |                                                            | stubs, breaking extension behavior.                                 |                                |

**Symptoms these fixed:**

- Silent timeouts in webchat when no profile rotation / fallback was configured —
  Opus OAuth returned 429 fast, gateway reached `surface_error`, logged it, and
  returned `continue_normal` → no user-visible error.
- 60-second hangs on the next prompt after Claude Code rotated OAuth tokens —
  proactive-refresh short-circuited on store expiry and never saw the fresher
  credential-file tokens, so the next LLM call used a server-revoked access
  token that Anthropic stalled on for a full minute before the client timed out.
- Fractal reflections terminating with "NO" and rendering without the green
  `🌿 FRACTAL:` compaction prefix — the plugin's `loadPrompt()` fallback was
  serving a one-line stub because `fractal-prompt.md` was missing from
  dist-runtime (dropped by the staging step's manifest-only allowlist).

## 2026-04-14 — April 6 merge damage (restored)

The 2026-04-06 upstream merge silently dropped nine fork additions across the
type and helper layer. They were restored by hand on 2026-04-14 in commits
`9223a3cb9e` `e06283b94e` `62ae6c6ab3` `fbd5b51e20` `39d331ac8a` `88d361e8fa`,
and registered as wiring-script patches the same day so the next merge can
auto-restore them. The wiring script also gained a structural PRESERVE guard
and a cross-package import guard.

| #   | File                                                  | Symbol                            | Patch fn                    | Restored in |
| --- | ----------------------------------------------------- | --------------------------------- | --------------------------- | ----------- |
| 1   | src/config/types.auth.ts                              | AuthProfileConfig.displayName     | patchAuthProfileDisplayName | 9223a3cb9e  |
| 2   | src/agents/bash-tools.exec-host-shared.ts             | obfuscationDetected (×2 fns)      | patchObfuscationDetected    | 9223a3cb9e  |
| 3   | src/infra/heartbeat-runner.ts                         | hasFractalHook (type+ret+dst)     | patchHeartbeatFractalHook   | 9223a3cb9e  |
| 4   | src/agents/system-prompt.ts                           | amygdalaNudge (param+block)       | patchAmygdalaNudge          | e06283b94e  |
| 5   | src/agents/embedded-agent-subscribe.types.ts          | modelId + modelProvider           | patchSubscribeModelFields   | 62ae6c6ab3  |
| 6   | src/agents/embedded-agent-subscribe.handlers.types.ts | emitBlockReply on context         | patchEmitBlockReply         | 62ae6c6ab3  |
| 7   | src/auto-reply/reply/agent-runner.ts                  | resetTriggered                    | patchResetTriggered         | fbd5b51e20  |
| 8   | src/auto-reply/reply/get-reply.ts                     | applyMergePatch + logIngressStage | patchGetReplyHelpers        | fbd5b51e20  |
| 9   | src/media/read-response-with-limit.ts                 | onIdleTimeout                     | patchOnIdleTimeout          | fbd5b51e20  |

Structural guards added in the same wiring-script change:

- **`checkPreservePaths()`** — verifies `extensions/tinkerclaw-whatsapp/src/backfill/index.ts`
  and `extensions/tinkerclaw-whatsapp/src/history/` survived the merge. Both
  were dropped during the modularization extraction and restored from
  `preserve/tinkerclaw-whatsapp-*` tags. On miss, the script prints `⚠️`
  and sets exit code 1 — does NOT silently stub.
- **`checkCrossPackageImports()`** — walks `packages/memory-host-sdk/src/`
  for `../..`-style relative imports that resolve into `src/agents/` or
  `src/infra/`. The April merge moved memory-host-sdk one level deeper but
  left several test files at the old climb depth (4 levels instead of 5),
  silently breaking 9 imports. Guard prints `⚠️` for any unresolved spec.

## Post-Modularization Audit (2026-03-28, updated 2026-04-14)

| Metric                                               | Count | Notes                                                              |
| ---------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| FORK: marker files (src/, excl. src/fork/ and tests) | 57    | Upstream-touching files with fork modifications                    |
| FORK: marker occurrences total                       | 119   | Across 63 files (incl. src/fork/)                                  |
| Patch functions (apply-fork-wiring.mjs)              | 23    | 14 original + 9 added 2026-04-14 (April 6 merge damage)            |
| Structural guards (apply-fork-wiring.mjs)            | 2     | checkPreservePaths + checkCrossPackageImports (added 2026-04-14)   |
| Guardian checks (merge-guardian.sh)                  | 50    | Wiring + build verification points                                 |
| TIER1 files                                          | 14    | Accept upstream + re-wire (original list; 9 new files use --merge) |
| MANUAL files                                         | 10    | Require human review                                               |
| PRESERVE paths                                       | 13    | Always keep fork version                                           |

Cognitive extraction status:

- `src/memory/synapse/`, `src/memory/cortex/`, `src/memory/limbic/` — DELETED (extracted to extensions)
- `src/memory/**` PRESERVE rule — still valid for remaining files (embeddings-ollama.ts, embedding-model-limits.ts)
- `src/agents/system-prompt.ts` — STILL IN TIER1 (personaBlock injection remains inline, gated by feature flag)
- `src/agents/embedded-agent-runner/run.ts` — STILL IN TIER1 (per-profile fallback events not extracted)

Dry-run merge (2026-03-28): 185 commits behind upstream, 4 conflicts, no tags pending.

## TIER1 — Accept Upstream + Re-Wire

These files are resolved with `--theirs` (accept upstream version), then
`apply-fork-wiring.mjs` re-applies fork hooks.

| File                                                          | Patch Function            | Notes                                                                                         |
| ------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| src/agents/embedded-agent-runner/run/attempt.ts               | patchAttempt              | 2 imports + 4 hook call sites (persona, reinject, intercept, onTurnComplete)                  |
| src/agents/system-prompt.ts                                   | patchSystemPrompt         | personaBlock parameter + injection                                                            |
| src/agents/embedded-agent-runner/run.ts                       | patchRun                  | Per-profile fallback error events (4 emission sites)                                          |
| src/agents/embedded-agent-subscribe.types.ts                  | patchSubscribeTypes       | authProfileId field                                                                           |
| src/agents/embedded-agent-helpers/errors.ts                   | patchErrors               | Billing cap classification                                                                    |
| src/agents/embedded-agent-helpers/failover-matches.ts         | patchFailoverMatches      | Billing pattern in failover array                                                             |
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

| Path                                | Reason                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| src/fork/\*\*                       | Fork hook implementations                                                         |
| src/memory/\*\*                     | Embeddings (ollama, model-limits) — cortex/limbic/synapse extracted to extensions |
| src/whatsapp-history/\*\*           | WhatsApp history import                                                           |
| src/agents/pi-extensions/\*\*       | Retrieval runtime + tools                                                         |
| src/agents/tools/\*\*               | Fork custom tools                                                                 |
| extensions/manus/\*\*               | Manus extension                                                                   |
| extensions/budget-panel/\*\*        | Budget panel extension                                                            |
| extensions/tinker/\*\*              | Tinker Command Center plugin                                                      |
| extensions/hippocampus/\*\*         | Hippocampus memory search                                                         |
| extensions/overseer/\*\*            | Overseer sub-agent monitor                                                        |
| extensions/tinkerclaw-whatsapp/\*\* | Standalone WhatsApp plugin (whatsmeow backend, 4-tier access control, 2026-04-12) |
| tinker-ui/\*\*                      | Fork webchat UI (Vite+Lit)                                                        |
| FORK_PATCHES.md                     | This file                                                                         |
| TINKER_UI_DESIGN_BIBLE.md           | Fork documentation                                                                |

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

## New Fork Extensions

### tinkerclaw-whatsapp (2026-04-12)

- **Path:** `extensions/tinkerclaw-whatsapp/`
- **Purpose:** Standalone WhatsApp plugin extracting all fork WhatsApp code from upstream `extensions/whatsapp/`. whatsmeow-node (Go subprocess) as the only backend; Baileys adapter maps events so existing processing code works unchanged. Includes SQLite history (FTS5), multi-agent routing/congestion/budget/lifecycle, and the 4-tier access control model (self-chat, owner DM, agent group by name, authorized DM with prefix, everything else).
- **Status:** Created and builds. NOT yet wired into gateway config — upstream `extensions/whatsapp/` still runs. Channel ID `whatsapp` collides with upstream; enabling requires disabling the upstream extension.
- **Deferred tasks:** (10) delete upstream fork files after consumer migration; (11) remove `triggerPrefixExempt` from `~/.openclaw/openclaw.json`, drop `OPENCLAW_WHATSAPP_BACKEND` env; (12) integration test with upstream disabled.
- **Known caveats:** plugin currently re-exports `whatsappPlugin` and `monitorWebInbox` from upstream (full localization deferred); `send.ts` still imports `loadOutboundMediaFromUrl` from upstream.
- **Docs:** `~/.openclaw/workspace/memory/knowledge/tinkerclaw-whatsapp-plugin.md`
