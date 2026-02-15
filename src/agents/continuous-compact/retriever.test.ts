import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { ScoredTurnChunk } from "./session-store.js";
import { DEFAULT_RETRIEVAL_CONFIG } from "./config.js";
import { buildRetrievalQuery, formatRetrievedTurns } from "./retriever.js";

function msg(role: string, text: string): AgentMessage {
  return { role, content: [{ type: "text", text }] } as AgentMessage;
}

function scoredChunk(overrides: Partial<ScoredTurnChunk> = {}): ScoredTurnChunk {
  return {
    id: "test-1",
    sessionId: "sess",
    text: "User: hello\nAssistant: hi there",
    tokenEstimate: 20,
    timestamp: Date.now(),
    turnStartIndex: 0,
    turnEndIndex: 1,
    roles: ["user", "assistant"],
    score: 0.8,
    ...overrides,
  };
}

describe("buildRetrievalQuery", () => {
  it("includes current message", () => {
    const query = buildRetrievalQuery("what about the reactor?", [], DEFAULT_RETRIEVAL_CONFIG);
    expect(query).toContain("what about the reactor?");
  });

  it("includes recent context for ambiguous messages", () => {
    const recent = [
      msg("user", "Should we deploy the fusion reactor?"),
      msg("assistant", "The fusion reactor deployment requires careful planning."),
    ];
    const query = buildRetrievalQuery("yes, do that", recent, DEFAULT_RETRIEVAL_CONFIG);
    expect(query).toContain("fusion reactor");
    expect(query).toContain("yes, do that");
  });

  it("skips short recent messages", () => {
    const recent = [msg("user", "ok"), msg("assistant", "A longer response about deployment")];
    const query = buildRetrievalQuery("continue", recent, DEFAULT_RETRIEVAL_CONFIG);
    expect(query).toContain("deployment");
  });
});

describe("formatRetrievedTurns", () => {
  it("returns empty string for no turns", () => {
    expect(formatRetrievedTurns([])).toBe("");
  });

  it("wraps in XML-like tags", () => {
    const formatted = formatRetrievedTurns([scoredChunk()]);
    expect(formatted).toContain("<retrieved_conversation_history>");
    expect(formatted).toContain("</retrieved_conversation_history>");
  });

  it("includes turn text and metadata", () => {
    const turns = [
      scoredChunk({
        turnStartIndex: 5,
        turnEndIndex: 7,
        metadata: { toolNames: ["bash", "Read"] },
      }),
    ];
    const formatted = formatRetrievedTurns(turns);
    expect(formatted).toContain("[Turn 5-7");
    expect(formatted).toContain("[tools: bash, Read]");
  });

  it("separates multiple turns with dividers", () => {
    const turns = [
      scoredChunk({ id: "a", turnStartIndex: 0, turnEndIndex: 1 }),
      scoredChunk({ id: "b", turnStartIndex: 5, turnEndIndex: 6 }),
    ];
    expect(formatRetrievedTurns(turns)).toContain("---");
  });
});
