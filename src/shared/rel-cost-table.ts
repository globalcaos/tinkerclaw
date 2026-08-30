/**
 * Relative cost per model — the SINGLE source for "what does one Mtok of output
 * from this model actually cost", shared by the gateway and the browser.
 *
 * WHY THIS FILE EXISTS: the number lived in exactly two places that could not see
 * each other — `cfg.agents.defaults.models[key].relCost` on the gateway side and
 * `EEG_COST_TABLE` in tinker-ui/src/panels/eeg-trace.ts in the browser. Two
 * sources for one number is drift with a delay fuse: re-price a model in one and
 * the other keeps arguing from last month's invoice. The table below is the
 * authority; every other surface reads it.
 *
 * Browser-safe and dependency-free ON PURPOSE, exactly like ./quota-window.ts:
 * `src/shared` is the proven client+server home (tinker-ui/vite.config.ts opens
 * server.fs.allow for it). No node:* imports, no gateway types, no hidden clock —
 * both sides must be able to import this module unchanged.
 *
 * ⚠ ORDER IS LOAD-BEARING — THE ROWS ARE A SEQUENCE, NOT A SET. `relCostFor`
 * walks REL_COST_TABLE top-down and returns the FIRST regex that matches, so a
 * specific row must always sit ABOVE the generic row that would also claim its
 * id. Sorting this array, or appending a broad pattern in the middle, silently
 * re-prices models with no test-free way to notice: `nex-n2-mini` under a
 * hoisted `/nex-n2/` draws 10x too thick, and `claude-opus-5-fast` under a
 * hoisted `/opus/` understates a CASH route by 224x. The rows below were moved
 * here VERBATIM from EEG_COST_TABLE, in their original order, comments included —
 * several of those comments ARE the record of an order bug already paid for once.
 *
 * UPDATE RULE, so the next editor does not have to re-derive it: a NEW row goes
 * ABOVE the generic family row that would otherwise claim its id — never appended
 * at the end, never sorted into place. Then pin it in rel-cost-table.test.ts with
 * its full ORDERED claimant list, not just its price. Several ids already have
 * two, three and four claimants (`github-copilot/gpt-5.5` has four, spanning
 * 187×), so "the value is right today" is not evidence the order is right.
 *
 * STILL SPLIT, ON PURPOSE — do not close the drift ticket on this file alone:
 *   1. tinker-ui/src/panels/eeg-trace.ts keeps its own EEG_COST_TABLE for now (a
 *      sibling unit owns that file this wave); a later wave rewires it to
 *      re-export REL_COST_TABLE / DEFAULT_REL_COST / relCostKey / relCostFor from
 *      here. Until then the rows exist in two places — this module creates the
 *      single source, it does not yet collapse the duplicate.
 *   2. The ~54-line "Cost model" basis block above that table (eeg-trace.ts:192-245
 *      — the €0.0893 measured Anthropic unit, the Copilot ×0.5571 allowance factor,
 *      why prepaid amortizes and metered does not) is deliberately NOT copied here.
 *      Duplicating the derivation while eeg-trace.ts still holds it would recreate
 *      the very two-sources defect this module exists to end. The rewire wave must
 *      MOVE that block, not copy it.
 *   3. The gateway still reads cfg.agents.defaults.models[key].relCost, present on
 *      0 of 39 entries, so the 1.5× cost veto stays inert until it reads this.
 */
export const REL_COST_TABLE: { modelMatch: RegExp; relCost: number }[] = [
  // ── GitHub Copilot Pro+ — PREPAID at a PUBLISHED allowance ──
  // FORK 2026-08-15 (the architect: "revise the models that have an EEG trace thicker than
  // fable"). On 2026-08-12 these rows were moved to RAW vendor sticker because Copilot
  // switched to token billing on 2026-06-01. That was half right: Copilot bills tokens,
  // but Pro+ is still a **subscription with an included allowance** — $39/mo carrying
  // **$70 of AI credits** (7,000 credits at $0.01; docs.github.com plans + billing).
  // Treating it as pure cash put the whole block at the 40px cap, implying Copilot was
  // the dearest thing we can run. It is not: inside the allowance you pay $39 for $70
  // of sticker value, an officially-stated conversion of **39/70 = 0.5571×**.
  // So: relCost = published sticker × 0.5571. No measurement, no invention — both
  // numbers come off GitHub's own pages. (Past the allowance you pay list; our Copilot
  // burn is ~3 turns in 30 days, i.e. deep inside it, so 0.5571 is the live factor.)
  //
  // ⚠ PROSPECTIVE ROWS — the architect 2026-08-15: **we do not hold a Copilot Pro+
  // subscription.** These models are on the panel to show management what buying one
  // would get us and whether it is worth it. So the number to draw is what a token
  // WOULD cost if we bought the plan (sticker × 0.5571), which is what these are — but
  // nothing here is live spend, and the EEG will never paint one of these traces
  // because the models are not routable today.
  //
  // AND THE THING MANAGEMENT WILL ASK: GitHub applies **NO MARKUP**. Its per-token
  // prices are IDENTICAL to each model's own vendor — verified 13 of 14 price triples
  // (input / cache-read / output) against Anthropic, OpenAI, Google and xAI on
  // 2026-08-15; the sole exception is Grok-4.5's cache-read, $0.50 on Copilot against
  // xAI's $0.30. Copilot rows draw thick NOT because GitHub overcharges but because our
  // baseline is a far deeper discount: Pro+ returns ~1.79x its fee in list value,
  // Anthropic Max 20x returns ~30x — an **18x gap in value-per-euro**. Same tokens,
  // same list price, very different plan.
  { modelMatch: /github-copilot\/.*fable/i, relCost: 27.86 }, // $50
  { modelMatch: /github-copilot\/.*opus/i, relCost: 13.93 }, // $25
  { modelMatch: /github-copilot\/.*5\.6-sol/i, relCost: 5.57 }, // $10 promo through 2026-09-03 (GitHub docs 2026-08-28; was $30 / 16.71)
  { modelMatch: /github-copilot\/.*gpt-5\.5/i, relCost: 16.71 }, // $30
  { modelMatch: /github-copilot\/.*5\.6-terra/i, relCost: 6.69 }, // $12
  { modelMatch: /github-copilot\/.*gpt-5\.4(?!-mini|-nano)/i, relCost: 8.36 }, // $15
  { modelMatch: /github-copilot\/.*sonnet-5(?!\.)/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*sonnet/i, relCost: 8.36 }, // $15
  { modelMatch: /github-copilot\/.*5\.6-luna/i, relCost: 0.67 }, // $1.20
  { modelMatch: /github-copilot\/.*gemini.*pro/i, relCost: 6.69 }, // $12
  // GitHub docs 2026-08-28: 3.6/3.7 Flash promo $0.75/$3.75 through 2026-12-31.
  // The $7.50 / $9 rows were last year's stickers. 3.75 × 0.5571 = 2.09.
  { modelMatch: /github-copilot\/.*gemini-3\.[67].*flash/i, relCost: 2.09 }, // $3.75 promo
  { modelMatch: /github-copilot\/.*gemini.*flash/i, relCost: 5.01 }, // 3.5 Flash $9
  { modelMatch: /github-copilot\/.*haiku/i, relCost: 2.79 }, // $5
  { modelMatch: /github-copilot\/.*gpt-5\.4-mini/i, relCost: 2.51 }, // $4.50
  { modelMatch: /github-copilot\/.*gpt-5-mini/i, relCost: 1.11 }, // $2
  { modelMatch: /github-copilot\/.*gpt-5\.3-codex/i, relCost: 7.8 }, // $14
  { modelMatch: /github-copilot\/.*gpt-5\.2/i, relCost: 7.8 }, // $14
  { modelMatch: /github-copilot\/.*gpt-5\.1/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*gpt-5(?!\.)/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*gpt-4\.1/i, relCost: 4.46 }, // $8
  { modelMatch: /github-copilot\/.*gpt-4o/i, relCost: 5.57 }, // $10
  { modelMatch: /github-copilot\/.*grok/i, relCost: 3.34 }, // $6
  { modelMatch: /github-copilot\//i, relCost: 6.69 }, // unknown copilot model ($12-class)

  // ── OpenRouter, METERED (the architect 2026-08-04) ──
  // These are the only models on the panel billed in REAL CASH per token — there
  // is no subscription to amortize, so relCost is the sticker output $/Mtok
  // verified against the live /v1/models endpoint on 2026-08-04, with NO ÷4.65.
  // That is why Kimi K3 draws THICKER than Opus: an Opus token is prepaid inside
  // the Max 20x plan, a Kimi token is money leaving the account. The widths are
  // telling the truth about spend, which is the whole point of the column.
  // Must precede the bare-family rules below so nothing generic claims them.
  // Prices re-read from the vendors' own pages 2026-08-12 (NOT from our telemetry).
  // FORK 2026-08-13 — RE-VERIFIED against the OpenRouter **API** (`/api/v1/models`),
  // not its web pages or a search summary. Three of five were wrong, including one I
  // introduced the day before by pricing a brokered model from the LAB's page:
  //   kimi-k3   14   → 15     (OR charges $3/$15, identical to Moonshot first-party;
  //                            the "$2.80/$14" read off the model page was not the
  //                            price actually billed)
  //   glm-5.2   4.4  → 1.98   (4.4 was Z.ai's OWN $1.40/$4.40 — we route through
  //                            OpenRouter, which charges $0.63/$1.98. 2.22× overstated)
  //   deepseek  0.144→ 0.18   (OR charges $0.08/$0.18, not the $0.072/$0.144 listed)
  // qwen3.8 and qwen3.7 verified EXACT. Re-verify with:
  //   curl -s https://openrouter.ai/api/v1/models | jq '.data[]|select(.id=="z-ai/glm-5.2").pricing'
  // RE-CHECKED 2026-08-15 against the same API. **Two of five moved in 48 hours** —
  // these are live marketplace prices, not stable literals:
  //   glm-5.2      1.98 → 1.452  (-27%)
  //   deepseek     0.18 → 0.28   (+56% — the rise DeepSeek's own docs warned about;
  //                               it now matches their first-party $0.14/$0.28)
  // qwen3.8, qwen3.7 and kimi unchanged. Anything frozen here is wrong within days;
  // re-run the curl above before trusting these.
  // RE-CHECKED 2026-08-17 → glm-5.2 1.452 → 2.42, deepseek-v4-pro 0.87 → 3.96.
  // RE-CHECKED 2026-08-18 → glm-5.2 2.42 → 3.15 (+30% out, while INPUT fell 0.76 →
  //   0.50). Three moves in four days on one model, in both directions: GLM's routed
  //   price is the most volatile figure on this panel. Everything else held exactly.
  // RE-CHECKED 2026-08-19 → glm-5.2 3.15 → 3.036 (−3.6% out; input 0.50 → 0.966).
  // ── OpenRouter catalog rows (FORK 2026-08-15, the architect: "add all of them ... which
  //    will tell us how good we are doing"). Metered $/Mtok-OUTPUT, every figure
  //    read off the live /api/v1/models endpoint, never off a price page.
  //    SPECIFIC ROWS MUST STAY ABOVE the generic /kimi/, /glm/, /deepseek.*flash/
  //    rows below — regex order decides, and the generic rows misprice these by up
  //    to 6× (a K2.6 dot priced as a K3 dot is a lie the chart cannot walk back).
  { modelMatch: /qwen3\.8-2\.4t/i, relCost: 6.0 }, // $2.000/$6.000
  // FORK 2026-08-18: added with the model itself. No generic /qwen/ row exists, so
  // without this the 27B would have fallen through to EEG_DEFAULT_REL_COST (2.58)
  // and drawn 19% thin — the "dot with no cost row" failure the block above warns of.
  { modelMatch: /qwen3\.8-27b/i, relCost: 2.55 }, // $0.425/$2.550 — re-checked 2026-08-25 (was 3.0; -15%)
  { modelMatch: /deepseek-v4-pro-0813/i, relCost: 1.98 }, // $0.660/$1.980 — re-checked 2026-08-29 live endpoints (-41%; DeepSeek direct cheapest, was DeepInfra $1.122/$3.366)
  { modelMatch: /deepseek.*v4-pro/i, relCost: 1.3993 }, // $0.6997/$1.3993 — re-checked 2026-08-29 live endpoints (undated slug; was 1.74; -20%)
  { modelMatch: /minimax/i, relCost: 1.2 }, // $0.300/$1.200
  { modelMatch: /muse-spark/i, relCost: 4.25 }, // $1.250/$4.250
  // PROVIDER-SCOPED ON PURPOSE. The native `google/*` rows further down sit on an
  // AMORTIZED scale (3.5 Flash = 0.0804 for a $9 sticker, i.e. ÷112), left over from
  // when Gemini was reachable on a free CLI tier. An unscoped /gemini-3.7.*flash/ here
  // would win by regex order and price a NATIVE google dot at raw metered rate — two
  // scales in one column, which is exactly the 43× lie of [eeg-cost-table-amortized].
  // Only the metered OpenRouter route gets the raw number.
  { modelMatch: /openrouter\/.*gemini-3\.7.*flash/i, relCost: 1.875 }, // $0.375/$1.875 OR
  { modelMatch: /mimo/i, relCost: 0.87 }, // $0.435/$0.870
  { modelMatch: /inkling-small/i, relCost: 1.2 }, // $0.450/$1.200
  { modelMatch: /inkling/i, relCost: 4.05 }, // $0.950/$4.050
  { modelMatch: /tencent|hy3/i, relCost: 0.528 }, // $0.132/$0.528
  // FORK 2026-08-15 (regex-leak audit): `/nex-n2/i` also claimed `nex-n2-mini`
  // ($0.100), drawing it 10× too thick. Specific row first.
  { modelMatch: /nex-n2-mini/i, relCost: 0.1 }, // $0.025/$0.100
  { modelMatch: /nex-n2/i, relCost: 1.0 }, // nex-n2-pro $0.250/$1.000
  { modelMatch: /solar-pro/i, relCost: 0.12 }, // $0.030/$0.120
  { modelMatch: /glm-5\.3-flash/i, relCost: 0.25 }, // $0.075/$0.250 — re-checked 2026-08-29 live (Relace, unchanged; was Z.AI)
  { modelMatch: /glm-5\.3/i, relCost: 4.0 }, // $1.200/$4.000 — re-checked 2026-08-30 live (+1%; DeepInfra now cheapest, AtlasCloud raised $3.96→$4.40)
  { modelMatch: /glm-5\.1/i, relCost: 2.856 }, // $0.9086/$2.8556 — re-checked 2026-08-29 live (-28%; Baidu cheapest, was GMICloud $1.260/$3.960)
  { modelMatch: /glm-5\.2/i, relCost: 1.0296 }, // $0.3276/$1.0296 — re-checked 2026-08-30 live (-8.6%; StreamLake still cheapest)
  // FORK 2026-08-15: `/glm-5(?![.\d])/i` blocks a following digit or dot, but NOT a
  // letter or hyphen — so it also claimed `glm-5-turbo` and `glm-5v-turbo`, both
  // $4.000, and drew them at 1.92 (2.1× too thin). Both turbos get their own row.
  { modelMatch: /glm-5v?-turbo/i, relCost: 4.0 }, // $1.200/$4.000
  { modelMatch: /glm-5(?![.\d])/i, relCost: 1.92 }, // $0.600/$1.920
  { modelMatch: /kimi-k2\.6/i, relCost: 2.228 }, // $0.5292/$2.228 — re-checked 2026-08-29 live (-44%; Baidu cheapest, was StreamLake $0.950/$4.000)
  { modelMatch: /kimi-k2\.7/i, relCost: 3.4 }, // $0.670/$3.400 — re-checked 2026-08-22 (was 3.5)
  { modelMatch: /qwen3\.6-max-preview/i, relCost: 6.162 }, // $1.027/$6.162 — added 2026-08-22
  { modelMatch: /qwen3\.6-plus/i, relCost: 1.95 }, // $0.325/$1.950
  // RE-CHECKED 2026-08-29 live endpoints: DeepSeek now serves deepseek-v4-flash-vision-exp-20260821
  // at $0.220/$0.660 — confirmed via /api/v1/models/deepseek/deepseek-v4-flash-vision-exp/endpoints.
  // The 2026-08-27 "correction" to $1.32 was wrong; the $0.66 this pass wrote is real.
  { modelMatch: /deepseek-v4-flash-vision/i, relCost: 0.66 }, // $0.220/$0.660 — re-checked 2026-08-29 live (-50% vs $1.320; new model ID with date suffix)
  { modelMatch: /deepseek-v4-flash-0731/i, relCost: 0.0899 }, // $0.0449/$0.0899 — re-checked 2026-08-29 live (-25%; Baidu cheapest, was OpenInference $0.060/$0.120)
  { modelMatch: /deepseek-v4-flash(?!-)/i, relCost: 0.168 }, // $0.0679/$0.168 — re-checked 2026-08-29 live (undated slug, DigitalOcean cheapest; was 0.159)
  // FORK 2026-08-23: openrouter/openai/gpt-5.3-codex is metered at $1.75/$14.00.
  // Without this row the generic /gpt-5/i catch-all (0.0893) would underprice it by
  // 157× against the actual metered rate. Must be scoped to the openrouter/ prefix so
  // the github-copilot/gpt-5.3-codex row above keeps its Copilot-adjusted price.
  { modelMatch: /openrouter\/openai\/gpt-5\.3-codex/i, relCost: 14.0 }, // $1.75/$14.00
  { modelMatch: /kimi/i, relCost: 15 }, // $3/$15, cache read $0.30
  { modelMatch: /qwen3\.8-max/i, relCost: 6.0 }, // $2/$6, cache read $0.25
  { modelMatch: /qwen3\.7-max/i, relCost: 4.425 }, // $1.475/$4.425, cache read $0.295
  { modelMatch: /glm/i, relCost: 3.036 }, // GLM generic fallback (glm-5.1/5.2/5.3 have specific rows above)
  { modelMatch: /deepseek.*flash/i, relCost: 0.168 }, // $0.0679/$0.168 — generic fallback (re-checked 2026-08-29; was 0.159)

  // ── FORK 2026-08-30 (the architect: "update it with the newest models in the market") ──
  // Every figure below read off the LIVE OpenRouter catalog this pass (http=200,
  // 396 models, 655,423 bytes) — id, price AND context window from /api/v1/models,
  // never a price page. That is the rule the Kimi K3 miss bought ($2.90/$14 on
  // every price page, $3.00/$15 actually billed).
  //
  // claude-opus-5-fast MUST STAY IN THIS BLOCK, above the native `/opus/i` row.
  // Anthropic's fast mode is sold METERED at $10/$50 — 2x regular Opus 5, per
  // OpenRouter's own description ("identical capabilities with higher output speed
  // at 2x pricing"). The native row prices an Opus token at the Max 20x amortized
  // €0.2232, so if `/opus/i` won here a CASH route would draw at a subscription
  // rate and understate it by 224x — the same regex-order failure class as the
  // glm-5-turbo and nex-n2-mini leaks above.
  { modelMatch: /claude-opus-5-fast/i, relCost: 50.0 }, // $10.000/$50.000 OR, ctx 1M
  { modelMatch: /nemotron-3\.5-lightning/i, relCost: 0.2 }, // $0.080/$0.200 OR, ctx 262k
  { modelMatch: /ling-3\.0-flash/i, relCost: 0.063 }, // $0.021/$0.063 OR, ctx 262k
  { modelMatch: /longcat-2\.0/i, relCost: 1.2 }, // $0.300/$1.200 OR, ctx 1.05M

  // ── Native / non-Copilot paths — SUBSCRIPTION, so relCost is amortized ──
  // Anthropic: Max 20x ÷ MEASURED trailing-30d burn, weighted with the renderer's own
  // blend (output + 0.2·input), then split by the PUBLIC sticker ratios (Haiku $5 /
  // Sonnet 5 $10 / Opus 5 $25 / Fable $50 → 0.5 / 1 / 2.5 / 5) — NOT the .3/1/5/10
  // frozen at the Opus-4.1 era ($75 out).
  //   measured 2026-08-12, trailing 30d: 6,291 Mtok in + 34.2 Mtok out over 23,354
  //   turns → 1,292 Mtok weighted → 3,323 Mtok-sonnet-eq.
  // FORK 2026-08-13 (the architect: "consider an average of 75% usage"). The denominator is
  // no longer raw measured burn but the QUOTA CEILING × his stated utilisation, which
  // is the number he actually reasons with. Derived end to end from live data:
  //   · live `budget.usage` 2026-08-12 16:36 UTC: seven_day = **70%**, window opened
  //     2026-08-06 15:59 UTC.
  //   · our burn inside exactly that window, in the RENDERER's own blend
  //     (output + 0.2·input), split by public sticker ratios (.5/1/2.5/5):
  //     opus 204.6 + sonnet 11.2 = **522.7 Mtok-sonnet-eq** — which IS that 70%.
  //   · ceiling = 522.7 / 0.70 = 746.7 eq-Mtok/week; at 75% usage = 560.0 consumed.
  //   · €50/week (€200/mo ÷ ~4 weeks) / 560.0 = **€0.0893 per sonnet-eq Mtok**.
  // Every Anthropic row moves ×1.48 against the 2026-08-12 values, and sonnet comes
  // back OFF the floor (0.35 → 0.52px). Opus 1.30px against qwen3.8's 34.88px: 27×
  // the width for 27× the cash, which is the linear axis doing its job.
  //
  // READ THIS BEFORE TRUSTING THE NUMBER: it is an AVERAGE, not a MARGINAL price.
  // At 75% usage there is headroom, so the true cost of the next Anthropic token is
  // €0 until the cap. Dividing a flat fee by usage measures how well a seat is used,
  // not what a model costs — see the OpenAI rows below, where the same arithmetic
  // makes Sol look 48× Opus purely because that seat sits idle.
  { modelMatch: /fable/i, relCost: 0.4464 },
  { modelMatch: /opus/i, relCost: 0.2232 },
  { modelMatch: /sonnet/i, relCost: 0.0893 },
  { modelMatch: /haiku/i, relCost: 0.0446 },
  // OpenAI gpt-5.6 trio (ChatGPT Business seat, codex provider) — sticker out ÷ 4.65.
  // FORK 2026-08-12: Terra is $12 out (not $15) and Luna is $1.20 (not $6) per
  // developers.openai.com/api/docs/pricing. Luna being 5× wrong mattered most —
  // it was the pixel anchor for the whole scale.
  //
  // WHY THESE STAY ON THE ÷4.65 BLANKET WHILE ANTHROPIC IS MEASURED — the architect
  // asked why Sol draws so much dearer than Opus when the two feel comparable in use.
  // He is right about the models: at PUBLIC sticker Sol is $30 out against Opus 5's
  // $25 — **1.2×**. The panel says 43×, and measuring the OpenAI seat the same way we
  // measure Anthropic says **48×**, so the blanket is not the culprit. The culprit is
  // UTILISATION: over the same 30 days the Anthropic seat did 3,323 sonnet-eq Mtok
  // and the OpenAI seat did **3.6** sol-eq Mtok — 924× less work for a comparable
  // fee. Amortising a flat fee over a nearly idle seat is also numerically unstable:
  // one more Sol session moves that rate ~12%. So the measured value (€7.23) is NOT
  // adopted here — it would be a more precise answer to the wrong question. This
  // column is meant to say "how much cash does this token cost", and for any seat
  // with headroom the answer is ~zero regardless of provider.
  // OPEN, for the architect: either (a) leave the blanket and accept that the
  // subscription block encodes assumed-utilisation, (b) measure every seat and accept
  // that idle seats draw thick, or (c) split the channel so width = metered cash only
  // and prepaid models share one thin band ordered by sticker. Costed in bug-log
  // 2026-08-12 [panels]. Do NOT half-migrate this — mixing a measured Anthropic rate
  // with a blanket OpenAI one is exactly what produced the 43× the architect caught.
  //
  // AND THE FACT THAT UNDERMINES ANY per-token AMORTISATION HERE: **neither plan
  // meters tokens at all.** `memory/chatgpt-usage.json` (fetched 2026-08-12 10:01)
  // reports `limit_requests: 100` weekly with `limit_tokens: null` — a REQUEST quota,
  // and `utilization_pct: 2` with 98/100 remaining, i.e. the seat is close to idle.
  // `memory/claude-usage.json` reports five_hour / seven_day / seven_day_opus
  // UTILISATION WINDOWS, again no token quota (that file is stale — fetchedAt
  // 2026-04-03 — so it cannot confirm a current figure either). So "N% of my token
  // quota" is not a quantity either vendor defines; every per-token subscription rate
  // in this table divides by a denominator we invented. Treat these four values as an
  // ACCOUNTING CONVENTION, never as a price, and never compare them to a metered row
  // without saying which is which.
  // ══ FORK 2026-08-13 — THE ÷4.65 BLANKET IS GONE. the architect: "How can Sol cost so much
  // more than Fable? There must be a mistake here somewhere." There was, and it was
  // an INVERSION, not a magnitude error. Claude Fable 5 is the dearest model we can
  // reach ($50/Mtok out) and drew at 2.60px; gpt-5.6-sol ($30) drew at 37.50px —
  // Sol **14.4× thicker than a model 1.67× its price**, an end-to-end error of 24×.
  //
  // Neither number was wrong on its own terms. Fable sat on the MEASURED Anthropic
  // basis; Sol sat on the INVENTED `÷ 4.65` blanket ("9.3× price→API-value quota at
  // 50% use" — a July guess with no source). Two units in one column, which is the
  // same defect that made this panel recommend the model behind a $146 bill.
  //
  // THE FIX: one basis for EVERY prepaid seat. relCost = MEASURED_UNIT × (public
  // sticker output ÷ Sonnet 5's $10), where MEASURED_UNIT = **€0.0893 per sonnet-eq
  // Mtok** — the same figure the Anthropic rows use, derived from the live 70%
  // `seven_day` reading, our burn inside that exact window, and 75% average usage.
  // Every prepaid model is now ranked by its OFFICIAL price, on a unit measured from
  // the one seat we can actually meter. Fable 2.60px > Sol 1.56px, ratio 1.67× —
  // exactly the sticker ratio. The last invented number in this table is gone.
  //
  // WHAT THIS DELIBERATELY DOES NOT ENCODE: that the OpenAI seat is barely used
  // (2% utilisation, 2026-08-12). That is a real fact and a real waste, but it answers
  // "is this subscription worth it?", not "what does this model cost" — and mixing the
  // two is what produced the inversion above. Seat efficiency belongs in its own view.
  // FORK 2026-08-30 — BASIS CORRECTION, not a price move. OpenAI publishes TWO
  // rates per gpt-5.6 model (developers.openai.com/api/docs/pricing, read today):
  // short-context and long-context. Sol carried the LONG rate ($30) while Terra
  // ($12) and Luna ($1.20) carried the SHORT one — three rows of ONE family on two
  // different bases, the same defect that made this table recommend the model
  // behind a $146 bill. All three now on the SHORT/standard rate:
  // Sol $4/$20 · Terra $2/$12 · Luna $0.20/$1.20. Long context doubles
  // ($30/$18/$1.80); relCost is a scalar and cannot say so — same caveat as grok.
  // LIVE PROMO, deliberately NOT baked here: OpenRouter bills Sol at $2/$10 today
  // and GitHub quotes $10 through 2026-09-03, while OpenAI's page says the promo
  // runs "at least through 2026-11-21". This row tracks the STANDARD list because
  // that is what the column claims to rank by; the promo is reported, not encoded.
  { modelMatch: /5\.6-sol/i, relCost: 0.1786 }, // $20 out short-ctx = 0.0893 x (20/10)
  { modelMatch: /5\.6-terra/i, relCost: 0.1072 }, // $12 out
  { modelMatch: /5\.6-luna/i, relCost: 0.0107 }, // $1.20 out
  // Google (€21.99 Google One attributed, the architect 2026-07-22).
  // gemini rows BEFORE \bmini\b so "…e-mini…" never steals a gemini id.
  // 3.6-flash ($7.50 out) is cheaper than 3.5-flash ($9), so it needs its own row.
  // FORK 2026-08-15 — RE-BASED FROM AMORTIZED TO METERED, and this is a correction,
  // not a tuning. These three rows carried the ÷112 subscription divisor every other
  // native row uses (3.5 Flash read 0.0804 against a $9 sticker), because Gemini was
  // reachable on the free Gemini-CLI tier and a free seat genuinely amortizes to ~0.
  // That tier is GONE: `gemini -p` now returns IneligibleTierError ("no longer
  // supported for Gemini Code Assist for individuals"), and Google is reached with a
  // metered API key as of tonight. A metered model priced on a subscription divisor
  // understates its cost by two orders of magnitude — the same defect recorded in
  // [eeg-cost-table-amortized], pointing the other way.
  // Prices from ai.google.dev/gemini-api/docs/pricing, output $/Mtok. The 3.7/3.6
  // rate is promotional through 2026-12-31; re-check it in January.
  // 3.7 BEFORE 3.6 BEFORE the generic flash row — regex order decides.
  { modelMatch: /gemini.*pro/i, relCost: 12.0 }, // 3.1 Pro $12 out ≤200k (doubles above)
  { modelMatch: /gemini-3\.7.*flash/i, relCost: 3.75 }, // $0.75/$3.75 (promo → 2026-12-31)
  { modelMatch: /gemini-3\.6.*flash/i, relCost: 3.75 }, // $0.75/$3.75 (promo → 2026-12-31)
  { modelMatch: /gemini.*flash/i, relCost: 9.0 }, // 3.5 Flash $1.50/$9.00
  // Catch-all for an unrecognised "*-mini": assume the dearer current-generation
  // member (gpt-5.4-mini $4.50, not gpt-5-mini $2) so it is never under-drawn.
  { modelMatch: /\bmini\b/i, relCost: 0.0402 },
  { modelMatch: /gpt-5\.5/i, relCost: 0.2679 }, // $30 out
  { modelMatch: /gpt-5\.4(?!-mini|-nano)/i, relCost: 0.134 }, // $15 out
  { modelMatch: /gpt-5/i, relCost: 0.0893 }, // $10 out
  // xAI grok-4.5 (SuperGrok) — $6 out BELOW 200k context. Above 200k xAI doubles
  // every rate ($4/$12); relCost is a scalar and cannot say that, so this row
  // UNDERSTATES any run with a long context. See bug-log 2026-08-12 [panels].
  { modelMatch: /grok|xai/i, relCost: 0.0536 }, // $6 out
  // FORK 2026-06-25 (the architect scope C): local housekeeping tool calls (grep/read/edit/
  // plain bash) — effectively free, drawn as the thinnest possible gray hairline.
  // FORK 2026-08-04 (the architect, found while rescaling to Luna=1.5px): the anchor was
  // `^tool:local$`, but eegCostKey PREFIXES the provider — eegToolIdentity returns
  // {provider:"tool", model:"tool:local"}, so the key is "tool/tool:local" and the
  // anchored rule NEVER matched. Every grep/read/edit therefore fell through to
  // EEG_DEFAULT_REL_COST and drew as thick as a mid-tier model — the exact
  // "housekeeping out-shouts a provider call" failure the hairline exists to
  // prevent. Its test had been red since the rule was written. Allow the prefix.
  // FORK 2026-08-12: was 0.3, chosen to sit under everything on a LINEAR scale. Once
  // the Anthropic rows became honest (haiku 0.0401) that put local grep ABOVE opus,
  // and on the log axis it would have drawn thicker still. Local compute costs
  // nothing, so the value is now nominal-zero and it floors by arithmetic, not luck.
  { modelMatch: /(?:^|\/)tool:local$/i, relCost: 0.001 },
];
// Unknown model → assume it is METERED and mid-frontier (between glm-5.2's 1.98 and
// qwen3.7's 4.425). Since 2026-08-13 every PREPAID row sits below 0.45, so this value
// also guarantees an unrecognised model never masquerades as subscription-cheap.
export const DEFAULT_REL_COST = 2.58;

/**
 * Build the lookup key. Prefer full "provider/model" refs so provider-scoped rows
 * (github-copilot/*, openrouter/*) can fire; a bare name falls through to the
 * native/subscription rows.
 */
export function relCostKey(model: string, provider?: string): string {
  const m = (model || "").trim();
  if (!m) return m;
  if (m.includes("/")) return m;
  const p = (provider || "").trim();
  return p ? `${p}/${m}` : m;
}

/**
 * Effective EUR/Mtok-output for a model. FIRST MATCH WINS — see the order note in
 * the file header before touching REL_COST_TABLE.
 */
export function relCostFor(model: string, provider?: string): number {
  const key = relCostKey(model, provider);
  for (const row of REL_COST_TABLE) {
    if (row.modelMatch.test(key)) return row.relCost;
  }
  return DEFAULT_REL_COST;
}
