/**
 * FORK 2026-06-11 — map an OpenClaw "think level" to Claude Code's native
 * thinking budget (`MAX_THINKING_TOKENS`).
 *
 * `MAX_THINKING_TOKENS` is a first-class Claude Code env knob (the sibling of
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` that worker.ts already pins per model): it
 * caps how many tokens the model may spend on extended-thinking blocks. Because
 * it is a native CLI knob it doesn't look like a harness tell.
 *
 * Why off/unknown -> `undefined` (and NOT 0): the caller must OMIT the env var
 * entirely in that case. Exporting `MAX_THINKING_TOKENS=0` is NOT the same as
 * "unset" — a 0 budget can disable thinking outright / be treated as an invalid
 * value, whereas leaving it unset lets Claude Code apply its own default. So
 * `undefined` is the explicit "don't set this env var" signal for the caller.
 *
 * Clamp rationale: thinking must never crowd out the actual answer. We cap the
 * budget at `modelMaxOutput - 4000` (4k headroom reserved for the reply) with a
 * 1000-token floor so a model with a tiny output ceiling still gets some
 * thinking room rather than a negative/zero budget.
 *
 * Pure + dependency-free (level is a plain string) so it is trivially testable.
 */

/** Token budget per lowercased think level. Unknown keys -> undefined (omit). */
const THINK_LEVEL_BUDGET: Record<string, number> = {
  minimal: 2000,
  low: 4000,
  medium: 8000,
  adaptive: 8000,
  high: 16000,
  xhigh: 22000,
  max: 28000,
};

/**
 * Map an OpenClaw think `level` to a `MAX_THINKING_TOKENS` value for Claude Code.
 *
 * @param level - the OpenClaw think level (case/whitespace-insensitive). Falsy
 *   or "off" -> `undefined` (caller OMITS the env var — never sets it to 0).
 * @param modelMaxOutput - the active model's max output tokens; used to clamp
 *   the thinking budget so it can't crowd out the answer.
 * @returns the clamped thinking-token budget, or `undefined` when the env var
 *   should be omitted (level off/falsy/unknown).
 */
export function thinkLevelToMaxThinkingTokens(
  level: string | undefined | null,
  modelMaxOutput: number,
): number | undefined {
  if (!level) {
    return undefined;
  }
  const key = level.trim().toLowerCase();
  if (key === "off") {
    return undefined;
  }
  const base = THINK_LEVEL_BUDGET[key];
  if (base === undefined) {
    return undefined;
  }
  // Reserve 4k headroom for the answer; 1k floor for tiny-ceiling models.
  const ceiling = Math.max(1000, modelMaxOutput - 4000);
  return Math.min(base, ceiling);
}
