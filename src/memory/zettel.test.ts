// Upgrade 9: Zettelkasten auto-linking — backlinks table, link store, k-hop traversal.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeLinkStrength,
  getBacklinks,
  getBreadthFirstNeighbors,
  linkChunks,
} from "./manager-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

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

function insertChunk(d: DatabaseSync, id: string) {
  d.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `/${id}.md`, "memory", 1, 2, `h-${id}`, "mock", `note ${id}`, "[1,0,0]", 1000);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-zettel-"));
  db = open();
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("zettel schema", () => {
  it("creates the backlinks table + related_chunks column idempotently", () => {
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      cacheEnabled: true,
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain("backlinks");
    const cols = (db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols.filter((c) => c === "related_chunks")).toHaveLength(1);
  });
});

describe("computeLinkStrength", () => {
  it("stays within [0,1] at boundaries", () => {
    expect(computeLinkStrength(0, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(computeLinkStrength(1, 0, 1_000_000)).toBeLessThanOrEqual(1);
  });
  it("is monotonic in similarity", () => {
    expect(computeLinkStrength(0.9, 0, 0)).toBeGreaterThan(computeLinkStrength(0.4, 0, 0));
  });
  it("is monotonic (non-decreasing) in access count", () => {
    expect(computeLinkStrength(0.5, 0, 100)).toBeGreaterThan(computeLinkStrength(0.5, 0, 0));
  });
});

describe("linkChunks", () => {
  it("derives link_type from similarity (duplicate >= 0.9, related otherwise)", () => {
    insertChunk(db, "A");
    insertChunk(db, "B");
    insertChunk(db, "C");
    linkChunks(db, "A", "B", 0.95);
    linkChunks(db, "A", "C", 0.75);
    const rows = db
      .prepare("SELECT to_chunk_id AS t, link_type AS lt FROM backlinks WHERE from_chunk_id='A'")
      .all() as Array<{ t: string; lt: string }>;
    const byTarget = Object.fromEntries(rows.map((r) => [r.t, r.lt]));
    expect(byTarget["B"]).toBe("duplicate");
    expect(byTarget["C"]).toBe("related");
  });

  it("upserts on re-link (no duplicate PK, strength updated)", () => {
    insertChunk(db, "A");
    insertChunk(db, "B");
    linkChunks(db, "A", "B", 0.7);
    const first = db
      .prepare(
        "SELECT link_strength AS s FROM backlinks WHERE from_chunk_id='A' AND to_chunk_id='B' AND link_type='related'",
      )
      .get() as { s: number };
    linkChunks(db, "A", "B", 0.85);
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM backlinks WHERE from_chunk_id='A'").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
    const second = db
      .prepare(
        "SELECT link_strength AS s FROM backlinks WHERE from_chunk_id='A' AND to_chunk_id='B' AND link_type='related'",
      )
      .get() as { s: number };
    expect(second.s).toBeGreaterThan(first.s);
  });

  it("refuses to self-link", () => {
    insertChunk(db, "A");
    linkChunks(db, "A", "A", 0.99);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM backlinks").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("maintains link_count on the source chunk", () => {
    insertChunk(db, "A");
    insertChunk(db, "B");
    insertChunk(db, "C");
    linkChunks(db, "A", "B", 0.8);
    linkChunks(db, "A", "C", 0.8);
    const lc = (
      db.prepare("SELECT link_count AS c FROM chunks WHERE id='A'").get() as { c: number }
    ).c;
    expect(lc).toBe(2);
  });
});

describe("getBacklinks", () => {
  it("returns referrers ordered by strength, respecting limit", () => {
    insertChunk(db, "target");
    insertChunk(db, "weak");
    insertChunk(db, "strong");
    linkChunks(db, "weak", "target", 0.71);
    linkChunks(db, "strong", "target", 0.99);
    const all = getBacklinks(db, "target", 10);
    expect(all.map((b) => b.id)).toEqual(["strong", "weak"]);
    expect(all[0].snippet).toContain("note strong");
    const limited = getBacklinks(db, "target", 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe("strong");
  });

  it("drops orphaned backlink rows whose source chunk was deleted", () => {
    insertChunk(db, "target");
    insertChunk(db, "ghost");
    linkChunks(db, "ghost", "target", 0.9);
    db.prepare("DELETE FROM chunks WHERE id='ghost'").run();
    // JOIN drops the missing row instead of crashing
    expect(() => getBacklinks(db, "target")).not.toThrow();
    expect(getBacklinks(db, "target")).toHaveLength(0);
  });
});

describe("getBreadthFirstNeighbors", () => {
  it("walks a chain A->B->C with maxDepth=2 returning {B@1, C@2}", () => {
    insertChunk(db, "A");
    insertChunk(db, "B");
    insertChunk(db, "C");
    linkChunks(db, "A", "B", 0.8);
    linkChunks(db, "B", "C", 0.8);
    const nbrs = getBreadthFirstNeighbors(db, "A", 2);
    const byId = Object.fromEntries(nbrs.map((n) => [n.id, n.depth]));
    expect(byId).toEqual({ B: 1, C: 2 });
  });

  it("terminates on a cycle A->B->A and never revisits A", () => {
    insertChunk(db, "A");
    insertChunk(db, "B");
    linkChunks(db, "A", "B", 0.8);
    linkChunks(db, "B", "A", 0.8);
    const nbrs = getBreadthFirstNeighbors(db, "A", 5);
    expect(nbrs.map((n) => n.id)).toEqual(["B"]);
    expect(nbrs.find((n) => n.id === "A")).toBeUndefined();
  });

  it("respects the limit option", () => {
    insertChunk(db, "A");
    for (const id of ["B", "C", "D"]) {
      insertChunk(db, id);
      linkChunks(db, "A", id, 0.8);
    }
    const nbrs = getBreadthFirstNeighbors(db, "A", 3, { limit: 2 });
    expect(nbrs).toHaveLength(2);
  });
});
