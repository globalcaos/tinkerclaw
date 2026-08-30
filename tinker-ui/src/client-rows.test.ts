/**
 * FORK 2026-08-23 — the store that makes the chat immutable for rows the SERVER never had.
 *
 * The rule being defended: "once something is written it should not be erased." Everything here
 * is a way that rule can break, and every one of these has a real precedent in this codebase —
 * the outbox lost prompts to a full localStorage, to a corrupt read, and to a de-dup that
 * confirmed the wrong entry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_ROWS_PER_SESSION,
  MAX_SESSIONS,
  clearClientRowsForTest,
  missingClientRows,
  readClientRows,
  recordClientRow,
} from "./client-rows.js";

const KEY = "agent:main:tinker:abc";
const row = (label: string) => ({ role: "assistant", _isPhaseTiming: true, _phaseLabel: label });

beforeEach(() => {
  clearClientRowsForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearClientRowsForTest();
});

describe("client rows persist", () => {
  it("stores a row and reads it back", () => {
    const id = recordClientRow(KEY, row("recalling memories"), 3, 1000);
    expect(id).toBeTruthy();
    const rows = readClientRows(KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0].row._phaseLabel).toBe("recalling memories");
    expect(rows[0].turn).toBe(3);
  });

  it("keeps sessions apart", () => {
    recordClientRow(KEY, row("a"), 1, 1000);
    recordClientRow("other:session", row("b"), 1, 1001);
    expect(readClientRows(KEY)).toHaveLength(1);
    expect(readClientRows("other:session")).toHaveLength(1);
  });

  it("preserves insertion order — a transcript is not a set", () => {
    for (const l of ["first", "second", "third"]) {
      recordClientRow(KEY, row(l), 1, 1000);
    }
    expect(readClientRows(KEY).map((r) => r.row._phaseLabel)).toEqual(["first", "second", "third"]);
  });

  it("refuses a blank session key rather than storing under an empty bucket", () => {
    expect(recordClientRow("", row("x"), 1)).toBeNull();
    expect(recordClientRow("   ", row("x"), 1)).toBeNull();
  });
});

describe("re-injection is idempotent", () => {
  it("returns nothing when every stored row is already on screen", () => {
    const id = recordClientRow(KEY, row("a"), 1, 1000);
    const onScreen = [{ ...row("a"), _clientRowId: id }];
    expect(missingClientRows(KEY, onScreen)).toHaveLength(0);
  });

  it("returns exactly the rows that are missing", () => {
    const a = recordClientRow(KEY, row("a"), 1, 1000);
    recordClientRow(KEY, row("b"), 1, 1001);
    const onScreen = [{ ...row("a"), _clientRowId: a }];
    const missing = missingClientRows(KEY, onScreen);
    expect(missing).toHaveLength(1);
    expect(missing[0].row._phaseLabel).toBe("b");
  });

  it("returns everything when the screen is empty — the reload case", () => {
    recordClientRow(KEY, row("a"), 1, 1000);
    recordClientRow(KEY, row("b"), 1, 1001);
    expect(missingClientRows(KEY, [])).toHaveLength(2);
  });

  it("survives junk in the on-screen list", () => {
    recordClientRow(KEY, row("a"), 1, 1000);
    expect(missingClientRows(KEY, [null, undefined, "str", 5, {}])).toHaveLength(1);
  });

  it("gives each row a distinct id, so two identical rows are two rows", () => {
    // Two "preparing context — 12.0s" rows in one session are a real thing: two turns.
    // De-duplicating by CONTENT would silently merge them, which is the outbox's old bug.
    const a = recordClientRow(KEY, row("same"), 1, 1000);
    const b = recordClientRow(KEY, row("same"), 2, 1000);
    expect(a).not.toBe(b);
    expect(missingClientRows(KEY, [])).toHaveLength(2);
  });
});

describe("bounded, but never silently emptied", () => {
  it("caps a session at MAX_ROWS_PER_SESSION, dropping the OLDEST", () => {
    for (let i = 0; i < MAX_ROWS_PER_SESSION + 25; i++) {
      recordClientRow(KEY, row(`row-${i}`), 1, 1000 + i);
    }
    const rows = readClientRows(KEY);
    expect(rows).toHaveLength(MAX_ROWS_PER_SESSION);
    // The newest must survive; the oldest are the ones nobody is looking at.
    expect(rows[rows.length - 1].row._phaseLabel).toBe(`row-${MAX_ROWS_PER_SESSION + 24}`);
    expect(rows[0].row._phaseLabel).toBe("row-25");
  });

  it("caps the number of sessions, evicting least-recently-touched", () => {
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      recordClientRow(`session-${i}`, row("x"), 1, 1000 + i);
    }
    // The three oldest are gone; the newest is not.
    expect(readClientRows("session-0")).toHaveLength(0);
    expect(readClientRows(`session-${MAX_SESSIONS + 2}`)).toHaveLength(1);
  });
});

describe("a hostile localStorage", () => {
  it("sheds the oldest half and retries once when the quota is exceeded", () => {
    recordClientRow(KEY, row("old"), 1, 1000);
    recordClientRow(KEY, row("new"), 1, 1001);
    const real = localStorage.setItem.bind(localStorage);
    let firstCall = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((k: string, v: string) => {
      if (firstCall) {
        firstCall = false;
        throw new DOMException("QuotaExceededError");
      }
      real(k, v);
    });
    // The write must still land. A full localStorage turning this into a silent no-op is
    // exactly what happened to the outbox.
    expect(recordClientRow(KEY, row("newest"), 1, 1002)).toBeTruthy();
    expect(readClientRows(KEY).some((r) => r.row._phaseLabel === "newest")).toBe(true);
  });

  it("reports failure rather than claiming success when it cannot write at all", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(recordClientRow(KEY, row("x"), 1, 1000)).toBeNull();
  });

  it("treats a corrupt store as empty instead of throwing", () => {
    localStorage.setItem("tinker-client-rows", "{not json");
    expect(readClientRows(KEY)).toEqual([]);
    // and the next write repairs it rather than leaving it broken forever
    expect(recordClientRow(KEY, row("a"), 1, 1000)).toBeTruthy();
    expect(readClientRows(KEY)).toHaveLength(1);
  });

  it("treats a store of the wrong SHAPE as empty", () => {
    for (const junk of ['["array"]', '"string"', "42", "null"]) {
      localStorage.setItem("tinker-client-rows", junk);
      expect(readClientRows(KEY)).toEqual([]);
    }
  });
});
