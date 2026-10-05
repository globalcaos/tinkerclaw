import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../node-sqlite.js";
import { configureSqliteWalMaintenance } from "../sqlite-wal.js";
import { type CatalogEvent, EVENT_CATALOG } from "./catalog.js";
import {
  EVENTS_MIGRATIONS,
  EVENTS_SCHEMA_V1_SQL,
  EVENTS_SCHEMA_VERSION,
  type EventsDatabase,
  type EventsMigration,
  eventViewColumns,
  eventViewName,
  eventViewSql,
  migrateEventsSchema,
  openEventsDatabase,
  VIEW_BASE_COLUMNS,
  viewColumnName,
} from "./schema.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const loggingMdPath = join(repoRoot, "TINKER_UI_DESIGN_BIBLE", "logging.md");

const CREATED_AT_MS = 1_790_000_000_000;
/** No periodic checkpoint timer in tests; close() still runs the final checkpoint. */
const NO_TIMER = { checkpointIntervalMs: 0 };

let tmpDir: string;
const opened: EventsDatabase[] = [];
const bare: DatabaseSync[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "events-schema-"));
});

afterEach(() => {
  for (const handle of opened.splice(0)) {
    handle.close();
  }
  for (const db of bare.splice(0)) {
    db.close();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Opens the test's events file, creating it (and its `logs/` directory) on first use. */
function open(options: { catalog?: readonly CatalogEvent[]; nowMs?: number } = {}): EventsDatabase {
  const handle = openEventsDatabase(join(tmpDir, "logs", "events.sqlite"), {
    catalog: options.catalog,
    nowMs: options.nowMs ?? CREATED_AT_MS,
    walMaintenance: NO_TIMER,
  });
  opened.push(handle);
  return handle;
}

function close(handle: EventsDatabase): void {
  opened.splice(opened.indexOf(handle), 1);
  handle.close();
}

/** A bare connection, for the cases that must bypass openEventsDatabase's pragma order. */
function bareDb(file: string): DatabaseSync {
  const { DatabaseSync: Database } = requireNodeSqlite();
  const db = new Database(join(tmpDir, file));
  bare.push(db);
  return db;
}

function one(
  db: DatabaseSync,
  sql: string,
  ...params: Array<string | number>
): Record<string, unknown> | undefined {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : { ...row };
}

function names(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ name: string }>).map((row) => row.name);
}

function columnsOf(db: DatabaseSync, relation: string): string[] {
  return names(db, `PRAGMA table_info("${relation}")`);
}

function viewNames(db: DatabaseSync): string[] {
  return names(db, "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name");
}

function meta(db: DatabaseSync, key: string): unknown {
  return one(db, "SELECT value FROM meta WHERE key = ?", key)?.value;
}

function catalogRevision(db: DatabaseSync, name: string): unknown {
  return one(db, "SELECT version FROM catalog WHERE name = ?", name)?.version;
}

function fixtureEvent(overrides: Partial<CatalogEvent> & Pick<CatalogEvent, "name">): CatalogEvent {
  return {
    kind: "mark",
    retention: "debug",
    paper: null,
    question: "Does the schema module handle this fixture row?",
    label: null,
    durMs: null,
    n1: null,
    n2: null,
    n3: null,
    n4: null,
    fields: {},
    uiIngestable: false,
    ...overrides,
  };
}

describe("events database schema (logging.md §7.3, §9 step 2)", () => {
  it("an empty file migrates to version 1: §7.3's STRICT tables, typed columns, indexes and meta", () => {
    const { db, migration } = open();
    expect(EVENTS_SCHEMA_VERSION).toBe(1);
    expect(migration).toEqual({
      fromVersion: 0,
      toVersion: 1,
      applied: [1],
      viewsRegenerated: true,
      views: EVENT_CATALOG.length,
    });
    expect(meta(db, "schema_version")).toBe("1");
    expect(meta(db, "created_at_ms")).toBe(String(CREATED_AT_MS));

    const tables = (
      db.prepare("PRAGMA table_list").all() as Array<{
        schema: string;
        name: string;
        type: string;
        strict: number;
      }>
    )
      .filter((t) => t.schema === "main" && t.type === "table" && !t.name.startsWith("sqlite_"))
      .map((t) => `${t.name}${t.strict === 1 ? " STRICT" : ""}`)
      .toSorted();
    expect(tables).toEqual(["catalog STRICT", "events STRICT", "meta STRICT", "rollup_1h STRICT"]);

    const eventColumns = (
      db.prepare("PRAGMA table_info(events)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>
    ).map((c) => `${c.name} ${c.type}${c.notnull === 1 ? " NOT NULL" : ""}`);
    expect(eventColumns).toEqual([
      "id INTEGER",
      "ts_ms INTEGER NOT NULL",
      "name TEXT NOT NULL",
      "kind TEXT NOT NULL",
      "boot_id TEXT NOT NULL",
      "session_hash TEXT",
      "session_kind TEXT",
      "run_id TEXT",
      "worker_id TEXT",
      "label TEXT",
      "dur_ms REAL",
      "n1 REAL",
      "n2 REAL",
      "n3 REAL",
      "n4 REAL",
      "fields TEXT",
    ]);
    expect(
      names(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' " +
          "AND sql IS NOT NULL ORDER BY name",
      ),
    ).toEqual([
      "events_name_label_ts",
      "events_name_ts",
      "events_run",
      "events_session_ts",
      "events_worker_ts",
    ]);

    // STRICT is the schema half of L4: a declared type is enforced, never hoped for.
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (ts_ms, name, kind, boot_id) VALUES ('later', 'gw.boot', 'mark', 'b')",
        )
        .run(),
    ).toThrow(/INTEGER/);

    // §7.4's incremental_vacuum reclaims nothing unless this took on the empty file.
    expect(one(db, "PRAGMA auto_vacuum")?.auto_vacuum).toBe(2);
    expect(one(db, "PRAGMA journal_mode")?.journal_mode).toBe("wal");

    expect(one(db, "SELECT count(*) AS n FROM catalog")?.n).toBe(EVENT_CATALOG.length);
    for (const event of EVENT_CATALOG) {
      expect(
        one(
          db,
          "SELECT kind, retention, paper, question, label_means, dur_means, n1_means, n2_means, " +
            "n3_means, n4_means, field_types, version FROM catalog WHERE name = ?",
          event.name,
        ),
        event.name,
      ).toEqual({
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
        version: 1,
      });
    }
  });

  it("a version-1 file re-runs the migrations idempotently: nothing applied, nothing rewritten", () => {
    const first = open();
    first.db
      .prepare("INSERT INTO events (ts_ms, name, kind, boot_id, n1) VALUES (?, ?, ?, ?, ?)")
      .run(1, "worker.sample", "sample", "boot-a", 42);
    close(first);

    const again = open({ nowMs: CREATED_AT_MS + 60_000 });
    expect(again.migration).toEqual({
      fromVersion: 1,
      toVersion: 1,
      applied: [],
      viewsRegenerated: false,
      views: EVENT_CATALOG.length,
    });
    expect(meta(again.db, "created_at_ms")).toBe(String(CREATED_AT_MS));
    expect(one(again.db, "SELECT mem_bytes FROM v_worker_sample")).toEqual({ mem_bytes: 42 });
    expect(one(again.db, "SELECT max(version) AS revision FROM catalog")?.revision).toBe(1);
    // And once more on the open connection: the ladder is a no-op on a current file.
    expect(migrateEventsSchema(again.db)).toMatchObject({ applied: [], viewsRegenerated: false });
    expect(viewNames(again.db)).toHaveLength(EVENT_CATALOG.length);
  });

  it("every catalog row has a view whose columns match its meanings", () => {
    const { db } = open();
    expect(viewNames(db)).toEqual(
      EVENT_CATALOG.map((event) => eventViewName(event.name)).toSorted(),
    );

    // One row per event, every slot filled with a value that says which slot it came from.
    const insert = db.prepare(
      "INSERT INTO events (ts_ms, name, kind, boot_id, label, dur_ms, n1, n2, n3, n4, fields) " +
        "VALUES (1, ?, ?, 'boot', 'label-value', 0.5, 1, 2, 3, 4, ?)",
    );
    for (const event of EVENT_CATALOG) {
      const fields = Object.fromEntries(
        Object.keys(event.fields).map((key) => [key, `${key}-value`]),
      );
      insert.run(event.name, event.kind, JSON.stringify(fields));
    }

    for (const event of EVENT_CATALOG) {
      const view = eventViewName(event.name);
      const slots = (["n1", "n2", "n3", "n4"] as const).flatMap((slot, index) => {
        const meaning = event[slot];
        return meaning === null ? [] : [{ column: viewColumnName(meaning), value: index + 1 }];
      });
      // Expected names come from the meanings, so a real row that needed the collision fallback
      // (a raw `label` or `n2` column) fails here.
      expect(columnsOf(db, view), view).toEqual([
        ...VIEW_BASE_COLUMNS,
        ...(event.label === null ? [] : [viewColumnName(event.label)]),
        ...(event.durMs === null ? [] : ["dur_ms"]),
        ...slots.map((slot) => slot.column),
        ...Object.keys(event.fields),
      ]);
      const rows = db.prepare(`SELECT * FROM "${view}"`).all() as Array<Record<string, unknown>>;
      expect(rows, `${view} reads only ${event.name} rows`).toHaveLength(1);
      const row = rows[0];
      if (event.label !== null) {
        expect(row[viewColumnName(event.label)], `${view} label`).toBe("label-value");
      }
      if (event.durMs !== null) {
        expect(row.dur_ms, `${view} dur_ms`).toBe(0.5);
      }
      for (const slot of slots) {
        expect(row[slot.column], `${view}.${slot.column}`).toBe(slot.value);
      }
      for (const key of Object.keys(event.fields)) {
        expect(row[key], `${view}.${key}`).toBe(`${key}-value`);
      }
    }
  });

  it("worker.sample's view is the one logging.md §7.3 prints, so the doc example cannot go stale", () => {
    const workerSample = EVENT_CATALOG.find((event) => event.name === "worker.sample");
    if (workerSample === undefined) {
      throw new Error(
        "worker.sample is gone from the catalog; move this pin to another sample row",
      );
    }
    expect(eventViewColumns(workerSample).map(({ column }) => column)).toEqual([
      "id",
      "ts_ms",
      "boot_id",
      "session_hash",
      "session_kind",
      "run_id",
      "worker_id",
      "worker_type",
      "mem_bytes",
      "cpu_ms",
      "age_ms",
      "peak_bytes",
      "source",
      "pids",
      "heap_used_bytes",
      "heap_limit_bytes",
    ]);
    expect(readFileSync(loggingMdPath, "utf8")).toContain(eventViewSql(workerSample));
  });

  it("§7.3's version-1 block is rung 1's SQL, apart from comments and the connection pragmas", () => {
    const doc = readFileSync(loggingMdPath, "utf8");
    const start = doc.indexOf("```sql\nPRAGMA busy_timeout");
    expect(start, "§7.3's schema block moved or changed its first line; update this pin").toBe(
      doc.lastIndexOf("```sql\nPRAGMA busy_timeout"),
    );
    expect(start).toBeGreaterThan(-1);
    const block = doc.slice(start + "```sql\n".length, doc.indexOf("\n```", start));
    const normalize = (sql: string): string =>
      sql
        .replace(/--[^\n]*/g, "")
        .replace(/^PRAGMA [^\n]*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
    expect(normalize(block)).toBe(normalize(EVENTS_SCHEMA_V1_SQL));
  });

  it.each([
    ["worker_type (gateway, tinker_bridge, fts_thread, whatsmeow)", "worker_type"],
    ["cpu_ms since the last sample", "cpu_ms"],
    ["outcome (hit, miss)", "outcome"],
    ["tool name", "tool_name"],
    ["hook:plugin", "hook_plugin"],
    ["algorithm/variant", "algorithm_variant"],
    ["outcome or failure_kind", "outcome_or_failure_kind"],
    ["reasons joined by +", "reasons_joined_by"],
    ["loop_p99_ms", "loop_p99_ms"],
    ["+", ""],
  ])("a meaning names its column by one rule: %j → %j", (meaning, column) => {
    expect(viewColumnName(meaning)).toBe(column);
  });

  it("a meaning that would collide falls back to its raw slot, so a view always builds", () => {
    const colliding = fixtureEvent({
      name: "zz.schema.collide",
      label: "id",
      n1: "age_ms",
      n2: "age_ms (again)",
      fields: { flag: "boolean" },
    });
    expect(eventViewColumns(colliding).map(({ column }) => column)).toEqual([
      ...VIEW_BASE_COLUMNS,
      "label",
      "age_ms",
      "n2",
      "flag",
    ]);
  });

  it("views and the catalog mirror regenerate when the catalog changes", () => {
    const first = open();
    // A view a migration might make under its own name: not the generator's, so it must survive.
    first.db.exec("CREATE VIEW keep_me AS SELECT count(*) AS n FROM events");
    close(first);

    const workerSample = EVENT_CATALOG.find((event) => event.name === "worker.sample");
    if (workerSample === undefined) {
      throw new Error("worker.sample is gone from the catalog; move this fixture to another row");
    }
    expect(workerSample.n1).toBe("mem_bytes");
    // gw.boot removed, worker.sample's n1 renamed, one row added.
    const changed: CatalogEvent[] = [
      ...EVENT_CATALOG.filter((event) => event.name !== "gw.boot" && event !== workerSample),
      { ...workerSample, n1: "rss_bytes" },
      fixtureEvent({
        name: "zz.schema.added",
        label: "probe id",
        n1: "count",
        fields: { flag: "boolean" },
      }),
    ];

    const second = open({ catalog: changed });
    expect(second.migration).toEqual({
      fromVersion: 1,
      toVersion: 1,
      applied: [],
      viewsRegenerated: true,
      views: changed.length,
    });
    expect(columnsOf(second.db, "v_worker_sample")).toContain("rss_bytes");
    expect(columnsOf(second.db, "v_worker_sample")).not.toContain("mem_bytes");
    expect(viewNames(second.db)).not.toContain("v_gw_boot");
    expect(columnsOf(second.db, "v_zz_schema_added")).toEqual([
      ...VIEW_BASE_COLUMNS,
      "probe_id",
      "count",
      "flag",
    ]);
    expect(viewNames(second.db)).toContain("keep_me");
    expect(catalogRevision(second.db, "worker.sample")).toBe(2);
    expect(catalogRevision(second.db, "rpc.minute")).toBe(1);
    expect(catalogRevision(second.db, "zz.schema.added")).toBe(1);
    expect(catalogRevision(second.db, "gw.boot")).toBeUndefined();
    close(second);

    expect(open({ catalog: changed }).migration.viewsRegenerated).toBe(false);
  });

  it("an empty file some caller switched to WAL first still gets INCREMENTAL auto-vacuum", () => {
    // The trap is real on this build: in the wrong order the pragma is a silent no-op.
    const control = bareDb("control.sqlite");
    control.exec("PRAGMA journal_mode = WAL;");
    control.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    control.exec("CREATE TABLE t (a INTEGER) STRICT;");
    expect(
      one(control, "PRAGMA auto_vacuum")?.auto_vacuum,
      "SQLite now honours auto_vacuum after a WAL switch; the repair and its §7.3 sentence can go",
    ).toBe(0);

    const db = bareDb("wal-first.sqlite");
    const wal = configureSqliteWalMaintenance(db, NO_TIMER);
    try {
      expect(migrateEventsSchema(db, { nowMs: CREATED_AT_MS }).applied).toEqual([1]);
      expect(one(db, "PRAGMA auto_vacuum")?.auto_vacuum).toBe(2);
    } finally {
      wal.close();
    }
  });

  it("a file from a newer build is refused and left untouched: migrations are forward-only", () => {
    const { db } = open();
    const newer = String(EVENTS_SCHEMA_VERSION + 1);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(newer);
    expect(() => migrateEventsSchema(db)).toThrow(/newer than this build/);
    expect(meta(db, "schema_version")).toBe(newer);
  });

  it("a rung that throws rolls the whole ladder back, and the next open starts clean", () => {
    const db = bareDb("failing.sqlite");
    const failing: EventsMigration[] = [
      ...EVENTS_MIGRATIONS,
      {
        version: EVENTS_SCHEMA_VERSION + 1,
        description: "fails on purpose",
        up: () => {
          throw new Error("rung failed");
        },
      },
    ];
    expect(() => migrateEventsSchema(db, { migrations: failing, nowMs: CREATED_AT_MS })).toThrow(
      "rung failed",
    );
    expect(names(db, "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")).toEqual([]);
    expect(migrateEventsSchema(db, { nowMs: CREATED_AT_MS })).toMatchObject({
      fromVersion: 0,
      toVersion: 1,
      applied: [1],
    });
  });

  it("the ladder is numbered 1..N: a gap or a reorder is refused before anything runs", () => {
    expect(EVENTS_MIGRATIONS.map((migration) => migration.version)).toEqual(
      EVENTS_MIGRATIONS.map((_, index) => index + 1),
    );
    const db = bareDb("ladder.sqlite");
    const [first] = EVENTS_MIGRATIONS;
    expect(() => migrateEventsSchema(db, { migrations: [{ ...first, version: 2 }] })).toThrow(
      /numbered 1\.\.N/,
    );
    expect(names(db, "SELECT name FROM sqlite_master")).toEqual([]);
  });
});
