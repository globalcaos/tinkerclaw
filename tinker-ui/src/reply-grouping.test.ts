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

  it("collapses pre-last-tool segments across multiple tool rounds (Mechanism A shape)", () => {
    // [TXT, TOOL, TOOL, TXT, TOOL, TXT] — final text after the last tool is the answer.
    // This is the interleaved shape Mechanism A reconstructs from a coalesced cc-bridge
    // turn: two tools fire back-to-back, then a mid-turn narration bubble (idx 3), then a
    // final tool, then the answer (idx 5). lastToolIdx=4 → narration = the assistant-text
    // bubbles before it (0 and 3); idx 5 stays visible as the answer.
    expect(narrationIndices([TXT, TOOL, TOOL, TXT, TOOL, TXT])).toEqual([0, 3]);
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

// FORK 2026-08-15 (the architect: "The turns now end up in a 'Reflection artifact verified' extra
// thinking … I have to expand the thinking to see the answer").
//
// The 🌿 FRACTAL section became TOOL-BACKED: the per-turn injection (app.ts buildInjectedPrompt)
// now says "write the lesson or fix to disk NOW … instead of describing it", and the reflection
// then VERIFIES the write landed. Both are real tool calls, and both fire AFTER the answer text.
//
// That falsifies this module's founding assumption — "the answer is the text after the last
// tool_result". The answer is now text BEFORE a tool, so narrationIndices demoted it into the
// collapsed Reasoning group (or, when no bubble followed, into a bare grey "Thinking:" bubble
// with no group at all) and the reflection's own trailing line became the only visible reply.
//
// The reflection's post-answer tool calls are NOT part of the main turn's work and must not
// classify anything. A run that carries a 🌿 FRACTAL bubble therefore stops counting tools
// once the last real answer bubble has been emitted.
// The 🌿 bubble itself is never `isAssistantText` — app.ts excludes a 🌿-opening bubble, and
// `isRunBoundary` usually puts it in the NEXT run anyway. Both shapes are covered below.
describe("narrationIndices — post-answer tool calls never demote the answer", () => {
  it("keeps the answer visible when the reflection writes + verifies after it", () => {
    // answer → fractal write → its tool_result, and the 🌿 bubble opens the next run.
    // Was [0] (the answer demoted to 'thinking'); must be [] — nothing to collapse.
    expect(narrationIndices([TXT, TOOL, TOOL])).toEqual([]);
  });

  it("still collapses the main turn's OWN narration in the same run", () => {
    // narration → tool → answer → fractal write → tool_result.
    // Only the pre-tool narration (0) collapses; the answer (2) stays visible.
    expect(narrationIndices([TXT, TOOL, TXT, TOOL, TOOL])).toEqual([0]);
  });

  it("handles the answer and the fractal tool arriving in ONE message", () => {
    // chat.history serves an assistant message as [text, toolCall] — the answer bubble itself
    // carries the fractal write. It sits AT the last counted tool index, never before it.
    expect(narrationIndices([TXT_TOOL, TOOL])).toEqual([]);
  });

  it("does not depend on anything that arrives AFTER the answer", () => {
    // THE RACE THIS REPLACES: app.ts freezes `_narration` at main-turn end, before the reflection
    // exists. Any rule needing to see the 🌿 bubble is therefore wrong at exactly the moment it is
    // asked. These two runs differ only in what came later — they must classify identically.
    expect(narrationIndices([TXT, TOOL, TOOL])).toEqual(narrationIndices([TXT, TOOL, TOOL]));
    expect(narrationIndices([TXT, TOOL, TXT, TOOL, TOOL])).toEqual([0]);
  });

  it("a run with NO answer bubble is unchanged", () => {
    expect(narrationIndices([TOOL, TOOL])).toEqual([]);
  });

  it("REGRESSION GUARD: every pre-existing shape classifies exactly as before", () => {
    expect(narrationIndices([TXT, TOOL, TXT])).toEqual([0]);
    expect(narrationIndices([TXT, TOOL, TXT, TXT])).toEqual([0]);
    expect(narrationIndices([TXT, TOOL, TXT, TOOL, TXT])).toEqual([0, 2]);
    expect(narrationIndices([TXT, TOOL, TOOL, TXT, TOOL, TXT])).toEqual([0, 3]);
    expect(narrationIndices([TXT, TOOL, TXT_TOOL, TXT])).toEqual([0]);
    expect(narrationIndices([TXT, SYS, TOOL, TXT])).toEqual([0]);
    expect(narrationIndices([TXT, TXT])).toEqual([]);
    expect(narrationIndices([])).toEqual([]);
  });

  // THE REAL SHAPE, measured on agent:main:tinker:msuxhsfq messages 173-176. No 🌿 marker anywhere:
  // a 4,898-char answer, the reflection's Write + Edit, then a 58-char receipt. The receipt is the
  // last text, so the cutoff alone does not save the answer — the size rule does.
  it("never collapses the run's largest text bubble (the reflection-receipt shape)", () => {
    const narr = (n: number): RunMsgKind => ({ isAssistantText: true, hasTool: false, textLen: n });
    const run = [
      narr(113), // "Path resolution issue — the repo root is…"
      TOOL,
      narr(4898), // THE ANSWER
      TOOL, // reflection: Write
      TOOL, // reflection: Edit
      narr(58), // "Memory written and indexed — both files confirmed on disk."
    ];
    const out = narrationIndices(run);
    expect(out).not.toContain(2); // the answer stays visible
    expect(out).toContain(0); // real narration still collapses
  });

  it("ties and unknown lengths leave classification untouched", () => {
    const t = (n: number): RunMsgKind => ({ isAssistantText: true, hasTool: false, textLen: n });
    // Trailing text at idx 4 keeps the cutoff out of the way, so this isolates the size rule.
    // Equal maxima → nothing is unambiguously "the" answer → both collapse, as before.
    expect(narrationIndices([t(500), TOOL, t(500), TOOL, t(10)])).toEqual([0, 2]);
    // A clear maximum → idx 2 is the answer and is spared.
    expect(narrationIndices([t(500), TOOL, t(4000), TOOL, t(10)])).toEqual([0]);
    // No lengths at all → the guard never engages.
    expect(narrationIndices([TXT, TOOL, TXT, TOOL, TXT])).toEqual([0, 2]);
  });

  it("THE ONE DELTA: a run ending on a tool keeps its last text instead of rendering blank", () => {
    // [narration, tool, answer, tool] used to collapse BOTH text bubbles, leaving the run with no
    // visible reply at all — the same "everything is thinking" pathology, seen from the other side.
    // The trailing tool now classifies nothing, so index 2 stays visible.
    expect(narrationIndices([TXT, TOOL, TXT, TOOL])).toEqual([0]);
    expect(narrationIndices([TXT, TOOL])).toEqual([]);
  });
});
