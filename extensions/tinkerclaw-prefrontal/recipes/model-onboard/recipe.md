---
schema: "kit/1.0"
slug: "model-onboard"
title: "Onboard one model onto every surface (route, price basis, colour, logo, effort ladder)"
summary: "Wire a single newly-released model into ALL the surfaces that carry model facts, in one pass: resolve which BILLING ROUTE actually serves it (subscription vs metered), add the config entry, the cost row, the headline and per-effort Intelligence Index, and verify the colour, logo, circle and triangle it will actually draw. Exists because a model added to the picker but missed on four other surfaces looks broken to the reader, and because the cheapest way to get the route wrong is to transcribe the aggregator's display name as the provider id."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
subdivision: "models"
tags:
  [
    "new model",
    "add a model",
    "onboard a model",
    "model picker",
    "wrong colour on the chart",
    "wrong logo on the chart",
    "model cost is wrong",
    "smart x cost chart",
    "thinking effort ladder",
    "intelligence index",
    "subscription vs metered",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis"
params:
  model_name:
    {
      type: "string",
      description: "The model as the aggregator names it, e.g. 'Claude Fable 5.1'. A DISPLAY NAME — never used as a provider id.",
    }
  config_path:
    {
      type: "string",
      default: "~/.openclaw/openclaw.json",
      description: "The live OpenClaw config: provider routes + the model panel list.",
    }
  ui_src:
    {
      type: "string",
      default: "~/src/tinkerclaw/tinker-ui/src",
      description: "Where the chart / dossier / EEG surfaces live.",
    }
---

# Onboard one model onto every surface

## Goal

Take ONE model that has just shipped and leave it correct on every surface that
carries a fact about it — the picker, the EEG trace, the smart × cost chart (both
axes, both mark types), the dossier — with no invented number anywhere.

## When to Use

- A new model appeared and needs adding (manually, or called per-model by
  [`model-catalog-refresh`](../model-catalog-refresh/recipe.md)).
- A model is ON a surface but drawing WRONG: neutral-gray trace, someone else's
  logo, a cost that is off by a subscription factor, a single bubble where an
  effort ladder belongs.

## The one rule that matters most

**The aggregator's display name is not a provider id, and the price you find first
is not the price we pay.** Both of the architect's 2026-09-02 corrections trace to this
single mistake, so Step 1 is the whole recipe and everything after it is bookkeeping.

## Steps

### 1. Resolve the BILLING ROUTE before anything else

**Done when:** you can name which provider actually serves this model to us, and
you have PROBED that exact id and watched a deliberately-wrong id fail.

A model is often reachable by more than one route, and the routes differ by up to
**112×** in what they cost us. Getting this wrong is not a rounding error — it
places the dot in the wrong half of the chart and paints it the wrong colour.

Check the SUBSCRIPTION routes first, because they are the ones that look absent:

- **Derive the candidate id from the config's OWN convention for that provider,
  never from the aggregator's spelling.** Read the sibling entries in
  `{{config_path}}` and copy their shape. Anthropic ids under `claude-code` are
  HYPHENATED — `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` — so
  "Claude Fable 5.1" is `claude-fable-5-1`, **not** the dotted `claude-fable-5.1`
  that Artificial Analysis prints.
- **Probe it, and probe a control.** A probe that cannot fail proves nothing
  (see the standing rule: a probe returning the same answer for every input is
  broken). For Claude Code:

  ```bash
  claude --print --model <candidate-id> "reply with exactly: OK"      # expect OK
  claude --print --model claude-fable-9-9 "reply with exactly: OK"    # expect a loud failure
  ```

  A real id answers; an unknown id returns `unrecognized_model`. If the control
  does NOT fail, your probe is not discriminating and its success means nothing.

- Note the CLI **version** in whatever you write down, and treat any recorded
  "not served yet" as **expired on read** — vendors ship ids between our runs, and
  a stale negative is what kept Fable 5.1 on the wrong route.

Only if no subscription route serves it, use the metered one (OpenRouter et al),
with id, price AND context window taken from the live catalog:

```bash
curl -s https://openrouter.ai/api/v1/models     # authoritative — never a price page
```

**If BOTH routes serve it, add both.** They are the same model on different bills
and the chart is built to show exactly that; give the metered one a name that says
so (`… (OpenRouter, metered)`) so it cannot be picked by accident in the picker.

### 2. Config entry

**Done when:** `{{config_path}}` has the provider route and the panel entry, and
the file still parses.

- Provider route under `models.providers.<provider>.models`: copy the shape of the
  nearest sibling. A **subscription** route carries `cost: {input:0, output:0, …}` —
  the plan already paid; a **metered** route carries the live catalog's real prices.
- Panel entry under `agents.defaults.models`: `{rank, intelligenceIndex}`. Ranks are
  ordinals — inserting one shifts the rest.
- Write atomically (temp file + replace), 2-space indent, trailing newline. The
  `auth-reload` plugin picks it up; no gateway restart.

### 3. The cost row — and key it on the ROUTE, not on the spelling

**Done when:** `{{ui_src}}/panels/eeg-trace.ts` → `EEG_COST_TABLE` prices this model
on the right basis, and a hypothetical next version of it would still be right.

- **Metered** row → the vendor's published **$/Mtok OUTPUT**, verbatim from the live
  catalog.
- **Subscription** row → the amortised plan price already derived in that file's
  header (Anthropic Max 20x: Fable €0.4464, Opus €0.2232, Sonnet €0.0893, Haiku
  €0.0446 — the $50/$25/$10/$5 stickers ÷ **112**).
- **Regex order is load-bearing and first match wins.** A specific row goes ABOVE a
  generic one, or the generic swallows it and misprices by up to 6×.
- **Match on the provider prefix** (`/openrouter\/.*fable/i`), the way the Copilot
  block does — _never_ on a punctuation difference between two ids. The original
  Fable 5.1 row keyed on the DOT in `fable-5\.1`, which happened to work only because
  the subscription id spells the same version with a hyphen. That is not a rule, it
  is a coincidence, and it hid the fact that the wrong route had been chosen.
- A model with no row falls through to `EEG_DEFAULT_REL_COST` and draws at a price
  that is simply false. **Add the cost row in the same pass as the score, never after.**

### 4. Intelligence Index — headline and per effort

**Done when:** the headline score is in `app.ts` → `AA_INTELLIGENCE_INDEX` and every
effort AA actually scored is in `panels/aa-effort-index.ts` → `AA_EFFORT_INDEX`.

Extraction rules, each bought by a real miss — see that file's header:

- Read the effort from AA's **structured `effort.slug` field**, never from the
  display name's `(high)` / `High Effort` parenthetical. AA prints `GLM-5.3-Flash`
  with no parenthetical while tagging it `effort: max`, so a name-regex extractor
  drops the row silently.
- **Do not key on `release.slug`** — it over-merges (`deepseek-v4-flash-vision` files
  under `deepseek-v4-flash`, overwriting one model's score with another's). Strip the
  effort suffix off the model slug instead.
- **Exclude `non-reasoning` rows.** AA tags some with an effort; folding them in files
  a different MODE as an effort stop.
- **A `null` score is OMITTED, never approximated.** A missing rung still draws — on
  the dashed cost rail at the headline index, flagged `measured:false` — because its
  COST is real even when its score is not. That is the honest form; inventing a Y is
  the 2026-08-25 defect this chart exists without.

### 4b. The PLAN price — derive it, never divide the sticker

**Done when:** the subscription rows come from live quota x measured burn x published
price weights, and you can state the arithmetic.

For a metered route the price IS the vendor's number and there is nothing to derive.
For a SUBSCRIPTION route there is no per-token price at all — you are amortising a flat
fee, and that is an arithmetic you must actually do:

1. Read the live plan utilisation (`openclaw gateway call budget.usage --json` →
   `claude.limits.seven_day.utilization`) and note when that window opened.
2. Measure OUR burn inside exactly that window from `anatomy_events`
   (`~/.openclaw/data/anatomy-timeline.db`), weighting tokens by the vendor's OWN
   published prices expressed in OUTPUT-equivalent units. For Anthropic, verified
   across all four models on 2026-09-02: **out 1.0 · fresh input 0.20 · cache READ 0.02
   · cache WRITE 0.25** (cache read is 10% of input, cache write 1.25x input).
3. Split by the public sticker ladder to get sonnet-equivalents (haiku 0.5 / sonnet 1 /
   opus 2.5 / fable 5), giving burn in eq-Mtok.
4. ceiling = burn / utilisation. Consumed = ceiling x the stated average utilisation
   (the architect uses 75%). unit = weekly fee / consumed. Each model row = unit x its ratio.
5. **Cross-check against a second window.** One window is a sample; two agreeing
   windows are a measurement.

**NEVER shortcut this as `sticker / N`.** The N is an OUTPUT of the arithmetic above and
it moves: it was 112 on 2026-08-13 and 340 on 2026-09-02 — not because prices changed
but because Anthropic raised the Max 20x weekly allowance ~10x, which only re-measuring
can see. the architect's words: _"do not just divide the $50 sticker by 112, find the proper
model cost."_

**Two traps that made the old number wrong, both worth checking explicitly:**

- **Weighting cache reads like fresh input.** Our traffic is ~99% cache read, so using
  0.2 instead of 0.02 did not shade the result, it dominated it — burn came out 5.3x
  too high. Whenever one token class dwarfs the others, its weight IS the answer.
- **A constant that can only age one way.** A flat fee divided by usage falls as usage
  grows and as the vendor raises limits. Re-derive on a schedule, not on suspicion.

**Move the whole ladder together.** The rows are one unit times fixed sticker ratios.
Hand-editing a single row makes the chart claim something false — e.g. Fable cheaper
than Opus. Assert the RATIOS in a test, not the absolute values.

### 5. Colour and logo — check the ROUTED id, not the provider string

**Done when:** you have called the two resolvers and compared the output to the brand
constant, rather than assuming.

A model reached THROUGH a router arrives with `provider = "openrouter"` and its brand
in the id's MIDDLE segment. Both resolvers must read the model id:

- `eegProviderPaint(provider, model)` → brand stroke. It matches on
  provider **and** model together; a branch that tests the provider alone paints every
  routed model neutral gray (the 2026-09-02 Fable symptom, which covered five brands).
- `getRoutedLogoSvg(modelId, provider)` → the mark. Falls back through
  `ROUTED_VENDOR_ALIASES[seg[1]]`; a vendor missing from that table gets the neutral
  glyph, and an unknown provider used to get **Anthropic's sparkle**, which once branded
  15 of 99 models as Claude.

If the vendor is new, add it to `ROUTED_VENDOR_ALIASES` + `PROVIDER_LOGO_SVG` with the
vendor's REAL artwork (lobehub `@lobehub/icons-static-svg`, `npm pack` into /tmp, inline
it — no runtime dependency). Approximating a trademark from memory is inventing it.

**THERE IS MORE THAN ONE LOGO CALL SITE, AND FIXING ONE IS NOT FIXING THE CLASS.** On
2026-09-02 the chart was corrected and the models panel still drew a grey circle, because
`modelIcon()` used the vendor-only `getModelLogoSvg` and then looked up the literal
provider `"openrouter"`, which has no icon, so `providerIcon()` emitted its last-resort
coloured dot. The dossier rows and the legend chips had the same defect. Before claiming a
logo is fixed, grep for every resolver call and make them agree:

```bash
grep -n "getModelLogoSvg\|getRoutedLogoSvg\|providerIcon\|getProviderLogoSvg" tinker-ui/src/app.ts
```

`getRoutedLogoSvg(id, provider)` is the one to use everywhere: it reads the vendor out of
the id's middle segment and returns the neutral routed glyph — never Anthropic's sparkle —
for an unknown key.

### 5b. Retiring a duplicate — remove it from EVERY dot source

**Done when:** the model is gone from the config AND from the chart catalog, and you have
looked at the chart to confirm one dot.

`AA_INTELLIGENCE_INDEX` in `app.ts` is **not just a score lookup — it is a DOT SOURCE**:
`moreIds` unions its keys with the configured models, so an id left there keeps drawing
after you delete it from `openclaw.json`. That is exactly how a removed OpenRouter twin
went on rendering at its $50 sticker while the config was already clean.

When the architect asks to drop a redundant route: delete the panel entry, delete the provider-block
entry, delete the `AA_INTELLIGENCE_INDEX` key, then **re-compact the ranks** (they are
ordinals; a hole is a bug). Keep the EEG cost row as a guard for any future route on that
vendor. And run the census before deleting anything — normalise ids to their last segment
and compare, rather than eyeballing the list.

### 6. Verify by COMPUTING what the chart will draw

**Done when:** you have printed the actual numbers, not asserted them.

Do not eyeball this and do not trust the diff. Write a scratch test that calls the real
functions and prints, for the new id:

- `eegProviderPaint(...).stroke` vs the brand constant
- `getRoutedLogoSvg(...)` identity against the expected mark
- `eegRelCost(id)` — and, for a subscription route, `listPrice / eegRelCost(id)` ≈ the
  plan factor (112 for Anthropic Max 20x)
- `scPointsFor(m)` — one stop per rung, each with a DISTINCT cost, and `measured:true`
  exactly where AA published
- `scApiPointsFor(m)` — the triangles: **at the official list price**, one per rung, each
  at the SAME Y as its circle. Empty is the correct answer for a metered route, whose
  circle already IS sticker.

Then delete the scratch file and add the surviving assertions as REAL regression tests
next to the existing ones. Run `pnpm test:tinker-ui` from the repo root — the canonical
harness; `--root tinker-ui` lacks jsdom and reports false reds.

### 7. Confirm it is SERVED, not merely saved

**Done when:** the new symbol is in what the browser is handed.

The Tinker UI runs a Vite dev server on **:18790** under the `/tinker/` base, so a source
edit is live after a hard refresh — no gateway restart, no rebuild of a bundle the live
session is reading from.

```bash
curl -s http://127.0.0.1:18790/tinker/src/panels/eeg-trace.ts | grep -c "<a NEW symbol>"
```

Grep for a symbol you just ADDED **plus a control symbol that should still be there** — a
zero-match on both means you fetched the wrong URL, not that the edit failed. Source ≠
served: if the UI is being served from `tinker-ui/dist` instead, say **written, not
running** and name the build + restart as the architect's step.

## Constraints

- **No invented numbers, anywhere.** Every score comes from AA, every price from the
  vendor's live catalog. Absent is a valid, reportable state; approximated is not.
- **Never remove an existing model** to resolve a duplicate. Rename or re-rank it, and
  say what you did, so the architect can reverse it in one line.
- Adding a model is not spending money — nothing bills until something routes to it. Add
  it, price it, and report the COST prominently rather than asking permission.

## Failures Overcome

- **2026-09-02 — the display name became the id.** Fable 5.1 was probed as
  `claude-fable-5.1` (AA's dotted spelling) against a convention that hyphenates every
  Anthropic id. The probe failed, the model was filed as OpenRouter-metered, and it then
  drew gray, at $50 instead of €0.4464, with no API-price triangle. One wrong character
  produced four separate visible defects. → Step 1.
- **2026-09-02 — the routed brand painted gray.** The colour branches tested the provider
  string while the vendor branch tested provider+model, so every `openrouter/<brand>/*`
  route missed its brand. Found via Fable; the class covered five vendors. → Step 5.
- **2026-09-02 — a name-regex extractor dropped a scored row.** `GLM-5.3-Flash` carries
  no `(max)` in its AA display name but IS tagged `effort: max` in the payload, so it sat
  on the dashed cost rail while a real measurement existed. → Step 4.
- **2026-08-15 — one writer, three readers.** `openclaw.json` was refreshed almost daily
  while `AA_INTELLIGENCE_INDEX` sat frozen on a superseded scale with zero OpenRouter
  models. Updating the config alone leaves the system lying by omission. → Steps 3–4.
- **2026-09-02 — the price was inherited, not derived.** Fable 5.1 was given Fable 5's row
  on the reasoning "same sticker, so same plan price". The sticker part was right (both
  $10/$50, verified live) but the ROW ITSELF was stale: it came from a 2026-08-13
  measurement that weighted cache reads at 10x their price and predated a ~10x rise in the
  plan's weekly allowance. the architect: _"do not just divide the $50 sticker by 112 you moron."_
  → Step 4b.
- **2026-09-02 — one logo fixed, three call sites broken.** The chart resolver was corrected
  and reported as done; the models panel, the dossier and the legend each had their own
  copy of the lossy precedence and still drew grey. → Step 5.
- **2026-09-02 — deleted from the config, still on the chart.** `AA_INTELLIGENCE_INDEX`
  independently sources dots, so removing the model from `openclaw.json` left it plotted at
  the sticker price — read by the architect, correctly, as "you did not fix it". → Step 5b.
- **2026-07-21 — auto-added ids that resolved nowhere** killed every non-Anthropic pin on
  the model slider. Verify the id at the provider before adding it. → Step 1.
