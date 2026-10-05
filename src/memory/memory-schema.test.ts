// Guards the chunks-table index set that ensureMemoryIndexSchema is responsible for.
//
// idx_chunks_fact_identity is a PERFORMANCE contract, and performance contracts are the ones
// no functional test notices breaking: without it the planner falls back to idx_chunks_source
// and effectively scans every row of that source (measured 56-66 ms per supersede lookup on
// the live store, ~2,800 times per session re-index — the bulk of the 130-180 s gateway
// main-thread freeze of 2026-09-03). So this file asserts three separate things: that the
// index exists, that its COLUMN ORDER is the one the hot query can seek on, and that SQLite
// actually picks it. The third is the one that survives a well-meaning refactor.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

let tmpDir: string;
let db: DatabaseSync;

function ensure(target: DatabaseSync): void {
  ensureMemoryIndexSchema({
    db: target,
    embeddingCacheTable: "embedding_cache",
    cacheEnabled: true,
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
}

function open(): DatabaseSync {
  const { DatabaseSync: Ctor } = requireNodeSqlite();
  const opened = new Ctor(join(tmpDir, "index.sqlite"));
  ensure(opened);
  return opened;
}

function chunkIndexNames(target: DatabaseSync): string[] {
  return (target.prepare("PRAGMA index_list(chunks)").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-schema-"));
  db = open();
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ensureMemoryIndexSchema chunk indexes", () => {
  it("creates the composite fact-identity index on a fresh database", () => {
    expect(chunkIndexNames(db)).toContain("idx_chunks_fact_identity");
  });

  it("indexes the fact-identity columns in the order the supersede lookup pins them", () => {
    // Equality columns first so the seek uses all of them, validity_end last. Reordering
    // these silently demotes the index to a prefix match and the freeze comes back.
    const columns = (
      db.prepare("PRAGMA index_info(idx_chunks_fact_identity)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(["source", "path", "start_line", "end_line", "validity_end"]);
  });

  it("is idempotent — re-running the schema neither throws nor duplicates the index", () => {
    // This is what running against the existing multi-GB store does on every open.
    expect(() => ensure(db)).not.toThrow();
    expect(chunkIndexNames(db).filter((name) => name === "idx_chunks_fact_identity")).toHaveLength(
      1,
    );
  });

  it("is the index SQLite actually chooses for the supersede fact-identity lookup", () => {
    // Mirrors findSupersededChunkIds' WHERE (engram/supersede-writer.ts). Literals rather
    // than bound parameters so EXPLAIN QUERY PLAN needs no bindings; planning is identical.
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT id FROM chunks
              WHERE source = 'sessions'
                AND path = '/session.jsonl'
                AND start_line = 1
                AND end_line = 2
                AND model = 'mock-embed'
                AND hash <> 'h'
                AND id <> 'c'
                AND validity_start < 1000
                AND validity_end IS NULL`,
        )
        .all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toContain("idx_chunks_fact_identity");
  });

  it("also serves the once-per-file prior-open probe from the same index", () => {
    // manager-embedding-ops.hasPriorOpenInterval uses the (source, path) prefix.
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT 1 AS present FROM chunks
              WHERE source = 'sessions'
                AND path = '/session.jsonl'
                AND validity_start < 1000
                AND validity_end IS NULL
              LIMIT 1`,
        )
        .all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toContain("idx_chunks_fact_identity");
  });
});
