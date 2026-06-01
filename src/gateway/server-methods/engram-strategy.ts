/**
 * FORK — Upgrade 4 runtime wiring: gateway RPC surface for strategy-switch review.
 *
 * The offline consolidation loop (sleep-consolidation.ts) records per-strategy
 * failure counts and writes gated switch proposals to the daily manifest. This
 * RPC surface lets a human (or the autonomy loop) inspect and act on those
 * proposals against the durable failure-state map.
 *
 * Styled like src/fork/curiosity-rpc.ts: same GatewayRequestHandlers shape, the
 * same readStr param guard, the same errorShape responses. Every method is
 * fork-only — no upstream path is patched.
 *
 * Handlers:
 *   fork.strategy.switch.list   — open switch decisions (shouldSwitch === true)
 *                                 computed from the current failure-state map.
 *   fork.strategy.switch.apply  — apply a switch for one strategy (records the
 *                                 switch in history, resets the counter) and
 *                                 persist atomically.
 *   fork.strategy.switch.review — full per-strategy state + its current decision,
 *                                 the human audit surface.
 *
 * Persistence goes through failure-tracking-store.ts (atomic temp+rename,
 * read-modify-write). The `baseDir` param overrides the ENGRAM root for tests.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 4).
 */

import {
  loadFailureStateMap,
  updateFailureStateMap,
} from "../../memory/engram/failure-tracking-store.js";
import { applySwitch, type StrategyState } from "../../memory/engram/failure-tracking.js";
import {
  DEFAULT_FALLBACKS,
  decideSwitch,
  type SwitchDecision,
} from "../../memory/engram/strategy-switch.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./shared-types.js";

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Parse an optional ISO `now` override (for deterministic tests). */
function readNow(p: Record<string, unknown>): Date {
  const v = readStr(p, "now");
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return new Date();
}

/** Compute the switch decision for one strategy state. */
function decisionFor(state: StrategyState, now: Date): SwitchDecision {
  return decideSwitch(state, DEFAULT_FALLBACKS, {}, now);
}

export const forkStrategyHandlers: GatewayRequestHandlers = {
  // List open switch proposals (those where shouldSwitch === true).
  "fork.strategy.switch.list": async ({ params, respond }) => {
    const p = params ?? {};
    const baseDir = readStr(p, "baseDir");
    const now = readNow(p);
    let map;
    try {
      map = loadFailureStateMap(baseDir);
    } catch (err) {
      console.error("[fork.strategy.switch.list] load failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.strategy.switch.list: load failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    const decisions = Object.values(map)
      .map((s) => decisionFor(s, now))
      .filter((d) => d.shouldSwitch);
    respond(true, { ok: true, decisions }, undefined);
  },

  // Apply a switch for one strategy and persist atomically.
  "fork.strategy.switch.apply": async ({ params, respond }) => {
    const p = params ?? {};
    const baseDir = readStr(p, "baseDir");
    const strategyId = readStr(p, "strategyId");
    if (!strategyId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.strategy.switch.apply: 'strategyId' required.",
        ),
      );
      return;
    }

    let current: StrategyState | undefined;
    try {
      current = loadFailureStateMap(baseDir)[strategyId];
    } catch (err) {
      console.error("[fork.strategy.switch.apply] load failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.strategy.switch.apply: load failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (!current) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `fork.strategy.switch.apply: strategy '${strategyId}' not found.`,
        ),
      );
      return;
    }

    const to = readStr(p, "toStrategy") ?? DEFAULT_FALLBACKS.get(current.currentStrategy) ?? null;
    if (!to) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `fork.strategy.switch.apply: no 'toStrategy' given and no registered fallback for "${current.currentStrategy}".`,
        ),
      );
      return;
    }

    const atISO = readStr(p, "at") ?? new Date().toISOString();
    let switched: StrategyState | undefined;
    try {
      updateFailureStateMap(baseDir, (fresh) => {
        const s = fresh[strategyId];
        // Re-check inside the atomic helper: another writer may have removed it.
        if (s) {
          switched = applySwitch(s, to, atISO);
          fresh[strategyId] = switched;
        }
        return fresh;
      });
    } catch (err) {
      console.error("[fork.strategy.switch.apply] persist failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.strategy.switch.apply: persist failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    if (!switched) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `fork.strategy.switch.apply: strategy '${strategyId}' disappeared before apply.`,
        ),
      );
      return;
    }

    respond(true, { ok: true, strategyId, toStrategy: to, state: switched }, undefined);
  },

  // Full per-strategy state + its current decision (human audit surface).
  "fork.strategy.switch.review": async ({ params, respond }) => {
    const p = params ?? {};
    const baseDir = readStr(p, "baseDir");
    const only = readStr(p, "strategyId");
    const now = readNow(p);
    let map;
    try {
      map = loadFailureStateMap(baseDir);
    } catch (err) {
      console.error("[fork.strategy.switch.review] load failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.strategy.switch.review: load failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    const strategies = Object.values(map)
      .filter((s) => !only || s.strategyId === only)
      .map((s) => ({ ...s, decision: decisionFor(s, now) }));
    respond(true, { ok: true, strategies }, undefined);
  },
};
