import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAxisParentIdColumn, closeDb, getDb, stripTodoistMetadata } from "./db.js";

describe("addAxisParentIdColumn migration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE task_axis (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO task_axis (id, label, position, created_at, updated_at)
        VALUES ('online', 'Online', 100, 0, 0), ('serra', 'SERRA', 200, 0, 0);
    `);
  });

  afterEach(() => db.close());

  it("adds parent_id column without losing existing rows", () => {
    addAxisParentIdColumn(db);
    const cols = db.prepare("PRAGMA table_info(task_axis)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("parent_id");
    const rows = db.prepare("SELECT id, parent_id FROM task_axis ORDER BY id").all() as Array<{
      id: string;
      parent_id: string | null;
    }>;
    expect(rows).toEqual([
      { id: "online", parent_id: null },
      { id: "serra", parent_id: null },
    ]);
  });

  it("is idempotent — running twice does not throw", () => {
    addAxisParentIdColumn(db);
    expect(() => addAxisParentIdColumn(db)).not.toThrow();
  });
});

/**
 * FORK 2026-05-22: regression for the v3.5 boot-ordering crash. Catches the
 * class where schema.ts/schema.sql references a column that only exists
 * after a later migration. The original symptom was
 * `SqliteError: no such column: parent_id` thrown from schema.exec() at
 * boot, which silently broke the plugin loader (re-registrations after
 * `http server listening` never made it into the RPC routing table).
 *
 * Test path: seed a tmpdir with a v3.3-shaped task_axis (no parent_id),
 * then call getDb() — which runs schema.exec() + migrations in their real
 * boot order. Must not throw, must end with parent_id present + existing
 * rows preserved.
 */
describe("getDb() boot path on a pre-v3.5 DB", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-boot-test-"));
    dbPath = path.join(dir, "store.db");
    // Seed the file with a v3.3-shaped task_axis (parent_id missing).
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE task_axis (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO task_axis (id, label, position, created_at, updated_at)
        VALUES ('legacy-axis-1', 'Legacy 1', 100, 0, 0),
               ('legacy-axis-2', 'Legacy 2', 200, 0, 0);
    `);
    seed.close();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not throw + adds parent_id + preserves existing rows", () => {
    const cfg = {
      dbPath,
      dataDir: dir,
      calendarSync: false,
      briefingImport: false,
      execMode: false,
    } as Parameters<typeof getDb>[0];
    expect(() => getDb(cfg)).not.toThrow();
    const db = getDb(cfg);
    const cols = db.prepare("PRAGMA table_info(task_axis)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("parent_id");
    const legacy = db
      .prepare("SELECT id, parent_id FROM task_axis WHERE id LIKE 'legacy-axis-%' ORDER BY id")
      .all() as Array<{ id: string; parent_id: string | null }>;
    expect(legacy).toEqual([
      { id: "legacy-axis-1", parent_id: null },
      { id: "legacy-axis-2", parent_id: null },
    ]);
  });

  it("creates the task_axis_parent index via the migration (not the schema)", () => {
    const cfg = {
      dbPath,
      dataDir: dir,
      calendarSync: false,
      briefingImport: false,
      execMode: false,
    } as Parameters<typeof getDb>[0];
    const db = getDb(cfg);
    const indexes = db.prepare("PRAGMA index_list(task_axis)").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("task_axis_parent");
  });
});

/**
 * FORK 2026-05-22: Todoist deprecation cleanup. `stripTodoistMetadata`
 * walks task.metadata_json and removes every `todoist_*` key. If the strip
 * empties the JSON object, the column is set to NULL. Idempotent.
 */
describe("stripTodoistMetadata migration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        metadata_json TEXT
      );
    `);
    db.prepare("INSERT INTO task (id, text, metadata_json) VALUES (?, ?, ?)").run(
      "t1",
      "with todoist",
      JSON.stringify({ todoist_id: "abc123", gmail_thread_ids: ["g1"], note: "keep me" }),
    );
    db.prepare("INSERT INTO task (id, text, metadata_json) VALUES (?, ?, ?)").run(
      "t2",
      "no metadata",
      null,
    );
    db.prepare("INSERT INTO task (id, text, metadata_json) VALUES (?, ?, ?)").run(
      "t3",
      "all todoist",
      JSON.stringify({ todoist_url: "https://...", todoist_labels: ["x"] }),
    );
  });

  afterEach(() => db.close());

  it("strips todoist_* keys from metadata_json while preserving siblings", () => {
    stripTodoistMetadata(db);
    const row = db.prepare("SELECT metadata_json FROM task WHERE id = 't1'").get() as {
      metadata_json: string;
    };
    const t1 = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(t1).toEqual({ gmail_thread_ids: ["g1"], note: "keep me" });
  });

  it("sets metadata_json to NULL when nothing remains after strip", () => {
    stripTodoistMetadata(db);
    const t3 = db.prepare("SELECT metadata_json FROM task WHERE id = 't3'").get() as {
      metadata_json: string | null;
    };
    expect(t3.metadata_json).toBeNull();
  });

  it("leaves rows with null metadata_json alone", () => {
    stripTodoistMetadata(db);
    const t2 = db.prepare("SELECT metadata_json FROM task WHERE id = 't2'").get() as {
      metadata_json: string | null;
    };
    expect(t2.metadata_json).toBeNull();
  });

  it("is idempotent — running twice produces the same result", () => {
    stripTodoistMetadata(db);
    const before = db.prepare("SELECT id, metadata_json FROM task ORDER BY id").all();
    stripTodoistMetadata(db);
    const after = db.prepare("SELECT id, metadata_json FROM task ORDER BY id").all();
    expect(after).toEqual(before);
  });
});
