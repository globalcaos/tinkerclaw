/**
 * logging.md §4.11 `engram.metric` (§9 step 9): the ENGRAM collector's dual write, and the
 * backfill of its per-day files (scripts/events-backfill.ts).
 *
 * CONTROL: before this change record() appended its per-day line and wrote NO events row, so every
 * row asserted below is new behaviour. The writer is the real one (emit.ts); its worker runs
 * in-process on the real writer core (writer-worker.ts) against a temp database, so every
 * assertion reads the file.
 *
 * Fixtures carry the collector's field names only; every value is invented.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKFILL_BOOT_ID, runEventsBackfill } from "../../../scripts/events-backfill.js";
import { EVENT_CATALOG } from "../../infra/events/catalog.js";
import {
  flushEventWriter,
  getEventWriterStats,
  resetEventWriterForTest,
  startEventWriter,
  type WriterWorkerRequest,
} from "../../infra/events/emit.js";
import { type EventsDatabase, openEventsDatabase } from "../../infra/events/schema.js";
import { createWriterCore, handleWriterRequest } from "../../infra/events/writer-worker.js";
import { createMetricsCollector, ENGRAM_METRIC_EVENT } from "./metrics.js";

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

const WAL = { walMaintenance: { checkpointIntervalMs: 0 } };

let dir = "";
let dbPath = "";
let engramDir = "";
let handle: EventsDatabase | null = null;

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
    .all(ENGRAM_METRIC_EVENT) as unknown as StoredEvent[];
}

function liveEngramRows(): StoredEvent[] {
  if (handle === null) {
    throw new Error("the live database is closed");
  }
  return selectRows(handle);
}

/** The gateway going away: stop the live writer and close the test's connection. */
async function stopLiveWriter(): Promise<void> {
  await resetEventWriterForTest();
  handle?.close();
  handle = null;
}

beforeEach(async () => {
  await resetEventWriterForTest();
  dir = mkdtempSync(join(tmpdir(), "engram-metric-events-"));
  dbPath = join(dir, "db", "events.sqlite");
  engramDir = join(dir, "engram");
  mkdirSync(engramDir, { recursive: true });
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
  rmSync(dir, { recursive: true, force: true });
});

describe("engram.metric dual write (logging.md §4.11)", () => {
  it("one record() writes one per-day line AND one row in the declared shape", async () => {
    expect(liveEngramRows()).toEqual([]); // CONTROL: the file holds no row before the call

    const collector = createMetricsCollector({ baseDir: engramDir, date: "2026-09-03" });
    collector.record("compaction", "engram_pointer_compaction", 1, {
      eventsStored: 3,
      tokensEvicted: 120,
      markerTokens: 9,
      pointerMode: 1,
    });
    await flushEventWriter();

    // The per-day file is written exactly as before, metadata included.
    const lines = readFileSync(collector.filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    expect(line).toMatchObject({
      phase: "compaction",
      metric_name: "engram_pointer_compaction",
      value: 1,
      metadata: { eventsStored: 3, tokensEvicted: 120, markerTokens: 9, pointerMode: 1 },
    });

    const rows = liveEngramRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as StoredEvent;
    const declared = EVENT_CATALOG.find((event) => event.name === ENGRAM_METRIC_EVENT);
    expect(declared).toBeDefined();
    expect(row.kind).toBe(declared?.kind);
    expect(row.label).toBe("compaction/engram_pointer_compaction");
    expect(row.n1).toBe(1);
    expect(row.ts_ms).toBe(Date.parse(String(line.timestamp)));
    // label and n1 only: metadata is not carried, and no session column is filled.
    expect([
      row.dur_ms,
      row.n2,
      row.n3,
      row.n4,
      row.fields,
      row.session_hash,
      row.session_kind,
    ]).toEqual([null, null, null, null, null, null, null]);
    expect(JSON.stringify(row)).not.toContain("tokensEvicted");
    const stats = getEventWriterStats();
    expect({
      dropped: stats.dropped,
      undeclaredKeys: stats.undeclaredKeys,
      invalidValues: stats.invalidValues,
    }).toEqual({ dropped: 0, undeclaredKeys: 0, invalidValues: 0 });
  });
});

describe("scripts/events-backfill.ts on the ENGRAM per-day files", () => {
  /** A collector line as the per-day file holds it: the real field names, invented values. */
  function entry(timestamp: string, metricName: string): string {
    return JSON.stringify({
      timestamp,
      phase: "compaction",
      metric_name: metricName,
      value: 1,
      metadata: { eventsStored: 2, tokensEvicted: 50, markerTokens: 4 },
    });
  }

  it("imports the day files once, recognises the live row, and reads only day files", async () => {
    writeFileSync(
      join(engramDir, "2026-09-01.jsonl"),
      `${entry("2026-09-01T10:00:00.000Z", "engram_compaction")}\n` +
        `${entry("2026-09-01T11:00:00.000Z", "engram_pointer_compaction")}\n`,
    );
    writeFileSync(
      join(engramDir, "2026-09-02.jsonl"),
      `${entry("2026-09-02T09:00:00.000Z", "engram_pointer_compaction")}\n{not json\n`,
    );
    // Not a day file: the collector never writes this name, so the backfill never reads it.
    writeFileSync(
      join(engramDir, "not-a-day.jsonl"),
      `${entry("2026-09-02T12:00:00.000Z", "engram_compaction")}\n`,
    );
    // One record through the live bridge: a per-day line AND its row.
    createMetricsCollector({ baseDir: engramDir, date: "2026-09-03" }).record(
      "compaction",
      "engram_pointer_compaction",
      1,
    );
    await flushEventWriter();
    await stopLiveWriter();

    const run = () =>
      runEventsBackfill({
        dbPath,
        algorithmMetricsPath: join(dir, "absent-algorithm-metrics.jsonl"),
        engramDirs: [engramDir],
        dryRun: false,
        settleMs: 0,
      });
    const first = await run();
    expect(first.sources.engram).toMatchObject({ files: 3, lines: 5, malformed: 1, records: 4 });
    expect(first.alreadyPresent).toBe(1); // the live row, recognised by its key
    expect(first.inserted).toBe(3);
    expect(first.writer).toEqual({ dropped: 0, invalidValues: 0, undeclaredKeys: 0 });
    expect(first.parity.total[ENGRAM_METRIC_EVENT]).toEqual({
      compaction: { jsonl: 4, dbLive: 1, dbBackfill: 3 },
    });

    const second = await run();
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(4);

    const check = openEventsDatabase(dbPath, WAL);
    try {
      const rows = selectRows(check);
      expect(rows).toHaveLength(4);
      expect(
        rows
          .filter((row) => row.boot_id === BACKFILL_BOOT_ID)
          .map((row) => row.label)
          .toSorted(),
      ).toEqual([
        "compaction/engram_compaction",
        "compaction/engram_pointer_compaction",
        "compaction/engram_pointer_compaction",
      ]);
      expect(JSON.stringify(rows)).not.toContain("tokensEvicted");
    } finally {
      check.close();
    }
  });
});
