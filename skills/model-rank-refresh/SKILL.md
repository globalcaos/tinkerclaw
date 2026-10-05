---
name: model-rank-refresh
description: "Refresh model performance rankings and raw Artificial Analysis Intelligence Index scores in openclaw.json. Updates existing models and auto-adds verified frontier models from supported providers."
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "os": ["linux", "darwin", "win32"],
        "requires": { "capabilities": ["webfetch"] },
      },
  }
---

# Model Rank Refresh

Keep the OpenClaw model panel ordered by current real-world performance, and
auto-discover new frontier models as they ship.

> **THE WORKFLOW LIVES IN A RECIPE (2026-09-02).** Read these first; they are the
> source of truth for the procedure and they are visible in the Recipes tab, so a
> manual update runs the same steps the cron does:
>
> - `~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes/model-catalog-refresh/recipe.md`
>   — the daily sweep (fetch, re-price, re-rank, detect, propagate, report).
> - `~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes/model-onboard/recipe.md`
>   — wiring ONE model onto every surface. Owns billing-route resolution.
>
> What stays HERE is reference data the recipes call by path: the extractor scripts
> in `scripts/`, the AA→OpenClaw name mapping table below, and the per-provider
> gotchas. When the two disagree, the recipe wins for PROCEDURE and this file wins
> for PROVIDER FACTS — and whichever is wrong gets fixed, not worked around.

<provider_id_convention>
**DERIVE A PROVIDER ID FROM THE CONFIG'S OWN CONVENTION, NEVER FROM A DISPLAY NAME.**
Added 2026-09-02, after this cost us Claude Fable 5.1 for a day.

Artificial Analysis prints `claude-fable-5.1`. Every `claude-code` id in
`openclaw.json` is HYPHENATED — `claude-opus-4-8`, `claude-sonnet-4-6`,
`claude-haiku-4-5` — so the real id is **`claude-fable-5-1`**. The dotted name was
probed, no such id has ever existed, the probe failed, and the model was filed as
OpenRouter-metered. It then drew neutral gray, at $50 instead of the €0.4464 the Max
20x plan actually costs (a 112× overstatement), with no API-price triangle.

So, for every candidate: copy the sibling entries' shape, then PROBE the id **with a
control that must fail** —

```bash
claude --print --model claude-fable-5-1 "reply with exactly: OK"   # a real id answers
claude --print --model claude-fable-9-9 "reply with exactly: OK"   # must say unrecognized_model
```

If the control does not fail, the probe is not discriminating and its success proves
nothing. Record the CLI version alongside any "not served" finding, and treat every
such finding as **expired on read** — Claude Code 2.1.251 genuinely did not serve
Fable 5.1; 2.1.258 does.
</provider_id_convention>

<why_this_matters>
LLM rankings drift weekly — gpt-5.5 ships, gemini bumps a sub-version, a new
Anthropic Sonnet variant lands. Editing `openclaw.json` ranks by hand goes
stale within days. This skill pulls the current rankings from Artificial
Analysis (the canonical aggregated benchmark) once a day and updates the
config so the models panel always reflects current performance order. New
frontier-tier models from supported providers (OpenAI, Anthropic, Google)
are auto-added with appropriate routing.
</why_this_matters>

<source_of_truth>
**Primary**: https://artificialanalysis.ai/leaderboards/models

- Composite "Intelligence Index" score (averaged across MMLU-Pro, GPQA, AIME,
  HumanEval, MATH-500, etc.) — single number, higher is better.
- Updates within days of new model releases.
- Public HTML page; their `/api/v2/data/llms/models` endpoint is gated by API
  key. We scrape via WebFetch (Claude reads the rendered page and extracts).

**Fallback**: https://huggingface.co/spaces/lmsys/chatbot-arena-leaderboard

- Elo-based, less benchmark-centric, no auth needed.
- Use only if AA is unreachable.
  </source_of_truth>

<workflow>

## Step 1 — Fetch the leaderboard

Run the bundled deterministic extractor:

```bash
python3 scripts/fetch_aa_scores.py > /tmp/aa-intelligence-index.json
```

The script fails closed if the public page shape changes or yields suspiciously
few rows. Parse its JSON and keep TWO tables:

1. **Headline** — the highest-scoring named-effort variant per family. This is
   `AA_INTELLIGENCE_INDEX` (models panel sort key).
2. **Per-effort** — write these into `src/shared/aa-effort-index.ts`
   (`AA_EFFORT_INDEX`) and the sidecar `memory/aa-effort-index.json`. A `null`
   score is **omitted**, never filled from the headline. The smart × cost chart
   plots the intersection of this table and the vendor ladder; approximating a
   missing cell flattens the chart again, which is the 2026-08-25 failure the operator
   corrected on 2026-08-27.

   **Take the effort from AA's structured `effort.slug` field, NOT from a
   parenthetical in the display name** (corrected 2026-09-02 — this step used to
   say "every row whose name contains a parenthetical effort token", and that is
   lossy). AA prints `GLM-5.3-Flash` with no parenthetical at all while tagging it
   `effort: max`, so the name-regex reading silently dropped a scored row for a
   model that was already on our panel. The model pages embed the full payload —
   `{slug, name, effort:{slug}, release:{slug}, intelligenceIndex}` — so read the
   field. Two further rules the 2026-09-02 audit confirmed:
   - **Do not key families on `release.slug`.** It over-merges: it files
     `deepseek-v4-flash-vision` under `deepseek-v4-flash`, overwriting one model's
     score with another's. Strip the effort suffix off the model slug instead.
   - **Exclude `non-reasoning` rows.** AA tags several with an effort
     (`claude-sonnet-5-non-reasoning` carries `high`); folding them in files a
     different MODE as an effort stop, which would give Sonnet 5 a bogus
     `high: 42.57` sitting below its own `max: 55.26`.

   Audited 2026-09-02 against the live payload (631 slugs, 132 effort-tagged and
   scored): every family in the shipped table matched exactly — no drift, no missing
   effort. The only effort variants AA lists but does NOT score are
   `claude-sonnet-5` {low, medium, high, xhigh}, `gpt-5-4-pro` and `gpt-5-5-pro`,
   all `intelligenceIndex: null`, all correctly absent. No other site publishes
   AA's Intelligence Index itself — it is AA's own composite — so **no per-effort
   AA number is waiting to be found elsewhere**, and nothing goes into
   `AA_EFFORT_INDEX` that AA did not publish.

   **But the missing cells CAN be estimated, and are (2026-09-02, the operator: "you must
   certainly be able to find other benchmarks … even if you have to approximate").**
   Step 1b below fits other public per-effort measurements to AA's scale and writes
   them to a SEPARATE table the chart draws as estimates, never as measurements.

## Step 1b — Estimate the effort cells AA never scored

```bash
python3 scripts/estimate_effort_index.py
# → memory/aa-effort-estimate.json + src/shared/aa-effort-estimate.ts
```

Sources, both public and both fetched live: Epoch AI's benchmarking hub
(`https://epoch.ai/data/benchmark_data.zip`, CC-BY — ~80 benchmark tables whose
"Model version" carries the effort as a suffix, e.g. `claude-opus-4-8_medium`)
and LMArena's text leaderboard (some keys name an effort: `gpt-5.5-high`,
`claude-opus-5-max`). Epoch's own Capabilities Index is ONE number per model
copied across its effort rows, so it cannot split efforts — the per-benchmark
tables can.

Method: per benchmark, a linear fit AA ≈ a + b·score on the cells BOTH scored at
the same effort (kept when n ≥ 6 and R² ≥ 0.55 — 20 benchmarks on 2026-09-02,
DeepSWE / ARC-AGI / FrontierMath tightest at R² 0.86–0.90); the fits predict the
missing cells; a ladder-shape prior (mean AA ratio between two efforts across AA's
own multi-rung families) covers cells no benchmark ran; both are blended by inverse
variance; then every estimate is clamped between the model's measured neighbours and
kept non-decreasing. Every cell carries `v`, a 1σ `sd`, the `method` and its `basis`.

Rules: a measured cell is never overwritten (`aaEstimateAt` refuses); the chart draws
an estimated rung DOTTED with "ESTIMATE" in the tooltip; the generated file is not
hand-edited; the script's `FAMILY_ALIASES` must match `AA_FAMILY_ALIASES` in
`src/shared/aa-effort-index.ts` (moved there 2026-09-02 so the gateway router reads
the same table; the panel path re-exports it). Re-run after every Step 1, because a
new AA measurement both retires an estimate and re-fits every benchmark.

## Step 1c — Measured per-domain strengths (what THALAMUS routes on)

```bash
python3 scripts/build_domain_strength.py
# → memory/domain-strength.json + src/shared/domain-strength.generated.ts
```

Same Epoch zip. Each benchmark table maps to one dossier domain (`BENCH_DOMAIN` in the
script: code, agentic, reason, write, context, vision, world); a family's strength in
a domain is the mean PERCENTILE of its best run over the domain's tables, among models
released in the last 12 months. `src/shared/thalamus-frontier.ts` reads it to switch
the route by task (Fugu / J6 §3.6 — expertise-matched routing) and the dossier marks
"best at" from it. Known holes 2026-09-02: WRITE (Lech Mazur's table is >12 months
old, so nothing recent) and PSYCH (no public benchmark) stay JUDGED. Re-run with
Step 1b; when Epoch adds a table, add it to `BENCH_DOMAIN` or it is silently skipped —
the script prints the unmapped names every run.

## Step 1d — Regenerate and gate every downstream surface

After updating the config, `AA_INTELLIGENCE_INDEX`, the measured effort table, and
`src/shared/rel-cost-table.ts`, run one deterministic tail. Pass every model added
this run; omit the flags if there were no additions:

```bash
scripts/refresh_model_surfaces.sh \
  --new-model provider/model \
  --new-model provider/another-model
```

This fetches Epoch's archive once, regenerates the estimated effort table used by
the yellow €/task Pareto envelope, regenerates per-domain strengths used by THALAMUS
and the dossier's best marks, refreshes the provider matrix, and runs focused plus
full Tinker UI tests. For each `--new-model`, it fails closed unless the id is in the
picker/config, headline score table, and shared published-cost resolver; it also
guards that dossier rows still enumerate the configured catalog dynamically.

**A cron run may not report success unless this command finishes green.** This is a
hard gate, not a checklist item. Added 2026-09-03 after the cron timed out at 30
minutes and left no report: model discovery and all of its readers are one transaction.

If the AA extractor is unavailable, use WebFetch on the same URL and extract
`{slug, name, intelligenceIndex}` rows. Do not infer scores from rank positions.

## Step 2 — Map AA names to OpenClaw model IDs

Provider mapping table (kept in this skill, NOT in code, so it's easy to update):

| AA name pattern               | OpenClaw model ID                        | Notes                                                                              |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `GPT-5.5`                     | `openai/gpt-5.5`                         | direct                                                                             |
| `GPT-5.4 Pro` / `GPT-5.4-pro` | `openai/gpt-5.4-pro`                     | direct                                                                             |
| `GPT-5.X`                     | `openai/gpt-5.X`                         | preserve dot version                                                               |
| `GPT-4.X`                     | `openai/gpt-4.X`                         | direct                                                                             |
| `o3` / `o5` / `oN`            | `openai/oN`                              | direct                                                                             |
| `Claude Opus 4.X`             | `claude-code/claude-opus-4-X`            | claude-code prefix (subscription); DOTS BECOME HYPHENS                             |
| `Claude Sonnet 4.X`           | `claude-code/claude-sonnet-4-X`          | claude-code prefix; DOTS BECOME HYPHENS                                            |
| `Claude Haiku 4.X`            | `claude-code/claude-haiku-4-X`           | claude-code prefix; DOTS BECOME HYPHENS                                            |
| `Claude Fable 5.X`            | `claude-code/claude-fable-5-X`           | e.g. "Claude Fable 5.1" -> `claude-fable-5-1`, NOT `claude-fable-5.1` (2026-09-02) |
| `Gemini 3.X Pro`              | `google/gemini-3.X-pro-preview` or `pro` | direct, replace dots with dots                                                     |
| `Gemini 2.X`                  | `google/gemini-2.X-...`                  | direct                                                                             |
| `Grok 4.X`                    | `xai/grok-4.X`                           | SUBSCRIPTION — see xAI rule below                                                  |

Other providers (Kimi, Xiaomi/MiMo, Meta/Muse, Alibaba/Qwen, DeepSeek,
Z AI/GLM, MiniMax) — **skip by default**, and surface them in your final report
so the user can decide.

**xAI/Grok is SUBSCRIPTION-BILLED, not metered — added 2026-08-15.** The `xai`
provider does NOT point at the metered `api.x.ai`; its baseUrl is
`https://cli-chat-proxy.grok.com/v1`, the Grok CLI proxy, authenticated by the
OAuth token in `~/.openclaw/xai-oauth.json`. Tokens there cost nothing per call,
so Grok belongs with `claude-code/*` on the auto-add side of the Step-2 guardrail,
NOT with the metered `openrouter/*` vendors.

This was wrong for two weeks and cost a real detection: on 2026-07-30 this skill
demoted `xai/grok-4.5` from rank 14 to 33 with the reason "xAI = unsupported
provider", and Grok 4.6 (AA 60.923, would rank 4) went undetected on every run
until the operator spotted it by hand on 2026-08-15.

Verify a new Grok release against the proxy's own catalog before adding — the
model list is subscription-scoped, so a model existing at xAI does not mean our
plan serves it:

```bash
TOK=$(python3 -c "import json;print(json.load(open('$HOME/.openclaw/xai-oauth.json'))['access'])")
curl -sS https://cli-chat-proxy.grok.com/v1/models -H "Authorization: Bearer $TOK" \
  -H "x-grok-client-identifier: grok-pager" -H "x-grok-client-version: 0.2.91" \
  -H "User-Agent: grok-pager/0.2.91 grok-shell/0.2.91 (linux; x86_64)"
```

Copy the `grok-4.5` entry in `models.providers.xai.models`, change `id`, `name`,
`contextWindow` (from the catalog's `context_window`) and the
`headers.x-grok-model-override` value to the new id. That header is what selects
the model; omitting it silently serves the old one.

### `openrouter/*` — metered vendors ADD LIKE ANY OTHER (rule set 2026-08-15)

`openrouter` is a first-class provider literal in the config schema
(`src/config/types.models.ts:55`, `zod-schema.core.ts:206`, baseUrl
`https://openrouter.ai/api/v1`), the key is configured, and it fronts Kimi, Qwen,
DeepSeek, GLM and MiniMax under `openrouter/<vendor>/<model>` ids. It needs NO
entry in `plugins.allow` — the self-contained `models.providers` block routes
through the generic openai-completions path.

**Add them. Do not park them for approval.** A 2026-08-04 guardrail forbade this
job from adding any metered model on the theory that adding a slider stop hands
an unattended cron authority to spend. the operator overruled that on 2026-08-15: _"Forbidding
jobs from adding anything that spends per token is a mistake."_ The reasoning is that
**adding a model is not spending money** — nothing bills until something is routed
to it, and a model that is absent from the panel cannot be compared, which is the
whole point of tracking the field. A withheld candidate is not a saved euro; it is
a blind spot.

So: a new model from ANY reachable provider — subscription or metered — gets added,
priced, ranked, and plotted. What the report owes the operator is the COST, prominently,
not a request for permission.

**Verification binds hardest here**, because the aggregator sites are actively wrong
about these vendors. Resolve every id, price AND context window against the live
catalog, never against a price page or a search summary:

```bash
curl -s https://openrouter.ai/api/v1/models   # authoritative id + pricing + context_length
```

Confirmed failure of trusting secondary sources: every price page quotes Kimi K3
at $2.90/$14; the live endpoint says $3.00/$15, and the cheaper figure belongs to
the unrelated `~moonshotai/kimi-latest` alias. Second confirmed failure, 2026-08-15:
a two-day-old `/tmp/or-models.json` was nearly used as the price source for three
additions — `curl` had returned `http=000` and the stale file parsed cleanly anyway.
Re-fetch and check the byte count; a JSON that parses is not a JSON that is current.

**Re-price on every run, not just on add.** GLM-5.2 sat in the config at
`0.378/1.188` while the live catalog said `0.462/1.452` — a 22% understatement on a
model already on the slider, which silently flatters every cost comparison it appears
in. Diff the whole `models.providers.*.cost` block against the live catalog each pass
and report any drift.

Do NOT append a further correction to this block. If it goes stale again, REWRITE
the section — a stack of dated reversals is how a rule stops being readable.

## Step 3 — Read current openclaw.json

```bash
cat ~/.openclaw/openclaw.json
```

Extract `agents.defaults.models` — the current model registry.

## Step 4 — Build the new ranks

Walk the AA list in score order. **TIE-BREAK equal Intelligence-Index scores by
version recency (newer minor version = better rank), then by lower price.** AA
often gives a new point-release the SAME score as its predecessor (e.g. Gemini
3.6 Flash = 3.5 Flash = 50 on v4.1, but 3.6 is faster + cheaper); a naive stable
sort then parks the newer/better model BELOW the old one, which reads as "3.6 is
dumber than 3.5" on the slider (the operator flagged this 2026-07-22). Never let a
strictly-better point-release sort under its predecessor.

For each AA model that maps to a supported OpenClaw provider:

1. If the model ID is already in the config: keep its `alias`/`params`
   metadata, set `intelligenceIndex` to AA's raw score, and set `rank` to
   its position in the new order. Provider twins of the same underlying model
   (for example `openai/gpt-5.5` and `github-copilot/gpt-5.5`) get the same raw
   score.
2. If the model ID is NEW: **VERIFY the exact ID exists at the provider BEFORE
   adding it** — hit the provider's live models list (OpenAI `/v1/models` with the
   configured key; Google via the auth path actually in use) and confirm the id
   verbatim. NEVER guess suffixes (`-preview`, tier names) from the AA display
   name. INCIDENT 2026-07-21: auto-added `openai/gpt-5.6-sol|terra|luna` +
   `google/gemini-3.5-flash-preview` from AA names; none resolved in OpenClaw's
   catalog → every Tinker model-slider pin died as "Unknown model" and the slider
   looked wholly broken for non-Anthropic providers. If the ID can't be verified,
   SKIP it and surface it in the report instead. Also check the model is
   SERVEABLE by a configured auth path (a real id with zero API quota is still a
   dead slider stop). Then add with empty params, `rank` set, no `alias`.
3. If a previously-configured model is NOT scored by AA: keep it, remove any
   stale `intelligenceIndex`, and push its rank to the bottom (preserve the
   "I configured this for a reason" intent — the user can prune manually).

   **PROVISIONAL entries.** Some models are configured before AA scores them. Such an
   `intelligenceIndex` is a PROVISIONAL placement (e.g. derived from LMArena), not an
   AA measurement. Rule: when AA does score the model, OVERWRITE the provisional value
   — AA wins, that is the point. But do NOT silently strip it to `undefined` and drop
   the model to the bottom of the panel just because AA has not caught up; report it
   in Step 6 as `provisional, awaiting AA` and leave the value in place. An
   unscored-but-placed model is a deliberate state, not drift.

   Worked example, now CLOSED: `openrouter/qwen/qwen3.8-max` shipped 2026-08-03 with no
   AA row, and was placed provisionally at 58.1 from LMArena. As of 2026-08-08 AA scores
   it for real — `qwen3-8-max` = 58.077 → 58.1, i.e. the provisional placement was
   correct and the entry is no longer provisional. Keep the rule; the example is only
   here to show what the closed state looks like.

   **NEVER invent the number.** On 2026-08-04 a web-search summary confidently
   reported "Qwen3.8 Max scores 53 on the Artificial Analysis Intelligence Index".
   No such row exists; the figure was hallucinated and I wrote it into the config
   with a comment claiming two sources had corroborated it. Both "sources" were the
   same search engine paraphrasing the same page. Run `scripts/fetch_aa_scores.py`
   and grep the actual rows — if the model is absent, say ABSENT.

**Important: keep `claude-code/claude-haiku-4-5` even if it doesn't appear
in the AA top 30** — it's the budget-tier baseline for the panel and is
referenced by the `haiku` alias.

## Step 4b — Propagate to the CHART and the DOSSIER (mandatory, added 2026-08-15)

The model panel is not the only reader. `openclaw.json` feeds the panel; the graph,
shared THALAMUS router, and dossier read other tables, and a run that updates only the
config leaves the system lying by omission. the operator's rule: _"in the smart x cost and
dossier graphs you should add all of them — it all goes together."_

| surface                                   | file                                                   | what to update                                                 |
| ----------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| SMARTNESS × COST y-axis                   | `tinker-ui/src/app.ts` → `AA_INTELLIGENCE_INDEX`       | refresh every score from this run's AA data; append new ids    |
| SMARTNESS × COST x-axis + yellow envelope | `src/shared/rel-cost-table.ts`                         | one verified price row per new id on the correct billing route |
| measured / estimated effort rungs         | `src/shared/aa-effort-{index,estimate}.ts`             | measured table from AA; estimated table through Step 1d        |
| THALAMUS task routing + best marks        | `src/shared/domain-strength.generated.ts`              | regenerate through Step 1d                                     |
| dossier rows                              | `tinker-ui/src/app.ts` → `openDossier`                 | dynamic from every configured scored model, no score floor     |
| dossier provider matrix                   | `tinker-ui/src/panels/cn-provider-prices.generated.ts` | regenerate through Step 1d                                     |

Three rules that are load-bearing, each learned the hard way:

1. **A dot with no cost row is worse than no dot.** The drawing fallback is 2.58,
   while `relCostLookup` deliberately returns missing for routing. Add the shared cost
   row in the SAME pass as the score, never after.
2. **Regex order decides.** `REL_COST_TABLE` is matched top-down, and the generic
   `/kimi/i`, `/glm/i`, `/deepseek.*flash/i` rows will swallow a specific new model
   and misprice it by up to 6× (Kimi K2.6 at $2.28 priced as K3 at $15). Specific
   rows go ABOVE the generic ones.
3. **The chart's catalog tail is NOT limited to providers we run.** That gate existed
   until 2026-08-15 and defeated the chart's purpose — a switch candidate is by
   definition on a provider we have not configured yet. The requirement is a verified
   PRICE, not a configured provider.

Why this step exists at all: on 2026-08-15 `AA_INTELLIGENCE_INDEX` was found frozen on
a superseded AA scale (Opus 5 at 60.7 against a live 63.05) with **zero** OpenRouter
models in it, while `openclaw.json` had been refreshed almost daily. One writer, one
surface; the other two rotted quietly for weeks. After editing, run
`pnpm test:tinker-ui` from the repo root and report the result.

## Step 5 — Write back the config

Write the updated JSON atomically. Preserve indent (2 spaces) and trailing
newline. Validate it against OpenClaw's config schema before replacing the live
file. `intelligenceIndex` must be AA's raw finite number; `rank` remains a
positive integer ordinal.

The `auth-reload` plugin watches `openclaw.json` and reloads config
automatically — no gateway restart needed.

## Step 6 — Report

Output a one-line summary: `processed=N scored=I updated=U added=A unchanged=S`
where N is total models in AA top 30, U is existing models with new rank,
A is newly-added models, S is unchanged.

If any unsupported-provider models showed up in AA top 30, list them at
the end so the user can decide to add provider routing.

</workflow>

<safety_rails>

- NEVER overwrite `agents.defaults.model.primary` — the user chose that
  primary; don't auto-flip it just because a new model is at AA #1.
- NEVER change `agents.defaults.model.fallbacks` — that's a user-curated
  list. Just update the model registry.
- NEVER remove existing models from the registry. Drift them to the bottom
  if AA dropped them. The user prunes.
- NEVER touch `auth.profiles` or `auth.order` — those are credential
  routing tables, not model config.
- If the AA fetch fails (rate-limited, 4xx, parse-error), log and exit
  with status nonzero. Do not write a partial config. The next cron tick
  retries.
  </safety_rails>

<failure_modes>

- AA blocks scrapers → fall back to LMSYS Chatbot Arena for ordering only.
  Never write Arena-derived values into `intelligenceIndex`; the two scales are
  not interchangeable. Preserve the last AA scores until AA can be fetched.
- Both unreachable → exit, no config change. The model panel keeps showing
  the previous order. Surface the failure in the cron summary so the
  morning briefing notices.
- AA renames a model (e.g. "GPT-5.5" → "GPT-5.5 Turbo") and our existing
  config has the old name → keep the old config entry at lowest rank,
  add the new one at top. The user notices the duplicate in the panel and
  decides which to keep.
  </failure_modes>
