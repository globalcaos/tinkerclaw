import { describe, expect, it } from "vitest";
import {
  applyCursor,
  buildOlderRequest,
  buildTailRequest,
  cursorOf,
  emptyWindow,
  BG_STUB_ROWS,
  BG_UNLOAD_MS,
  WINDOW_MAX_ROWS,
  WINDOW_PAGE,
  type HistoryCursor,
} from "./history-window";

const cur = (o: Partial<HistoryCursor> = {}): HistoryCursor => ({
  epoch: "e1",
  firstSeq: 1,
  lastSeq: 100,
  hasMoreBefore: false,
  reset: false,
  ...o,
});

describe("history-window constants", () => {
  it("locks the paging/backgrounding constants", () => {
    expect(WINDOW_PAGE).toBe(100);
    expect(WINDOW_MAX_ROWS).toBe(400);
    expect(BG_STUB_ROWS).toBe(30);
    expect(BG_UNLOAD_MS).toBe(10 * 60_000);
  });
});

describe("buildTailRequest / buildOlderRequest", () => {
  it("empty window asks for one page", () => {
    expect(buildTailRequest("k", emptyWindow())).toEqual({ sessionKey: "k", limit: WINDOW_PAGE });
  });

  it("populated window asks only for rows after lastSeq", () => {
    const { window } = applyCursor(emptyWindow(), cur(), "s1", "tail");
    expect(buildTailRequest("k", window)).toEqual({ sessionKey: "k", afterSeq: 100, epoch: "e1" });
  });

  it("older moves firstSeq back; null when nothing older", () => {
    const { window } = applyCursor(
      emptyWindow(),
      cur({ firstSeq: 201, lastSeq: 300, hasMoreBefore: true }),
      "s1",
      "tail",
    );
    expect(buildOlderRequest("k", window)).toEqual({
      sessionKey: "k",
      beforeSeq: 201,
      limit: WINDOW_PAGE,
      epoch: "e1",
    });
    const older = applyCursor(
      window,
      cur({ firstSeq: 101, lastSeq: 200, hasMoreBefore: false }),
      "s1",
      "older",
    ).window;
    expect(older.firstSeq).toBe(101);
    expect(buildOlderRequest("k", older)).toBeNull();
  });

  it("a tail whose local rows are all newer than a cut import (firstSeq === lastSeq + 1) still pages from firstSeq, never negative or zero", () => {
    const { window } = applyCursor(
      emptyWindow(),
      cur({ firstSeq: 101, lastSeq: 100, hasMoreBefore: true }),
      "s1",
      "tail",
    );
    expect(buildOlderRequest("k", window)).toEqual({
      sessionKey: "k",
      beforeSeq: 101,
      limit: WINDOW_PAGE,
      epoch: "e1",
    });
  });
});

describe("applyCursor", () => {
  it("reset or new sessionId forces a page reset", () => {
    const { window } = applyCursor(emptyWindow(), cur(), "s1", "tail");
    expect(applyCursor(window, cur({ reset: true }), "s1", "tail").resetPage).toBe(true);
    expect(applyCursor(window, cur(), "s2", "tail").resetPage).toBe(true);
  });

  it("a reset reply re-initializes the window wholesale from the reply, never merged with the old one", () => {
    const { window } = applyCursor(
      emptyWindow(),
      cur({ firstSeq: 1, lastSeq: 100, hasMoreBefore: true }),
      "s1",
      "tail",
    );
    const { window: reset, resetPage } = applyCursor(
      window,
      cur({ epoch: "e2", firstSeq: 500, lastSeq: 600, hasMoreBefore: false, reset: true }),
      "s1",
      "tail",
    );
    expect(resetPage).toBe(true);
    expect(reset).toEqual({
      epoch: "e2",
      firstSeq: 500,
      lastSeq: 600,
      hasMoreBefore: false,
      sessionId: "s1",
    });
  });

  it("tail never moves lastSeq backwards", () => {
    const { window } = applyCursor(emptyWindow(), cur({ lastSeq: 120 }), "s1", "tail");
    expect(
      applyCursor(window, cur({ firstSeq: 100, lastSeq: 100 }), "s1", "tail").window.lastSeq,
    ).toBe(120);
  });

  it("an afterSeq tail reply's hasMoreBefore (true whenever afterSeq >= 1) must not overwrite the window's real firstSeq/hasMoreBefore", () => {
    const { window } = applyCursor(
      emptyWindow(),
      cur({ firstSeq: 50, lastSeq: 100, hasMoreBefore: true }),
      "s1",
      "tail",
    );
    const next = applyCursor(
      window,
      cur({ firstSeq: 90, lastSeq: 150, hasMoreBefore: false }),
      "s1",
      "tail",
    ).window;
    expect(next).toEqual({
      epoch: "e1",
      firstSeq: 50,
      lastSeq: 150,
      hasMoreBefore: true,
      sessionId: "s1",
    });
  });

  it("epoch-less (legacy/flat transcript) cursors keep the window cursor-less", () => {
    const { window } = applyCursor(
      emptyWindow(),
      cur({ epoch: null, firstSeq: 1, lastSeq: 50, hasMoreBefore: true }),
      "s1",
      "tail",
    );
    expect(window.epoch).toBeNull();
    expect(buildTailRequest("k", window)).toEqual({ sessionKey: "k", limit: WINDOW_PAGE });
    expect(buildOlderRequest("k", window)).toBeNull();
  });
});

describe("cursorOf", () => {
  it("extracts a valid cursor from a chat.history reply", () => {
    const reply = {
      rows: [],
      cursor: { epoch: "e1", firstSeq: 1, lastSeq: 100, hasMoreBefore: false, reset: false },
    };
    expect(cursorOf(reply)).toEqual({
      epoch: "e1",
      firstSeq: 1,
      lastSeq: 100,
      hasMoreBefore: false,
      reset: false,
    });
  });

  it("accepts a null epoch (a real cursor on a legacy/flat transcript)", () => {
    const reply = {
      cursor: { epoch: null, firstSeq: 1, lastSeq: 50, hasMoreBefore: false, reset: false },
    };
    expect(cursorOf(reply)?.epoch).toBeNull();
  });

  it("returns null for the old gateway's reply shape (no cursor field at all)", () => {
    expect(cursorOf({ rows: [] })).toBeNull();
  });

  it("returns null for a malformed cursor", () => {
    expect(
      cursorOf({
        cursor: { epoch: 1, firstSeq: "x", lastSeq: 100, hasMoreBefore: false, reset: false },
      }),
    ).toBeNull();
    expect(cursorOf({ cursor: null })).toBeNull();
  });

  it("returns null for a non-object reply", () => {
    expect(cursorOf(null)).toBeNull();
    expect(cursorOf(undefined)).toBeNull();
    expect(cursorOf("nope")).toBeNull();
  });

  it("rejects NaN, negative, fractional, and Infinite firstSeq/lastSeq", () => {
    const base = { epoch: "e1", firstSeq: 1, lastSeq: 100, hasMoreBefore: false, reset: false };
    expect(cursorOf({ cursor: { ...base, firstSeq: NaN } })).toBeNull();
    expect(cursorOf({ cursor: { ...base, lastSeq: NaN } })).toBeNull();
    expect(cursorOf({ cursor: { ...base, firstSeq: -5 } })).toBeNull();
    expect(cursorOf({ cursor: { ...base, lastSeq: -1 } })).toBeNull();
    expect(cursorOf({ cursor: { ...base, firstSeq: 1.5 } })).toBeNull();
    expect(cursorOf({ cursor: { ...base, lastSeq: 100.25 } })).toBeNull();
    expect(cursorOf({ cursor: { ...base, firstSeq: Infinity } })).toBeNull();
    expect(cursorOf({ cursor: { ...base, lastSeq: -Infinity } })).toBeNull();
  });

  it("rejects a cursor missing a boolean field", () => {
    expect(
      cursorOf({ cursor: { epoch: "e1", firstSeq: 1, lastSeq: 100, reset: false } }),
    ).toBeNull();
    expect(
      cursorOf({ cursor: { epoch: "e1", firstSeq: 1, lastSeq: 100, hasMoreBefore: false } }),
    ).toBeNull();
  });
});

// FORK 2026-09-24 — ruling R36: the cursor may say how many user rows precede its window.
describe("cursor.userRowsBefore (R36)", () => {
  const base = { epoch: "e1", firstSeq: 51, lastSeq: 100, hasMoreBefore: true, reset: false };

  it("cursorOf carries a valid count and drops an invalid one without rejecting the cursor", () => {
    expect(cursorOf({ cursor: { ...base, userRowsBefore: 20 } })?.userRowsBefore).toBe(20);
    for (const bad of [-1, 1.5, "3", null, Number.NaN]) {
      const c = cursorOf({ cursor: { ...base, userRowsBefore: bad } });
      expect(c, String(bad)).not.toBeNull();
      expect(c?.userRowsBefore, String(bad)).toBeUndefined();
    }
  });

  it("a fresh window takes it; a plain tail delta keeps the window's; an older page adopts the reply's", () => {
    const init = applyCursor(emptyWindow(), cur({ ...base, userRowsBefore: 20 }), "s1", "tail");
    expect(init.window.userRowsBefore).toBe(20);
    const delta = applyCursor(init.window, cur({ firstSeq: 101, lastSeq: 110 }), "s1", "tail");
    expect(delta.window.userRowsBefore).toBe(20);
    const older = applyCursor(
      init.window,
      cur({ firstSeq: 11, lastSeq: 50, hasMoreBefore: true, userRowsBefore: 4 }),
      "s1",
      "older",
    );
    expect(older.window).toMatchObject({ firstSeq: 11, userRowsBefore: 4 });
    // Absent (a gateway that does not count): the window has none, i.e. counts from its page.
    expect(
      applyCursor(emptyWindow(), cur(base), "s1", "tail").window.userRowsBefore,
    ).toBeUndefined();
  });
});
