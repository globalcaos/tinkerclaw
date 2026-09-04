// src/shared/aa-effort-index.ts
// MOVED 2026-09-02 from tinker-ui/src/panels/ so the gateway router (THALAMUS) and the
// chart read ONE table. The panel path re-exports this module.
// Artificial Analysis Intelligence Index per (model family, thinking effort).
//
// Source: https://artificialanalysis.ai/leaderboards/models
// Retrieved: 2026-09-02T09:29:29+00:00 (full audit vs the live payload; added
// claude-fable-5-1 and glm-5-3-flash, no existing score moved)
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
  "claude-fable-5": { max: 62.0727 },
  "claude-fable-5-1": {
    low: 58.1487,
    medium: 60.4752,
    high: 62.4807,
    xhigh: 64.8016,
    max: 65.6529,
  },
  "claude-opus-4-6-adaptive": { max: 44.9314 },
  "claude-opus-4-7": { max: 54.9641 },
  "claude-opus-4-8": { max: 57.3304 },
  "claude-opus-5": { low: 52.4569, medium: 58.6355, high: 61.4751, xhigh: 62.5205, max: 63.0532 },
  "claude-sonnet-4-6-adaptive": { max: 48.3663 },
  "claude-sonnet-5": { max: 55.2612 },
  "deepseek-v4-flash": { max: 51.7666 },
  "deepseek-v4-flash-0420": { high: 39.0138, max: 42.1162 },
  "deepseek-v4-flash-vision": { max: 51.4736 },
  "deepseek-v4-pro": { max: 53.1977 },
  "deepseek-v4-pro-0424": { high: 43.7458, max: 45.2683 },
  "gemini-3-5-flash": { minimal: 35.782, medium: 46.6725, high: 51.9636 },
  "gemini-3-5-flash-lite": { high: 37.4387 },
  "gemini-3-6-flash": { high: 51.5819 },
  "gemini-3-7-flash": { low: 50.9423, medium: 53.4167, high: 56.0301 },
  "gemini-3-pro": { low: 33.87, high: 40.6068 },
  "glm-5-2": { max: 52.641 },
  "glm-5-3": { max: 59.5134 },
  // FORK 2026-09-02: on the panel since 2026-08-27 with a headline score, but absent
  // from THIS table until now, so its one rung drew on the dashed cost rail instead of
  // as a measurement. It was missed because the extractor read the effort out of AA's
  // DISPLAY NAME, and AA prints this one as plain "GLM-5.3-Flash" with no "(max)"
  // parenthetical — while the page's own payload tags it `effort.slug: "max"`. Read
  // the structured field, not the name; see the retrieval note at the top.
  "glm-5-3-flash": { max: 57.4592 },
  "gpt-5": { minimal: 17.3432, low: 31.8771, medium: 34.5655, high: 35.3127 },
  "gpt-5-1": { high: 37.4661 },
  "gpt-5-1-codex": { high: 35.5957 },
  "gpt-5-1-codex-mini": { high: 31.334 },
  "gpt-5-2": { medium: 38.9436, xhigh: 43.3436 },
  "gpt-5-2-codex": { xhigh: 41.2154 },
  "gpt-5-3-codex": { xhigh: 45.5117 },
  "gpt-5-4": { low: 40.177, xhigh: 53.1231 },
  "gpt-5-4-mini": { medium: 30.4823, xhigh: 40.9386 },
  "gpt-5-4-nano": { medium: 30.8432, xhigh: 39.7139 },
  "gpt-5-5": { low: 44.4981, medium: 51.4223, high: 54.6668, xhigh: 56.3067 },
  "gpt-5-6-luna": { low: 33.8546, medium: 38.9051, high: 46.9604, xhigh: 50.0587, max: 52.3181 },
  "gpt-5-6-sol": { low: 50.7315, medium: 55.5729, high: 57.3317, xhigh: 59.009, max: 60.9299 },
  "gpt-5-6-terra": { low: 41.2961, medium: 46.7559, high: 50.1131, xhigh: 52.7732, max: 56.5756 },
  "gpt-5-codex": { high: 37.0355 },
  "gpt-5-mini": { minimal: 14.3025, medium: 31.6293, high: 25.7971 },
  "gpt-5-nano": { minimal: 7.8062, medium: 19.2365, high: 20.14 },
  "gpt-oss-120b": { low: 14.9256, high: 24.1264 },
  "gpt-oss-20b": { low: 14.3991, high: 15.2252 },
  "grok-3-mini-reasoning": { high: 22.8792 },
  "grok-4-3": { low: 36.3281, medium: 36.9152, high: 37.9469 },
  "grok-4-5": { high: 55.7589 },
  "grok-4-6": { low: 51.6796, medium: 59.0064, high: 60.923, xhigh: 60.0136 },
  inkling: { xhigh: 42.2948 },
  "k2-v2": { low: 8.3795, medium: 12.4048, high: 14.2358 },
  "kimi-k3": { low: 48.2515, max: 59.6995 },
  "muse-glimmer": { high: 35.0642 },
  "muse-spark-1-1": { xhigh: 53.199 },
  "muse-spark-1-2": { xhigh: 56.7616 },
  "nova-2-0-lite-reasoning": { low: 18.0077, medium: 19.2403, high: 20.7998 },
  "nova-2-0-omni-reasoning": { low: 16.7076, medium: 21.2637 },
  "nova-2-0-pro-reasoning": { low: 19.7601, medium: 22.1156 },
  "o3-mini": { high: 15.7002 },
  "o4-mini": { high: 26.0528 },
  "qwen3-8-27b": { low: 42.8682, medium: 44.4542, xhigh: 52.0247 },
  "sarvam-105b": { high: 11.9046 },
  "sarvam-30b": { high: 6.3867 },
};

/** Dated / preview ids that share an AA family slug. Explicit, not guessed. */
export const AA_FAMILY_ALIASES: Record<string, string> = {
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-v4-flash-vision",
  "deepseek-v4-pro-0813": "deepseek-v4-pro",
  "gemini-3-pro-preview": "gemini-3-pro",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-fable-5.1": "claude-fable-5-1",
  // FORK 2026-09-02: AA files Anthropic's 4.6 pair under an `-adaptive` slug
  // ("Claude Sonnet 4.6 (Adaptive Reasoning, Max Effort)"), while our config and
  // every other surface call them `claude-sonnet-4-6` / `claude-opus-4-6`. Without
  // these two lines the family lookup missed and BOTH models drew with ZERO measured
  // rungs — the one real AA number we had for each was on disk and unreachable.
  // Sonnet 4.6's ladder exposes `max`, so this recovers a genuine measurement.
  "claude-sonnet-4-6": "claude-sonnet-4-6-adaptive",
  "claude-opus-4-6": "claude-opus-4-6-adaptive",
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
