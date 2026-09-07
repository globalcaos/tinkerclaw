import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { describeArchivedStateTwin, guardArchivedStateFile } from "./state-file-guard.js";
import {
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistrySqlitePath,
} from "./task-flow-registry.paths.js";
import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord, TaskFlowSyncMode, JsonValue } from "./task-flow-registry.types.js";

type FlowRegistryRow = {
  flow_id: string;
  sync_mode: TaskFlowSyncMode | null;
  shape?: string | null;
  owner_key: string;
  requester_origin_json: string | null;
  controller_id: string | null;
  revision: number | bigint | null;
  status: TaskFlowRecord["status"];
  notify_policy: TaskFlowRecord["notifyPolicy"];
  goal: string;
  current_step: string | null;
  blocked_task_id: string | null;
  blocked_summary: string | null;
  state_json: string | null;
  wait_json: string | null;
  cancel_requested_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  ended_at: number | bigint | null;
};

type FlowRegistryStatements = {
  selectAll: StatementSync;
  upsertRow: StatementSync;
  deleteRow: StatementSync;
  clearRows: StatementSync;
};

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
  statements: FlowRegistryStatements;
  walMaintenance: SqliteWalMaintenance;
};

let cachedDatabase: FlowRegistryDatabase | null = null;
const FLOW_REGISTRY_DIR_MODE = 0o700;
const FLOW_REGISTRY_FILE_MODE = 0o600;
const FLOW_REGISTRY_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Persisted JSON columns are typed by the receiving field.
function parseJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToSyncMode(row: FlowRegistryRow): TaskFlowSyncMode {
  if (row.sync_mode === "task_mirrored" || row.sync_mode === "managed") {
    return row.sync_mode;
  }
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

function rowToFlowRecord(row: FlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeNumber(row.ended_at);
  const cancelRequestedAt = normalizeNumber(row.cancel_requested_at);
  const requesterOrigin = parseJsonValue<DeliveryContext>(row.requester_origin_json);
  const stateJson = parseJsonValue<JsonValue>(row.state_json);
  const waitJson = parseJsonValue<JsonValue>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeNumber(row.revision) ?? 0,
    status: row.status,
    notifyPolicy: row.notify_policy,
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeNumber(row.created_at) ?? 0,
    updatedAt: normalizeNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

function bindFlowRecord(record: TaskFlowRecord) {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    owner_key: record.ownerKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: serializeJson(record.stateJson),
    wait_json: serializeJson(record.waitJson),
    cancel_requested_at: record.cancelRequestedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  };
}

function createStatements(db: DatabaseSync): FlowRegistryStatements {
  return {
    selectAll: db.prepare(`
      SELECT
        flow_id,
        sync_mode,
        shape,
        owner_key,
        requester_origin_json,
        controller_id,
        revision,
        status,
        notify_policy,
        goal,
        current_step,
        blocked_task_id,
        blocked_summary,
        state_json,
        wait_json,
        cancel_requested_at,
        created_at,
        updated_at,
        ended_at
      FROM flow_runs
      ORDER BY created_at ASC, flow_id ASC
    `),
    upsertRow: db.prepare(`
      INSERT INTO flow_runs (
        flow_id,
        sync_mode,
        owner_key,
        requester_origin_json,
        controller_id,
        revision,
        status,
        notify_policy,
        goal,
        current_step,
        blocked_task_id,
        blocked_summary,
        state_json,
        wait_json,
        cancel_requested_at,
        created_at,
        updated_at,
        ended_at
      ) VALUES (
        @flow_id,
        @sync_mode,
        @owner_key,
        @requester_origin_json,
        @controller_id,
        @revision,
        @status,
        @notify_policy,
        @goal,
        @current_step,
        @blocked_task_id,
        @blocked_summary,
        @state_json,
        @wait_json,
        @cancel_requested_at,
        @created_at,
        @updated_at,
        @ended_at
      )
      ON CONFLICT(flow_id) DO UPDATE SET
        sync_mode = excluded.sync_mode,
        owner_key = excluded.owner_key,
        requester_origin_json = excluded.requester_origin_json,
        controller_id = excluded.controller_id,
        revision = excluded.revision,
        status = excluded.status,
        notify_policy = excluded.notify_policy,
        goal = excluded.goal,
        current_step = excluded.current_step,
        blocked_task_id = excluded.blocked_task_id,
        blocked_summary = excluded.blocked_summary,
        state_json = excluded.state_json,
        wait_json = excluded.wait_json,
        cancel_requested_at = excluded.cancel_requested_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at
    `),
    deleteRow: db.prepare(`DELETE FROM flow_runs WHERE flow_id = ?`),
    clearRows: db.prepare(`DELETE FROM flow_runs`),
  };
}

type FlowRunsColumn = { name: string; ddl: string };
type FlowRunsIndex = { name: string; columns: string };

// Single source of truth for the flow_runs shape. The fresh-install DDL, the
// legacy-rebuild target table and the rebuild's INSERT column list all read from
// here, so they can never drift apart the way they did for owner_session_key.
const FLOW_RUNS_COLUMNS: readonly FlowRunsColumn[] = [
  { name: "flow_id", ddl: "flow_id TEXT PRIMARY KEY" },
  { name: "shape", ddl: "shape TEXT" },
  { name: "sync_mode", ddl: "sync_mode TEXT NOT NULL DEFAULT 'managed'" },
  { name: "owner_key", ddl: "owner_key TEXT NOT NULL" },
  { name: "requester_origin_json", ddl: "requester_origin_json TEXT" },
  { name: "controller_id", ddl: "controller_id TEXT" },
  { name: "revision", ddl: "revision INTEGER NOT NULL DEFAULT 0" },
  { name: "status", ddl: "status TEXT NOT NULL" },
  { name: "notify_policy", ddl: "notify_policy TEXT NOT NULL" },
  { name: "goal", ddl: "goal TEXT NOT NULL" },
  { name: "current_step", ddl: "current_step TEXT" },
  { name: "blocked_task_id", ddl: "blocked_task_id TEXT" },
  { name: "blocked_summary", ddl: "blocked_summary TEXT" },
  { name: "state_json", ddl: "state_json TEXT" },
  { name: "wait_json", ddl: "wait_json TEXT" },
  { name: "cancel_requested_at", ddl: "cancel_requested_at INTEGER" },
  { name: "created_at", ddl: "created_at INTEGER NOT NULL" },
  { name: "updated_at", ddl: "updated_at INTEGER NOT NULL" },
  { name: "ended_at", ddl: "ended_at INTEGER" },
];

const FLOW_RUNS_INDEXES: readonly FlowRunsIndex[] = [
  { name: "idx_flow_runs_status", columns: "status" },
  { name: "idx_flow_runs_owner_key", columns: "owner_key" },
  { name: "idx_flow_runs_updated_at", columns: "updated_at" },
];

// Replaced by owner_key. Still present — and still NOT NULL — on every database
// created before the rename, while nothing has written it since.
const LEGACY_OWNER_COLUMN = "owner_session_key";
const FLOW_RUNS_REBUILD_TABLE = "flow_runs_schema_rebuild";

function createFlowRunsTableSql(tableName: string, options?: { ifNotExists?: boolean }): string {
  const columns = FLOW_RUNS_COLUMNS.map((column) => `      ${column.ddl}`).join(",\n");
  return `
    CREATE TABLE ${options?.ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
${columns}
    );
  `;
}

function listFlowRunsColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(flow_runs)`).all() as Array<{ name?: string }>;
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") {
      names.add(row.name);
    }
  }
  return names;
}

function hasFlowRunsColumn(db: DatabaseSync, columnName: string): boolean {
  return listFlowRunsColumns(db).has(columnName);
}

function ensureFlowRunsIndexes(db: DatabaseSync) {
  for (const index of FLOW_RUNS_INDEXES) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${index.name} ON flow_runs(${index.columns});`);
  }
}

// Legacy databases predate several columns and lack the NOT NULL/DEFAULT
// guarantees of the current DDL, so every target column is carried across through
// an expression over whatever the legacy table actually has.
function legacyFlowRunsColumnSource(column: string, present: ReadonlySet<string>): string {
  if (column === "owner_key") {
    if (present.has("owner_key")) {
      return present.has(LEGACY_OWNER_COLUMN)
        ? `COALESCE(owner_key, ${LEGACY_OWNER_COLUMN})`
        : "owner_key";
    }
    return present.has(LEGACY_OWNER_COLUMN) ? LEGACY_OWNER_COLUMN : "NULL";
  }
  if (column === "sync_mode") {
    const derived = present.has("shape")
      ? "CASE WHEN shape = 'single_task' THEN 'task_mirrored' ELSE 'managed' END"
      : "'managed'";
    return present.has("sync_mode") ? `COALESCE(sync_mode, ${derived})` : derived;
  }
  if (column === "revision") {
    return present.has("revision") ? "COALESCE(revision, 0)" : "0";
  }
  return present.has(column) ? column : "NULL";
}

/**
 * `owner_session_key` was replaced by `owner_key`, but the migration only ADDed
 * the new column. SQLite cannot drop a column or relax NOT NULL in place, so on
 * every pre-existing database the legacy `owner_session_key TEXT NOT NULL` column
 * survived while nothing wrote it: every insert built from the current column list
 * died with SQLITE_CONSTRAINT_NOTNULL (errcode 1299) and task-flow registration was
 * silently dead for months. Rebuilding the table is the only way out.
 */
function rebuildLegacyFlowRunsTable(db: DatabaseSync): boolean {
  const present = listFlowRunsColumns(db);
  if (!present.has(LEGACY_OWNER_COLUMN)) {
    return false;
  }
  const targetColumns = FLOW_RUNS_COLUMNS.map((column) => column.name);
  const selectList = targetColumns.map(
    (column) => `${legacyFlowRunsColumnSource(column, present)} AS ${column}`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP TABLE IF EXISTS ${FLOW_RUNS_REBUILD_TABLE};`);
    db.exec(createFlowRunsTableSql(FLOW_RUNS_REBUILD_TABLE));
    db.exec(`
      INSERT INTO ${FLOW_RUNS_REBUILD_TABLE} (${targetColumns.join(", ")})
      SELECT ${selectList.join(", ")}
      FROM flow_runs
    `);
    // Dropping the old table drops its indexes too, including the legacy
    // idx_flow_runs_owner_session_key that points at the column being removed.
    db.exec(`DROP TABLE flow_runs;`);
    db.exec(`ALTER TABLE ${FLOW_RUNS_REBUILD_TABLE} RENAME TO flow_runs;`);
    ensureFlowRunsIndexes(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already unwound by SQLite; keep the original failure as the thrown one.
    }
    throw error;
  }
  console.warn(`[flow-registry] rebuilt flow_runs to drop legacy ${LEGACY_OWNER_COLUMN} column`);
  return true;
}

function ensureSchema(db: DatabaseSync) {
  db.exec(createFlowRunsTableSql("flow_runs", { ifNotExists: true }));
  // Runs before the additive migrations below: after a rebuild they are no-ops,
  // and databases that never had the legacy column still take the ALTER path.
  rebuildLegacyFlowRunsTable(db);
  if (!hasFlowRunsColumn(db, "shape")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN shape TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "sync_mode")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN sync_mode TEXT;`);
    if (hasFlowRunsColumn(db, "shape")) {
      db.exec(`
        UPDATE flow_runs
        SET sync_mode = CASE
          WHEN shape = 'single_task' THEN 'task_mirrored'
          ELSE 'managed'
        END
        WHERE sync_mode IS NULL
      `);
    } else {
      db.exec(`
        UPDATE flow_runs
        SET sync_mode = 'managed'
        WHERE sync_mode IS NULL
      `);
    }
  }
  if (!hasFlowRunsColumn(db, "controller_id")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN controller_id TEXT;`);
  }
  db.exec(`
    UPDATE flow_runs
    SET controller_id = 'core/legacy-restored'
    WHERE sync_mode = 'managed'
      AND (controller_id IS NULL OR trim(controller_id) = '')
  `);
  if (!hasFlowRunsColumn(db, "revision")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN revision INTEGER;`);
    db.exec(`
      UPDATE flow_runs
      SET revision = 0
      WHERE revision IS NULL
    `);
  }
  if (!hasFlowRunsColumn(db, "blocked_task_id")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_task_id TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "blocked_summary")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_summary TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "state_json")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN state_json TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "wait_json")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN wait_json TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "cancel_requested_at")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN cancel_requested_at INTEGER;`);
  }
  ensureFlowRunsIndexes(db);
}

function ensureFlowRegistryPermissions(pathname: string) {
  const dir = resolveTaskFlowRegistryDir(process.env);
  mkdirSync(dir, { recursive: true, mode: FLOW_REGISTRY_DIR_MODE });
  chmodSync(dir, FLOW_REGISTRY_DIR_MODE);
  for (const suffix of FLOW_REGISTRY_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, FLOW_REGISTRY_FILE_MODE);
  }
}

function openFlowRegistryDatabase(): FlowRegistryDatabase {
  const pathname = resolveTaskFlowRegistrySqlitePath(process.env);
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.walMaintenance.close();
    cachedDatabase.db.close();
    cachedDatabase = null;
  }
  ensureFlowRegistryPermissions(pathname);
  const restored = guardArchivedStateFile(pathname);
  if (restored) {
    console.warn(`[flow-registry] ${describeArchivedStateTwin(restored)}`);
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  const walMaintenance = configureSqliteWalMaintenance(db);
  db.exec(`PRAGMA synchronous = NORMAL;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  ensureSchema(db);
  ensureFlowRegistryPermissions(pathname);
  cachedDatabase = {
    db,
    path: pathname,
    statements: createStatements(db),
    walMaintenance,
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (statements: FlowRegistryStatements) => void) {
  const { db, path, statements } = openFlowRegistryDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    write(statements);
    db.exec("COMMIT");
    ensureFlowRegistryPermissions(path);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadTaskFlowRegistryStateFromSqlite(): TaskFlowRegistryStoreSnapshot {
  const { statements } = openFlowRegistryDatabase();
  const rows = statements.selectAll.all() as FlowRegistryRow[];
  return {
    flows: new Map(rows.map((row) => [row.flow_id, rowToFlowRecord(row)])),
  };
}

export function saveTaskFlowRegistryStateToSqlite(snapshot: TaskFlowRegistryStoreSnapshot) {
  withWriteTransaction((statements) => {
    statements.clearRows.run();
    for (const flow of snapshot.flows.values()) {
      statements.upsertRow.run(bindFlowRecord(flow));
    }
  });
}

export function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord) {
  const store = openFlowRegistryDatabase();
  store.statements.upsertRow.run(bindFlowRecord(flow));
  ensureFlowRegistryPermissions(store.path);
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  const store = openFlowRegistryDatabase();
  store.statements.deleteRow.run(flowId);
  ensureFlowRegistryPermissions(store.path);
}

export function closeTaskFlowRegistrySqliteStore() {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.walMaintenance.close();
  cachedDatabase.db.close();
  cachedDatabase = null;
}
