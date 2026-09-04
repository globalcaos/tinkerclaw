// src/shared/tokens-per-task.ts
// MOVED 2026-09-03 from tinker-ui/src/panels/smart-cost-chart.ts (the "LATER UNIT"
// thalamus-candidates.ts asked for): the gateway router and the chart now read ONE
// tokens-per-task table, because the architect's envelope is built on €/TASK, not €/token —
// "make sure to use the graph in €/task to make the envelope, not the €/token"
// (2026-09-02). A rung's task cost = €/Mtok at that effort x tokenRatio(model, effort).
// The chart re-exports these under its historical sc* names.
import { EFFORT_COST_MULT } from "./effort-cost-mult.js";

// ─── Tokens per average task ───
// Base = average OUTPUT tokens (thinking + visible) to complete one reasoning
// task at MEDIUM effort. Per-effort value = base × EEG_EFFORT_MULT — the same
// documented burn ladder the cost axis uses, because tokens ARE the cost.
//
// PROVENANCE PER ROW:
//   claude-opus-5     MEASURED — OckBench: high=6,745 · xhigh=1.44× · max=1.95×
//                     of high (200 tasks, math+coding+science). 4,497 = 6,745/1.5.
//   kimi-k3           BENCHMARK-ANCHORED — OckBench: high=12,250 (1.8× Opus 5
//                     high, rank-13 first open-weight entry). 8,167 = 12,250/1.5.
//   claude-opus-4-8   ANCHORED ESTIMATE — Anthropic: "Opus 5 generates 26%
//                     fewer tokens than Opus 4.8 at max reasoning" → 4.8 ≈
//                     Opus5 ÷ 0.74 ≈ 1.35×.
//   claude-*          ESTIMATES from the Opus 5 anchor + class (flagship bigger,
//                     sonnet leaner, haiku pays the Overthinking Tax — OckBench:
//                     small models over-generate to compensate for capacity).
//   deepseek-v4-flash ANCHORED ESTIMATE — OckBench puts DeepSeek-V4-PRO at
//                     ≈3.6× Kimi (~29k medium); FLASH is the efficiency-tuned
//                     sibling → ~0.4× of Pro.
//   qwen / glm        ESTIMATES — OckBench's Qwen3.5 flagship ran ~17.6k medium
//                     at 67.5% accuracy; newer/smarter flagships are leaner,
//                     open-weight reasoning stays verbose (open-vs-closed gap up
//                     to 26× on OckBench, 1.8× at the frontier).
//   grok-4.5          ESTIMATE — proprietary frontier class, no public per-task
//                     measurement found.
export const TOKENS_PER_TASK_RULES: { match: RegExp; base: number }[] = [
  { match: /claude-opus-5|opus-5/i, base: 4497 },
  { match: /claude-fable/i, base: 5900 },
  { match: /claude-opus-4-8|opus-4\.8/i, base: 6071 },
  { match: /claude-opus-4-7|opus-4\.7/i, base: 5500 },
  { match: /claude-sonnet/i, base: 3500 },
  { match: /claude-haiku/i, base: 2200 },
  { match: /kimi/i, base: 8167 },
  { match: /deepseek.*flash/i, base: 11600 },
  { match: /deepseek/i, base: 29300 },
  { match: /qwen3\.8/i, base: 13400 },
  { match: /qwen/i, base: 14700 },
  { match: /glm/i, base: 12000 },
  { match: /grok/i, base: 4800 },
];
const TOKENS_PER_TASK_DEFAULT = 8000;

/**
 * The normalization anchor the architect chose: Opus 5 at its HIGHEST REAL effort.
 *
 * Kept at `high` — Anthropic's documented DEFAULT for Opus 5 (effort.md,
 * 2026-08-27), not the top of the ladder. `max` is real on this model now; it is
 * just not the operating point the €/task view is pinned to. Changing this
 * would slide every task-mode dot.
 */
export const TASK_REFERENCE = { match: /claude-opus-5|opus-5/i, effort: "high" };

export function baseTokensFor(modelId: string): number {
  for (const row of TOKENS_PER_TASK_RULES) {
    if (row.match.test(modelId)) return row.base;
  }
  return TOKENS_PER_TASK_DEFAULT;
}

/** Average tokens to complete one task at the given effort level. */
export function tokensPerTaskFor(modelId: string, effortLvl: string): number {
  return baseTokensFor(modelId) * (EFFORT_COST_MULT[effortLvl] ?? 1);
}

export function tokenRatioFor(modelId: string, effortLvl: string): number {
  const ref = tokensPerTaskFor("claude-code/claude-opus-5", TASK_REFERENCE.effort);
  return tokensPerTaskFor(modelId, effortLvl) / ref;
}
