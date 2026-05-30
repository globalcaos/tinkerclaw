// Upgrade 3: bi-temporal graph edges — schema, validity-interval filtering, invalidation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchVector, temporalPredicate } from "./manager-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";
import { invalidate, supersede } from "./temporal-invalidation.js";

let tmpDir: string;
let db: DatabaseSync;

function open(): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const d = new DatabaseSync(join(tmpDir, "index.sqlite"));
  ensureMemoryIndexSchema({
    db: d,
    embeddingCacheTable: "embedding_cache",
    cacheEnabled: true,
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return d;
}

function insertChunk(
  d: DatabaseSync,
  id: string,
  opts: {
    model?: string;
    updatedAt?: number;
    validityStart?: number;
    validityEnd?: number | null;
    ingestionTime?: number;
  } = {},
): void {
  const updatedAt = opts.updatedAt ?? 1000;
  d.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, validity_start, validity_end, ingestion_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `/${id}.md`,
    "memory",
    1,
    2,
    `hash-${id}`,
    opts.model ?? "mock-embed",
    `text for ${id}`,
    JSON.stringify([1, 0, 0]),
    updatedAt,
    opts.validityStart ?? updatedAt,
    opts.validityEnd ?? null,
    opts.ingestionTime ?? updatedAt,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-temporal-"));
  db = open();
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bi-temporal schema", () => {
  it("adds validity + ingestion columns idempotently", () => {
    // run schema again — must not throw and columns appear exactly once
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      cacheEnabled: true,
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    const cols = (db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    for (const c of ["validity_start", "validity_end", "ingestion_time", "superseded_by"]) {
      expect(cols.filter((x) => x === c)).toHaveLength(1);
    }
    const idx = (db.prepare("PRAGMA index_list(chunks)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(idx).toContain("idx_chunks_validity");
  });
});

describe("temporalPredicate", () => {
  it("current mode keeps open intervals (validity_end IS NULL)", () => {
    const p = temporalPredicate("current", "c", undefined, 5000);
    expect(p.sql).toContain("validity_end IS NULL OR c.validity_end > ?");
    expect(p.params).toEqual([5000]);
  });
  it("valid-at mode bounds both ends", () => {
    const p = temporalPredicate("valid-at", "c", 3000, 5000);
    expect(p.sql).toContain("validity_start <= ?");
    expect(p.params).toEqual([3000, 3000]);
  });
  it("all mode is empty", () => {
    expect(temporalPredicate("all", "c").sql).toBe("");
  });
});

describe("invalidate / supersede", () => {
  it("closes the interval and stamps superseded_by without deleting", () => {
    insertChunk(db, "A", { updatedAt: 1000 });
    const before = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
    const res = invalidate(db, "A", "B", "contradicted by B", { validAt: 2000 });
    expect(res.closed).toBe(true);
    const row = db
      .prepare("SELECT validity_end AS ve, superseded_by AS sb FROM chunks WHERE id = ?")
      .get("A") as { ve: number; sb: string };
    expect(row.ve).toBe(2000);
    expect(row.sb).toBe("B");
    const after = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
    expect(after).toBe(before); // no delete
  });

  it("does not rewrite an already-closed interval", () => {
    insertChunk(db, "A", { updatedAt: 1000, validityEnd: 1500 });
    const res = invalidate(db, "A", "B", "again", { validAt: 9000 });
    expect(res.closed).toBe(false);
    const row = db.prepare("SELECT validity_end AS ve FROM chunks WHERE id = ?").get("A") as {
      ve: number;
    };
    expect(row.ve).toBe(1500); // unchanged
  });

  it("supersede uses the new chunk's validity_start as the close time", () => {
    insertChunk(db, "A", { updatedAt: 1000 });
    insertChunk(db, "B", { updatedAt: 4000, validityStart: 4000 });
    supersede(db, "A", "B", "B replaces A");
    const row = db
      .prepare("SELECT validity_end AS ve, superseded_by AS sb FROM chunks WHERE id = ?")
      .get("A") as { ve: number; sb: string };
    expect(row.ve).toBe(4000);
    expect(row.sb).toBe("B");
  });
});

describe("searchVector temporal filtering (brute-force fallback path)", () => {
  // ensureVectorReady=false forces the listChunks-based path, so we exercise the
  // temporal filter without needing the sqlite-vec extension.
  const vectorOff = async () => false;

  it("current mode excludes a chunk whose interval closed in the past", async () => {
    insertChunk(db, "open", { validityEnd: null });
    insertChunk(db, "closed", { validityEnd: 10 }); // closed long ago
    const results = await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "mock-embed",
      queryVec: [1, 0, 0],
      limit: 10,
      snippetMaxChars: 100,
      ensureVectorReady: vectorOff,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
      temporalMode: "current",
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("open");
    expect(ids).not.toContain("closed");
  });

  it("all mode includes a closed chunk", async () => {
    insertChunk(db, "closed", { validityEnd: 10 });
    const results = await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "mock-embed",
      queryVec: [1, 0, 0],
      limit: 10,
      snippetMaxChars: 100,
      ensureVectorReady: vectorOff,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
      temporalMode: "all",
    });
    expect(results.map((r) => r.id)).toContain("closed");
  });

  it("valid-at returns the OLD fact inside its window, the NEW fact at now", async () => {
    // Fact A valid [1000, 5000); fact B valid [5000, open). B superseded A.
    insertChunk(db, "A", { validityStart: 1000, validityEnd: 5000 });
    insertChunk(db, "B", { validityStart: 5000, validityEnd: null });

    const asOfOld = await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "mock-embed",
      queryVec: [1, 0, 0],
      limit: 10,
      snippetMaxChars: 100,
      ensureVectorReady: vectorOff,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
      temporalMode: "valid-at",
      asOfTime: 3000,
    });
    expect(asOfOld.map((r) => r.id)).toEqual(["A"]);

    const asOfNow = await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "mock-embed",
      queryVec: [1, 0, 0],
      limit: 10,
      snippetMaxChars: 100,
      ensureVectorReady: vectorOff,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
      temporalMode: "valid-at",
      asOfTime: 9000,
    });
    expect(asOfNow.map((r) => r.id)).toEqual(["B"]);
  });
});
