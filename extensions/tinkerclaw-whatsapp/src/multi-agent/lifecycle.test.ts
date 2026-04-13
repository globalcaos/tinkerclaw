import { describe, expect, it } from "vitest";
import { ConversationLifecycleManager, cosineSimilarity } from "./lifecycle.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("ConversationLifecycleManager", () => {
  it("tracks turn count", () => {
    const mgr = new ConversationLifecycleManager();
    mgr.recordTurn("chat1", "mia", "Hello");
    mgr.recordTurn("chat1", "luna", "Hi there");
    expect(mgr.getTurnCount("chat1")).toBe(2);
  });

  it("detects staleness with similar embeddings", () => {
    const mgr = new ConversationLifecycleManager({ stalenessThreshold: 0.9 });
    // Near-identical embeddings → stale
    const v1 = [1, 0.1, 0.2];
    const v2 = [1, 0.11, 0.21];
    const v3 = [1, 0.09, 0.19];
    const v4 = [1, 0.1, 0.2];

    mgr.recordTurn("chat1", "mia", "msg1", v1);
    mgr.recordTurn("chat1", "luna", "msg2", v2);
    mgr.recordTurn("chat1", "rex", "msg3", v3);
    mgr.recordTurn("chat1", "mia", "msg4", v4);

    expect(mgr.getStalenessScore("chat1")).toBeGreaterThan(0.9);
    expect(mgr.isStale("chat1")).toBe(true);
  });

  it("does not flag as stale with diverse embeddings", () => {
    const mgr = new ConversationLifecycleManager({ stalenessThreshold: 0.85 });
    mgr.recordTurn("chat1", "mia", "msg1", [1, 0, 0]);
    mgr.recordTurn("chat1", "luna", "msg2", [0, 1, 0]);
    mgr.recordTurn("chat1", "rex", "msg3", [0, 0, 1]);

    expect(mgr.isStale("chat1")).toBe(false);
  });

  it("detects agreement loops", () => {
    const mgr = new ConversationLifecycleManager();
    mgr.recordTurn("chat1", "mia", "I agree with that approach");
    mgr.recordTurn("chat1", "luna", "Exactly, good point");
    mgr.recordTurn("chat1", "rex", "Absolutely, couldn't agree more");

    expect(mgr.detectAgreementLoop("chat1")).toBe(true);
  });

  it("does not detect agreement loop with substantive content", () => {
    const mgr = new ConversationLifecycleManager();
    mgr.recordTurn("chat1", "mia", "The dataset shows a 15% improvement in Q3");
    mgr.recordTurn("chat1", "luna", "But the confidence interval is too wide for that claim");
    mgr.recordTurn("chat1", "rex", "Here's an alternative analysis using bootstrapping");

    expect(mgr.detectAgreementLoop("chat1")).toBe(false);
  });

  it("allows one pivot at a time", () => {
    const mgr = new ConversationLifecycleManager({ stalenessWindow: 3 });
    expect(mgr.proposeTopicPivot("chat1", "mia")).toBe(true);
    expect(mgr.proposeTopicPivot("chat1", "luna")).toBe(false); // Mia is pivoting

    // After enough turns, pivot expires
    mgr.recordTurn("chat1", "mia", "pivot msg");
    mgr.recordTurn("chat1", "luna", "response");
    mgr.recordTurn("chat1", "rex", "response");
    expect(mgr.proposeTopicPivot("chat1", "luna")).toBe(true);
  });

  it("tracks objective and closure", () => {
    const mgr = new ConversationLifecycleManager();
    mgr.setObjective("chat1", "Decide on Valencia move");
    expect(mgr.getObjective("chat1")).toBe("Decide on Valencia move");

    mgr.proposeClosure("chat1", "mia", "We agreed Valencia is worth it");
    expect(mgr.isConversationComplete("chat1", 3)).toBe(false);

    mgr.ackClosure("chat1", "luna");
    expect(mgr.isConversationComplete("chat1", 3)).toBe(false);

    mgr.ackClosure("chat1", "rex");
    expect(mgr.isConversationComplete("chat1", 3)).toBe(true);
  });

  it("completes on max turns", () => {
    const mgr = new ConversationLifecycleManager({ maxTurnsPerObjective: 3 });
    mgr.recordTurn("chat1", "mia", "1");
    mgr.recordTurn("chat1", "luna", "2");
    mgr.recordTurn("chat1", "rex", "3");

    expect(mgr.isConversationComplete("chat1", 3)).toBe(true);
  });

  it("reset clears state", () => {
    const mgr = new ConversationLifecycleManager();
    mgr.setObjective("chat1", "test");
    mgr.recordTurn("chat1", "mia", "msg");
    mgr.reset("chat1");

    expect(mgr.getObjective("chat1")).toBeNull();
    expect(mgr.getTurnCount("chat1")).toBe(0);
  });

  it("updateConfig changes thresholds dynamically", () => {
    const mgr = new ConversationLifecycleManager({ stalenessThreshold: 0.85 });
    // Record similar embeddings
    const v = [1, 0.1, 0.2];
    mgr.recordTurn("chat1", "a", "1", v);
    mgr.recordTurn("chat1", "b", "2", [1, 0.11, 0.21]);
    mgr.recordTurn("chat1", "c", "3", [1, 0.09, 0.19]);

    const _score = mgr.getStalenessScore("chat1");
    // With threshold 0.85, it's stale
    expect(mgr.isStale("chat1")).toBe(true);

    // Raise threshold (burn mode) → no longer stale
    mgr.updateConfig({ stalenessThreshold: 1.01 });
    expect(mgr.isStale("chat1")).toBe(false);
  });
});
