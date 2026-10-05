/**
 * Import the two research JSONL stores into the events database, and report per-family parity —
 * TINKER_UI_DESIGN_BIBLE/logging.md §4.11 and §9 step 9 (the scripts/llm-ledger-backfill.ts
 * precedent: explicit --db, a --dry-run flag, a JSON report on stdout).
 *
 *   node --import tsx scripts/events-backfill.ts [--state-dir <dir>] [--db <file>]
 *        [--algorithm-metrics <file>] [--engram-dir <dir>]... [--settle-minutes 10] [--dry-run]
 *
 * SOURCES, read-only (logging.md §2b):
 *  - `<state>/data/algorithm-metrics.jsonl` -> `algo.outcome`;
 *  - the ENGRAM collector's per-day `YYYY-MM-DD.jsonl` files -> `engram.metric`, from
 *    `<state>/engram` (the directory compaction-engram.ts hands the collector, where the files
 *    actually are) and `<state>/metrics` (the collector's own default). Only date-named files.
 * `<state>` defaults to resolveStateDir(), the events writer's own resolution, and --db to
 * `<state>/logs/events.sqlite`. Both source writers hardcode `$HOME/.openclaw`, so on a host whose
 * state directory lives elsewhere, pass --algorithm-metrics and --engram-dir explicitly.
 *
 * THE SAME ROW AS THE LIVE BRIDGE. Every line goes through the builder the live dual-write uses
 * (algorithmOutcomeEvent, engramMetricEvent) and then through the REAL writer (emit.ts: catalog
 * lookup, undeclared-key and value checks, session hashing with the salt beside --db); only the
 * writer's worker is swapped for a recorder, and the insert goes through the writer core
 * (writer-worker.ts). Nothing here re-implements a writer rule, so an imported row cannot drift
 * from a live one. Imported rows carry boot_id BACKFILL_BOOT_ID.
 *
 * IDEMPOTENT. The dedup key is every column the builders fill — (name, ts_ms, session_hash,
 * label, n1, fields) — matched as a MULTISET against the rows already in the file, live and
 * backfilled alike: a line whose row exists is skipped, two identical lines need two rows, and a
 * second run inserts 0. Unlike the precedent's "only what predates the first live row" cut, this
 * also fills a hole in the live record (a batch the writer dropped, a gateway whose writer could
 * not start), because the key recognises the live row itself. Lines younger than
 * --settle-minutes are left for the next run: their live row may still sit in the gateway
 * writer's queue.
 *
 * --dry-run opens the database READ-ONLY and never creates, migrates or salts anything; it
 * reports what WOULD be inserted. Under a test runner the production database is refused outright
 * (the resolveLedgerPath precedent in src/infra/algorithm-metrics.ts).
 *
 * THE PARITY REPORT is the seven-day retirement check's input (logging.md §4.11): per event and
 * family (the algorithm, or the ENGRAM phase), every source line against every row, split live vs
 * backfilled; and, per complete UTC day over the last seven, source lines against LIVE rows only —
 * a backfill can never make the live bridge look complete. `--dry-run` is the read-only way to run
 * that check. Retiring the JSONL stays an owner decision; this script never does it.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { resolveStateDir } from "../src/config/paths.js";
import {
  ALGO_OUTCOME_EVENT,
  type AlgorithmLedgerRecord,
  algorithmOutcomeEvent,
} from "../src/infra/algorithm-metrics.js";
import { isVitestRuntimeEnv } from "../src/infra/env.js";
import {
  createEventWriter,
  type EmitEventRecord,
  type EventWireRow,
  type WriterWorkerRequest,
  type WriterWorkerResponse,
} from "../src/infra/events/emit.js";
import { EVENTS_SALT_BASENAME } from "../src/infra/events/paths.js";
import { openEventsDatabase } from "../src/infra/events/schema.js";
import { createWriterCore } from "../src/infra/events/writer-worker.js";
import { requireNodeSqlite } from "../src/infra/node-sqlite.js";
import { routeLogsToStderr } from "../src/logging/console.js";
import {
  ENGRAM_METRIC_EVENT,
  engramMetricEvent,
  type MetricEntry,
} from "../src/memory/engram/metrics.js";

/** boot_id of every imported row: the parity report's live/backfill split reads it. */
export const BACKFILL_BOOT_ID = "backfill:events-backfill";
/** A line younger than this is left for the next run: its live row may still be queued. */
export const DEFAULT_SETTLE_MS = 10 * 60_000;
/** logging.md §4.11: the JSONL retires once row counts per family match for seven days. */
export const RETIREMENT_WINDOW_DAYS = 7;

/** Records emitted between flushes — far under the writer's 20,000-record queue bound. */
const EMIT_CHUNK = 1_000;
/** Rows per insert transaction (the writer's own per-batch ceiling). */
const INSERT_CHUNK = 5_000;
const DAY_MS = 86_400_000;
const ENGRAM_DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export type BackfillEventName = typeof ALGO_OUTCOME_EVENT | typeof ENGRAM_METRIC_EVENT;

/** One source line the backfill can rebuild a row from. */
export interface SourceRecord {
  readonly name: BackfillEventName;
  /** The parity family: the algorithm, or the ENGRAM phase — the first half of the label. */
  readonly family: string;
  readonly tsMs: number;
  readonly event: EmitEventRecord;
}

export interface SourceScan {
  readonly files: number;
  /** Non-blank lines read. */
  readonly lines: number;
  /** Lines that are not JSON or not the store's record shape: counted, never guessed at. */
  readonly malformed: number;
  readonly records: SourceRecord[];
}

/** The columns the dedup key reads. */
export type DedupColumns = Pick<
  EventWireRow,
  "name" | "ts_ms" | "session_hash" | "label" | "n1" | "fields"
>;
/** A row as the backfill reads it back from the file. */
export type StoredRow = DedupColumns & Pick<EventWireRow, "boot_id">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readJsonLines(file: string): { lines: number; malformed: number; values: unknown[] } {
  let lines = 0;
  let malformed = 0;
  const values: unknown[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    lines += 1;
    try {
      values.push(JSON.parse(line));
    } catch {
      // A truncated tail is normal on an append-only file killed mid-write.
      malformed += 1;
    }
  }
  return { lines, malformed, values };
}

function asLedgerRecord(value: unknown): AlgorithmLedgerRecord | null {
  if (
    !isRecord(value) ||
    typeof value.v !== "number" ||
    !isTimestamp(value.ts) ||
    !isNonEmptyString(value.algorithm) ||
    typeof value.variant !== "string" ||
    !isNonEmptyString(value.outcome) ||
    !isRecord(value.metrics) ||
    !isRecord(value.provenance)
  ) {
    return null;
  }
  return value as unknown as AlgorithmLedgerRecord;
}

function asMetricEntry(value: unknown): MetricEntry | null {
  if (
    !isRecord(value) ||
    !isTimestamp(value.timestamp) ||
    !isNonEmptyString(value.phase) ||
    !isNonEmptyString(value.metric_name) ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value)
  ) {
    return null;
  }
  return value as unknown as MetricEntry;
}

/** algorithm-metrics.jsonl -> `algo.outcome` source records. A missing file is an empty source. */
export function scanAlgorithmLedger(file: string): SourceScan {
  if (!existsSync(file)) {
    return { files: 0, lines: 0, malformed: 0, records: [] };
  }
  const read = readJsonLines(file);
  let malformed = read.malformed;
  const records: SourceRecord[] = [];
  for (const value of read.values) {
    const record = asLedgerRecord(value);
    if (record === null) {
      malformed += 1;
      continue;
    }
    records.push({
      name: ALGO_OUTCOME_EVENT,
      family: record.algorithm,
      tsMs: Date.parse(record.ts),
      event: algorithmOutcomeEvent(record),
    });
  }
  return { files: 1, lines: read.lines, malformed, records };
}

/** The ENGRAM per-day files in `dirs` -> `engram.metric` source records. Missing dirs are empty. */
export function scanEngramMetrics(dirs: readonly string[]): SourceScan {
  let files = 0;
  let lines = 0;
  let malformed = 0;
  const records: SourceRecord[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved) || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
      continue;
    }
    seen.add(resolved);
    const dayFiles = readdirSync(resolved)
      .filter((name) => ENGRAM_DAY_FILE.test(name))
      .toSorted();
    for (const name of dayFiles) {
      files += 1;
      const read = readJsonLines(path.join(resolved, name));
      lines += read.lines;
      malformed += read.malformed;
      for (const value of read.values) {
        const entry = asMetricEntry(value);
        if (entry === null) {
          malformed += 1;
          continue;
        }
        records.push({
          name: ENGRAM_METRIC_EVENT,
          family: entry.phase,
          tsMs: Date.parse(entry.timestamp),
          event: engramMetricEvent(entry),
        });
      }
    }
  }
  return { files, lines, malformed, records };
}

type RecorderWorker = EventEmitter & {
  postMessage(request: WriterWorkerRequest): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
};

/** The writer's worker, swapped for a recorder: the backfill wants the checked rows, not a thread. */
function recordingWorker(sink: EventWireRow[]): Worker {
  const fake = new EventEmitter() as RecorderWorker;
  fake.ref = () => {};
  fake.unref = () => {};
  fake.terminate = () => Promise.resolve(0);
  fake.postMessage = (request) => {
    let response: WriterWorkerResponse;
    if (request.type === "insert") {
      for (const row of request.rows) {
        sink.push(row);
      }
      response = { id: request.id, ok: true, type: "insert", inserted: request.rows.length };
    } else {
      response = {
        id: request.id,
        ok: false,
        type: "error",
        message: "the backfill's recorder answers inserts only",
      };
    }
    setImmediate(() => fake.emit("message", response));
  };
  return fake as unknown as Worker;
}

export interface BuiltRows {
  readonly rows: EventWireRow[];
  /** The writer's own counters: anything non-zero is a row that differs from its line. */
  readonly dropped: number;
  readonly invalidValues: number;
  readonly undeclaredKeys: number;
}

/**
 * Source records -> `events` rows through the real writer (emit.ts). `saltDbPath` picks the salt:
 * the one beside it is read, or created exactly as the gateway's writer would create it.
 */
export async function buildBackfillRows(
  records: readonly SourceRecord[],
  saltDbPath: string,
): Promise<BuiltRows> {
  const rows: EventWireRow[] = [];
  const writer = createEventWriter({
    env: { OPENCLAW_EVENTS_DB_PATH: saltDbPath },
    spawn: () => recordingWorker(rows),
    flushIntervalMs: 3_600_000,
    statsIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    for (let start = 0; start < records.length; start += EMIT_CHUNK) {
      for (const record of records.slice(start, start + EMIT_CHUNK)) {
        writer.emit(record.name, record.event);
      }
      await writer.flush();
    }
  } finally {
    await writer.stop();
  }
  const stats = writer.stats();
  return {
    rows,
    dropped: stats.dropped,
    invalidValues: stats.invalidValues,
    undeclaredKeys: stats.undeclaredKeys,
  };
}

/**
 * The dedup key: every column the builders fill. The fields JSON compares byte for byte — a live
 * row and an imported row of one line come from the same builder and the same writer serializer.
 */
export function backfillDedupKey(row: DedupColumns): string {
  return JSON.stringify([row.name, row.ts_ms, row.session_hash, row.label, row.n1, row.fields]);
}

export interface BackfillPlan {
  /** Rows to insert, stamped with BACKFILL_BOOT_ID. */
  readonly toInsert: EventWireRow[];
  /** Candidates whose row the file already holds, live or backfilled. */
  readonly alreadyPresent: number;
}

/** Multiset difference: the candidates minus the rows the file already holds. */
export function planBackfill(
  candidates: readonly EventWireRow[],
  existing: readonly DedupColumns[],
): BackfillPlan {
  const remaining = new Map<string, number>();
  for (const row of existing) {
    const key = backfillDedupKey(row);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const toInsert: EventWireRow[] = [];
  let alreadyPresent = 0;
  for (const row of candidates) {
    const key = backfillDedupKey(row);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      alreadyPresent += 1;
    } else {
      toInsert.push({ ...row, boot_id: BACKFILL_BOOT_ID });
    }
  }
  return { toInsert, alreadyPresent };
}

export interface FamilyParity {
  jsonl: number;
  dbLive: number;
  dbBackfill: number;
}

export interface DayMismatch {
  readonly day: string;
  readonly name: string;
  readonly family: string;
  readonly jsonl: number;
  readonly dbLive: number;
}

export interface ParityReport {
  /** Per event name, per family: every source line against every row in the file. */
  readonly total: Record<string, Record<string, FamilyParity>>;
  /** The seven-day retirement input: per complete UTC day, source lines against LIVE rows only. */
  readonly retirement: {
    readonly days: string[];
    readonly jsonlRows: number;
    readonly liveRows: number;
    readonly mismatches: DayMismatch[];
    /** Every (day, event, family) agrees AND the live bridge wrote at least one row in the window. */
    readonly match: boolean;
  };
}

export interface ParitySource {
  readonly name: string;
  readonly family: string;
  readonly tsMs: number;
}

export type ParityRow = Pick<EventWireRow, "name" | "ts_ms" | "label" | "boot_id">;

/** `compaction/engram-pointer` -> `compaction`; a row whose label the writer refused is its own bucket. */
function familyOfLabel(label: string | null): string {
  if (label === null) {
    return "(no label)";
  }
  const slash = label.indexOf("/");
  return slash < 0 ? label : label.slice(0, slash);
}

function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function buildParityReport(
  sources: readonly ParitySource[],
  rows: readonly ParityRow[],
  nowMs: number,
): ParityReport {
  const total: Record<string, Record<string, FamilyParity>> = {};
  const totalCell = (name: string, family: string): FamilyParity => {
    const byFamily = (total[name] ??= {});
    return (byFamily[family] ??= { jsonl: 0, dbLive: 0, dbBackfill: 0 });
  };
  // The window is the last RETIREMENT_WINDOW_DAYS COMPLETE UTC days: today is still being written.
  const windowEnd = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const windowStart = windowEnd - RETIREMENT_WINDOW_DAYS * DAY_MS;
  const inWindow = (tsMs: number): boolean => tsMs >= windowStart && tsMs < windowEnd;
  const daily = new Map<
    string,
    { day: string; name: string; family: string; jsonl: number; dbLive: number }
  >();
  const dayCell = (tsMs: number, name: string, family: string) => {
    const day = utcDay(tsMs);
    const key = JSON.stringify([day, name, family]);
    let cell = daily.get(key);
    if (cell === undefined) {
      cell = { day, name, family, jsonl: 0, dbLive: 0 };
      daily.set(key, cell);
    }
    return cell;
  };
  let jsonlRows = 0;
  let liveRows = 0;
  for (const source of sources) {
    totalCell(source.name, source.family).jsonl += 1;
    if (inWindow(source.tsMs)) {
      dayCell(source.tsMs, source.name, source.family).jsonl += 1;
      jsonlRows += 1;
    }
  }
  for (const row of rows) {
    const family = familyOfLabel(row.label);
    const cell = totalCell(row.name, family);
    if (row.boot_id === BACKFILL_BOOT_ID) {
      // Imported history: counted in the totals, never as evidence that the live bridge works.
      cell.dbBackfill += 1;
      continue;
    }
    cell.dbLive += 1;
    if (inWindow(row.ts_ms)) {
      dayCell(row.ts_ms, row.name, family).dbLive += 1;
      liveRows += 1;
    }
  }
  const mismatches = [...daily.values()]
    .filter((cell) => cell.jsonl !== cell.dbLive)
    .toSorted(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.name.localeCompare(b.name) ||
        a.family.localeCompare(b.family),
    );
  return {
    total,
    retirement: {
      days: Array.from({ length: RETIREMENT_WINDOW_DAYS }, (_, i) =>
        utcDay(windowStart + i * DAY_MS),
      ),
      jsonlRows,
      liveRows,
      mismatches,
      match: mismatches.length === 0 && liveRows > 0,
    },
  };
}

function productionEventsDbPaths(env: NodeJS.ProcessEnv): Set<string> {
  const paths = new Set<string>();
  const add = (stateDir: () => string): void => {
    try {
      paths.add(path.resolve(stateDir(), "logs", "events.sqlite"));
    } catch {
      // An unresolvable home is covered by the other resolutions.
    }
  };
  add(() => resolveStateDir(env));
  add(() => path.join(os.homedir(), ".openclaw"));
  // A test run may point HOME and OPENCLAW_STATE_DIR at a sandbox; the account's real home (the
  // passwd entry, not $HOME) still names the file the gateway writes.
  add(() => path.join(os.userInfo().homedir, ".openclaw"));
  return paths;
}

/**
 * Throws when `dbPath` is the production events database and this process runs under a test
 * runner (isVitestRuntimeEnv, the canonical detector events/paths.ts uses): a test is sandboxed by
 * construction, never by remembering to pass a temp path.
 */
export function assertBackfillTargetAllowed(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isVitestRuntimeEnv(env) && productionEventsDbPaths(env).has(path.resolve(dbPath))) {
    throw new Error(
      `events-backfill: refusing the production events database under a test runner: ${dbPath}`,
    );
  }
}

const SELECT_ROWS_SQL =
  "SELECT name, ts_ms, session_hash, label, n1, fields, boot_id FROM events WHERE name IN (?, ?)";

function readStoredRows(db: DatabaseSync): StoredRow[] {
  return db
    .prepare(SELECT_ROWS_SQL)
    .all(ALGO_OUTCOME_EVENT, ENGRAM_METRIC_EVENT) as unknown as StoredRow[];
}

/** Dry run: the file as it is, read-only; a missing file, or one with no `events` table, is empty. */
function readStoredRowsReadOnly(dbPath: string): StoredRow[] {
  if (!existsSync(dbPath)) {
    return [];
  }
  const { DatabaseSync: Database } = requireNodeSqlite();
  const db = new Database(dbPath, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .get();
    return table === undefined ? [] : readStoredRows(db);
  } finally {
    db.close();
  }
}

export interface BackfillOptions {
  readonly dbPath: string;
  readonly algorithmMetricsPath: string;
  readonly engramDirs: readonly string[];
  readonly dryRun: boolean;
  readonly settleMs?: number;
  readonly nowMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SourceSummary {
  readonly files: number;
  readonly lines: number;
  readonly malformed: number;
  readonly records: number;
}

export interface BackfillReport {
  readonly db: string;
  readonly dryRun: boolean;
  readonly sources: {
    readonly algorithmMetrics: SourceSummary & { readonly path: string };
    readonly engram: SourceSummary & { readonly dirs: readonly string[] };
  };
  /** Lines younger than the settle window, left for the next run. */
  readonly deferredRecent: number;
  readonly alreadyPresent: number;
  /** Rows this run wrote; in a dry run, the rows it WOULD write. */
  readonly inserted: number;
  readonly insertedByName: Readonly<Record<string, number>>;
  /** `algo.outcome` + `engram.metric` rows in the file; in a dry run `after` is projected. */
  readonly rowsInFile: { readonly before: number; readonly after: number };
  readonly writer: {
    readonly dropped: number;
    readonly invalidValues: number;
    readonly undeclaredKeys: number;
  };
  /** Read back from the file after the insert; in a dry run, projected with the would-be rows. */
  readonly parity: ParityReport;
}

function summarize(scan: SourceScan): SourceSummary {
  return {
    files: scan.files,
    lines: scan.lines,
    malformed: scan.malformed,
    records: scan.records.length,
  };
}

function countByName(rows: readonly EventWireRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.name] = (counts[row.name] ?? 0) + 1;
  }
  return counts;
}

export async function runEventsBackfill(options: BackfillOptions): Promise<BackfillReport> {
  assertBackfillTargetAllowed(options.dbPath, options.env ?? process.env);
  const nowMs = options.nowMs ?? Date.now();
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const algo = scanAlgorithmLedger(options.algorithmMetricsPath);
  const engram = scanEngramMetrics(options.engramDirs);
  const sources = [...algo.records, ...engram.records];
  const settled = sources.filter((source) => source.tsMs <= nowMs - settleMs);

  // Session keys are hashed with the salt beside the target file, read exactly as the gateway's
  // writer reads it, so an imported row's session_hash equals the live row's. A dry run creates
  // nothing: when that salt does not exist yet it draws a throwaway one — and then no live row can
  // carry a hash from the real salt either.
  const saltExists = existsSync(path.join(path.dirname(options.dbPath), EVENTS_SALT_BASENAME));
  const scratch =
    options.dryRun && !saltExists ? mkdtempSync(path.join(os.tmpdir(), "events-backfill-")) : null;
  try {
    const built = await buildBackfillRows(
      settled,
      scratch === null ? options.dbPath : path.join(scratch, "events.sqlite"),
    );
    const common = {
      db: options.dbPath,
      dryRun: options.dryRun,
      sources: {
        algorithmMetrics: { path: options.algorithmMetricsPath, ...summarize(algo) },
        engram: { dirs: [...options.engramDirs], ...summarize(engram) },
      },
      deferredRecent: sources.length - settled.length,
      writer: {
        dropped: built.dropped,
        invalidValues: built.invalidValues,
        undeclaredKeys: built.undeclaredKeys,
      },
    };
    if (options.dryRun) {
      const existing = readStoredRowsReadOnly(options.dbPath);
      const plan = planBackfill(built.rows, existing);
      const projected = [...existing, ...plan.toInsert];
      return {
        ...common,
        alreadyPresent: plan.alreadyPresent,
        inserted: plan.toInsert.length,
        insertedByName: countByName(plan.toInsert),
        rowsInFile: { before: existing.length, after: projected.length },
        parity: buildParityReport(sources, projected, nowMs),
      };
    }
    const handle = openEventsDatabase(options.dbPath);
    try {
      const existing = readStoredRows(handle.db);
      const plan = planBackfill(built.rows, existing);
      // The writer core owns the INSERT and the one-transaction-per-batch rule (§7.5). saltId
      // "unavailable" leaves meta.salt_id to the gateway's writer, which owns it (§7.3).
      const core = createWriterCore(handle, { saltId: "unavailable", bootId: BACKFILL_BOOT_ID });
      let inserted = 0;
      for (let start = 0; start < plan.toInsert.length; start += INSERT_CHUNK) {
        inserted += core.insert(plan.toInsert.slice(start, start + INSERT_CHUNK));
      }
      // Parity is read back from the file, not from the plan: the artefact is the evidence.
      const after = readStoredRows(handle.db);
      return {
        ...common,
        alreadyPresent: plan.alreadyPresent,
        inserted,
        insertedByName: countByName(plan.toInsert),
        rowsInFile: { before: existing.length, after: after.length },
        parity: buildParityReport(sources, after, nowMs),
      };
    } finally {
      handle.close();
    }
  } finally {
    if (scratch !== null) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argValues(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === `--${name}`) {
      values.push(process.argv[i + 1] as string);
    }
  }
  return values;
}

function expandHome(value: string): string {
  return path.resolve(value.replace(/^~(?=$|\/)/, os.homedir()));
}

async function main(): Promise<void> {
  // The report is the only thing on stdout: writer and logger lines go to stderr.
  routeLogsToStderr();
  const stateArg = argValue("state-dir");
  const stateDir = stateArg === undefined ? resolveStateDir(process.env) : expandHome(stateArg);
  const dbArg = argValue("db");
  const algoArg = argValue("algorithm-metrics");
  const engramDirs = argValues("engram-dir").map(expandHome);
  const settleMinutes = Number(argValue("settle-minutes") ?? DEFAULT_SETTLE_MS / 60_000);
  const report = await runEventsBackfill({
    dbPath: dbArg === undefined ? path.join(stateDir, "logs", "events.sqlite") : expandHome(dbArg),
    algorithmMetricsPath:
      algoArg === undefined
        ? path.join(stateDir, "data", "algorithm-metrics.jsonl")
        : expandHome(algoArg),
    engramDirs:
      engramDirs.length > 0
        ? engramDirs
        : [path.join(stateDir, "engram"), path.join(stateDir, "metrics")],
    dryRun: process.argv.includes("--dry-run"),
    settleMs:
      Number.isFinite(settleMinutes) && settleMinutes >= 0
        ? settleMinutes * 60_000
        : DEFAULT_SETTLE_MS,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
