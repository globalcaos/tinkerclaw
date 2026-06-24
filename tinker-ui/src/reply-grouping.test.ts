import { describe, it, expect } from "vitest";
import { narrationIndices, type RunMsgKind } from "./reply-grouping";

// Shorthands for building a run's message-kind sequence.
const TXT: RunMsgKind = { isAssistantText: true, hasTool: false };
const TOOL: RunMsgKind = { isAssistantText: false, hasTool: true };
// an assistant text bubble that ALSO carries a tool block (rare) — counts as a tool position
const TXT_TOOL: RunMsgKind = { isAssistantText: true, hasTool: true };
const SYS: RunMsgKind = { isAssistantText: false, hasTool: false }; // tool-only msg / system / etc.

describe("narrationIndices (bug A: answer = text after the last tool, not 'the last bubble')", () => {
  it("collapses pre-tool narration, keeps the post-tool answer visible", () => {
    // narration → tool → answer
    expect(narrationIndices([TXT, TOOL, TXT])).toEqual([0]);
  });

  it("keeps a MULTI-bubble answer fully visible (the core regression)", () => {
    // narration → tool → answer-part-1 → answer-part-2 (block-break / gap split)
    // OLD behavior (slice(0,-1)) would have hidden answer-part-1 in Reasoning. It must stay visible.
    expect(narrationIndices([TXT, TOOL, TXT, TXT])).toEqual([0]);
  });

  it("collapses narration across MULTIPLE tool rounds, shows only the final answer", () => {
    // narration1 → tool → narration2 → tool → answer
    expect(narrationIndices([TXT, TOOL, TXT, TOOL, TXT])).toEqual([0, 2]);
  });

  it("collapses NOTHING when the run has no tools (whole reply is the answer)", () => {
    // a plain reply, possibly gap-split into two bubbles — both are the answer
    expect(narrationIndices([TXT, TXT])).toEqual([]);
    expect(narrationIndices([TXT])).toEqual([]);
  });

  it("does not collapse a bubble that sits AT the last tool position", () => {
    // a text bubble at the last-tool index is not 'before' it → stays visible
    expect(narrationIndices([TXT, TOOL, TXT_TOOL, TXT])).toEqual([0]);
  });

  it("ignores non-text / system messages for collapse selection", () => {
    // SYS (tool-only assistant / system) is never an answer bubble and is not returned here;
    // only assistant TEXT before the last tool is narration.
    expect(narrationIndices([TXT, SYS, TOOL, TXT])).toEqual([0]);
  });

  it("empty run → no narration", () => {
    expect(narrationIndices([])).toEqual([]);
  });
});
