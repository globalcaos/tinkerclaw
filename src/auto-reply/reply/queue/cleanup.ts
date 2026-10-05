import { resolveEmbeddedSessionLane } from "../../../agents/embedded-agent-runner/lanes.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { clearFollowupDrainCallback } from "./drain.js";
import { clearFollowupQueue, type FollowupQueueState } from "./state.js";
import type { FollowupRun } from "./types.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
  /**
   * FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/prompt-queue.md C11, §6.2 step 2): the backlogged
   * prompts this call dropped, in queue order per key, so a caller can END each one (a `chat`
   * `aborted` under its prompt key) instead of only counting it. Absent when nothing was queued.
   * `followupCleared` can be larger: it also counts prompts the queue cap had already folded into
   * a summary line, and those have no item left to hand back.
   */
  followupItems?: FollowupRun[];
};

/**
 * state.ts's FOLLOWUP_QUEUES, resolved per call through the process-wide slot it lives in: the
 * same `resolveGlobalMap(Symbol.for(...))` sharing every registry here uses across bundle splits.
 * Read here rather than through a new state.ts export so this module's runtime surface on state.ts
 * stays `clearFollowupQueue` alone, the seam cleanup.test.ts stubs. A drift between the two
 * symbols fails sessions.delete-pending-turn.test.ts, which enqueues through state.ts and asserts
 * clearSessionQueues hands the item back.
 */
const FOLLOWUP_QUEUES_SLOT = Symbol.for("openclaw.followupQueues");

function snapshotFollowupItems(key: string): FollowupRun[] {
  const queue = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_SLOT).get(key);
  return queue ? [...queue.items] : [];
}

const defaultQueueCleanupDeps = {
  resolveEmbeddedSessionLane,
  clearCommandLane,
};

const queueCleanupDeps = {
  ...defaultQueueCleanupDeps,
};

function resolveQueueCleanupLaneResolver() {
  return typeof queueCleanupDeps.resolveEmbeddedSessionLane === "function"
    ? queueCleanupDeps.resolveEmbeddedSessionLane
    : defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
}

function resolveQueueCleanupLaneClearer() {
  return typeof queueCleanupDeps.clearCommandLane === "function"
    ? queueCleanupDeps.clearCommandLane
    : defaultQueueCleanupDeps.clearCommandLane;
}

export const __testing = {
  setDepsForTests(deps: Partial<typeof defaultQueueCleanupDeps> | undefined): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      typeof deps?.resolveEmbeddedSessionLane === "function"
        ? deps.resolveEmbeddedSessionLane
        : defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane =
      typeof deps?.clearCommandLane === "function"
        ? deps.clearCommandLane
        : defaultQueueCleanupDeps.clearCommandLane;
  },
  resetDepsForTests(): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane = defaultQueueCleanupDeps.clearCommandLane;
  },
};

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];
  const followupItems: FollowupRun[] = [];
  const resolveLane = resolveQueueCleanupLaneResolver();
  const clearLane = resolveQueueCleanupLaneClearer();

  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    // Snapshot BEFORE clearing: clearFollowupQueue empties the items array in place.
    followupItems.push(...snapshotFollowupItems(cleaned));
    followupCleared += clearFollowupQueue(cleaned);
    clearFollowupDrainCallback(cleaned);
    laneCleared += clearLane(resolveLane(cleaned));
  }

  return {
    followupCleared,
    laneCleared,
    keys: clearedKeys,
    ...(followupItems.length > 0 ? { followupItems } : {}),
  };
}
