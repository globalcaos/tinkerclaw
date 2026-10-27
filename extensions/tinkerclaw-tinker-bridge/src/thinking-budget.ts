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
 *
 * FORK 2026-10-09 (effort per turn): the budget above is for OLDER models only. On a model with
 * adaptive effort (isAdaptiveEffortModel: Claude 5.x, Fable, Opus 4.7+) a MAX_THINKING_TOKENS > 0
 * swaps the effort for a legacy fixed budget, and the effort the CLI then runs comes from the
 * host's own settings, whatever the slider says (measured on CLI 2.1.295). Those models get the
 * level as a Claude Code EFFORT instead (thinkLevelToClaudeEffort), applied per turn on the live
 * process (worker.ts applyTurnEffort).
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

/**
 * FORK 2026-10-09 (effort per turn) — the effort levels Claude Code takes as `effortLevel`
 * (`apply_flag_settings`, the `--effort` flag, settings.json).
 */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** What one `apply_flag_settings` sets. `effortLevel: null` hands the effort back to the host. */
export type ClaudeEffortSettings = { effortLevel: ClaudeEffortLevel | null; ultracode: boolean };

/** OpenClaw think level -> Claude Code effort. `minimal` has no effort of its own: it rounds up. */
const CLAUDE_EFFORT_BY_LEVEL: Record<string, ClaudeEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  // Legacy 'adaptive' level, as in thinkLevelToMaxThinkingTokens.
  adaptive: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * FORK 2026-10-09 (effort per turn) — map an OpenClaw think level to a Claude Code effort.
 * Falsy, "off" or unknown -> `undefined`: the turn names no effort, and the host's own applies.
 */
export function thinkLevelToClaudeEffort(
  level: string | undefined | null,
): ClaudeEffortLevel | undefined {
  if (!level) {
    return undefined;
  }
  const key = level.trim().toLowerCase();
  return Object.hasOwn(CLAUDE_EFFORT_BY_LEVEL, key) ? CLAUDE_EFFORT_BY_LEVEL[key] : undefined;
}

/**
 * FORK 2026-10-09 (effort per turn) — what one turn asks of an adaptive-effort model: its level as
 * an effort, and ultracode on top of it (at `max` when the turn names no level: ultracode is asked
 * for the hardest work). Both keys are always set, because a request that leaves `ultracode` out
 * keeps an earlier `ultracode: true` on. `undefined` when the turn asks for neither.
 */
export function claudeEffortForTurn(
  level: string | undefined | null,
  ultracode: boolean | undefined,
): { effortLevel: ClaudeEffortLevel; ultracode: boolean } | undefined {
  const effortLevel = thinkLevelToClaudeEffort(level);
  if (ultracode === true) {
    return { effortLevel: effortLevel ?? "max", ultracode: true };
  }
  return effortLevel ? { effortLevel, ultracode: false } : undefined;
}

/**
 * FORK 2026-10-09 (effort per turn) — does this model run Claude Code's adaptive EFFORT? True for
 * every Claude 5.x family (Opus, Sonnet, Haiku and any newer one), Fable, and Opus 4.7 and later;
 * false for Opus 4.6 and older, Sonnet 4.x and Haiku 4.5, which keep the MAX_THINKING_TOKENS
 * budget. A provider prefix (`claude-code/`), a context suffix (`[1m]`) and date or version
 * suffixes are ignored. The bare aliases follow defaults.ts MODEL_ALIASES (opus and sonnet are
 * 5.5, haiku is 4.5). An id it cannot read is NOT adaptive, so an unknown model keeps today's
 * behaviour.
 */
export function isAdaptiveEffortModel(modelId: string | undefined | null): boolean {
  if (!modelId) {
    return false;
  }
  const lower = modelId.trim().toLowerCase();
  const id = lower.slice(lower.lastIndexOf("/") + 1).replace(/\[[^\]]*\]$/, "");
  if (id === "opus" || id === "sonnet" || id === "fable") {
    return true;
  }
  // `claude-<family>-<major>[-<minor>]`. A minor is one or two digits, so a date suffix
  // (`claude-opus-4-20250514`) is never read as one.
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m) {
    return false;
  }
  const family = m[1];
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  if (family === "fable" || major >= 5) {
    return true;
  }
  return family === "opus" && major === 4 && minor >= 7;
}
