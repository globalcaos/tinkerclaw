import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FractalLedger, LEDGER_FILENAME, LEDGER_ROTATE_BYTES_CEILING } from "./ledger.js";
import type { FractalRow } from "./types.js";

const HOUR_MS = 3_600_000;

let seq = 0;
/**
 * Build a row without depending on the exact required-field list of the U1
 * types contract — the ledger guards every field it touches at runtime.
 */
function makeRow(overrides: Record<string, unknown> = {}): FractalRow {
  seq += 1;
  return {
    v: 1,
    parentRunId: `parent-${seq}`,
    triageRunId: `triage-${seq}`,
    status: "clean",
    verdict: "ok",
    findings: [],
    escalated: false,
    abstainedFindings: 0,
    ts: Date.now(),
    ...overrides,
  } as unknown as FractalRow;
}

describe("FractalLedger", () => {
  let dir: string;
  let ledger: FractalLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fractal-ledger-"));
    ledger = new FractalLedger(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips append → byParentRunId in a tmpdir", async () => {
    await ledger.append(makeRow({ parentRunId: "run-A", verdict: "all good" }));
    const back = await ledger.byParentRunId("run-A");
    expect(back).toMatchObject({ parentRunId: "run-A", verdict: "all good" });
    expect(await ledger.byParentRunId("nope")).toBeUndefined();
  });

  it("byParentRunId returns the LATEST row for a parent", async () => {
    await ledger.append(makeRow({ parentRunId: "run-A", status: "pending" }));
    await ledger.append(makeRow({ parentRunId: "run-A", status: "acted" }));
    const back = await ledger.byParentRunId("run-A");
    expect(back?.status).toBe("acted");
  });

  it("feed returns newest-first with limit and filter", async () => {
    await ledger.append(makeRow({ parentRunId: "p1" }));
    await ledger.append(makeRow({ parentRunId: "p2" }));
    await ledger.append(makeRow({ parentRunId: "p3", status: "flagged" }));
    const recent = await ledger.feed(2);
    expect(recent.map((r) => r.parentRunId)).toEqual(["p3", "p2"]);
    const flagged = await ledger.feed(10, (r) => String(r.status) === "flagged");
    expect(flagged.map((r) => r.parentRunId)).toEqual(["p3"]);
    expect(await ledger.feed(0)).toEqual([]);
  });

  it("append never throws upward when the ledger dir path is a file", async () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "i am a file, not a directory\n");
    const bad = new FractalLedger(blocked);
    await expect(bad.append(makeRow())).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[fractal-ledger]"),
      expect.anything(),
    );
  });

  it("skips a torn/corrupt trailing line instead of poisoning readers", async () => {
    await ledger.append(makeRow({ parentRunId: "good" }));
    writeFileSync(join(dir, LEDGER_FILENAME), '{"parentRunId":"torn"', { flag: "a" });
    const rows = await ledger.feed(10);
    expect(rows.map((r) => r.parentRunId)).toEqual(["good"]);
  });

  it("computes stats over a synthetic mix (escalated, abstained, skipped)", async () => {
    const now = Date.now();
    await ledger.append(
      makeRow({
        status: "acted",
        escalated: true,
        timeToDockMs: 100,
        usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 10 },
      }),
    );
    await ledger.append(
      makeRow({
        status: "flagged",
        escalated: true,
        timeToDockMs: 300,
        usage: { input: 0, output: 2, cacheRead: 90, cacheWrite: 10 },
      }),
    );
    await ledger.append(makeRow({ status: "clean", abstainedFindings: 1, timeToDockMs: 200 }));
    await ledger.append(makeRow({ status: "skipped", skipReason: "quota" }));
    await ledger.append(makeRow({ status: "skipped", skipReason: "superseded" }));
    // outside the 24h window — must be excluded everywhere
    await ledger.append(makeRow({ status: "acted", ts: now - 48 * HOUR_MS }));

    const stats = await ledger.stats(24);
    expect(stats.fires).toBe(3);
    expect(stats.byStatus).toEqual({
      acted: 1,
      flagged: 1,
      clean: 1,
      "skipped:quota": 1,
      "skipped:superseded": 1,
    });
    expect(stats.escalationRate).toBeCloseTo(2 / 3);
    expect(stats.fixYield).toBeCloseTo(1 / 2); // 1 acted of 2 escalated
    expect(stats.abstainRate).toBeCloseTo(1 / 3);
    // warm-ratio: cacheRead/(input+cacheRead+cacheWrite); output excluded
    expect(stats.warmRatio).toBeCloseTo(170 / 200);
    expect(stats.p50TimeToDockMs).toBe(200);
    expect(stats.p95TimeToDockMs).toBe(300);
    expect(stats.rowsPerTurn).toBe(1); // 5 rows, 5 distinct parents
  });

  it("returns zeroed stats on an empty ledger", async () => {
    expect(await ledger.stats(24)).toEqual({
      fires: 0,
      byStatus: {},
      escalationRate: 0,
      fixYield: 0,
      abstainRate: 0,
      warmRatio: 0,
      p50TimeToDockMs: 0,
      p95TimeToDockMs: 0,
      rowsPerTurn: 0,
    });
  });

  it("counts recurrences of a kind+path finding across non-skipped rows", async () => {
    const finding = {
      kind: "stale-doc",
      evidence: { claim: "c", path: "docs/a.md", verbatimQuote: "q" },
    };
    await ledger.append(makeRow({ findings: [finding] }));
    await ledger.append(makeRow({ findings: [finding], status: "flagged" }));
    // skipped rows never count
    await ledger.append(makeRow({ findings: [finding], status: "skipped", skipReason: "quota" }));
    // same kind, different path
    await ledger.append(
      makeRow({
        findings: [
          { kind: "stale-doc", evidence: { claim: "c", path: "docs/b.md", verbatimQuote: "q" } },
        ],
      }),
    );
    // same path, different kind
    await ledger.append(
      makeRow({
        findings: [
          { kind: "bug", evidence: { claim: "c", path: "docs/a.md", verbatimQuote: "q" } },
        ],
      }),
    );
    expect(await ledger.recurrenceCount("stale-doc", "docs/a.md")).toBe(2);
    expect(await ledger.recurrenceCount("stale-doc", "docs/zzz.md")).toBe(0);
  });

  it("rotates the live file past the ceiling; readers scan the live file only", async () => {
    const small = new FractalLedger(dir, { rotateBytesCeiling: 64 });
    await small.append(makeRow({ parentRunId: "old-parent" })); // live > 64 bytes now
    await small.append(makeRow({ parentRunId: "new-parent" })); // rotation fires first
    const files = readdirSync(dir);
    expect(files).toContain(LEDGER_FILENAME);
    const archives = files.filter((f) => f !== LEDGER_FILENAME && /^results-.+\.jsonl$/u.test(f));
    expect(archives).toHaveLength(1);
    // rotated rows are archives — invisible to live readers
    expect(await small.byParentRunId("old-parent")).toBeUndefined();
    expect((await small.byParentRunId("new-parent"))?.parentRunId).toBe("new-parent");
  });

  it("documents the production rotation ceiling at 5 MB", () => {
    expect(LEDGER_ROTATE_BYTES_CEILING).toBe(5 * 1024 * 1024);
  });

  it("missedTurns = independent main-turn count minus rows in window", async () => {
    const now = Date.now();
    await ledger.append(makeRow());
    await ledger.append(makeRow({ status: "skipped", skipReason: "quota" }));
    await ledger.append(makeRow({ ts: now - 48 * HOUR_MS })); // outside window
    expect(await ledger.missedTurns(10, 24)).toBe(8); // 10 turns − 2 rows
    expect(await ledger.missedTurns(2, 24)).toBe(0);
    // double-fire surfaces as a NEGATIVE count — a signal, so not clamped
    expect(await ledger.missedTurns(1, 24)).toBe(-1);
  });
});
