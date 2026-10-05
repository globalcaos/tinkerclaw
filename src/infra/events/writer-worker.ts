/**
 * The events writer's worker thread — TINKER_UI_DESIGN_BIBLE/logging.md §7.5 (§9 step 3).
 *
 * One worker_threads Worker owns the ONE connection to the events database — opened only through
 * `openEventsDatabase` (schema.ts), so the §7.3 pragma order and migration ladder cannot be
 * bypassed — the prepared INSERT (one transaction per batch), the daily §7.4 maintenance pass
 * (rollup into `rollup_1h`, batched deletes near 50 ms per transaction, `incremental_vacuum`, a
 * TRUNCATE checkpoint, and the `logs.retention.run` row), the answer to `stats` requests, the
 * compaction ledger's restart-seed `ledger` query (queryLedgerGroups; context-window-panel.md §6.1
 * A4), and the `query` request — a SAVED events query by name for `logs.query` / `logs.catalog`
 * (logging.md §8.2) — run on a SECOND, read-only connection that query.ts opens on the first
 * query, so the main thread never reads the database either.
 * The main-thread half (emit.ts) spawns it with `workerData` and respawns it after a crash with
 * the FTS worker's backoff.
 *
 * The `stats` answer also carries THIS isolate's heap (readIsolateStats). v8 reports the CALLING
 * isolate, so the writer thread's own memory can be read nowhere else — which is what makes the
 * `events_writer` row of `worker.sample` possible at all (logging.md §4.9).
 *
 * Everything is an exported function so writer-worker.test.ts exercises it in-process. The
 * thread bootstrap at the bottom runs ONLY when `workerData` carries this module's role marker:
 * `isMainThread` alone cannot gate it, because vitest itself runs test files in worker threads.
 */

import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import type {
  EventLedgerWireGroup,
  EventLedgerWireQuery,
  EventQueryWireRequest,
  EventWireRow,
  EventWriterIsolateStats,
  WriterWorkerInit,
  WriterWorkerRequest,
  WriterWorkerResponse,
} from "./emit.js";
import { type EventsQueryResult, openReadOnlyEventsDatabase, runSavedQuery } from "./query.js";
import { openEventsDatabase, type EventsDatabase } from "./schema.js";

// ─── §7.4 retention constants ───────────────────────────────────────────────

export const HOT_WINDOW_DAYS = 14;
export const EVENT_WINDOW_DAYS = 180;
export const DEBUG_WINDOW_HOURS = 48;
export const ROLLUP_KEEP_DAYS = 400;
/** The pass is daily; the gate is meta.last_maintenance_ms, durable across restarts. */
export const MAINTENANCE_MIN_INTERVAL_MS = 24 * 3_600_000;
/** §7.4: the first pass deletes 5,000 rows per transaction; later batches derive from measurement. */
export const FIRST_DELETE_BATCH_ROWS = 5_000;
export const DELETE_BATCH_TARGET_MS = 50;
const DELETE_BATCH_MIN_ROWS = 500;
const DELETE_BATCH_MAX_ROWS = 50_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type Stmt = ReturnType<DatabaseSync["prepare"]>;

const INSERT_SQL =
  "INSERT INTO events (ts_ms, name, kind, boot_id, session_hash, session_kind, run_id, " +
  "worker_id, label, dur_ms, n1, n2, n3, n4, fields) VALUES (@ts_ms, @name, @kind, @boot_id, " +
  "@session_hash, @session_kind, @run_id, @worker_id, @label, @dur_ms, @n1, @n2, @n3, @n4, " +
  "@fields)";

/**
 * The compaction ledger's restart seed (emit.ts queryPriorBootLedger): per (session_hash,
 * `fields.trigger`), the row count, the n3 sum and count, and the latest ts_ms of the `name` rows
 * labelled `label`, leaving out the listed writers' rows. Both lists travel as JSON arrays, so one
 * prepared statement serves any batch size; the session filter can use `events_session_ts`.
 */
const LEDGER_SQL =
  "SELECT session_hash, json_extract(fields, '$.trigger') AS trigger_name, " +
  "count(*) AS row_count, sum(n3) AS dropped_tokens, count(n3) AS dropped_known, " +
  "max(ts_ms) AS last_ts_ms FROM events " +
  "WHERE session_hash IN (SELECT value FROM json_each(@hashes)) AND name = @name " +
  "AND label = @label AND boot_id NOT IN (SELECT value FROM json_each(@exclude)) " +
  "GROUP BY session_hash, json_extract(fields, '$.trigger')";

type LedgerSqlRow = {
  session_hash: string;
  trigger_name: string | null;
  row_count: number;
  dropped_tokens: number | null;
  dropped_known: number;
  last_ts_ms: number | null;
};

function getMetaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** One transaction per batch (§7.5); a batch either lands whole or not at all. */
export function insertEventRows(
  db: DatabaseSync,
  insert: Stmt,
  rows: readonly EventWireRow[],
): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      insert.run(row);
    }
    db.exec("COMMIT");
    return rows.length;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Some failures end the transaction themselves; the original error is the one to report.
    }
    throw error;
  }
}

export function databaseBytes(handle: EventsDatabase): { dbBytes: number; walBytes: number } {
  const { page_count: pageCount } = handle.db.prepare("PRAGMA page_count").get() as {
    page_count: number;
  };
  const { page_size: pageSize } = handle.db.prepare("PRAGMA page_size").get() as {
    page_size: number;
  };
  let walBytes = 0;
  try {
    walBytes = statSync(`${handle.path}-wal`).size;
  } catch {
    // no WAL file yet
  }
  return { dbBytes: pageCount * pageSize, walBytes };
}

export interface MaintenanceOptions {
  readonly nowMs: number;
  /** §7.4: OPENCLAW_EVENTS_DB_MAX_BYTES, resolved by the main thread. */
  readonly budgetBytes: number;
  /** Test seam: skip the daily gate. */
  readonly force?: boolean;
  readonly bootId: string;
}

export interface MaintenanceOutcome {
  readonly ran: boolean;
  readonly rowsDeleted: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly hotDays: number;
  readonly eventDays: number;
  readonly shortened: boolean;
}

interface RetentionClassTotals {
  readonly retention: string;
  readonly total: number;
  readonly minTs: number;
  readonly maxTs: number;
}

/**
 * §7.4 derived windows: `hot_days = min(14, floor((budget − research − event) / hot_per_day))`,
 * then the same for `event` against what remains; `research` is never cut. Bytes per class are
 * estimated as row share of the measured file size — provenance: estimated, replaced by nothing
 * better until SQLite grows a per-row scale. Clamped to at least one day so a pathological
 * budget still leaves a readable today.
 */
export function deriveRetentionWindows(
  db: DatabaseSync,
  dbBytes: number,
  budgetBytes: number,
): { hotDays: number; eventDays: number; shortened: boolean } {
  const totals = db
    .prepare(
      "SELECT COALESCE(c.retention, 'event') AS retention, count(*) AS total, " +
        "min(e.ts_ms) AS minTs, max(e.ts_ms) AS maxTs FROM events e " +
        "LEFT JOIN catalog c ON c.name = e.name GROUP BY COALESCE(c.retention, 'event')",
    )
    .all() as unknown as RetentionClassTotals[];
  const byClass = new Map(totals.map((row) => [row.retention, row]));
  const totalRows = totals.reduce((sum, row) => sum + row.total, 0);
  const avgRowBytes = totalRows > 0 ? dbBytes / totalRows : 150;
  const bytesOf = (retention: string): number => (byClass.get(retention)?.total ?? 0) * avgRowBytes;
  const perDay = (retention: string): number => {
    const row = byClass.get(retention);
    if (!row || row.total === 0) {
      return 0;
    }
    const spanDays = Math.max(1, Math.ceil((row.maxTs - row.minTs) / DAY_MS));
    return (row.total * avgRowBytes) / spanDays;
  };
  const hotPerDay = perDay("hot");
  const hotDays =
    hotPerDay > 0
      ? clamp(
          Math.floor((budgetBytes - bytesOf("research") - bytesOf("event")) / hotPerDay),
          1,
          HOT_WINDOW_DAYS,
        )
      : HOT_WINDOW_DAYS;
  const eventPerDay = perDay("event");
  const eventDays =
    eventPerDay > 0
      ? clamp(
          Math.floor((budgetBytes - bytesOf("research") - hotPerDay * hotDays) / eventPerDay),
          1,
          EVENT_WINDOW_DAYS,
        )
      : EVENT_WINDOW_DAYS;
  return {
    hotDays,
    eventDays,
    shortened: hotDays < HOT_WINDOW_DAYS || eventDays < EVENT_WINDOW_DAYS,
  };
}

interface RollupGroup {
  readonly hour_ms: number;
  readonly name: string;
  readonly label: string;
  readonly worker_id: string;
  readonly count: number;
  readonly dur_sum: number | null;
  readonly dur_max: number | null;
  readonly dur_count: number;
  readonly n1_avg: number | null;
  readonly n1_max: number | null;
  readonly n2_avg: number | null;
  readonly n2_max: number | null;
  readonly n3_avg: number | null;
  readonly n3_max: number | null;
  readonly n4_avg: number | null;
  readonly n4_max: number | null;
}

/**
 * Rolls the FULL hours of hot-class rows before `cutoffHourMs` (already hour-aligned) into
 * `rollup_1h`. Idempotent: INSERT OR REPLACE on the rollup key, and only whole hours are ever
 * rolled, so a re-run recomputes the same aggregate rather than replacing it with a partial one.
 * dur_p99 is nearest-rank (§8.1's convention), computed per group.
 */
export function rollupHotHours(db: DatabaseSync, cutoffHourMs: number): number {
  const groups = db
    .prepare(
      "SELECT (e.ts_ms / 3600000) * 3600000 AS hour_ms, e.name AS name, " +
        "COALESCE(e.label, '') AS label, COALESCE(e.worker_id, '') AS worker_id, " +
        "count(*) AS count, sum(e.dur_ms) AS dur_sum, max(e.dur_ms) AS dur_max, " +
        "count(e.dur_ms) AS dur_count, " +
        "avg(e.n1) AS n1_avg, max(e.n1) AS n1_max, avg(e.n2) AS n2_avg, max(e.n2) AS n2_max, " +
        "avg(e.n3) AS n3_avg, max(e.n3) AS n3_max, avg(e.n4) AS n4_avg, max(e.n4) AS n4_max " +
        "FROM events e JOIN catalog c ON c.name = e.name " +
        "WHERE c.retention = 'hot' AND e.ts_ms < ? " +
        "GROUP BY hour_ms, e.name, COALESCE(e.label, ''), COALESCE(e.worker_id, '')",
    )
    .all(cutoffHourMs) as unknown as RollupGroup[];
  if (groups.length === 0) {
    return 0;
  }
  const p99 = db.prepare(
    "SELECT dur_ms FROM events WHERE name = ? AND ts_ms >= ? AND ts_ms < ? " +
      "AND COALESCE(label, '') = ? AND COALESCE(worker_id, '') = ? AND dur_ms IS NOT NULL " +
      "ORDER BY dur_ms LIMIT 1 OFFSET ?",
  );
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO rollup_1h (hour_ms, name, label, worker_id, count, dur_sum, " +
      "dur_max, dur_p99, n1_avg, n1_max, n2_avg, n2_max, n3_avg, n3_max, n4_avg, n4_max) " +
      "VALUES (@hour_ms, @name, @label, @worker_id, @count, @dur_sum, @dur_max, @dur_p99, " +
      "@n1_avg, @n1_max, @n2_avg, @n2_max, @n3_avg, @n3_max, @n4_avg, @n4_max)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const group of groups) {
      let durP99: number | null = null;
      if (group.dur_count > 0) {
        const offset = Math.max(0, Math.ceil(0.99 * group.dur_count) - 1);
        const row = p99.get(
          group.name,
          group.hour_ms,
          group.hour_ms + HOUR_MS,
          group.label,
          group.worker_id,
          offset,
        ) as { dur_ms: number } | undefined;
        durP99 = row?.dur_ms ?? null;
      }
      upsert.run({
        hour_ms: group.hour_ms,
        name: group.name,
        label: group.label,
        worker_id: group.worker_id,
        count: group.count,
        dur_sum: group.dur_sum,
        dur_max: group.dur_max,
        dur_p99: durP99,
        n1_avg: group.n1_avg,
        n1_max: group.n1_max,
        n2_avg: group.n2_avg,
        n2_max: group.n2_max,
        n3_avg: group.n3_avg,
        n3_max: group.n3_max,
        n4_avg: group.n4_avg,
        n4_max: group.n4_max,
      });
    }
    db.exec("COMMIT");
    return groups.length;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // see insertEventRows
    }
    throw error;
  }
}

/**
 * §7.4: deletes in batches sized so one transaction stays near DELETE_BATCH_TARGET_MS, the size
 * derived from each batch's measured rate. A retired event (no catalog row) ages as `event`
 * class: its rows stay §7.3-readable but not immortal. `research` is never passed in here.
 */
function createBatchedDeleter(db: DatabaseSync, initialBatchRows: number) {
  let batchRows = clamp(
    Number.isFinite(initialBatchRows) && initialBatchRows > 0
      ? Math.floor(initialBatchRows)
      : FIRST_DELETE_BATCH_ROWS,
    DELETE_BATCH_MIN_ROWS,
    DELETE_BATCH_MAX_ROWS,
  );
  const del = db.prepare(
    "DELETE FROM events WHERE id IN (SELECT e.id FROM events e " +
      "LEFT JOIN catalog c ON c.name = e.name " +
      "WHERE COALESCE(c.retention, 'event') = ? AND e.ts_ms < ? LIMIT ?)",
  );
  return {
    byRetention(retention: string, cutoffMs: number): number {
      let total = 0;
      for (;;) {
        const limit = batchRows;
        const started = Date.now();
        const changes = Number(del.run(retention, cutoffMs, limit).changes);
        total += changes;
        const elapsedMs = Math.max(1, Date.now() - started);
        batchRows = clamp(
          Math.round((limit * DELETE_BATCH_TARGET_MS) / elapsedMs),
          DELETE_BATCH_MIN_ROWS,
          DELETE_BATCH_MAX_ROWS,
        );
        if (changes < limit) {
          return total;
        }
      }
    },
    batchRows(): number {
      return batchRows;
    },
  };
}

/**
 * The daily maintenance pass (§7.4): rollup, batched deletes, `incremental_vacuum`, a TRUNCATE
 * checkpoint, and the `logs.retention.run` row. Gated on meta.last_maintenance_ms unless forced.
 */
export function runMaintenance(
  handle: EventsDatabase,
  insert: Stmt,
  options: MaintenanceOptions,
): MaintenanceOutcome {
  const db = handle.db;
  const last = Number(getMetaValue(db, "last_maintenance_ms") ?? "0");
  if (
    options.force !== true &&
    Number.isFinite(last) &&
    options.nowMs - last < MAINTENANCE_MIN_INTERVAL_MS
  ) {
    return {
      ran: false,
      rowsDeleted: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      hotDays: HOT_WINDOW_DAYS,
      eventDays: EVENT_WINDOW_DAYS,
      shortened: false,
    };
  }
  const before = databaseBytes(handle);
  const bytesBefore = before.dbBytes + before.walBytes;
  const windows = deriveRetentionWindows(db, before.dbBytes, options.budgetBytes);
  // Hour-aligned so only FULL hours leave the hot window (rollup idempotence).
  const hotCutoffMs = Math.floor((options.nowMs - windows.hotDays * DAY_MS) / HOUR_MS) * HOUR_MS;
  rollupHotHours(db, hotCutoffMs);
  const deleter = createBatchedDeleter(
    db,
    Number(getMetaValue(db, "maintenance_delete_batch") ?? "") || FIRST_DELETE_BATCH_ROWS,
  );
  let rowsDeleted = 0;
  rowsDeleted += deleter.byRetention("hot", hotCutoffMs);
  rowsDeleted += deleter.byRetention("event", options.nowMs - windows.eventDays * DAY_MS);
  rowsDeleted += deleter.byRetention("debug", options.nowMs - DEBUG_WINDOW_HOURS * HOUR_MS);
  rowsDeleted += Number(
    db
      .prepare("DELETE FROM rollup_1h WHERE hour_ms < ?")
      .run(options.nowMs - ROLLUP_KEEP_DAYS * DAY_MS).changes,
  );
  db.exec("PRAGMA incremental_vacuum;");
  handle.walMaintenance.checkpoint();
  const after = databaseBytes(handle);
  const outcome: MaintenanceOutcome = {
    ran: true,
    rowsDeleted,
    bytesBefore,
    bytesAfter: after.dbBytes + after.walBytes,
    hotDays: windows.hotDays,
    eventDays: windows.eventDays,
    shortened: windows.shortened,
  };
  insert.run({
    ts_ms: options.nowMs,
    name: "logs.retention.run",
    kind: "outcome",
    boot_id: options.bootId,
    session_hash: null,
    session_kind: null,
    run_id: null,
    worker_id: null,
    label: null,
    dur_ms: null,
    n1: outcome.rowsDeleted,
    n2: outcome.bytesBefore,
    n3: outcome.bytesAfter,
    n4: null,
    fields: JSON.stringify({
      hot_days: outcome.hotDays,
      event_days: outcome.eventDays,
      shortened: outcome.shortened,
    }),
  } satisfies EventWireRow);
  setMetaValue(db, "last_maintenance_ms", String(options.nowMs));
  setMetaValue(db, "maintenance_delete_batch", String(deleter.batchRows()));
  return outcome;
}

/** The `ledger` request, on the worker's own connection (LEDGER_SQL). */
export function queryLedgerGroups(
  statement: Stmt,
  query: EventLedgerWireQuery,
): EventLedgerWireGroup[] {
  const rows = statement.all({
    hashes: JSON.stringify(query.sessionHashes),
    exclude: JSON.stringify(query.excludeBootIds),
    name: query.name,
    label: query.label,
  }) as unknown as LedgerSqlRow[];
  return rows.map((row) => ({
    sessionHash: row.session_hash,
    trigger: row.trigger_name,
    rows: row.row_count,
    droppedTokens: row.dropped_tokens,
    droppedKnown: row.dropped_known,
    lastTsMs: row.last_ts_ms,
  }));
}

export interface WriterCore {
  insert(rows: readonly EventWireRow[]): number;
  stats(): { dbBytes: number; walBytes: number; schemaVersion: number };
  maintenance(options: { nowMs: number; budgetBytes: number; force?: boolean }): MaintenanceOutcome;
  /** The compaction ledger's restart seed (queryLedgerGroups). */
  ledger(query: EventLedgerWireQuery): EventLedgerWireGroup[];
  /** A saved events query by name, on the read-only connection (query.ts runSavedQuery). */
  query(request: EventQueryWireRequest): EventsQueryResult;
  /** Closes the read-only connection if one was opened; the writer's own handle is its owner's. */
  closeReader(): void;
}

export function createWriterCore(
  handle: EventsDatabase,
  init: { readonly saltId: string; readonly bootId: string },
): WriterCore {
  // §7.3 meta: a fingerprint of the salt, never the salt. A spawn whose salt failed to load
  // must not overwrite a previously recorded good fingerprint.
  if (init.saltId !== "unavailable") {
    setMetaValue(handle.db, "salt_id", init.saltId);
  }
  const insert = handle.db.prepare(INSERT_SQL);
  // Prepared on the first ledger query, so a writer nobody asks pays nothing for it.
  let ledgerStatement: Stmt | undefined;
  // logging.md §8.2: saved queries read through a SECOND connection, opened read-only by query.ts
  // on the first query — a query cannot write, whatever its SQL, and the writer's own connection
  // stays the only one opened through openEventsDatabase. Between queries it holds no snapshot.
  let reader: DatabaseSync | undefined;
  return {
    insert(rows) {
      return insertEventRows(handle.db, insert, rows);
    },
    stats() {
      const bytes = databaseBytes(handle);
      return {
        ...bytes,
        schemaVersion: Number(getMetaValue(handle.db, "schema_version") ?? 0),
      };
    },
    maintenance(options) {
      return runMaintenance(handle, insert, { ...options, bootId: init.bootId });
    },
    ledger(query) {
      ledgerStatement ??= handle.db.prepare(LEDGER_SQL);
      return queryLedgerGroups(ledgerStatement, query);
    },
    query(request) {
      reader ??= openReadOnlyEventsDatabase(handle.path);
      return runSavedQuery(reader, request);
    },
    closeReader() {
      reader?.close();
      reader = undefined;
    },
  };
}

/**
 * The ANSWERING isolate's heap — in production the writer thread's own, because v8 reports the
 * CALLING isolate and only this thread answers a `stats` request there (logging.md §4.9; the
 * src/memory/engram/fts-worker.ts precedent, field for field). Cheap enough to ride every stats
 * probe: two synchronous v8 reads. It lives HERE and not on WriterCore, because WriterCore is the
 * database's contract and an isolate is a fact about the thread, not about the connection.
 */
export function readIsolateStats(): EventWriterIsolateStats {
  const heap = getHeapStatistics();
  // This thread's own CPU. A Node without threadCpuUsage answers null — never the process's CPU
  // under the thread's name, which would count the gateway's work as the writer's.
  const cpu = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : null;
  return {
    usedHeapBytes: heap.used_heap_size,
    totalHeapBytes: heap.total_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    externalBytes: heap.external_memory,
    cpuUsec: cpu === null ? null : cpu.user + cpu.system,
    uptimeMs: performance.now(),
  };
}

/** Requests are answered one at a time, in arrival order; an error never kills the thread. */
export function handleWriterRequest(
  core: WriterCore,
  request: WriterWorkerRequest,
): WriterWorkerResponse {
  try {
    switch (request.type) {
      case "insert":
        return { id: request.id, ok: true, type: "insert", inserted: core.insert(request.rows) };
      case "stats":
        return {
          id: request.id,
          ok: true,
          type: "stats",
          ...core.stats(),
          isolate: readIsolateStats(),
        };
      case "ledger":
        return { id: request.id, ok: true, type: "ledger", groups: core.ledger(request) };
      case "query":
        return { id: request.id, ok: true, type: "query", result: core.query(request) };
      case "maintenance":
        return {
          id: request.id,
          ok: true,
          type: "maintenance",
          ...core.maintenance({
            nowMs: request.nowMs,
            budgetBytes: request.budgetBytes,
            force: request.force === true,
          }),
        };
      default:
        return {
          id: (request as { id: number }).id,
          ok: false,
          type: "error",
          message: "unknown events writer request type",
        };
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      type: "error",
      message: String(error).slice(0, 500),
    };
  }
}

function isWriterInit(value: unknown): value is WriterWorkerInit {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "events-writer" &&
    typeof (value as { dbPath?: unknown }).dbPath === "string"
  );
}

// The bootstrap: only in a thread emit.ts spawned (the role marker), never under a test runner
// that merely imported this module — vitest runs test files in worker threads of its own.
if (parentPort !== null && isWriterInit(workerData)) {
  const port = parentPort;
  const handle = openEventsDatabase(workerData.dbPath);
  const core = createWriterCore(handle, workerData);
  port.on("message", (request: WriterWorkerRequest) => {
    port.postMessage(handleWriterRequest(core, request));
  });
}
