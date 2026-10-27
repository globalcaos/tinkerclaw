// extensions/tinkerclaw-prefrontal/subagent-run-prune.ts
// FORK 2026-08-04 (the architect): bounded retention for terminal subagent runs.
//
// The Prefrontal run map in index.ts (`sharedSubagentRuns`) had no `.delete` and no
// `.clear` anywhere in the plugin — its only mutations were two `.set()` calls. Every
// subagent spawned since gateway boot therefore stayed a child of the Prefrontal tree
// forever (observed growing 1 -> 21, never decreasing, until a gateway restart).
//
// This module is the EVICTION half of the fix. The LIVENESS half lives in index.ts:
// runs are now closed on `agent_end` rather than on the delivery-gated `subagent_ended`,
// which lands 7-8 minutes late BY DESIGN (it waits on the completion announce). Without
// that half this module would almost never fire in time; without this half the map would
// still only ever grow.
//
// Kept as its own module rather than inlined into the monitor tick so index.ts gains a
// single call site and the retention rule is unit-testable with an injected clock.

/** How long a terminal run stays visible in the tree before it is evicted. */
export const TERMINAL_RUN_RETENTION_MS = 120_000;

/**
 * The structural subset of `SubagentRunInfo` this module reads. Kept structural on
 * purpose so the pruner imports nothing: the dependency only ever points one way
 * (index.ts -> pruner), which is what keeps this testable without the monitor.
 */
export interface PrunableRun {
  endedAt?: number;
}

export interface PruneTerminalRunsOptions<T extends PrunableRun> {
  /** The run map to evict from. Mutated in place. */
  runs: Map<string, T>;
  /** Injected clock — required, so a caller cannot silently test against wall time. */
  now: number;
  retentionMs?: number;
  /** The runId-keyed liveness clock in index.ts; evicted runs are dropped from it too. */
  lastEventTimestamps?: Map<string, number>;
  /**
   * Drops the monitor's per-node progress row for an evicted run. Without this the
   * leak would simply relocate from the run map into `nodeProgress` one module over.
   */
  forgetRun?: (runId: string) => void;
}

/**
 * Evict every run that has been terminal for at least `retentionMs`.
 * Returns the evicted runIds in map order. Mutates `runs` (and the companions) in place.
 *
 * A run with no `endedAt` is live — either still working, or REOPENED after a steer
 * (index.ts clears `endedAt` on the child's next `llm_input`) — and is never evicted,
 * however old it is. Age on its own is not a terminality signal.
 */
export function pruneTerminalRuns<T extends PrunableRun>(
  opts: PruneTerminalRunsOptions<T>,
): string[] {
  const retentionMs = opts.retentionMs ?? TERMINAL_RUN_RETENTION_MS;
  const evicted: string[] = [];

  for (const [runId, run] of opts.runs) {
    if (run.endedAt === undefined) {
      continue;
    }
    if (opts.now - run.endedAt < retentionMs) {
      continue;
    }
    evicted.push(runId);
  }

  // Collect first, delete second — never mutate the map while still deciding.
  for (const runId of evicted) {
    opts.runs.delete(runId);
    opts.lastEventTimestamps?.delete(runId);
    opts.forgetRun?.(runId);
  }

  return evicted;
}
