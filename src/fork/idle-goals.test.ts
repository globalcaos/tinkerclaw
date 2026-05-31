import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  proposeIdleGoals,
  shouldProposeNow,
  _resetIdleGoalsState,
  type IdleGoalDeps,
  type ProposedGoal,
} from "./idle-goals.js";

beforeEach(() => _resetIdleGoalsState());

function deps(
  gaps: ProposedGoal[],
  now = 1_000_000,
): { d: IdleGoalDeps; emitted: ProposedGoal[][] } {
  const emitted: ProposedGoal[][] = [];
  return {
    emitted,
    d: {
      fetchTopGaps: vi.fn().mockResolvedValue(gaps),
      emit: (_sk, g) => emitted.push(g),
      now: () => now,
    },
  };
}

describe("proposeIdleGoals", () => {
  it("proposes when there are gaps + emits them", async () => {
    const { d, emitted } = deps([{ topic: "use the foo tool" }, { topic: "learn bar" }]);
    const out = await proposeIdleGoals("agent:main:main", d);
    expect(out).toEqual({ proposed: true, reason: "proposed" });
    expect(emitted).toEqual([[{ topic: "use the foo tool" }, { topic: "learn bar" }]]);
  });

  it("rate-limits a second proposal in the same window", async () => {
    const { d } = deps([{ topic: "x" }], 5_000_000);
    expect((await proposeIdleGoals("s", d)).proposed).toBe(true);
    const out2 = await proposeIdleGoals("s", d); // same now → within MIN interval
    expect(out2).toEqual({ proposed: false, reason: "rate-limited" });
  });

  it("allows again after the rate-limit window passes", async () => {
    const first = deps([{ topic: "x" }], 0);
    expect((await proposeIdleGoals("s", first.d)).proposed).toBe(true);
    const later = deps([{ topic: "x" }], 3 * 60 * 60 * 1000); // +3h > 2h interval
    expect((await proposeIdleGoals("s", later.d)).proposed).toBe(true);
  });

  it("skips automated/subagent sessions", async () => {
    const { d, emitted } = deps([{ topic: "x" }]);
    expect((await proposeIdleGoals("agent:main:main:subagent:abc", d)).reason).toBe("automated");
    expect(emitted).toEqual([]);
  });

  it("does not propose when there are no gaps", async () => {
    const { d, emitted } = deps([]);
    const out = await proposeIdleGoals("s", d);
    expect(out).toEqual({ proposed: false, reason: "no-gaps" });
    expect(emitted).toEqual([]);
  });

  it("handles a fetch error gracefully (no throw, no emit)", async () => {
    const emitted: ProposedGoal[][] = [];
    const d: IdleGoalDeps = {
      fetchTopGaps: vi.fn().mockRejectedValue(new Error("gateway down")),
      emit: (_sk, g) => emitted.push(g),
      now: () => 9_000_000,
    };
    expect((await proposeIdleGoals("s", d)).reason).toBe("fetch-error");
    expect(emitted).toEqual([]);
  });
});

describe("shouldProposeNow", () => {
  it("true for a never-proposed session", () => {
    expect(shouldProposeNow("fresh", 10 * 60 * 60 * 1000)).toBe(true);
  });
});
