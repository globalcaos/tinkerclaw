---
file: auth-routing.md
purpose: Which model gets picked, in what order, when does fallback fire, when is billing gated
audience: AI
last_verified: 2026-06-10
last_verified_commit: HEAD
single_owner: yes — model routing + auth profile order + billing logic live here
see_also: config-shape.md (where these keys are read), failures.md (M1 idle watchdog, billing failures)
verify:
  - name: anthropic auth order is cli-gm only (subscription, not metered api)
    cmd: python3 -c 'import json,os; cfg = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); assert cfg["auth"]["order"]["anthropic"] == ["anthropic:cli-gm"]'
  - name: primary model is a flat-rate subscription model (cli-gm / claude-code), never a metered api model
    cmd: python3 -c 'import json,os; cfg=json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); p=cfg["agents"]["defaults"]["model"]["primary"]; assert p.startswith("claude-code/"), f"primary {p} is metered, not the flat-rate subscription"'
  - name: primary model is the best-ranked subscription model EXCLUDING fable (fable = escalation tier, never the default primary — the architect 2026-07-21)
    cmd: python3 -c 'import json,os; cfg=json.load(open(os.path.expanduser("~/.openclaw/openclaw.json"))); d=cfg["agents"]["defaults"]; p=d["model"]["primary"]; subs={k:v["rank"] for k,v in d["models"].items() if k.startswith("claude-code/") and "fable" not in k and isinstance(v,dict) and "rank" in v}; best=min(subs,key=subs.get); assert p==best, f"primary {p} != best-ranked non-fable subscription model {best} @ rank {subs[best]}"'
  - name: every model CHOICE site (spawn guidance, bridge aliases, prefrontal defaults + kits, round-table roles, cron fallbacks, live primary + prefrontal routes) names the best-ranked claude-code model of its line
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && node scripts/bible/auth-routing-model-choices.mjs
  - name: THALAMUS owns every formerly fixed model choice when it is working — spawn, leaf default and round-table ask the leaf resolver by site, the worker says who picks, and the flag ships off
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && python3 -c 'import json; r=open("src/infra/thalamus-call-router.ts").read(); assert "export function pickOwnedModel" in r and "owns?(site" in r, "leaf resolver lost owns/pickOwnedModel"; assert "pickOwnedModel(\"subagent\"" in open("src/agents/subagent-spawn-plan.ts").read(), "a spawn with no model no longer asks Thalamus"; assert "\"orchestrate-default\"" in open("extensions/tinkerclaw-prefrontal/orchestration-deps.ts").read(), "a leaf with no model no longer asks Thalamus"; assert "thalamusRoleModel(" in open("extensions/tinkerclaw-round-table/index.ts").read(), "the debate no longer asks Thalamus"; w=open("extensions/tinkerclaw-tinker-bridge/src/worker.ts").read(); assert "subagentModelOwnerText()" in w and "leafModelOwnerText()" in w, "the worker no longer says who picks"; assert "leafActsFor" in open("extensions/tinkerclaw-thalamus/src/leaf-resolver.ts").read(); m=json.load(open("extensions/tinkerclaw-thalamus/openclaw.plugin.json")); assert m["configSchema"]["properties"]["enforce"]["properties"]["ownModelChoices"]["default"] is False, "ownModelChoices must ship off"'
  - name: all four thinking-level resolution sites clamp via resolveSupportedThinkingLevel (none rejects an over-ceiling level)
    cmd: python3 -c 'import os; r=os.path.expanduser("~/src/tinkerclaw/src"); sites=["auto-reply/reply/get-reply-run.ts","auto-reply/reply/directive-handling.impl.ts","gateway/sessions-patch.ts","agents/agent-command.ts"]; [exec("t=open(os.path.join(r,s)).read(); assert \"resolveSupportedThinkingLevel\" in t, s+\": resolveSupportedThinkingLevel call missing — over-ceiling thinking level may hard-reject again\"") for s in sites]; sp=open(os.path.join(r,"gateway/sessions-patch.ts")).read(); assert "next.thinkingLevel = resolveSupportedThinkingLevel" in sp, "sessions-patch.ts no longer clamps the persisted thinkingLevel"'
  - name: THALAMUS v4 — the per-call router, its price table, N* and the Jev client each live in one file; the plugin ships disabled
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && python3 -c 'import json; r=open("src/shared/thalamus-route-call.ts").read(); sw=open("src/shared/thalamus-switch.ts").read(); pt=open("src/shared/thalamus-price-table.ts").read(); assert "export function routeCall" in r, "routeCall moved (bible auth-routing THALAMUS v4)"; assert "breakEvenN" in sw, "N* is no longer in thalamus-switch.ts"; assert "readOn" in pt, "price rows lost their read date"; open("src/infra/jev/jev.ts").read(); m=json.load(open("extensions/tinkerclaw-thalamus/openclaw.plugin.json")); assert m.get("enabledByDefault") is False, "tinkerclaw-thalamus must ship off"'
---

# Auth + model routing

## Model rank table

Source of truth: `agents.defaults.models[<provider/model>].rank` (ordinal routing/UI order) plus `.intelligenceIndex` (raw Artificial Analysis score) in `openclaw.json`. Both are updated by the `model-rank-refresh` cron at 06:30 daily from the Artificial Analysis Intelligence Index leaderboard.

**The primary is DERIVED, not frozen (design-principles.md #19).** `agents.defaults.model.primary` is the **best-ranked _subscription_ (cli-gm / `claude-code/*`) model** — never a metered model, however highly the leaderboard ranks it. The rank numbers churn daily; the routing rule does not. The frontmatter `verify:` enforces the derived rule (primary is a `claude-code/*` model AND equals the lowest-rank `claude-code/*` entry), so it survives a new model landing at the top instead of re-breaking on every cron run. The table below is a dated snapshot, illustrative only.

**Primary decision (the architect 2026-07-21, SUPERSEDES the 2026-06-23 fable-demotion note): primary = Opus; Fable is excluded from the primary derivation even though it is AVAILABLE again (since 2026-07-02) and ranks #1 on the AA index (2026-07-21 rank refresh set fable rank 1, opus-4-8 rank 3).** Fable is the ESCALATION tier — reserved for stuck/frontier work per the model×effort ladder — never the everyday default. The `verify:` above derives "best-ranked `claude-code/*` model excluding fable" (= opus-5-5 since 2026-10-03; Opus 5 shipped 2026-07-24 and replaced Opus 4.8, then Opus 5.5 took rank 1 at $4/$20 against Opus 5's $5/$25 and the architect moved the primary: "opus 5.5 is smarter and cheaper") and reads `~/.openclaw/openclaw.json` live, so daily rank churn keeps it honest without freezing a model name. Historical context: on 2026-06-23 fable was export-controlled/unavailable and hand-demoted to rank 25 to make the derivation pass; that workaround died with the 2026-07-21 rank refresh (fable back to rank 1), which surfaced as a gate failure — and separately, a Gemini-oauth exploration session (≤2026-07-21 morning) had silently flipped primary to `google/gemini-3.1-pro-preview`, which the architect reverted the same day ("Primary must be opus, I never asked you to change it"). Sessions must NEVER change `model.primary` as a side effect of provider experiments.

**Model choices follow the rank table (2026-10-03).** The primary is one choice among many. Subagents spawned without a model inherit it (`resolveSubagentSpawnModelSelection`, `src/agents/model-selection.ts`), and the rest are written into files: the spawn guidance in `subagent-helper.md` and `orchestration-disposition.md`, the bridge's `opus`/`sonnet` aliases (`defaults.ts MODEL_ALIASES`), prefrontal's planner, summary and effort routes (`prefrontal-types.ts`, plus the live `plugins.entries.tinkerclaw-prefrontal.config`), the workflow leaf default (`orchestration-deps.ts DEFAULT_LEAF_MODEL`), every kit's and recipe's `model.name`, the round-table roles, and the bundled cron fallbacks. Each must name the best-ranked `claude-code/*` model of its line: opus, sonnet, fable, haiku. The failure this stops was measured on 2026-10-03. Opus 5.5 had held rank 1 since at least 2026-10-02, cheaper than Opus 5, while the primary, the `maximum` route, the guidance table and the `opus` alias still said Opus 5, and 22 kits said Opus 4.7. Sonnet 4.6 (rank 41, $3/$15) was still the `standard` route and the leaf default, with Sonnet 5.5 at rank 2 and $2/$10. The guidance also named `claude-fable-5`, which the provider no longer serves. `scripts/bible/auth-routing-model-choices.mjs` (verify above) reads the live ranks and names every site that falls behind. When a new model of a line takes the top rank, it goes red and lists each file to change. Catalogs, price tables, benchmark anchors and history keep their older ids and are not scanned. When Thalamus owns these choices (§ THALAMUS v4, "Owned model choices"), the named models are its fallbacks, so they still have to be the best of their line.

Historical snapshot (2026-06-10; row 1 is superseded, the live primary is derived as above):

| Rank | Model                           | Alias        | Tier                  | Notes                                           |
| ---- | ------------------------------- | ------------ | --------------------- | ----------------------------------------------- |
| 1    | claude-code/claude-opus-5       | —            | subscription (cli-gm) | **PRIMARY** for agents.defaults.model           |
| 2    | claude-code/claude-opus-4-8     | —            | subscription (cli-gm) | prior primary (kept available)                  |
| 2    | openai/gpt-5.5                  | —            | metered               | top leaderboard rank, but metered → not primary |
| 3    | claude-code/claude-opus-4-7     | —            | subscription (cli-gm) | prior primary                                   |
| 4    | google/gemini-3.1-pro-preview   | gemini       | metered               |                                                 |
| 5    | google/gemini-3.5-flash-preview | —            | metered               |                                                 |
| 6    | openai/gpt-5.3-codex            | —            | metered               |                                                 |
| 7    | claude-code/claude-sonnet-4-6   | sonnet       | subscription (cli-gm) |                                                 |
| 8    | openai/gpt-5.4-mini             | —            | metered               |                                                 |
| 9    | openai/gpt-5.4-nano             | —            | metered               |                                                 |
| 10   | claude-code/claude-haiku-4-5    | haiku        | subscription (cli-gm) |                                                 |
| 11   | openai/o3                       | —            | metered               |                                                 |
| 12   | openai/gpt-5.4                  | gpt54        | metered               |                                                 |
| 13   | google/gemini-3-flash-preview   | gemini-flash | metered               |                                                 |
| 14   | google/gemini-3-pro-preview     | —            | metered               |                                                 |
| 15   | openai/gpt-5.4-pro              | —            | metered               |                                                 |
| 16   | openai/gpt-5.2-pro              | gpt          | metered               |                                                 |
| 17   | google/gemini-2.5-pro           | —            | metered               |                                                 |
| 18   | openai/gpt-5.2                  | —            | metered               |                                                 |
| 19   | openai/gpt-5.1                  | —            | metered               |                                                 |
| 20   | openai/gpt-4.1                  | —            | metered               |                                                 |
| 21   | openai/gpt-4o                   | —            | metered               |                                                 |
| 22   | google/gemini-2.5-flash         | —            | metered               |                                                 |
| 23   | google/gemini-2.0-flash         | —            | metered               |                                                 |

## Provider routing

### claude-code (Anthropic subscription via claude-cli)

- **Driver:** `tinkerclaw-tinker-bridge` plugin → claude-cli subprocess.
- **Auth profile:** `anthropic:cli-gm` (OAuth, `~/.claude/.credentials-gm.json`).
- **Order:** `[cli-gm]` only. The metered `anthropic:api` profile is DISABLED in `auth.order.anthropic`.
- **Tier:** subscription (max_20x at $200/month per `env.ANTHROPIC_SUBSCRIPTION_TIER`).
- **Timeout:** 600s (via plugin overlay, see config-shape.md).
- **Tool execution:** internal to claude-cli (see tool-loop.md).

### openai

- **Driver:** upstream openai provider.
- **Auth profile:** `openai:default` (API key from `env.OPENAI_API_KEY`).
- **Order:** `[default]`.
- **Tier:** metered.

### google

- **Driver:** upstream google provider.
- **Auth profile:** `google:default` (API key from `env.GOOGLE_API_KEY` if set, else gateway resolves).
- **Order:** `[default]`.
- **Tier:** metered.

### ollama (local)

- **Driver:** upstream ollama provider.
- **Auth profile:** `ollama:default` (`apiKey: "ollama-local"`).
- **Base URL:** `http://127.0.0.1:11434`.
- **Tier:** free / local. Currently used only for `mxbai-embed-large` (memorySearch embeddings), not for chat.

## Thinking-level clamp — unsupported levels clamp, never reject (cross-model, FORK 2026-06-24)

Each model exposes a thinking profile (the ordered set of levels it admits, ranked by `THINKING_LEVEL_RANKS` in `thinking.shared.ts`). The effort slider's top stop is **Max**, but not every model admits `max` — e.g. `openai/gpt-5.5` tops out at `xhigh`. When the requested level exceeds a model's ceiling, the resolver **clamps DOWN to that model's highest supported level and proceeds** — it never hard-errors the turn.

The canonical resolver is `resolveSupportedThinkingLevel({ provider, model, level, catalog })` (`src/auto-reply/thinking.ts`): if the level is in the profile it passes through, otherwise it returns the highest profile level whose rank `<=` the requested rank (falling back to the highest non-`off` level, then `off`). This is the single source of truth for "what level does this model actually get."

There are FOUR resolution sites where a requested level meets a model that may not support it; ALL FOUR clamp via `resolveSupportedThinkingLevel` (none rejects):

| Path                            | Site                                 | Surfaces the clamp via                                                                              |
| ------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| chat.send / Tinker              | `get-reply-run.ts` (~:630)           | `logVerbose` info note (no ack channel on this path)                                                |
| `/think` directive              | `directive-handling.impl.ts` (~:318) | ack note, guarded on `requested !== applied`                                                        |
| persisted `thinkingLevel` patch | `sessions-patch.ts` (~:512)          | silent clamp — the patch always succeeds (previously a `"thinkingLevel" in patch → invalid` REJECT) |
| CLI `agent`                     | `agent-command.ts` (~:862)           | stderr note                                                                                         |

**Why the slider could trigger a reject:** the slider's Max injects an **EXPLICIT** `/think max` directive (`chat-command-body.ts`), so the resolver classified it as explicit and (pre-fix) took a reject branch instead of the clamp that already existed for the non-explicit case. The fix unified all four sites to clamp regardless of explicit-vs-derived. The slider's Max is a **ceiling request**, not a contract the model must honor exactly. Models that DO support `max` (`claude-code/*`) are unaffected. This is the cross-model analogue of the 2026-06-19 `claude-code` thinking-profile gate (which rejected a level the model DID support because its profile was missing — opposite cause, same "reject instead of admit/clamp" symptom). See bug-log.md `### FIXED [think-clamp+detection-pattern]` (2026-06-24).

The "all four sites clamp via `resolveSupportedThinkingLevel`, none rejects" contract is enforced by this file's frontmatter `verify:` block (asserts each of the four source files calls the resolver and that `sessions-patch.ts` still clamps the persisted level).

## Failover and cost-aware routing

The fork patched the upstream failover bug 2026-02-19 (bible §11.x):

- **Removed early `throw` for unclassified errors** in `model-fallback.ts` (was line 355-357). This unblocks the failover chain when the error doesn't match a known category.
- **Order:** OAuth (subscription) FIRST, then API (pay-per-use). Exhaust flat-rate before metering.
- **Primary switched opus-4-6 → sonnet-4-6 → opus-4-7 → opus-4-8** (today's primary, 2026-06-10 — opus-4-8 entered the leaderboard at rank 1 and is a subscription model, so the derived rule promoted it automatically).

### Billing gate (2026-03-20, DEPLOYED)

Cost-aware routing in `model-fallback.ts` blocks metered models (GPT, o3, gemini-metered) when:

1. **Flat-rate primary has headroom** (`<70%` of seven-day quota burned), OR
2. **Provider spend exceeds per-model `monthlyCapUsd`** (configured per model).

Rationale: keep AI work on the flat-rate subscription as long as it can handle the load. Only spill to metered when the subscription is exhausted, and only up to a hard $/month cap per metered model.

Configured in `agents.defaults.models[<id>].billing` + `.monthlyCapUsd`. Knowledge: `~/.openclaw/workspace/memory/knowledge/cost-aware-model-routing.md`.

### Failover-bug history

- 2026-02-19 — patched the `throw` removing the failover ceiling.
- 2026-02-19 — primary switched to sonnet-4-6 (same quality, 1/5 cost) and later to opus-4-7.
- 2026-03-20 — billing gate deployed.
- **CRITICAL after patching:** clear `usageStats` in `~/.openclaw/agents/main/agent/auth-profiles.json` + gateway restart, OR the old billing state will keep the gate closed even after a fix.

### Rate-limit header capture (2026-04-03)

Anthropic returns rate-limit headers; the fork captures these and uses them to project the seven-day-spent percentage for the billing gate. See bible §11.x.

## THALAMUS v2 — the supply axis (2026-09-04) — OWNED BY `tinker-ui.md` §5.8U

**Single owner:** the routing mechanism, its don't-regress list and its executable `verify:`
block live in `tinker-ui.md` §5.8U, beside §5.8T which already owns the frontier the dial walks.
This file records only the part it has owned since 2026-07-21, because v2 changed that part's
STATUS rather than its content:

**The Opus anchor is not a new policy — it is this file's policy finally reaching the router.**
Above, under "Model rank table", this file has asserted since 2026-07-21 that
_primary = Opus; Fable is the ESCALATION tier, reserved for stuck/frontier work, never the
everyday default_, and a `verify:` block has derived the primary as "best-ranked `claude-code/*`
excluding fable" ever since. The ROUTER did not honour it: `THALAMUS_BIAS_GAP` measured every dial
stop as a gap **below the board's best rung**, and the board's best rung is Fable — so "balanced"
was defined relative to the one model this file excludes, and resolved to whatever was cheapest
above that floor. As of 2026-09-04 the dial is anchored on `claude-code/claude-opus-5` and Fable is
a reserved set opened only by three named reasons. **The bible was right and the code disagreed
with it for six weeks** — which is the argument for `verify:` blocks that read the SOURCE, not only
the config: this one read `openclaw.json` and passed throughout.

The recovery ladder also supersedes a gap in "Failover and cost-aware routing" above: that section
describes the failover ORDER (OAuth before metered) and the billing gate, and both were correct —
but `agents.defaults.model.fallbacks` was `[]`, so the ladder those rules order had one rung. See
`bug-log.md`, tag `mechanism-starved`.

## THALAMUS v4 — the per-call router (2026-10-01) — OWNED BY THIS FILE

**Status:** `IMPLEMENTED` and **RUNNING IN `enforce`** since 2026-10-02 16:14 (develop `63ea3f58522`), on the architect's "turn on Thalamus … fully deploy". The plugin manifest still ships `enabledByDefault: false` and `mode: off`; what is live is the operator's own config (`plugins.entries.tinkerclaw-thalamus.config`), applied from a staged patch at the gateway's start: `mode: enforce`, `enforce.orchestrateAuto` and `enforce.shortlist` ON, `perCall` / `midThread` / `digest` / `check` / `finish` / `hedge` OFF. **`enforce.perCall` stays off and unbuilt** — the per-call swap is its own phase and the architect's call. v2's `thalamusPlan` (§5.8U in `tinker-ui.md`) stays the **task-level** decision; v4 adds the **call-level** one beneath it, and since the full deploy both read the SAME suggestion and cooling store (`thalamusSuggestionFor` is the one reader) — see `tinker-ui.md` §5.8AE. Design: `docs/plans/2026-09-30-thalamus-v4-design.md`; paper J19 v4.1.

**WANT (the architect, 2026-09-30):** "mix models within a same turn … at the lowest level possible"; the best Thalamus the paper describes, not a shrunk one; Jev ranks the enhancements (skills, recipes, plugins) and Thalamus learns from which one the agent uses.

**RUN.** Pure logic in `src/shared/thalamus-*.ts`, runtime in the plugin `extensions/tinkerclaw-thalamus`. One loop, two levels.

- `thalamus-route-call.ts` `routeCall` picks per call from options = rung × feed, after vetoes, priced as `money × pace + λ·t_crit + p_fail·c_rec`. Money is cache-aware, from `thalamus-cache-ledger.ts`, which is built from recorded cached and uncached token counts and never guessed. `thalamus-price-table.ts` holds list prices, each row with a source URL and the date it was read; a null means unknown, not free.
- `thalamus-switch.ts` holds N* (`breakEvenN`: about 2.9, 4.8, 7.7 for the paper's cases) and the digest rule. A mid-thread switch happens only through N*, a stuck step or a cold cache; fresh points (a unit, a sub-agent, a long tool result, a check, the closing writer) cost nothing to switch.
- `thalamus-vetoes.ts`: v2's vetoes plus `privacy` and `policy` (a vendor × topic table). Low reader confidence or a silent Jev never makes a route cheaper or riskier: the cautious option, and every vendor with a topic restriction is left out.
- **Jev reads** (task, step, outcome, enhancement ranking) go through ONE client, moved to `src/infra/jev/` behind the `openclaw/plugin-sdk/fork-jev` subpath; the amygdala keeps a three-line shim. Question wording lives only in `extensions/tinkerclaw-thalamus/questions/*.json`. The step read rides on the amygdala's per-step Jev call when both run (`companion` seam on `decide()`).
- **Owned model choices (2026-10-03).** The architect: "Make sure Thalamus is owner of all those model choices when it is working." Every place that used to name a fixed model asks the leaf resolver first, naming its site (`ModelChoiceSite` in `src/infra/thalamus-call-router.ts`), and keeps the fixed model as the fallback for an empty answer: a sub-agent spawned with no model (`subagent`, `subagent-spawn-plan.ts`, priced on the child's task), an orchestrate leaf with no model (`orchestrate-default`, `orchestration-deps.ts`), and the Claude roles of a round-table debate on their builtin model (`round-table`, `thalamusRoleModel`). `orchestrate-auto` acts under `enforce.orchestrateAuto` as before; the rest act under `enforce.ownModelChoices` (ships off; `leafActsFor`). The resolver's `owns(site)` tells the worker who picks, and the spawn guidance and the orchestration disposition say so (`{{MODEL_CHOICE_OWNER}}`, `{{LEAF_MODEL_OWNER}}`): the agent leaves the model out instead of picking by weight. **Never owned:** a model named on purpose (by the architect, a script, a recipe step's `model:` line, a `roleModels` override, configured `subagents.model` or a target agent's model, or the agent's own `--model`); the other vendors' debate roles and anything outside `claude-code` (ruling C2); cron jobs (their models and `fallbacks` are the job's own, and failover must not depend on the router). **Nothing to own:** kit frontmatter `model:` blocks and prefrontal's `model`, `summaryModel` and `effortRouting` choose nothing (display and prompt text only, measured 2026-10-03); chat turns with no pin are already v2's (`thalamusPlan` routes from the primary). The ORCA conductor runs outside the gateway with its own measured router that mixes vendors on purpose, so it keeps its pool. Off or in shadow, every path is the old one byte for byte; shadow writes the would-be pick per site.
- **Seams, per lane.** Embedded runner: a per-call router slot (`src/agents/embedded-agent-runner/call-router.ts`, identity when unregistered) and a digest slot. Claude Code workers: the lane switches at the turn, the unit (`--agents`, `workerExtras`) and the tool result (`hooks/post-tool-digest.mjs`, `updatedToolOutput`), not per call. `tool-loop.md` § THALAMUS v4 seams.
- **Learning** is the nightly update (`posterior = (10 × map + wins) / (10 + n)`), exploration only on overnight jobs and only in enforce (at most 5%), refusals feed v2's existing veto. Nothing is trained.

**Lines not to cross.** A model the user picked by hand is never replaced; only Auto routes. The reserved set (Fable) is reached only by a named reason, as in v2. The short list is advice: nothing forces, loads or runs an enhancement, and "none of these fits" is always an option. Every shared path touched behaves byte for byte as develop while v4 is off, each with its own test. Jev sees synthetic cases only until the architect sets `jev.sendRealSituations`; real content from a private source makes no Jev call at all.

**Rejected:** a second Jev client and store (one call, two jobs); per-token sticker prices (the cache changes the real price); switching whole conversations; cross-vendor translation inside a Claude Code worker; asking the agent what it used (use is read from tool calls with `attributeToolUsage`).

**Don't regress:** a rung with no price row is priced on the anchor unit and marked `moneyKnown: false`, never at zero; a stuck step skips the "cautious keep" and gets no depth relief, or a step that failed twice stays on the weak model exactly when the read is least sure; the plugin's own tables never write into the amygdala's file (two files, one logical ledger, joined by `situation_id`).

**Files:** `src/shared/thalamus-{v4-types,price-table,cache-ledger,switch,vetoes,options,price,route-call,graph}.ts`, `src/infra/thalamus-{board,board-build,call-router,read-provider}.ts`, `src/infra/jev/`, `src/plugin-sdk/fork-{jev,thalamus,thalamus-runtime}.ts`, `extensions/tinkerclaw-thalamus/`.

## Auth profile environment

`env.vars` in openclaw.json contains:

- `ANTHROPIC_API_KEY` (metered fallback, currently unused due to `auth.order.anthropic = [cli-gm]`)
- `CLAUDE_AI_SESSION_KEY` (claude.ai session)
- `ANTHROPIC_ADMIN_API_KEY` (admin operations)
- `ANTHROPIC_SUBSCRIPTION_TIER = "max_20x"`
- `ANTHROPIC_MONTHLY_BUDGET_USD = "200"`
- `OPENAI_API_KEY`, `OPENAI_ADMIN_API_KEY`
- `MANUS_API_KEY`, `BRAVE_API_KEY`
- `OLLAMA_API_KEY = "ollama-local"`

**PII boundary note:** these env vars contain real credentials. They live in the PRIVATE jarvis-brain repo (`~/.openclaw/openclaw.json`), never in the public tinkerclaw fork. See `pii-boundary.md`.

## Don't regress

- `cli-gm` profile is the only Anthropic auth in use. The `api` profile must stay out of `auth.order.anthropic` until the OAuth subscription is genuinely exhausted (not just for testing).
- The downscoped-token cascade incident (2026-02-23 per bible §11.x) — downscoped tokens written back to BOTH `auth-profiles.json` AND credential files corrupted the credentials. cli-sv refresh token was invalidated by Anthropic strict rotation after 2 days. **Never write downscoped tokens back to source-of-truth credential files.**
- OAuth was NOT disabled by Anthropic. Whenever you see auth-related errors, do NOT assume OAuth is gone (memory note `feedback_oauth_assumption.md`).

## Verify (proposed)

```yaml
verify:
  - cmd: openclaw gateway call models.list
    expect: '.providers["claude-code"] != null'
  - cmd: jq -r '.auth.order.anthropic' ~/.openclaw/openclaw.json
    expect: '["cli-gm"]'
```
