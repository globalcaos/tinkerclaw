---
file: config-shape.md
purpose: For every openclaw.json key, where it's read at runtime, the default chain, who can override
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — config-flow facts live here
see_also: topology.md (what runs), auth-routing.md (which model is picked), tool-loop.md (why cc-bridge has its own timeout)
verify:
  - name: claude-code provider overlay resolves timeoutSeconds=600
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.session.config","--params",json.dumps({"provider":"claude-code"})],capture_output=True,text=True); assert "\"resolvedRequestTimeoutMs\": 600000" in r.stdout, r.stdout[-500:]'
  - name: agents.defaults.timeoutSeconds is 900 in openclaw.json
    cmd: python3 -c 'import json,os; assert json.load(open(os.path.expanduser("~/.openclaw/openclaw.json")))["agents"]["defaults"]["timeoutSeconds"] == 900'
  - name: claude-code timeoutSeconds is NOT manually set in openclaw.json (must come from overlay)
    cmd: python3 -c 'import json,os; cfg = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); cc = cfg["models"]["providers"]["claude-code"]; assert "timeoutSeconds" not in cc'
  - name: dead-code trap registry table is current (8 rows expected today)
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/config-shape.md")).read(); rows = [line for line in t.split("\n") if line.startswith("| T") and "|" in line[3:]]; assert len(rows) >= 8, f"only {len(rows)} dead-code-trap rows — has a trap been added without registering it?"'
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

## Dead-code config trap registry

Each trap is a config surface that _looks_ like it should apply at runtime but doesn't. Tagged `dead-code` so the bug-log's `config-dead-code` failure class (see `bug-log.md`) can correlate. The pattern is always: a key/path that is syntactically valid, accepted by the config loader, and not flagged as an error — but never read by the code path that needs it.

| #   | Trap                                                                                                                                   | Looks live because                                                                                                                                                                           | What actually applies                                                                                                                                                        | Detection command                                                                                                                                                                                                                                           | Class                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| T1  | Per-model `requestTimeoutMs` on a catalog model object                                                                                 | The field type accepts a `number`; the model object lists it next to `id`/`name`                                                                                                             | The idle watchdog reads only `providerConfig.timeoutSeconds` (via `resolveProviderRequestTimeoutMs` → `applyConfiguredProviderOverrides`). The model-level field is ignored. | `openclaw gateway call debug.session.config --params '{"provider":"claude-code"}'` → assert `resolvedRequestTimeoutMs == 600000`. If you set it on the model object and got 120s, you hit this trap.                                                        | `config-dead-code`              |
| T2  | Plugin `discovery.run` returning `{ provider: { timeoutSeconds: N } }`                                                                 | The discovery API accepts a `providerConfig`-shaped payload and the gateway loads it without error                                                                                           | `cfg.models.providers` is not mutated. The 2026-05-10 fix: `registerPluginProviderConfigOverlay(providerId, partial)` from the plugin's `register()` hook                    | Same as T1 — `debug.session.config` is the canary. If `effective.timeoutSeconds` is missing despite a discovery.run setting it, you hit T2.                                                                                                                 | `config-dead-code`              |
| T3  | `plugins.allow: <name>` entry naming a plugin that no longer exists (e.g. the old `whatsapp` id after rename to `tinkerclaw-whatsapp`) | The gateway emits a warning ("`plugins.allow: plugin not found: <name> (stale config entry ignored; remove it from plugins config)`") but BOOTS NORMALLY and continues to load other plugins | Nothing — the stale allowlist entry is silently dropped. The new plugin id must be in `plugins.allow` for the plugin to load; the old id is decorative noise.                | Boot journal scan: `journalctl --user -u openclaw-gateway.service --since today --no-pager \| grep -E 'plugin not found:'`. Each match is one stale entry to clean from `openclaw.json:plugins.allow`.                                                      | `config-dead-code` + `noisy`    |
| T4  | `plugins.entries.<name>` config present for a plugin not in the allowlist                                                              | The config block validates against the plugin's `configSchema` so it looks complete                                                                                                          | The plugin is disabled (because not in `plugins.allow`), so the entry is decorative                                                                                          | `openclaw gateway call plugin.boot.status --params '{"status":"disabled"}'` (FORK 2026-05-11) — any plugin whose `enabled:false` while the entry has substantive config is T4.                                                                              | `config-dead-code` + `noisy`    |
| T5  | Model-level field on a catalog model whose provider config doesn't merge it                                                            | Most catalog model fields ARE read (id, name, alias, rank, contextWindow). But adding a NEW field doesn't automatically wire it.                                                             | The field is held in memory and exposed via `models.list` but never read by any consumer until explicit code wires it. Often added speculatively in PRs and forgotten.       | `grep -rn "model\\.<fieldName>" src/ extensions/` — if the grep returns zero, the field is dead.                                                                                                                                                            | `config-dead-code` + `forward`  |
| T6  | Old `config.models` BASE_METHODS reservation without a handler                                                                         | The method name appears in the BASE_METHODS list                                                                                                                                             | The legitimate plugin handler can't register because the reservation collides ("method already registered"). The fix is to remove the stale reservation. See bible §11.6c.   | At plugin load: `[plugin] method already registered: <name>` in the journal. The probe `plugin.boot.status` would report this plugin's `failurePhase:"register"`.                                                                                           | `config-dead-code` + `blocking` |
| T7  | `pnpm.onlyBuiltDependencies` array — load-bearing but easy to lose                                                                     | The field is just a list of package names                                                                                                                                                    | Required for `better-sqlite3`, `opusscript`, `@discordjs/opus` to be pre-built. Wiped on every upstream merge.                                                               | `plugin.boot.status --params '{"status":"error"}'` → any plugin with `Cannot find module '@sinclair/typebox'` or similar native-binding error in `failurePhase:"load"` is the canary. Today's example: `tinkerclaw-round-table`, `tinkerclaw-total-recall`. | `merge-wipe` + `bundler-trap`   |
| T8  | `configSchema` field absent from `openclaw.plugin.json`                                                                                | The plugin loads in older builds where the field was optional                                                                                                                                | Since 2026-03-05, missing it = plugin config validation loop blocks ALL plugins (cascading)                                                                                  | `plugin.boot.status --params '{"status":"error"}'` → plugin with `failurePhase:"validation"` is T8                                                                                                                                                          | `plugin-load` + `blocking`      |

**Discipline for adding new traps to this registry.** A trap qualifies when (a) the config surface looks load-bearing to a reader, AND (b) at least one incident proved the runtime ignores it. Add the row WITH the detection command at the time the trap is first identified — never just "TBD". The detection command is the contract the merge gate enforces.

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
