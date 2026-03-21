/**
 * WhatsApp Protocol v2 — Budget-Aware Scheduling
 *
 * Adjusts congestion and lifecycle parameters based on API usage and reset proximity.
 * Burn mode: when tokens are about to expire unused, encourage deeper multi-agent discussions.
 */

import { DEFAULT_BUDGET_CONFIG, type BudgetConfig, type BudgetMode } from "./types.js";

export type BudgetContext = {
  /** Fraction of budget window used (0.0 – 1.0). */
  usagePercent: number;
  /** Hours remaining until budget reset. */
  hoursToReset: number;
};

export type BudgetModifiers = {
  congestionDelayMultiplier: number;
  stalenessThreshold: number;
  maxTurnsMultiplier: number;
  tangentExploration: boolean;
};

const MODE_MODIFIERS: Record<BudgetMode, BudgetModifiers> = {
  conservative: {
    congestionDelayMultiplier: 2.0,
    stalenessThreshold: 0.8,
    maxTurnsMultiplier: 0.5,
    tangentExploration: false,
  },
  moderate: {
    congestionDelayMultiplier: 1.0,
    stalenessThreshold: 0.85,
    maxTurnsMultiplier: 1.0,
    tangentExploration: false,
  },
  aggressive: {
    congestionDelayMultiplier: 0.7,
    stalenessThreshold: 0.85,
    maxTurnsMultiplier: 1.0,
    tangentExploration: true,
  },
  burn: {
    congestionDelayMultiplier: 0.3,
    stalenessThreshold: 0.95,
    maxTurnsMultiplier: 2.0,
    tangentExploration: true,
  },
};

/**
 * Resolve budget mode from usage context.
 *
 * - burn: <20% used AND <24h to reset (use it or lose it)
 * - conservative: >85% used (watch spending)
 * - moderate: 60-85% used (normal)
 * - aggressive: <60% used (plenty of headroom)
 */
export function resolveBudgetMode(ctx: BudgetContext, config?: Partial<BudgetConfig>): BudgetMode {
  const cfg = { ...DEFAULT_BUDGET_CONFIG, ...config };

  // Burn mode: low usage + near reset.
  if (
    cfg.burnModeEnabled &&
    ctx.hoursToReset < cfg.burnTriggerHours &&
    ctx.usagePercent < cfg.burnUsageThreshold
  ) {
    return "burn";
  }

  if (ctx.usagePercent > 0.85) return "conservative";
  if (ctx.usagePercent > 0.6) return "moderate";
  return "aggressive";
}

/** Get the modifiers for a given budget mode. */
export function getBudgetModifiers(mode: BudgetMode): BudgetModifiers {
  return MODE_MODIFIERS[mode];
}

/**
 * Apply budget modifiers to base congestion/lifecycle parameters.
 * Returns adjusted values ready for use.
 */
export function applyBudgetModifiers(
  base: {
    congestionDelay: number;
    stalenessThreshold: number;
    maxTurns: number;
  },
  mode: BudgetMode,
): {
  congestionDelay: number;
  stalenessThreshold: number;
  maxTurns: number;
  tangentExploration: boolean;
} {
  const mods = MODE_MODIFIERS[mode];
  return {
    congestionDelay: Math.round(base.congestionDelay * mods.congestionDelayMultiplier),
    stalenessThreshold: mods.stalenessThreshold,
    maxTurns: Math.round(base.maxTurns * mods.maxTurnsMultiplier),
    tangentExploration: mods.tangentExploration,
  };
}
