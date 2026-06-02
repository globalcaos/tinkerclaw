---
file: config-shape.md
purpose: For every openclaw.json key, where it's read at runtime, the default chain, who can override
audience: AI
last_verified: 2026-06-02
last_verified_commit: 06f8647fdc
single_owner: yes — config-flow facts live here
see_also: topology.md (what runs), auth-routing.md (which model is picked), tool-loop.md (why cc-bridge has its own timeout)
verify:
  - name: claude-code provider overlay resolves timeoutSeconds=600
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.session.config","--params",json.dumps({"provider":"claude-code"})],capture_output=True,text=True); assert "\"resolvedRequestTimeoutMs\": 600000" in r.stdout, r.stdout[-500:]'
  - name: agents.defaults.timeoutSeconds is 900 in openclaw.json
    cmd: python3 -c 'import json,os; assert json.load(open(os.path.expanduser("~/.openclaw/openclaw.json")))["agents"]["defaults"]["timeoutSeconds"] == 900'
  - name: claude-code timeoutSeconds is NOT manually set in openclaw.json (must come from overlay)
    cmd: python3 -c 'import json,os; cfg = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); cc = cfg["models"]["providers"]["claude-code"]; assert "timeoutSeconds" not in cc'
  - name: dead-code trap registry table is current (10 rows expected today, incl U7 T9/T10)
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/config-shape.md")).read(); rows = [line for line in t.split("\n") if line.startswith("| T") and "|" in line[3:]]; assert len(rows) >= 10, f"only {len(rows)} dead-code-trap rows — has a trap been added without registering it?"'
  - name: U8 ENGRAM_RECONCILE is a real env-gated read site in ingestion.ts (dark-launch flag exists in code)
    cmd: python3 -c 'import os; assert "process.env.ENGRAM_RECONCILE" in open(os.path.expanduser("~/src/tinkerclaw/src/memory/engram/ingestion.ts")).read()'
  - name: U8 ENGRAM_RECONCILE is dark-launched OFF (UNSET in openclaw.json — safe default)
    cmd: python3 -c 'import json,os; v = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))).get("env",{}).get("vars",{}); assert "ENGRAM_RECONCILE" not in v, "ENGRAM_RECONCILE was flipped on — confirm it was intentional"'
  - name: U7 round-table respectBillingGate(default true) + orchestratorId(default raac) keys exist in plugin schema
    cmd: python3 -c 'import json,os; p = json.load(open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-round-table/openclaw.plugin.json")))["configSchema"]["properties"]; assert p["respectBillingGate"]["default"] is True and p["orchestratorId"]["default"] == "raac"'
  - name: U7 7D/7G dead-code trap real — agent.getBillingState + plugins.getOrchestrator are NOT registered in src/
    cmd: python3 -c 'import subprocess,os; src=os.path.expanduser("~/src/tinkerclaw/src"); a=subprocess.run(["grep","-rn","agent.getBillingState",src],capture_output=True,text=True).stdout.strip(); o=subprocess.run(["grep","-rn","plugins.getOrchestrator",src],capture_output=True,text=True).stdout.strip(); assert a=="" and o=="", "an RPC the round-table reads now exists in src/ — T9/T10 may have bound; re-verify the trap rows"'
  - name: U10 fork.cognitive.reasoning is read by getReasoningMode (tri-state) and is UNSET (default none)
    cmd: python3 -c 'import os,json; assert "fork?.cognitive?.reasoning" in open(os.path.expanduser("~/src/tinkerclaw/src/fork/reasoning-runtime.ts")).read(); assert json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))).get("fork",{}).get("cognitive",{}).get("reasoning") is None'
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

## OSS-harness upgrade config keys (U1–U12, FORK 2026-06-02, commit 06f8647fdc)

The 12 OSS-harness upgrades (U1–U12; roadmap `docs/notes/2026-05-30-papers-coverage-and-oss-roadmap.md` Part 3 in jarvis-icu) added three new operator-facing config surfaces this optic owns: one env flag (U8), two round-table plugin keys (U7), one fork cognitive key (U10). Most upgrades reuse existing already-true autonomy env flags (cross-referenced below) and need NO new config.

### `env.vars.ENGRAM_RECONCILE` (U8 — Mem0 write-reconciliation, DARK-LAUNCHED OFF)

- **Read at:** `process.env.ENGRAM_RECONCILE === "true"` in three hot-path sites — `src/memory/engram/ingestion.ts:159` (`reconcileActive` gate), `src/cron/jobs/engram-consolidate.ts:297` (consolidation `reconcileWindow`), `src/fork/attempt-hooks.ts:939` (reconciliation summary trail line).
- **Default:** **OFF** — UNSET in `~/.openclaw/openclaw.json` (verified absent). The ingestion pipeline always _constructs_ a reconciler (`createAlwaysAddReconciler()` so the field is never undefined), but `decideSync` is only _consulted_ when `config.reconciler != null || process.env.ENGRAM_RECONCILE === "true"`. With the flag off and no explicit reconciler injected, the decision call is **skipped entirely → byte-identical to pre-reconciliation behavior** (always-ADD = today's behavior).
- **Drives:** when "true", the Mem0 reconciler's ADD/UPDATE/DELETE/NONE ledger (`reconciliation.ts` + `reconciliation-ledger.ts`) becomes active in the ingestion append path and the consolidation window; `memory-md-writer.ts` emits bounded, idempotent, suggest-only MEMORY.md edits.
- **Override chain:** explicit per-call `config.reconciler` injection (always active regardless of flag) > `ENGRAM_RECONCILE` env > off.
- **Don't regress:** this is a deliberate dark-launch. Do NOT flip it to "true" in openclaw.json without the architect's sign-off; the default reconciler being always-ADD means the safe path and the flag-off path are intentionally identical.
- **Kind:** this is an `env.vars.<key>` instance (see that key above for the spawn-env read model); listed separately here because it is a feature-gate, not a process-env passthrough.

### `<round-table plugin>.respectBillingGate` (U7 7D — cost-aware debate budget) ⚠️ inert

- **Schema:** `configSchema.properties.respectBillingGate` in `extensions/tinkerclaw-round-table/openclaw.plugin.json` (boolean, **default `true`**).
- **Read at:** `extensions/tinkerclaw-round-table/index.ts:166` → at debate time queries the gateway RPC `agent.getBillingState` and, if headroom is known, calls `resolveDebateBudget` to clamp `config.maxBudgetPerDebate` to a fraction of remaining USD.
- **⚠️ CURRENTLY INERT:** `agent.getBillingState` is **not a registered gateway method** (grep of `src/` returns zero). The `callGatewayFromCli("agent.getBillingState", …)` always errors → headroom stays `undefined` → `resolveDebateBudget` is a no-op → behaviour is identical whether this key is true or false. The wiring is pre-placed so the clamp activates the day the RPC ships. **Registered as dead-code trap T9 below.**
- **Override chain:** plugin config block only; no overlay.

### `<round-table plugin>.orchestratorId` (U7 7G — debate choreography) ⚠️ partly inert

- **Schema:** `configSchema.properties.orchestratorId` in `extensions/tinkerclaw-round-table/openclaw.plugin.json` (string, **default `"raac"`**).
- **Read at:** `extensions/tinkerclaw-round-table/index.ts:168`; resolved via `getOrchestrator(orchestratorId)` (`src/orchestrator-api.ts`).
- **Active values:** `"raac"` (the 5-phase RAAC protocol, default) plus the builtin alternative choreographies (`fan-out`, `sequential`, `moderated-tribunal`) are **fully active** — they resolve inside the extension.
- **⚠️ EXTERNAL path inert:** any _other_ id is resolved through the external loader, which calls gateway RPC `plugins.getOrchestrator` — **not a registered gateway method** (grep of `src/` returns zero). The loader always returns null and `getOrchestrator` falls back to `raacOrchestrator` (logs `orchestrator '<id>' unresolved; falling back to 'raac'`). So setting `orchestratorId` to a non-builtin id is currently a no-op fall-back. **Registered as dead-code trap T10 below.**
- **Override chain:** plugin config block only; no overlay.
- **Sibling note:** the 7A speaker-selection hook follows the same open-substrate pattern via `plugins.getSpeakerSelectionHook` (also unregistered today; degrades to builtin). Not a config key, so not registered as a separate trap — same class as T10.

### `fork.cognitive.reasoning` (U10 — ToT/LATS thought search, tri-state)

- **Read at:** `getReasoningMode()` in `src/fork/reasoning-runtime.ts:291` — reads `snapshot.config.fork.cognitive.reasoning` dynamically off the live runtime config snapshot (`getRuntimeConfigSnapshot`), NOT off a typed schema field (the key is read untyped so it works before the schema declares it).
- **Values:** tri-state `"none" | "tree" | "lats"`. Any unknown/invalid value (or a throwing/absent snapshot) coerces to `"none"` (fail-safe).
- **Default:** **`"none"`** — UNSET in openclaw.json (verified absent). ToT is opt-in and expensive, so it must NOT default on.
- **Drives:** when `"tree"` or `"lats"`, the pre-prompt `maybeRunThoughtSearch` in `attempt.ts` runs a bounded thought search (LATS adds value-backup) and folds the winning leaf into the prompt under "## Deliberation"; `reasoning_tree_state` is persisted as a MemoryEvent in `onTurnComplete`. Automated sessions (cron/heartbeat/subagent/isolated) are skipped regardless of mode (`shouldRunThoughtSearch`).
- **Override chain:** runtime config snapshot only; per-turn there is no override (mode is read fresh each turn).
- **see also:** `tool-loop.md` (the deliberation-prompt turn-local apply — a bugfix in `attempt.ts` captured `preDeliberationSystemPromptText` and restores the TRUE base in `finally` so the deliberation block no longer leaks into the next turn when a runtimeContext override is present).

### Reused autonomy env flags (cross-ref — owned as `env.vars.<key>` above; NOT new in U1–U12)

The OSS upgrades that need a runtime gate reuse the three full-autonomy flags already set `"true"` in `~/.openclaw/openclaw.json` `env.vars` (granted 2026-05-31; see jarvis-icu memory `project_jarvis_full_autonomy_flags.md`). No new key was added for these:

- **`RECIPE_AUTOAPPLY_ENABLED`** (`"true"`) — gates **U1** recipe-evolution self-apply (`recipe-evolution.ts` `isAutoPromotable` + kit-runner `recipe:<owner/slug>` attribution feeding `makeFitnessLookup`). Same flag that already gated recipe self-rewrite.
- **`ENGRAM_SUPERSEDE_ENABLED`** (`"true"`) — gates **U3** bi-temporal supersede (`supersede-writer.ts` interval-close on contradiction; `temporalMode`/`asOfTime` on `fork.memory.search`).
- **`PREFRONTAL_SEMANTIC_MATCH_ENABLED`** (`"true"`) — semantic kit/recipe match lane; threaded by U1's fitness feedback into `matchKitsDetailed`.
- **No new flag** for U4 (failure→strategy-switch, driven by the engram-consolidate cron), U5 (durable checkpointing), U6 (Voyager skill-library), U9 (A-MEM Zettelkasten links), U11 (external recipe acquisition), U12 (recipe marketplace) — these are always-on once the consolidation cron / kit-runner paths execute; their behavior is data-driven, not config-gated.

## control-panel plugin schema (v3.5 — 2026-05-22)

The control-panel plugin owns the Today card / Exec panel surface (see `tinker-ui.md` §5.68). Its SQLite store lives at `~/.openclaw/data/control-panel.db`; schema in `extensions/tinkerclaw-control-panel/src/store/schema.{sql,ts}` + migrations in `db.ts`.

### `task_axis.parent_id` (v3.5)

- **Column shape:** `parent_id TEXT REFERENCES task_axis(id) ON DELETE CASCADE` — self-referencing nullable FK. NULL = top-level group. Index `task_axis_parent` on `(parent_id)`.
- **Migration owner:** `addAxisParentIdColumn` in `db.ts` (idempotent ALTER TABLE; checks `PRAGMA table_info` for the column before adding). The index is created **inside the migration**, not inside `schema.ts` (see `failures.md` M12 — schema-migration ordering bug).
- **Depth cap:** two levels only (group → sub-group). Enforced at the application layer by `validateParentDepth` (`src/store/axes.ts`): an axis with `parent_id != NULL` cannot itself be a parent. `addAxis` and `updateAxis` reject violators with a thrown error. There is no DB-level CHECK constraint — the discipline is the function call.
- **Cascade:** deleting a top-level group cascades-deletes its sub-groups via the FK. Tasks reference `priority_axis` via TEXT (not FK), so post-cascade their axis becomes a dangling reference; the UI falls back to an "unsorted" implicit bucket.
- **Ordering:** `position` is per-level (top-level groups ordered among themselves; sub-groups ordered within their parent). The position-MAX query in `addAxis` uses `COALESCE(parent_id, '')` so the NULL-parent and named-parent scopes don't collide.

### `task.priority_rank` (INTEGER, clean-spacing maintained client-side)

- **Column shape:** `INTEGER` — unchanged from earlier versions.
- **⚠️ History trap:** midpoint arithmetic `(prev + next) / 2` on integers compresses adjacent ranks to identical values over a few reorders, breaking sort. Confirmed in live data (`ventures` axis: 21 tasks at rank=30 + 17 at rank=40 before the 2026-05-23 fix). See `failures.md` M11.
- **Current strategy:** client renumbers ALL tasks in the destination axis with spacing 100 on **every drop** via parallel `tasks.update` RPCs. "Fresh ranks on every move" instead of "midpoint forever." Schema stays INTEGER; clean-spacing is a UI invariant.
- **Don't regress:** never reintroduce midpoint arithmetic on INTEGER ranks. If you need single-RPC ordering, change the column type to REAL — at which point midpoints are safe again.

### `task_axis_metadata_json` — Todoist scrub (v3.5)

- **Migration owner:** `stripTodoistMetadata` in `db.ts` (idempotent one-shot — scans every task's `metadata_json`, strips keys matching `^todoist_*`, rewrites). Re-running is a no-op.
- **Trigger:** runs on every gateway boot via the migration step in `getDb()`. Drawer renders no longer recognise any `todoist_*` chips. Pair with the delete of `extensions/tinkerclaw-control-panel/scripts/import-from-todoist.mjs`.

## cc-bridge ethical-rules prompt loader (FORK 2026-05-21)

The cc-bridge plugin loads an `ethical-rules` block into the worker's `--append-system-prompt` between the persona block and the narration/tool-choice/plan-tools blocks. See `tool-loop.md` for the slot in `combinedSystemPrompt`.

**Resolution order** (per `loadPromptFile` defaults; first existing path wins):

1. `env.TINKERCLAW_ETHICAL_RULES_PROMPT` — explicit path override.
2. `~/.openclaw/workspace/memory/knowledge/jarvis-ethical-rules.md` — user-personalised override (outside the public repo).
3. `extensions/tinkerclaw-cc-bridge/prompts/ethical-rules-default.md` — bundled default (in the public repo). Ships ten Asimov-style priority-ordered rules + a generic preamble. The bundled file carries `default-version: 1.0` in its frontmatter so the drift-detection log line (see bible §5.76f) can flag override staleness.

**Don't regress:** workspace override path is `memory/knowledge/jarvis-ethical-rules.md`, NOT `SOUL.md` (persona) and NOT `BRIEFING.md` (briefing). Each foundational block has its own override file; conflating them silently overrides the wrong layer.

## Dead-code config trap registry

Each trap is a config surface that _looks_ like it should apply at runtime but doesn't. Tagged `dead-code` so the bug-log's `config-dead-code` failure class (see `bug-log.md`) can correlate. The pattern is always: a key/path that is syntactically valid, accepted by the config loader, and not flagged as an error — but never read by the code path that needs it.

| #   | Trap                                                                                                                                   | Looks live because                                                                                                                                                                                                                   | What actually applies                                                                                                                                                                                                                                                                             | Detection command                                                                                                                                                                                                                                                                                | Class                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| T1  | Per-model `requestTimeoutMs` on a catalog model object                                                                                 | The field type accepts a `number`; the model object lists it next to `id`/`name`                                                                                                                                                     | The idle watchdog reads only `providerConfig.timeoutSeconds` (via `resolveProviderRequestTimeoutMs` → `applyConfiguredProviderOverrides`). The model-level field is ignored.                                                                                                                      | `openclaw gateway call debug.session.config --params '{"provider":"claude-code"}'` → assert `resolvedRequestTimeoutMs == 600000`. If you set it on the model object and got 120s, you hit this trap.                                                                                             | `config-dead-code`              |
| T2  | Plugin `discovery.run` returning `{ provider: { timeoutSeconds: N } }`                                                                 | The discovery API accepts a `providerConfig`-shaped payload and the gateway loads it without error                                                                                                                                   | `cfg.models.providers` is not mutated. The 2026-05-10 fix: `registerPluginProviderConfigOverlay(providerId, partial)` from the plugin's `register()` hook                                                                                                                                         | Same as T1 — `debug.session.config` is the canary. If `effective.timeoutSeconds` is missing despite a discovery.run setting it, you hit T2.                                                                                                                                                      | `config-dead-code`              |
| T3  | `plugins.allow: <name>` entry naming a plugin that no longer exists (e.g. the old `whatsapp` id after rename to `tinkerclaw-whatsapp`) | The gateway emits a warning ("`plugins.allow: plugin not found: <name> (stale config entry ignored; remove it from plugins config)`") but BOOTS NORMALLY and continues to load other plugins                                         | Nothing — the stale allowlist entry is silently dropped. The new plugin id must be in `plugins.allow` for the plugin to load; the old id is decorative noise.                                                                                                                                     | Boot journal scan: `journalctl --user -u openclaw-gateway.service --since today --no-pager \| grep -E 'plugin not found:'`. Each match is one stale entry to clean from `openclaw.json:plugins.allow`.                                                                                           | `config-dead-code` + `noisy`    |
| T4  | `plugins.entries.<name>` config present for a plugin not in the allowlist                                                              | The config block validates against the plugin's `configSchema` so it looks complete                                                                                                                                                  | The plugin is disabled (because not in `plugins.allow`), so the entry is decorative                                                                                                                                                                                                               | `openclaw gateway call plugin.boot.status --params '{"status":"disabled"}'` (FORK 2026-05-11) — any plugin whose `enabled:false` while the entry has substantive config is T4.                                                                                                                   | `config-dead-code` + `noisy`    |
| T5  | Model-level field on a catalog model whose provider config doesn't merge it                                                            | Most catalog model fields ARE read (id, name, alias, rank, contextWindow). But adding a NEW field doesn't automatically wire it.                                                                                                     | The field is held in memory and exposed via `models.list` but never read by any consumer until explicit code wires it. Often added speculatively in PRs and forgotten.                                                                                                                            | `grep -rn "model\\.<fieldName>" src/ extensions/` — if the grep returns zero, the field is dead.                                                                                                                                                                                                 | `config-dead-code` + `forward`  |
| T6  | Old `config.models` BASE_METHODS reservation without a handler                                                                         | The method name appears in the BASE_METHODS list                                                                                                                                                                                     | The legitimate plugin handler can't register because the reservation collides ("method already registered"). The fix is to remove the stale reservation. See bible §11.6c.                                                                                                                        | At plugin load: `[plugin] method already registered: <name>` in the journal. The probe `plugin.boot.status` would report this plugin's `failurePhase:"register"`.                                                                                                                                | `config-dead-code` + `blocking` |
| T7  | `pnpm.onlyBuiltDependencies` array — load-bearing but easy to lose                                                                     | The field is just a list of package names                                                                                                                                                                                            | Required for `better-sqlite3`, `opusscript`, `@discordjs/opus` to be pre-built. Wiped on every upstream merge.                                                                                                                                                                                    | `plugin.boot.status --params '{"status":"error"}'` → any plugin with `Cannot find module '@sinclair/typebox'` or similar native-binding error in `failurePhase:"load"` is the canary. Today's example: `tinkerclaw-round-table`, `tinkerclaw-total-recall`.                                      | `merge-wipe` + `bundler-trap`   |
| T8  | `configSchema` field absent from `openclaw.plugin.json`                                                                                | The plugin loads in older builds where the field was optional                                                                                                                                                                        | Since 2026-03-05, missing it = plugin config validation loop blocks ALL plugins (cascading)                                                                                                                                                                                                       | `plugin.boot.status --params '{"status":"error"}'` → plugin with `failurePhase:"validation"` is T8                                                                                                                                                                                               | `plugin-load` + `blocking`      |
| T9  | round-table `respectBillingGate: true` (U7 7D, FORK 2026-06-02) — looks like an active cost-aware debate-budget clamp                  | The key validates against `configSchema`, defaults `true`, and `extensions/tinkerclaw-round-table/index.ts:166` reads it then queries `agent.getBillingState` at debate time to clamp `maxBudgetPerDebate` via `resolveDebateBudget` | Nothing — `agent.getBillingState` is NOT a registered gateway method, so the `callGatewayFromCli` always errors, headroom stays `undefined`, and `resolveDebateBudget` is a graceful no-op (budget identical whether the key is true or false). Binds only once the RPC ships.                    | Method-existence: `grep -rn "agent.getBillingState" src/` returns ZERO registrations (the only hits live in `extensions/tinkerclaw-round-table/`). If a debate budget never clamps despite `respectBillingGate:true`, the RPC still doesn't exist.                                               | `config-dead-code` + `forward`  |
| T10 | round-table `orchestratorId: <non-builtin>` (U7 7G, FORK 2026-06-02) — looks like it can switch to an external debate orchestrator     | The key validates, defaults `"raac"`, and `index.ts:168` resolves it via `getOrchestrator(id)` whose external loader calls `plugins.getOrchestrator`                                                                                 | Builtins (`raac`/`fan-out`/`sequential`/`moderated-tribunal`) work. For ANY other id: `plugins.getOrchestrator` is NOT a registered gateway method, the loader returns null, and `getOrchestrator` silently falls back to `raac` (logs `orchestrator '<id>' unresolved; falling back to 'raac'`). | Method-existence: `grep -rn "plugins.getOrchestrator" src/` returns ZERO registrations (only the read site in the extension). The journal line `orchestrator '<id>' unresolved; falling back to 'raac'` confirms a live hit. Same class covers the 7A `plugins.getSpeakerSelectionHook` sibling. | `config-dead-code` + `forward`  |

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
