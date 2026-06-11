import { describe, expect, it } from "vitest";
import { flattenResultContent } from "./stream.js";

// flattenResultContent normalizes a claude-cli tool_result `content` field
// into a single display string. The field is either a plain string (most
// tool outputs) or the full content-block array (multi-part results). The
// sibling unit ccbridge-stream-producers extracts this helper from the
// inline `user`-handler logic in stream.ts so the rule is testable in
// isolation: text blocks join with \n, every non-text / malformed block
// contributes nothing, and the empty/undefined cases collapse to "".

describe("flattenResultContent", () => {
  it("returns a plain string verbatim", () => {
    expect(flattenResultContent("hello world")).toBe("hello world");
  });

  it("preserves an empty string verbatim (string branch, not the empty fallback)", () => {
    expect(flattenResultContent("")).toBe("");
  });

  it("joins text blocks with \\n and drops non-text blocks", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "image", source: { data: "..." } },
      { type: "text", text: "second" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: exercises the runtime content-block contract
    expect(flattenResultContent(content as any)).toBe("first\nsecond");
  });

  it("filters out empty-string text blocks before joining", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "text", text: "" },
      { type: "text", text: "b" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: exercises the runtime content-block contract
    expect(flattenResultContent(content as any)).toBe("a\nb");
  });

  it("ignores null / non-object entries and text blocks with a non-string text", () => {
    const content = [
      null,
      "loose-string",
      { type: "text" },
      { type: "text", text: 42 },
      { type: "text", text: "kept" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: exercises malformed-block resilience
    expect(flattenResultContent(content as any)).toBe("kept");
  });

  it('returns "" for an empty array', () => {
    expect(flattenResultContent([])).toBe("");
  });

  it('returns "" for an array with only non-text blocks', () => {
    const content = [
      { type: "image", source: { data: "..." } },
      { type: "tool_use", id: "t1", name: "x", input: {} },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: exercises the runtime content-block contract
    expect(flattenResultContent(content as any)).toBe("");
  });

  it('returns "" for undefined', () => {
    expect(flattenResultContent(undefined)).toBe("");
  });
});
