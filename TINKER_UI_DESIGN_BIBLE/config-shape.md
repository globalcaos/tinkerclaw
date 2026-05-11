---
file: config-shape.md
purpose: For every openclaw.json key, where it's read at runtime, the default chain, who can override
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — config-flow facts live here
see_also: topology.md (what runs), auth-routing.md (which model is picked), tool-loop.md (why cc-bridge has its own timeout)
---

# Config shape — openclaw.json flow into runtime

The fork has multiple override layers between `~/.openclaw/openclaw.json` and a running model call. Each row below is one key + its read site + override chain. **Anti-patterns** are flagged with `⚠️` — fields that look load-bearing but are dead code.

## Read priority (highest wins per field)

For provider/model config specifically:

1. **Plugin runtime overlay** — `registerPluginProviderConfigOverlay(providerId, partial)` from a plugin's `register()` hook. New FORK 2026-05-10. See bible §11.6e.
2. **`cfg.models.providers[provider]`** — the explicit openclaw.json block.
3. **`cfg.models.providers` normalized fallback** — `findNormalizedProviderValue` (handles prefix variants).
4. **Inline model match** — `cfg.models.providers[provider].models[]` and `cfg.agents.defaults.models[<provider/model>]`.
5. **Model registry** — `pi-coding-agent` built-in discovery.

`{...overlay, ...explicit}` semantics: explicit wins per-key; overlay fills gaps the user hasn't set.

## Top-level keys

### `agents.defaults.timeoutSeconds`

- **Read at:** `resolveAgentTimeoutMs` (src/agents/...)
- **Default:** none in code; openclaw.json sets 900
- **Override chain:** per-run `params.timeoutMs` > agent default
- **Drives:** session lock max hold, run-level abort timer
- **Current value:** 900s

### `models.providers.<provider>.timeoutSeconds`

- **Read at:** `resolveConfiguredProviderConfig` → `applyConfiguredProviderOverrides` → `resolveProviderRequestTimeoutMs` → attaches `requestTimeoutMs` to the resolved model → `resolveLlmIdleTimeoutMs` (via `params.model.requestTimeoutMs`)
- **Drives:** LLM idle watchdog timeout (`streamWithIdleTimeout` wraps the streamFn)
- **Default chain:** plugin overlay → explicit cfg → undefined (which then falls through to `clampImplicitTimeoutMs(agentTimeoutMs)`, capped at `DEFAULT_LLM_IDLE_TIMEOUT_MS=120_000`)
- **Current values:**
  - `claude-code`: 600 (from cc-bridge plugin overlay, FORK 2026-05-10, NOT openclaw.json)
  - `ollama`: undefined → default 120s
- **⚠️ Anti-pattern:** per-model `requestTimeoutMs` on the catalog model object is silently ignored. Only the provider-level `timeoutSeconds` propagates. See bible §11.6d.
- **⚠️ Anti-pattern (fixed 2026-05-10):** the cc-bridge plugin's `discovery.run` returning `{ provider: { timeoutSeconds: 600 } }` did NOT merge into cfg.models.providers. The fix is the plugin overlay (J15 §4 + bible §11.6e). Do NOT rely on the discovery path for runtime config; use the overlay.

### `agents.defaults.models[<provider/model>].rank`

- **Read at:** model-router skill, model-rank-refresh cron
- **Drives:** ordering in the models panel; failover order (cost-aware routing, see auth-routing.md)
- **Updated by:** `model-rank-refresh` cron at 06:30 daily, fetching Artificial Analysis Intelligence Index
- **Current top 3:** openai/gpt-5.5 (1), claude-code/claude-opus-4-7 (2), google/gemini-3.1-pro-preview (3)

### `agents.defaults.models[<provider/model>].alias`

- **Read at:** model-router skill, possibly chat command parsing
- **Drives:** short names users can refer to ("sonnet", "haiku", "gpt", etc.)
- **Override chain:** explicit cfg only; no overlay

### `agents.defaults.memorySearch.*`

- **Read at:** memory-core retrieval pipeline (upstream)
- **Drives:** Ollama embedding provider, mxbai-embed-large model, hybrid FTS+vector weighting, cache
- **Sources:** `memory`, `sessions`; `extraPaths: ["bank"]`
- **Critical:** the experimental `sessionMemory: true` flag enables retrieval over session jsonl, not just memory dirs

### `agents.defaults.compaction.{mode, pointerMode}`

- **Read at:** memory-core compaction pipeline
- **Drives:** engram pointer-mode compaction (J1)
- **Env coupling:** `ENGRAM_POINTER_COMPACTION=1` in env.vars (mirror, must stay in sync)

### `agents.defaults.contextPruning.{mode, ttl}`

- **Read at:** context-pruning pipeline
- **Drives:** cache-TTL based pruning (1h)

### `channels.<channel>.*`

- **Read at:** channel adapter (per-channel)
- **Drives:** per-channel behavior (trigger gating, delivery policy, etc.)
- **Current channels enabled:** `whatsapp`, `tinker` (webchat); `telegram` disabled

### `messages.groupChat.visibleReplies`

- **Read at:** auto-reply dispatch policy
- **Values:** `automatic` (auto-deliver), `message_tool_only` (only when explicit messaging tool is invoked)
- **Critical:** default is `message_tool_only`; must be set to `automatic` for groups to auto-deliver replies. See memory note 2026-05-04.

### `auth.profiles.<id>`

- **Read at:** auth-reload plugin, model failover
- **Drives:** per-provider credentials, OAuth vs API key
- **Critical:** Anthropic uses `cli-gm` profile (OAuth from `~/.claude/.credentials-gm.json`); the `api` profile is metered fallback.

### `auth.order.<provider>`

- **Read at:** model-fallback.ts
- **Drives:** profile order within a provider for fallback chains
- **Current Anthropic order:** `[cli-gm]` (subscription only; api fallback disabled by config)

### `auth.cooldowns.{billingBackoffHours, billingMaxHours, failureWindowHours}`

- **Read at:** model-fallback.ts
- **Drives:** how long to wait before retrying a billing-failed profile

### `env.vars.<key>`

- **Read at:** child-process spawn env (cc-bridge, exec tool, etc.)
- **Critical:** `DISPLAY=:0` enables GUI ops from spawned processes (browser, etc.)

### `tools.exec.*`

- **Read at:** exec tool gating
- **Values:** `ask: off`, `security: full`, `applyPatch.workspaceOnly: false`

### `commands.*`

- **Read at:** auto-reply command dispatcher
- **Drives:** which native commands are enabled, ownerDisplay format

### `cron.maxConcurrentRuns`

- **Read at:** cron scheduler
- **Drives:** parallelism cap (currently 6)
- **See:** `crons.md` for the job list

### `diagnostics.otel.*`

- **Read at:** otel exporter
- **Drives:** clawmetry/grafana traces+metrics

### `browser.*`

- **Read at:** browser plugin
- **Drives:** Chrome relay attach (existing-session driver, attachOnly:true, cdpUrl:`http://127.0.0.1:18792`)

## The dead-code patterns to remember

1. **Per-model `requestTimeoutMs`** on a catalog model object is ignored. Use provider-level `timeoutSeconds` (+ plugin overlay).
2. **Plugin `discovery.run` providerConfig fields** do NOT merge into `cfg.models.providers` at runtime. Use the plugin overlay (`registerPluginProviderConfigOverlay`).
3. **`config.models` BASE_METHODS reservation without a handler** blocks legitimate plugin handler registration. Symptom: "method already registered." Remove stale reservations. See bible §11.6c.
4. **`pnpm.onlyBuiltDependencies`** is wiped on upstream merges. `better-sqlite3`, `opusscript`, `@discordjs/opus` must be re-added after every merge.
5. **`configSchema` field in `openclaw.plugin.json`** is mandatory since 2026-03-05. Missing it = plugin config validation loop blocks ALL plugins.

## Auto-generation

The structural part of this file (the table rows) can be partially auto-generated by:

1. Parsing `openclaw.json` schema (`src/config/schema.base.generated.ts`).
2. Grepping `cfg.<key>` reads across src/.
3. Cross-referencing plugin manifests.

The override-chain prose and the anti-pattern list stay hand-written.

## Verify commands (to be added)

```yaml
verify:
  - cmd: openclaw gateway call debug.session.config --params '{"provider":"claude-code"}'
    expect: ".requestTimeoutMs == 600000" # confirms overlay path works
  - cmd: jq -r '.models.providers["claude-code"].timeoutSeconds // "unset"' ~/.openclaw/openclaw.json
    expect: '"unset"' # confirms we're relying on the overlay, not the patch
```

The `debug.session.config` probe is proposed; see `probes.md`.
