/**
 * Tests — Upgrade 4: failure-count → strategy-switch.
 * failure-tracking.ts state machine + strategy-switch.ts decision logic +
 * runSleepConsolidation integration (regression-guard for absent dep).
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { createInitialConsolidationState, type Episode } from "./episode-detection.js";
import { createEventStore, type EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import {
  applySwitch,
  createInitialStrategyState,
  isFailureEpisode,
  recordFailure,
  recordSuccess,
  strategyOf,
  type FailureStateMap,
} from "./failure-tracking.js";
import { runSleepConsolidation } from "./sleep-consolidation.js";
import { DEFAULT_FALLBACKS, decideSwitch } from "./strategy-switch.js";

let tmpDir: string;
let store: EventStore;
let artifactStore: ArtifactStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-stratsw-"));
  store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });
  artifactStore = createArtifactStore({ baseDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = new Date("2026-05-30T10:00:00Z");
function iso(minsFromT0: number): string {
  return new Date(T0.getTime() + minsFromT0 * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// failure-tracking.ts — pure state machine
// ---------------------------------------------------------------------------
describe("failure-tracking state machine", () => {
  it("recordFailure increments consecutiveErrors and stamps lastFailureTime", () => {
    let s = createInitialStrategyState("fork-sync:always-merge");
    s = recordFailure(s, iso(0), "e1");
    s = recordFailure(s, iso(1), "e2");
    expect(s.consecutiveErrors).toBe(2);
    expect(s.lastFailureTime).toBe(iso(1));
  });

  it("recordSuccess resets consecutiveErrors to 0", () => {
    let s = createInitialStrategyState("x");
    s = recordFailure(s, iso(0), "e1");
    s = recordFailure(s, iso(1), "e2");
    s = recordSuccess(s, iso(2), "e3");
    expect(s.consecutiveErrors).toBe(0);
    expect(s.lastSuccessTime).toBe(iso(2));
  });

  it("recordSuccess after a switch stamps recoveredAfter on the latest switch", () => {
    let s = createInitialStrategyState("always-merge");
    s = recordFailure(s, iso(0), "e1");
    s = recordFailure(s, iso(1), "e2");
    s = recordFailure(s, iso(2), "e3");
    s = applySwitch(s, "ask-before-merge", iso(3));
    // one failure after the switch, then a success
    s = recordFailure(s, iso(4), "e4");
    s = recordSuccess(s, iso(5), "e5");
    const last = s.switchHistory[s.switchHistory.length - 1];
    expect(last.to).toBe("ask-before-merge");
    expect(last.recoveredAfter).toBe(1);
  });

  it("dedupes failures by event id (idempotency guard, risk #4)", () => {
    let s = createInitialStrategyState("x");
    s = recordFailure(s, iso(0), "dup");
    s = recordFailure(s, iso(1), "dup"); // same key → ignored
    expect(s.consecutiveErrors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// strategyOf / isFailureEpisode attribution
// ---------------------------------------------------------------------------
function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "ep",
    startEventId: "s",
    endEventId: "e",
    startTime: iso(0),
    endTime: iso(1),
    turnCount: 1,
    topic: "fork sync run",
    participants: ["agent"],
    outcome: "completed",
    keyDecisions: [],
    sourceEventIds: [],
    ...overrides,
  };
}

function ev(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "x",
    timestamp: iso(0),
    turnId: 0,
    sessionKey: "test",
    kind: "user_message",
    content: "hi",
    tokens: 1,
    metadata: {},
    ...overrides,
  };
}

describe("strategyOf attribution", () => {
  it("prefers an explicit strategy:<id> tag", () => {
    const e = ev({ metadata: { tags: ["strategy:fork-sync:always-merge"] } });
    expect(strategyOf(episode(), [e])).toBe("fork-sync:always-merge");
  });

  it("falls back to taskId", () => {
    const e = ev({ metadata: { taskId: "task-42" } });
    expect(strategyOf(episode(), [e])).toBe("task:task-42");
  });

  it("falls back to slugified topic", () => {
    expect(strategyOf(episode({ topic: "Fork Sync Run" }), [ev()])).toBe("topic:fork-sync-run");
  });
});

describe("isFailureEpisode signal preference", () => {
  it("explicit failure tag → true even if outcome is completed", () => {
    const e = ev({ metadata: { tags: ["failure"] } });
    expect(isFailureEpisode(episode({ outcome: "completed" }), [e])).toBe(true);
  });

  it("explicit success tag → false even if outcome is abandoned", () => {
    const e = ev({ metadata: { tags: ["success"] } });
    expect(isFailureEpisode(episode({ outcome: "abandoned" }), [e])).toBe(false);
  });

  it("no tag → falls back to outcome===abandoned", () => {
    expect(isFailureEpisode(episode({ outcome: "abandoned" }), [ev()])).toBe(true);
    expect(isFailureEpisode(episode({ outcome: "completed" }), [ev()])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideSwitch decision logic
// ---------------------------------------------------------------------------
describe("decideSwitch", () => {
  function failed(n: number, strategyId: string, lastAtMins: number) {
    let s = createInitialStrategyState(strategyId);
    for (let i = 0; i < n; i++) {
      s = recordFailure(s, iso(lastAtMins - (n - 1 - i)), `e${i}`);
    }
    return s;
  }

  it("2 consecutive failures within window → no switch", () => {
    const s = failed(2, "always-merge", 10);
    const d = decideSwitch(s, DEFAULT_FALLBACKS, {}, new Date(iso(11)));
    expect(d.shouldSwitch).toBe(false);
  });

  it("3rd consecutive failure within window → switch to registered fallback", () => {
    const s = failed(3, "always-merge", 10);
    const d = decideSwitch(s, DEFAULT_FALLBACKS, {}, new Date(iso(11)));
    expect(d.shouldSwitch).toBe(true);
    expect(d.toStrategy).toBe("ask-before-merge");
  });

  it("3 failures spread beyond window → no switch (recency guard)", () => {
    let s = createInitialStrategyState("always-merge");
    s = recordFailure(s, iso(0), "e0");
    s = recordFailure(s, iso(60), "e1");
    s = recordFailure(s, iso(120), "e2"); // last failure 2h before "now"+window
    // now is far beyond windowMs from the last failure
    const now = new Date(new Date(iso(120)).getTime() + 25 * 60 * 60 * 1000);
    const d = decideSwitch(s, DEFAULT_FALLBACKS, {}, now);
    expect(d.shouldSwitch).toBe(false);
    expect(d.rationale).toMatch(/recency guard/);
  });

  it("switch with no registered fallback → toStrategy null + needsHumanReview", () => {
    const s = failed(3, "mystery-strategy", 10);
    const d = decideSwitch(s, new Map(), {}, new Date(iso(11)));
    expect(d.shouldSwitch).toBe(true);
    expect(d.toStrategy).toBeNull();
    expect(d.needsHumanReview).toBe(true);
  });

  it("B010 reproduction: 3 always-merge failures → switch to ask-before-merge", () => {
    const s = failed(3, "fork-sync:always-merge", 30);
    const d = decideSwitch(s, DEFAULT_FALLBACKS, {}, new Date(iso(31)));
    expect(d.shouldSwitch).toBe(true);
    expect(d.fromStrategy).toBe("fork-sync:always-merge");
    expect(d.toStrategy).toBe("fork-sync:ask-before-merge");
  });
});

// ---------------------------------------------------------------------------
// runSleepConsolidation integration
// ---------------------------------------------------------------------------
function appendStrategyEvent(opts: {
  content: string;
  strategy: string;
  failure: boolean;
  turnId: number;
  taskId: string;
}): MemoryEvent {
  const tags = [`strategy:${opts.strategy}`, opts.failure ? "failure" : "success"];
  return store.append({
    kind: "user_message",
    content: opts.content,
    tokens: 10,
    turnId: opts.turnId,
    sessionKey: "test",
    metadata: { tags, taskId: opts.taskId },
  });
}

describe("runSleepConsolidation strategy-switch integration", () => {
  it("absent dep → no strategySwitchesProposed field (regression guard)", async () => {
    store.append({
      kind: "user_message",
      content: "hi",
      tokens: 1,
      turnId: 0,
      sessionKey: "test",
      metadata: {},
    });
    const state = createInitialConsolidationState();
    const result = await runSleepConsolidation(store, artifactStore, state);
    expect(result.strategySwitchesProposed).toBeUndefined();
    expect(result.summariesGenerated).toBeGreaterThan(0);
  });

  it("3 abandoned same-strategy episodes → proposes a switch + writes manifest", async () => {
    // 3 distinct tasks (so 3 episodes via taskId-change boundary), same strategy, all failures.
    appendStrategyEvent({
      content: "merge run 1",
      strategy: "fork-sync:always-merge",
      failure: true,
      turnId: 0,
      taskId: "t1",
    });
    appendStrategyEvent({
      content: "merge run 2",
      strategy: "fork-sync:always-merge",
      failure: true,
      turnId: 1,
      taskId: "t2",
    });
    appendStrategyEvent({
      content: "merge run 3",
      strategy: "fork-sync:always-merge",
      failure: true,
      turnId: 2,
      taskId: "t3",
    });

    const stratState: FailureStateMap = {};
    const state = createInitialConsolidationState();
    const result = await runSleepConsolidation(store, artifactStore, state, {
      manifestBaseDir: tmpDir,
      strategySwitch: { state: stratState },
    });

    expect(result.strategySwitchesProposed).toBe(1);
    expect(stratState["fork-sync:always-merge"].consecutiveErrors).toBe(3);

    // Manifest written
    const dir = join(tmpDir, "recipe-mutations");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const lines = readFileSync(join(dir, files[0]), "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe("strategy_switch");
    expect(entry.decision.toStrategy).toBe("fork-sync:ask-before-merge");
  });

  it("2 failures → no switch proposed", async () => {
    appendStrategyEvent({
      content: "merge run 1",
      strategy: "fork-sync:always-merge",
      failure: true,
      turnId: 0,
      taskId: "t1",
    });
    appendStrategyEvent({
      content: "merge run 2",
      strategy: "fork-sync:always-merge",
      failure: true,
      turnId: 1,
      taskId: "t2",
    });

    const stratState: FailureStateMap = {};
    const state = createInitialConsolidationState();
    const result = await runSleepConsolidation(store, artifactStore, state, {
      manifestBaseDir: tmpDir,
      strategySwitch: { state: stratState },
    });
    expect(result.strategySwitchesProposed).toBe(0);
  });
});
