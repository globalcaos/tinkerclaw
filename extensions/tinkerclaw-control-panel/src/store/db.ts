/**
 * FORK: tinkerclaw-control-panel — SQLite connection singleton + bootstrap.
 *
 * Lazily opens better-sqlite3 against the configured dbPath, enables WAL,
 * and applies the schema (inlined in schema.ts) once on first open. Subsequent
 * calls reuse the cached connection. Mirrors the pattern from
 * extensions/tinkerclaw-whatsapp/src/history/db.ts — schema lives inline
 * because tsdown bundlers don't ship .sql assets.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ControlPanelResolvedConfig } from "../paths.js";
import { CONTROL_PANEL_SCHEMA_SQL } from "./schema.js";

let db: Database.Database | null = null;
let initializedAt = 0;

export function getDb(cfg: ControlPanelResolvedConfig): Database.Database {
  if (db) return db;

  if (!fs.existsSync(cfg.dataDir)) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
  }

  db = new Database(cfg.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // CREATE TABLE IF NOT EXISTS makes this idempotent — subsequent boots are no-ops.
  db.exec(CONTROL_PANEL_SCHEMA_SQL);

  // v3.1.1 migration — old DBs have a CHECK constraint on task.priority_axis
  // that lists only ('online','family','me','serra','meta'). The new schema
  // drops that constraint so we can add 'ventures' (and future axes) without
  // a schema migration each time. Detect + rewrite in-place; idempotent.
  migrateRemoveAxisCheck(db);

  // v3.3 migration — old DBs have status CHECK without 'back_burner'. Widen
  // the constraint so the new "snooze indefinitely" feature can write the
  // status. Same in-place rewrite pattern as the axis migration above.
  migrateWidenStatusCheck(db);

  // v3.5 migration — old DBs have task_axis without the parent_id column that
  // backs the group → sub-group hierarchy in the Today card redesign. Plain
  // ALTER TABLE ADD COLUMN (SQLite supports it for NULL-default columns with
  // a FK target); idempotent via PRAGMA table_info check.
  addAxisParentIdColumn(db);

  // FORK 2026-05-22: Todoist deprecation cleanup. Walk task.metadata_json and
  // remove every `todoist_*` key. Idempotent one-shot — subsequent boots find
  // nothing to strip and are no-ops.
  stripTodoistMetadata(db);

  // v3.3 — seed task_axis + task_est_preset with the prior hardcoded defaults
  // if the tables are empty. Idempotent — only inserts on truly empty tables,
  // so user edits survive subsequent boots.
  seedTaxonomyDefaults(db);

  initializedAt = Date.now();
  return db;
}

function migrateRemoveAxisCheck(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return;
  if (!row.sql.includes("priority_axis IN ('online','family','me','serra','meta')")) {
    return; // already migrated or fresh schema
  }
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE task_new (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        context_md TEXT,
        status TEXT NOT NULL CHECK (status IN ('open','in_progress','resolved','dropped','dismissed')),
        source TEXT NOT NULL,
        source_ref TEXT,
        briefing_pass_id TEXT REFERENCES briefing_pass(id),
        priority_axis TEXT,
        priority_rank INTEGER NOT NULL DEFAULT 50,
        carry_days INTEGER NOT NULL DEFAULT 0,
        age_seconds INTEGER NOT NULL DEFAULT 0,
        due_date TEXT,
        dismissal_kind TEXT CHECK (dismissal_kind IN ('not_a_task','not_relevant','wrong_priority','duplicate','out_of_scope','other')),
        dismissal_note TEXT,
        est_minutes INTEGER,
        hands TEXT CHECK (hands IN ('user','assistant','either')),
        inferred_signal_json TEXT,
        metadata_json TEXT,
        recurrence_rule_text TEXT,
        recurrence_parent_id TEXT REFERENCES task(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
    db.exec("INSERT INTO task_new SELECT * FROM task");
    db.exec("DROP TABLE task");
    db.exec("ALTER TABLE task_new RENAME TO task");
    db.exec(`
      CREATE INDEX IF NOT EXISTS task_open_priority ON task(status, priority_axis, priority_rank) WHERE status IN ('open','in_progress');
      CREATE INDEX IF NOT EXISTS task_resolved_recent ON task(resolved_at DESC) WHERE status = 'resolved';
      CREATE INDEX IF NOT EXISTS task_due_date ON task(due_date) WHERE due_date IS NOT NULL;
      CREATE INDEX IF NOT EXISTS task_briefing_pass ON task(briefing_pass_id);
      CREATE INDEX IF NOT EXISTS task_dismissed ON task(status, dismissal_kind) WHERE status = 'dismissed';
      CREATE INDEX IF NOT EXISTS task_recurring ON task(recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL;
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v3.3 — widen status CHECK constraint to include 'back_burner'. Old DBs
// have CHECK (status IN ('open','in_progress','resolved','dropped','dismissed')) —
// new schema adds 'back_burner'. SQLite can't ALTER a CHECK in place; same
// rebuild-rename pattern as migrateRemoveAxisCheck above. Idempotent: detect
// the old constraint via sqlite_master and skip if absent.
function migrateWidenStatusCheck(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return;
  if (row.sql.includes("'back_burner'")) return; // already widened
  if (!row.sql.includes("status IN ('open','in_progress','resolved','dropped','dismissed')")) {
    return; // schema doesn't match the expected old shape — leave alone
  }
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE task_new (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        context_md TEXT,
        status TEXT NOT NULL CHECK (status IN ('open','in_progress','resolved','dropped','dismissed','back_burner')),
        source TEXT NOT NULL,
        source_ref TEXT,
        briefing_pass_id TEXT REFERENCES briefing_pass(id),
        priority_axis TEXT,
        priority_rank INTEGER NOT NULL DEFAULT 50,
        carry_days INTEGER NOT NULL DEFAULT 0,
        age_seconds INTEGER NOT NULL DEFAULT 0,
        due_date TEXT,
        dismissal_kind TEXT CHECK (dismissal_kind IN ('not_a_task','not_relevant','wrong_priority','duplicate','out_of_scope','other')),
        dismissal_note TEXT,
        est_minutes INTEGER,
        hands TEXT CHECK (hands IN ('user','assistant','either')),
        inferred_signal_json TEXT,
        metadata_json TEXT,
        recurrence_rule_text TEXT,
        recurrence_parent_id TEXT REFERENCES task(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
    db.exec("INSERT INTO task_new SELECT * FROM task");
    db.exec("DROP TABLE task");
    db.exec("ALTER TABLE task_new RENAME TO task");
    db.exec(`
      CREATE INDEX IF NOT EXISTS task_open_priority ON task(status, priority_axis, priority_rank) WHERE status IN ('open','in_progress');
      CREATE INDEX IF NOT EXISTS task_resolved_recent ON task(resolved_at DESC) WHERE status = 'resolved';
      CREATE INDEX IF NOT EXISTS task_due_date ON task(due_date) WHERE due_date IS NOT NULL;
      CREATE INDEX IF NOT EXISTS task_briefing_pass ON task(briefing_pass_id);
      CREATE INDEX IF NOT EXISTS task_dismissed ON task(status, dismissal_kind) WHERE status = 'dismissed';
      CREATE INDEX IF NOT EXISTS task_recurring ON task(recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS task_back_burner ON task(priority_axis, priority_rank) WHERE status = 'back_burner';
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// v3.5 — add task_axis.parent_id (NULL-default TEXT FK → task_axis.id ON
// DELETE CASCADE) + the supporting partial-free index. Exported so the
// vitest covering the runtime migration path can hit it directly; same
// shape as the v3.1.1 / v3.3 migrations above except SQLite's plain
// ALTER TABLE works here because the new column is nullable + has no
// CHECK constraint. Idempotent via PRAGMA table_info — re-running on an
// already-migrated DB is a no-op.
export function addAxisParentIdColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(task_axis)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "parent_id")) return; // idempotent
  db.exec(
    "ALTER TABLE task_axis ADD COLUMN parent_id TEXT REFERENCES task_axis(id) ON DELETE CASCADE",
  );
  db.exec("CREATE INDEX IF NOT EXISTS task_axis_parent ON task_axis(parent_id)");
}

/**
 * FORK 2026-05-22: Todoist deprecation cleanup. Strips `todoist_*` keys from
 * every task.metadata_json. Idempotent: re-runs are no-ops.
 *
 * If a row's metadata_json becomes the empty object after the strip, we set
 * the column back to NULL so empty `{}` doesn't accumulate. Malformed JSON
 * rows are left alone — better an opaque blob the user can hand-fix than a
 * boot-time crash on parse failure.
 */
export function stripTodoistMetadata(db: Database.Database): void {
  const rows = db
    .prepare("SELECT id, metadata_json FROM task WHERE metadata_json IS NOT NULL")
    .all() as Array<{ id: string; metadata_json: string }>;
  const update = db.prepare("UPDATE task SET metadata_json = ? WHERE id = ?");
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      continue; // malformed JSON — leave alone
    }
    let changed = false;
    for (const key of Object.keys(parsed)) {
      if (key.startsWith("todoist_")) {
        delete parsed[key];
        changed = true;
      }
    }
    if (!changed) continue;
    const remaining = Object.keys(parsed).length;
    update.run(remaining === 0 ? null : JSON.stringify(parsed), row.id);
  }
}

// v3.3 — first-boot seed for task_axis + task_est_preset. Both tables CREATE
// IF NOT EXISTS in the schema, so they exist (empty) on first run after this
// migration ships. The seeds mirror the prior hardcoded EXEC_AXIS_ORDER /
// EXEC_AXIS_LABEL in tinker-ui/src/app.ts and the implicit "30 min default"
// in the add-task wizard's <input type=number value=30>. Inserts only when
// the table is empty so user edits across reboots are never overwritten.
function seedTaxonomyDefaults(db: Database.Database): void {
  const now = Date.now();
  const axisCount = (db.prepare("SELECT COUNT(*) as n FROM task_axis").get() as { n: number }).n;
  if (axisCount === 0) {
    const insAxis = db.prepare(
      "INSERT INTO task_axis (id, label, position, created_at, updated_at) VALUES (@id, @label, @position, @now, @now)",
    );
    const defaults = [
      { id: "ventures", label: "🚀 Ventures", position: 10 },
      { id: "online", label: "💰 Online", position: 20 },
      { id: "family", label: "👨‍👩‍👧 Family", position: 30 },
      { id: "me", label: "🏃 Me", position: 40 },
      { id: "serra", label: "🏭 SERRA", position: 50 },
      { id: "meta", label: "⚙️ Meta", position: 60 },
    ];
    db.exec("BEGIN");
    try {
      for (const a of defaults) insAxis.run({ ...a, now });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  const presetCount = (
    db.prepare("SELECT COUNT(*) as n FROM task_est_preset").get() as { n: number }
  ).n;
  if (presetCount === 0) {
    const insPreset = db.prepare(
      "INSERT INTO task_est_preset (minutes, label, position, created_at, updated_at) VALUES (@minutes, @label, @position, @now, @now)",
    );
    const defaults = [
      { minutes: 5, label: "5 min", position: 10 },
      { minutes: 15, label: "15 min", position: 20 },
      { minutes: 30, label: "30 min", position: 30 },
      { minutes: 60, label: "1 hour", position: 40 },
      { minutes: 120, label: "2 hours", position: 50 },
      { minutes: 240, label: "4 hours", position: 60 },
      { minutes: 480, label: "All day", position: 70 },
    ];
    db.exec("BEGIN");
    try {
      for (const p of defaults) insPreset.run({ ...p, now });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    initializedAt = 0;
  }
}

export function dbInitializedAt(): number {
  return initializedAt;
}
