import { describe, it, expect } from "vitest";
import { createFork, estimateForkCacheSavings } from "../fork-subagent.js";

describe("createFork", () => {
  it("passes parent rendered prompt bytes verbatim", () => {
    const parentPrompt = "rendered system prompt bytes here";
    const fork = createFork({ renderedSystemPrompt: parentPrompt, task: "test" });
    expect(fork.systemPrompt).toBe(parentPrompt);
  });

  it("includes parent conversation context", () => {
    const parentMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const fork = createFork({ parentMessages, task: "test", contextDepth: 10 });
    expect(fork.messages).toHaveLength(2);
    expect(fork.messages[0]).toEqual(parentMessages[0]);
    expect(fork.messages[1]).toEqual(parentMessages[1]);
  });

  it("limits context depth", () => {
    const parentMessages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    }));
    const fork = createFork({ parentMessages, task: "test", contextDepth: 5 });
    expect(fork.messages).toHaveLength(5);
    expect(fork.messages[0].content).toBe("msg 15");
  });

  it("defaults context depth to 10", () => {
    const parentMessages = Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));
    const fork = createFork({ parentMessages, task: "test" });
    expect(fork.messages).toHaveLength(10);
  });

  it("runs in background by default", () => {
    const fork = createFork({ task: "test" });
    expect(fork.background).toBe(true);
  });

  it("can disable background", () => {
    const fork = createFork({ task: "test", background: false });
    expect(fork.background).toBe(false);
  });

  it("does not call renderSystemPrompt when rendered bytes provided", () => {
    let called = false;
    createFork({
      renderedSystemPrompt: "cached bytes",
      task: "test",
      renderSystemPrompt: () => {
        called = true;
        return "new bytes";
      },
    });
    expect(called).toBe(false);
  });

  it("uses empty string when no rendered prompt", () => {
    const fork = createFork({ task: "test" });
    expect(fork.systemPrompt).toBe("");
  });

  it("includes task description", () => {
    const fork = createFork({ task: "implement feature X" });
    expect(fork.taskPrompt).toBe("implement feature X");
  });

  it("handles empty parent messages", () => {
    const fork = createFork({ parentMessages: [], task: "test" });
    expect(fork.messages).toHaveLength(0);
  });
});

describe("estimateForkCacheSavings", () => {
  it("calculates savings for multiple children", () => {
    const result = estimateForkCacheSavings(1000, 3);
    expect(result.savedTokens).toBe(3000);
    expect(result.savingsPct).toBe(75);
  });

  it("returns 0 for no children", () => {
    const result = estimateForkCacheSavings(1000, 0);
    expect(result.savedTokens).toBe(0);
  });

  it("handles zero prompt tokens", () => {
    const result = estimateForkCacheSavings(0, 5);
    expect(result.savedTokens).toBe(0);
    expect(result.savingsPct).toBe(0);
  });
});
