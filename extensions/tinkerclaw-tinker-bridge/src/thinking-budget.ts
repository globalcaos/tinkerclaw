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
  high: 16000,
  xhigh: 22000,
  max: 28000,
};

/**
 * Canonical rank per think level — mirrors core `THINKING_LEVEL_RANKS` so the
 * profile we hand OpenClaw downgrades stale stored values in the right order.
 * Kept local (not imported) so the extension doesn't deep-reach into core
 * internals; the values are stable contract.
 */
const THINK_LEVEL_RANK: Record<string, number> = {
  off: 0,
  minimal: 10,
  low: 20,
  medium: 30,
  high: 40,
  xhigh: 60,
  max: 70,
};

/** Matches core `ProviderThinkingLevelId` so the profile types line up. */
type ThinkLevelId = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";

/** The user-selectable think levels for claude-code, weakest -> strongest. */
const CLAUDE_CODE_THINK_LEVELS: ThinkLevelId[] = [
  "off",
  ...(Object.keys(THINK_LEVEL_BUDGET) as ThinkLevelId[]),
];

/**
 * FORK 2026-06-19 — the claude-code thinking PROFILE handed to OpenClaw's
 * provider-thinking registry (`ProviderPlugin.resolveThinkingProfile`).
 *
 * Why this exists: core's BASE_THINKING_LEVELS tops out at `high`, and `xhigh`
 * is only admitted via a deprecated per-provider boolean while `max` has NO
 * admit-path at all. So the Tinker effort slider's top two stops (xHigh, Max)
 * resolved to "unsupported" and chat.send rejected them. Returning the full
 * 7-level set here is the non-deprecated fix: core uses a provider profile
 * verbatim (see auto-reply/thinking.ts resolveThinkingProfile), so every level
 * tinker-bridge can actually budget (THINK_LEVEL_BUDGET + off) becomes selectable.
 *
 * `defaultLevel` is intentionally omitted so Auto (no pin) keeps falling
 * through to core's existing default-resolution — this change widens the
 * ceiling, it does not move the default.
 */
export function claudeCodeThinkingProfile(): {
  levels: { id: ThinkLevelId; label: string; rank: number }[];
} {
  return {
    levels: CLAUDE_CODE_THINK_LEVELS.map((id) => ({
      id,
      label: id,
      rank: THINK_LEVEL_RANK[id],
    })),
  };
}

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
  const raw = level.trim().toLowerCase();
  if (raw === "off") {
    return undefined;
  }
  // Defensive: legacy 'adaptive' level (removed from the table) maps to medium.
  const key = raw === "adaptive" ? "medium" : raw;
  const base = THINK_LEVEL_BUDGET[key];
  if (base === undefined) {
    return undefined;
  }
  // Reserve 4k headroom for the answer; 1k floor for tiny-ceiling models.
  const ceiling = Math.max(1000, modelMaxOutput - 4000);
  return Math.min(base, ceiling);
}
