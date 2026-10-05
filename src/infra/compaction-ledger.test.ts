// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A4: the compaction LEDGER
// on the events database (logging.md §4.7).
//
// CONTROL: before A4 src/infra/compaction-ledger.ts did not exist and no code wrote a
// compaction.run row, so this file fails to import and every test is red.
//
// The writer here is the REAL one (a worker thread on a temp database), because the two claims
// that matter are about the database: one end is one row in the declared shape, and a restart
// seeds from those rows without counting this process's own twice.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPACTION_LEDGER_SEED_RETRY_MS,
  compactionLedgerDrop,
  readCompactionLedger,
  resetCompactionLedgerForTest,
  settleCompactionLedgerSeedsForTest,
} from "./compaction-ledger.js";
import { type CompactionEndEvent, emitCompactionTelemetry } from "./compaction-telemetry.js";
import {
  flushEventWriter,
  getEventWriterStats,
  resetEventWriterForTest,
  startEventWriter,
} from "./events/emit.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const KEY = "agent:main:tinker:ledger-a4";
const OTHER_KEY = "agent:main:tinker:ledger-a4-other";

let tmpDir: string;
const dbs: DatabaseSync[] = [];

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "compaction-ledger-"));
  await resetEventWriterForTest();
  resetCompactionLedgerForTest();
});

afterEach(async () => {
  await resetEventWriterForTest();
  resetCompactionLedgerForTest();
  for (const db of dbs.splice(0)) {
    db.close();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A gateway start: the process-wide writer on this test's database, timers off (tests flush). */
function startWriter(): void {
  startEventWriter({
    env: { OPENCLAW_EVENTS_DB_PATH: join(tmpDir, "events.sqlite") },
    statsIntervalMs: 0,
    maintenanceIntervalMs: 0,
    flushIntervalMs: 3_600_000,
  });
}

/** A gateway restart: the writer AND the in-memory ledger go; the database stays. */
async function restart(): Promise<void> {
  await flushEventWriter();
  await resetEventWriterForTest();
  resetCompactionLedgerForTest();
  startWriter();
}

type EndFields = Omit<CompactionEndEvent, "phase" | "lane" | "provenance" | "completed"> &
  Partial<Pick<CompactionEndEvent, "lane" | "provenance" | "completed">>;

/** One A1 end through the owner. `sessionKey: null` sends none (a producer that knew no session). */
function end(fields: EndFields, opts: { runId?: string; sessionKey?: string | null } = {}): void {
  const sessionKey = opts.sessionKey === undefined ? KEY : opts.sessionKey;
  emitCompactionTelemetry(
    { runId: opts.runId ?? "run-a4", ...(sessionKey === null ? {} : { sessionKey }) },
    { phase: "end", lane: "embedded", provenance: "estimated", completed: true, ...fields },
  );
}

/** The first read of an unseeded session queues its seed; the second answers once it settled. */
async function seeded(key = KEY) {
  expect(readCompactionLedger(key)).toBeUndefined();
  await settleCompactionLedgerSeedsForTest();
  return readCompactionLedger(key);
}

/** The database, opened AFTER the writer stopped. */
function openDb(): DatabaseSync {
  const { DatabaseSync: Database } = requireNodeSqlite();
  const db = new Database(join(tmpDir, "events.sqlite"));
  dbs.push(db);
  return db;
}

describe("compactionLedgerDrop (derived once, for the row and the memory alike)", () => {
  it("prefers the executor's measured drop, else before minus after, else unknown", () => {
    expect(compactionLedgerDrop({ tokensDropped: 50, tokensBefore: 1_000, tokensAfter: 200 })).toBe(
      50,
    );
    expect(compactionLedgerDrop({ tokensDropped: 0 })).toBe(0);
    expect(compactionLedgerDrop({ tokensBefore: 1_000, tokensAfter: 200 })).toBe(800);
    expect(compactionLedgerDrop({ tokensBefore: 1_000 })).toBeUndefined();
    expect(compactionLedgerDrop({ tokensAfter: 200 })).toBeUndefined();
    // A context that GREW is not a negative drop: unknown, never a fabricated figure.
    expect(compactionLedgerDrop({ tokensBefore: 100, tokensAfter: 300 })).toBeUndefined();
  });
});

describe("the compaction ledger (context-window-panel.md §6.1 A4)", () => {
  it("one A1 end is exactly one compaction.run row, in the shape the catalog declares", async () => {
    startWriter();
    emitCompactionTelemetry(
      { runId: "run-a4-shape", sessionKey: KEY },
      {
        phase: "start",
        trigger: "manual",
        lane: "embedded",
        provenance: "estimated",
        tokensBefore: 1_000,
      },
    );
    end(
      { trigger: "manual", tokensBefore: 1_000, tokensAfter: 200, durationMs: 1_500 },
      { runId: "run-a4-shape" },
    );
    await flushEventWriter();
    const stats = getEventWriterStats();
    expect(stats.written).toBe(1); // the start wrote nothing
    expect(stats.undeclaredKeys).toBe(0);
    expect(stats.invalidValues).toBe(0);
    await resetEventWriterForTest();

    const rows = openDb().prepare("SELECT * FROM v_compaction_run").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: "run-a4-shape",
      session_kind: "tinker",
      outcome: "completed",
      dur_ms: 1_500,
      tokens_before: 1_000,
      tokens_after: 200,
      tokens_dropped: 800,
      trigger: "manual",
      lane: "embedded",
      provenance: "estimated",
    });
    expect(rows[0]?.session_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rows[0])).not.toContain(KEY);
  }, 30_000);

  it("an end with no session key is still a row, and counts for no session", async () => {
    startWriter();
    end({ trigger: "pi-auto", tokensBefore: 7_000 }, { runId: "run-a4-nokey", sessionKey: null });
    expect(await seeded()).toEqual({ compactions: 0, evictions: 0, droppedTokens: 0 });
    await flushEventWriter();
    await resetEventWriterForTest();
    const row = openDb()
      .prepare("SELECT session_hash, outcome, tokens_dropped FROM v_compaction_run")
      .get() as Record<string, unknown>;
    expect(row).toEqual({ session_hash: null, outcome: "completed", tokens_dropped: null });
  }, 30_000);

  it("a manual compaction the tab hears twice (RPC reply + stream) is ONE row and ONE count", async () => {
    startWriter();
    // The stream: the leaf's pair for sessions.compact, on a run id minted for it.
    const runId = "compaction:manual-a4";
    emitCompactionTelemetry(
      { runId, sessionKey: KEY },
      { phase: "start", trigger: "manual", lane: "embedded", provenance: "estimated" },
    );
    end({ trigger: "manual", tokensBefore: 9_000, tokensAfter: 1_000 }, { runId });
    // The reply carries the same compaction to the clicking tab and is not a ledger input (the
    // structural guard below pins that no RPC and no executor feeds the ledger itself). The row is
    // in the database BEFORE the seed asks, and is still counted once.
    await flushEventWriter();
    expect(await seeded()).toEqual({
      compactions: 1,
      evictions: 0,
      droppedTokens: 8_000,
      lastCompactionAt: expect.any(Number),
    });
    await resetEventWriterForTest();
    const count = openDb()
      .prepare("SELECT count(*) AS n FROM events WHERE name = 'compaction.run'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  }, 30_000);

  it("after a restart it seeds from the database and never counts this process's rows twice", async () => {
    startWriter();
    end({ trigger: "manual", tokensBefore: 1_000, tokensAfter: 200 }); // drop 800
    end({ trigger: "evict", tokensBefore: 600, tokensAfter: 550, tokensDropped: 50 }); // eviction
    end({ trigger: "overflow", completed: false, tokensBefore: 5_000 }); // a row, not a count
    end({ trigger: "pi-auto", tokensBefore: 7_000 }); // counted, drop unknown
    end({ trigger: "manual", tokensBefore: 10, tokensAfter: 5 }, { sessionKey: OTHER_KEY });
    await restart();

    // This process compacts once BEFORE anyone reads, and its row reaches the database first.
    const bootTwoAt = Date.now();
    end({
      trigger: "cli-internal",
      lane: "cc-bridge",
      provenance: "exact",
      tokensBefore: 900_000,
      tokensAfter: 15_000,
    });
    await flushEventWriter();

    const view = await seeded();
    expect(view).toEqual({
      compactions: 3,
      evictions: 1,
      droppedTokens: 800 + 50 + 885_000,
      lastCompactionAt: expect.any(Number),
    });
    expect(view?.lastCompactionAt).toBeGreaterThanOrEqual(bootTwoAt);

    // Seeded once, the live half keeps adding.
    end({ trigger: "evict", tokensDropped: 7 });
    expect(readCompactionLedger(KEY)).toMatchObject({ evictions: 2, droppedTokens: 885_857 });

    // Another session's history stays its own.
    expect(await seeded(OTHER_KEY)).toEqual({
      compactions: 1,
      evictions: 0,
      droppedTokens: 5,
      lastCompactionAt: expect.any(Number),
    });
  }, 30_000);

  it("P10: absent until a read succeeds, and a seed with no answer is retried, not left shut", async () => {
    // No writer yet: the seed has nobody to ask.
    end({ trigger: "manual", tokensBefore: 100, tokensAfter: 10 });
    expect(readCompactionLedger(KEY)).toBeUndefined();
    await settleCompactionLedgerSeedsForTest();
    // Counted in memory, still absent: the history before this process is unknown.
    expect(readCompactionLedger(KEY)).toBeUndefined();

    startWriter();
    // Inside the retry window nothing is asked again.
    expect(readCompactionLedger(KEY)).toBeUndefined();
    await settleCompactionLedgerSeedsForTest();
    expect(readCompactionLedger(KEY)).toBeUndefined();
    // Past it, the read queues the retry, and the worker answers.
    expect(readCompactionLedger(KEY, Date.now() + COMPACTION_LEDGER_SEED_RETRY_MS)).toBeUndefined();
    await settleCompactionLedgerSeedsForTest();
    expect(readCompactionLedger(KEY)).toEqual({
      compactions: 1,
      evictions: 0,
      droppedTokens: 90,
      lastCompactionAt: expect.any(Number),
    });
  }, 30_000);

  it("P10: a 0 only after a successful read, and a drop nobody measured stays absent", async () => {
    startWriter();
    expect(await seeded()).toEqual({ compactions: 0, evictions: 0, droppedTokens: 0 });
    end({ trigger: "pi-auto", tokensBefore: 7_000 }); // pi reports no tokensAfter
    const view = readCompactionLedger(KEY);
    expect(view).toMatchObject({ compactions: 1, evictions: 0 });
    expect(view).not.toHaveProperty("droppedTokens");
  }, 30_000);
});

describe("the ledger's one writer (structural)", () => {
  const source = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  it("only the A1 owner feeds it: no executor and no RPC reply writes a ledger row or count", () => {
    const owner = source("./compaction-telemetry.ts");
    expect(owner).toContain("noteCompactionLedgerEnd(");
    expect(owner).toContain("emitEvent(COMPACTION_LEDGER_EVENT");
    for (const relative of [
      "../gateway/server-methods/sessions.ts",
      "../gateway/session-eviction.ts",
      "../agents/embedded-agent-runner/compact.ts",
      "../agents/embedded-agent-runner/compact.queued.ts",
      "../agents/embedded-agent-subscribe.handlers.compaction.ts",
      "../../extensions/tinkerclaw-tinker-bridge/src/stream.ts",
    ]) {
      const text = source(relative);
      expect(text, relative).not.toContain("noteCompactionLedgerEnd");
      expect(text, relative).not.toMatch(/["']compaction\.run["']/);
    }
  });

  it("the ledger never names the compaction stream (gate 7 of context-window-panel.md)", () => {
    expect(source("./compaction-ledger.ts")).not.toMatch(/stream\s*:\s*["']compaction["']/);
  });
});
