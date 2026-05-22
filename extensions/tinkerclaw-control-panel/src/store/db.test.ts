import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAxisParentIdColumn } from "./db.js";

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
