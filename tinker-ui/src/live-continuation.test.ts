import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  closeSegment,
  MIN_DETACHED_MATCH,
  nextSegmentWrite,
  runShownTexts,
  runTurnStart,
  shownPrefixEnd,
  type SegmentCursor,
} from "./live-continuation.ts";
import { isBrowserOnlyPrompt } from "./msg-order.ts";
import { OUTBOX_MAX_ATTEMPTS } from "./outbox.ts";

const isPrompt = (m: unknown): boolean => {
  const r = m as Record<string, unknown>;
  const c = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : [];
  return c.some((b) => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
};

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "user",
  content: [{ type: "text", text }],
  ...extra,
});
const said = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});
const thought = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  _isReasoning: true,
  ...extra,
});
const toolResult = () => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
});

describe("runTurnStart", () => {
  it("prefers the prompt keyed to the run", () => {
    const page = [user("old"), said("a"), user("new", { idempotencyKey: "R" }), said("b")];
    expect(runTurnStart(page, "R", isPrompt)).toBe(2);
  });

  it("falls back to the last real prompt when nothing is keyed (a cc-bridge import row)", () => {
    const page = [user("old"), said("a"), user("new"), said("b"), toolResult()];
    expect(runTurnStart(page, "R", isPrompt)).toBe(2);
  });

  // The 2026-09-21 snapshot: history prompt (no key) + the run's rows, then the outbox's re-drawn
  // bubble carrying the run's key at the very end. Since prompt-queue.md step U2 that bubble holds
  // prompt-state FACTS (`_promptState`, msg-order.ts outboxPromptFacts) instead of the retired
  // `_undelivered` flag, and the CALLER's predicate refuses it: app.ts `isPromptRow` asks
  // msg-order.ts `isBrowserOnlyPrompt`, mirrored here.
  const isRealPrompt = (m: unknown): boolean => !isBrowserOnlyPrompt(m) && isPrompt(m);
  const withBottomCopy = (facts: Record<string, unknown>) => [
    user("prompt"),
    said("Jarvis: first narration"),
    said("second narration"),
    user("prompt", { _clientMsgId: "R", _promptState: facts }),
  ];
  const browserOnly: Array<[string, Record<string, unknown>]> = [
    ["UNSENT", { transport: "rejected", attempts: 1 }],
    ["LOST (replays spent)", { transport: "rejected", attempts: OUTBOX_MAX_ATTEMPTS }],
    ["LOST (acked, unproven)", { transport: "acked", noGatewayHolder: true }],
  ];

  for (const [state, facts] of browserOnly) {
    it(`a ${state} copy of the prompt at the bottom never cuts the run's own rows out`, () => {
      expect(runTurnStart(withBottomCopy(facts), "R", isRealPrompt)).toBe(0);
    });
  }

  it("reads no prompt state itself: the exclusion is the caller's predicate", () => {
    // CONTROL for the cases above. A predicate that admits the browser-only copy lets it become
    // the turn start and cut the run's own rows out, so the green cases are the predicate's doing.
    const page = withBottomCopy({ transport: "rejected", attempts: 1 });
    expect(runTurnStart(page, "R", isPrompt)).toBe(3);
  });

  it("a keyed optimistic prompt of a run this client started is its own turn start", () => {
    const page = [user("q1"), said("a1"), user("q2", { _clientMsgId: "R" })];
    expect(runTurnStart(page, "R", isPrompt)).toBe(2);
  });

  it("returns -1 on a page with no prompt", () => {
    expect(runTurnStart([said("x")], "R", isPrompt)).toBe(-1);
  });
});

describe("runShownTexts", () => {
  const page = [
    user("q"),
    thought("I should look at the file."),
    said("Reading the file."),
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    toolResult(),
    said("warning", { _isWarning: true }),
    said("⏱ timing", { _isPhaseTiming: true }),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Now the fix." },
        { type: "text", text: "Found it." },
      ],
    },
  ];

  it("text = answer/narration blocks after the turn start, notes excluded", () => {
    expect(runShownTexts(page, 0, "text")).toEqual(["Reading the file.", "Found it."]);
  });

  it("reasoning = thinking bubbles plus raw thinking blocks of mixed rows", () => {
    expect(runShownTexts(page, 0, "reasoning")).toEqual([
      "I should look at the file.",
      "Now the fix.",
    ]);
  });

  it("ignores rows at or before the turn start", () => {
    expect(runShownTexts([said("before"), user("q"), said("after")], 1, "text")).toEqual(["after"]);
  });

  // FORK 2026-10-03, review round 1 — two runs with no prompt of their own (a cron, an announce)
  // share the last real prompt's turn. A second run whose final repeats the first one's words found
  // the first run's bubble among "what this run shows", credited its whole body as shown and
  // pushed nothing: the answer missing until a reload. A row stamped for ANOTHER run is not this
  // run's text; history rows (no stamp) still are, which is what a page that joined mid-run needs.
  describe("scoped to one run", () => {
    const body = "Reminder: stand up, roll your shoulders and drink some water.";
    const scoped = [
      user("q"),
      said("an answer the page loaded from history"),
      thought("Time for the hourly reminder.", { _runId: "R1", _reasoningRunId: "R1" }),
      said(body, { _runId: "R1" }),
      thought("Time for the hourly reminder.", { _runId: "R2", _reasoningRunId: "R2" }),
    ];

    it("skips rows stamped for another run, so a repeated body is not credited as shown", () => {
      expect(runShownTexts(scoped, 0, "text", { runId: "R2" })).toEqual([
        "an answer the page loaded from history",
      ]);
      expect(shownPrefixEnd(body, runShownTexts(scoped, 0, "text", { runId: "R2" }))).toBe(0);
    });

    it("keeps the run's own rows, history rows and the frozen turn the run resumes", () => {
      expect(runShownTexts(scoped, 0, "text", { runId: "R1" })).toEqual([
        "an answer the page loaded from history",
        body,
      ]);
      expect(runShownTexts(scoped, 0, "text", { runId: "R2", alsoRunId: "R1" })).toContain(body);
      expect(runShownTexts(scoped, 0, "reasoning", { runId: "R2" })).toEqual([
        "Time for the hourly reminder.",
      ]);
    });

    it("unscoped, it reads every row as before", () => {
      expect(runShownTexts(scoped, 0, "text")).toContain(body);
    });

    // A history row carries no run stamp, so the scope alone still let a promptless run whose
    // final repeated an EARLIER answer the page had loaded from history ("Done.") credit that row
    // and write nothing. A row stamped before the run started cannot be the run's: with the start
    // known (the page saw its lifecycle start), such rows are skipped. A page that joined mid-run
    // never saw the start and keeps reading every history row, which is what the join needs.
    it("skips history rows stamped before the run started, when the start is known", () => {
      const STARTED = 1_000_000;
      const page = [
        user("q"),
        said("Done.", { timestamp: STARTED - 60_000 }),
        thought("Another scheduled message is due.", { _runId: "R2", _reasoningRunId: "R2" }),
        said("the run's own beginning, from history", { timestamp: STARTED + 5_000 }),
      ];
      const scope = {
        runId: "R2",
        notBefore: STARTED,
        timeOf: (m: unknown) => (m as { timestamp?: number }).timestamp ?? null,
      };
      expect(runShownTexts(page, 0, "text", scope)).toEqual([
        "the run's own beginning, from history",
      ]);
      expect(shownPrefixEnd("Done.", runShownTexts(page, 0, "text", scope))).toBe(0);
      expect(runShownTexts(page, 0, "text", { runId: "R2" })).toContain("Done.");
    });
  });
});

describe("shownPrefixEnd", () => {
  it("is 0 when the page shows nothing of the run", () => {
    expect(shownPrefixEnd("Hello there.", [])).toBe(0);
    expect(shownPrefixEnd("Hello there.", ["Something else entirely"])).toBe(0);
  });

  it("covers consecutive history rows that the cumulative buffer concatenates", () => {
    const buffer = "Jarvis: Deleted tabs are back.Reading the handler.Found two bugs.";
    const shown = ["Jarvis: Deleted tabs are back.", "Reading the handler."];
    expect(shownPrefixEnd(buffer, shown)).toBe(
      "Jarvis: Deleted tabs are back.Reading the handler.".length,
    );
  });

  it("is whitespace-insensitive: trimmed history rows against a raw stream", () => {
    const buffer = "\nFirst part.\n\nSecond part.\n\nThird, still streaming";
    const at = shownPrefixEnd(buffer, ["First part.", "Second part."]);
    expect(buffer.slice(at).trim()).toBe("Third, still streaming");
  });

  it("returns the whole buffer when the page already shows all of it", () => {
    const buffer = "One.  Two.";
    expect(shownPrefixEnd(buffer, ["One.", "Two."])).toBe(buffer.length);
  });

  it("a short text that is not at the cursor never makes the cursor leap", () => {
    // "OK." appears later in the buffer, but not where the page's text would be.
    const buffer = "Starting now. The answer is OK.";
    expect(shownPrefixEnd(buffer, ["OK."])).toBe(0);
  });

  it("after the first match, a long text found further on still advances (a block the page skipped)", () => {
    const skipped = "a block this page never received";
    const long = "x".repeat(MIN_DETACHED_MATCH) + " anchored";
    const buffer = `Opening. ${skipped} ${long} tail`;
    expect(buffer.slice(shownPrefixEnd(buffer, ["Opening.", long])).trim()).toBe("tail");
  });

  it("the first match must open the buffer: a neighbouring turn's text the run QUOTES never anchors", () => {
    // A reflection run (no prompt of its own) is scoped to the previous prompt's turn, so the
    // previous answer is among the shown texts — and the reflection quotes it.
    const previousAnswer = "The deploy failed because the lockfile drifted from package.json.";
    const buffer = `🌿 FRACTAL: I claimed "${previousAnswer}" without checking the log.`;
    expect(shownPrefixEnd(buffer, [previousAnswer])).toBe(0);
  });

  it("texts the stream never carried are skipped until one opens the buffer (a bridge resume)", () => {
    // The 2026-09-21 snapshot: the live thinking buffer began at history row 3, not row 1.
    const shown = [
      "Pulling up the tab persistence logic in tinker-ui.",
      "Reading the /api/ui-state handler in the extension.",
      "The server overwrites the whole blob with last-writer-wins.",
      "The client store is ui-state.ts.",
    ];
    const buffer = `${shown[2]}${shown[3]} Still thinking`;
    expect(buffer.slice(shownPrefixEnd(buffer, shown)).trim()).toBe("Still thinking");
  });

  it("skips a shown text the buffer does not contain and keeps matching after it", () => {
    const buffer = "Alpha. Beta.";
    expect(buffer.slice(shownPrefixEnd(buffer, ["Alpha.", "client note", "Beta."]))).toBe("");
  });
});

describe("nextSegmentWrite — one cursor rule for text and thinking", () => {
  const fresh: SegmentCursor = { uid: null, start: 0, seen: "" };

  it("opens the first bubble with the whole buffer on a run the page has not shown", () => {
    expect(nextSegmentWrite(fresh, "abc", null)).toEqual({ kind: "open", start: 0, text: "abc" });
  });

  it("continues after what the page already shows instead of restarting (the duplicate)", () => {
    const shown = "Jarvis: part one.";
    const buffer = `${shown} part two`;
    const cur: SegmentCursor = { uid: null, start: 0, seen: buffer.slice(0, shown.length) };
    expect(nextSegmentWrite(cur, buffer, null)).toEqual({
      kind: "open",
      start: shown.length,
      text: " part two",
    });
  });

  it("grows the open bubble in place", () => {
    const cur: SegmentCursor = { uid: "m1", start: 0, seen: "abc" };
    expect(nextSegmentWrite(cur, "abcdef", "abc")).toEqual({ kind: "grow", text: "abcdef" });
    expect(nextSegmentWrite(cur, "abc", "abc")).toEqual({ kind: "none" });
  });

  it("after a boundary closes the segment, the next write opens a NEW bubble below", () => {
    let cur: SegmentCursor = { uid: "m1", start: 0, seen: "think A" };
    cur = closeSegment(cur);
    const w = nextSegmentWrite(cur, "think A then B", null);
    expect(w).toEqual({ kind: "open", start: "think A".length, text: " then B" });
    cur = advanceCursor(cur, w, "think A then B", "m2");
    expect(cur).toEqual({ uid: "m2", start: 7, seen: "think A then B" });
  });

  it("never opens a bubble that would render as nothing", () => {
    const cur: SegmentCursor = { uid: null, start: 0, seen: "abc" };
    expect(nextSegmentWrite(cur, "abc\n\n", null)).toEqual({ kind: "none" });
  });

  it("a restarted stream is written as a new bubble; nothing on the page is rewritten", () => {
    const cur: SegmentCursor = { uid: "m1", start: 0, seen: "first attempt" };
    expect(nextSegmentWrite(cur, "second", "first attempt")).toEqual({
      kind: "open",
      start: 0,
      text: "second",
    });
  });

  it("refuses to shrink the open bubble", () => {
    const cur: SegmentCursor = { uid: "m1", start: 0, seen: "abcdef" };
    expect(nextSegmentWrite(cur, "abcdef", "abcdefgh")).toEqual({ kind: "none" });
  });
});
