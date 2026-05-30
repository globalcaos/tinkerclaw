/**
 * ENGRAM Phase 3D — Failure tracking (per-strategy consecutive-error state machine).
 *
 * The offline (consolidation-time) counterpart to single-shot prompt mutation:
 * instead of reacting to one failure, the Cerebellum remembers *how many times in
 * a row* a named strategy has failed, so a recurring-failure *pattern* can trip a
 * strategy switch (see strategy-switch.ts) rather than yet another identical patch.
 *
 * A "strategy" is the named approach a cron/task is currently using
 * (e.g. "fork-sync:always-merge"). State is keyed by strategyId.
 *
 * The core transition functions are PURE (no I/O). Persistence is a thin wrapper
 * (loadFailureState/saveFailureState) so callers can store the map next to
 * consolidation-state.json without coupling the state machine to the filesystem.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 4).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Episode } from "./episode-detection.js";
import type { MemoryEvent } from "./event-types.js";

/** A recorded strategy switch (for time-to-recovery analysis). */
export interface StrategySwitchRecord {
  at: string;
  from: string;
  to: string;
  /** Number of consecutive failures that triggered the switch. */
  triggeredAfter: number;
  /**
   * Consecutive failures observed *after* the switch before the first success.
   * Stamped lazily by recordSuccess once recovery is observed. Undefined while
   * still failing or not yet recovered.
   */
  recoveredAfter?: number;
}

/** Per-strategy failure state machine. */
export interface StrategyState {
  strategyId: string;
  consecutiveErrors: number;
  /** Failures observed since the most recent switch (for recoveredAfter). */
  failuresSinceSwitch: number;
  lastFailureTime: string | null;
  lastSuccessTime: string | null;
  /** The strategy variant currently in effect (defaults to strategyId). */
  currentStrategy: string;
  switchHistory: StrategySwitchRecord[];
  /**
   * Event IDs already counted, used to de-duplicate failures within the same
   * consolidation window (guards risk #4 idempotency + risk #5 episode-split
   * double counting). Bounded to the most recent N ids.
   */
  countedEventIds: string[];
}

/** Map of strategyId -> StrategyState, the persisted shape. */
export type FailureStateMap = Record<string, StrategyState>;

/** Cap on retained counted-event ids per strategy (bounded state, risk #3). */
const MAX_COUNTED_IDS = 200;

export function createInitialStrategyState(strategyId: string): StrategyState {
  return {
    strategyId,
    consecutiveErrors: 0,
    failuresSinceSwitch: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    currentStrategy: strategyId,
    switchHistory: [],
    countedEventIds: [],
  };
}

function trackCountedId(state: StrategyState, eventId: string | undefined): StrategyState {
  if (!eventId) {
    return state;
  }
  const ids = [...state.countedEventIds, eventId];
  if (ids.length > MAX_COUNTED_IDS) {
    ids.splice(0, ids.length - MAX_COUNTED_IDS);
  }
  return { ...state, countedEventIds: ids };
}

/**
 * Record a failure for a strategy. Pure — returns a new state.
 * If `dedupeKey` was already counted, the failure is ignored (idempotency).
 */
export function recordFailure(
  state: StrategyState,
  atISO: string,
  dedupeKey?: string,
): StrategyState {
  if (dedupeKey && state.countedEventIds.includes(dedupeKey)) {
    return state;
  }
  const next: StrategyState = {
    ...state,
    consecutiveErrors: state.consecutiveErrors + 1,
    failuresSinceSwitch: state.failuresSinceSwitch + 1,
    lastFailureTime: atISO,
  };
  return trackCountedId(next, dedupeKey);
}

/**
 * Record a success for a strategy. Pure — returns a new state.
 * Resets the consecutive-error counter. If a switch is pending recovery, stamps
 * `recoveredAfter` on the most recent switch record.
 */
export function recordSuccess(
  state: StrategyState,
  atISO: string,
  dedupeKey?: string,
): StrategyState {
  if (dedupeKey && state.countedEventIds.includes(dedupeKey)) {
    return state;
  }
  let switchHistory = state.switchHistory;
  const latest = switchHistory[switchHistory.length - 1];
  if (latest && latest.recoveredAfter === undefined) {
    switchHistory = [
      ...switchHistory.slice(0, -1),
      { ...latest, recoveredAfter: state.failuresSinceSwitch },
    ];
  }
  const next: StrategyState = {
    ...state,
    consecutiveErrors: 0,
    failuresSinceSwitch: 0,
    lastSuccessTime: atISO,
    switchHistory,
  };
  return trackCountedId(next, dedupeKey);
}

/**
 * Apply a strategy switch. Pure — returns a new state with the new strategy in
 * effect, the consecutive counter reset, and a switch record appended.
 */
export function applySwitch(state: StrategyState, to: string, atISO: string): StrategyState {
  return {
    ...state,
    currentStrategy: to,
    consecutiveErrors: 0,
    failuresSinceSwitch: 0,
    switchHistory: [
      ...state.switchHistory,
      {
        at: atISO,
        from: state.currentStrategy,
        to,
        triggeredAfter: state.consecutiveErrors,
      },
    ],
  };
}

/**
 * Infer a strategyId from an episode.
 *
 * Priority:
 *   1. An explicit `strategy:<id>` tag in any source event's metadata.tags.
 *   2. The task id (`metadata.taskId`) of the first event carrying one.
 *   3. The episode topic, slugified.
 *
 * Returns null when nothing identifiable is present (no false attribution).
 */
export function strategyOf(episode: Episode, events: MemoryEvent[]): string | null {
  for (const e of events) {
    const tag = e.metadata?.tags?.find((t) => t.startsWith("strategy:"));
    if (tag) {
      return tag.slice("strategy:".length);
    }
  }
  for (const e of events) {
    if (e.metadata?.taskId) {
      return `task:${e.metadata.taskId}`;
    }
  }
  const slug = episode.topic
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `topic:${slug}` : null;
}

/**
 * Whether an episode represents an explicit failure of its strategy.
 *
 * Preference order (per spec — explicit signal beats outcome heuristic):
 *   1. An explicit `failure` / `error` tag → failure.
 *   2. An explicit `success` tag → not a failure.
 *   3. Otherwise fall back to `outcome === "abandoned"`.
 *
 * `outcome === "ongoing"` is never a failure (work still in progress).
 */
export function isFailureEpisode(episode: Episode, events: MemoryEvent[]): boolean {
  for (const e of events) {
    const tags = e.metadata?.tags ?? [];
    if (tags.includes("failure") || tags.includes("error")) {
      return true;
    }
    if (tags.includes("success")) {
      return false;
    }
  }
  return episode.outcome === "abandoned";
}

// ---------------------------------------------------------------------------
// Persistence (thin wrapper — JSON map next to consolidation-state.json)
// ---------------------------------------------------------------------------

export function loadFailureState(filePath: string): FailureStateMap {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as FailureStateMap;
  } catch {
    return {};
  }
}

export function saveFailureState(filePath: string, map: FailureStateMap): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(map, null, 2));
}
