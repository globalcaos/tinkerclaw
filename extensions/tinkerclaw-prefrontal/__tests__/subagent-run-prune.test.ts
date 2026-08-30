/**
 * FORK 2026-08-04 (the architect): bounded retention for terminal Prefrontal subagent runs.
 * Target: subagent-run-prune.ts (pruneTerminalRuns -> run map + liveness clock + progress).
 * Bug-history: `sharedSubagentRuns` in index.ts had only `.set()` calls — no `.delete`, no
 *   `.clear` anywhere in the plugin — so the Prefrontal tree grew monotonically (observed
 *   1 -> 21, never decreasing) until a gateway restart. The companion fix closes runs on
 *   `agent_end` instead of the delivery-gated `subagent_ended` (7-8 min late).
 * Catches: a terminal run surviving past retention; a live run evicted on age alone; a
 *   REOPENED run (endedAt cleared after a steer) evicted as if terminal; the companion
 *   maps (lastEventTimestamps / nodeProgress) left behind when a run is evicted.
 *
 * Lane: node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts \
 *         extensions/tinkerclaw-prefrontal/__tests__/subagent-run-prune.test.ts
 *       (the filter path must be repo-root-relative — a lane-relative path matches
 *        nothing and still exits 0).
 */
import { describe, it, expect } from "vitest";
import {
  pruneTerminalRuns,
  TERMINAL_RUN_RETENTION_MS,
  type PrunableRun,
} from "../subagent-run-prune.js";

const NOW = 1_800_000_000_000;

function mapOf(entries: Record<string, PrunableRun>): Map<string, PrunableRun> {
  return new Map(Object.entries(entries));
}

describe("pruneTerminalRuns", () => {
  it("evicts a terminal run once it is past the retention window", () => {
    const runs = mapOf({ old: { endedAt: NOW - TERMINAL_RUN_RETENTION_MS - 1 } });

    expect(pruneTerminalRuns({ runs, now: NOW })).toEqual(["old"]);
    expect(runs.size).toBe(0);
  });

  it("keeps a terminal run that is still inside the retention window", () => {
    const runs = mapOf({ fresh: { endedAt: NOW - 1_000 } });

    expect(pruneTerminalRuns({ runs, now: NOW })).toEqual([]);
    expect(runs.has("fresh")).toBe(true);
  });

  it("evicts at exactly the retention boundary (>= retention, not strictly >)", () => {
    const runs = mapOf({ edge: { endedAt: NOW - TERMINAL_RUN_RETENTION_MS } });

    expect(pruneTerminalRuns({ runs, now: NOW })).toEqual(["edge"]);
  });

  it("never evicts a live run, however old it is", () => {
    // A long-running subagent has no endedAt. Age alone must never evict it — that
    // would delete the very node the Prefrontal panel exists to show.
    const runs = mapOf({ live: {} });

    expect(pruneTerminalRuns({ runs, now: NOW + 10 * TERMINAL_RUN_RETENTION_MS })).toEqual([]);
    expect(runs.has("live")).toBe(true);
  });

  it("keeps a REOPENED run — a steered child whose endedAt was cleared", () => {
    // agent_end closed it long ago, then the child was steered and the llm_input hook
    // cleared endedAt (index.ts). It is live again and must survive indefinitely.
    const reopened: PrunableRun = { endedAt: NOW - 10 * TERMINAL_RUN_RETENTION_MS };
    reopened.endedAt = undefined;
    const runs = mapOf({ steered: reopened });

    expect(pruneTerminalRuns({ runs, now: NOW })).toEqual([]);
    expect(runs.has("steered")).toBe(true);
  });

  it("evicts the companion maps too, so the leak cannot just move one module over", () => {
    const runs = mapOf({
      gone: { endedAt: NOW - TERMINAL_RUN_RETENTION_MS - 1 },
      stays: { endedAt: NOW - 1_000 },
      live: {},
    });
    const lastEventTimestamps = new Map<string, number>([
      ["gone", NOW - 500_000],
      ["stays", NOW - 1_000],
      ["live", NOW - 10],
    ]);
    const forgotten: string[] = [];

    const evicted = pruneTerminalRuns({
      runs,
      now: NOW,
      lastEventTimestamps,
      forgetRun: (runId) => forgotten.push(runId),
    });

    expect(evicted).toEqual(["gone"]);
    expect([...runs.keys()]).toEqual(["stays", "live"]);
    expect([...lastEventTimestamps.keys()]).toEqual(["stays", "live"]);
    expect(forgotten).toEqual(["gone"]);
  });

  it("honours an explicit retentionMs override", () => {
    const runs = mapOf({ r: { endedAt: NOW - 5_000 } });

    expect(pruneTerminalRuns({ runs, now: NOW, retentionMs: 10_000 })).toEqual([]);
    expect(runs.has("r")).toBe(true);

    expect(pruneTerminalRuns({ runs, now: NOW, retentionMs: 1_000 })).toEqual(["r"]);
    expect(runs.has("r")).toBe(false);
  });

  it("prunes a mixed map in one pass without disturbing survivors", () => {
    const runs = mapOf({
      "dead-1": { endedAt: NOW - 300_000 },
      "live-1": {},
      "dead-2": { endedAt: NOW - 200_000 },
      recent: { endedAt: NOW - 5_000 },
    });

    expect(pruneTerminalRuns({ runs, now: NOW })).toEqual(["dead-1", "dead-2"]);
    expect([...runs.keys()]).toEqual(["live-1", "recent"]);
  });
});
