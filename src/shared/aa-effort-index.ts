// src/shared/aa-effort-index.ts
// MOVED 2026-09-02 from tinker-ui/src/panels/ so the gateway router (THALAMUS) and the
// chart read ONE table. The panel path re-exports this module.
// Artificial Analysis Intelligence Index per (model family, thinking effort).
//
// Source: https://artificialanalysis.ai/leaderboards/models
// Retrieved: 2026-10-03T03:45:22+00:00 (689 rows; 2026-10-03 re-scored claude-sonnet-5-5, kimi-k3 low, deepseek-v4-flash-0420 high, added grok-4-7 low; earlier 2026-09-29: 679 slugs, 670 scored). Effort recovered from AA's structured effort.slug. Headline scores of already-plotted families unchanged vs 09-28. New family: claude-sonnet-5-5 (AA 55.978). GLM 5.3 Flash / MiMo-V2.6-Pro still have no effort tag; their existing max cells are kept (same headline number).
//
// HONESTY (the architect 2026-08-27): a number is here because AA published it against a
// named effort — read from the payload's `effort.slug`, NOT from a parenthetical in
// the display name, which is lossy (see the re-derivation note below). Null-scored
// AA variants are omitted — we do not approximate. A model-effort pair missing from
// this table MUST NOT be drawn at an invented Y. Non-reasoning rows are a different
// mode, not an effort stop.
//
// Family key = AA slug with a trailing -<effort> stripped, dots already hyphens.
//
// HOW TO RE-DERIVE THIS TABLE (2026-09-02, after a full audit against the live site).
// Take the effort from AA's STRUCTURED payload field `effort.slug`, never from the
// display name's "(high)" / "High Effort" parenthetical. The name is lossy: AA prints
// GLM-5.3-Flash with no parenthetical at all while tagging it `effort: max`, so a
// name-regex extractor silently drops the row. Two further rules the audit confirmed:
//   · Do NOT key on the payload's `release.slug`. It over-merges — it files
//     `deepseek-v4-flash-vision` under `deepseek-v4-flash`, which would overwrite one
//     model's score with another's. Strip the effort suffix off the model slug instead.
//   · EXCLUDE any row whose slug or name says "non-reasoning". AA tags several of
//     those with an effort (claude-sonnet-5-non-reasoning carries `high`), and folding
//     them in would file a different MODE as an effort stop — e.g. Sonnet 5 would gain
//     a bogus high=42.57 sitting below its own max=55.26.
// Audited 2026-09-02 against the live payload (631 slugs, 132 effort-tagged and
// scored): every family already here matched exactly — no drift, no missing effort.
// The only genuinely unscored variants AA lists are claude-sonnet-5 {low,medium,high,
// xhigh}, gpt-5-4-pro and gpt-5-5-pro, all `intelligenceIndex: null`. Correctly absent.
//
// ─── WHY MANY MODELS USED TO DRAW AS A HORIZONTAL LINE, AND WHAT CHANGED ───
// A flat constellation = the model has a vendor effort ladder but ≤1 AA-measured
// rung. Census 2026-09-02 over the 99 plotted models: 26 real multi-point curves, 28
// single-stop, 45 flat, 193 rungs with no AA number.
//
// AA itself has no more to give: its data model is ONE ROW PER (model, effort) THEY
// ACTUALLY RAN, it runs a full ladder only for selected flagships (Opus 5, Fable 5.1,
// the GPT-5.6 trio, GPT-5.5, Grok 4.6), and no other site publishes the Intelligence
// Index — it is AA's own nine-eval composite. That part of the 2026-09-02 morning
// finding stands.
//
// What was WRONG in that finding was the conclusion "so there is nothing to draw".
// the architect, the same evening: "You must certainly be able to find other benchmarks,
// other intelligence index measurements, even if you have to approximate the ones we
// don't know for sure, right?" He is right, and the approximation lives in
// `aa-effort-estimate.ts` (GENERATED — see model-rank-refresh/scripts/
// estimate_effort_index.py): Epoch AI's benchmarking hub runs GPQA, CritPt, HLE,
// DeepSWE, ARC-AGI, FrontierMath, SWE-bench … PER EFFORT, and LMArena rates some
// effort variants separately. Each benchmark is fitted against AA on the cells both
// scored (R² 0.55–0.90), the fit predicts the missing cells, a ladder-shape prior from
// AA's own multi-rung families fills the rest, and the result is clamped into ladder
// order. Every estimate carries a 1σ and names its basis.
//
// THE RULE THAT SURVIVES: an estimate is never a measurement. This file holds only
// what AA published; `aaScoreAt` returns undefined for everything else and the chart
// draws an estimated rung DOTTED with "ESTIMATE" in the tooltip, a measured rung
// solid, and a rung with neither on the dashed cost rail. A measured cell is never
// overwritten by an estimate (`aaEstimateAt` refuses).
//
// WHAT *IS* STILL WORTH RE-CHECKING, because it hides real data behind a join miss: a
// model can draw flat because our FAMILY KEY does not match AA's slug (the `-adaptive`
// pair below), or because AA scored an effort the model's
// ROUTE does not expose (Copilot resells Anthropic without `max`). The first is a bug
// and is fixed here; the second is correct behaviour. Both are found by diffing our
// ladder against AA's live families — see the model-catalog-refresh recipe.

import { AA_EFFORT_ESTIMATE, type AaEstimate } from "./aa-effort-estimate.js";

export type AaEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const AA_EFFORT_INDEX: Record<string, Partial<Record<AaEffort, number>>> = {
  // FORK 2026-09-02 (the architect) dropped Fable 5.0 from the model PICKER as superseded by
  // Fable 5.1. Its measured AA rung is KEPT here on purpose: this table is reference
  // measurement data, not a dot source (that is AA_INTELLIGENCE_INDEX in tinker-ui/src/app.ts,
  // where the entry WAS removed, alongside openclaw.json). The measurement stayed true when
  // the model was retired, and smart-cost-chart.test.ts uses it as its documented sample of
  // the "AA scored one rung, the rest are estimates" shape that 60 of 99 models are in.
  "claude-fable-5": { max: 49.6258 },
  "claude-fable-5-1": {
    low: 46.8163,
    medium: 48.9206,
    high: 51.1516,
    xhigh: 53.2033,
    max: 53.3549,
  },
  "claude-opus-4-6-adaptive": { max: 31.9457 },
  "claude-opus-4-7": { max: 40.6898 },
  "claude-opus-4-8": { max: 41.7899 },
  "claude-opus-5": { low: 39.3543, medium: 44.8253, high: 48.1219, xhigh: 49.6774, max: 50.7771 },
  "claude-opus-5-5": { low: 42.3078, medium: 51.2435, high: 53.5832, xhigh: 55.9874, max: 57.6224 },
  "claude-sonnet-4-6-adaptive": { max: 30.0576 },
  "claude-sonnet-5": { low: 24.2638, medium: 28.0531, high: 31.6623, xhigh: 34.3842, max: 38.1639 },
  "claude-sonnet-5-5": {
    low: 35.8682,
    medium: 40.8387,
    high: 46.7534,
    xhigh: 51.8956,
    max: 56.0001,
  },
  "deepseek-v4-1-flash": { max: 39.4562 }, // AA tagged effort.slug=max on 2026-09-17 (was null)
  "deepseek-v4-flash": { max: 34.3305 },
  "deepseek-v4-flash-0420": { high: 24.384 }, // AA also lists an untagged headline 24.1673, below high — omitted
  "deepseek-v4-flash-vision": { max: 34.8391 },
  "deepseek-v4-pro": { max: 35.9968 },
  // AA's 2026-09-07 max sat BELOW its own high, so max was omitted. Today max
  // (30.8651) is above high (30.1055) again, so both rungs are filed.
  "deepseek-v4-pro-0424": { high: 30.1055, max: 30.4497 },
  "gemini-3-5-flash": { minimal: 23.8488, medium: 33.6326, high: 32.5983 },
  "gemini-3-5-flash-lite": { high: 22.1685 },
  "gemini-3-6-flash": { high: 33.9786 },
  "gemini-3-7-flash": { low: 36.9459, medium: 39.6178, high: 39.0595 },
  "gemini-3-8-flash": { low: 33.4548, medium: 39.774, high: 40.9262 },
  "gemini-3-pro": { low: 22.3196, high: 27.958 },
  "glm-5-2": { max: 33.7055 },
  "glm-5-3": { low: 34.299, max: 44.7774 },
  // FORK 2026-09-02: on the panel since 2026-08-27 with a headline score, but absent
  // from THIS table until now, so its one rung drew on the dashed cost rail instead of
  // as a measurement. It was missed because the extractor read the effort out of AA's
  // DISPLAY NAME, and AA prints this one as plain "GLM-5.3-Flash" with no "(max)"
  // parenthetical — while the page's own payload tags it `effort.slug: "max"`. Read
  // the structured field, not the name; see the retrieval note at the top.
  "glm-5-3-flash": { max: 41.8075 },
  "gpt-5": { minimal: 11.4482, low: 20.7856, medium: 22.8693, high: 22.9828 },
  "gpt-5-1": { high: 24.7358 },
  "gpt-5-1-codex": { high: 23.6973 },
  "gpt-5-1-codex-mini": { high: 20.3782 },
  "gpt-5-2": { medium: 26.501, xhigh: 30.4482 },
  "gpt-5-2-codex": { xhigh: 28.5017 },
  "gpt-5-3-codex": { xhigh: 32.5028 },
  "gpt-5-4": { low: 27.5773, xhigh: 38.9756 },
  "gpt-5-4-mini": { medium: 19.7484, xhigh: 24.0682 },
  "gpt-5-4-nano": { medium: 20.0139, xhigh: 20.7197 },
  "gpt-5-5": { low: 30.7095, medium: 33.8044, high: 36.9794, xhigh: 38.3556 },
  "gpt-5-6-luna": { low: 21.0125, medium: 25.0359, high: 32.1196, xhigh: 34.5553, max: 37.3244 },
  "gpt-5-6-sol": { low: 33.4731, medium: 39.2364, high: 42.3461, xhigh: 44.0089, max: 46.9727 },
  "gpt-5-6-terra": { low: 27.4962, medium: 30.0938, high: 34.2377, xhigh: 37.9513, max: 42.0829 },
  // GPT-6 Astra on AA (headline 52.6737 after the 2026-09-08 rescale; still between Grok 4.6
  // and Kimi K3). Effort taken from AA slug suffixes + display-name effort tokens;
  // the non-reasoning row is excluded.
  //
  // ON THE PICKER 2026-09-09 as openai-codex/gpt-6-astra (ChatGPT seat). The $10/$50
  // list remains the triangle; the circle is the amortised seat unit.
  "gpt-6-astra": { low: 45.7819, medium: 49.5704, high: 50.9191, xhigh: 52.3863, max: 52.6737 },
  // FORK 2026-09-23: gpt-6-sol + gpt-6-luna launched 2026-09-22 (AA fetched same day).
  "gpt-6-sol": { low: 34.1549, medium: 39.8119, high: 42.4005, xhigh: 44.2449, max: 47.6305 },
  "gpt-6-luna": { low: 21.5262, medium: 29.9252, high: 32.9282, xhigh: 34.5587, max: 38.1245 },
  // FORK 2026-09-30: gpt-6.1-sol, AA fetched 2026-09-30 03:57Z. Seat id openai-codex/gpt-6.1-sol.
  "gpt-6-1-sol": { low: 42.0836, medium: 47.7833, high: 50.2378, xhigh: 51.0378, max: 51.8333 },
  "gpt-5-codex": { high: 24.8819 },
  "gpt-5-mini": { minimal: 9.9062, medium: 20.5992, high: 16.7731 },
  "gpt-5-nano": { minimal: 7.0888, medium: 12.4803, high: 12.9922 },
  "gpt-oss-120b": { low: 10.2106, high: 11.6028 },
  "gpt-oss-20b": { low: 9.953, high: 8.9675 },
  "grok-3-mini-reasoning": { high: 14.6213 },
  "grok-4-3": { low: 24.2959, medium: 24.7817, high: 24.8801 },
  "grok-4-5": { high: 38.8121 },
  "grok-4-6": { low: 35.1247, medium: 42.8363, high: 44.3113, xhigh: 44.1998 },
  "grok-4-7": { low: 42.2167, high: 46.3322, xhigh: 46.4466 }, // grok-4-7-high + untagged headline on xhigh (vendor top; ladder has no max)
  "mimo-v2-6-pro": { max: 46.3242 },
  inkling: { xhigh: 24.9848 },
  "k2-v2": { low: 7.3113, medium: 9.016, high: 9.8739 },
  "kimi-k3": { low: 30.0667, max: 43.5938 },
  "muse-glimmer": { high: 17.4754 },
  "muse-spark-1-1": { xhigh: 33.7298 },
  "muse-spark-1-2": { xhigh: 39.5759 },
  "muse-spark-1-3": { xhigh: 45.0733, max: 48.0923 },
  "nova-2-0-lite-reasoning": { low: 11.8041, medium: 12.4824, high: 13.3741 },
  "nova-2-0-omni-reasoning": { low: 11.1141, medium: 13.6465 },
  "nova-2-0-pro-reasoning": { low: 12.7755, medium: 14.1555 },
  "o3-mini": { high: 10.9644 },
  "o4-mini": { high: 16.6531 },
  "qwen3-8-27b": { low: 26.2048, medium: 27.5508, xhigh: 33.6963 },
  "quasar-438b": { max: 26.7373 }, // AA-only 2026-09-19; not on OpenRouter
  "ring-2-6-1t": { xhigh: 16.6172 },
  "sarvam-105b": { high: 8.7906 },
  "sarvam-30b": { high: 6.5597 },
  "sarvam-m-reasoning": { high: 5.3107 },
  "solar-open-100b-reasoning": { high: 10.3644 },
  "solar-pro-2-preview-reasoning": { high: 9.07 },
  "solar-pro-2-reasoning": { high: 7.4917 },
  "solar-pro-3": { high: 7.8155 },
  "step-3-7-flash": { high: 19.4813 },
  "gemini-3-1-flash-lite-preview": { high: 15.5543 },
  "hypernova-60b": { high: 11.738 },
  "k2-think-v2": { high: 11.4957 },
  "mercury-2": { high: 13.7691 },
  "mistral-medium-3-5": { high: 14.1889 },
};

/** Dated / preview ids that share an AA family slug. Explicit, not guessed. */
export const AA_FAMILY_ALIASES: Record<string, string> = {
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-v4-flash-vision",
  "deepseek-v4-pro-0813": "deepseek-v4-pro",
  // OpenRouter id is dotted (`deepseek-v4.1-flash`); aaFamilyOf already hyphenates it
  // onto the AA family `deepseek-v4-1-flash` added 2026-09-17. Keep this in case a
  // caller looks the dotted tail up before hyphenation.
  "deepseek-v4.1-flash": "deepseek-v4-1-flash",
  "gemini-3-pro-preview": "gemini-3-pro",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-fable-5.1": "claude-fable-5-1",
  "claude-opus-5.5": "claude-opus-5-5",
  // FORK 2026-09-02: AA files Anthropic's 4.6 pair under an `-adaptive` slug
  // ("Claude Sonnet 4.6 (Adaptive Reasoning, Max Effort)"), while our config and
  // every other surface call them `claude-sonnet-4-6` / `claude-opus-4-6`. Without
  // these two lines the family lookup missed and BOTH models drew with ZERO measured
  // rungs — the one real AA number we had for each was on disk and unreachable.
  // Sonnet 4.6's ladder exposes `max`, so this recovers a genuine measurement.
  "claude-sonnet-4-6": "claude-sonnet-4-6-adaptive",
  "claude-opus-4-6": "claude-opus-4-6-adaptive",
  // FORK 2026-09-06: OpenRouter retired `qwen/qwen3.8-max` and listed the 0902 snapshot
  // at the same $2/$6. AA still files the family as `qwen3-8-max`; without this alias the
  // new picker id would draw with ZERO measured rungs while the score sat on disk.
  "qwen3-8-max-0902": "qwen3-8-max",
  // FORK 2026-09-02 (the architect): the `claude-opus-5-fast` → `claude-opus-5` alias is gone
  // with the model. It existed because OpenRouter's fast-output Opus is the SAME brain at
  // dearer tokens, so it borrowed Opus 5's measured ladder. That route is now banned outright
  // (see src/shared/reseller-route-policy.ts) — we hold Anthropic directly on the Max 20x
  // plan, where the identical measured intelligence costs ~EUR0.15/Mtok against $10/$50 — so
  // there is no id left for the alias to resolve.
};

/** AA family key for a model ref: last path segment, dots → hyphens, then aliases. */
export function aaFamilyOf(modelId: string): string {
  const tail = (modelId.split("/").pop() ?? modelId).toLowerCase().replace(/\./g, "-");
  return AA_FAMILY_ALIASES[tail] ?? tail;
}

/** The Intelligence Index AA published for this model at this named effort, or undefined.
 *  Undefined means "AA did not publish a number" — callers MUST NOT approximate. */
export function aaScoreAt(modelId: string, effort: string): number | undefined {
  if (!effort) return undefined;
  const row = AA_EFFORT_INDEX[aaFamilyOf(modelId)];
  if (!row) return undefined;
  const v = row[effort as AaEffort];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** An ESTIMATE of the index at this effort from other public benchmarks, or undefined.
 *  Never returned for a cell AA measured — the measurement wins — so a caller can
 *  fall through `aaScoreAt` → `aaEstimateAt` → headline rail in that order. */
export function aaEstimateAt(modelId: string, effort: string): AaEstimate | undefined {
  if (!effort || aaScoreAt(modelId, effort) !== undefined) return undefined;
  const fam = aaFamilyOf(modelId);
  const row = AA_EFFORT_ESTIMATE[fam] ?? AA_EFFORT_ESTIMATE[fam.replace(/-preview$/, "")];
  const v = row?.[effort as AaEffort];
  return v && Number.isFinite(v.v) ? v : undefined;
}

export function aaNamedEfforts(modelId: string): AaEffort[] {
  const row = AA_EFFORT_INDEX[aaFamilyOf(modelId)];
  if (!row) return [];
  return (Object.keys(row) as AaEffort[]).filter((k) => typeof row[k] === "number");
}
