// src/shared/aa-effort-index.ts
// MOVED 2026-09-02 from tinker-ui/src/panels/ so the gateway router (THALAMUS) and the
// chart read ONE table. The panel path re-exports this module.
// Artificial Analysis Intelligence Index per (model family, thinking effort).
//
// Source: https://artificialanalysis.ai/leaderboards/models
// Retrieved: 2026-09-07T03:45:47+00:00 (643 slugs, 630 scored; Opus 4.8 max 46.4375→47.7797,
// Fable 5.1 lower rungs up ~3pts, Muse Spark 1.1 xhigh 43.2876→41.1636. gpt-6-astra still
// chart-only — Codex 0.150.1 upgrade-required; control gpt-6-astra-9-9 fails differently).
//
// HONESTY (the user 2026-08-27): a number is here because AA published it against a
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
// the user, the same evening: "You must certainly be able to find other benchmarks,
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
  "claude-fable-5": { max: 53.1913 },
  "claude-fable-5-1": {
    low: 50.9066,
    medium: 52.7648,
    high: 54.4555,
    xhigh: 56.2441,
    max: 56.7581,
  },
  "claude-opus-4-6-adaptive": { max: 36.4072 },
  "claude-opus-4-7": { max: 44.2905 },
  "claude-opus-4-8": { max: 47.7797 },
  "claude-opus-5": { low: 43.8062, medium: 49.5216, high: 52.0304, xhigh: 53.3699, max: 54.0539 },
  "claude-sonnet-4-6-adaptive": { max: 38.4674 },
  "claude-sonnet-5": { max: 45.1096 },
  "deepseek-v4-flash": { max: 40.8391 },
  "deepseek-v4-flash-0420": { high: 30.4205, max: 30.725 },
  "deepseek-v4-flash-vision": { max: 40.6858 },
  "deepseek-v4-pro": { max: 42.1133 },
  // AA's 2026-09-07 max (34.5458) sits BELOW its own high (34.6476). That is not a
  // ladder — omitting max rather than filing a decreasing rung, which would invert
  // the estimate clamp (xhigh would have to sit in an empty interval).
  "deepseek-v4-pro-0424": { high: 34.6476 },
  "gemini-3-5-flash": { minimal: 28.0263, medium: 38.002, high: 39.7284 },
  "gemini-3-5-flash-lite": { high: 27.5743 },
  "gemini-3-6-flash": { high: 40.287 },
  "gemini-3-7-flash": { low: 41.0619, medium: 43.3776, high: 45.242 },
  "gemini-3-8-flash": { low: 40.9508, medium: 46.773, high: 47.0713 },
  "gemini-3-pro": { low: 26.2749, high: 32.4459 },
  "glm-5-2": { max: 42.0812 },
  "glm-5-3": { max: 48.584 },
  // FORK 2026-09-02: on the panel since 2026-08-27 with a headline score, but absent
  // from THIS table until now, so its one rung drew on the dashed cost rail instead of
  // as a measurement. It was missed because the extractor read the effort out of AA's
  // DISPLAY NAME, and AA prints this one as plain "GLM-5.3-Flash" with no "(max)"
  // parenthetical — while the page's own payload tags it `effort.slug: "max"`. Read
  // the structured field, not the name; see the retrieval note at the top.
  "glm-5-3-flash": { max: 46.2237 },
  "gpt-5": { minimal: 11.1364, low: 24.4494, medium: 26.912, high: 27.0852 },
  "gpt-5-1": { high: 29.0522 },
  "gpt-5-1-codex": { high: 27.8556 },
  "gpt-5-1-codex-mini": { high: 23.952 },
  "gpt-5-2": { medium: 30.9224, xhigh: 34.9528 },
  "gpt-5-2-codex": { xhigh: 33.0033 },
  "gpt-5-3-codex": { xhigh: 36.9388 },
  "gpt-5-4": { low: 32.0521, xhigh: 42.8257 },
  "gpt-5-4-mini": { medium: 23.1718, xhigh: 31.9167 },
  "gpt-5-4-nano": { medium: 23.5024, xhigh: 30.9226 },
  "gpt-5-5": { low: 35.2592, medium: 41.219, high: 44.1092, xhigh: 45.6173 },
  "gpt-5-6-luna": { low: 25.754, medium: 30.1858, high: 37.3627, xhigh: 41.5752, max: 43.4415 },
  "gpt-5-6-sol": { low: 40.8432, medium: 45.9687, high: 48.2979, xhigh: 49.8448, max: 51.2552 },
  "gpt-5-6-terra": { low: 32.4033, medium: 37.2269, high: 41.2997, xhigh: 44.3904, max: 46.7688 },
  // GPT-6 Astra on AA (headline 54.6573 after the 2026-09-05 rescale; still between Grok 4.6
  // and Kimi K3). Effort taken from AA slug suffixes + display-name effort tokens;
  // the non-reasoning row is excluded.
  //
  // CORRECTED the same day (the user: "add it to the graph and table"). This note said
  // "NOT plotted ... no verified price half". The ROUTE half is still missing and the
  // probes below prove it, but the PRICE half was never missing — it was only looked
  // for in the two places we buy through. OpenAI publishes $10 in / $50 out on
  // developers.openai.com/api/docs/pricing, which is the same published-sticker basis
  // every other metered dot on the chart already stands on. Absent from OUR catalog is
  // not absent from the market, and conflating the two is what kept a shipped frontier
  // model off a chart whose whole subject is price.
  "gpt-6-astra": { low: 49.3199, medium: 52.2467, high: 53.3589, xhigh: 54.3149, max: 54.6573 },
  "gpt-5-codex": { high: 29.1745 },
  "gpt-5-mini": { minimal: 8.3511, medium: 24.2225, high: 18.4192 },
  "gpt-5-nano": { minimal: 2.4005, medium: 12.8706, high: 13.6983 },
  "gpt-oss-120b": { low: 8.9219, high: 15.572 },
  "gpt-oss-20b": { low: 8.4396, high: 9.1365 },
  "grok-3-mini-reasoning": { high: 16.2074 },
  "grok-4-3": { low: 28.5265, medium: 29.0643, high: 29.9365 },
  "grok-4-5": { high: 45.4782 },
  "grok-4-6": { low: 41.6074, medium: 48.8471, high: 50.5768, xhigh: 49.9162 },
  inkling: { xhigh: 32.1665 },
  "k2-v2": { low: 2.9257, medium: 6.6128, high: 8.2899 },
  "kimi-k3": { low: 37.1024, max: 50.2337 },
  "muse-glimmer": { high: 24.3773 },
  "muse-spark-1-1": { xhigh: 41.1636 },
  "muse-spark-1-2": { xhigh: 46.8372 },
  "muse-spark-1-3": { xhigh: 51.553, max: 52.9531 },
  "nova-2-0-lite-reasoning": { low: 11.7451, medium: 12.8741, high: 14.3027 },
  "nova-2-0-omni-reasoning": { low: 10.5541, medium: 14.7275 },
  "nova-2-0-pro-reasoning": { low: 13.3503, medium: 15.5079 },
  "o3-mini": { high: 9.6314 },
  "o4-mini": { high: 19.1144 },
  "qwen3-8-27b": { low: 33.7632, medium: 35.1815, xhigh: 41.4059 },
  "sarvam-105b": { high: 6.1546 },
  "sarvam-30b": { high: 1.1002 },
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
