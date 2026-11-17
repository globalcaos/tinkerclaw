import { describe, expect, it } from "vitest";
import { narrationIndices, sentBackAnswerIndices, type RunMsgKind } from "./reply-grouping";

// FORK 2026-11-13: a finished reply was folded into "Reasoning" after a stop check sent it back
// (seen 2026-11-04 and 2026-11-11). The send-back makes the same run go on: one tool call, then a
// short result. chat-units.ts marks the bubble the check judged; this is the rule that reads it.
const TOOL: RunMsgKind = { isAssistantText: false, hasTool: true };
const THOUGHT: RunMsgKind = { isAssistantText: false, hasTool: false };
const text = (textLen: number, sentBackAfter = false): RunMsgKind => ({
  isAssistantText: true,
  hasTool: false,
  textLen,
  ...(sentBackAfter ? { sentBackAfter: true } : {}),
});
const unmarked = (kinds: RunMsgKind[]): RunMsgKind[] =>
  kinds.map((k) => ({ ...k, sentBackAfter: false }));

// Narration, its tool, the reply with its html card. The check sends it back. Then the tool call
// the send-back asked for, that call's result row, and a result text that repeats the card and is
// the longer of the two texts.
const sentBackTurn = (marked: boolean): RunMsgKind[] => [
  text(25), // 0 "Reading the config first."
  TOOL, // 1
  text(1400, marked), // 2 the spoken line, the answer, the html-render card
  TOOL, // 3 the check the send-back asked for
  TOOL, // 4 its result
  text(1450), // 5 the short result, with the card again
];

describe("narrationIndices — the answer a stop check sent back is never narration", () => {
  it("BEFORE: with no mark the reply is narration (a tool follows it, and it is not the largest bubble)", () => {
    expect(narrationIndices(sentBackTurn(false))).toEqual([0, 2]);
  });

  it("AFTER: the marked reply is an answer, and the narration before its own tool still folds", () => {
    expect(sentBackAnswerIndices(sentBackTurn(true))).toEqual([2]);
    expect(narrationIndices(sentBackTurn(true))).toEqual([0]);
  });

  it("an answer that reached the page as several bubbles is one answer", () => {
    const run = (marked: boolean): RunMsgKind[] => [
      text(40),
      TOOL,
      text(300),
      THOUGHT,
      text(500, marked),
      TOOL,
      text(900),
    ];
    expect(narrationIndices(run(false))).toEqual([0, 2, 4]);
    expect(sentBackAnswerIndices(run(true))).toEqual([2, 4]);
    expect(narrationIndices(run(true))).toEqual([0]);
  });

  it("what the agent writes after the send-back, before its tool, is still narration", () => {
    // reply, then the send-back, then a short sentence before the tool, the tool, the result
    const run = (marked: boolean): RunMsgKind[] => [text(1400, marked), text(30), TOOL, text(80)];
    expect(narrationIndices(run(false))).toEqual([1]);
    expect(narrationIndices(run(true))).toEqual([1]);
  });

  it("two send-backs in one run: both judged answers stay", () => {
    const run = (marked: boolean): RunMsgKind[] => [
      text(100),
      TOOL,
      text(800, marked),
      TOOL,
      text(700, marked),
      TOOL,
      text(900),
    ];
    expect(narrationIndices(run(false))).toEqual([0, 2, 4]);
    expect(sentBackAnswerIndices(run(true))).toEqual([2, 4]);
    expect(narrationIndices(run(true))).toEqual([0]);
  });

  it("reveals only: with marks the narration set is a subset of what it was without them", () => {
    const shapes: RunMsgKind[][] = [
      sentBackTurn(true),
      [text(40), TOOL, text(300), THOUGHT, text(500, true), TOOL, text(900)],
      [text(1400, true), text(30), TOOL, text(80)],
      [text(10, true), TOOL, text(20, true), TOOL, text(5)],
      [text(10), TOOL, { ...TOOL, sentBackAfter: true }, text(20), TOOL, text(30)],
    ];
    for (const marked of shapes) {
      const before = narrationIndices(unmarked(marked));
      for (const i of narrationIndices(marked)) {
        expect(before).toContain(i);
      }
    }
  });

  it("a mark that judges nothing changes nothing: on the run's last bubble, on a tool row", () => {
    expect(narrationIndices([text(40), TOOL, text(300, true)])).toEqual([0]);
    const onTool: RunMsgKind[] = [
      text(40),
      { ...TOOL, sentBackAfter: true },
      text(300),
      TOOL,
      text(900),
    ];
    expect(sentBackAnswerIndices(onTool)).toEqual([]);
    expect(narrationIndices(onTool)).toEqual([0, 2]);
  });

  it("REGRESSION GUARD: a run with no mark classifies exactly as before", () => {
    const TXT: RunMsgKind = { isAssistantText: true, hasTool: false };
    expect(sentBackAnswerIndices([TXT, TOOL, TXT, TOOL, TXT])).toEqual([]);
    expect(narrationIndices([TXT, TOOL, TXT, TOOL, TXT])).toEqual([0, 2]);
    expect(narrationIndices([TXT, TOOL, TXT, TOOL, TOOL])).toEqual([0]);
    expect(narrationIndices([text(500), TOOL, text(4000), TOOL, text(10)])).toEqual([0]);
    expect(narrationIndices(unmarked(sentBackTurn(true)))).toEqual(
      narrationIndices(sentBackTurn(false)),
    );
    expect(narrationIndices([])).toEqual([]);
  });
});
