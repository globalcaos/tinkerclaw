---
schema: "kit/1.0"
slug: "model-catalog-refresh"
title: "Daily model catalog refresh (rank, re-price, detect arrivals, propagate)"
summary: "The daily sweep that keeps the model panel and the smart x cost chart honest: pull the Artificial Analysis Intelligence Index and the live OpenRouter catalog, re-rank existing models, RE-PRICE them against the catalog (prices drift weekly), detect genuinely new frontier models, and hand each new one to the model-onboard recipe so it lands on every surface at once. Report the deltas that matter — cheapest-provider flips and >10% price moves — not a green tick."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
subdivision: "models"
tags:
  [
    "model rank refresh",
    "refresh model rankings",
    "intelligence index update",
    "new models this week",
    "model prices drifted",
    "re-price models",
    "artificial analysis",
    "openrouter catalog",
    "cn provider price matrix",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis"
parallelism:
  groups:
    - [0]
    - [1, 2]
    - [3]
    - [4]
    - [5]
params:
  config_path:
    { type: "string", default: "~/.openclaw/openclaw.json", description: "Live OpenClaw config." }
  skill_dir:
    {
      type: "string",
      default: "~/.openclaw/workspace/skills/model-rank-refresh",
      description: "Holds the deterministic extractors: fetch_aa_scores.py, fetch_cn_provider_prices.mjs.",
    }
  ui_src:
    {
      type: "string",
      default: "~/src/tinkerclaw/tinker-ui/src",
      description: "Chart / dossier / EEG surfaces.",
    }
---

# Daily model catalog refresh

## Goal

Every morning, leave the model panel ordered by current real-world performance, every
price matching what the vendor charges today, and every newly-shipped frontier model
fully wired — or explicitly reported as unplottable, with which half is missing.

## When to Use

- The daily cron (`model-rank-refresh`).
- Manually: "are the model rankings current?", "did prices move?", "what shipped this week?"

## Steps

### 1. Fetch both halves of the truth

**Done when:** a fresh AA table and a fresh OpenRouter catalog are on disk, each with a
byte count you looked at.

```bash
python3 {{skill_dir}}/scripts/fetch_aa_scores.py > /tmp/aa-$(date +%F).json
curl -s https://openrouter.ai/api/v1/models > /tmp/or-$(date +%F).json
```

**A JSON that parses is not a JSON that is current.** On 2026-08-15 a two-day-old
`/tmp/or-models.json` was nearly used as the price source for three additions: `curl` had
returned `http=000` and the stale file parsed cleanly. Check size and the retrieval
timestamp, and re-fetch rather than reuse.

A model needs **BOTH halves** to be plottable — a measured AA index (y) and a live
provider id + price (x) — and **neither may be inferred**. One half missing means the
model is REPORTED, not plotted.

**Coverage: no model is left out (the architect, 2026-10-13).** _"The ai analysis post is for the whole
humanity to see, so no model should be left out. All models, without exception, should show in
tinkerclaw as well. … Even if we had no api, I want to know there is a new model in town anyway."_

- **Scope:** every one of the **top 50 base rows** on today's AA table (`effort == null`), ranked
  by index. Ordinal on purpose, so an AA rescale cannot shrink it. Each must be on the public
  page AND in TinkerClaw (config, picker data, chart, dossier). A dated snapshot of a model we
  already carry (`qwen3-8-max-0803` next to Qwen3.8 Max) is a twin: name it in the report, no row.
- **The route never decides inclusion.** "We do not route through that provider", "the key has
  no credit", "OpenRouter is not active" are ROUTING facts. They decide the billing label, never
  whether the model appears. The OpenRouter key exists; activating a model is one card payment.
- **Route order:** subscription seat → a direct API key we hold (Google via `GEMINI_API_KEY`,
  xAI, DeepInfra; list the provider's own model endpoint, do not assume) → OpenRouter (metered).
- **No seller anywhere** (AA scores it, no catalog sells it yet): add the score anyway and give
  it a dossier row marked "no public price yet". If a surface cannot draw a model without a
  price, that is a code gap to fix in this run, never a reason to drop it.
- **Census in one call:** `python3 -I ~/.openclaw/workspace/skills/model-rank-refresh/scripts/coverage_census.py` (today's `/tmp/aa-*.json` + `/tmp/or-*.json`; exit 1 = models missing, each with its OpenRouter seller). The run is not done while it exits 1, twins excepted. 2026-10-13 the hand count took 8 calls and stopped at 11; the script found 13.
- **Where an unsellable model lives (built 2026-10-13):** `tinker-ui/src/panels/aa-unrouted-models.ts`
  (`AA_UNROUTED_MODELS`). It feeds the dossier rows and the chart's "not plotted" note, and stays out of
  `AA_INTELLIGENCE_INDEX` (a dot source: no cost row draws at the false default 2.58) and out of
  `openclaw.json` (the picker would offer a model that fails). Add the entry, and drop it the day a
  seller exists and the model is onboarded for real. A model OpenRouter lists under a different name
  ("Step 5 Preview" for AA's "step-5") is not matched without proof. A family with no `SC_DOSSIER_RULES`
  rule gets a row reading "no dossier entry yet", and the report names it; do not invent graded cells.
- **Every new arrival leads the FOUND line**, plotted or not: name, score, vendor, seller, price.

### 2. Re-price everything that is already on the panel

**Done when:** every configured model's cost has been diffed against the live catalog and
any drift is reported.

This is not an add-time-only job. GLM-5.2 sat at `0.378/1.188` while the catalog said
`0.462/1.452` — a 22% understatement on a model already on the slider, silently flattering
every cost comparison it appeared in. Prices move weekly; between 2026-08-13 and 08-15
glm-5.2 fell 27% and deepseek-v4-flash rose 56%.

**Some catalog prices are TIME-WINDOWED — read `pricing.overrides` before calling a move.**
OpenRouter's top-level `prompt`/`completion` is the price of the window that is open _when you
fetch_, and some models carry an `overrides` array (`utc_days`, `utc_start`/`utc_end` in HHMM).
DeepSeek V4.1 Flash is $0.30/$1.20 on weekdays 01:00-04:00 and 06:00-10:00 UTC and $0.15/$0.60
otherwise, all weekend. This cron fires 03:45 UTC, inside the dear window on weekdays, so a
Friday-to-Saturday diff shows a "-50%" that is only the clock (2026-09-12). Diff like against like
(same window) or report the window; never rewrite the config to the off-peak figure on a weekend.

**The SUBSCRIPTION rows need re-deriving too, and nothing prompts you to do it.** A metered
price is wrong loudly (the catalog disagrees); an amortised plan price is wrong SILENTLY,
because it is a flat fee divided by our own usage and both terms drift. On 2026-09-02 the
Anthropic block was found 3x too high: it weighted cache reads at 10x their real price, and
it predated a ~10x rise in the Max 20x weekly allowance that only re-measuring could see.
Re-derive per `model-onboard` Step 4b (live `budget.usage` utilisation x measured
`anatomy_events` burn x published price weights, cross-checked on two windows) whenever the
utilisation reading has moved materially since the figure in `EEG_COST_TABLE`'s header — and
say in the report what the new unit is. Never write `sticker / N`.

Also refresh the CN provider matrix, which the dossier renders as its closing table:

```bash
node {{skill_dir}}/scripts/fetch_cn_provider_prices.mjs
```

It regenerates `{{ui_src}}/panels/cn-provider-prices.generated.ts` (DO-NOT-EDIT banner —
regenerate, never hand-edit) and prints `models=N/14`. If it exits non-zero or reports
`errors>0`, **say so** rather than shipping a partial matrix.

### 2b. Re-measure the subscription seats, and hold every typed claim to them

The prepaid circles are priced from `SEAT_MEASURED` in `src/shared/rel-cost-table.ts`. When its
dated measurement is older than 14 days, re-run it: read the seat's weekly meter
(`python3 ~/.openclaw/workspace/scripts/claude-usage.py`, name the account), start the window at
`max(resets_at − 7 d, the moment the CLI moved to that account)`, run
`python3 scripts/measure-seat-burn.py <start> <start>`, set `weeklyListUsd = burn / meter`, and
re-base the pins the tests report (every one moves by the same factor; one that does not is a bug).
Then grep every place a seat multiple is TYPED rather than computed and hold it to
`seatValueMultiple()`: `{{ui_src}}/app.ts` legend, the hero card
(`~/.openclaw/workspace/artifacts/ai-analysis/hero/hero.html` → `render-hero.mjs`, upload as a new
media item), the static WordPress sentence on post 485, and the memory notes that quote it. A typed
number off by more than ~20% is a gap this run closes, not a note.

### 3. Re-rank

**Done when:** ranks are a clean ordinal sequence over the new scores.

- Walk AA in score order. **Tie-break equal scores by version recency, then lower price.**
  AA often gives a point-release the same score as its predecessor; a naive stable sort
  then parks the newer model BELOW the old one, which reads as "3.6 is dumber than 3.5".
- A configured model AA no longer scores keeps its entry and drifts to the bottom. the architect
  prunes; this job does not.
- A **provisional** placement (configured before AA scored it) is a deliberate state, not
  drift: when AA catches up, AA wins and overwrites it; until then leave it and report it
  as `provisional, awaiting AA`.
- Never touch `model.primary`, `model.fallbacks`, `auth.profiles` or `auth.order`.

### 4. Detect arrivals — and hand each to `model-onboard`

**Done when:** every new model is either fully wired or reported with the missing half named.

Add from ANY reachable provider, subscription or metered. Adding a model is not spending
money — nothing bills until something routes to it, and a model absent from the panel
cannot be compared, which is the whole point of tracking the field. What the report owes
the architect is the **cost, prominently**, not a request for permission.

For each new model, run **[`model-onboard`](../model-onboard/recipe.md)** rather than
re-deriving its steps here. That recipe owns the part that keeps going wrong: resolving the
BILLING ROUTE, keying the cost row on the route rather than on a spelling, the per-effort
index extraction rules, and the colour/logo resolvers.

Two things this step must not do:

- **Do not transcribe the aggregator's display name as a provider id.** It cost us Fable 5.1
  on 2026-09-02 — see `model-onboard` Step 1.
- **Do not trust a recorded "not served yet".** Those are dated negatives and they expire on
  read; vendors ship ids between our runs. Re-probe.

### 4c. Diff OUR ladder against AA's families — that is where lost data hides

**Done when:** every plotted model's effort rungs have been compared against the efforts
AA actually scored, and each mismatch is classified as a bug or as correct.

A model drawing as a **horizontal line** (a vendor effort ladder but ≤1 AA-measured rung)
usually means AA never ran those efforts — see the long note in `aa-effort-index.ts`;
that is not fixable and must not be filled in. But sometimes it means we are failing to
READ data we already have, and the two look identical on the chart. Diff them:

- **Family-key miss** — our key is the model id's last segment; AA may file the same model
  under a different slug. AA names Anthropic's 4.6 pair `claude-sonnet-4-6-adaptive` /
  `claude-opus-4-6-adaptive`, so both resolved to a family that does not exist and drew
  with ZERO measured rungs while their real score sat on disk. **Fix:** add an explicit
  entry to `AA_FAMILY_ALIASES` — never a fuzzy match.
- **Route-ladder miss** — AA scored an effort the ROUTE does not expose (Copilot resells
  Anthropic without `max`, so AA's max row is unreachable there). **This is correct**;
  leave it, and do not widen the ladder to make a dot appear. The ladder describes what
  the provider actually serves.

Mechanically: for each plotted id, take `resolveProviderEffortLadder` levels and the AA
families whose slug equals the key, key + `-adaptive`, or key + `-preview`; report any AA
effort that is missing from our table (a bug) versus missing from the ladder (fine).

### 5. Propagate to every reader, then run the deterministic tail

**Done when:** all six readers agree and `refresh_model_surfaces.sh` finishes green.

`{{config_path}}` feeds the picker; the chart, envelope, router, and dossier have other
inputs. A run that updates only the config leaves the system lying by omission (2026-08-15:
the config was refreshed almost daily while `AA_INTELLIGENCE_INDEX` sat frozen on a
superseded scale with zero OpenRouter models).

| reader                                     | file                                                               | what to update                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| picker                                     | `{{config_path}}`                                                  | every verified route, rank, and headline index                                                           |
| smart × cost Y axis                        | `tinker-ui/src/app.ts` → `AA_INTELLIGENCE_INDEX`                   | every score this run; append new ids                                                                     |
| smart × cost X axis + envelope price       | `src/shared/rel-cost-table.ts`                                     | one verified row per new id, on the right billing basis                                                  |
| measured effort ladder                     | `src/shared/aa-effort-index.ts`                                    | every effort AA actually scored                                                                          |
| measured effort SIDECAR (estimator input)  | `~/.openclaw/workspace/memory/aa-effort-index.json`                | the SAME cells as the .ts above — `estimate_effort_index.py` reads this file, not the .ts (2026-09-13)   |
| estimated effort ladder                    | `src/shared/aa-effort-estimate.ts` (GENERATED)                     | regenerated after every AA refresh; a new AA measurement retires an estimate and re-fits every benchmark |
| THALAMUS task routing + dossier best marks | `src/shared/domain-strength.generated.ts` (GENERATED)              | measured Epoch AI percentiles by domain                                                                  |
| dossier rows                               | `tinker-ui/src/app.ts` → `openDossier`                             | dynamic from every configured scored model; no score floor                                               |
| dossier provider matrix                    | `tinker-ui/src/panels/cn-provider-prices.generated.ts` (GENERATED) | current provider prices                                                                                  |

After the four hand-owned inputs above are current, run the deterministic tail once,
passing every model added this run (omit the flags when none were added):

```bash
{{skill_dir}}/scripts/refresh_model_surfaces.sh \
  --new-model provider/model \
  --new-model provider/another-model
```

The command downloads Epoch's archive once, regenerates the two derived THALAMUS tables
and provider matrix, proves each new id exists in config and the chart score table, proves
the shared cost resolver returns a published value, guards the dossier's dynamic catalog
enumeration, then runs the focused envelope/dossier tests and the full Tinker UI suite.
It fails closed. **Do not report success if it did not finish green.**

### 6. Report the deltas that matter

**Done when:** a Layer-1 report is on disk and the Layer-2 summary names the moves.

Write the run report to `~/.openclaw/cron/reports/<YYYY-MM-DD>/model-rank-refresh.md` per
`~/.openclaw/workspace/CRON_REPORT_CONTRACT.md`, each bullet in the
`~/.openclaw/workspace/CRON-ITEM-VOICE.md` form. **The report is a separate file and
updating the ranks does not discharge it** — on 2026-08-08 five of nine cron subagents did
the real work and skipped this write.

The summary line is `processed=N scored=I updated=U added=A unchanged=S`, plus the two facts
that are the whole reason this runs:

- any model whose **cheapest provider changed**;
- any price that **moved more than 10%**;

and, for each addition, its **cost and its billing route** — subscription or cash.

## Constraints

- If the AA fetch fails, log and exit non-zero. **Do not write a partial config**; the next
  tick retries. Never write Arena-derived values into `intelligenceIndex` — different scale.
- Never invent a score. On 2026-08-04 a search summary "reported" a Qwen3.8 Max AA score of
  53; no such row existed, and it was written into the config with a comment claiming two
  sources had corroborated it. Both were the same engine paraphrasing the same page. Grep the
  actual rows; if the model is absent, say ABSENT.

## Failures Overcome

- **2026-09-02** — Fable 5.1 landed on the metered route because its id was transcribed from
  AA's display name, then drew gray, mispriced 112×, with no API triangle. → Step 4 delegates
  route resolution to `model-onboard` Step 1 instead of restating it.
- **2026-08-15** — one writer, three readers: the config was current, the chart was weeks
  stale. → Step 5.
- **2026-08-15** — xAI was demoted as an "unsupported provider" for two weeks, so Grok 4.6
  (would rank 4) went undetected until the architect spotted it by hand. Subscription-billed
  providers are not unsupported. → Step 4.
- **2026-08-08** — the Layer-1 report was required only in the coordinator's trigger message,
  never in the brief the subagent executed, so five of nine skipped it. → Step 6.
- **2026-09-02** — the subscription cost model silently rotted for three weeks while the
  metered rows were re-priced daily, because only the metered side has an external source
  that contradicts it. A flat-fee-per-usage constant ages in one direction and nothing
  raises a flag. → Step 2 now re-derives both sides.
- **2026-09-13** — GLM-5.2 was re-scored 38.6 → 34.0 in `aa-effort-index.ts` but not in its JSON
  sidecar, which is what the estimator reads; its high/xhigh estimates landed above the new
  measurement and the clamp test went red after the full suite. → Step 5 table lists the sidecar,
  and `refresh_model_surfaces.sh` now fails fast when the two disagree.
- **2026-09-02** — two models drew flat with ZERO measured rungs not because AA lacked the
  data but because AA files them under an `-adaptive` slug our family key never matched. A
  join miss is visually identical to missing data, so it survived every previous audit.
  → Step 4c.
- **2026-10-10** — the 09-23 re-measurement cut the Max 20× multiple from ~340× to ~59×, but the
  chart legend, the hero card (">100×") and a memory note kept the typed 340×; it reached a public
  post in Matt Berman's community before anyone checked. The numbers were redone and the published graph revised → Step 2b; the legend now computes it.

- **2026-10-13** — Meta's Muse Wonder (AA 52.39) and Muse Wonder Full (55.80) and Gemini 4 Argon
  (52.56) had a live OpenRouter price ($4/$20) and were left off because "that route is retired
  for us". The question was whether the cron missed it or skipped it for lack of a route; the
  answer is that no model is left out, even one we cannot call, because a new model still matters. → Step 1, the coverage rule (top 50 base
  rows, route never decides inclusion). The same census found 8 older gaps the cron had never
  flagged (Fable 5, step-5, Ling 3.1 Flash, Qwen3.8-Flash-Next, Gemini 3.7 Flash, GPT-5.4,
  Mistral Large 4 Preview, plus the 0803 Qwen twin).
