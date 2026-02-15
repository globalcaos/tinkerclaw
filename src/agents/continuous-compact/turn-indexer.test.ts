import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_INDEXER_CONFIG } from "./config.js";
import {
  buildTurnChunks,
  flattenMessageText,
  flattenPairText,
  groupIntoPairs,
  partitionActiveWindow,
} from "./turn-indexer.js";

function msg(role: string, text: string, extra?: Record<string, unknown>): AgentMessage {
  return { role, content: [{ type: "text", text }], ...extra } as AgentMessage;
}

describe("partitionActiveWindow", () => {
  it("returns all messages in active window when under limits", () => {
    const messages = [msg("user", "hi"), msg("assistant", "hello")];
    const { activeWindow, agedOut } = partitionActiveWindow(messages);
    expect(activeWindow).toHaveLength(2);
    expect(agedOut).toHaveLength(0);
  });

  it("partitions when exceeding windowSize", () => {
    const messages = Array.from({ length: 25 }, (_, i) => msg("user", `msg ${i}`));
    const { activeWindow, agedOut } = partitionActiveWindow(messages, {
      ...DEFAULT_INDEXER_CONFIG,
      windowSize: 10,
    });
    expect(activeWindow.length).toBeLessThanOrEqual(10);
    expect(agedOut.length).toBeGreaterThan(0);
    expect(activeWindow.length + agedOut.length).toBe(25);
  });

  it("handles empty messages", () => {
    const { activeWindow, agedOut } = partitionActiveWindow([]);
    expect(activeWindow).toHaveLength(0);
    expect(agedOut).toHaveLength(0);
  });

  it("partitions based on token budget", () => {
    const bigText = "x".repeat(10_000);
    const messages = [msg("user", bigText), msg("assistant", bigText), msg("user", "recent")];
    const { activeWindow, agedOut } = partitionActiveWindow(messages, {
      ...DEFAULT_INDEXER_CONFIG,
      windowSize: 100,
      windowTokenBudget: 100,
    });
    expect(agedOut.length).toBeGreaterThan(0);
    expect(activeWindow.length + agedOut.length).toBe(3);
  });
});

describe("groupIntoPairs", () => {
  it("groups user→assistant exchanges", () => {
    const messages = [
      msg("user", "q1"),
      msg("assistant", "a1"),
      msg("user", "q2"),
      msg("assistant", "a2"),
    ];
    const pairs = groupIntoPairs(messages);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toHaveLength(2);
    expect(pairs[1]).toHaveLength(2);
  });

  it("handles assistant with tool results", () => {
    const messages = [
      msg("user", "do something"),
      msg("assistant", "calling tool"),
      msg("toolResult", "result", { toolName: "bash" }),
      msg("assistant", "done"),
    ];
    const pairs = groupIntoPairs(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toHaveLength(4);
  });

  it("handles empty array", () => {
    expect(groupIntoPairs([])).toHaveLength(0);
  });

  it("handles messages starting with assistant", () => {
    const messages = [msg("assistant", "hello"), msg("user", "hi")];
    const pairs = groupIntoPairs(messages);
    expect(pairs).toHaveLength(2);
  });
});

describe("flattenMessageText", () => {
  it("extracts text from string content", () => {
    const m = { role: "user", content: "hello" } as AgentMessage;
    expect(flattenMessageText(m)).toBe("hello");
  });

  it("extracts text from array content", () => {
    expect(flattenMessageText(msg("user", "hello world"))).toBe("hello world");
  });

  it("prefixes tool results with tool name", () => {
    const m = {
      role: "toolResult",
      content: [{ type: "text", text: "output" }],
      toolName: "bash",
    } as AgentMessage;
    expect(flattenMessageText(m)).toBe("[Tool: bash] output");
  });

  it("returns empty for non-text content", () => {
    const m = { role: "user", content: 42 } as unknown as AgentMessage;
    expect(flattenMessageText(m)).toBe("");
  });
});

describe("flattenPairText", () => {
  it("concatenates with role labels", () => {
    const pair = [msg("user", "question"), msg("assistant", "answer")];
    const text = flattenPairText(pair, 10_000);
    expect(text).toContain("User: question");
    expect(text).toContain("Assistant: answer");
  });

  it("truncates to maxChars", () => {
    const pair = [msg("user", "x".repeat(1000))];
    const text = flattenPairText(pair, 100);
    expect(text.length).toBeLessThanOrEqual(100);
  });
});

describe("buildTurnChunks", () => {
  it("builds chunks from aged-out messages", () => {
    const messages = [
      msg("user", "what is the meaning of life"),
      msg("assistant", "42, according to Douglas Adams"),
    ];
    const chunks = buildTurnChunks(messages, "test-session", 0, DEFAULT_INDEXER_CONFIG);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("test-session-pair-0");
    expect(chunks[0].turnStartIndex).toBe(0);
    expect(chunks[0].turnEndIndex).toBe(1);
    expect(chunks[0].text).toContain("User:");
    expect(chunks[0].text).toContain("Assistant:");
  });

  it("skips short turns below minTurnChars", () => {
    const messages = [msg("user", "ok"), msg("assistant", "k")];
    const chunks = buildTurnChunks(messages, "test", 0, {
      ...DEFAULT_INDEXER_CONFIG,
      minTurnChars: 100,
    });
    expect(chunks).toHaveLength(0);
  });

  it("extracts tool names in metadata", () => {
    const messages = [
      msg("user", "read the file please"),
      msg("assistant", "reading..."),
      { role: "toolResult", content: "file contents here", toolName: "Read" } as AgentMessage,
    ];
    const chunks = buildTurnChunks(messages, "test", 0, DEFAULT_INDEXER_CONFIG);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata?.toolNames).toContain("Read");
  });
});
