import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAxisParentIdColumn,
  closeDb,
  getDb,
  migrateRemoveAxisCheck,
  stripTodoistMetadata,
} from "./db.js";

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
        VALUES ('online', 'Online', 100, 0, 0), ('acme', 'Acme', 200, 0, 0);
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
      { id: "acme", parent_id: null },
      { id: "online", parent_id: null },
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

/**
 * v3.1.1 — the old schema enumerated the allowed axis ids in a CHECK on
 * task.priority_axis. The migration detects any such enumeration (whatever ids
 * it lists) and rebuilds the table without it, keeping rows verbatim.
 */
describe("migrateRemoveAxisCheck on an old-schema DB", () => {
  let dir: string;
  let dbPath: string;
  const cfgFor = () =>
    ({
      dbPath,
      dataDir: dir,
      calendarSync: false,
      briefingImport: false,
      execMode: false,
    }) as unknown as Parameters<typeof getDb>[0];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-axis-check-"));
    dbPath = path.join(dir, "store.db");
    const seed = new Database(dbPath);
    // v3.1-shaped store: enumerated axis CHECK, a custom axis row and a task
    // that sits on it.
    seed.exec(`
      CREATE TABLE briefing_pass (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        pass_number INTEGER NOT NULL,
        delivered_to_user_at INTEGER,
        initial_task_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        context_md TEXT,
        status TEXT NOT NULL CHECK (status IN ('open','in_progress','resolved','dropped','dismissed')),
        source TEXT NOT NULL,
        source_ref TEXT,
        briefing_pass_id TEXT REFERENCES briefing_pass(id),
        priority_axis TEXT CHECK (priority_axis IN ('online','family','me','acme','meta')),
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
      CREATE TABLE task_axis (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO task_axis (id, label, position, created_at, updated_at)
        VALUES ('acme', 'Acme Corp', 50, 1, 2);
      INSERT INTO task (id, text, status, source, priority_axis, priority_rank, metadata_json, created_at, updated_at)
        VALUES ('t-acme', 'custom-axis task', 'open', 'manual', 'acme', 3, '{"k":"v"}', 10, 20);
    `);
    seed.close();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("drops the enumerated CHECK and keeps the custom axis row + its tasks verbatim", () => {
    const db = getDb(cfgFor());
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).not.toContain("priority_axis IN (");

    const axes = db.prepare("SELECT id, label, position FROM task_axis").all();
    // The custom row survives and the non-empty table is not re-seeded.
    expect(axes).toEqual([{ id: "acme", label: "Acme Corp", position: 50 }]);

    const task = db
      .prepare(
        "SELECT id, text, status, priority_axis, priority_rank, metadata_json, created_at, updated_at FROM task WHERE id = 't-acme'",
      )
      .get();
    expect(task).toEqual({
      id: "t-acme",
      text: "custom-axis task",
      status: "open",
      priority_axis: "acme",
      priority_rank: 3,
      metadata_json: '{"k":"v"}',
      created_at: 10,
      updated_at: 20,
    });

    // Any axis id is now accepted — the column is no longer enumerated.
    db.prepare(
      "INSERT INTO task (id, text, status, source, priority_axis, created_at, updated_at) VALUES ('t-new', 'x', 'open', 'manual', 'brand-new-axis', 0, 0)",
    ).run();
    expect(
      (
        db.prepare("SELECT priority_axis FROM task WHERE id = 't-new'").get() as {
          priority_axis: string;
        }
      ).priority_axis,
    ).toBe("brand-new-axis");
  });

  it("is a no-op on an already-migrated table", () => {
    const db = getDb(cfgFor());
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='task'").get();
    migrateRemoveAxisCheck(db);
    const after = db.prepare("SELECT sql FROM sqlite_master WHERE name='task'").get();
    expect(after).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 1 });
  });
});

describe("fresh DB axis seed", () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("seeds the generic work axis", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-axis-seed-"));
    const db = getDb({
      dbPath: path.join(dir, "store.db"),
      dataDir: dir,
    } as unknown as Parameters<typeof getDb>[0]);
    const ids = (
      db.prepare("SELECT id FROM task_axis ORDER BY position").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    expect(ids).toContain("work");
  });
});

describe("calendarSync.sources config schema", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as {
    configSchema: {
      properties: {
        calendarSync: { properties: { sources: { items: { type: string; pattern: string } } } };
      };
    };
  };
  const items = manifest.configSchema.properties.calendarSync.properties.sources.items;
  const re = new RegExp(items.pattern);

  it("is an open <provider>.<account> pattern, not an enum", () => {
    expect(items.type).toBe("string");
    expect(items).not.toHaveProperty("enum");
  });

  it("accepts google.primary and outlook.<any account name>", () => {
    for (const ok of ["google.primary", "outlook.work", "outlook.acme", "outlook.my-team_2"]) {
      expect(re.test(ok), ok).toBe(true);
    }
  });

  it("rejects unknown providers and malformed values", () => {
    for (const bad of ["outlook", "outlook.", "yahoo.primary", "outlook.a.b", "google primary"]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });
});
