// tinker-ui/src/panels/aa-effort-index.ts
// Artificial Analysis Intelligence Index per (model family, thinking effort).
//
// Source: https://artificialanalysis.ai/leaderboards/models
// Retrieved: 2026-08-30T03:45:36.175885+00:00 (re-verified 2026-08-30 — no per-effort score changed)
//
// HONESTY (the architect 2026-08-27): a number is here because AA published it under a
// named effort in parentheses. Null-scored AA variants are omitted — we do not
// approximate. A model-effort pair missing from this table MUST NOT be drawn at
// an invented Y. Non-reasoning rows are a different mode, not an effort stop.
//
// Family key = AA slug with a trailing -<effort> stripped, dots already hyphens.

export type AaEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const AA_EFFORT_INDEX: Record<string, Partial<Record<AaEffort, number>>> = {
  "claude-fable-5": { max: 62.0727 },
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
  "gemini-3-6-flash": { high: 51.5819 },
  "gemini-3-7-flash": { low: 50.9423, medium: 53.4167, high: 56.0301 },
  "gemini-3-pro": { low: 33.87, high: 40.6068 },
  "glm-5-2": { max: 52.641 },
  "glm-5-3": { max: 59.5134 },
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

export function aaNamedEfforts(modelId: string): AaEffort[] {
  const row = AA_EFFORT_INDEX[aaFamilyOf(modelId)];
  if (!row) return [];
  return (Object.keys(row) as AaEffort[]).filter((k) => typeof row[k] === "number");
}
