/**
 * The events database schema — TINKER_UI_DESIGN_BIBLE/logging.md §7.2–§7.3 (§9 step 2).
 *
 * Owns every statement that shapes the events database: the connection pragmas, the forward-only
 * numbered migrations recorded in `meta.schema_version`, the in-file mirror of the catalog (the
 * `catalog` table) and one VIEW per catalog row, generated from catalog.ts so that a view cannot
 * disagree with the catalog. It shapes the file and never writes an event: the writer (§7.5, §9
 * step 3) and the short-lived script emitters open the file through `openEventsDatabase`, so every
 * process agrees on one shape. Resolving the path is step 3's too; this module takes it explicitly.
 *
 * Driver (§7.2): `node:sqlite` through `requireNodeSqlite`, WAL through
 * `configureSqliteWalMaintenance`, as the LLM ledger and the task registry do. No native addon.
 *
 * Two ordering rules (schema.test.ts and logging.md's verify gate pin the first):
 *  - `PRAGMA auto_vacuum = INCREMENTAL` runs before `journal_mode = WAL`, not merely before the
 *    first CREATE TABLE. The WAL switch writes page 1, after which the pragma is a silent no-op
 *    (measured on SQLite 3.51.3, 2026-09-24) and §7.4's `incremental_vacuum` would reclaim nothing
 *    for the life of the file. `openEventsDatabase` sets it first; `migrateEventsSchema` repairs an
 *    empty file that another caller opened the other way round.
 *  - Every DDL statement lives in a numbered migration, never in an unconditional boot exec
 *    (failures.md M12), and the generated views are dropped before any migration runs and rebuilt
 *    after it, so a migration never trips over a view that reads what it changes.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../node-sqlite.js";
import {
  configureSqliteWalMaintenance,
  type SqliteWalMaintenance,
  type SqliteWalMaintenanceOptions,
} from "../sqlite-wal.js";
import { type CatalogEvent, EVENT_CATALOG } from "./catalog.js";

/** One rung of the ladder. `up` runs inside the ladder's single transaction and never commits. */
export interface EventsMigration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: DatabaseSync, context: { readonly nowMs: number }) => void;
}

/**
 * logging.md §7.3, version 1. Plain CREATE, not IF NOT EXISTS: this runs once, on a version-0
 * file, and a version-0 file that already holds one of these tables is not ours — adopting its
 * shape silently would be worse than failing the open. `catalog` carries `dur_means` and
 * `field_types` beside the label and n1..n4 meanings, so the file alone says what `dur_ms` and
 * every `fields` key of a row mean. schema.test.ts holds this equal to §7.3's block, comments aside.
 */
export const EVENTS_SCHEMA_V1_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE catalog (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  retention TEXT NOT NULL,
  paper TEXT,
  question TEXT NOT NULL,
  label_means TEXT,
  dur_means TEXT,
  n1_means TEXT, n2_means TEXT, n3_means TEXT, n4_means TEXT,
  field_types TEXT NOT NULL,
  version INTEGER NOT NULL
) STRICT;

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  session_hash TEXT,
  session_kind TEXT,
  run_id TEXT,
  worker_id TEXT,
  label TEXT,
  dur_ms REAL,
  n1 REAL, n2 REAL, n3 REAL, n4 REAL,
  fields TEXT
) STRICT;

CREATE INDEX events_name_ts ON events (name, ts_ms);
CREATE INDEX events_name_label_ts ON events (name, label, ts_ms);
CREATE INDEX events_session_ts ON events (session_hash, ts_ms) WHERE session_hash IS NOT NULL;
CREATE INDEX events_run ON events (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX events_worker_ts ON events (worker_id, ts_ms) WHERE worker_id IS NOT NULL;

CREATE TABLE rollup_1h (
  hour_ms INTEGER NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  worker_id TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL,
  dur_sum REAL, dur_max REAL, dur_p99 REAL,
  n1_avg REAL, n1_max REAL, n2_avg REAL, n2_max REAL,
  n3_avg REAL, n3_max REAL, n4_avg REAL, n4_max REAL,
  PRIMARY KEY (hour_ms, name, label, worker_id)
) STRICT;
`;

/**
 * The forward-only ladder, numbered 1..N. Change the shape by appending a rung; never edit or
 * remove a shipped one — a file at version N has already run it.
 */
export const EVENTS_MIGRATIONS: readonly EventsMigration[] = [
  {
    version: 1,
    description: "logging.md §7.3 version 1: meta, catalog, events and its indexes, rollup_1h",
    up: (db, { nowMs }) => {
      db.exec(EVENTS_SCHEMA_V1_SQL);
      setMeta(db, "created_at_ms", String(nowMs));
    },
  },
];

/** The version this build brings a file to: the ladder's last rung. */
export const EVENTS_SCHEMA_VERSION: number =
  EVENTS_MIGRATIONS[EVENTS_MIGRATIONS.length - 1].version;

/** The columns every generated view leads with: the row, its clock and the correlation ids (§4). */
export const VIEW_BASE_COLUMNS = [
  "id",
  "ts_ms",
  "boot_id",
  "session_hash",
  "session_kind",
  "run_id",
  "worker_id",
] as const;

const N_SLOTS = ["n1", "n2", "n3", "n4"] as const;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
/** `PRAGMA auto_vacuum` reads 2 for INCREMENTAL. */
const AUTO_VACUUM_INCREMENTAL = 2;

/** `worker.sample` → `v_worker_sample` (§7.3). */
export function eventViewName(name: string): string {
  return `v_${name.replaceAll(".", "_")}`;
}

/**
 * The column a catalog meaning names in its event's view (§7.3). One rule, in order:
 *  1. a parenthetical lists the values a label takes, never its name: `outcome (hit, miss)` → outcome;
 *  2. a snake_case identifier followed by prose names itself and keeps its unit (L1):
 *     `cpu_ms since the last sample` → cpu_ms;
 *  3. any other phrase becomes one snake_case name: `tool name` → tool_name, `hook:plugin` →
 *     hook_plugin, `algorithm/variant` → algorithm_variant.
 * Returns "" when nothing identifier-shaped survives; the view then keeps the raw slot name.
 */
export function viewColumnName(meaning: string): string {
  const head = meaning.split(" (")[0].trim().toLowerCase();
  const first = head.split(/\s+/)[0];
  if (first !== head && first.includes("_") && IDENTIFIER.test(first)) {
    return first;
  }
  const slug = head
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return IDENTIFIER.test(slug) ? slug : "";
}

/** One column of a generated view: its name and the expression over `events` that fills it. */
export interface EventViewColumn {
  readonly column: string;
  readonly expr: string;
}

/**
 * A catalog row's view columns, in order: the base columns, the label, `dur_ms` when the row gives
 * it a meaning, each used n slot, then one column per declared `fields` key. An unused slot has no
 * column. `dur_ms` keeps its name: its meanings are prose ("hold", "save") and the unit belongs in
 * the name (L1). A derived name that would collide with a base column, a raw slot, a field key or
 * an earlier slot falls back to the raw slot name, so a view always builds; schema.test.ts fails if
 * any real catalog row needs that fallback, so a colliding meaning is renamed rather than shipped.
 */
export function eventViewColumns(event: CatalogEvent): EventViewColumn[] {
  const fieldKeys = Object.keys(event.fields);
  const taken = new Set<string>([
    ...VIEW_BASE_COLUMNS,
    "dur_ms",
    "label",
    ...N_SLOTS,
    ...fieldKeys,
  ]);
  const columns: EventViewColumn[] = VIEW_BASE_COLUMNS.map((name) => ({
    column: name,
    expr: name,
  }));
  const addSlot = (slot: string, meaning: string | null): void => {
    if (meaning === null) {
      return;
    }
    const derived = viewColumnName(meaning);
    const column = derived !== "" && !taken.has(derived) ? derived : slot;
    taken.add(column);
    columns.push({ column, expr: slot });
  };
  addSlot("label", event.label);
  if (event.durMs !== null) {
    columns.push({ column: "dur_ms", expr: "dur_ms" });
  }
  for (const slot of N_SLOTS) {
    addSlot(slot, event[slot]);
  }
  for (const key of fieldKeys) {
    columns.push({ column: key, expr: `json_extract(fields, '$.${key}')` });
  }
  return columns;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The CREATE VIEW for one catalog row; logging.md §7.3 prints the one for `worker.sample`, and
 * schema.test.ts holds the two equal. Aliases are quoted: some meanings and field keys are SQL
 * keywords (`drop`, `from`).
 */
export function eventViewSql(event: CatalogEvent): string {
  const select = eventViewColumns(event)
    .map(({ column, expr }) => (column === expr ? column : `${expr} AS ${quoteIdentifier(column)}`))
    .join(",\n       ");
  return (
    `CREATE VIEW ${quoteIdentifier(eventViewName(event.name))} AS\n` +
    `SELECT ${select}\n` +
    "FROM events\n" +
    `WHERE name = ${sqlString(event.name)};`
  );
}

interface GeneratedView {
  readonly view: string;
  readonly sql: string;
}

/** Every catalog row's view, checked first: unique view names, identifier-shaped columns. */
function generateEventViews(catalog: readonly CatalogEvent[]): GeneratedView[] {
  const owners = new Map<string, string>();
  return catalog.map((event) => {
    const view = eventViewName(event.name);
    const owner = owners.get(view);
    if (owner !== undefined) {
      throw new Error(
        `events schema: \`${owner}\` and \`${event.name}\` both map to view ${view}; ` +
          "rename one in logging.md §4 and catalog.ts",
      );
    }
    owners.set(view, event.name);
    // The SQL is built from these names, so each must be a bare identifier.
    for (const name of [view, ...eventViewColumns(event).map(({ column }) => column)]) {
      if (!IDENTIFIER.test(name)) {
        throw new Error(`events schema: \`${event.name}\` yields "${name}", not an identifier`);
      }
    }
    return { view, sql: eventViewSql(event) };
  });
}

/** A `catalog` table row without its revision; the keys are the columns and the bind names. */
type CatalogTableRow = {
  readonly name: string;
  readonly kind: string;
  readonly retention: string;
  readonly paper: string | null;
  readonly question: string;
  readonly label_means: string | null;
  readonly dur_means: string | null;
  readonly n1_means: string | null;
  readonly n2_means: string | null;
  readonly n3_means: string | null;
  readonly n4_means: string | null;
  readonly field_types: string;
};

const CATALOG_DEFINITION_COLUMNS = [
  "kind",
  "retention",
  "paper",
  "question",
  "label_means",
  "dur_means",
  "n1_means",
  "n2_means",
  "n3_means",
  "n4_means",
  "field_types",
] as const;

function catalogTableRow(event: CatalogEvent): CatalogTableRow {
  return {
    name: event.name,
    kind: event.kind,
    retention: event.retention,
    paper: event.paper,
    question: event.question,
    label_means: event.label,
    dur_means: event.durMs,
    n1_means: event.n1,
    n2_means: event.n2,
    n3_means: event.n3,
    n4_means: event.n4,
    field_types: JSON.stringify(event.fields),
  };
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  if (!tableExists(db, "meta")) {
    return undefined;
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * The rung a file stands on: 0 for a file with no meta table (a new file). A value it cannot read
 * is thrown, never guessed at.
 */
export function readEventsSchemaVersion(db: DatabaseSync): number {
  const raw = readMeta(db, "schema_version");
  if (raw === undefined) {
    return 0;
  }
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `events schema: meta.schema_version is ${JSON.stringify(raw)}, not a positive integer; ` +
        "refusing to guess the file's shape",
    );
  }
  return version;
}

/** The ladder is numbered 1..N; returns N. */
function assertLadder(migrations: readonly EventsMigration[]): number {
  if (migrations.length === 0) {
    throw new Error("events schema: the migration ladder is empty");
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `events schema: rung ${index + 1} of the migration ladder declares version ` +
          `${migration.version}; the ladder is numbered 1..N with no gap and no reorder`,
      );
    }
  });
  return migrations.length;
}

function refuseNewer(version: number, target: number): void {
  if (version > target) {
    throw new Error(
      `events schema: the file is at version ${version}, newer than this build's ${target}; ` +
        "migrations are forward-only, so it is left untouched",
    );
  }
}

/** See the header: a WAL switch before the pragma leaves an empty file at NONE. */
function repairAutoVacuumOnEmptyFile(db: DatabaseSync): void {
  const { auto_vacuum: mode } = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
  if (mode === AUTO_VACUUM_INCREMENTAL) {
    return;
  }
  const anyTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table'").get();
  if (anyTable !== undefined) {
    // Not a new file: rung 1's plain CREATE TABLE refuses it loudly.
    return;
  }
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  // The only way to change the mode once the file has a header; instant on an empty file.
  db.exec("VACUUM;");
}

/**
 * Drops the views this module generated: those named after a row of the in-file catalog mirror
 * (the catalog installed last time) or of the catalog being installed now. A view a migration
 * makes under any other name is not the generator's and is left alone.
 */
function dropGeneratedViews(db: DatabaseSync, views: readonly GeneratedView[]): void {
  const owned = new Set(views.map(({ view }) => view));
  if (tableExists(db, "catalog")) {
    const previous = db.prepare("SELECT name FROM catalog").all() as Array<{ name: string }>;
    for (const { name } of previous) {
      owned.add(eventViewName(name));
    }
  }
  const present = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as Array<{
    name: string;
  }>;
  for (const { name } of present) {
    if (owned.has(name)) {
      db.exec(`DROP VIEW ${quoteIdentifier(name)};`);
    }
  }
}

/**
 * Mirrors the catalog into the `catalog` table. `version` is the row's revision: 1 when the row
 * first appears, +1 each time any of its definition columns changes, so a reader can tell that a
 * meaning moved under rows already written. A row gone from the catalog leaves the table (its
 * events stay in `events`), so §8.1's J-coverage query never lists a retired event as silent.
 */
function syncCatalogTable(db: DatabaseSync, rows: readonly CatalogTableRow[]): void {
  const stored = new Map<string, CatalogTableRow & { version: number }>();
  const existing = db
    .prepare(
      "SELECT name, kind, retention, paper, question, label_means, dur_means, " +
        "n1_means, n2_means, n3_means, n4_means, field_types, version FROM catalog",
    )
    .all() as Array<CatalogTableRow & { version: number }>;
  for (const row of existing) {
    stored.set(row.name, row);
  }
  const insert = db.prepare(
    "INSERT INTO catalog (name, kind, retention, paper, question, label_means, dur_means, " +
      "n1_means, n2_means, n3_means, n4_means, field_types, version) VALUES (@name, @kind, " +
      "@retention, @paper, @question, @label_means, @dur_means, @n1_means, @n2_means, " +
      "@n3_means, @n4_means, @field_types, @version)",
  );
  const update = db.prepare(
    "UPDATE catalog SET kind = @kind, retention = @retention, paper = @paper, " +
      "question = @question, label_means = @label_means, dur_means = @dur_means, " +
      "n1_means = @n1_means, n2_means = @n2_means, n3_means = @n3_means, " +
      "n4_means = @n4_means, field_types = @field_types, version = @version WHERE name = @name",
  );
  const remove = db.prepare("DELETE FROM catalog WHERE name = ?");
  const declared = new Set<string>();
  for (const row of rows) {
    declared.add(row.name);
    const previous = stored.get(row.name);
    if (previous === undefined) {
      insert.run({ ...row, version: 1 });
    } else if (CATALOG_DEFINITION_COLUMNS.some((column) => previous[column] !== row[column])) {
      update.run({ ...row, version: previous.version + 1 });
    }
  }
  for (const name of stored.keys()) {
    if (!declared.has(name)) {
      remove.run(name);
    }
  }
}

export interface MigrateEventsSchemaOptions {
  /** The catalog to mirror and generate views from. Tests pass a doctored copy; production never does. */
  readonly catalog?: readonly CatalogEvent[];
  /** The ladder. Tests pass a doctored one; production never does. */
  readonly migrations?: readonly EventsMigration[];
  /** The clock for `meta.created_at_ms`; defaults to now. */
  readonly nowMs?: number;
}

export interface EventsMigrationResult {
  /** The rung the file stood on; 0 for a new file. */
  readonly fromVersion: number;
  readonly toVersion: number;
  /** The rungs this call ran, in order; empty when the file was already current. */
  readonly applied: readonly number[];
  /** Whether the views and the catalog mirror were rebuilt: a rung ran, or the catalog changed. */
  readonly viewsRegenerated: boolean;
  /** Generated views in the file after this call: one per catalog row. */
  readonly views: number;
}

/**
 * Brings an open connection to this build's schema: the pending rungs, the catalog mirror and the
 * generated views, all in ONE `BEGIN IMMEDIATE` transaction that re-reads the version under the
 * write lock. Two processes opening a new file at once run the ladder once, and a rung that throws
 * leaves the file exactly as it was. The views and the mirror are rebuilt only when a rung ran or
 * `meta.catalog_fingerprint` (a hash of both) differs from this build's, so reopening a current
 * file writes nothing and takes no write lock.
 */
export function migrateEventsSchema(
  db: DatabaseSync,
  options: MigrateEventsSchemaOptions = {},
): EventsMigrationResult {
  const migrations = options.migrations ?? EVENTS_MIGRATIONS;
  const target = assertLadder(migrations);
  const catalog = options.catalog ?? EVENT_CATALOG;
  const views = generateEventViews(catalog);
  const rows = catalog.map(catalogTableRow);
  const fingerprint = createHash("sha256").update(JSON.stringify({ rows, views })).digest("hex");

  const seen = readEventsSchemaVersion(db);
  refuseNewer(seen, target);
  if (seen === target && readMeta(db, "catalog_fingerprint") === fingerprint) {
    return {
      fromVersion: seen,
      toVersion: target,
      applied: [],
      viewsRegenerated: false,
      views: views.length,
    };
  }
  if (seen === 0) {
    repairAutoVacuumOnEmptyFile(db);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the write lock: another process may have migrated since the read above.
    const from = readEventsSchemaVersion(db);
    refuseNewer(from, target);
    const pending = migrations.filter((migration) => migration.version > from);
    const regenerate = pending.length > 0 || readMeta(db, "catalog_fingerprint") !== fingerprint;
    if (regenerate) {
      dropGeneratedViews(db, views);
      const nowMs = options.nowMs ?? Date.now();
      for (const migration of pending) {
        migration.up(db, { nowMs });
        setMeta(db, "schema_version", String(migration.version));
      }
      syncCatalogTable(db, rows);
      for (const { sql } of views) {
        db.exec(sql);
      }
      setMeta(db, "catalog_fingerprint", fingerprint);
    }
    db.exec("COMMIT");
    return {
      fromVersion: from,
      toVersion: target,
      applied: pending.map((migration) => migration.version),
      viewsRegenerated: regenerate,
      views: views.length,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Some failures (a full disk, an I/O error) end the transaction themselves; the original
      // error is the one to report.
    }
    throw error;
  }
}

export interface OpenEventsDatabaseOptions extends MigrateEventsSchemaOptions {
  /** Passed to configureSqliteWalMaintenance; tests pass `{ checkpointIntervalMs: 0 }`. */
  readonly walMaintenance?: SqliteWalMaintenanceOptions;
}

export interface EventsDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly migration: EventsMigrationResult;
  /** The WAL helper; the writer's maintenance pass (§7.4) runs its TRUNCATE checkpoint. */
  readonly walMaintenance: SqliteWalMaintenance;
  /** Stops the periodic checkpoint, runs a final one and closes the connection. */
  readonly close: () => void;
}

/**
 * The one way to open the events database — the writer thread and the script emitters alike
 * (§7.5). `path` is explicit: resolving `<state>/logs/events.sqlite` and refusing it under a test
 * runner is step 3's paths.ts. The pragma order below is load-bearing (see the header).
 */
export function openEventsDatabase(
  path: string,
  options: OpenEventsDatabaseOptions = {},
): EventsDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path);
  let walMaintenance: SqliteWalMaintenance | null = null;
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    // Before the WAL switch, not merely before the first table: the switch writes page 1.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    walMaintenance = configureSqliteWalMaintenance(db, options.walMaintenance);
    db.exec("PRAGMA synchronous = NORMAL;");
    const migration = migrateEventsSchema(db, options);
    const maintenance = walMaintenance;
    return {
      db,
      path,
      migration,
      walMaintenance: maintenance,
      close: () => {
        maintenance.close();
        db.close();
      },
    };
  } catch (error) {
    if (walMaintenance !== null) {
      walMaintenance.close();
    }
    db.close();
    throw error;
  }
}
