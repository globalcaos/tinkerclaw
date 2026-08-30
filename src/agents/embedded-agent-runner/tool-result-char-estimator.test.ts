import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createMessageCharEstimateCache,
  estimateMessageRawCharsCached,
  estimateMessageWeightedCharsCached,
  estimateRawContextChars,
  getToolResultText,
} from "./tool-result-char-estimator.js";

/**
 * Regression tests for malformed tool result content blocks.
 * See https://github.com/openclaw/openclaw/issues/34979
 *
 * A plugin tool handler returning undefined produces {type: "text"} (no text
 * property) in the session JSONL. Without guards, this crashes the char
 * estimator with: TypeError: Cannot read properties of undefined (reading 'length')
 */
describe("tool-result-char-estimator", () => {
  it("does not crash on toolResult with malformed text block (missing text string)", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(() => estimateMessageWeightedCharsCached(malformed, cache)).not.toThrow();
    // Malformed block should be estimated via the unknown-block fallback, not zero
    expect(estimateMessageWeightedCharsCached(malformed, cache)).toBeGreaterThan(0);
    expect(estimateMessageRawCharsCached(malformed, cache)).toBeGreaterThan(0);
  });

  it("does not crash on toolResult with null content entries", () => {
    const malformed = {
      role: "toolResult",
      toolName: "read",
      content: [null, { type: "text", text: "ok" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(() => estimateMessageWeightedCharsCached(malformed, cache)).not.toThrow();
    expect(() => estimateMessageRawCharsCached(malformed, cache)).not.toThrow();
  });

  it("getToolResultText skips malformed text blocks without crashing", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }, { type: "text", text: "valid" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(() => getToolResultText(malformed)).not.toThrow();
    expect(getToolResultText(malformed)).toBe("valid");
  });

  it("estimates well-formed toolResult correctly", () => {
    const msg = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    // "hello world".length === 11; the weighted estimate scores tool results x2.
    expect(estimateMessageRawCharsCached(msg, cache)).toBe(11);
    expect(estimateMessageWeightedCharsCached(msg, cache)).toBe(22);
  });
});

/**
 * FORK 2026-07-27 — raw vs weighted split.
 *
 * The whole-context overflow predicate must measure what actually goes on the wire
 * (uniform 4 chars/token, `toolResult.details` excluded, no x2 weighting). The
 * per-single-tool-result truncation budget deliberately keeps the pessimistic
 * 2-chars/token weighting AND charges `details`. These two must never be confused.
 */
describe("raw vs weighted char estimates", () => {
  function makeToolResultMessage(text: string, details?: unknown): AgentMessage {
    return {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
      ...(details === undefined ? {} : { details }),
    } as unknown as AgentMessage;
  }

  it("excludes toolResult.details from the raw estimate but keeps them in the weighted one", () => {
    const plain = makeToolResultMessage("x".repeat(1_000));
    const withDetails = makeToolResultMessage("x".repeat(1_000), {
      blob: "d".repeat(50_000),
    });
    const cache = createMessageCharEstimateCache();

    expect(estimateMessageRawCharsCached(plain, cache)).toBe(1_000);
    expect(estimateMessageRawCharsCached(withDetails, cache)).toBe(1_000);

    expect(estimateMessageWeightedCharsCached(plain, cache)).toBe(2_000);
    expect(estimateMessageWeightedCharsCached(withDetails, cache)).toBeGreaterThan(100_000);
  });

  it("does not apply the 2x tool-result weighting to the raw estimate", () => {
    const msg = makeToolResultMessage("y".repeat(4_096));
    const cache = createMessageCharEstimateCache();

    expect(estimateMessageRawCharsCached(msg, cache)).toBe(4_096);
    expect(estimateMessageWeightedCharsCached(msg, cache)).toBe(8_192);
  });

  it("totals only on-the-wire chars in estimateRawContextChars", () => {
    const user = {
      role: "user",
      content: "u".repeat(500),
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    const toolResult = makeToolResultMessage("t".repeat(1_500), {
      blob: "d".repeat(20_000),
    });
    const cache = createMessageCharEstimateCache();

    expect(estimateRawContextChars([user, toolResult], cache)).toBe(2_000);
  });

  it("keeps the raw and weighted caches from contaminating each other", () => {
    const msg = makeToolResultMessage("z".repeat(100));
    const cache = createMessageCharEstimateCache();

    expect(estimateMessageRawCharsCached(msg, cache)).toBe(100);
    expect(estimateMessageWeightedCharsCached(msg, cache)).toBe(200);
    expect(estimateMessageRawCharsCached(msg, cache)).toBe(100);
    expect(estimateMessageWeightedCharsCached(msg, cache)).toBe(200);
  });
});
