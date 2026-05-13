import { describe, it, expect } from "vitest";
import { classifyTask, createFaarTracker, type TaskOutcome } from "../faar-tracker.js";

function outcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    timestamp: Date.now(),
    sessionKey: "test",
    category: "coding",
    firstAttemptSuccess: true,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    tokensUsed: 1000,
    durationMs: 5000,
    retryCount: 0,
    ...overrides,
  };
}

describe("classifyTask", () => {
  it("classifies coding tasks", () => {
    expect(classifyTask("implement the new API endpoint")).toBe("coding");
    expect(classifyTask("add feature for user profiles")).toBe("coding");
  });

  it("classifies debugging tasks", () => {
    expect(classifyTask("fix the login bug")).toBe("debugging");
    expect(classifyTask("debug the failing test")).toBe("debugging");
  });

  it("classifies operational tasks", () => {
    expect(classifyTask("deploy the new version")).toBe("operational");
    expect(classifyTask("merge the upstream changes")).toBe("operational");
  });

  it("classifies research tasks", () => {
    expect(classifyTask("research the best database option")).toBe("research");
    expect(classifyTask("review paper J13")).toBe("research");
  });

  it("classifies conversation", () => {
    expect(classifyTask("hello")).toBe("conversation");
    expect(classifyTask("what time is it?")).toBe("conversation");
  });

  it("returns unknown for unclassifiable", () => {
    expect(classifyTask("asdfghjkl")).toBe("unknown");
  });
});

describe("createFaarTracker", () => {
  it("records and retrieves outcomes", () => {
    const tracker = createFaarTracker();
    tracker.record(outcome());
    expect(tracker.getOutcomes()).toHaveLength(1);
  });

  it("calculates FAAR correctly", () => {
    const tracker = createFaarTracker();
    tracker.record(outcome({ firstAttemptSuccess: true }));
    tracker.record(outcome({ firstAttemptSuccess: true }));
    tracker.record(outcome({ firstAttemptSuccess: false }));
    const metrics = tracker.getMetrics();
    expect(metrics.totalTasks).toBe(3);
    expect(metrics.firstAttemptSuccesses).toBe(2);
    expect(metrics.faar).toBeCloseTo(0.667, 2);
  });

  it("calculates average tokens", () => {
    const tracker = createFaarTracker();
    tracker.record(outcome({ tokensUsed: 1000 }));
    tracker.record(outcome({ tokensUsed: 3000 }));
    expect(tracker.getMetrics().avgTokens).toBe(2000);
  });

  it("breaks down by category", () => {
    const tracker = createFaarTracker();
    tracker.record(outcome({ category: "coding", firstAttemptSuccess: true }));
    tracker.record(outcome({ category: "coding", firstAttemptSuccess: false }));
    tracker.record(outcome({ category: "debugging", firstAttemptSuccess: true }));
    const metrics = tracker.getMetrics();
    expect(metrics.byCategory.coding.faar).toBe(0.5);
    expect(metrics.byCategory.debugging.faar).toBe(1.0);
  });

  it("breaks down by model", () => {
    const tracker = createFaarTracker();
    tracker.record(outcome({ model: "opus", firstAttemptSuccess: true }));
    tracker.record(outcome({ model: "sonnet", firstAttemptSuccess: false }));
    const metrics = tracker.getMetrics();
    expect(metrics.byModel.opus.faar).toBe(1.0);
    expect(metrics.byModel.sonnet.faar).toBe(0.0);
  });

  it("filters by timestamp", () => {
    const tracker = createFaarTracker();
    tracker.record(outcome({ timestamp: 1000 }));
    tracker.record(outcome({ timestamp: 2000 }));
    tracker.record(outcome({ timestamp: 3000 }));
    const metrics = tracker.getMetrics(2000);
    expect(metrics.totalTasks).toBe(2);
  });

  it("handles empty tracker", () => {
    const tracker = createFaarTracker();
    const metrics = tracker.getMetrics();
    expect(metrics.faar).toBe(0);
    expect(metrics.avgTokens).toBe(0);
    expect(metrics.totalTasks).toBe(0);
  });
});
