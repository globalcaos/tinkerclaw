# Thalamus v4: inventory and detailed design

**What this is for.** The build spec for Thalamus v4, read by the worker in phases B to H and checked by the
master at each one. It turns the J19 v4.0 paper into files, types, tables, methods and tests, and it says which
parts of the paper the harness cannot do yet. **How it was derived.** Phase A, 2026-09-30: the v2 design and code
read in full where they touch the paper; the live gateway, the LLM ledger, the events store and the amygdala store
read without writing; ten model calls or fewer spent on probes of the Claude Code lane. Every claim about the live
system below names where it was seen. **What would change it.** A review that finds a wrong seam, a phase that
turns up a fact this document has wrong, or a decision from the architect (section 16). Changes are dated at the bottom.

Paper: `~/Documents/AI_reports/Papers/J19_maestro/2026-09-30-thalamus-v4.1.md` (cited as P§n; from v4.1 the new §7 is the enhancement short list, and v4.0's §7 to §11 are §8 to §12, so every pointer below already uses the v4.1 numbers). Charter:
`~/Documents/AI_reports/Papers/J19_maestro/build/charter.md`. Nothing here restates the paper's argument; it
points to it.

## 1. What runs today (measured, read-only)

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where it was seen                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| F1  | 87 sessions listed. Provider: claude-code 66, xai 8, openai 4, codex 4, openai-codex 3, copilot 2. Claude Code sessions run Opus 5 (36), Opus 5.5 (19), Sonnet 5.5 (6), Sonnet 4.6 (4), Haiku 4.5 (1). The main Tinker chats answer through the **Claude Code worker**, not the embedded runner.                                                                                                                                                                                                                                                                                                                                                       | `openclaw gateway call sessions.list`                                              |
| F2  | 73 of 87 sessions have no stored model override, so they are Auto. 14 carry `modelOverrideSource: "user"` and are hand-picked. Auto means "no user pin", decided in `hasExplicitModelSelection` (`src/auto-reply/reply/model-selection.ts:478`).                                                                                                                                                                                                                                                                                                                                                                                                       | same call; that file                                                               |
| F3  | Thalamus v2 is live. 201 `j.route.decision` rows since 2026-09-25: anthropic solo 197, anthropic critic 1, xai solo 3. The rows carry domain, house, mode, score and margin only (rule L4: no model keys).                                                                                                                                                                                                                                                                                                                                                                                                                                             | `~/.openclaw/logs/events.sqlite`                                                   |
| F4  | `llm-ledger.sqlite` is 2.6 GB for 6,695 calls since 2026-09-19 because it keeps gzipped request and response bodies. Every row has input, output, cacheRead, cacheWrite and `duration_ms`. Since 09-29: xai 453 rows, claude-code 140, openai-codex 113, copilot 8.                                                                                                                                                                                                                                                                                                                                                                                    | `src/forensic/llm-ledger.ts`; the file                                             |
| F5  | **A claude-code row is one gateway turn, not one API call.** One row holds 26.6 million cache-read tokens and 110,566 output tokens for a single turn: the sum over every call the CLI made inside it. The embedded providers (xai, codex, copilot) write one row per call. So the LLM ledger cannot feed a per-call cache ledger for the lane that runs the main chats.                                                                                                                                                                                                                                                                               | rows for `agent:main:tinker:mtba8duf`                                              |
| F6  | Exact per-call counts exist on the agent-event bus. `src/infra/call-telemetry.ts` defines the `stream: "call"` event (phase send / usage / end, with `input`, `cacheRead`, `cacheWrite`, `output`). The embedded runner emits it (`embedded-agent-subscribe.handlers.messages.ts`) and the cc-bridge emits it from the CLI's own `message_start` and `message_delta` lines (`extensions/tinkerclaw-tinker-bridge/src/stream.ts:540-600`). `onAgentEvent` is a published plugin-SDK export (`plugin-sdk/agent-harness-runtime.ts:69`). The Claude Code transcripts also hold per-call `usage`, with a request id and the 5-minute / 1-hour write split. | files named                                                                        |
| F7  | The bridge tracker skips sub-agent stream events (`parent_tool_use_id`), so calls a Claude Code sub-agent makes inside a turn reach the turn aggregate but not the per-call feed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `stream.ts:562` comment                                                            |
| F8  | The amygdala runs in shadow mode since 06:31 today. Its store holds 6 verdicts, all skipped as `not-allowed`, and 2 real situations at the stop seam. `sendRealSituations` is false, so **Jev has never seen a live situation**. Installed hooks: PreToolUse (timeout 330 s), UserPromptSubmit (5 s), PostToolUse (5 s), Stop (8 s).                                                                                                                                                                                                                                                                                                                   | `~/.openclaw/data/amygdala-jev/amygdala.sqlite`, `cc-hook-settings.effective.json` |
| F9  | The config prices subscription providers at zero (claude-code, openai-codex, copilot: `cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}`). Only xai and openrouter carry real numbers. The paper's "plan price" (P§3) therefore has no data behind it today. Concurrency caps are global: `agents.defaults.maxConcurrent` 4, `subagents.maxConcurrent` 8.                                                                                                                                                                                                                                                                                      | `~/.openclaw/openclaw.json`                                                        |
| F10 | v2 calls `thalamusPlan` without `refusals` or `cooling` (`model-selection.ts:622-640`). The refusal veto and the cooling veto exist and are tested, but nothing feeds them in production. The amygdala emits `amygdala2.refusal` events; nothing turns them into a `RefusalLedger`.                                                                                                                                                                                                                                                                                                                                                                    | that call site                                                                     |

## 2. Inventory: paper concept against code

"Exists" means it does the paper's job now. "Partly" names what is missing. "Absent" means nothing to extend.

| Paper concept                          | Status | File and symbol, or what is missing                                                                                                                                                                                                                                        |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P§3 map: rungs, frontier               | exists | `thalamus-frontier.ts`: `FrontierRung`, `frontierRungsFor`, `paretoFrontier`; efforts from `provider-effort-ladders.ts`; heights from `aa-effort-index.ts`                                                                                                                 |
| P§3 strength by kind of work           | exists | `DOMAIN_STRENGTH` (`domain-strength.generated.ts`), `domainStrengthFor`, 17 `TaskDomain`s                                                                                                                                                                                  |
| P§3 map rebuilt daily                  | partly | the `model-rank-refresh` cron re-ranks AA scores into `openclaw.json`; the strength table is regenerated offline, not on that schedule                                                                                                                                     |
| P§3 two prices (list, plan)            | partly | `rel-cost-table.ts` gives relative cost per task, not €/Mtok; no plan price (F9); no cache multipliers outside `types.models.ts` config fields that are zero                                                                                                               |
| P§3 quota pace                         | exists | `thalamus-supply.ts`: `supplyStateFrom`, `shadow`, `ballistic`, `EXHAUSTED_PERCENT`, `SHADOW_LAMBDA` 0.6. It takes the largest shadow across windows, which covers the paper's "short window with room does not make a provider cheap" case. Phase B pins that with a test |
| P§3 cache state, cache ledger          | absent | `cache-ttl.ts` keeps one last-call timestamp per session; `call-telemetry.ts` carries the counts (F6). No per model, per conversation ledger of warm tokens and expiry                                                                                                     |
| P§3 time per rung                      | absent | nothing holds first-token time, speed or thinking time per rung. The raw data exists: `duration_ms` in the LLM ledger, `timeToFirstByteMs` on `model_call_ended`, `ttft_ms` in the CLI result                                                                              |
| P§3 the dial                           | exists | `THALAMUS_BIAS_GAP`, `anchoredBiasPick`, anchor `claude-code/claude-opus-5`, reserved set `THALAMUS_RESERVED_RE`                                                                                                                                                           |
| P§3 one price per option               | absent | v2 has `cost_eff = cost x (1 + λ·shadow)` on a per-task axis. No time term, no failure term, no cache-aware money                                                                                                                                                          |
| P§3 vetoes: capacity, quota            | exists | `thalamus-feasibility.ts`: `fitsContext`, `CAPACITY_HEADROOM`; supply `spent`                                                                                                                                                                                              |
| P§3 veto: policy table                 | partly | `refusalCount`, `REFUSAL_VETO_COUNT` 2, `REFUSAL_TTL_MS` 30 days exist; the operator's vendor x topic table does not; the ledger is never fed (F10)                                                                                                                        |
| P§3 veto: privacy by source            | absent | `classifySubject` marks "sensitive" text; nothing decides from where a task came                                                                                                                                                                                           |
| P§4 task, step, outcome reads          | absent | v2 classifies with regex (`classifyTaskDomain`, `classifySubject`). The Jev client exists in the amygdala (`src/jev.ts`)                                                                                                                                                   |
| P§4 confidence floor, cautious option  | absent |                                                                                                                                                                                                                                                                            |
| P§4 read sent while the tool runs      | absent |                                                                                                                                                                                                                                                                            |
| P§4 one call, two jobs                 | absent | the amygdala's per-step call is `decide()` in `decide.ts:149-170`; families ask, one `jev.ask` answers all                                                                                                                                                                 |
| P§4 privacy first                      | partly | `sendRealSituations` false and `redact.ts` in the amygdala; no source-based rule                                                                                                                                                                                           |
| P§5 Table 1 row "the request"          | exists | `thalamusPlan` called at `model-selection.ts:622`                                                                                                                                                                                                                          |
| P§5.1 N\*, single-step rule            | absent | pure function to write                                                                                                                                                                                                                                                     |
| P§5.2 digest rule, reader, recall      | absent | `tool-result-context-guard.ts` truncates results to fit the window; it does not condense with a reader and keeps no named raw copy                                                                                                                                         |
| P§5.4 five rules                       | absent | rule 4 has partial machinery: the `adversarial-verify` kit and `synapse_debate`; the amygdala families `double-check` and `second-opinion` use Jev, not a second model family                                                                                              |
| P§6.1 plan graph with declared changes | partly | `orchestration-runtime.ts` has `parallel` and `pipeline` with no declared inputs, outputs or writes. ORCA units declare `writes` (`parallel-implement.workflow.js`) and are the model for the declaration                                                                  |
| P§6.2 critical path, slack             | absent |                                                                                                                                                                                                                                                                            |
| P§6.3 shared-start fan-out             | partly | v2 `fanOutSupply` picks the leaf supply by clock; nothing groups siblings by a shared prefix                                                                                                                                                                               |
| P§6.4 hedge                            | absent |                                                                                                                                                                                                                                                                            |
| P§6.4 panels at the top of the dial    | exists | `CompositionMode` debate / critic / fan-out at `COMPOSITION_MIN_BIAS` 4, `CONTESTED_MARGIN` 1.5                                                                                                                                                                            |
| P§6.5 per-provider concurrency         | partly | global caps only (F9); `concurrencyCap()` in `orchestration-runtime.ts:60` is min(16, cores-2)                                                                                                                                                                             |
| P§8 ladder by reason                   | exists | `reorderChain` and `FailureClass` in `thalamus-plan.ts:392`; recovery through `runWithModelFallback`                                                                                                                                                                       |
| P§8 hand-picked model never replaced   | exists | `hasExplicitModelSelection` (`model-selection.ts:478`)                                                                                                                                                                                                                     |
| P§8 outcome read                       | absent | the runner's failure classifier (`failure-signal.ts`) covers errors, not "stuck" or "worth a retry"                                                                                                                                                                        |
| P§8 one writer to finish               | absent |                                                                                                                                                                                                                                                                            |
| P§8 decision ledger                    | partly | `j.route.decision` row and LLM-ledger bodies; no row with the options, prices, vetoes, pick and outcome                                                                                                                                                                    |
| P§8 nightly learning                   | partly | shrinkage estimator specified in MAESTRO §8; the v2 registry audit found the ledger crediting models that never ran, so it cannot be trusted as a base. Cron infrastructure exists                                                                                         |
| P§10 tests                             | absent | none written                                                                                                                                                                                                                                                               |

## 3. Seams: where each piece of work can go to another model

### 3.1 Table 1 against the three lanes

**R** reachable today. **S** needs a seam (named). **X** out of reach (why).

| Switch point     | Embedded runner (xai, codex, copilot)                                                                                                                                                                                                                                                                                                                      | Claude Code worker (the main chats)                                                                                                                                                                                                      | Fan-out (orchestrate, spawn)                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The request      | **R** `thalamusPlan` at `model-selection.ts:622`; provider and model set before the run                                                                                                                                                                                                                                                                    | **R** same call; the bridge respawns the worker with `--resume` when the requested model differs (`worker-pool.ts:128`)                                                                                                                  | **R** `spawnSubagentDirect` takes `model` (`subagent-spawn.ts:253`)                        |
| Plan and work    | **S** the planner is a routed call: `completeWithPreparedSimpleCompletionModel` (`simple-completion-runtime.ts:278`) takes any configured model                                                                                                                                                                                                            | **S** same helper called from the plugin, outside the worker                                                                                                                                                                             | **R** `agent(task, {model})` (`orchestration-runtime.ts:41`) but only `claude-code/*` (C2) |
| A unit of work   | **R** the sub-agent spawn above                                                                                                                                                                                                                                                                                                                            | **R** `--agents` with a per-agent `model` runs a sub-agent on another model (probe P3); needs the bridge to pass it (`worker.ts` builds no `--agents` today). `CLAUDE_CODE_SUBAGENT_MODEL` also exists in the binary, unprobed           | **R** within `claude-code/*`                                                               |
| The next step    | **S** a `streamFn` wrapper beside `wrapStreamFnWithLedger` (`attempt.ts:2042`) receives `(model, context, options)` on every call and can replace `model`. `pi-ai` already drops signed thinking blocks and rewrites tool-call ids when the model changes (`transform-messages.js:65-104`). Missing: per-call auth and API resolution for the new provider | **X** for a call inside a turn: the CLI fixes `--model` at spawn. **R** at the turn boundary by respawn. A same-vendor proxy (probe P2) can rewrite the field; not recommended (3.2)                                                     | **X** a unit is one worker                                                                 |
| Reading a result | **S** `tool_result_persist` is a synchronous hook (`hook-types.ts:876`), so it cannot await a reader. Seam: an async digest step in the tool-result path before `installToolResultContextGuard` (`attempt.ts:1590`)                                                                                                                                        | **S** a PostToolUse hook may return `updatedToolOutput`, which the CLI says "works for all tools" (binary strings). Needs a longer hook timeout than the installed 5 s and a raw copy on disk. One probe call left to confirm in phase D | **R** a unit that reads is its own worker                                                  |
| The check        | **R** `prepareSimpleCompletionModelForAgent` (`simple-completion-runtime.ts:237`) calls any family in process, ledgered                                                                                                                                                                                                                                    | **S** the Stop hook can refuse the stop and hand the model a reason; the checker runs in the plugin and needs a trigger from `step-commits-or-claims`                                                                                    | **R** a check is a unit with another `model`                                               |
| The finish       | **S** `before_agent_reply` exists (`hook-types.ts:74`); a rewrite pass is one more call                                                                                                                                                                                                                                                                    | **X** in an interactive chat the worker's own model writes the reply. **R** inside an orchestrated task: the write unit takes the model                                                                                                  | **R** a write unit                                                                         |
| Inside a tool    | **R** tools resolve their model through `resolveSimpleCompletionSelectionForAgent` (`simple-completion-runtime.ts:67`): `pdf-tool`, `media-understanding/image`, `btw`, `tts`, `model-scan`                                                                                                                                                                | **X** built-in tools that call a small model run inside the CLI. The small model is set by `ANTHROPIC_DEFAULT_HAIKU_MODEL` at spawn (binary strings, unprobed)                                                                           | not applicable                                                                             |

Hedging, prefetch and panels need no row: they are units started by the scheduler (section 12).

### 3.2 The three Claude Code questions

**Can the model change per sub-agent or per unit? Yes.** Probe P3 ran a parent on `sonnet` (resolved to
`claude-sonnet-5-5`, 20 tools) with `--agents '{"probe-sub": {..., "model": "haiku"}}'`. The proxy log shows four
calls: parent on `claude-sonnet-5-5`, two calls on `claude-haiku-4-5-20251001` for the sub-agent, then the parent
again. The sub-agent saw only its brief (1,598 then 1,988 input tokens, cache read 0, cache write 0). The parent's
own cache stayed warm across the excursion: cache write 25,172 on its first call, cache read 25,172 on its last.
That is the paper's "fresh point costs nothing to switch" (P§5) measured on the real CLI.

**Can a hook change anything about the next call? Not the model.** Hooks add context (`additionalContext` on
UserPromptSubmit, PreToolUse, PostToolUse), deny a tool, refuse a stop, or replace a tool's output. This matches
`reference_amygdala_injection_seams.md` (verified 2026-09-28) and the field names in the CLI binary. A PreToolUse
hook could change the `model` argument of a sub-agent tool call through `updatedInput`; the charter forbids
`updatedInput`, so that route stays closed.

**Does a same-vendor proxy keep working with the subscription login?** Yes, with two facts to weigh.

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` worked with the OAuth login from the credentials file. The CLI sent
  its usual calls to the proxy, which forwarded them unchanged to `api.anthropic.com` and got HTTP 200 back (P1).
- Rewriting only the `model` field of the second call from Haiku 4.5 to `claude-sonnet-5-5` (P2) returned HTTP 200
  and a stream whose `message_start` named `claude-sonnet-5-5`. The history at that point held a signed thinking
  block from Haiku and a tool result. Usage on that call: `cache_read_input_tokens` 0,
  `cache_creation_input_tokens` 5,329 (one-hour tier). The call before it, on the original model, had read 4,249
  cached tokens. So a mid-turn switch costs a cold write, as P§5.1 says. Whether the API used the old thinking block
  or silently dropped it cannot be read from usage; the call answered in 5 output tokens with no thinking.
- The CLI's final JSON for P2 was not captured cleanly (my parse failed), so "the CLI tolerated a response from a
  different model" rests on the proxy having served a complete 200 stream and not on the CLI's own result.

**Recommendation for this build.** Do not build the proxy for enforcement. It puts a local process between every
worker and the vendor, carries the OAuth token through it, and every worker depends on it staying up. The gain it
buys, a model change inside a turn, is the case P§5.1 says rarely pays. The Claude Code lane gets the three switches
that measured cheap: the turn boundary (respawn), the unit (`--agents`, orchestrate), and the tool result
(`updatedToolOutput`). The proxy stays specified here as an optional unit D6 that the architect can order later.

### 3.3 Probe record

Eight model calls, all on the subscription login (no API key in the environment), scratch folder from `mktemp -d`,
proxy on loopback port 18997, hard cap of 10 forwarded calls in the proxy code. Prompts under 1,000 tokens; the
CLI adds its own tool and system text. Order: P1 baseline tool loop on Haiku (2 calls); P2 same loop with the
second call rewritten to Sonnet 5.5 (2 calls); P3 sub-agent on Haiku under a Sonnet parent (4 calls). The proxy
logged header names and body shapes only, never header values or content. The proxy was stopped after each run;
afterwards no listener on 18997 and no process. List-price equivalent of the two runs whose totals I captured:
about $0.13. Two calls of the ten remain unspent; they are reserved for the PostToolUse `updatedToolOutput`
check in phase D.

## 4. Challenges to the charter

**C1. One ledger, but not one file.** The charter says one store with a new table. The amygdala store is
versioned (`SCHEMA_VERSION`), append-only, and exists only while the amygdala is enabled. Thalamus must keep
recording when the amygdala is off, and its migrations must never touch a file another plugin owns. Proposal: two
files, one logical ledger. Thalamus rows carry the amygdala's `situation_id` and verdict ids as join keys, and the
step read that rides on the amygdala's call is stored in both (verdicts by the amygdala, `reads` rows by
Thalamus). Evidence: `extensions/tinkerclaw-amygdala/src/schema.ts` and `runtime.ts:339-350` (the file is opened
by that plugin's `start()`).

**C2. The scheduler's first consumer cannot pick a model outside the vendor.** The charter says `orchestrate`
with `model: "auto"`. `orchestration-deps.ts:57-63` forces every leaf to `claude-code/*` as a billing guard
(`coerceClaudeCodeModel`), and it says why: a stray metered id must never spill onto the per-token API. So in
this build "auto" chooses among Haiku, Sonnet, Opus and Fable, plus effort. Cross-vendor leaves need the guard
relaxed to a named list of subscription-billed providers. I keep the guard and add
`orchestrate.allowedLeafProviders` (default `["claude-code"]`). Widening it changes billing exposure, so it is
the architect's (section 16, O3).

**C3. Placing the shared Jev client.** The charter says reuse the amygdala's client. A relative import between
extensions breaks the plugin boundary (the bridge had to get `openclaw/plugin-sdk/fork-telemetry` for the same
reason). Proposal: move `jev.ts`, `breaker.ts` and `cache.ts` into core as `src/infra/jev/`, publish
`openclaw/plugin-sdk/fork-jev`, and leave one-line re-export files at the old amygdala paths so its suites and
imports stay byte-identical. The amygdala's own tests gate that move.

## 5. Findings that narrow the charter's wording

- **The main chats are Claude Code turns** (F1). The embedded per-call seam serves 24 of 87 sessions today and none
  of the main chats. For the main chats, "per call" means observing calls (F6) and switching at turn, unit and
  tool-result level (3.1).
- **Live Jev reads are local until `sendRealSituations` is switched** (F8). In shadow on real traffic the task,
  step and outcome reads come from local rules. The Jev path runs on synthetic cases in phase H (€2 cap). Turning
  real reads on is the architect's (O1).
- **The existing plugin hooks cannot make the per-call decision.** `model_call_started` and `model_call_ended` are
  void hooks and carry no messages or usage (`hook-types.ts:230-241`); `llm_input` fires once per prompt. The
  per-call seam is a `streamFn` wrapper, added to core as one small inert file (section 6.2).
- **v2's refusal veto is inert in production** (F10). v4's learning job will write the refusal ledger. Handing that
  ledger to v2's live call would change live routing, so it is not done here (O6).

## 6. Architecture

### 6.1 Where code goes

Pure logic beside v2 in `src/shared/` (browser-safe, no clock, no I/O, `nowMs` passed in, as v2 does), so the chart
and the router share one computation. Runtime in `extensions/tinkerclaw-thalamus`. Core edits are small, inert when
v4 is off, and each has a test that compares behaviour with v4 off against develop.

| File                                              | Owns                                                                                                                   | Pure |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/shared/thalamus-v4-types.ts`                 | every v4 type in section 7; no logic                                                                                   | yes  |
| `src/shared/thalamus-price-table.ts`              | list prices in €/Mtok with cache multipliers per model family; plan factor per supply                                  | yes  |
| `src/shared/thalamus-cache-ledger.ts`             | reducer: `applyCallUsage`, `predictCall`, `isWarm`                                                                     | yes  |
| `src/shared/thalamus-options.ts`                  | option enumeration: rung x feed                                                                                        | yes  |
| `src/shared/thalamus-price.ts`                    | the price function of section 11                                                                                       | yes  |
| `src/shared/thalamus-switch.ts`                   | `breakEvenN`, `singleStepPays`, `digestPays`, `decideSwitch`                                                           | yes  |
| `src/shared/thalamus-vetoes.ts`                   | privacy by source, policy table, plus v2's `feasibility`                                                               | yes  |
| `src/shared/thalamus-reads.ts`                    | read types, confidence floor, cautious defaults, local rules                                                           | yes  |
| `src/shared/thalamus-route-call.ts`               | `routeCall`: reads + cache ledger + options + vetoes + price + switch policy                                           | yes  |
| `src/shared/thalamus-graph.ts`                    | plan graph, conflict edges, critical path, slack, ready set, shared-start groups, hedge test                           | yes  |
| `src/shared/thalamus-learning.ts`                 | `shrink`, nightly update over aggregated outcomes                                                                      | yes  |
| `extensions/tinkerclaw-thalamus/`                 | plugin: config, store, feeds, reads client, shadow, digest, check, finish, scheduler runtime, RPC, events, nightly job | no   |
| `src/agents/embedded-agent-runner/call-router.ts` | registry `setCallRouter` and `wrapStreamFnWithCallRouter`; identity when nothing is registered                         | no   |
| `src/infra/jev/`, `src/plugin-sdk/fork-jev.ts`    | the moved Jev client (C3)                                                                                              | no   |
| `src/plugin-sdk/fork-thalamus.ts`                 | `registerCallRouter`, `registerLeafModelResolver` for the plugin                                                       | no   |

### 6.2 Core edits and why each is inert when off

| Edit                                                  | Change                                                                                      | Inert when off because                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `attempt.ts:~2042`                                    | one line: `wrapStreamFnWithCallRouter(streamFn, meta)` after `wrapStreamFnWithLedger`       | with no router registered it returns the same function object; test compares the object |
| `orchestration-deps.ts:220`                           | `agentOpts.model === "auto"` calls an injected resolver                                     | resolver undefined: falls to today's coerce path                                        |
| `worker.ts` args builder                              | optional `--agents` JSON and `CLAUDE_CODE_SUBAGENT_MODEL` from an injected provider         | provider undefined: argument list byte-identical (test on the built args)               |
| amygdala `types.ts`, `question-book.ts`, `runtime.ts` | `FamilyId` gains `"routing"`; `QuestionBookOptions.extraSeedDirs`; `runtime.registerFamily` | all additive; nobody registers, nothing changes; its full suite is the gate             |
| `src/infra/events/catalog.ts`                         | new event names                                                                             | catalog entries only                                                                    |
| `tinker-ui` `routing-rationale.ts`                    | one new block, drawn only when the payload carries call decisions                           | no payload, no block                                                                    |

## 7. Types

All in `src/shared/thalamus-v4-types.ts`. v2 types (`FrontierRung`, `SupplyState`, `TaskDomain`, `SubjectClass`,
`ThalamusPlan`) are reused, not copied.

```ts
export type Rung = FrontierRung; // key, effort, smart, cost(€/task, v2), basis
export type Feed = "thread" | "brief" | "digest"; // P§3 "one price per option"
export type Lane = "embedded" | "cc-bridge"; // call-telemetry.ts CallLane
export type Confidence = number; // 0..1 as Jev returns it

export type ReadSource = "jev" | "local" | "fallback"; // fallback = Jev silent or below floor
export type Answered<T> = { value: T; conf: Confidence; source: ReadSource };

export type TaskRead = {
  id: string;
  ts: number;
  sessionKey: string;
  kind: Answered<TaskDomain>;
  difficulty: Answered<1 | 2 | 3 | 4 | 5>; // lookup, routine, involved, hard, research
  topic: Answered<SubjectClass>;
  urgency: Answered<"waiting" | "today" | "whenever">;
  shape: Answered<"answer" | "parts" | "chain">;
  private: boolean; // decided from the source, before any read
};
export type StepKind = "plan" | "tool" | "read" | "write" | "check" | "answer";
export type StepRead = {
  id: string;
  ts: number;
  sessionKey: string;
  callIndex: number;
  kind: Answered<StepKind>;
  depth: Answered<"mechanical" | "routine" | "deep">;
  needs: Answered<"all" | "recent" | "item">;
  runLength: Answered<0 | 1 | 2 | 3 | 4>; // level; N by level is config (section 11)
  parallelOk: Record<string, Answered<boolean>>; // pending item id -> can run at the same time
  commitsOrClaims: Answered<boolean>;
};
export type OutcomeState = "done" | "retry" | "stuck" | "refused" | "check";
export type OutcomeRead = {
  id: string;
  ts: number;
  callIndex: number;
  state: Answered<OutcomeState>;
};

export type CachePolicy = {
  // per vendor family, from the price table
  readMult: number;
  write5mMult: number;
  write1hMult: number;
  ttlMs: 300_000 | 3_600_000;
  automatic: boolean; // automatic: vendor caches with no write charge
};
export type CacheLedgerEntry = {
  // one per (conversationKey, modelKey)
  conversationKey: string;
  modelKey: string;
  warmTokens: number;
  writtenAtMs: number;
  ttlMs: number;
  lastReadAtMs: number;
};
export type CallPrediction = { cachedIn: number; uncachedIn: number; writeIn: number };

export type Option = { rung: Rung; feed: Feed; inputTokens: number; expectedOutputTokens: number };
export type PriceParts = {
  money: number;
  pace: number;
  timeSec: number;
  critSec: number;
  pFail: number;
  recovery: number;
};
export type PricedOption = Option & {
  parts: PriceParts;
  price: number;
  quality: number;
  vetoed?: VetoRecord;
};
export type VetoRecord = {
  veto: "privacy" | "policy" | "capacity" | "quota" | "engagement" | "reachability";
  detail?: string;
};

export type SwitchDecision = {
  kind: "keep" | "switch" | "fresh"; // fresh = new unit, check, finish, digest
  reason:
    | "fresh-point"
    | "run-exceeds-n-star"
    | "stuck"
    | "cache-cold"
    | "single-step-pays"
    | "kept-below-n-star"
    | "hand-picked";
  nStar?: number;
  expectedRun?: number;
};
export type CallDecision = {
  id: string;
  ts: number;
  runId: string;
  callIndex: number;
  lane: Lane;
  mode: "shadow" | "enforce";
  taskReadId?: string;
  stepReadId?: string;
  options: PricedOption[];
  vetoes: Array<{ key: string } & VetoRecord>;
  pick: PricedOption;
  incumbent: string;
  switch: SwitchDecision;
  applied: boolean;
  wouldChange: boolean;
  degraded: boolean;
  dialIdx: number;
};
export type LedgerRow = {
  // the decision plus what happened (table `outcomes`)
  decisionId: string;
  actualModel: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  durationMs: number;
  ttftMs?: number;
  stopReason?: string;
  outcome: OutcomeState | "error";
  refused: boolean;
};

export type Unit = {
  // P§6.1
  id: string;
  task: string;
  kind: "read" | "work" | "check" | "combine" | "write";
  inputs: string[];
  outputs: string[];
  writes: string[];
  estIn: number;
  estOut: number;
  sharedStart?: { id: string; tokens: number };
  model: string | "auto";
  urgency: "waiting" | "today" | "whenever";
  private: boolean;
};
export type PlanGraph = {
  id: string;
  units: Unit[];
  edges: Array<{ from: string; to: string; why: "input" | "same-write" }>;
  criticalPath: string[];
  slackSec: Record<string, number>;
};
```

## 8. Storage

`~/.openclaw/data/thalamus-v4/thalamus.sqlite`, mode 0700 directory, WAL, `better-sqlite3` as in the amygdala,
`meta.schema_version`. **Nothing here stores request or response bodies**; that is what made the LLM ledger 2.6 GB.
Model keys are stored locally and never travel on the research event bus (rule L4).

```sql
CREATE TABLE reads(id TEXT PRIMARY KEY, ts INT, kind TEXT, session TEXT, run_id TEXT, call_index INT,
  source TEXT, answers_json TEXT, latency_ms INT, cost_usd REAL, situation_ref TEXT);
CREATE TABLE decisions(id TEXT PRIMARY KEY, ts INT, session TEXT, run_id TEXT, call_index INT, lane TEXT,
  mode TEXT, task_read TEXT, step_read TEXT, dial_idx INT, private INT, degraded INT,
  incumbent TEXT, pick TEXT, pick_feed TEXT, switch_kind TEXT, switch_reason TEXT, n_star REAL,
  applied INT, would_change INT, price REAL, incumbent_price REAL, options_json TEXT, vetoes_json TEXT);
CREATE INDEX decisions_run ON decisions(run_id, call_index);
CREATE TABLE outcomes(decision_id TEXT PRIMARY KEY REFERENCES decisions, ts INT, actual_model TEXT,
  input INT, cache_read INT, cache_write INT, output INT, duration_ms INT, ttft_ms INT,
  stop_reason TEXT, outcome TEXT, refused INT, cost_eur REAL);
CREATE TABLE cache_ledger(conversation TEXT, model TEXT, warm_tokens INT, written_at INT, ttl_ms INT,
  last_read_at INT, PRIMARY KEY(conversation, model));
CREATE TABLE rung_time(rung TEXT PRIMARY KEY, ttft_p50 REAL, ttft_p95 REAL, tokens_per_sec REAL,
  think_sec REAL, n INT, updated_at INT);
CREATE TABLE units(plan_id TEXT, unit_id TEXT, deps_json TEXT, writes_json TEXT, model TEXT,
  start_ts INT, end_ts INT, slack_sec REAL, on_critical INT, hedged INT, status TEXT, PRIMARY KEY(plan_id, unit_id));
CREATE TABLE estimates(domain TEXT, step_kind TEXT, rung TEXT, n INT, wins INT, retries INT, refusals INT,
  cost_sum REAL, time_sum REAL, prior REAL, posterior REAL, updated_at INT, PRIMARY KEY(domain, step_kind, rung));
CREATE TABLE raw_results(name TEXT PRIMARY KEY, ts INT, session TEXT, path TEXT, bytes INT, digest_tokens INT);
```

`decisions` older than 90 days are pruned by the nightly job; `estimates` and `rung_time` are kept. Raw tool
results for the digest reader live as files under `~/.openclaw/data/thalamus-v4/raw/<session-hash>/<name>` (mode
0600); `raw_results` indexes them. They inherit the session's privacy: a private session's raw files are never
sent to a reader outside the approved list.

Cache ledger keys: `conversation` is the session key plus lane (plus sub-agent id where the bridge can name it),
`model` is the route key. The ledger is updated from the `stream: "call"` bus (F6); the LLM ledger is used only in
phase F for replay.

## 9. Gateway methods and events

Registered by the plugin with `api.registerGatewayMethod`. No method changes a mode or a flag; switching shadow or
enforcement is a config edit, and that stays the architect's.

| Method                  | Params                                                 | Result                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `thalamus.status`       | none                                                   | `{mode, flags, jev: {enabled, breaker, calls, spentEur}, cacheLedger: {entries}, decisions: {shadow, wouldChange}, reads: {jev, local, fallback}, lastDecisionAt}` |
| `thalamus.feed`         | `{sinceId?, limit? <= 200, sessionKey?}`               | `CallDecisionView[]`: decision without `options_json`, plus a one-line reason                                                                                      |
| `thalamus.explain`      | `{decisionId}`                                         | full `CallDecision` with options, vetoes and price parts                                                                                                           |
| `thalamus.cache.state`  | `{sessionKey}`                                         | `CacheLedgerEntry[]` with `warmUntilMs`                                                                                                                            |
| `thalamus.ledger.query` | `{fromMs, toMs, groupBy: "domain" \| "rung" \| "day"}` | aggregated outcomes for the panel and the learning job                                                                                                             |
| `thalamus.plan.preview` | `{units}` or `{task}`                                  | `PlanGraph` with routing per unit; no run (phase E)                                                                                                                |
| `thalamus.learn.run`    | `{dryRun: true}`                                       | estimate diff; a non-dry run happens only from the nightly job                                                                                                     |

Agent-bus and gateway events (payloads are small; model keys appear only in the gateway events the panel reads,
not on the research bus):

| Event             | When                                   | Payload                                                                                                           |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `thalamus.call`   | after each shadow or enforced decision | `{decisionId, runId, callIndex, lane, mode, pick, incumbent, switch, wouldChange, price, incumbentPrice, reason}` |
| `thalamus.read`   | after a read                           | `{kind, source, latencyMs, degraded}`                                                                             |
| `thalamus.plan`   | a graph is scheduled or finishes       | `{planId, units, criticalPath, hedges}`                                                                           |
| `thalamus.status` | every 30 s while enabled               | the `status` result                                                                                               |

Research-bus rows in `catalog.ts`, following `j.route.decision`: `j.thalamus.call` (domain, lane, mode, switch
kind enum, price ratio, would-change flag), `j.thalamus.read` (kind, source enum, latency), `j.thalamus.switch`
(reason enum, N\* and expected run as numbers). No model keys, reason text or prompt content.

## 10. Jev: the question list and how it merges

Names, purposes, types and option keys only. **The wording lives in `extensions/tinkerclaw-thalamus/questions/*.json`
and nowhere else.** Every question carries the fields the amygdala's `Question` schema requires (id, version, family
`routing`, seams, type, criteria, instructions, fields, cutoff, purpose, origin, retirement, mustCatch, status, name),
and each cutoff is `none` because Thalamus computes with the whole answer and its confidence, not a threshold.

| Read    | Question id              | Purpose                                                                         | Type   | Options                                                                                               |
| ------- | ------------------------ | ------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| task    | `route-work-kind`        | which map domain the task belongs to                                            | choice | one option per `TaskDomain` (17)                                                                      |
| task    | `route-difficulty`       | how much reasoning the task needs                                               | score  | 5 levels: lookup, routine, involved, hard, research                                                   |
| task    | `route-topic-class`      | whether some vendors refuse or restrict this topic                              | choice | none, medical, security, legal, sensitive                                                             |
| task    | `route-urgency`          | whether someone is waiting                                                      | choice | waiting, today, whenever                                                                              |
| task    | `route-shape`            | one answer, independent parts, or a dependent chain                             | choice | answer, parts, chain                                                                                  |
| step    | `step-kind`              | what this step does                                                             | choice | plan, tool, read, write, check, answer                                                                |
| step    | `step-depth`             | how much thought it needs                                                       | score  | 3 levels: mechanical, routine, deep                                                                   |
| step    | `step-context-need`      | how much of the conversation it needs                                           | choice | all, recent, item                                                                                     |
| step    | `step-run-length`        | how many mechanical steps probably follow                                       | score  | 5 levels, none to more than ten                                                                       |
| step    | `step-parallel-ok-<n>`   | for the n-th pending item, whether it can run at the same time as the others    | noul   | asked once per pending item, at most 6 per read, numbered by position; extra items count as dependent |
| step    | `step-commits-or-claims` | whether the step changes something outside or states a fact others will rely on | noul   |                                                                                                       |
| outcome | `outcome-state`          | how the call ended                                                              | choice | done, retry, stuck, refused, check                                                                    |

**Seams.** Task read at the `prompt` seam (fields `request`). Step read at `pre-tool` and for the first call at
`prompt` (fields `request`, `tool`, `args`, `toolRecord`). Outcome read at `post-tool` and `stop` (fields `request`,
`toolRecord`, `reply`, `repeatedErrors`). These are existing `Situation` fields, so the amygdala's type stays
unchanged apart from the added family id.

**Stuck is code, not Jev.** "The same failure twice" is `repeatedErrors >= 2` on the situation; `outcome-state`
returns `stuck` from that count without a call, and Jev is asked only to tell done, retry, refused and check.

**How it merges (P§4 "one call, two jobs").** Thalamus registers a `Family` with id `routing` through
`runtime.registerFamily`. Its `questionsFor(seam, s, state)` returns the ids above for the seam; its `decide()`
always returns nothing (it never holds, asks or blocks); its `observe()` receives the verdicts of the same
`jev.ask` that the safety, second-opinion and double-check families use. One HTTP call carries both sets. The
amygdala's `budgetMs` per seam is not extended: a slow Jev costs the same wait as today, and when it is late the
routing verdicts are `skipped` and the reads become `fallback`.

**When the amygdala is off.** Thalamus builds its own `JevClient` from `fork-jev` and asks alone. Without the
amygdala's Claude Code hooks there is no PreToolUse seam, so the standalone reader asks at three places only: the
task read from `before_model_resolve`, the outcome read from `agent_end`, and for embedded runs the step read from
the call-router wrapper (which sees the context). Claude Code steps get local reads.

**Read sent ahead (P§4).** At PreToolUse for step _n_ the family also starts the step read for _n+1_ from the
tool record so far, keeps the promise in the turn state, and the next call takes it if it resolved; a plain
continuation reuses the last read. In shadow this costs no waiting.

**Confidence.** Floor 0.6 for every question (config `reads.confidenceFloor`, per-question override). It is a
starting value: nothing measures Jev's calibration yet (P§10 test 1). Below the floor, or on `skipped`, the read
becomes the cautious one: `needs = all`, no switch, no digest, the stronger of the two cheapest passing rungs,
and every vendor with a topic restriction is dropped.

**Local rules (private sources and Jev down).** `thalamus-reads.ts`: domain from `classifyTaskDomain`, topic from
`classifySubject`, urgency from the trigger (a user turn is `waiting`, cron and heartbeat are `whenever`), shape
from a list-of-items pattern, step kind from the tool name, depth `routine`, needs `all`, run length 0, commits from
`effectClass` at or above external. The local reader is v2's regex classifiers plus these, so the shadow data
stays comparable to what v2 already does.

**Privacy.** A task is private when its source is on the operator's list (config `privacy.privateSources`, section 11) and the decision is taken before any read. For private tasks `jev.sendRealSituations` is ignored: Jev reads
only if the source is on `privacy.jevApprovedSources`; otherwise local rules read. Private content goes only to
providers in `privacy.approvedProviders`.

## 11. The price, shadow mode and the flags

### 11.1 Price function

Per option, units in euros and seconds (P§3):

```
price = money x pace + lambda x t_crit + p_fail x c_rec

money  = ( uncachedIn x p_in + cachedIn x p_cr + writeIn x p_cw + E[out] x p_out ) / 1e6     [EUR]
pace   = max(0.4, 1 + SHADOW_LAMBDA x shadow(supply))          v2's effectiveCost; 1.0 if metered and shadow < 0
t_crit = max(0, t_option - slack(unit))                          [s]; 0 slack for a lone chain
t_option = ttft(cold or warm) + think_s(depth) + E[out] / tokens_per_sec                        [s]
lambda = { waiting: 0.004, today: 0.0005, whenever: 0 }         [EUR/s]
p_fail = clamp( health(supply) + refusalRate(domain, topic, rung), 0, 0.9 )
c_rec  = price of the next rung on the ladder + lambda x t_failed                                [EUR]
```

Where each input comes from:

| Input                               | Source                                                                                                               | Today                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p_in`, `p_out`, cache multipliers  | new `thalamus-price-table.ts`, list prices per model family; converted with `cost.eurPerUsd` (0.92, as the amygdala) | absent: written in phase B from the vendors' price pages, each row dated. Paper values as tests: read 0.1, Opus 5.5 0.05, Fable 5.1 0.025; write 1.25 (5 min) and 2.0 (1 h) |
| plan price                          | `planFactor[supply]` multiplying list price, default 1.0 (list price as the conservative money term)                 | the architect's fee data (O2)                                                                                                                                                       |
| `cachedIn`, `uncachedIn`, `writeIn` | `predictCall(cacheLedger, conversation, model, promptTokens, nowMs)`                                                 | from the call bus (F6)                                                                                                                                                      |
| `shadow`                            | v2 `SupplyState.shadow`                                                                                              | exists                                                                                                                                                                      |
| `ttft`, `tokens_per_sec`, `think_s` | `rung_time`, updated nightly from `duration_ms`, `timeToFirstByteMs` and stream timings                              | absent; cold start uses the rung's class default                                                                                                                            |
| `slack`                             | `PlanGraph.slackSec[unit]`                                                                                           | phase E                                                                                                                                                                     |
| `health`, `refusalRate`             | v2 health penalties and the refusal ledger written by the learning job                                               | ledger unfed today (F10)                                                                                                                                                    |
| `E[out]`                            | `tokens-per-task.ts` (`tokensPerTaskFor`) scaled by depth                                                            | exists                                                                                                                                                                      |

`lambda` values are starting guesses: a minute of someone waiting is worth about €0.24, roughly one mid-sized
Opus call. `quality(option)` is the strength in the read's domain where measured, else the AA height at that
effort, then moved by the `estimates` posterior (P§8). An option clears the bar when
`quality >= bar(dial) - relief[depth]`, with `bar` from v2's anchored dial (`thalamusRoute().target`) and
`relief = {mechanical: 12, routine: 5, deep: 0}` AA points. The relief values are guesses too; P§10 test 2 is what
tunes them.

`routeCall` picks the lowest price among options that clear the bar and pass the vetoes. Ties go to the incumbent,
then to the higher quality. Then `decideSwitch` (P§5.4) may overrule a pick that would move a running thread:

1. Fresh points (new unit, check, finish, digest): the pick stands.
2. A long result (`Feed = digest` beats `thread` by `digestPays`): condense, then price the thread without it.
3. A mid-thread move stands only if `expectedRun > N*` (`N* = (w - r_s) / (k r_b - r_s)`, from the cache ledger
   and the price table), or the outcome is `stuck` and a stronger rung is cheaper than another failed try
   (`p_fail x c_rec`), or the incumbent's cache is cold in the ledger. A single step needs `k r_b > 1`.
4. The checker comes from another family than the builder; the finish from the writer chosen for language and
   register.
5. A hand-picked model returns `kind: keep, reason: hand-picked` before anything else runs.

### 11.2 Shadow mode

`mode: "shadow"` is the default of the plugin once it is enabled. On every model call the plugin computes the
decision that enforcement would take and writes it, with `applied: 0`, to `decisions`; the outcome joins it when
the call ends. Embedded lane: the call-router wrapper sees the call before it goes out, computes synchronously (a
pure function, no I/O), hands the write to a deferred queue as `llm-ledger.ts` does, and always returns the
original `model`. Claude Code lane: the `send` event of the call bus triggers the computation (the call is already
on its way; nothing to change). The routed model of a Claude Code turn is v2's, unchanged. `wouldChange` and the
price gap between pick and incumbent are what the panel and phase F read.

### 11.3 Flags

Plugin `tinkerclaw-thalamus`: `enabledByDefault: false`, `activation.onStartup: true`. Enabling it is the architect's.
Config (all keys optional, the listed defaults apply):

| Key                                     | Default                                                         | Meaning                                                                             |
| --------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `mode`                                  | `"shadow"`                                                      | `shadow` or `enforce`                                                               |
| `enforce.perCall`                       | false                                                           | embedded lane replaces `model` per call                                             |
| `enforce.digest`                        | false                                                           | reader condenses long results                                                       |
| `enforce.check`                         | false                                                           | other-family check on commit or claim                                               |
| `enforce.finish`                        | false                                                           | one writer in orchestrated tasks                                                    |
| `enforce.hedge`                         | false                                                           | second copy of a slow critical-path unit                                            |
| `enforce.orchestrateAuto`               | false                                                           | `model: "auto"` resolves                                                            |
| `enforce.midThread`                     | false                                                           | switch a running thread at all; even with `perCall` on, off means fresh points only |
| `jev.enabled`                           | false                                                           | any outside read                                                                    |
| `jev.sendRealSituations`                | false                                                           | real content to Jev; synthetic only when false                                      |
| `reads.confidenceFloor`                 | 0.6                                                             | below it, cautious                                                                  |
| `reads.runLengthN`                      | `[0, 1.5, 4, 8, 15]`                                            | N by `step-run-length` level                                                        |
| `privacy.privateSources`                | `["channel:*"]`                                                 | any non-Tinker source (WhatsApp, mail, Teams, SMS)                                  |
| `privacy.privatePaths`                  | `[]`                                                            | folders whose content marks a task private                                          |
| `privacy.approvedProviders`             | `["claude-code"]`                                               | private content goes only here                                                      |
| `privacy.jevApprovedSources`            | `[]`                                                            | private sources Jev may read                                                        |
| `policy.table`                          | `{}`                                                            | vendor x topic: `allow` or `deny`                                                   |
| `orchestrate.allowedLeafProviders`      | `["claude-code"]`                                               | C2                                                                                  |
| `scheduler.providerCaps`                | `{"claude-code": 4, "xai": 4, "openai-codex": 4, "copilot": 2}` | concurrent calls per provider                                                       |
| `hedge.margin`                          | 1.5                                                             | multiple of the rung's p95 before a copy starts                                     |
| `learning.enabled` / `learning.explore` | false / false                                                   | nightly update; exploration on overnight jobs only                                  |
| `spend.capEurPerDay`                    | 2                                                               | Jev spend cap; the amygdala's spend tracker pattern                                 |

Environment kill switch: `OPENCLAW_THALAMUS_V4=off` makes `start()` return before opening anything. `dataDir`
defaults as in section 8.

## 12. Scheduler

`thalamus-graph.ts` (pure): `buildGraph(units)` adds an `input` edge for each declared input and a `same-write`
edge, in unit order, between units whose `writes` intersect, so two units that change the same thing never run
together (P§6.1). `criticalPath(graph, durations)` is the longest path; `slack` is latest start minus earliest
start. `ready(graph, done, running, caps)` returns units whose inputs are done, within `providerCaps` per provider.
`sharedStartGroups` collects siblings with the same `sharedStart.id`; `fanOutMode` compares one model with a warm
shared start (`w x S + (n-1) x r x S`) against each sibling on its own cheapest brief and returns the cheaper.
`hedgeDue(unit, elapsedSec, rungTime, margin)` is true for a critical-path unit only, at most once per unit and
for at most 20% of a plan's units.

The runtime in the plugin runs a plan: it asks `routeCall`-style pricing for each ready unit (fresh point, so no
switch penalty), starts them, listens for the unit's completion, starts the hedge copy on another supply when due,
keeps the first result and kills the other, and writes `units` rows. A planner unit for a `parts` request is itself
a routed call that returns `Unit[]`; a request read as `answer` or `chain` stays one unit (P§6.1, last sentence).

First consumer: `openclaw-orchestrate` scripts call `agent(task, {model: "auto", reads, writes})`. The resolver
injected into `orchestration-deps.ts` prices the unit under the guard of C2. `thalamus.plan.preview` and
`openclaw-orchestrate --dry-run` print the graph, the critical path and the pick per unit without spawning.

## 13. Learning

`thalamus-learning.ts`: `posterior = (kappa x prior + wins) / (kappa + n)` with `kappa` 10, so ten outcomes stay
near the map and a thousand follow their record (P§8). Prior is the strength percentile or AA height. A win is an
outcome of `done` with no retry inside the same step. The nightly job (`learning.enabled`) aggregates `outcomes`
into `estimates` and `rung_time`, writes a refusal record when a vendor refuses legitimate work in a class twice in
a month (reusing `REFUSAL_VETO_COUNT` and `REFUSAL_TTL_MS` from `thalamus-feasibility.ts`), and reports a diff to a
cron report per `CRON-REPORT-CONTRACT.md`. Exploration (`learning.explore`) takes an option the router would not
normally take, on jobs whose task read says `whenever` only, at most 5% of their calls. Nothing is trained. The
v2 registry problem (credit going to models that never ran) is avoided by joining on `outcomes.actual_model`, the
model the usage event reports, never on the pick.

## 13A. The enhancement short list (paper section 7)

**What this is for.** Jev already reads the task. The same call ranks the assistant's enhancements (skills, recipes,
plugins) for it, and the agent gets a short list in order, with probabilities, and decides. Thalamus then watches
which enhancement the agent actually opened and improves the text Jev reads, so the next ranking is slightly better.
**How it was derived.** the architect's decision 5 (2026-09-30 07:26) and P§7. Nothing in it forces, loads or runs an
enhancement (charter, line not to cross): the list is advice, and "none of these fits" is always an option.
**What would change it.** The measured replay metric of section 13A.6, an owner correction, or a change to the
registry shape below.

### 13A.1 What exists

| Paper concept                                                                     | Status | Where, or what is missing                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Names and files of skills, recipes, plugin tools                                  | partly | `getUsageRegistry()` (`src/fork/usage-attribution.ts:1127`) resolves a name, path, slug or tool to an enhancement. It **cannot list them** and holds **no description or triggers**. See challenge C4                                                              |
| Use observed from tool calls                                                      | exists | `attributeToolUsage` (same file, line 155) turns one tool call into `UsageMark[]` (`kind`, `name`, `path`, `via`). It is what draws the chat chips: `server-chat.ts:50` for live turns, `session-utils.fs.ts:696` for history                                      |
| A choice question with up to 255 options and a probability per option             | exists | Jev; `JevClient` returns `probs` (`jev.ts`, `toVerdict`)                                                                                                                                                                                                           |
| Cards, families, short-list builder, fit-kind read, use ledger, nightly card loop | absent | this section                                                                                                                                                                                                                                                       |
| Context seam to hand the agent the list                                           | partly | embedded runner: `before_prompt_build` returns `prependContext` (`hook-before-agent-start.types.ts:30`). Claude Code: a `UserPromptSubmit` hook can return `additionalContext`; our installed hook returns nothing today (`reference_amygdala_injection_seams.md`) |

### 13A.2 Types

In `src/shared/thalamus-enhancements.ts` (pure). `UsageKind` and `UsageMark` are v-existing; not copied.

```ts
export type EnhancementKind = "skill" | "recipe" | "plugin"; // = UsageKind
export type EnhancementCard = {
  id: string; // "<kind>:<name>", the option key Jev returns
  kind: EnhancementKind;
  name: string;
  path?: string;
  family: string;
  purpose: string; // what it was made for (seeded from description and triggers)
  structure: string; // how it works, without its subject (P§7.2)
  alsoServed: string[]; // kinds of task it served that its author never had in mind (learned)
  version: number;
  status: "active" | "retired";
  origin: "seed" | "nightly" | "owner";
};
export type CardVersion = {
  card: EnhancementCard;
  createdAt: number;
  parent?: number;
  replay?: { before: number; after: number; n: number };
}; // every version is kept
export type Family = { id: string; purpose: string; memberIds: string[] };
export type FitKind = "made-for" | "by-structure" | "covers-part";
export type ShortlistEntry = {
  cardId: string;
  rank: number;
  prob: number;
  fit?: Answered<FitKind>;
};
export type Shortlist = {
  entries: ShortlistEntry[];
  noneFitsProb: number;
  shown: boolean;
  reason: "shown" | "none-leads" | "empty" | "not-asked";
  source: "jev" | "local";
  together?: [string, string]; // top two cover parts: "fit together"
};
export type EnhancementUse = {
  taskId: string;
  ts: number;
  session: string;
  source: string;
  private: boolean;
  shuffled: boolean;
  shown: ShortlistEntry[];
  noneFitsProb: number;
  used: Array<{
    cardId: string;
    onList: boolean;
    rank?: number;
    via: UsageVia;
    how: "as-written" | "adapted" | "merged" | "unknown";
  }>;
  outcome: "done" | "retried" | "corrected";
  cardVersions: Record<string, number>;
  questionVersion: number;
};
```

### 13A.3 Storage (Thalamus store, section 8)

```sql
CREATE TABLE enh_cards(card_id TEXT, version INT, family TEXT, kind TEXT, name TEXT, path TEXT,
  purpose TEXT, structure TEXT, also_json TEXT, status TEXT, origin TEXT, parent INT, replay_json TEXT,
  created_at INT, PRIMARY KEY(card_id, version));               -- append-only: a version is never edited
CREATE TABLE enh_active(card_id TEXT PRIMARY KEY, version INT, since INT);
CREATE TABLE enh_families(family TEXT PRIMARY KEY, purpose TEXT);
CREATE TABLE enh_uses(task_id TEXT PRIMARY KEY, ts INT, session TEXT, source TEXT, private INT, shuffled INT,
  shown_json TEXT, none_fits REAL, used_json TEXT, outcome TEXT, card_versions_json TEXT, question_version INT);
CREATE TABLE enh_replay_set(task_id TEXT PRIMARY KEY REFERENCES enh_uses, text_redacted TEXT);
                                                                 -- only tasks from sources Jev is approved for
CREATE TABLE enh_pins(id TEXT PRIMARY KEY, task_id TEXT, card_id TEXT, by TEXT, created_at INT);
CREATE TABLE enh_calibration(bucket INT PRIMARY KEY, n INT, hits INT, mapped REAL, updated_at INT);
CREATE TABLE enh_rates(rank INT PRIMARY KEY, tasks INT, picked INT, pi REAL, updated_at INT);
CREATE TABLE enh_proposals(id TEXT PRIMARY KEY, kind TEXT, payload_json TEXT, status TEXT, created_at INT);
```

`enh_replay_set` holds task text, the one place this store keeps content, so it is filled only for sources
approved for Jev and only after `redact.ts`-style redaction; private tasks never enter it (P§7.4, last paragraph).
`enh_proposals.kind` is `merge`, `new` or `card-edit`; merge and new-enhancement proposals are **proposals only**,
never created by the loop.

### 13A.4 Questions (names, purposes, types; wording lives only in `questions/*.json`)

| Read | Question id       | Purpose                                          | Type   | Options                                                                                            |
| ---- | ----------------- | ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| task | `enh-family`      | which family of enhancements the task belongs to | choice | one option per family, plus `none`                                                                 |
| task | `enh-in-<family>` | within one family, which enhancement fits        | choice | one option per card of the family (card text is the option description), plus `none of these fits` |
| task | `enh-fit-<rank>`  | for one of the top three entries, how it fits    | choice | made-for, by-structure, covers-part                                                                |

The task read carries `enh-family` and one `enh-in-<family>` for **every** family, in the same call. The joint
probability of a card is `P(family) x P(card | family)`, and `noneFitsProb = P(none) + sum over families of P(family)
x P(none of these fits | family)`. A choice holds at most 255 options, so a family with more than 254 cards is split
into `<family>-p1`, `<family>-p2` and so on before asking, each part a family option of its own; if that still leaves
more than 254 families, the least-used are left to local matching. `enh-fit-<rank>` goes out for the top three
entries only, in parallel with the first model call (P§7.2), so it adds no waiting. The per-family questions are built
at run time from a template in `questions/enhancement.json` and the cards; their version is a hash of the option
set, so a changed card is a new version and an old version is never edited.

### 13A.5 Seeding, the short list, the seam and the use label

**Seeding.** The registry gains an **additive** `list()` (optional on the interface, implemented in
`createUsageRegistry`): every skill directory and recipe file it already walks, as `{kind, name, path}`. A reader in
the Thalamus extension adds `description` (skill frontmatter), `title` and `triggers` (recipe frontmatter), and for
plugins the manifest description of each tool owner. `seedCards(listing, familyRules)` (pure) makes one card each:
`purpose` = description plus triggers, `structure` empty until the nightly writer proposes one (or the owner writes
it), `family` from a keyword rule table with `other` as the default. The seed is versioned data: version 1.

**Short-list builder (P§7.1).** Options sorted by joint probability, `none of these fits` included. If it leads, the
list is not shown (`none-leads`). Otherwise take the shortest prefix whose cumulative probability reaches 0.8 of the
mass, never more than six entries, and cut it where `none of these fits` appears. The probabilities shown are passed
through the calibration map (`enh_calibration`) so "0.6" keeps its meaning while cards change. If the top two entries
both come back `covers-part`, the list says they fit together.

**Seam per runtime (Phase D builds it; nothing here installs a hook).** Embedded runner: the plugin's
`before_prompt_build` returns `prependContext` with the list. Claude Code: the `UserPromptSubmit` hook returns
`additionalContext`; it is refreshed when the plan changes and when a unit starts. Private sources get the list from
local word matching against the cards (`localRank`, pure), never from Jev.

**Use label (P§7.3).** `attributeToolUsage` on every tool call of the task, never the model's prose and never a
second detector. Embedded: the plugin's `after_tool_call`. Claude Code: the `PostToolUse` payload (`tool_name`,
`tool_input`). A mark is `onList` when its card is in the shown list, with its rank. `how` starts as `unknown`: the
tool calls show that an enhancement was opened, not whether it was adapted, so the nightly job fills `how` with a
`noul` read on the transcript for sources approved for Jev. That is an open point, listed in the status file.

### 13A.6 The nightly card loop and the replay metric (Phase F builds it)

1. **Misses** from `enh_uses`: tasks whose used enhancement ranked low or was off the list, and confident lists whose
   top entry went unused. A task that ended `retried` yields no evidence that the pick fitted (P§7.3).
2. **Weights.** A pick at rank `r` counts `1 / pi(r)`, `pi(r)` the share of tasks in which the agent takes rank `r`,
   measured on the shuffled lists (`enh_rates`, overnight jobs only). Before any shuffle exists `pi` is the prior
   `[0.7, 0.15, 0.08, 0.05, 0.02, 0.02]` and is marked as a prior in the report.
3. **Proposals.** For each group of similar misses a writer model (a routed call; mocked in tests) proposes one small
   edit: a line for `alsoServed`, a sharper `structure`, or a narrower `purpose`.
4. **Replay.** Jev reads the held-out replay set with the old cards and with the new ones. The metric is the
   weighted mean reciprocal rank, `sum w_i / rank_i / sum w_i` with `w_i = 1 / pi(rank of the used enhancement at
time i)`. An edit is kept only if the metric rises and **every pinned case keeps its rank or improves**.
5. **Versions.** Kept edits are appended as `enh_cards` versions; one step back is always a pointer change in
   `enh_active`. The calibration map is refit from `enh_uses` in the same run.
6. **Proposals to people.** The same ordered pair used together for one kind of task three times, or a kind of task
   done three times by hand, becomes a row in `enh_proposals` for the owner or the recipe author. Never created.

### 13A.7 Tests (Jev mocked; no test needs the key)

| Module                  | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thalamus-enhancements` | seeding gives version 1 and the right family; joint probability and `noneFitsProb` sum to 1 within 1e-9; the 0.8 prefix, the cap of six, `none` leading (not shown), `none` in the middle (cut there); a registry of 300 enhancements across 6 families builds legal questions (<= 255 options each); a family of 600 splits into three; more than 254 families spill to local matching; calibration map is monotone; local word matching ranks the obvious card first |
| enhancement reader      | one mocked call carries the task read and every family's question; Jev down and low confidence give `not-asked` and the cautious read; `skipped` verdicts never produce a list; the fit reads go out only for the top three; **a private source makes no Jev call at all** (asserted on the mock's call count)                                                                                                                                                         |
| registry `list()`       | lists what `skillDirByName` resolves; absent on registries built without it                                                                                                                                                                                                                                                                                                                                                                                            |
| replay (Phase F)        | a pinned case can never lose rank; a first-place-only history does not move the cards                                                                                                                                                                                                                                                                                                                                                                                  |

### 13A.8 Challenges found while amending

**C4. The registry does not list enhancements.** The charter and the paper say cards are seeded from what
`getUsageRegistry()` "already lists (name, description, triggers)". It lists nothing: it answers lookups, and it reads
a recipe's `title` and `slug` only when asked. So the seed needs the additive `list()` above plus the frontmatter
reader in the extension. Evidence: the `UsageRegistry` interface, `usage-attribution.ts:70-96`.

**C5. The Jev client cannot move as bytes alone.** `jev.ts` and `cache.ts` import four amygdala types (`Question`,
`Situation`, `SituationFieldName`, `Verdict`), and core cannot import from an extension. The move therefore adds
`src/infra/jev/types.ts` with structural types for exactly the fields the client reads, makes `JevClient` generic
over them, and casts one indexed access in `fieldValues`. Logic lines are unchanged; the diff shows type lines
only. The amygdala's shim for `jev.ts` is three lines, not one: a subclass that pins the generics to its own
`Situation` and `Question`, so its own tests keep inferring the types they always did. Built, and gated by the
amygdala suite: 52 files and 858 tests before the move, the same after.

**C6. The amygdala's `FamilyId` is a key of four `Record<FamilyId, ...>` maps.** A `routing` family would have
touched its config, factories, order, status and learning code. The built seam is smaller and isolates better: an
optional `companion` on `decide()` (`extensions/tinkerclaw-amygdala/src/companion.ts`, one hunk in `decide.ts`,
one line in `runtime.ts`). The companion's questions are appended to the call the amygdala is already making, only
when it is making one, and their verdicts are split off before any family, the store or the learning loop sees
them. The provider that supplies the questions is registered through `openclaw/plugin-sdk/fork-thalamus`
(`setRoutingReadProvider`); with none registered the seam does nothing. Routing verdicts therefore live in
Thalamus's own store only (C1), joined by `situation_id`.

**C7. Question ids are kebab-case only.** The amygdala's book requires it, and whether Jev accepts other characters
as keys is unverified. Fit questions are `enh-fit-<rank>`, pending-item questions `step-parallel-ok-<n>`, and a
split family is `<family>-p<k>`; each is mapped back by position.

## 14. Test plan

Runner: `node scripts/run-vitest.mjs <paths>` from the worktree. Jev is mocked everywhere; no test needs the key.

| Module                             | Tests                                                                                                                                                                                                  | Mocked                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `thalamus-price-table`             | every row dated; cache multipliers equal the paper's; no row with input 0 for a metered supply                                                                                                         | none                       |
| `thalamus-cache-ledger`            | reducer: write then read warms; expiry at TTL; a different model starts cold; automatic-cache vendors show no write cost; `predictCall` against 20 recorded call sequences (P§10 test 3, offline half) | clock                      |
| `thalamus-switch`                  | N\* = 2.875, 4.75, 7.67, 7.67 for the four cases in P§5.1; `k r_b <= r_s` never pays; single step pays only for `k r_b > 1`; digest rule against the P§5.2 inequality on a grid                        | none                       |
| `thalamus-options`, `-price`       | enumeration count; cached input cheaper than uncached; λ zero makes slack-rich options cheaper; pace raises a scarce supply; cautious default never cheaper than the read it replaced                  | supplies                   |
| `thalamus-vetoes`                  | private source blocks unapproved providers before any other check; policy table; capacity with headroom; a spent quota window; v2 vetoes unchanged (v2 suites still pass)                              | catalog                    |
| `thalamus-reads`                   | local reader parity with v2 classifiers on v2's own fixtures; floor and `skipped` give the cautious read; `stuck` from `repeatedErrors`                                                                | none                       |
| `thalamus-route-call`              | hand-picked model kept; reserved set only by a named reason; fresh point switches freely; mid-thread holds below N\*; stuck escalates; cold cache releases; result stable under permutation of options | none                       |
| `thalamus-graph`                   | conflict edge from intersecting writes; critical path on hand-made DAGs; slack sums; provider caps respected; shared-start choice flips at the computed threshold; hedge once, critical only           | none                       |
| `thalamus-learning`                | shrink at n = 0, 10, 1000; diff report; refusal record after two in a month; exploration only on `whenever`                                                                                            | clock                      |
| plugin store, feeds                | schema creation and migration; call-bus events fill the ledger; outcomes join decisions on `actual_model`; prune                                                                                       | sqlite in memory, fake bus |
| Jev family                         | one `ask` carries both families' questions; amygdala verdicts unchanged; budget not extended; Jev down, breaker open, low confidence, `not-allowed` each give the cautious read                        | `JevTransport`             |
| inert-when-off (one per core edit) | `wrapStreamFnWithCallRouter` returns the same function with nothing registered; orchestrate `"auto"` path untouched with no resolver; worker args identical with no provider; amygdala suite green     | none                       |
| shadow                             | a full embedded run with a fake stream: decisions written, `applied` 0, model handed to the stream unchanged, latency added under 2 ms                                                                 | stream                     |
| RPC and events                     | each method's payload against its schema; events match the catalog                                                                                                                                     | gateway                    |
| scheduler runtime                  | a synthetic contract task (P§9) as a graph: twelve readers, a shared start, one slow reader hedged, combine, check; provider caps hold                                                                 | fake spawner               |
| UI                                 | `routing-rationale` renders no block without call decisions; one line per decision; expandable; Playwright against a mock gateway (phase G)                                                            | gateway                    |

Offline P§10 results phase F can produce: test 3 (ledger prediction against recorded counts, on the LLM ledger's
embedded rows and on Claude Code transcripts), test 4 on synthetic long results, test 7 (router compute time and
Jev latency with the mock). Tests 1, 2, 5, 6 need live labels, live traffic or a week of quota data; phase F states
that plainly. Test 1 is the only one phase H can approach, on synthetic cases under the €2 cap.

## 15. Phases B to H as ORCA units

Each unit lists the files it writes; units with no dependency run in parallel with `commit:false`, and the worker
commits per unit by pathspec (`feat(thalamus): ...`). Tests sit beside each file.

| Unit              | Files (writes)                                                                                                                                              | Depends on |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **B1**            | `src/shared/thalamus-v4-types.ts`                                                                                                                           |            |
| **B2**            | `src/shared/thalamus-price-table.ts` (+test)                                                                                                                |            |
| **B3**            | `src/shared/thalamus-cache-ledger.ts` (+test)                                                                                                               | B1         |
| **B4**            | `src/shared/thalamus-switch.ts` (+test)                                                                                                                     | B1         |
| **B5**            | `src/shared/thalamus-vetoes.ts` (+test)                                                                                                                     | B1         |
| **B6**            | `src/shared/thalamus-options.ts`, `thalamus-price.ts` (+tests)                                                                                              | B1, B2, B3 |
| **B7**            | `src/shared/thalamus-route-call.ts` (+test)                                                                                                                 | B4, B5, B6 |
| **C1**            | `src/infra/jev/*`, `src/plugin-sdk/fork-jev.ts`, re-export shims in the amygdala                                                                            |            |
| **C2**            | `src/shared/thalamus-reads.ts` (+test)                                                                                                                      | B1         |
| **C3**            | amygdala `types.ts`, `question-book.ts`, `runtime.ts` (additive), `extensions/tinkerclaw-thalamus/questions/*.json`, `src/reads/routing-family.ts` (+tests) | C1, C2     |
| **C4**            | `extensions/tinkerclaw-thalamus/src/reads/standalone.ts` (+test), synthetic cases                                                                           | C1, C2     |
| **D0**            | `extensions/tinkerclaw-thalamus/{index.ts, openclaw.plugin.json, package.json, src/config.ts, src/runtime.ts}`, `src/plugin-sdk/fork-thalamus.ts`           | B1         |
| **D1**            | `src/store.ts`, `src/cache-feed.ts` (bus to ledger), `src/rung-time.ts` (+tests)                                                                            | D0, B3     |
| **D2**            | `src/agents/embedded-agent-runner/call-router.ts`, one line in `attempt.ts`, `src/shadow.ts` (+tests)                                                       | D0, B7     |
| **D3**            | `src/digest.ts`, embedded async digest step, `hooks/post-tool-digest.mjs`, raw store and recall (+tests)                                                    | D1, B4     |
| **D4**            | `src/check.ts`, `src/finish.ts`, `src/stuck.ts`, ladder by reason wiring (+tests)                                                                           | D2         |
| **D5**            | bridge `worker.ts` optional `--agents` and env provider, per-turn model from the plugin, sub-agent call counting (+tests)                                   | D0         |
| **D6** (optional) | loopback proxy, off, only on the architect's order                                                                                                                  | D5         |
| **E1**            | `src/shared/thalamus-graph.ts` (+test)                                                                                                                      | B1, B6     |
| **E2**            | `src/scheduler.ts`, hedge runtime (+tests)                                                                                                                  | E1, D1     |
| **E3**            | prefrontal `orchestration-deps.ts` resolver hook, `openclaw-orchestrate.mjs --dry-run`, `thalamus.plan.preview` (+tests)                                    | E2         |
| **E4**            | synthetic contract task test (P§9)                                                                                                                          | E3         |
| **F1**            | `src/shared/thalamus-learning.ts`, `src/learning-job.ts` (+tests)                                                                                           | D1         |
| **F2**            | refusal ledger writer, `rung_time` updater (+tests)                                                                                                         | F1         |
| **F3**            | replay harness over a read-only copy of the LLM ledger and Claude Code transcripts; offline P§10 tests 3, 4, 7                                              | F1, B3     |
| **G1**            | `tinker-ui/src/panels/routing-rationale.ts` call block, `thalamus.feed` consumer (+tests)                                                                   | D1         |
| **G2**            | mock gateway, Playwright run, screenshots                                                                                                                   | G1         |
| **H1**            | merge develop; all touched suites; `scripts/deploy-worktree.sh --sha <tip> --dry-run`; start once ON from a `--keep-worktree` dist                          | all        |
| **H2**            | live Jev on synthetic cases, €2 cap written in its turn file                                                                                                | H1         |

Critical path: B1, B3, B6, B7, D2. C and D0 run beside B. E and F need D1. G needs D1 and can start once the
`thalamus.feed` payload of section 9 is fixed.

## 16. Choices made, and decisions for the architect

### Made in this document (the paper and charter left them open)

1. Two files, one logical ledger (C1). 2. Shared Jev client moved to core with shims (C3). 3. Orchestrate leaf guard
   kept, widened only by a list (C2). 4. Per-call seam is a `streamFn` wrapper in core, inert when unregistered.
2. The Claude Code lane switches at turn, unit and tool-result level; no proxy in this build (3.2).
3. Thalamus is a routing family of the amygdala's runtime, not a second client, and reads locally on real traffic.
4. `stuck` from `repeatedErrors`, not from Jev. 8. Confidence floor 0.6. 9. λ table and depth relief as in 11.1.
5. `kappa` 10 for the posterior. 11. Store keeps no bodies and prunes decisions at 90 days. 12. Research-bus rows
   carry no model keys. 13. Raw tool results kept as 0600 files, recalled by a plain file read.

### For the architect (safe default taken; nothing waits on him)

| #   | Decision                                                                                             | Default taken                           |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| O1  | Let Jev read real situations (`sendRealSituations`)? Until yes, live shadow data is local reads only | no                                      |
| O2  | Plan price: what fraction of list price should each subscription count as?                           | 1.0, list price                         |
| O3  | Widen the orchestrate leaf guard to xai, openai-codex or copilot                                     | claude-code only                        |
| O4  | Which sources are private, and which providers may see private content                               | non-Tinker channels; `claude-code` only |
| O5  | The vendor x topic policy table                                                                      | empty (learned refusals only)           |
| O6  | Feed v4's refusal ledger to v2's live `thalamusPlan` call, which makes its refusal veto live         | not done                                |
| O7  | The proxy (D6 unit) for in-turn model change on the Claude Code lane                                 | not built                               |
| O8  | Turning shadow, then enforcement, on; each `enforce.*` flag separately                               | off                                     |
| O9  | The λ and relief values (11.1), tuned later by P§10 test 2                                           | starting guesses                        |
| O10 | Whether Claude Code workers get `--agents` sub-agents on cheaper models by default                   | off; orchestrate only                   |

Changed 2026-09-30: created (Phase A).
