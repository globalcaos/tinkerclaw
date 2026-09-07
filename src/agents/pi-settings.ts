import type { AgentCompactionMode } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineInfo } from "../context-engine/types.js";
import { MIN_PROMPT_BUDGET_RATIO, MIN_PROMPT_BUDGET_TOKENS } from "./pi-compaction-constants.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

type PiSettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
      enabled?: boolean;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};

/**
 * Ensures the compaction reserve tokens are at least the specified minimum.
 * Note: This function is not context-aware and uses an uncapped floor.
 * If called for small-context models without threading `contextTokenBudget`,
 * it may re-introduce context overflow issues.
 */
export function ensurePiCompactionReserveTokens(params: {
  settingsManager: PiSettingsManagerLike;
  minReserveTokens?: number;
}): { didOverride: boolean; reserveTokens: number } {
  const minReserveTokens = params.minReserveTokens ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  const current = params.settingsManager.getCompactionReserveTokens();

  if (current >= minReserveTokens) {
    return { didOverride: false, reserveTokens: current };
  }

  params.settingsManager.applyOverrides({
    compaction: { reserveTokens: minReserveTokens },
  });

  return { didOverride: true, reserveTokens: minReserveTokens };
}

export function resolveCompactionReserveTokensFloor(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function applyPiCompactionSettingsFromConfig(params: {
  settingsManager: PiSettingsManagerLike;
  cfg?: OpenClawConfig;
  /** When known, the resolved context window budget for the current model. */
  contextTokenBudget?: number;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;

  const configuredReserveTokens = toNonNegativeInt(compactionCfg?.reserveTokens);
  const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);
  let reserveTokensFloor = resolveCompactionReserveTokensFloor(params.cfg);

  // Cap the floor to a safe fraction of the context window so that
  // small-context models (e.g. Ollama with 16 K tokens) are not starved of
  // prompt budget.  Without this cap the default floor of 20 000 can exceed
  // the entire context window, causing every prompt to be classified as an
  // overflow and triggering an infinite compaction loop.
  const ctxBudget = params.contextTokenBudget;
  if (typeof ctxBudget === "number" && Number.isFinite(ctxBudget) && ctxBudget > 0) {
    const minPromptBudget = Math.min(
      MIN_PROMPT_BUDGET_TOKENS,
      Math.max(1, Math.floor(ctxBudget * MIN_PROMPT_BUDGET_RATIO)),
    );
    const maxReserve = Math.max(0, ctxBudget - minPromptBudget);
    reserveTokensFloor = Math.min(reserveTokensFloor, maxReserve);
  }

  const targetReserveTokens = Math.max(
    configuredReserveTokens ?? currentReserveTokens,
    reserveTokensFloor,
  );
  const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;

  const overrides: { reserveTokens?: number; keepRecentTokens?: number } = {};
  if (targetReserveTokens !== currentReserveTokens) {
    overrides.reserveTokens = targetReserveTokens;
  }
  if (targetKeepRecentTokens !== currentKeepRecentTokens) {
    overrides.keepRecentTokens = targetKeepRecentTokens;
  }

  const didOverride = Object.keys(overrides).length > 0;
  if (didOverride) {
    params.settingsManager.applyOverrides({ compaction: overrides });
  }

  return {
    didOverride,
    compaction: {
      reserveTokens: targetReserveTokens,
      keepRecentTokens: targetKeepRecentTokens,
    },
  };
}

/**
 * Decide whether Pi's internal auto-compaction should be disabled for this run.
 *
 * FORK 2026-07-28 — WHY THE `ownsCompaction` CHECK ALONE WAS NOT ENOUGH.
 * Pi runs its own compaction decider (`AgentSession._checkCompaction`). It reads
 * `calculateContextTokens(assistantMessage.usage)` on the threshold path and
 * `usage.input + usage.cacheRead` on the overflow path. On the cc-bridge lane that
 * field is a TURN AGGREGATE (summed across every internal API call), so pi routinely
 * sees millions of "context" tokens on a session holding a few percent of its window.
 * Measured live 2026-07-28: pi reported 6,448,106 tokens (644.8% of a 1M window) and
 * 1,029,656 (103%) on sessions whose real context was 52,116 — a 19.8x over-read.
 *
 * We cannot teach pi to read a better field: it is a pinned `dist/` dependency. The only
 * lever is to switch its decider OFF and let OUR gates own compaction — which is exactly
 * what upstream openclaw does host-side (`src/agents/agent-settings.ts`
 * shouldDisableAgentAutoCompaction, three disjuncts vs our original one).
 *
 * The second disjunct is a DELIBERATE DIVERGENCE from upstream, recorded in the bible:
 * upstream tests `compactionMode === "safeguard"` against its own two-value enum; our enum
 * is "default" | "safeguard" | "engram" and our live mode is "engram". Both non-default
 * modes register a `session_before_compact` extension that supplies the compaction, so
 * "not default" is the faithful translation of upstream's "an extension owns this".
 */
export function shouldDisablePiAutoCompaction(params: {
  contextEngineInfo?: ContextEngineInfo;
  compactionMode?: AgentCompactionMode;
}): boolean {
  if (params.contextEngineInfo?.ownsCompaction === true) {
    return true;
  }
  return params.compactionMode !== undefined && params.compactionMode !== "default";
}

/**
 * Disable Pi auto-compaction when a context engine or a compaction extension owns it.
 *
 * Uses `applyOverrides` rather than `setCompactionEnabled`. Both take effect immediately
 * (pi's `save()` recomputes the merged snapshot synchronously before enqueuing its async
 * write), but `setCompactionEnabled` ALSO persists `compaction.enabled:false` into the
 * user's GLOBAL pi settings file, which would outlive this run and suppress manual
 * `/compact` everywhere. `applyOverrides` mutates only the in-memory merged settings, so
 * the guard stays scoped to the run that asked for it.
 *
 * MANDATORY: re-call this after any `resourceLoader.reload()`. `reload()` recomputes
 * `settings` from disk and discards `applyOverrides` mutations.
 */
export function applyPiAutoCompactionGuard(params: {
  settingsManager: PiSettingsManagerLike;
  contextEngineInfo?: ContextEngineInfo;
  compactionMode?: AgentCompactionMode;
}): { supported: boolean; disabled: boolean } {
  const disable = shouldDisablePiAutoCompaction({
    contextEngineInfo: params.contextEngineInfo,
    compactionMode: params.compactionMode,
  });
  if (!disable) {
    return { supported: true, disabled: false };
  }
  params.settingsManager.applyOverrides({ compaction: { enabled: false } });
  return { supported: true, disabled: true };
}
