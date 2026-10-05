import { describe, expect, it } from "vitest";
import { bridgeRefusalOutcome, topLevelStopReasonOf } from "./stream.js";

describe("topLevelStopReasonOf (bible tinker-ui.md §5.8AB)", () => {
  it("reads a top-level message_delta stop reason", () => {
    expect(
      topLevelStopReasonOf({
        type: "stream_event",
        event: { type: "message_delta", delta: { stop_reason: "refusal" } },
      }),
    ).toBe("refusal");
  });

  it("reads a block-complete assistant line's stop reason", () => {
    expect(
      topLevelStopReasonOf({
        type: "assistant",
        message: { role: "assistant", content: [], stop_reason: "end_turn" },
      }),
    ).toBe("end_turn");
  });

  it("ignores a subagent call inside a tool", () => {
    expect(
      topLevelStopReasonOf({
        type: "stream_event",
        parent_tool_use_id: "toolu_1",
        event: { type: "message_delta", delta: { stop_reason: "refusal" } },
      }),
    ).toBeUndefined();
  });

  it("ignores lines without a stop reason and garbage", () => {
    expect(
      topLevelStopReasonOf({ type: "stream_event", event: { type: "content_block_delta" } }),
    ).toBeUndefined();
    expect(
      topLevelStopReasonOf({ type: "assistant", message: { stop_reason: null } }),
    ).toBeUndefined();
    expect(topLevelStopReasonOf({ type: "result", result: "x" })).toBeUndefined();
    expect(topLevelStopReasonOf(null)).toBeUndefined();
    expect(topLevelStopReasonOf("line")).toBeUndefined();
  });
});

describe("bridgeRefusalOutcome", () => {
  it("has the TurnOutcome shape the projection and the UI accept", () => {
    expect(bridgeRefusalOutcome()).toEqual({
      kind: "refusal",
      recoverable: false,
      headline: "The model refused to answer",
      detail: 'Claude stopped this turn with stop_reason "refusal".',
      source: "cli",
    });
  });
});
