import { describe, expect, it } from "vitest";
import { buildChatUnits, THINKING_UNIT_KEY, type ChatUnitDeps } from "./chat-units.js";

// FORK 2026-11-13: a finished reply was folded into "Reasoning" after a stop check sent it back
// (seen 2026-11-04 and 2026-11-11). The reply, the tool call the send-back asked for and the short
// result sit in ONE run on the page, live and after a reload, so the reply is text with a tool after
// it; here the result repeats the card and is the longer text, so the size rule spares the result.

type Row = Record<string, unknown>;

const fence = (body: string): string => "```html-render\n<div>" + body + "</div>\n```";
/** The finished reply: a spoken line, the answer, its html card. */
const REPLY =
  "**Jarvis:** *All three pass.*\n\nConfig, port and log are fine.\n\n" +
  fence("Done: the three checks pass");
/** What follows the send-back: a short result, and the card again, a little longer. */
const RESULT =
  "**Jarvis:** *Checked, it holds.*\n\nThe port answered 200 just now.\n\n" +
  fence("Done: the three checks pass. Re-checked after the stop check: the port answered 200");
/** The line Claude Code writes for a Stop hook that blocks (templates.ts `send-back-unchecked`). */
const FEEDBACK =
  'Stop hook feedback:\nYour reply says you did not check this: "the port". Check it now with a ' +
  "tool that only reads or runs on this machine, then give the result in one or two lines.";
/** When the stop check judged the reply: after the reply began, before the next tool call. */
const SENT_BACK_AT = 7_000;

const user = (uid: string, text: string, extra: Row = {}): Row => ({
  role: "user",
  _uid: uid,
  content: [{ type: "text", text }],
  ...extra,
});
const say = (uid: string, text: string, extra: Row = {}): Row => ({
  role: "assistant",
  _uid: uid,
  content: [{ type: "text", text }],
  ...extra,
});
/** A live tool call as app.ts pushes it (the call alone), and its result as a user row. */
const call = (uid: string, id: string, extra: Row = {}): Row => ({
  role: "assistant",
  _uid: uid,
  content: [{ type: "tool_use", id, name: "read", input: {} }],
  ...extra,
});
const outcome = (uid: string, id: string, extra: Row = {}): Row => ({
  role: "user",
  _uid: uid,
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  ...extra,
});
/** A served tool step: the import hands a call and its result over as one assistant row. */
const step = (uid: string, id: string, extra: Row = {}): Row => ({
  role: "assistant",
  _uid: uid,
  content: [
    { type: "tool_use", id, name: "read", input: {} },
    { type: "tool_result", tool_use_id: id, content: "ok" },
  ],
  ...extra,
});

function deps(over: Partial<ChatUnitDeps> = {}): ChatUnitDeps {
  return {
    renderMsg: (msg, idx, thinking) =>
      `<div class="msg" data-uid="${String((msg as Row)._uid)}" data-i="${idx}"${thinking ? " data-thinking" : ""}></div>`,
    extractUserText: (msg) => {
      const c = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      return c.find((b) => b.type === "text")?.text ?? null;
    },
    expandedTools: new Set(),
    streamRunId: null,
    streamMsgUid: null,
    esc: (s) => s,
    skillNoticesHtmlAfter: () => "",
    renderThinkingIndicator: () => "",
    queuedRows: () => [],
    // What app.ts updateChat passes: a bubble's own start, else the row's time (amygdala-ui.ts rowTime).
    rowStartedAt: (m) => {
      const r = m as Row;
      const at = r._bubbleStartedAt ?? r.timestamp ?? r._arrivedAt;
      return typeof at === "number" ? at : undefined;
    },
    ...over,
  };
}

/**
 * LIVE: the rows this page wrote from the stream, each stamped by the page as it arrived. The CLI's
 * "Stop hook feedback" line is not among them: the bridge forwards only tool results from the CLI's
 * user lines (tinkerclaw-tinker-bridge stream.ts, handleLine).
 */
const liveTurn = (): Row[] => [
  user("u1", "is the service healthy?", { _promptStartedAt: 1_000 }),
  say("n1", "Reading the config first.", { _bubbleStartedAt: 2_000 }),
  call("c1", "t1", { _arrivedAt: 3_000 }),
  outcome("r1", "t1", { _arrivedAt: 3_500 }),
  say("a1", REPLY, { _bubbleStartedAt: 5_000 }),
  call("c2", "t2", { _arrivedAt: 9_000 }),
  outcome("r2", "t2", { _arrivedAt: 9_500 }),
  say("a2", RESULT, { _bubbleStartedAt: 10_000 }),
];
/** RELOAD: the same turn as chat.history serves it, one row per CLI entry with the CLI's own time. */
const servedTurn = (): Row[] => [
  user("u1", "is the service healthy?", { timestamp: 1_000 }),
  say("n1", "Reading the config first.", { timestamp: 2_000 }),
  step("s1", "t1", { timestamp: 3_000 }),
  say("a1", REPLY, { timestamp: 5_000 }),
  step("s2", "t2", { timestamp: 9_000 }),
  say("a2", RESULT, { timestamp: 10_000 }),
];

const keys = (units: { key: string }[]): string[] => units.map((u) => u.key);
const FOLDED = ["u:u1", "g:u:n1", "u:a2", THINKING_UNIT_KEY];
const SHOWN = ["u:u1", "g:u:n1", "u:a1", "u:a2", THINKING_UNIT_KEY];

describe("buildChatUnits — a reply a stop check sent back stays a reply", () => {
  it("the fixture holds what the report describes: the result is the longer text", () => {
    expect(RESULT.length).toBeGreaterThan(REPLY.length);
  });

  it("BEFORE (no send-back known): the reply is narration, folded with the tool steps", () => {
    for (const rows of [liveTurn(), servedTurn()]) {
      const units = buildChatUnits(rows, deps());
      expect(keys(units)).toEqual(FOLDED);
      const at = rows.findIndex((r) => r._uid === "a1");
      expect(units[1].html).toContain(`data-uid="a1" data-i="${at}" data-thinking`);
    }
  });

  it("LIVE: with the send-back known the reply is its own bubble, above the result", () => {
    const units = buildChatUnits(liveTurn(), deps({ sendBackTimes: () => [SENT_BACK_AT] }));
    expect(keys(units)).toEqual(SHOWN);
    const group = units[1].html;
    // Ordinary narration and every tool step, the send-back's own call included, stay folded.
    expect(group).toContain('data-uid="n1" data-i="1" data-thinking');
    for (const uid of ["c1", "r1", "c2", "r2"]) {
      expect(group).toContain(`data-uid="${uid}"`);
    }
    expect(group).not.toContain('data-uid="a1"');
    expect(units[2].html).toBe('<div class="msg" data-uid="a1" data-i="4"></div>');
  });

  it("LIVE, still streaming: the reply does not turn grey when the result starts to arrive", () => {
    // Every row of the turn is still a temp of the live run; the run is drawn flat, one unit per row.
    const streaming = (): Row[] =>
      liveTurn().map((r, k) => (k === 0 ? r : { ...r, _temporary: true, _runId: "run-1" }));
    const live = { streamRunId: "run-1", streamMsgUid: "a2" };
    const html = (units: { key: string; html: string }[], uid: string): string =>
      units.find((u) => u.key === `u:${uid}`)?.html ?? "";
    // No send-back known: the classifier greys the reply as soon as a text follows the tool.
    const plain = buildChatUnits(streaming(), deps(live));
    expect(html(plain, "a1")).toBe(
      '<div class="msg" data-uid="a1" data-i="4" data-thinking></div>',
    );
    const rows = streaming();
    const units = buildChatUnits(rows, deps({ ...live, sendBackTimes: () => [SENT_BACK_AT] }));
    expect(keys(units)).toEqual([
      "u:u1",
      "u:n1",
      "u:c1",
      "u:r1",
      "u:a1",
      "u:c2",
      "u:r2",
      "u:a2",
      THINKING_UNIT_KEY,
    ]);
    expect(html(units, "a1")).toBe('<div class="msg" data-uid="a1" data-i="4"></div>');
    expect(html(units, "n1")).toBe(
      '<div class="msg" data-uid="n1" data-i="1" data-thinking></div>',
    );
    // Nothing is stamped while the run streams: the verdict is taken again on every paint.
    expect(rows.every((r) => r._narration === undefined)).toBe(true);
  });

  it("RELOAD: the served rows classify the same way", () => {
    const units = buildChatUnits(servedTurn(), deps({ sendBackTimes: () => [SENT_BACK_AT] }));
    expect(keys(units)).toEqual(SHOWN);
    expect(units[1].html).toContain('data-uid="n1" data-i="1" data-thinking');
    expect(units[1].html).toContain('data-uid="s2"');
    expect(units[1].html).not.toContain('data-uid="a1"');
  });

  it("RELOAD: a send-back learned after the freeze lowers the stamp, and the reveal stays", () => {
    const rows = servedTurn();
    // First paint: the history is in, the Amygdala's feed is not. The run settles and is stamped.
    expect(keys(buildChatUnits(rows, deps({ sendBackTimes: () => [] })))).toEqual(FOLDED);
    expect(rows[3]._narration).toBe(true);
    // The feed arrives and the chat repaints over the same rows.
    expect(keys(buildChatUnits(rows, deps({ sendBackTimes: () => [SENT_BACK_AT] })))).toEqual(
      SHOWN,
    );
    expect(rows[3]._narration).toBe(false);
    expect(rows[1]._narration).toBe(true);
    // While no row joins the run its stamps are read back, with or without the send-back.
    expect(keys(buildChatUnits(rows, deps({ sendBackTimes: () => [] })))).toEqual(SHOWN);
  });

  it("a row that joins the run stamps it again: the reply stays while the send-back is known", () => {
    const grown = (): Row[] => {
      const rows = servedTurn();
      buildChatUnits(rows, deps({ sendBackTimes: () => [SENT_BACK_AT] }));
      rows.push(say("x", "Job finished.", { timestamp: 20_000 }));
      return rows;
    };
    const known = buildChatUnits(grown(), deps({ sendBackTimes: () => [SENT_BACK_AT] }));
    expect(keys(known)).toEqual(["u:u1", "g:u:n1", "u:a1", "u:a2", "u:x", THINKING_UNIT_KEY]);
    // amygdala-ui.ts keeps the times it handed out for the life of the page for this reason. A
    // page that no longer has the send-back (a reload after the feed's reach) folds the reply again.
    const forgotten = buildChatUnits(grown(), deps({ sendBackTimes: () => [] }));
    expect(keys(forgotten)).toEqual(["u:u1", "g:u:n1", "u:a2", "u:x", THINKING_UNIT_KEY]);
  });

  // A run that holds two turns (a wake-up has no prompt row of its own). The rule keeps the judged
  // reply and the text bubbles before it back to the last tool, so the earlier turn's closing text
  // stays visible with it. It was folded only because the later turn called a tool.
  it("in a run of two turns the text right before the judged reply stays with it", () => {
    const twoTurns = (): Row[] => [
      user("u1", "run the job", { timestamp: 1_000 }),
      step("s0", "t0", { timestamp: 2_000 }),
      say("b", "Job A finished.", { timestamp: 3_000 }),
      say("a1", REPLY, { timestamp: 5_000 }),
      step("s2", "t2", { timestamp: 9_000 }),
      say("a2", RESULT, { timestamp: 10_000 }),
    ];
    expect(keys(buildChatUnits(twoTurns(), deps()))).toEqual([
      "u:u1",
      "g:u:s0",
      "u:a2",
      THINKING_UNIT_KEY,
    ]);
    const units = buildChatUnits(twoTurns(), deps({ sendBackTimes: () => [SENT_BACK_AT] }));
    expect(keys(units)).toEqual(["u:u1", "g:u:s0", "u:b", "u:a1", "u:a2", THINKING_UNIT_KEY]);
  });

  it("the stop card then sits between the reply it judged and the result", () => {
    const units = buildChatUnits(
      liveTurn(),
      deps({
        sendBackTimes: () => [SENT_BACK_AT],
        amygdalaAfterRun: () => "",
        amygdalaStopBubbles: (prompt) =>
          (prompt as Row | null)?._uid === "u1"
            ? [
                {
                  key: "sb",
                  ts: SENT_BACK_AT,
                  html: "<i>sent back</i>",
                  opens: true,
                  seam: "stop",
                  turnId: "tab#1",
                },
              ]
            : [],
      }),
    );
    expect(keys(units)).toEqual([
      "u:u1",
      "g:u:n1",
      "u:a1",
      "amy-stop:sb",
      "u:a2",
      THINKING_UNIT_KEY,
    ]);
  });

  it("a tab no check sent back, and a send-back outside the run, change nothing", () => {
    for (const turn of [liveTurn, servedTurn]) {
      const plain = buildChatUnits(turn(), deps());
      expect(buildChatUnits(turn(), deps({ sendBackTimes: () => [] }))).toEqual(plain);
      // Before the run's first row, and after its last one: another turn's send-back.
      expect(buildChatUnits(turn(), deps({ sendBackTimes: () => [500, 99_000] }))).toEqual(plain);
    }
  });

  it("a served row with no time of its own is not a step after the check", () => {
    // An older run of the tab, wholly before another turn's send-back. One tool step was served
    // without a timestamp, so the only time it has is the moment this page loaded it.
    const old = (): Row[] => {
      const rows = servedTurn();
      rows[2] = step("s1", "t1", { __openclaw: { externalId: "cli-s1" }, _arrivedAt: 90_000 });
      return rows;
    };
    const units = buildChatUnits(old(), deps({ sendBackTimes: () => [50_000] }));
    expect(units).toEqual(buildChatUnits(old(), deps()));
    // "Reading the config first." is narration before that tool step and stays folded.
    expect(units[1].html).toContain('data-uid="n1" data-i="1" data-thinking');
  });

  // OPEN LIMIT, pinned so it is seen: the place of a send-back is read from the rows' times.
  it("a page that drew every row on waking has no row before the check: nothing is marked", () => {
    const woke = (): Row[] => [
      user("u1", "is the service healthy?", { _promptStartedAt: 1_000 }),
      say("n1", "Reading the config first.", { _bubbleStartedAt: 60_000 }),
      call("c1", "t1", { _arrivedAt: 60_001 }),
      outcome("r1", "t1", { _arrivedAt: 60_002 }),
      say("a1", REPLY, { _bubbleStartedAt: 60_003 }),
      call("c2", "t2", { _arrivedAt: 60_004 }),
      outcome("r2", "t2", { _arrivedAt: 60_005 }),
      say("a2", RESULT, { _bubbleStartedAt: 60_006 }),
    ];
    const units = buildChatUnits(woke(), deps({ sendBackTimes: () => [SENT_BACK_AT] }));
    expect(units).toEqual(buildChatUnits(woke(), deps()));
    expect(keys(units)).toEqual(FOLDED);
  });

  it("when the step before the check is a tool row the times are not the turn's: nothing is marked", () => {
    // The page slept after the first tool result and drew the rest on waking.
    const half = (): Row[] => [
      user("u1", "is the service healthy?", { _promptStartedAt: 1_000 }),
      say("n1", "Reading the config first.", { _bubbleStartedAt: 2_000 }),
      call("c1", "t1", { _arrivedAt: 3_000 }),
      outcome("r1", "t1", { _arrivedAt: 3_500 }),
      say("a1", REPLY, { _bubbleStartedAt: 60_000 }),
      call("c2", "t2", { _arrivedAt: 60_001 }),
      outcome("r2", "t2", { _arrivedAt: 60_002 }),
      say("a2", RESULT, { _bubbleStartedAt: 60_003 }),
    ];
    const units = buildChatUnits(half(), deps({ sendBackTimes: () => [SENT_BACK_AT] }));
    expect(units).toEqual(buildChatUnits(half(), deps()));
    // The narration before the first tool is not taken for the judged answer.
    expect(units[1].html).toContain('data-uid="n1" data-i="1" data-thinking');
  });

  // The fixture as the bug report words it: the user-role row IS in the view. It never is on the
  // live page, and a reload has it only if the CLI wrote the line without `isMeta`. Then it is a
  // prompt: it ends the run, so the reply before it has no tool after it and was never narration.
  it("a 'Stop hook feedback' row that does reach the page is a run boundary: the reply is a reply", () => {
    const view = [
      user("u1", "is the service healthy?"),
      say("a1", REPLY),
      user("sb", FEEDBACK),
      call("c2", "t2"),
      outcome("r2", "t2"),
      say("a2", RESULT),
    ];
    const units = buildChatUnits(view, deps());
    expect(keys(units)).toEqual(["u:u1", "u:a1", "u:sb", "g:u:c2", "u:a2", THINKING_UNIT_KEY]);
    expect(units[1].html).toBe('<div class="msg" data-uid="a1" data-i="1"></div>');
  });
});
