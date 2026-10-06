import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOlderPage,
  applyOlderReply,
  applyResetArchivePage,
  archiveOf,
  backgroundTrimDue,
  foldTailReply,
  HOLE_FILL_MAX_PAGES,
  heldSeq,
  holeFillAfterFold,
  holeFillAfterTrim,
  holeFillPageLimit,
  holeFillRequest,
  holeFillStillOwed,
  holeFillWaitsForTrim,
  isCursorRequest,
  legacyReadAfterRejectedCursor,
  nextHoleFill,
  inResetGap,
  isResetDivider,
  nextResetPaging,
  oldestServerRowTs,
  OLDER_PAGE_FAILURE_BACKOFF_MS,
  olderPageBackedOff,
  pageHoleBelowWindow,
  pageHoldsServerRows,
  planHistoryAroundLooseRows,
  planOlderPage,
  planResetArchivePage,
  planRowsByTime,
  planTrim,
  removeRowsInPlace,
  replyFitsPage,
  RESET_PAGING_START,
  resetArchiveRequest,
  resetDividerRow,
  resetGapStep,
  rowLocalSeq,
  stampHistorySeqs,
  stubTrimCutoff,
  TAIL_READ_LIMIT,
  tailRequestForPage,
  turnNumberOf,
  userRowOffset,
  viewedTrimCutoff,
  windowAfterReply,
  windowToFold,
} from "./history-paging.js";
import {
  BG_STUB_ROWS,
  BG_UNLOAD_MS,
  buildTailRequest,
  emptyWindow,
  WINDOW_MAX_ROWS,
  WINDOW_PAGE,
  type HistoryWindow,
} from "./history-window.js";
import { __resetMsgOrderForTests, renderOrder, stampOrder } from "./msg-order.js";

beforeEach(() => {
  __resetMsgOrderForTests();
});

// FORK 2026-09-23 — plan task 8: the glue between a tab's page, its cursor window and a reply.

const T0 = Date.parse("2026-09-23T10:00:00Z");
const srv = (id: string, seq: number, role = "assistant") => ({
  role,
  content: [{ type: "text", text: `${role}:${id}` }],
  timestamp: T0 + seq * 1_000,
  __openclaw: { id, seq },
});
const cursor = (over: Partial<Record<string, unknown>> = {}) => ({
  epoch: "e1",
  firstSeq: 1,
  lastSeq: 100,
  hasMoreBefore: false,
  reset: false,
  ...over,
});
const held = (over: Partial<HistoryWindow> = {}): HistoryWindow => ({
  epoch: "e1",
  firstSeq: 1,
  lastSeq: 100,
  hasMoreBefore: false,
  sessionId: "sid-1",
  ...over,
});

describe("pageHoldsServerRows", () => {
  it("is false for a blank page and for a page of client-only rows", () => {
    expect(pageHoldsServerRows([])).toBe(false);
    expect(pageHoldsServerRows([{ role: "user", _clientMsgId: "c1", content: "hi" }])).toBe(false);
  });

  it("is true once any row carries a transcript identity", () => {
    expect(pageHoldsServerRows([{ role: "user", _clientMsgId: "c1" }, srv("a", 1)])).toBe(true);
  });
});

describe("tailRequestForPage", () => {
  it("asks only for rows after the window's last seq when the page holds server rows", () => {
    const { request, base } = tailRequestForPage("k", held(), [srv("a", 100)]);
    expect(request).toEqual({ sessionKey: "k", afterSeq: 100, epoch: "e1", limit: 1000 });
    expect(TAIL_READ_LIMIT).toBe(1000);
    expect(base).toEqual(held());
  });

  it("R25: a page that holds server rows asks up to 1000 rows in the legacy shape too", () => {
    expect(tailRequestForPage("k", emptyWindow(), [srv("a", 1)]).request).toEqual({
      sessionKey: "k",
      limit: TAIL_READ_LIMIT,
    });
  });

  it("a BLANK page asks the legacy shape and folds into an empty window, whatever the tab's window says", () => {
    const { request, base } = tailRequestForPage("k", held(), []);
    expect(request).toEqual({ sessionKey: "k", limit: WINDOW_PAGE });
    expect(base).toEqual(emptyWindow());
    // CONTROL: building from the tab's window alone would have written a 2-row delta onto a blank
    // page as if it were the whole transcript.
    expect(buildTailRequest("k", held())).toEqual({ sessionKey: "k", afterSeq: 100, epoch: "e1" });
  });
});

// FORK 2026-09-24 — ruling R33 (final review item 4): a rolled-back gateway rejects cursor params.
describe("legacyReadAfterRejectedCursor", () => {
  const cursorReq = { sessionKey: "k", afterSeq: 100, epoch: "e1", limit: 1000 };

  it("a cursor read that failed non-retryably owes ONE legacy-shaped read of the same page", () => {
    expect(legacyReadAfterRejectedCursor(cursorReq, true, [srv("a", 100)])).toEqual({
      request: { sessionKey: "k", limit: TAIL_READ_LIMIT },
      base: emptyWindow(),
    });
    // A blank page asks what a first open asks.
    expect(legacyReadAfterRejectedCursor(cursorReq, true, [])?.request).toEqual({
      sessionKey: "k",
      limit: WINDOW_PAGE,
    });
  });

  it("owes nothing for a transport failure, a superseded read, or a legacy read (never loops)", () => {
    expect(legacyReadAfterRejectedCursor(cursorReq, false, [srv("a", 100)])).toBeNull();
    expect(
      legacyReadAfterRejectedCursor({ sessionKey: "k", limit: 1000 }, true, [srv("a", 100)]),
    ).toBeNull();
    expect(legacyReadAfterRejectedCursor({ afterSeq: 3, epoch: "e1" }, true, [])).toBeNull();
  });
});

describe("olderPageBackedOff (R33: 60 s per session after a failed older-page read)", () => {
  it("backs off for OLDER_PAGE_FAILURE_BACKOFF_MS after a failure, then allows the next read", () => {
    expect(OLDER_PAGE_FAILURE_BACKOFF_MS).toBe(60_000);
    const failedAt = 1_000_000;
    expect(olderPageBackedOff(failedAt, failedAt)).toBe(true);
    expect(olderPageBackedOff(failedAt, failedAt + 59_999)).toBe(true);
    expect(olderPageBackedOff(failedAt, failedAt + 60_000)).toBe(false);
  });

  it("control: a session with no recorded failure is never backed off", () => {
    expect(olderPageBackedOff(undefined, 1_000_000)).toBe(false);
  });
});

describe("windowAfterReply", () => {
  it("R7: a reply with NO cursor (the gateway before its restart) leaves the window untouched", () => {
    const base = emptyWindow();
    const r = windowAfterReply(base, { sessionKey: "k", messages: [srv("a", 1)] }, "tail");
    expect(r.cursor).toBeNull();
    expect(r.window).toBe(base);
    expect(r.resetPage).toBe(false);
    // …so every later request stays legacy-shaped, and "load older" stays unavailable.
    expect(tailRequestForPage("k", r.window, [srv("a", 1)]).request).toEqual({
      sessionKey: "k",
      limit: TAIL_READ_LIMIT,
    });
  });

  it("R7: a malformed cursor is treated exactly like no cursor", () => {
    const base = held();
    const r = windowAfterReply(base, { cursor: { ...cursor(), lastSeq: -1 } }, "tail");
    expect(r.cursor).toBeNull();
    expect(r.window).toBe(base);
  });

  it("the first cursor reply adopts the reply's window, and the next request becomes a delta", () => {
    const r = windowAfterReply(
      emptyWindow(),
      { sessionId: "sid-1", cursor: cursor({ firstSeq: 51, lastSeq: 150, hasMoreBefore: true }) },
      "tail",
    );
    expect(r.window).toEqual(held({ firstSeq: 51, lastSeq: 150, hasMoreBefore: true }));
    expect(tailRequestForPage("k", r.window, [srv("a", 150)]).request).toEqual({
      sessionKey: "k",
      afterSeq: 150,
      epoch: "e1",
      limit: TAIL_READ_LIMIT,
    });
  });

  it("a delta only moves lastSeq forward", () => {
    const r = windowAfterReply(
      held({ firstSeq: 51, hasMoreBefore: true }),
      { sessionId: "sid-1", cursor: cursor({ firstSeq: 101, lastSeq: 102, hasMoreBefore: true }) },
      "tail",
    );
    expect(r.window).toEqual(held({ firstSeq: 51, lastSeq: 102, hasMoreBefore: true }));
    expect(r.resetPage).toBe(false);
  });

  it("a reset reply for the SAME session re-initialises the window from the reply (the page is kept by the merge)", () => {
    const r = windowAfterReply(
      held({ epoch: "e1", lastSeq: 100 }),
      {
        sessionId: "sid-1",
        cursor: cursor({
          epoch: "e2",
          firstSeq: 31,
          lastSeq: 130,
          hasMoreBefore: true,
          reset: true,
        }),
      },
      "tail",
    );
    expect(r.resetPage).toBe(true);
    expect(r.window).toEqual(
      held({ epoch: "e2", firstSeq: 31, lastSeq: 130, hasMoreBefore: true, sessionId: "sid-1" }),
    );
  });
});

describe("replyFitsPage", () => {
  const delta = { sessionId: "sid-1", cursor: cursor({ firstSeq: 101, lastSeq: 102 }) };

  it("a delta continues a page that holds server rows", () => {
    expect(
      replyFitsPage({ sessionKey: "k", afterSeq: 100, epoch: "e1" }, delta, [srv("a", 100)]),
    ).toBe(true);
  });

  it("a delta is NEVER written onto a page blanked while the read was in flight", () => {
    expect(replyFitsPage({ sessionKey: "k", afterSeq: 100, epoch: "e1" }, delta, [])).toBe(false);
    expect(
      replyFitsPage({ sessionKey: "k", afterSeq: 100, epoch: "e1" }, delta, [
        { role: "user", _clientMsgId: "c1" },
      ]),
    ).toBe(false);
  });

  it("a reset reply is a whole tail window and fits any page; so does a legacy-shaped read", () => {
    const reset = { sessionId: "sid-1", cursor: cursor({ reset: true }) };
    expect(replyFitsPage({ sessionKey: "k", afterSeq: 100, epoch: "e1" }, reset, [])).toBe(true);
    expect(replyFitsPage({ sessionKey: "k", limit: WINDOW_PAGE }, { messages: [] }, [])).toBe(true);
  });
});

describe("windowToFold", () => {
  it("keeps an older-page widening that landed while the tail read was in flight", () => {
    const base = held({ firstSeq: 51, hasMoreBefore: true });
    const current = held({ firstSeq: 1, hasMoreBefore: false });
    expect(windowToFold(base, current)).toBe(current);
  });

  it("falls back to the request's own window when the tab's window moved on (reset, other session)", () => {
    const base = held();
    expect(windowToFold(base, held({ epoch: "e2" }))).toBe(base);
    expect(windowToFold(base, held({ sessionId: "sid-2" }))).toBe(base);
    expect(windowToFold(base, held({ lastSeq: 120 }))).toBe(base);
    expect(windowToFold(emptyWindow(), held())).toEqual(emptyWindow());
  });
});

describe("stampHistorySeqs / heldSeq — which seq a page row has under which epoch", () => {
  it("stamps every page row the reply carries (known and new) with the reply's epoch and local seq", () => {
    const known = srv("a", 7);
    const added = srv("b", 8);
    const page = [known, { role: "user", _clientMsgId: "c1" }, added];
    const n = stampHistorySeqs(page, [srv("a", 7), added], "e1");
    expect(n).toBe(2);
    expect(heldSeq(known, "e1")).toBe(7);
    expect(heldSeq(added, "e1")).toBe(8);
    expect(heldSeq(page[1], "e1")).toBeNull();
  });

  it("an IMPORT row has no local seq and is never stamped (its seq is not a cursor position)", () => {
    const imp = {
      role: "assistant",
      timestamp: T0,
      __openclaw: { externalId: "x1", importedFrom: "claude-cli", seq: 12 },
    };
    expect(rowLocalSeq(imp)).toBeNull();
    expect(stampHistorySeqs([imp], [imp], "e1")).toBe(0);
    expect(heldSeq(imp, "e1")).toBeNull();
  });

  it("a null epoch stamps nothing (a flat/legacy transcript has no cursor positions)", () => {
    const row = srv("a", 1);
    expect(stampHistorySeqs([row], [row], null)).toBe(0);
    expect(heldSeq(row, "e1")).toBeNull();
  });

  it("a seq recorded under one epoch is never read under another", () => {
    const row = srv("a", 5);
    stampHistorySeqs([row], [row], "e1");
    expect(heldSeq(row, "e2")).toBeNull();
    // A later reply under the new epoch that carries the row re-stamps it.
    stampHistorySeqs([row], [srv("a", 3)], "e2");
    expect(heldSeq(row, "e2")).toBe(3);
  });
});

describe("planOlderPage / applyOlderPage — an older page is written ABOVE the page, by identity", () => {
  const imp = (id: string, atSeq: number) => ({
    role: "assistant",
    content: [{ type: "text", text: `import ${id}` }],
    timestamp: T0 + atSeq * 1_000,
    __openclaw: { externalId: id, importedFrom: "claude-cli" },
  });
  const texts = (list: unknown[]) =>
    renderOrder(list).map((m) => (m as { content: Array<{ text: string }> }).content[0].text);
  const stamped = (rows: unknown[], epoch = "e1") => {
    stampHistorySeqs(rows, rows, epoch);
    stampOrder(rows);
    return rows;
  };

  it("a fresh tail's older page goes above the page, above the row it was paged from", () => {
    const page = stamped([srv("s3", 3), srv("s4", 4)]);
    const older = [srv("s1", 1), srv("s2", 2)];
    const plan = planOlderPage(page, older, "e1", 3);
    expect(plan.groups).toHaveLength(1);
    applyOlderPage(page, plan);
    expect(texts(page)).toEqual(["assistant:s1", "assistant:s2", "assistant:s3", "assistant:s4"]);
  });

  it("rows interleave with import rows a trim left on the page, each landing before its next known row", () => {
    // After a trim only seq'd rows were dropped; the imports of that era are still on the page.
    const page = stamped([imp("i1", 2), imp("i2", 4), srv("s6", 6), srv("s7", 7)]);
    const older = [srv("s1", 1), imp("i1", 2), srv("s3", 3), imp("i2", 4), srv("s5", 5)];
    const plan = planOlderPage(page, older, "e1", 6);
    expect(plan.skippedKnown).toBe(2);
    applyOlderPage(page, plan);
    expect(texts(page)).toEqual([
      "assistant:s1",
      "import i1",
      "assistant:s3",
      "import i2",
      "assistant:s5",
      "assistant:s6",
      "assistant:s7",
    ]);
  });

  it("never re-adds a row the page holds, a row listed twice, or a row with no identity", () => {
    const page = stamped([srv("s3", 3)]);
    const older = [srv("s1", 1), srv("s1", 1), { role: "assistant", timestamp: T0 }, srv("s3", 3)];
    const plan = planOlderPage(page, older, "e1", 3);
    expect(plan.skippedUnplaceable).toBe(1);
    expect(plan.skippedKnown).toBe(1);
    expect(plan.groups.flatMap((g) => g.rows)).toHaveLength(1);
  });

  it("finds the paging row by its seq under the CURRENT epoch, never a stale epoch's number", () => {
    const stale = srv("old", 6);
    stampHistorySeqs([stale], [stale], "e0");
    const page = [stale, ...stamped([srv("s6", 6)], "e1")];
    stampOrder(page);
    const plan = planOlderPage(page, [srv("s5", 5)], "e1", 6);
    expect(plan.groups[0].at).toEqual({ before: page[1] });
  });

  it("skips the server copies of a run the page watched live (the tail merge's watched rule)", () => {
    const liveBubble = {
      role: "assistant",
      content: [{ type: "text", text: "live" }],
      _runId: "R",
      _bubbleStartedAt: T0 + 5_000,
      _bubbleEndedAt: T0 + 6_000,
    };
    const page = stamped([srv("s1", 1)]);
    page.push(liveBubble);
    page.push(...stamped([srv("s60", 60)]));
    stampOrder(page);
    // s5 sits inside the watched run (±15 s slack); s40 is well outside it.
    const plan = planOlderPage(page, [srv("s5", 5), srv("s40", 40)], "e1", 60);
    expect(plan.skippedWatched).toBe(1);
    expect(plan.groups.flatMap((g) => g.rows).map((m) => rowLocalSeq(m))).toEqual([40]);
  });

  it("writes NOTHING onto a page that holds no server rows (blanked while the window lingered)", () => {
    // /clear keeps tab-main's key: until the reset lands, the old window still pages the OLD
    // transcript, and a wheel on the empty pane would paint its rows onto the cleared page.
    const cleared = [{ role: "user", _clientMsgId: "c1", content: "fresh prompt" }];
    const plan = planOlderPage(cleared, [srv("s1", 1), srv("s2", 2)], "e1", 3);
    expect(plan.groups).toEqual([]);
    expect(planOlderPage([], [srv("s1", 1)], "e1", 2).groups).toEqual([]);
  });

  it("with no paging row on the page: after the last known row, else at the top", () => {
    const page = stamped([imp("i1", 2), srv("s9", 9)]);
    const afterKnown = planOlderPage(page, [imp("i1", 2), srv("s3", 3)], "e1", 99);
    expect(afterKnown.groups[0].at).toEqual({ after: page[0] });
    const top = planOlderPage(page, [srv("s1", 1)], "e1", 99);
    expect(top.groups[0].at).toBe("top");
  });

  it("every row already on the page stays the same object in the same render order", () => {
    const page = stamped([srv("s3", 3), srv("s4", 4)]);
    const before = renderOrder(page);
    applyOlderPage(page, planOlderPage(page, [srv("s1", 1), srv("s2", 2)], "e1", 3));
    const after = renderOrder(page);
    expect(after.slice(2)).toEqual(before);
    after.slice(2).forEach((m, i) => expect(m).toBe(before[i]));
  });
});

describe("foldTailReply — a re-initialised window claims only what the page holds (C1)", () => {
  const reply = (rows: unknown[], over: Partial<Record<string, unknown>> = {}) => ({
    sessionId: "sid-1",
    messages: rows,
    cursor: cursor(over),
  });

  it("a plain delta only moves lastSeq forward and stamps the rows it carried", () => {
    const page = [srv("a", 100)];
    const added = srv("b", 101);
    page.push(added);
    const w = foldTailReply(
      held({ firstSeq: 51, hasMoreBefore: true }),
      reply([added], {
        firstSeq: 101,
        lastSeq: 101,
        hasMoreBefore: true,
      }),
      page,
    );
    expect(w).toEqual(held({ firstSeq: 51, lastSeq: 101, hasMoreBefore: true }));
    expect(heldSeq(added, "e1")).toBe(101);
  });

  it("a reset whose older rows the merge skipped starts the window at the page's contiguous run", () => {
    const page = [srv("s401", 401), srv("s500", 500)];
    const rows = [srv("s301", 301), srv("s401", 401), srv("s500", 500)];
    const w = foldTailReply(
      held({ epoch: "e0", lastSeq: 500 }),
      reply(rows, { epoch: "e1", firstSeq: 301, lastSeq: 500, hasMoreBefore: true, reset: true }),
      page,
    );
    expect(w).toEqual(held({ epoch: "e1", firstSeq: 401, lastSeq: 500, hasMoreBefore: true }));
  });

  it("never starts below the reply's own firstSeq (R23), and a fresh page keeps it as served", () => {
    const rows = [srv("s1", 1), srv("s2", 2), srv("s3", 3)];
    const page = [...rows];
    const w = foldTailReply(
      emptyWindow(),
      reply(rows, { firstSeq: 2, lastSeq: 3, hasMoreBefore: true }),
      page,
    );
    expect(w).toEqual(held({ firstSeq: 2, lastSeq: 3, hasMoreBefore: true }));
  });

  it("with not even the newest row on the page, pages from one past the end", () => {
    const w = foldTailReply(
      held({ epoch: "e0" }),
      reply([srv("s9", 9)], {
        epoch: "e1",
        firstSeq: 9,
        lastSeq: 9,
        hasMoreBefore: true,
        reset: true,
      }),
      [srv("other", 1)],
    );
    expect(w).toEqual(held({ epoch: "e1", firstSeq: 10, lastSeq: 9, hasMoreBefore: true }));
  });
});

describe("isCursorRequest", () => {
  it("names the shapes an old gateway rejects (additionalProperties: false)", () => {
    expect(isCursorRequest({ sessionKey: "k", limit: 100 })).toBe(false);
    expect(isCursorRequest({ sessionKey: "k", afterSeq: 0, epoch: "e" })).toBe(true);
    expect(isCursorRequest({ sessionKey: "k", beforeSeq: 5, epoch: "e", limit: 100 })).toBe(true);
  });
});

describe("memory trim — trimmed from memory is not deleted from the page (rulings R12, plan task 8)", () => {
  /** A page of `n` server rows seq 1..n, all carried by a reply of epoch `e1`. */
  const loaded = (n: number) => {
    const rows = Array.from({ length: n }, (_, i) => srv(`s${i + 1}`, i + 1));
    stampHistorySeqs(rows, rows, "e1");
    return rows as unknown[];
  };
  const win = (lastSeq: number, over: Partial<HistoryWindow> = {}) =>
    held({ lastSeq, firstSeq: 1, hasMoreBefore: false, ...over });

  it("the VIEWED tab trims only while pinned to the latest row, and only past WINDOW_MAX_ROWS", () => {
    const page = loaded(WINDOW_MAX_ROWS + 50);
    const w = win(WINDOW_MAX_ROWS + 50);
    expect(viewedTrimCutoff(page, w, false)).toBeNull(); // reading history: never trimmed
    expect(viewedTrimCutoff(loaded(WINDOW_MAX_ROWS), win(WINDOW_MAX_ROWS), true)).toBeNull();
    expect(viewedTrimCutoff(page, w, true)).toBe(50);
    // A cursor-less window (R7) cannot page rows back, so nothing is ever trimmed from it.
    expect(viewedTrimCutoff(page, emptyWindow(), true)).toBeNull();
  });

  it("drops only rows below the cutoff that hold a seq under the CURRENT epoch", () => {
    const page = loaded(10);
    const clientNote = { role: "assistant", _isWarning: true, content: "note" };
    // Far from every row, so its watched window covers none of them (R27 keeps watched rows).
    const liveBubble = {
      role: "assistant",
      _runId: "R",
      _bubbleStartedAt: T0 + 3_600_000,
      content: "live",
    };
    const importRow = {
      role: "assistant",
      timestamp: T0 + 1_500,
      __openclaw: { externalId: "x1", importedFrom: "claude-cli" },
    };
    const staleEpochRow = srv("old", 2);
    stampHistorySeqs([staleEpochRow], [staleEpochRow], "e0");
    page.splice(1, 0, clientNote, importRow, staleEpochRow);
    page.push(liveBubble); // at the tail: a live row higher up is a barrier (next case)
    const plan = planTrim(page, win(10), 6);
    expect(plan).not.toBeNull();
    const kept = page.filter((m) => !plan!.remove.has(m));
    // seq 1..5 of e1 are gone; everything without an e1 seq stays.
    expect(kept).toContain(clientNote);
    expect(kept).toContain(liveBubble);
    expect(kept).toContain(importRow);
    expect(kept).toContain(staleEpochRow);
    expect(kept.map((m) => heldSeq(m, "e1")).filter((s) => s !== null)).toEqual([6, 7, 8, 9, 10]);
    // …and the window says there is more before, from the lowest kept row.
    expect(plan!.window).toEqual(win(10, { firstSeq: 6, hasMoreBefore: true }));
  });

  it("R27: rows inside a watched window stay in place; everything else below the cut goes", () => {
    // A live bubble whose run the page joined from its prompt: rows within the run's watched window
    // (±15 s slack; rows here are 1 s apart, so s1..s12 all fall in it) are "watched" — older pages
    // skip them, so a trim must keep them. Rows outside it are trimmed as usual, live row or not.
    const page = loaded(12);
    const liveBubble = {
      role: "assistant",
      _runId: "R",
      _bubbleStartedAt: T0 + 5_000,
      _watchedFrom: T0 + 3_000,
      content: "live",
    };
    page.splice(5, 0, liveBubble); // s1..s5, LIVE, s6..s12
    const far = loaded(40).slice(20); // s21..s40, outside the window (it ends at T0 + 20 s)
    const all = [...page, ...far];
    const plan = planTrim(all, win(40), 30);
    const removed = [...plan!.remove].map((m) => heldSeq(m, "e1"));
    expect(removed).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(plan!.remove.has(liveBubble)).toBe(false);
    // One past the highest seq dropped: the older pages serve 21..29 first, then the rest.
    expect(plan!.window.firstSeq).toBe(30);
  });

  it("I1: firstSeq never drops below the window's own, so a hole the window still owes stays pageable", () => {
    // Page 1..10 and 21..30 of one epoch; the window owes 11..20 (firstSeq 21). Trim at 5.
    const page = [...loaded(10), ...loaded(30).slice(20)];
    const plan = planTrim(page, win(30, { firstSeq: 21, hasMoreBefore: true }), 5);
    expect(plan!.window.firstSeq).toBe(21);
    expect([...plan!.remove].map((m) => heldSeq(m, "e1"))).toEqual([1, 2, 3, 4]);
  });

  it("M-b / R26: the stub drops imports above its first kept row, never a row of an older epoch", () => {
    // A local row served under an older epoch may not exist in the current transcript at all (a
    // rewrite, a branch switch), so no older page of the current epoch could serve it back.
    const olderEpochRow = srv("old", 3);
    stampHistorySeqs([olderEpochRow], [olderEpochRow], "e0");
    const importRow = {
      role: "assistant",
      timestamp: T0 + 3_500,
      __openclaw: { externalId: "x1", importedFrom: "claude-cli" },
    };
    const [s4, s5] = loaded(5).slice(3);
    const page = [olderEpochRow, importRow, s4, s5];
    const plan = planTrim(page, win(5, { firstSeq: 4 }), 5, { seqlessServerRows: true });
    expect(plan!.remove.has(importRow)).toBe(true);
    expect(plan!.remove.has(s4)).toBe(true);
    expect(plan!.remove.has(olderEpochRow)).toBe(false);
  });

  it("M-a / R26: imports are dropped only above the FIRST kept row, even when array order ≠ seq order", () => {
    // s4 was appended after s5 (a gap-fill inside the watermark slack): the lowest-SEQ kept row is
    // not the first kept row. An import between s5 and s4 sits among kept rows — no older page
    // from the window's firstSeq serves it back, so it must stay.
    const imp = (id: string, at: number) => ({
      role: "assistant",
      timestamp: T0 + at,
      __openclaw: { externalId: id, importedFrom: "claude-cli" },
    });
    const rows = loaded(5);
    const [s1, s2, s3, s4, s5] = rows;
    const above = imp("above", 3_500);
    const among = imp("among", 5_500);
    const page = [s1, s2, s3, above, s5, among, s4];
    const plan = planTrim(page, win(5), 4, { seqlessServerRows: true });
    expect(plan!.remove.has(above)).toBe(true);
    expect(plan!.remove.has(among)).toBe(false);
  });

  it("does nothing when nothing is below the cutoff, or no current-epoch row would remain", () => {
    expect(planTrim(loaded(10), win(10), 1)).toBeNull();
    expect(planTrim(loaded(10), win(10), 11)).toBeNull();
  });

  it("a BACKGROUND stub keeps exactly the newest BG_STUB_ROWS rows that hold a seq", () => {
    const page = loaded(BG_STUB_ROWS + 70);
    const cutoff = stubTrimCutoff(page, win(BG_STUB_ROWS + 70));
    expect(cutoff).toBe(71);
    const plan = planTrim(page, win(BG_STUB_ROWS + 70), cutoff as number);
    expect(page.length - plan!.remove.size).toBe(BG_STUB_ROWS);
    expect(stubTrimCutoff(loaded(BG_STUB_ROWS), win(BG_STUB_ROWS))).toBeNull();
  });

  it("a background tab is stubbed only after BG_UNLOAD_MS unviewed, and never with a live run", () => {
    const now = 10 * BG_UNLOAD_MS;
    expect(backgroundTrimDue(now, now - BG_UNLOAD_MS + 1, false)).toBe(false);
    expect(backgroundTrimDue(now, now - BG_UNLOAD_MS - 1, false)).toBe(true);
    expect(backgroundTrimDue(now, now - BG_UNLOAD_MS - 1, true)).toBe(false);
  });

  it("removeRowsInPlace keeps the array object and the order of what stays", () => {
    const page = loaded(5);
    const same = page;
    const [a, b, c, d, e] = page;
    removeRowsInPlace(page, new Set([b, d]));
    expect(page).toBe(same);
    expect(page).toEqual([a, c, e]);
  });

  it("ROUND TRIP: scrolling up after a trim brings every trimmed row back, in order", () => {
    const all = Array.from({ length: 12 }, (_, i) => srv(`s${i + 1}`, i + 1));
    const page = [...all] as unknown[];
    stampHistorySeqs(page, all, "e1");
    stampOrder(page);
    const plan = planTrim(page, win(12), 7)!;
    removeRowsInPlace(page, plan.remove);
    expect(page).toHaveLength(6);
    // The older page the window now asks for (beforeSeq 7) serves seq 1..6 again, as new objects.
    const older = Array.from({ length: 6 }, (_, i) => srv(`s${i + 1}`, i + 1));
    applyOlderPage(page, planOlderPage(page, older, "e1", plan.window.firstSeq));
    expect(renderOrder(page).map((m) => heldSeq(m, "e1") ?? rowLocalSeq(m))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});

// FORK 2026-09-24 — ruling R32: the hole a lower-edge-moving fold leaves, and when its fill stops.
describe("hole fill after a fold (R32)", () => {
  /** Page rows stamped under e1 at `seqs`. */
  const stamped = (seqs: number[]) => {
    const page = seqs.map((n) => srv(`s${n}`, n));
    stampHistorySeqs(page, page, "e1");
    return page;
  };

  it("a gap between held seqs below the window's first seq is a hole; contiguous rows are not", () => {
    const w = held({ firstSeq: 501, lastSeq: 700, hasMoreBefore: true });
    expect(pageHoleBelowWindow(stamped([399, 400, 501, 502]), w)).toBe(true);
    expect(pageHoleBelowWindow(stamped([499, 500, 501, 502]), w)).toBe(false);
    expect(pageHoleBelowWindow(stamped([501, 502]), w)).toBe(false); // only "more before"
  });

  it("a local row with no seq under the window's epoch is a hole; client rows and imports are not", () => {
    const w = held({ firstSeq: 501, lastSeq: 700, hasMoreBefore: true });
    const page = stamped([501, 502]);
    const client = { role: "user", _clientMsgId: "c1", content: "hi" };
    const imp = {
      role: "assistant",
      content: "i",
      __openclaw: { externalId: "x1", importedFrom: "claude-cli" },
    };
    expect(pageHoleBelowWindow([client, imp, ...page], w)).toBe(false);
    expect(pageHoleBelowWindow([srv("old", 12), ...page], w)).toBe(true); // stamped by no reply of e1
  });

  it("only a fold that moved the window's lower edge owes a fill", () => {
    const page = stamped([399, 400, 501, 502]);
    const after = held({ firstSeq: 501, lastSeq: 700, hasMoreBefore: true });
    expect(holeFillAfterFold(page, held({ firstSeq: 1, lastSeq: 400 }), after)).toEqual({
      epoch: "e1",
      pagesLeft: HOLE_FILL_MAX_PAGES,
      floor: 501,
    });
    expect(holeFillAfterFold(page, { ...after, lastSeq: 650 }, after)).toBeNull(); // a plain delta
  });

  it("a fill stops when its pages are spent, the epoch moved, or an older page reached held rows", () => {
    const plan = { epoch: "e1", pagesLeft: 2, floor: 501 };
    const written = { kind: "written" as const, window: held(), written: [], reachedHeld: false };
    expect(nextHoleFill(plan, written)).toEqual({ epoch: "e1", pagesLeft: 1, floor: 501 });
    expect(nextHoleFill({ ...plan, pagesLeft: 1 }, written)).toBeNull();
    expect(nextHoleFill(plan, { ...written, reachedHeld: true })).toBeNull();
    expect(nextHoleFill(plan, { kind: "reset", window: emptyWindow(), written: [] })).toBeNull();
    const page = stamped([399, 400, 501, 502]);
    const w = held({ firstSeq: 501, lastSeq: 700, hasMoreBefore: true });
    expect(holeFillStillOwed(plan, page, w)).toBe(true);
    expect(holeFillStillOwed(plan, page, { ...w, epoch: "e2" })).toBe(false);
  });

  it("WAITS — still owed, not discarded — while the pinned viewed trim would drop every row a fill page brings back (R32 residual)", () => {
    const plan = { epoch: "e1", pagesLeft: 3, floor: 501 };
    const page = stamped([399, 400, 501, 502]);
    const w = held({ firstSeq: 501, lastSeq: 1000, hasMoreBefore: true });
    expect(holeFillStillOwed(plan, page, w)).toBe(true); // the pinned trim never discards it
    expect(holeFillWaitsForTrim(w, 600)).toBe(true); // trim floor above the lower edge
    expect(holeFillWaitsForTrim(w, 501)).toBe(true);
    expect(holeFillWaitsForTrim(w, 300)).toBe(false);
    expect(holeFillWaitsForTrim(w, null)).toBe(false); // not pinned, or a page under the cap
  });

  it("a fill page asks back the rows a pinned trim took since the plan was armed, capped at the gateway maximum", () => {
    const plan = { epoch: "e1", pagesLeft: 3, floor: 551 };
    const w = (firstSeq: number) => held({ firstSeq, lastSeq: 1550, hasMoreBefore: true });
    expect(holeFillPageLimit(plan, w(551))).toBe(WINDOW_PAGE); // nothing trimmed: a plain page
    expect(holeFillPageLimit(plan, w(451))).toBe(WINDOW_PAGE); // already inside the hole
    expect(holeFillPageLimit(plan, w(1150))).toBe(WINDOW_PAGE + 599); // 451..1149 in one read
    expect(holeFillPageLimit(plan, w(5000))).toBe(TAIL_READ_LIMIT);
    expect(holeFillRequest("k", w(1150), plan)).toEqual({
      sessionKey: "k",
      beforeSeq: 1150,
      limit: 699,
      epoch: "e1",
    });
    expect(holeFillRequest("k", held({ firstSeq: 1, hasMoreBefore: false }), plan)).toBeNull();
  });

  it("a pinned trim that leaves an older epoch's rows above what it dropped owes a fill; otherwise the plan is untouched", () => {
    const w = held({ firstSeq: 1150, lastSeq: 1550, hasMoreBefore: true });
    const dropped = new Set<unknown>(stamped([551, 552, 1149]));
    const kept = stamped([1150, 1151]);
    const olderEpoch = srv("old", 400); // a local seq, stamped by no reply of e1
    expect(holeFillAfterTrim(null, [olderEpoch, ...kept], dropped, w)).toEqual({
      epoch: "e1",
      pagesLeft: HOLE_FILL_MAX_PAGES,
      floor: 551,
    });
    expect(holeFillAfterTrim(null, kept, dropped, w)).toBeNull(); // nothing of an older epoch stays
    const owed = { epoch: "e1", pagesLeft: 1, floor: 700 };
    // An owed plan keeps its budget; only its floor drops to what the trim took.
    expect(holeFillAfterTrim(owed, [olderEpoch, ...kept], dropped, w)).toEqual({
      epoch: "e1",
      pagesLeft: 1,
      floor: 551,
    });
    expect(holeFillAfterTrim(owed, kept, dropped, w)).toBe(owed);
    const stale = { epoch: "e0", pagesLeft: 1, floor: 10 };
    expect(holeFillAfterTrim(stale, [olderEpoch, ...kept], dropped, w)).toEqual({
      epoch: "e1",
      pagesLeft: HOLE_FILL_MAX_PAGES,
      floor: 551,
    });
  });
});

// FORK 2026-09-24 — ruling R36: turn numbers (and EEG prompt indexes) count from the transcript's
// start, not from the page: the window's userRowsBefore plus the page's own user rows.
describe("turn numbering on a partial page (R36)", () => {
  /** Local rows seq from..to; odd seqs are user rows. Stamped under e1 when `stamp`. */
  const rows = (from: number, to: number, stamp = true) => {
    const page = Array.from({ length: to - from + 1 }, (_, i) =>
      srv(`r${from + i}`, from + i, (from + i) % 2 === 1 ? "user" : "assistant"),
    );
    if (stamp) {
      stampHistorySeqs(page, page, "e1");
    }
    return page;
  };

  it("absent userRowsBefore: the page's own count (today's behavior)", () => {
    const page = rows(51, 100);
    expect(userRowOffset(page, held({ firstSeq: 51 }))).toBe(0);
    expect(turnNumberOf(page, held({ firstSeq: 51 }))).toBe(25);
  });

  it("offsets the page's count by the rows before the window", () => {
    const page = rows(51, 100);
    const w = held({ firstSeq: 51, hasMoreBefore: true, userRowsBefore: 25 });
    expect(turnNumberOf(page, w)).toBe(50);
    // A client prompt not yet in the transcript counts like any user row on the page.
    expect(turnNumberOf([...page, { role: "user", _clientMsgId: "c1", content: "hi" }], w)).toBe(
      51,
    );
  });

  it("rows the page holds below firstSeq (or from another epoch) are not counted twice", () => {
    const below = rows(1, 10); // e.g. kept below a trim cut: already inside userRowsBefore
    const foreign = rows(11, 20, false); // stamped by no reply of e1
    const w = held({ firstSeq: 51, hasMoreBefore: true, userRowsBefore: 25 });
    expect(turnNumberOf([...below, ...foreign, ...rows(51, 100)], w)).toBe(50);
  });

  it("an older page moves rows from the offset onto the page: the number stays", () => {
    const page = rows(51, 100);
    const w = held({ firstSeq: 51, hasMoreBefore: true, userRowsBefore: 25 });
    const before = turnNumberOf(page, w);
    const reply = {
      sessionId: "sid-1",
      messages: rows(31, 50, false),
      cursor: cursor({ firstSeq: 31, lastSeq: 50, hasMoreBefore: true, userRowsBefore: 15 }),
    };
    const out = applyOlderReply(page, w, reply);
    expect(out.window).toMatchObject({ firstSeq: 31, userRowsBefore: 15 });
    expect(turnNumberOf(page, out.window)).toBe(before);
  });

  it("a trim moves rows from the page into the offset: the number stays", () => {
    const page = rows(1, 500);
    const w = held({ firstSeq: 1, lastSeq: 500, userRowsBefore: 0 });
    const before = turnNumberOf(page, w);
    const plan = planTrim(page, w, 101);
    expect(plan).not.toBeNull();
    removeRowsInPlace(page, plan!.remove);
    expect(plan!.window).toMatchObject({ firstSeq: 101, userRowsBefore: 50 });
    expect(turnNumberOf(page, plan!.window)).toBe(before);
  });

  it("a re-initialised window that claims less than its reply counts the rows in between (C1)", () => {
    // Page 401..500; a reset reply 301..500 with 150 user rows before 301. The merge skipped
    // 301..400 as behind the page, so the window starts at 401 and owes their 50 user rows too.
    const page = rows(401, 500, false);
    const reply = {
      sessionId: "sid-1",
      messages: rows(301, 500, false),
      cursor: cursor({
        firstSeq: 301,
        lastSeq: 500,
        hasMoreBefore: true,
        reset: true,
        userRowsBefore: 150,
      }),
    };
    const w = foldTailReply(held({ firstSeq: 401, lastSeq: 500 }), reply, page);
    expect(w).toMatchObject({ firstSeq: 401, userRowsBefore: 200 });
    expect(turnNumberOf(page, w)).toBe(250);
  });
});

// FORK 2026-10-02 (the architect: "When switching from Acmevision to its slave, parallel worker, the chat
// history does not load at all") — after a reload, a tab whose session never stops running held
// only the live bubbles it had watched since: the tail merge waits for a quiet session (a fresh
// write would drop the live bubble) and the background prefetch skipped any page with rows. The
// history is now written AROUND those rows by time, never replacing them.
describe("planHistoryAroundLooseRows — history for a page that holds only live rows", () => {
  const live = (uid: string, at: number, watchedFrom?: number) => ({
    role: "assistant",
    _uid: uid,
    _runId: "run-1",
    _bubbleStartedAt: T0 + at * 1_000,
    ...(watchedFrom === undefined ? {} : { _watchedFrom: T0 + watchedFrom * 1_000 }),
    content: [{ type: "text", text: `live ${uid}` }],
  });
  const note = (uid: string, at: number) => ({
    role: "system",
    _uid: uid,
    _isPhaseTiming: true,
    ts: T0 + at * 1_000,
  });
  const ids = (page: unknown[]) =>
    renderOrder(page).map(
      (m) =>
        (m as { __openclaw?: { id?: string } }).__openclaw?.id ?? (m as { _uid?: string })._uid,
    );

  it("writes the older transcript ABOVE the live bubbles, skipping the run they already show", () => {
    const page: unknown[] = [live("L1", 50, 40), live("L2", 60)];
    stampOrder(page); // they are on screen
    const before = [...page];
    // a..e and g predate the run; f falls inside its watched window (40 s − 15 s .. 60 s + 15 s).
    const incoming = [
      srv("a", 1, "user"),
      srv("b", 2),
      srv("c", 3, "user"),
      srv("d", 4),
      srv("e", 5),
      srv("g", 20),
      srv("f", 45),
    ];
    const plan = planHistoryAroundLooseRows(page, incoming);
    expect(plan.skippedWatched).toBe(1);
    const written = applyOlderPage(page, plan);
    expect(written).toHaveLength(6);
    expect(ids(page)).toEqual(["a", "b", "c", "d", "e", "g", "L1", "L2"]);
    // Nothing that was on the page moved or went: the live bubbles are the same objects.
    for (const m of before) {
      expect(page).toContain(m);
    }
  });

  it("slots history around a client note by time", () => {
    const page: unknown[] = [note("N", 3), live("L1", 50, 40)];
    stampOrder(page);
    const plan = planHistoryAroundLooseRows(page, [srv("a", 1), srv("b", 2), srv("c", 4)]);
    applyOlderPage(page, plan);
    expect(ids(page)).toEqual(["a", "b", "N", "c", "L1"]);
  });

  it("leaves a page that already holds server rows to the ordinary merge", () => {
    const page: unknown[] = [srv("a", 1), live("L1", 50, 40)];
    expect(planHistoryAroundLooseRows(page, [srv("b", 2)]).groups).toEqual([]);
  });

  it("never writes a row it could not recognise again", () => {
    const page: unknown[] = [live("L1", 50, 40)];
    const plan = planHistoryAroundLooseRows(page, [{ role: "assistant", timestamp: T0 }]);
    expect(plan.groups).toEqual([]);
    expect(plan.skippedUnplaceable).toBe(1);
  });
});

// app.ts is an un-testable browser entry: the three places a busy session's tab used to stay blank
// are read off its source (the scroll-follow.test.ts technique).
describe("app.ts: a tab holding only live rows still gets its history", () => {
  const appSrc = (): string => {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "tinker-ui", "src", "app.ts");
      if (existsSync(candidate)) {
        return readFileSync(candidate, "utf8");
      }
      dir = path.dirname(dir);
    }
    throw new Error(`could not locate tinker-ui/src/app.ts from ${process.cwd()}`);
  };
  const app = appSrc();
  const body = (decl: string): string => {
    const at = app.indexOf(decl);
    expect(at, `${decl} moved or was renamed`).toBeGreaterThan(-1);
    return app.slice(at, app.indexOf("\n}\n", at));
  };

  it("the foreground merge writes around live rows instead of only deferring", () => {
    const branch = body("async function loadChat(").split("if (liveWriter) {")[1] ?? "";
    expect(branch.slice(0, 3000)).toMatch(
      /!pageHoldsServerRows\(messages\)[\s\S]{0,200}writeHistoryAroundLooseRows\(messages,/,
    );
    // FORK 2026-10-03 (reverted the same day) — never into a page that already holds history: the
    // by-time write under a live run drew copies (a replay of captured frames, fix/chat-live-dup).
    expect(branch.slice(0, 3000)).not.toContain("writeHistoryByTime");
  });

  it("entering a tab fills the turns its session ran and archived while it was away", () => {
    const sw = body("function applyTabSwitch(");
    expect(sw).toMatch(/loadChat\(\);[\s\S]{0,200}void fillResetGap\(\);/);
  });

  it("the background prefetch skips only a page that already holds history", () => {
    const h = body("async function hydrateTab(");
    expect(h).toContain("if (pageHoldsServerRows(ts.messages) && !opts?.force) {");
    expect(h).not.toContain("if (ts.messages.length > 0 && !opts?.force) {");
  });

  it("a background page of live rows is written around, never replaced", () => {
    expect(body("function mergeHistoryIntoSavedPage(")).toMatch(
      /if \(ts\.messages\.length > 0 && !pageHoldsServerRows\(ts\.messages\)\) \{\s*\n\s*const written = writeHistoryAroundLooseRows\(ts\.messages, incoming\);/,
    );
  });

  // FORK 2026-10-05 (bug-log busy-tab-history-and-eeg) — a scroll to the top pages back while the
  // session runs: the live-run gate silently refused it, and AcmeVision's turns run 30-45 min.
  it("a scroll-back older page is not gated on a live run; only a hole fill is", () => {
    const older = body("async function loadOlderPage(");
    expect(older).toContain("const liveRunGate = fill !== undefined;");
    expect(older).not.toMatch(
      /\|\|\s*transcriptWriterLive\(\)\s*\|\|\s*viewedSessionBusy\(\)\s*\)/,
    );
    expect(older).toContain('pane?.classList.add("archive-loading");');
  });

  it("the EEG backfill runs for a live session and never clears a richer or live store", () => {
    const eeg = body("function backfillEegFromAnatomy(");
    expect(eeg.slice(0, 1500)).not.toMatch(/if \(sessionIsBusy\(eegSk\)[^\n]*\{\s*\n\s*return;/);
    expect(eeg).toMatch(/if \(!olderOnly\) \{\s*\n\s*store\.clear\(\);/);
    expect(eeg).toContain("&fields=eeg");
  });
});

// FORK 2026-10-02 (the architect: "The parallel worker's chat history seems to not be loading") — a session
// reset every turn: chat.history {resetArchiveBefore: T} serves the newest archive reset before T,
// and the page writes it above what it holds, under a "session reset" divider.
describe("reset archives — paging past the start of the live transcript", () => {
  const imp = (id: string, at: number) => ({
    role: "assistant",
    content: [{ type: "text", text: `imp ${id}` }],
    timestamp: T0 + at * 1_000,
    __openclaw: { externalId: id },
  });
  const order = (page: unknown[]) =>
    renderOrder(page).map((m) => {
      const r = m as { __openclaw?: { id?: string; externalId?: string }; _resetAt?: number };
      return r.__openclaw?.id ?? r.__openclaw?.externalId ?? `divider@${r._resetAt}`;
    });

  it("asks before the instant it has reached, and stops once the transcript's start is reached", () => {
    let p = RESET_PAGING_START;
    expect(resetArchiveRequest("k", p)).toEqual({
      sessionKey: "k",
      resetArchiveBefore: Number.MAX_SAFE_INTEGER,
      limit: TAIL_READ_LIMIT,
    });
    p = nextResetPaging(p, { resetAt: T0 + 500_000, olderCount: 2, rowsBefore: 0 }, 40);
    expect(resetArchiveRequest("k", p)).toEqual({
      sessionKey: "k",
      resetArchiveBefore: T0 + 500_000,
      limit: TAIL_READ_LIMIT,
    });
    p = nextResetPaging(p, { resetAt: T0 + 100_000, olderCount: 0, rowsBefore: 0 }, 40);
    expect(p.done).toBe(true);
    expect(resetArchiveRequest("k", p)).toBeNull();
    // None that old: done too.
    expect(
      nextResetPaging(RESET_PAGING_START, { resetAt: null, olderCount: 0, rowsBefore: 0 }, 0).done,
    ).toBe(true);
  });

  it("reads a long archive in pages from its end before moving to the one before it", () => {
    let p = RESET_PAGING_START;
    p = nextResetPaging(p, { resetAt: T0 + 500_000, olderCount: 1, rowsBefore: 1500 }, 1000);
    expect(resetArchiveRequest("k", p)).toEqual({
      sessionKey: "k",
      resetArchiveBefore: T0 + 500_001,
      archiveOffset: 1000,
      limit: TAIL_READ_LIMIT,
    });
    p = nextResetPaging(p, { resetAt: T0 + 500_000, olderCount: 1, rowsBefore: 500 }, 1000);
    expect(resetArchiveRequest("k", p)?.archiveOffset).toBe(2000);
    p = nextResetPaging(p, { resetAt: T0 + 500_000, olderCount: 1, rowsBefore: 0 }, 500);
    expect(resetArchiveRequest("k", p)).toEqual({
      sessionKey: "k",
      resetArchiveBefore: T0 + 500_000,
      limit: TAIL_READ_LIMIT,
    });
  });

  it("reads the archive block off a reply, and nothing off a gateway that predates archives", () => {
    expect(
      archiveOf({ messages: [], archive: { resetAt: 5, olderCount: 1, rowsBefore: 3 } }),
    ).toEqual({ resetAt: 5, olderCount: 1, rowsBefore: 3, kind: "reset" });
    // A gateway from before archive paging: whole archives.
    expect(archiveOf({ messages: [], archive: { resetAt: 5, olderCount: 1 } })?.rowsBefore).toBe(0);
    expect(archiveOf({ messages: [] })).toBeNull();
    expect(archiveOf({ messages: [], archive: { resetAt: "x", olderCount: 1 } })).toBeNull();
  });

  // FORK 2026-10-03 (the architect: "There are still tabs where the history has been erased") — the
  // gateway now pages every earlier transcript of a tab, copies included; the page names the
  // oldest row it holds, and only older rows come back.
  it("names the oldest row the page holds when it starts an archive, and keeps that floor while reading it", () => {
    let p = RESET_PAGING_START;
    expect(resetArchiveRequest("k", p, T0 + 9_000)).toEqual({
      sessionKey: "k",
      resetArchiveBefore: Number.MAX_SAFE_INTEGER,
      archiveFloor: T0 + 9_000,
      limit: TAIL_READ_LIMIT,
    });
    p = nextResetPaging(
      p,
      { resetAt: T0 + 500_000, olderCount: 1, rowsBefore: 1500, kind: "copy" },
      1000,
      T0 + 9_000,
    );
    // Still reading that archive: the floor it started with, whatever the page holds now.
    expect(resetArchiveRequest("k", p, T0 + 1_000)).toEqual({
      sessionKey: "k",
      resetArchiveBefore: T0 + 500_001,
      archiveOffset: 1000,
      archiveFloor: T0 + 9_000,
      limit: TAIL_READ_LIMIT,
    });
    p = nextResetPaging(
      p,
      { resetAt: T0 + 500_000, olderCount: 1, rowsBefore: 0, kind: "copy" },
      500,
      T0 + 9_000,
    );
    // The archive before it starts from the page's oldest row now.
    expect(resetArchiveRequest("k", p, T0 + 1_000)?.archiveFloor).toBe(T0 + 1_000);
    // A page with no server row names no floor (then the gateway serves resets only).
    expect(resetArchiveRequest("k", RESET_PAGING_START, null)).not.toHaveProperty("archiveFloor");
  });

  it("the floor is the oldest server row's time; dividers and client-only rows do not count", () => {
    const page: unknown[] = [
      resetDividerRow(T0 + 1, "reset"),
      { role: "user", content: "a client note", timestamp: T0 + 2 },
      srv("n1", 100, "user"),
      srv("n2", 101),
    ];
    expect(oldestServerRowTs(page)).toBe(T0 + 100_000);
    expect(oldestServerRowTs([])).toBeNull();
  });

  it("reads what kind of transcript was served; a gateway before kinds served resets", () => {
    expect(
      archiveOf({ archive: { resetAt: 5, olderCount: 1, rowsBefore: 0, kind: "earlier" } })?.kind,
    ).toBe("earlier");
    expect(archiveOf({ archive: { resetAt: 5, olderCount: 1, rowsBefore: 0 } })?.kind).toBe(
      "reset",
    );
    expect(resetDividerRow(T0, "copy")._resetKind).toBe("copy");
  });

  // FORK 2026-10-03 (the architect, 4th report: "In the 'Parallel worker' tab I still cannot see its full
  // history") — a tab in the background never receives its session's live turns, and the worker's
  // session is reset before every turn, so the turns that ran while he was in another tab exist only
  // in archives, BETWEEN the rows the page kept and the turn it shows now.
  it("an archive of turns that ran while the tab was away goes between the rows around it, by time", () => {
    const page: unknown[] = [
      srv("a1", 10, "user"),
      srv("a2", 11),
      srv("c1", 100, "user"),
      srv("c2", 101),
    ];
    stampOrder(page);
    applyResetArchivePage(
      page,
      planResetArchivePage(page, [imp("b1", 50), imp("b2", 51)], T0 + 60_000),
    );
    expect(order(page)).toEqual(["a1", "a2", "b1", "b2", `divider@${T0 + 60_000}`, "c1", "c2"]);
  });

  it("does not write again a run the page watched live; the divider then goes where the reset fell", () => {
    const live = {
      role: "assistant",
      _uid: "L1",
      _runId: "run-1",
      _bubbleStartedAt: T0 + 52_000,
      _watchedFrom: T0 + 50_000,
      content: [{ type: "text", text: "live L1" }],
    };
    const page: unknown[] = [srv("a1", 10, "user"), live, srv("c1", 100, "user")];
    stampOrder(page);
    const plan = planResetArchivePage(page, [imp("b1", 50), imp("b2", 52)], T0 + 60_000);
    expect(plan.skippedWatched).toBe(2);
    applyResetArchivePage(page, plan);
    const ids = renderOrder(page).map((m) => {
      const r = m as { __openclaw?: { id?: string }; _uid?: string; _resetAt?: number };
      return isResetDivider(r) ? `divider@${r._resetAt}` : (r.__openclaw?.id ?? r._uid);
    });
    expect(ids).toEqual(["a1", "L1", `divider@${T0 + 60_000}`, "c1"]);
  });

  it("fills only the span the page holds: an archive set aside before its oldest row is older history", () => {
    expect(inResetGap({ resetAt: T0 + 60_000, olderCount: 1, rowsBefore: 0 }, T0 + 10_000)).toBe(
      true,
    );
    expect(inResetGap({ resetAt: T0 + 5_000, olderCount: 1, rowsBefore: 0 }, T0 + 10_000)).toBe(
      false,
    );
    expect(inResetGap({ resetAt: T0 + 60_000, olderCount: 1, rowsBefore: 0 }, null)).toBe(false);
    expect(inResetGap({ resetAt: null, olderCount: 0, rowsBefore: 0 }, T0)).toBe(false);
  });

  it("under a live run, writes the rows a page with history lacks around what it shows, by time", () => {
    const live = {
      role: "assistant",
      _uid: "L1",
      _runId: "run-1",
      _bubbleStartedAt: T0 + 92_000,
      _watchedFrom: T0 + 90_000,
      content: [{ type: "text", text: "live L1" }],
    };
    const page: unknown[] = [srv("a1", 10, "user"), srv("a2", 11), live];
    stampOrder(page);
    // c1..c3 started the run before the tab was viewed; c4 is inside what it watched.
    const plan = planRowsByTime(page, [
      srv("a2", 11),
      srv("c1", 60, "user"),
      srv("c2", 61),
      srv("c3", 62),
      srv("c4", 91),
    ]);
    expect(plan.skippedKnown).toBe(1);
    expect(plan.skippedWatched).toBe(1);
    applyOlderPage(page, plan);
    const ids = renderOrder(page).map(
      (m) =>
        (m as { __openclaw?: { id?: string }; _uid?: string }).__openclaw?.id ??
        (m as { _uid?: string })._uid,
    );
    expect(ids).toEqual(["a1", "a2", "c1", "c2", "c3", "L1"]);
  });

  it("fills the gap newest first, until an archive adds nothing the page lacks", () => {
    expect(resetGapStep({ resetAt: 5, olderCount: 3, rowsBefore: 0 }, 4)).toBe("next");
    expect(resetGapStep({ resetAt: 5, olderCount: 3, rowsBefore: 200 }, 4)).toBe("more");
    expect(resetGapStep({ resetAt: 5, olderCount: 3, rowsBefore: 0 }, 0)).toBe("stop");
    expect(resetGapStep({ resetAt: 5, olderCount: 0, rowsBefore: 0 }, 4)).toBe("stop");
    expect(resetGapStep({ resetAt: null, olderCount: 0, rowsBefore: 0 }, 0)).toBe("stop");
  });

  it("draws no divider for an archive that served no rows", () => {
    const page: unknown[] = [srv("n1", 100, "user")];
    stampOrder(page);
    const plan = planResetArchivePage(page, [], T0 + 50_000);
    expect(plan.divider).toBeNull();
    applyResetArchivePage(page, plan);
    expect(order(page)).toEqual(["n1"]);
  });

  it("writes an archive above the page, with its divider between it and the newer rows", () => {
    const page: unknown[] = [srv("n1", 100, "user"), srv("n2", 101)];
    stampOrder(page);
    const plan = planResetArchivePage(page, [imp("a1", 10), imp("a2", 11)], T0 + 50_000);
    applyResetArchivePage(page, plan);
    expect(order(page)).toEqual(["a1", "a2", `divider@${T0 + 50_000}`, "n1", "n2"]);
  });

  it("an older archive goes above the one already written", () => {
    const page: unknown[] = [srv("n1", 100, "user")];
    stampOrder(page);
    applyResetArchivePage(page, planResetArchivePage(page, [imp("b1", 40)], T0 + 50_000));
    applyResetArchivePage(page, planResetArchivePage(page, [imp("a1", 10)], T0 + 20_000));
    expect(order(page)).toEqual([
      "a1",
      `divider@${T0 + 20_000}`,
      "b1",
      `divider@${T0 + 50_000}`,
      "n1",
    ]);
  });

  it("rows of the archive the page already shows (open across the reset) stay put; the divider follows them", () => {
    // The tab was open when the session was reset: a1 and a2 are on the page from before the reset.
    const page: unknown[] = [imp("a1", 10), imp("a2", 11), srv("n1", 100, "user")];
    stampOrder(page);
    const plan = planResetArchivePage(
      page,
      [imp("a0", 5), imp("a1", 10), imp("a2", 11)],
      T0 + 50_000,
    );
    expect(plan.skippedKnown).toBe(2);
    applyResetArchivePage(page, plan);
    expect(order(page)).toEqual(["a0", "a1", "a2", `divider@${T0 + 50_000}`, "n1"]);
  });

  it("never draws a reset's divider twice", () => {
    const page: unknown[] = [srv("n1", 100, "user")];
    stampOrder(page);
    applyResetArchivePage(page, planResetArchivePage(page, [imp("a1", 10)], T0 + 50_000));
    const again = planResetArchivePage(page, [imp("a1", 10)], T0 + 50_000);
    expect(again.divider).toBeNull();
    applyResetArchivePage(page, again);
    expect(order(page)).toEqual(["a1", `divider@${T0 + 50_000}`, "n1"]);
  });
});
