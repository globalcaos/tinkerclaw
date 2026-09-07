---
file: config-shape.md
purpose: For every openclaw.json key, where it's read at runtime, the default chain, who can override
audience: AI
last_verified: 2026-08-04
last_verified_commit: 47df21425a
single_owner: yes — config-flow facts live here. ALSO the temporary home of the gateway operator-scope model (see the "Gateway operator scopes" section) — a lodger, not a resident; promote it to its own optic the next time INDEX.md is editable in the same change
see_also: topology.md (what runs), auth-routing.md (which model is picked), tool-loop.md (why tinker-bridge has its own timeout), probes.md (the forensic.\* RPCs that are still unclassified)
verify:
  - name: claude-code provider overlay resolves timeoutSeconds=600
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.session.config","--params",json.dumps({"provider":"claude-code"})],capture_output=True,text=True); assert "\"resolvedRequestTimeoutMs\": 600000" in r.stdout, r.stdout[-500:]'
  - name: agents.defaults.timeoutSeconds is 10800 in openclaw.json (2026-07-22 incident)
    cmd: python3 -c 'import json,os; assert json.load(open(os.path.expanduser("~/.openclaw/openclaw.json")))["agents"]["defaults"]["timeoutSeconds"] == 10800'
  - name: claude-code timeoutSeconds is NOT manually set in openclaw.json (must come from overlay)
    cmd: python3 -c 'import json,os; cfg = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); cc = cfg["models"]["providers"]["claude-code"]; assert "timeoutSeconds" not in cc'
  - name: dead-code trap registry table is current (11 rows expected today, incl U7 T9/T10 + T11 unclassified-RPC)
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/config-shape.md")).read(); rows = [line for line in t.split("\n") if line.startswith("| T") and "|" in line[3:]]; assert len(rows) >= 11, f"only {len(rows)} dead-code-trap rows — has a trap been added without registering it?"'
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
  - name: gateway.reload.deferralTimeoutMs contract — default-cap const exists in restart.ts AND server-reload-handlers reads the key for BOTH paths
    cmd: python3 -c 'import os; r = open(os.path.expanduser("~/src/tinkerclaw/src/infra/restart.ts")).read(); h = open(os.path.expanduser("~/src/tinkerclaw/src/gateway/server-reload-handlers.ts")).read(); assert "DEFAULT_RESTART_DEFERRAL_MAX_WAIT_MS = 15 * 60_000" in r; assert h.count("gateway?.reload?.deferralTimeoutMs") >= 2, "server-reload-handlers must read deferralTimeoutMs for BOTH the restart deferral and the channel-reload wait"'
  - name: gateway.reload.deferralTimeoutMs is explicitly 900000 in openclaw.json (15-min cap)
    cmd: python3 -c 'import json,os; assert json.load(open(os.path.expanduser("~/.openclaw/openclaw.json")))["gateway"]["reload"]["deferralTimeoutMs"] == 900000'
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

- **Read at:** `resolveAgentTimeoutMs` (src/agents/timeout.ts)
- **Default:** `DEFAULT_AGENT_TIMEOUT_SECONDS` (48 h) in code; openclaw.json sets 10800
- **Override chain:** per-run `params.timeoutMs` > agent default
- **Drives:** session lock max hold, run-level abort timer (**sliding since 2026-07-22** — see `activityGraceSeconds` below; the armed value is the INITIAL deadline, activity extends it up to `maxRunSeconds`)
- **Current value:** 10800s (raised 2026-07-22 from 2700 — earlier bible value 900 had drifted — after the 2700s wall-clock killed two actively-working 46-min VM-debug turns; see bug-log `[turn-wallclock-timeout-kills-active-runs]`)

### `agents.defaults.activityGraceSeconds` (FORK 2026-07-22)

- **Read at:** `resolveAgentActivityGraceSeconds/Ms` (src/agents/timeout.ts)
- **Default:** 600; `0` disables sliding (legacy fixed wall-clock)
- **Drives:** on run-deadline fire, `resolveRunTimeoutOnDeadline` (run/run-timeout-policy.ts) extends the abort timer while the last REAL stream/tool event is younger than the grace window — killing on silence, not wall-clock. Consulted BEFORE the compaction-grace check; compaction behavior for silent runs unchanged.

### `agents.defaults.maxRunSeconds` (FORK 2026-07-22)

- **Read at:** `resolveAgentMaxRunSeconds/Ms` (src/agents/timeout.ts)
- **Default:** `DEFAULT_AGENT_TIMEOUT_SECONDS` (48 h)
- **Drives:** hard cap from run start; activity extension never crosses it (runaway/stranded-run backstop — a stranded run whose stream closed stops producing activity and dies at the grace window instead).

### `models.providers.<provider>.timeoutSeconds`

- **Read at:** `resolveConfiguredProviderConfig` → `applyConfiguredProviderOverrides` → `resolveProviderRequestTimeoutMs` → attaches `requestTimeoutMs` to the resolved model → `resolveLlmIdleTimeoutMs` (via `params.model.requestTimeoutMs`)
- **Drives:** LLM idle watchdog timeout (`streamWithIdleTimeout` wraps the streamFn)
- **Default chain:** plugin overlay → explicit cfg → undefined (which then falls through to `clampImplicitTimeoutMs(agentTimeoutMs)`, capped at `DEFAULT_LLM_IDLE_TIMEOUT_MS=120_000`)
- **Current values:**
  - `claude-code`: 600 (from tinker-bridge plugin overlay, FORK 2026-05-10, NOT openclaw.json)
  - `ollama`: undefined → default 120s
- **⚠️ Anti-pattern:** per-model `requestTimeoutMs` on the catalog model object is silently ignored. Only the provider-level `timeoutSeconds` propagates. See bible §11.6d.
- **⚠️ Anti-pattern (fixed 2026-05-10):** the tinker-bridge plugin's `discovery.run` returning `{ provider: { timeoutSeconds: 600 } }` did NOT merge into cfg.models.providers. The fix is the plugin overlay (J15 §4 + bible §11.6e). Do NOT rely on the discovery path for runtime config; use the overlay.

### `agents.defaults.models[<provider/model>].rank`

- **Read at:** model-router skill, model-rank-refresh cron
- **Drives:** ordering in the models panel; failover order (cost-aware routing, see auth-routing.md)
- **Updated by:** `model-rank-refresh` cron at 06:30 daily, fetching Artificial Analysis Intelligence Index
- **Current top 3:** openai/gpt-5.5 (1), claude-code/claude-opus-4-7 (2), google/gemini-3.1-pro-preview (3)

### `agents.defaults.models[<provider/model>].intelligenceIndex`

- **Read at:** Tinker models panel
- **Drives:** column 3's visible score and the panel's descending intelligence sort
- **Semantics:** raw Artificial Analysis Intelligence Index; higher is smarter; `—` means AA has no score
- **Updated by:** `model-rank-refresh` cron alongside `rank`; never substitute LMSYS Elo or a list position

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

- **Read at:** child-process spawn env (tinker-bridge, exec tool, etc.)
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

### `agents.defaults.sessions.maxConcurrent` (FORK 2026-07-24, commit eba0911c7b)

- **Read at:** `resolveSessionsMaxConcurrent` (`src/config/agent-limits.ts`), applied by `applyGatewayLaneConcurrency` (`src/gateway/server-lanes.ts`) at gateway start + config reload.
- **Drives:** concurrency of the dedicated `sessions` command lane — the DEFAULT global lane for embedded session runs (`resolveGlobalLane` in `src/agents/embedded-agent-runner/lanes.ts`). Default: 8. Per-session ordering still comes from the `session:<sessionKey>` lane; this key only caps cross-session parallelism.
- **Why (stuck-tabs incident 2026-07-22/24):** embedded runs used to share the `main` global lane with system work; pile-ups of wedged runs starved it and froze all Tinker tabs. See `topology.md` § Command-lane topology.

### `diagnostics.otel.*`

- **Read at:** otel exporter
- **Drives:** clawmetry/grafana traces+metrics

### `browser.*`

- **Read at:** browser plugin
- **Drives:** Chrome relay attach (existing-session driver, attachOnly:true, cdpUrl:`http://127.0.0.1:18792`)

### `gateway.reload.deferralTimeoutMs` (restart/reload deferral cap, FORK 2026-07-21, commits 532b723776 + dbfc255cbe)

- **Read at:** `src/gateway/server-reload-handlers.ts` — TWO read sites off `nextConfig.gateway?.reload?.deferralTimeoutMs`: (1) passed as `maxWaitMs` to `deferGatewayRestartUntilIdle` (`src/infra/restart.ts`) for the gateway-restart deferral; (2) the channel-reload wait loop applies the same contract inline.
- **Semantics (tri-state):** OMITTED → falls back to `DEFAULT_RESTART_DEFERRAL_MAX_WAIT_MS` = 15 min (`src/infra/restart.ts`) — the deferral force-proceeds after the cap; explicit finite `> 0` → that cap in ms (floored to at least the poll interval); explicit `<= 0` or non-finite → wait FOREVER (deliberate opt-out — the pre-2026-07-21 behavior).
- **Current value:** `900000` (15 min, explicit in `~/.openclaw/openclaw.json`).
- **Override chain:** explicit cfg → code default (15-min cap). No plugin overlay; no env var.
- **Why the cap is the default:** before these commits an UNSET key meant wait-forever — a gateway restart requested at 09:12 stayed deferred 4+ hours behind zombie task runs. Sibling fix `aec445bfbb` (same incident) stops stale running tasks from vetoing restarts via the pending-count.

### `agents.defaults.heartbeat.{every, model, session, target}` (token-gating, FORK 2026-06-04)

- **Read at:** the heartbeat scheduler → `resolveHeartbeatRunPrompt` (`src/infra/heartbeat-runner.ts`) + `isHeartbeatContentEffectivelyEmpty` (`src/auto-reply/heartbeat.ts`).
- **Drives:** a `target:"none"` interval heartbeat is meant to be a cheap liveness tick, NOT a billable LLM turn. Two gates now skip the LLM (commit `cd324209`; see `bug-log.md` G1): (1) the **empty-file gate** — if `~/.openclaw/workspace/HEARTBEAT.md` is effectively empty (only headings + a link-only `## Related` footer, which is now stripped before the check) the LLM is skipped; (2) the **task-due gate** — a plain `reason:"interval"` poll with zero scheduled tasks actually due returns `prompt:null` → `{status:"skipped",reason:"no-tasks-due"}`.
- **⚠️ Open edge:** a NON-empty `HEARTBEAT.md` with free-prose instructions but no structured `tasks:` blocks still spends tokens on every interval tick — the task-due gate only covers the `tasks:` form. Add an interval floor if prose-only heartbeats should also be rate-limited.

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

- **`RECIPE_AUTOAPPLY_ENABLED`** (`"true"`) — gates **U1** recipe-evolution self-apply (`recipe-evolution.ts` `isAutoPromotable` + recipe-runner `recipe:<owner/slug>` attribution feeding `makeFitnessLookup`). Same flag that already gated recipe self-rewrite.
- **`ENGRAM_SUPERSEDE_ENABLED`** (`"true"`) — gates **U3** bi-temporal supersede (`supersede-writer.ts` interval-close on contradiction; `temporalMode`/`asOfTime` on `fork.memory.search`).
- **`PREFRONTAL_SEMANTIC_MATCH_ENABLED`** (`"true"`) — semantic kit/recipe match lane; threaded by U1's fitness feedback into `matchRecipesDetailed`.
- **No new flag** for U4 (failure→strategy-switch, driven by the engram-consolidate cron), U5 (durable checkpointing), U6 (Voyager skill-library), U9 (A-MEM Zettelkasten links), U11 (external recipe acquisition), U12 (recipe marketplace) — these are always-on once the consolidation cron / recipe-runner paths execute; their behavior is data-driven, not config-gated.

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

## tinker-bridge ethical-rules prompt loader (FORK 2026-05-21)

The tinker-bridge plugin loads an `ethical-rules` block into the worker's `--append-system-prompt` between the persona block and the narration/tool-choice/plan-tools blocks. See `tool-loop.md` for the slot in `combinedSystemPrompt`.

**Resolution order** (per `loadPromptFile` defaults; first existing path wins):

1. `env.TINKERCLAW_ETHICAL_RULES_PROMPT` — explicit path override.
2. `~/.openclaw/workspace/memory/knowledge/jarvis-ethical-rules.md` — user-personalised override (outside the public repo).
3. `extensions/tinkerclaw-tinker-bridge/prompts/ethical-rules-default.md` — bundled default (in the public repo). Ships ten Asimov-style priority-ordered rules + a generic preamble. The bundled file carries `default-version: 1.0` in its frontmatter so the drift-detection log line (see bible §5.76f) can flag override staleness.

**Don't regress:** workspace override path is `memory/knowledge/jarvis-ethical-rules.md`, NOT `SOUL.md` (persona) and NOT `BRIEFING.md` (briefing). Each foundational block has its own override file; conflating them silently overrides the wrong layer.

## AMYGDALA (learned-intuition) config keys (FORK 2026-06-11, v3.1)

Read in `extensions/tinkerclaw-learned-intuition/index.ts` `register()` from `api.pluginConfig` (manifest `openclaw.plugin.json`; runtime overrides in `openclaw.json` under `plugins.entries.tinkerclaw-learned-intuition.config`).

| Key               | Default (v3.1)           | Effect                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aegisEnabled`    | **`true`** (was `false`) | The deterministic AEGIS rule veto. v3.1 flips the default ON — resolving the old manifest-off vs code-on contradiction. `false` fully disables the rule floor.                                                                                                                                                             |
| `legacyEnsemble`  | `false`                  | Run the retired 5-net ONNX prudence/personality ensemble in the decision path. Off by default (trained on mislabelled data; arch C collapsed, arch E mush; frozen-MiniLM danger classification measured below chance, AUROC 0.286). The embedding pipeline (encoder + projection) is **always** loaded — novelty needs it. |
| `hookEnforcement` | `true`                   | Write `cc-hook-settings.json` so tinker-bridge passes `--settings` and destructive-execution AEGIS rules deny synchronously on the claude-cli runner (see `tool-loop.md`). `false` removes the settings file → observe-only spool, no pre-execution deny.                                                                  |
| `observeOnly`     | `true`                   | Neural soft-blocks stay advisory while the gate ramps. The novelty channel ships as an observe-only **ask** disposition under this. AEGIS hard-blocks enforce regardless.                                                                                                                                                  |
| `phase`           | `1`                      | Trust-ramp phase.                                                                                                                                                                                                                                                                                                          |

**Runtime artifacts dir** `~/.openclaw/data/amygdala/`: `policy.json` (serialized AEGIS rules + `hookEnforcement` flag, read by the hook), `cc-hook-settings.json` (claude-cli PreToolUse hook registration; presence = enabled), `amygdala-pretooluse.mjs` (staged dependency-free hook script), `hook-decisions.jsonl` (pre-execution decision spool, ingested into the feed), `training.sqlite` (schema `user_version 1`: ensemble columns NULLABLE + `novelty`/`disposition`/`signal` + `amygdala_calibration` k/v for the novelty threshold).

**Dead-code trap:** `DEFAULT_CONFORMAL_QUANTILE` and the per-arch conformal quantiles only matter when `legacyEnsemble:true`. With the default `false` the 10 ONNX nets are never loaded and those knobs are inert.

## Gateway operator scopes — the least-privilege authorization model (FORK, first documented 2026-08-04, commit `6decca5639`)

**This is not an `openclaw.json` key.** It is a lodger in this optic, not a resident — it belongs in a `gateway-authz.md` of its own, which was not created because `INDEX.md` was not editable in the same change and the invariant runner refuses any optic on disk that `INDEX.md` does not name (`scripts/test-invariants.mjs:418-432`, "INDEX.md mentions every bible file"). It is documented **here** because (a) nothing else in the bible owned it, and months of dead Overseer and curiosity features were the price of that gap, and (b) its failure mode is exactly the `config-dead-code` class registered directly below: a surface that is syntactically valid, loads without error, and is silently unreachable because it is **missing from a table**. Registered as trap **T11**.

### The scope vocabulary — SIX, not three

`src/gateway/operator-scopes.ts:1-6` is the complete set. `OperatorScope` is a closed union (`:8-14`) and `isOperatorScope()` (`:29-31`) validates against `KNOWN_OPERATOR_SCOPES` (`:25-27`). Anything not in this list is not a scope.

| Scope                   | Const                | What it admits                                                                                                                                                                       |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `operator.admin`        | `ADMIN_SCOPE`        | Everything. Short-circuits **before** any per-method lookup — two separate early returns, `server-methods.ts:86-88` and `method-scopes.ts:329-331`.                                  |
| `operator.read`         | `READ_SCOPE`         | Inspection only: returns state, mutates nothing, spawns nothing.                                                                                                                     |
| `operator.write`        | `WRITE_SCOPE`        | Mutates durable state, emits a broadcast, or spawns/burns compute. **Also admits every READ method** (`method-scopes.ts:333-338`), so READ is the most reachable tier.               |
| `operator.approvals`    | `APPROVALS_SCOPE`    | `exec.approval.*` and `plugin.approval.*` only (`method-scopes.ts:43-53`).                                                                                                           |
| `operator.pairing`      | `PAIRING_SCOPE`      | `node.pair.*`, `device.pair.*`, `device.token.rotate\|revoke`, `node.rename` (`:54-68`).                                                                                             |
| `operator.talk.secrets` | `TALK_SECRETS_SCOPE` | Its group is **empty** (`method-scopes.ts:263`). No core method requires it today; it survives in `CLI_DEFAULT_OPERATOR_SCOPES` and is reachable only via a plugin-registered scope. |

**The lattice is tiny:** `admin` ⊃ everything; `write` ⊃ `read`; everything else is disjoint. Holding `operator.write` does **not** get you `operator.pairing`.

### `METHOD_SCOPE_GROUPS` — one table, read by BOTH ends

`method-scopes.ts:42-264` maps scope → method list, flattened once into `METHOD_SCOPE_BY_NAME` (`:266-270`). Every lookup goes through `resolveScopedMethod` (`:272-286`), which tries three sources **in order, first hit wins**, and returns `undefined` if all miss:

1. the explicit `METHOD_SCOPE_GROUPS` entry;
2. `resolveReservedGatewayMethodScope` (`src/shared/gateway-method-policy.ts`) — the reserved-admin prefixes `exec.approvals.`, `config.`, `wizard.`, `update.` → `operator.admin`;
3. the active plugin registry's `gatewayMethodScopes[method]` — how a plugin classifies its own RPCs;
4. otherwise **UNCLASSIFIED**.

Two consequences of that ordering that readers get wrong:

- **Explicit beats reserved.** `config.get` and `config.schema.lookup` are in the `READ_SCOPE` group (`:139-140`) and resolve to `operator.read` **despite** the `config.` admin prefix. The prefix is a floor for everything the table does not name, not a ceiling over it.
- **Reserved beats plugin.** A plugin cannot narrow a reserved namespace — `normalizePluginGatewayMethodScope()` coerces it back to `operator.admin`.

The load-bearing fact: **both ends of every call read this same table, through two different functions.**

- **Client — what to ASK for:** `resolveLeastPrivilegeOperatorScopesForMethod(method)` (`:316-323`) → `[requiredScope]`.
- **Server — what to REQUIRE:** `authorizeOperatorScopesForMethod(method, scopes)` (`:325-343`) → `{allowed:true}` or `{allowed:false, missingScope}`.

So classifying a method fixes **both** ends at once. That is why the fix for the outage below was a table edit, not a caller edit.

### ⚠️ THE CRITICAL ASYMMETRY — unclassified is not "open", it is UNREACHABLE

The two ends disagree about what `undefined` means, and they disagree in **opposite directions**:

```ts
// method-scopes.ts:316-323 — CLIENT side
export function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[] {
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  if (requiredScope) return [requiredScope];
  // Default-deny for unclassified methods.   <-- :321
  return [];                                  <-- :322   asks for NOTHING
}

// method-scopes.ts:332 — SERVER side
const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
```

An unclassified method therefore has the client asking for `[]` while the server demands `operator.admin`. The call is refused ~1 ms in with `missing scope: operator.admin` — **at `warn` level only**.

Consequences, in the order they bite:

- **It is an omission bug, not a permission bug.** Nobody granted admin to the wrong caller; the method simply never appeared in a table.
- **It looks half-alive.** Callers that pass **explicit** admin scopes keep working, because both admin bypasses fire before the lookup. Least-privilege callers get a hard refusal. Same method, same gateway, opposite outcomes — which is precisely why the outage survived for months without anyone chasing it.
- **A refusal reads as "ran fine, nothing to report."** It arrives at a backend caller as an ordinary rejected promise and gets folded into the nearest generic failure branch. `isOperatorScopeDenial(err)` (`:365-368`, matches `/\bmissing scope:\s*[a-z0-9._-]+/i`) exists specifically so a caller can report a refusal as its **own** outcome: a scope denial is a wiring bug that will never self-heal, unlike a transient transport error.

**The incident (2026-08-04, fixed by `6decca5639`).** All **19** `fork.*` methods were unclassified. THE OVERSEER loop and the idle-curiosity chips were dead **for months** while the same RPCs answered fine when invoked by hand from the CLI.

### Which callers take which path (`src/gateway/call.ts`)

| Entry point                                                       | Scopes sent when `opts.scopes` is omitted                                      | On an UNCLASSIFIED method                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `callGateway()` — default `mode: BACKEND` (`:654-677`)            | delegates to `callGatewayLeastPrivilege` (`:672-676`)                          | `[]` → **REFUSED**. This is the path that died.                      |
| `callGateway()` with `mode: CLI` / `clientName: CLI` (`:659-661`) | delegates to `callGatewayCli`                                                  | survives                                                             |
| `callGateway()` with explicit `opts.scopes` (`:662-671`)          | the array, verbatim                                                            | survives if it contains admin                                        |
| `callGatewayLeastPrivilege()` (`:647-652`)                        | always least-privilege                                                         | `[]` → **REFUSED**                                                   |
| `callGatewayCli()` (`:636-645`)                                   | classified → least-privilege; **unclassified → `CLI_DEFAULT_OPERATOR_SCOPES`** | survives (all six scopes)                                            |
| `callGatewayScoped()` (`:630-634`)                                | caller-supplied, verbatim                                                      | caller's problem                                                     |
| `callGatewayTool()` (`src/agents/tools/gateway.ts:148-170`)       | BACKEND + least-privilege (`:155-157`, `:167`)                                 | `[]` → **REFUSED** — the agent's OWN gateway tool is least-privilege |

**The whole "works for me" illusion is one ternary branch** (`call.ts:639-643`): `callGatewayCli` falls back to `CLI_DEFAULT_OPERATOR_SCOPES` (`method-scopes.ts:23-30` — all six scopes, admin included) when `isGatewayMethodClassified()` is false. The backend path has no such fallback, by design. So `openclaw gateway call <method>` works by hand while the in-process backend caller of the same RPC is refused.

**Enforcement is not one gate but eight**, all calling `authorizeOperatorScopesForMethod`: WS JSON-RPC (`server-methods.ts:89-91`, where the `missing scope: …` string is minted) plus seven HTTP surfaces — `http-endpoint-helpers.ts:55`, `http-auth-utils.ts:168`, `sessions-history-http.ts:267`, `session-kill-http.ts:90`, `models-http.ts:93`, `managed-image-attachments.ts:1014`, `control-ui.ts:336`.

### Two orthogonal axes that are NOT this table

- **Role, checked BEFORE scope.** `server-methods.ts:67-93` runs `isRoleAuthorizedForMethod` (`role-policy.ts:18-23`) first: the seven `NODE_ROLE_METHODS` (`method-scopes.ts:32-40`) require `role === "node"`, everything else `role === "operator"`. A node-role connection then **returns before the scope check** (`:83-85`). So node-role methods legitimately carry no scope, and `isGatewayMethodClassified()` (`:345-350`) counting them as classified is correct, not an oversight. Also exempt: `method === "health"` (`:71-73`) and any client with no `connect` frame (`:68-70`).
- **Where granted scopes come from.** WS connect is **also** default-deny — `server/ws-connection/message-handler.ts:478` ("scopes must be explicit"), and a device-less shared-auth connection has its self-declared scopes cleared (`:605-607`). Trusted HTTP callers with no `x-openclaw-scopes` header get `CLI_DEFAULT_OPERATOR_SCOPES` (`http-auth-utils.ts:206`), as do shared-secret compat callers (`:227`) and plugin routes (`server/plugin-route-runtime-scopes.ts:18`).

### THE RULE FOR A NEW GATEWAY RPC

1. **Register the handler** in its `src/gateway/server-methods/*.ts` module (spread into `coreGatewayHandlers`).
2. **Classify it in `METHOD_SCOPE_GROUPS` in the SAME change.** Not a follow-up — an unclassified handler is born dead for every least-privilege backend caller, and dead quietly. Choose by effect, not by feel: **READ** = returns state, mutates nothing, spawns nothing. **WRITE** = mutates durable state, emits a broadcast, or spawns/burns compute (the tier of `agent`, `sessions.create`, `doctor.memory.*`, `fork.subagents.spawn`). **ADMIN** = control-plane over an **arbitrary** target or touching config/credentials — `cron.run` is ADMIN because it runs an arbitrary named job, while `fork.engram.consolidate.run` is WRITE because it runs one fixed known job.
3. **Node-transport-only?** Put it in `NODE_ROLE_METHODS` instead; that marks it classified with `[]` operator scopes. **Plugin RPC?** Classify via the plugin registry's `gatewayMethodScopes` (source 3 above).
4. **Advertise it too, if clients discover it.** `listGatewayMethods()` (`src/gateway/server-methods-list.ts:160-163` = `BASE_METHODS` + channel-plugin methods) is a **hand-curated advert list, independent of `coreGatewayHandlers`**. A handler missing from it still dispatches, but it is invisible to discovery and it does not reserve its name against plugin registration (`server-startup-plugins.ts:176`). All 14 methods in the TODO below are absent from `BASE_METHODS` — a second, quieter gap on the same handlers.
5. **Run the gate the repo already ships:** `pnpm vitest run src/gateway/method-scopes.test.ts` → `core gateway method classification > classifies every exposed core gateway handler method` (`:188-193`) asserts the unclassified list is `[]` and **prints it verbatim on failure**. That output is the authoritative TODO — run it, don't grep for it. Its sibling `classifies every listed gateway method name` (`:195-200`) does the same for `listGatewayMethods()` and passes today.
6. **Never "fix" a scope refusal by widening the caller's scopes.** That converts a one-line classification into a privilege grant and hides the omission instead of closing it. Classify the method.

**Standing TODO — 14 methods still unclassified.** Verbatim from `pnpm vitest run src/gateway/method-scopes.test.ts` on 2026-08-04 at `47df21425a`: `Test Files 3 failed (3) · Tests 3 failed | 120 passed (123)` — **one** test, RED in all three vitest projects (`gateway-core`, `gateway-client`, and the root project). Down from **33** before `6decca5639` classified all 19 `fork.*` (7 READ, `method-scopes.ts:157-167` + 12 WRITE, `:213-229`); **zero `fork.*` remain**. Each of these is reachable from `callGatewayCli` and unreachable from every backend caller:

| Method                                                                                                                                                                                                                                       | Suggested tier (from the handler body)                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `forensic.getMode`, `forensic.getLive`, `forensic.getLiveDetail`, `forensic.listDumps`, `forensic.getDump`, `forensic.getDumpDetail`, `forensic.getCallLive`, `forensic.summarize`, `forensic.getResponseLive`, `forensic.getResponseDetail` | `READ` — dump inspection, returns state only (`server-methods/forensic.ts`)                     |
| `forensic.setMode`                                                                                                                                                                                                                           | `WRITE` — calls `setForensicMode()` (`forensic.ts:370-374`)                                     |
| `sessions.fork`                                                                                                                                                                                                                              | `WRITE` — creates a session, same tier as `sessions.create` (`server-methods/sessions.ts:1048`) |
| `debug.simulate.stuckSession`, `debug.simulate.pluginLoadFail`                                                                                                                                                                               | `WRITE` or `ADMIN` — inject fault state (`server-methods/debug-simulate.ts:27`, `:96`)          |

**Why this section carries no `verify:` entry of its own.** The check that would keep it honest is job 3 in FOUNDATION.md's "Three different jobs, three different homes" (`FOUNDATION.md:46-58`, clarified the same day): it belongs in `scripts/bible/*.mjs` behind a one-line `cmd:` pointer, and that directory was outside this change's write set. Two further reasons not to inline one: `scripts/test-invariants.mjs` **executes** every `verify.cmd`, so pointing at `method-scopes.test.ts` would turn `pnpm bible:invariants` red on a documented standing TODO; and the trap-registry row-count check below (bumped 10 → 11 for T11) already fails loudly if T11 is deleted. When `scripts/bible/` is next in scope, the two invariants worth scripting are (1) the client-side `// Default-deny for unclassified methods.` comment and the server-side `?? ADMIN_SCOPE` fallback both still exist in `method-scopes.ts` — if either goes, this whole section is stale — and (2) `METHOD_SCOPE_GROUPS` still classifies 19 `fork.*` methods.

**⚠️ Two other optics went stale on `6decca5639`** and are not fixed here: `session-naming.md:138` and `bug-log.md:686` both state that `fork.subagents.spawn` is `operator.admin`-scoped. That was accurate **in effect** when written — unclassified meant the server fell back to `?? ADMIN_SCOPE`, so admin really was required — but the method is now `WRITE_SCOPE` (`method-scopes.ts:213`). Correct them the next time either optic is touched.

## Dead-code config trap registry

Each trap is a config surface that _looks_ like it should apply at runtime but doesn't. Tagged `dead-code` so the bug-log's `config-dead-code` failure class (see `bug-log.md`) can correlate. The pattern is always: a key/path that is syntactically valid, accepted by the config loader, and not flagged as an error — but never read by the code path that needs it.

> **Resolved trap (2026-06-04, commit `1f174c74`):** forensic dump capture was a `config-dead-code` instance at integration scale — `captureForensicDump` was reachable only via `emitPrePromptAnatomy`, a dead export never invoked, so `forensic.getLive*` returned `NO_DATA` cleanly (it _looked_ live). Now wired into `attempt.ts` immediately before `activeSession.prompt()` via a new `captureForensicDumpHook`. **Not** added as a standing row below — it no longer applies. See `bug-log.md` G2.

| #   | Trap                                                                                                                                                       | Looks live because                                                                                                                                                                                                                   | What actually applies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Detection command                                                                                                                                                                                                                                                                                                                                                                                        | Class                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| T1  | Per-model `requestTimeoutMs` on a catalog model object                                                                                                     | The field type accepts a `number`; the model object lists it next to `id`/`name`                                                                                                                                                     | The idle watchdog reads only `providerConfig.timeoutSeconds` (via `resolveProviderRequestTimeoutMs` → `applyConfiguredProviderOverrides`). The model-level field is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `openclaw gateway call debug.session.config --params '{"provider":"claude-code"}'` → assert `resolvedRequestTimeoutMs == 600000`. If you set it on the model object and got 120s, you hit this trap.                                                                                                                                                                                                     | `config-dead-code`              |
| T2  | Plugin `discovery.run` returning `{ provider: { timeoutSeconds: N } }`                                                                                     | The discovery API accepts a `providerConfig`-shaped payload and the gateway loads it without error                                                                                                                                   | `cfg.models.providers` is not mutated. The 2026-05-10 fix: `registerPluginProviderConfigOverlay(providerId, partial)` from the plugin's `register()` hook                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Same as T1 — `debug.session.config` is the canary. If `effective.timeoutSeconds` is missing despite a discovery.run setting it, you hit T2.                                                                                                                                                                                                                                                              | `config-dead-code`              |
| T3  | `plugins.allow: <name>` entry naming a plugin that no longer exists (e.g. the old `whatsapp` id after rename to `tinkerclaw-whatsapp`)                     | The gateway emits a warning ("`plugins.allow: plugin not found: <name> (stale config entry ignored; remove it from plugins config)`") but BOOTS NORMALLY and continues to load other plugins                                         | Nothing — the stale allowlist entry is silently dropped. The new plugin id must be in `plugins.allow` for the plugin to load; the old id is decorative noise.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Boot journal scan: `journalctl --user -u openclaw-gateway.service --since today --no-pager \| grep -E 'plugin not found:'`. Each match is one stale entry to clean from `openclaw.json:plugins.allow`.                                                                                                                                                                                                   | `config-dead-code` + `noisy`    |
| T4  | `plugins.entries.<name>` config present for a plugin not in the allowlist                                                                                  | The config block validates against the plugin's `configSchema` so it looks complete                                                                                                                                                  | The plugin is disabled (because not in `plugins.allow`), so the entry is decorative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `openclaw gateway call plugin.boot.status --params '{"status":"disabled"}'` (FORK 2026-05-11) — any plugin whose `enabled:false` while the entry has substantive config is T4.                                                                                                                                                                                                                           | `config-dead-code` + `noisy`    |
| T5  | Model-level field on a catalog model whose provider config doesn't merge it                                                                                | Most catalog model fields ARE read (id, name, alias, rank, contextWindow). But adding a NEW field doesn't automatically wire it.                                                                                                     | The field is held in memory and exposed via `models.list` but never read by any consumer until explicit code wires it. Often added speculatively in PRs and forgotten.                                                                                                                                                                                                                                                                                                                                                                                                                                        | `grep -rn "model\\.<fieldName>" src/ extensions/` — if the grep returns zero, the field is dead.                                                                                                                                                                                                                                                                                                         | `config-dead-code` + `forward`  |
| T6  | Old `config.models` BASE_METHODS reservation without a handler                                                                                             | The method name appears in the BASE_METHODS list                                                                                                                                                                                     | The legitimate plugin handler can't register because the reservation collides ("method already registered"). The fix is to remove the stale reservation. See bible §11.6c.                                                                                                                                                                                                                                                                                                                                                                                                                                    | At plugin load: `[plugin] method already registered: <name>` in the journal. The probe `plugin.boot.status` would report this plugin's `failurePhase:"register"`.                                                                                                                                                                                                                                        | `config-dead-code` + `blocking` |
| T7  | `pnpm.onlyBuiltDependencies` array — load-bearing but easy to lose                                                                                         | The field is just a list of package names                                                                                                                                                                                            | Required for `better-sqlite3`, `opusscript`, `@discordjs/opus` to be pre-built. Wiped on every upstream merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `plugin.boot.status --params '{"status":"error"}'` → any plugin with `Cannot find module '@sinclair/typebox'` or similar native-binding error in `failurePhase:"load"` is the canary. Today's example: `tinkerclaw-round-table`, `tinkerclaw-total-recall`.                                                                                                                                              | `merge-wipe` + `bundler-trap`   |
| T8  | `configSchema` field absent from `openclaw.plugin.json`                                                                                                    | The plugin loads in older builds where the field was optional                                                                                                                                                                        | Since 2026-03-05, missing it = plugin config validation loop blocks ALL plugins (cascading)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `plugin.boot.status --params '{"status":"error"}'` → plugin with `failurePhase:"validation"` is T8                                                                                                                                                                                                                                                                                                       | `plugin-load` + `blocking`      |
| T9  | round-table `respectBillingGate: true` (U7 7D, FORK 2026-06-02) — looks like an active cost-aware debate-budget clamp                                      | The key validates against `configSchema`, defaults `true`, and `extensions/tinkerclaw-round-table/index.ts:166` reads it then queries `agent.getBillingState` at debate time to clamp `maxBudgetPerDebate` via `resolveDebateBudget` | Nothing — `agent.getBillingState` is NOT a registered gateway method, so the `callGatewayFromCli` always errors, headroom stays `undefined`, and `resolveDebateBudget` is a graceful no-op (budget identical whether the key is true or false). Binds only once the RPC ships.                                                                                                                                                                                                                                                                                                                                | Method-existence: `grep -rn "agent.getBillingState" src/` returns ZERO registrations (the only hits live in `extensions/tinkerclaw-round-table/`). If a debate budget never clamps despite `respectBillingGate:true`, the RPC still doesn't exist.                                                                                                                                                       | `config-dead-code` + `forward`  |
| T10 | round-table `orchestratorId: <non-builtin>` (U7 7G, FORK 2026-06-02) — looks like it can switch to an external debate orchestrator                         | The key validates, defaults `"raac"`, and `index.ts:168` resolves it via `getOrchestrator(id)` whose external loader calls `plugins.getOrchestrator`                                                                                 | Builtins (`raac`/`fan-out`/`sequential`/`moderated-tribunal`) work. For ANY other id: `plugins.getOrchestrator` is NOT a registered gateway method, the loader returns null, and `getOrchestrator` silently falls back to `raac` (logs `orchestrator '<id>' unresolved; falling back to 'raac'`).                                                                                                                                                                                                                                                                                                             | Method-existence: `grep -rn "plugins.getOrchestrator" src/` returns ZERO registrations (only the read site in the extension). The journal line `orchestrator '<id>' unresolved; falling back to 'raac'` confirms a live hit. Same class covers the 7A `plugins.getSpeakerSelectionHook` sibling.                                                                                                         | `config-dead-code` + `forward`  |
| T11 | A gateway handler registered in `coreGatewayHandlers` but absent from `METHOD_SCOPE_GROUPS` (FORK 2026-08-04, commit `6decca5639`) — looks like a live RPC | The handler IS registered and DOES dispatch: `openclaw gateway call <method>` returns real data, and so does the Tinker UI — because both declare admin scopes. Nothing warns at boot.                                               | The two ends default in OPPOSITE directions: the client asks for `[]` (`resolveLeastPrivilegeOperatorScopesForMethod`, `method-scopes.ts:321-322`) while the server requires `?? ADMIN_SCOPE` (`:332`). So every `callGateway`/`callGatewayLeastPrivilege`/`callGatewayTool` BACKEND call is refused `missing scope: operator.admin` ~1 ms in, at warn level only; `callGatewayCli`'s `CLI_DEFAULT_OPERATOR_SCOPES` fallback (`call.ts:639-643`) hides it from every by-hand test. Unclassified is not "open", it is UNREACHABLE. 2026-08-04: all 19 `fork.*` methods — dead Overseer + curiosity for months. | `pnpm vitest run src/gateway/method-scopes.test.ts` → `classifies every exposed core gateway handler method` prints the unclassified list verbatim (14 today, so the test is RED). Live: `journalctl --user -u openclaw-gateway.service --since today --no-pager \| grep 'missing scope: operator.'` — every hit is a least-privilege caller meeting an unclassified (or genuinely under-scoped) method. | `config-dead-code` + `blocking` |

> **Sibling gap, deliberately NOT a separate row:** the same 14 handlers are also missing from `BASE_METHODS`/`listGatewayMethods()` (`server-methods-list.ts:160-163`), so they are undiscoverable and do not reserve their names against plugin registration. It is the same omission class as T11 on the same handlers, and the same fix-in-the-same-change discipline closes both — see the "Gateway operator scopes" section above, rule 4.

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
