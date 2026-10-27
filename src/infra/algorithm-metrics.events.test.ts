/**
 * logging.md §4.11 `algo.outcome` (§9 step 9): the dual write in recordAlgorithmOutcome, and the
 * backfill that imports the JSONL's history (scripts/events-backfill.ts).
 *
 * CONTROL: before this change recordAlgorithmOutcome appended its JSONL line and wrote NO events
 * row, so every row asserted below is new behaviour; the JSONL assertions pin that the other half
 * did not change. The writer is the real one (emit.ts: catalog lookup, key and value checks,
 * session hashing). Its worker runs in-process on the real writer core (writer-worker.ts) against
 * a temp database, so every assertion reads the file, not a recording of what was sent to it.
 *
 * The backfill's tests live here rather than beside the script: no vitest project includes test
 * files under the repo-root scripts/ directory, so a test there would never run.
 *
 * Fixtures carry the ledger's field names only; every value is invented.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertBackfillTargetAllowed,
  BACKFILL_BOOT_ID,
  buildParityReport,
  runEventsBackfill,
} from "../../scripts/events-backfill.js";
import {
  ALGO_OUTCOME_EVENT,
  ALGORITHM_METRICS_SCHEMA_VERSION,
  recordAlgorithmOutcome,
} from "./algorithm-metrics.js";
import { EVENT_CATALOG } from "./events/catalog.js";
import {
  flushEventWriter,
  getEventWriterStats,
  resetEventWriterForTest,
  startEventWriter,
  type WriterWorkerRequest,
} from "./events/emit.js";
import { type EventsDatabase, openEventsDatabase } from "./events/schema.js";
import { createWriterCore, handleWriterRequest } from "./events/writer-worker.js";

type StoredEvent = {
  id: number;
  ts_ms: number;
  name: string;
  kind: string;
  boot_id: string;
  session_hash: string | null;
  session_kind: string | null;
  label: string | null;
  dur_ms: number | null;
  n1: number | null;
  n2: number | null;
  n3: number | null;
  n4: number | null;
  fields: string | null;
};

const NOTE = "fixture-note free text that must never reach the events store";
/** Phone-number-shaped on purpose: it must reach no column (L4). */
const SESSION = "agent:main:whatsapp:+15555550142";
const WAL = { walMaintenance: { checkpointIntervalMs: 0 } };

let dir = "";
let dbPath = "";
let ledgerPath = "";
let handle: EventsDatabase | null = null;
const savedLedgerPath = process.env.OPENCLAW_ALGORITHM_METRICS_PATH;

/** The writer's worker, in-process: the real writer core on the test's own connection. */
function spawnInProcessWorker(db: EventsDatabase): Worker {
  const core = createWriterCore(db, { saltId: "unavailable", bootId: "fixture-live-boot" });
  const fake = new EventEmitter() as EventEmitter & {
    postMessage(request: WriterWorkerRequest): void;
    ref(): void;
    unref(): void;
    terminate(): Promise<number>;
  };
  fake.ref = () => {};
  fake.unref = () => {};
  fake.terminate = () => Promise.resolve(0);
  fake.postMessage = (request: WriterWorkerRequest) => {
    const response = handleWriterRequest(core, request);
    setImmediate(() => fake.emit("message", response));
  };
  return fake as unknown as Worker;
}

function selectRows(db: EventsDatabase): StoredEvent[] {
  return db.db
    .prepare("SELECT * FROM events WHERE name = ? ORDER BY id")
    .all(ALGO_OUTCOME_EVENT) as unknown as StoredEvent[];
}

function liveAlgoRows(): StoredEvent[] {
  if (handle === null) {
    throw new Error("the live database is closed");
  }
  return selectRows(handle);
}

/** Every JSONL line that parses (blank and deliberately malformed fixture lines are skipped). */
function ledgerRecords(): Array<Record<string, unknown>> {
  if (!existsSync(ledgerPath)) {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // blank or malformed
    }
  }
  return records;
}

/** The gateway going away: stop the live writer and close the test's connection. */
async function stopLiveWriter(): Promise<void> {
  await resetEventWriterForTest();
  handle?.close();
  handle = null;
}

beforeEach(async () => {
  await resetEventWriterForTest();
  dir = mkdtempSync(join(tmpdir(), "algo-outcome-events-"));
  dbPath = join(dir, "events.sqlite");
  ledgerPath = join(dir, "algorithm-metrics.jsonl");
  process.env.OPENCLAW_ALGORITHM_METRICS_PATH = ledgerPath;
  const db = openEventsDatabase(dbPath, WAL);
  handle = db;
  startEventWriter({
    env: { OPENCLAW_EVENTS_DB_PATH: dbPath },
    spawn: () => spawnInProcessWorker(db),
    statsIntervalMs: 0,
    maintenanceIntervalMs: 0,
    flushIntervalMs: 3_600_000,
  });
});

afterEach(async () => {
  await stopLiveWriter();
  if (savedLedgerPath === undefined) {
    delete process.env.OPENCLAW_ALGORITHM_METRICS_PATH;
  } else {
    process.env.OPENCLAW_ALGORITHM_METRICS_PATH = savedLedgerPath;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("algo.outcome dual write (logging.md §4.11)", () => {
  it("one call writes one JSONL line AND one row in the declared shape, with no free text", async () => {
    expect(liveAlgoRows()).toEqual([]); // CONTROL: the file holds no row before the call

    recordAlgorithmOutcome({
      algorithm: "compaction",
      variant: "fixture-variant",
      outcome: "fired",
      metrics: { tokensBefore: 1200, tokensAfter: 300, notFinite: Number.NaN },
      provenance: { tokensBefore: "third-party-reported", tokensAfter: "third-party-reported" },
      sessionKey: SESSION,
      model: "fixture-model",
      provider: "fixture-provider",
      config: { compactionMode: "fixture-mode" },
      note: NOTE,
    });
    await vi.waitFor(() => expect(ledgerRecords()).toHaveLength(1));
    await flushEventWriter();

    // The JSONL is written exactly as before: every key, the note and the raw key included.
    const line = ledgerRecords()[0] ?? {};
    expect(Object.keys(line)).toEqual([
      "v",
      "ts",
      "algorithm",
      "variant",
      "outcome",
      "metrics",
      "provenance",
      "sessionKey",
      "model",
      "provider",
      "config",
      "note",
    ]);
    expect(line.note).toBe(NOTE);
    expect(line.sessionKey).toBe(SESSION);

    const rows = liveAlgoRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as StoredEvent;
    const declared = EVENT_CATALOG.find((event) => event.name === ALGO_OUTCOME_EVENT);
    expect(declared).toBeDefined();
    expect(row.kind).toBe(declared?.kind);
    expect(row.label).toBe("compaction/fixture-variant");
    expect([row.dur_ms, row.n1, row.n2, row.n3, row.n4]).toEqual([null, null, null, null, null]);
    // One instant for both halves: the backfill's dedup key rests on it.
    expect(row.ts_ms).toBe(Date.parse(String(line.ts)));
    const fields = JSON.parse(row.fields ?? "{}") as Record<string, unknown>;
    expect(Object.keys(fields).filter((key) => !(key in (declared?.fields ?? {})))).toEqual([]);
    expect(fields).toEqual({
      outcome: "fired",
      metrics: { tokensBefore: 1200, tokensAfter: 300 },
      provenance: { tokensBefore: "third-party-reported", tokensAfter: "third-party-reported" },
      config: { compactionMode: "fixture-mode" },
      model: "fixture-model",
      provider: "fixture-provider",
      v: ALGORITHM_METRICS_SCHEMA_VERSION,
    });
    // L4: no free text and no raw session key in any column; the key survives only as its hash.
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("fixture-note");
    expect(stored).not.toContain("15555550142");
    expect(row.session_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.session_kind).toBe("whatsapp");
    const stats = getEventWriterStats();
    expect({
      dropped: stats.dropped,
      undeclaredKeys: stats.undeclaredKeys,
      invalidValues: stats.invalidValues,
    }).toEqual({ dropped: 0, undeclaredKeys: 0, invalidValues: 0 });
  });

  it("writes the row even when the JSONL's own sandbox guard writes no line", async () => {
    // Under a test runner with no explicit path, resolveLedgerPath() refuses: no JSONL line.
    delete process.env.OPENCLAW_ALGORITHM_METRICS_PATH;
    recordAlgorithmOutcome({
      algorithm: "prompt-cache",
      variant: "fixture-variant",
      outcome: "observed",
      metrics: { cacheReadTokens: 10 },
      provenance: { cacheReadTokens: "per-call-measured" },
    });
    await flushEventWriter();
    expect(liveAlgoRows().map((row) => row.label)).toEqual(["prompt-cache/fixture-variant"]);
    expect(existsSync(ledgerPath)).toBe(false);
  });
});

describe("scripts/events-backfill.ts on algorithm-metrics.jsonl", () => {
  /** A ledger line as the JSONL holds it: the real field names, invented values. */
  function ledgerLine(ts: string, algorithm: string, variant: string): string {
    return JSON.stringify({
      v: 1,
      ts,
      algorithm,
      variant,
      outcome: "observed",
      metrics: { bytesOut: 10 },
      provenance: { bytesOut: "local-measured" },
      note: "fixture free text",
    });
  }

  it("imports a fixture ledger once, recognises the live row, and a second run inserts 0", async () => {
    // History from before the bridge: two IDENTICAL lines (a multiset keeps both), one more
    // family, and a line that is not JSON.
    writeFileSync(
      ledgerPath,
      [
        ledgerLine("2026-09-01T10:00:00.000Z", "tool-output", "fixture_tool"),
        ledgerLine("2026-09-01T10:00:00.000Z", "tool-output", "fixture_tool"),
        ledgerLine("2026-09-02T11:00:00.000Z", "prompt-cache", "fixture-variant"),
        "{not json",
        "",
      ].join("\n"),
    );
    // One outcome through the live bridge: a JSONL line AND its row.
    recordAlgorithmOutcome({
      algorithm: "tool-output",
      variant: "fixture_tool",
      outcome: "observed",
      metrics: { bytesOut: 10 },
      provenance: { bytesOut: "local-measured" },
      note: "fixture free text",
    });
    await vi.waitFor(() => expect(ledgerRecords()).toHaveLength(4));
    await flushEventWriter();
    await stopLiveWriter();

    const run = () =>
      runEventsBackfill({
        dbPath,
        algorithmMetricsPath: ledgerPath,
        engramDirs: [],
        dryRun: false,
        settleMs: 0,
      });
    const first = await run();
    expect(first.sources.algorithmMetrics).toMatchObject({ lines: 5, malformed: 1, records: 4 });
    expect(first.alreadyPresent).toBe(1); // the live row, recognised by its key
    expect(first.inserted).toBe(3);
    expect(first.writer).toEqual({ dropped: 0, invalidValues: 0, undeclaredKeys: 0 });
    expect(first.parity.total[ALGO_OUTCOME_EVENT]).toEqual({
      "tool-output": { jsonl: 3, dbLive: 1, dbBackfill: 2 },
      "prompt-cache": { jsonl: 1, dbLive: 0, dbBackfill: 1 },
    });

    const second = await run();
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(4);
    expect(second.rowsInFile).toEqual({ before: 4, after: 4 });
    expect(second.parity.total).toEqual(first.parity.total);

    const check = openEventsDatabase(dbPath, WAL);
    try {
      const rows = selectRows(check);
      expect(rows).toHaveLength(4);
      expect(rows.filter((row) => row.boot_id === BACKFILL_BOOT_ID)).toHaveLength(3);
      expect(JSON.stringify(rows)).not.toContain("fixture free text");
    } finally {
      check.close();
    }
  });

  it("a dry run reports what it would insert and creates nothing", async () => {
    writeFileSync(
      ledgerPath,
      `${ledgerLine("2026-09-01T10:00:00.000Z", "compaction", "fixture-variant")}\n`,
    );
    const target = join(dir, "dry", "events.sqlite");
    const report = await runEventsBackfill({
      dbPath: target,
      algorithmMetricsPath: ledgerPath,
      engramDirs: [],
      dryRun: true,
      settleMs: 0,
    });
    expect(report.inserted).toBe(1);
    expect(report.parity.total[ALGO_OUTCOME_EVENT]).toEqual({
      compaction: { jsonl: 1, dbLive: 0, dbBackfill: 1 },
    });
    // No database, no salt, not even the directory.
    expect(existsSync(join(dir, "dry"))).toBe(false);
  });

  it("refuses the production events database under a test runner", async () => {
    const production = join(homedir(), ".openclaw", "logs", "events.sqlite");
    expect(() => assertBackfillTargetAllowed(production)).toThrow(
      /refusing the production events database/,
    );
    await expect(
      runEventsBackfill({
        dbPath: production,
        algorithmMetricsPath: ledgerPath,
        engramDirs: [],
        dryRun: true,
      }),
    ).rejects.toThrow(/refusing the production events database/);
    // CONTROL: the same path outside a test runner passes, so the refusal IS the test-runner guard.
    expect(() => assertBackfillTargetAllowed(production, {})).not.toThrow();
    expect(() => assertBackfillTargetAllowed(join(dir, "events.sqlite"))).not.toThrow();
  });
});

describe("the parity report (the seven-day retirement input)", () => {
  it("counts per family, and compares each complete UTC day against LIVE rows only", () => {
    const at = (iso: string): number => Date.parse(iso);
    const now = at("2026-09-10T12:00:00.000Z");
    const sources = [
      { name: ALGO_OUTCOME_EVENT, family: "tool-output", tsMs: at("2026-09-09T08:00:00.000Z") },
      { name: ALGO_OUTCOME_EVENT, family: "tool-output", tsMs: at("2026-09-09T09:00:00.000Z") },
      { name: ALGO_OUTCOME_EVENT, family: "compaction", tsMs: at("2026-09-08T10:00:00.000Z") },
      // Before the window, and today (not yet a complete day): totals only.
      { name: ALGO_OUTCOME_EVENT, family: "compaction", tsMs: at("2026-09-01T10:00:00.000Z") },
      { name: ALGO_OUTCOME_EVENT, family: "compaction", tsMs: at("2026-09-10T10:00:00.000Z") },
    ];
    const row = (label: string, iso: string, bootId = "fixture-live-boot") => ({
      name: ALGO_OUTCOME_EVENT,
      ts_ms: at(iso),
      label,
      boot_id: bootId,
    });
    const rows = [
      row("tool-output/fixture_tool", "2026-09-09T08:00:00.000Z"),
      row("tool-output/fixture_tool", "2026-09-09T09:00:00.000Z"),
      // Imported: it must NOT count as the live bridge having written this day.
      row("compaction/fixture-variant", "2026-09-08T10:00:00.000Z", BACKFILL_BOOT_ID),
    ];
    const report = buildParityReport(sources, rows, now);
    expect(report.total[ALGO_OUTCOME_EVENT]).toEqual({
      "tool-output": { jsonl: 2, dbLive: 2, dbBackfill: 0 },
      compaction: { jsonl: 3, dbLive: 0, dbBackfill: 1 },
    });
    expect(report.retirement.days).toEqual([
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
    ]);
    expect(report.retirement.mismatches).toEqual([
      { day: "2026-09-08", name: ALGO_OUTCOME_EVENT, family: "compaction", jsonl: 1, dbLive: 0 },
    ]);
    expect(report.retirement.match).toBe(false);

    // The live bridge writes that day's row: the window matches.
    const healed = buildParityReport(
      sources,
      [...rows, row("compaction/fixture-variant", "2026-09-08T10:00:00.000Z")],
      now,
    );
    expect(healed.retirement.mismatches).toEqual([]);
    expect(healed.retirement.match).toBe(true);
    // An empty window is not parity: it proves nothing about the live bridge.
    expect(buildParityReport([], [], now).retirement.match).toBe(false);
  });
});
