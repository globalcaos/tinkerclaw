/**
 * FORK 2026-09-08 — the store keeps the WHOLE anchor (ordinal + time + prompt), not just the
 * ordinal. See msg-order.anchor.test.ts for the bug this serves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearClientRowsForTest, missingClientRows, readClientRows, recordClientRow } from "./client-rows.js";

const KEY = "agent:main:tinker:abc";
const row = (label: string) => ({ role: "assistant", _isPhaseTiming: true, _phaseLabel: label });

beforeEach(() => {
  clearClientRowsForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearClientRowsForTest();
});

describe("a described anchor round-trips through the store", () => {
  it("stores turn, at and prompt and hands them back on restore", () => {
    const id = recordClientRow(KEY, row("a"), { turn: 3, at: 5000, prompt: "Ok, ship the 11" }, 6000);
    expect(id).toBeTruthy();
    const [stored] = readClientRows(KEY);
    expect(stored.turn).toBe(3);
    expect(stored.at).toBe(5000);
    expect(stored.prompt).toBe("Ok, ship the 11");
    expect(stored.ts).toBe(6000);
    const [missing] = missingClientRows(KEY, []);
    expect(missing.at).toBe(5000);
    expect(missing.prompt).toBe("Ok, ship the 11");
    // And ON the row, so a caller that maps back only `{ m: row, turn }` still has the anchor.
    expect(missing.row._anchorAt).toBe(5000);
    expect(missing.row._anchorPrompt).toBe("Ok, ship the 11");
  });

  it("gives a legacy row (ordinal only) its capture time as the anchor time on restore", () => {
    recordClientRow(KEY, row("old"), 7, 4242);
    const [missing] = missingClientRows(KEY, []);
    expect(missing.at).toBeUndefined();
    expect(missing.row._anchorAt).toBe(4242);
    expect(missing.row._anchorPrompt).toBeUndefined();
  });

  it("still accepts a bare number (legacy call shape) and leaves at/prompt unset", () => {
    recordClientRow(KEY, row("a"), 2, 1000);
    const [stored] = readClientRows(KEY);
    expect(stored.turn).toBe(2);
    expect(stored.at).toBeUndefined();
    expect(stored.prompt).toBeUndefined();
  });

  it("does not persist a blank prompt or a non-finite time", () => {
    recordClientRow(KEY, row("a"), { turn: 1, at: Number.NaN, prompt: "   " }, 1000);
    const [stored] = readClientRows(KEY);
    expect(stored.turn).toBe(1);
    expect(stored.at).toBeUndefined();
    expect(stored.prompt).toBeUndefined();
  });
});
