// Regression guard for the FTS5 ALIAS TRAP in searchKeyword (fixed 2026-08-03).
//
// searchKeyword() addressed the FTS5 table through its JOIN alias in the two places where
// SQLite does not accept an alias: the bm25() argument and the MATCH left-hand side. FTS5
// exposes a hidden column named after the TABLE, never after the alias, so `bm25(f)` and
// `f MATCH ?` both failed at PREPARE time with "no such column: f" — on EVERY call, for every
// query. MemoryIndexManager.search() wrapped the call in `.catch(() => [])`, so a hard SQL
// error was indistinguishable from "nothing matched" and fork.memory.search silently returned
// [] for months.
//
// These tests run the REAL searchKeyword against a real temp SQLite file with the REAL schema.
// Against the pre-fix source they FAIL (searchKeyword throws "no such column: f", so the
// awaited expectations reject); against the fixed source they PASS. Verified both ways.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";
import { searchKeyword } from "./manager-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

const FTS_TABLE = "chunks_fts";
const MODEL = "mock-embed";

let tmpDir: string;
let db: DatabaseSync;
let ftsAvailable: boolean;

function open(): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const d = new DatabaseSync(join(tmpDir, "index.sqlite"));
  const res = ensureMemoryIndexSchema({
    db: d,
    embeddingCacheTable: "embedding_cache",
    cacheEnabled: true,
    ftsTable: FTS_TABLE,
    ftsEnabled: true,
  });
  ftsAvailable = res.ftsAvailable;
  return d;
}

/** Insert into BOTH tables: searchKeyword JOINs chunks for the temporal/trust columns. */
function insertChunk(
  d: DatabaseSync,
  id: string,
  text: string,
  opts: { source?: string; model?: string; validityEnd?: number | null } = {},
): void {
  const source = opts.source ?? "memory";
  const model = opts.model ?? MODEL;
  d.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, validity_start, validity_end, ingestion_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `/${id}.md`,
    source,
    1,
    2,
    `hash-${id}`,
    model,
    text,
    JSON.stringify([1, 0, 0]),
    1000,
    1000,
    opts.validityEnd ?? null,
    1000,
  );
  d.prepare(
    `INSERT INTO ${FTS_TABLE} (id, path, source, start_line, end_line, text, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `/${id}.md`, source, 1, 2, text, model);
}

function run(query: string, overrides: Record<string, unknown> = {}) {
  return searchKeyword({
    db,
    ftsTable: FTS_TABLE,
    providerModel: MODEL,
    query,
    limit: 10,
    snippetMaxChars: 200,
    sourceFilter: { sql: "", params: [] },
    buildFtsQuery,
    bm25RankToScore,
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-keyword-"));
  db = open();
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("searchKeyword against a real FTS5 table", () => {
  it("has FTS5 compiled in (guards against a vacuously-passing suite)", () => {
    expect(ftsAvailable).toBe(true);
  });

  // THE regression test: pre-fix this rejects with "no such column: f".
  it("returns a hit for a term that is present", async () => {
    insertChunk(db, "A", "the quick brown fox jumps over the lazy dog");
    insertChunk(db, "B", "completely unrelated content about submarines");

    const results = await run("brown");

    expect(results.map((r) => r.id)).toEqual(["A"]);
    expect(results[0]?.snippet).toContain("brown");
    expect(results[0]?.path).toBe("/A.md");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("does not throw on a query that legitimately matches nothing", async () => {
    insertChunk(db, "A", "the quick brown fox");
    // The whole point of the bug: an EMPTY result must mean "no match", not "the SQL blew up".
    await expect(run("zzzzznotpresent")).resolves.toEqual([]);
  });

  it("still applies the model, source and temporal filters through the alias", async () => {
    // Ordinary columns DO resolve through `f`, so the fix must not have disturbed them.
    insertChunk(db, "keep", "shared token widget");
    insertChunk(db, "othermodel", "shared token widget", { model: "different-model" });
    insertChunk(db, "othersource", "shared token widget", { source: "session" });
    insertChunk(db, "expired", "shared token widget", { validityEnd: 10 });

    const all = await run("widget");
    expect(all.map((r) => r.id).toSorted()).toEqual(["keep", "othersource"]);

    const filtered = await run("widget", {
      sourceFilter: { sql: " AND source = ?", params: ["memory"] },
    });
    expect(filtered.map((r) => r.id)).toEqual(["keep"]);

    // temporalMode "all" lets the closed interval back in.
    const historical = await run("widget", { temporalMode: "all" });
    expect(historical.map((r) => r.id)).toContain("expired");
  });

  it("orders by bm25 rank, so the denser match wins", async () => {
    insertChunk(db, "dense", "kernel kernel kernel kernel");
    insertChunk(db, "sparse", "kernel plus a great deal of surrounding filler text to dilute it");

    const results = await run("kernel");

    expect(results.map((r) => r.id)).toEqual(["dense", "sparse"]);
    // bm25 returns negative "more relevant" ranks; the score mapping must stay monotonic.
    expect(results[0]?.textScore).toBeGreaterThan(results[1]?.textScore ?? Number.NaN);
  });
});
