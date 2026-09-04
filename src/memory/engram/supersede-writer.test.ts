// ENGRAM Upgrade 3 (J14): bi-temporal SUPERSEDE-WRITER.
// Verifies that a contradicting write CLOSES the prior fact's validity interval (non-lossy)
// instead of leaving both open, and that the prior row remains queryable in 'all'/'valid-at'.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchVector } from "../manager-search.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { requireNodeSqlite } from "../sqlite.js";
import {
  applySupersede,
  decideSupersede,
  findSupersededChunkIds,
  supersedeContradictions,
  type WriteDecision,
} from "./supersede-writer.js";

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

/** Insert a chunk row. Defaults make a currently-valid (validity_end NULL) fact. */
function insertChunk(
  d: DatabaseSync,
  id: string,
  opts: {
    path?: string;
    source?: string;
    startLine?: number;
    endLine?: number;
    hash?: string;
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
    opts.path ?? "/fact.md",
    opts.source ?? "memory",
    opts.startLine ?? 1,
    opts.endLine ?? 2,
    opts.hash ?? `hash-${id}`,
    opts.model ?? "mock-embed",
    `text for ${id}`,
    JSON.stringify([1, 0, 0]),
    updatedAt,
    opts.validityStart ?? updatedAt,
    opts.validityEnd ?? null,
    opts.ingestionTime ?? updatedAt,
  );
}

/** The candidate identity descriptor the gate/writer consumes. */
function candidate(
  id: string,
  o: Partial<{
    path: string;
    source: string;
    startLine: number;
    endLine: number;
    model: string;
    hash: string;
    validityStart: number;
  }> = {},
) {
  return {
    id,
    path: o.path ?? "/fact.md",
    source: o.source ?? "memory",
    startLine: o.startLine ?? 1,
    endLine: o.endLine ?? 2,
    model: o.model ?? "mock-embed",
    hash: o.hash ?? `hash-${id}`,
    validityStart: o.validityStart ?? 5000,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-supersede-"));
  db = open();
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("findSupersededChunkIds (per-chunk identity)", () => {
  it("matches a prior open-interval chunk at the same identity with a different hash", () => {
    insertChunk(db, "A", { hash: "h-old" });
    const ids = findSupersededChunkIds(db, candidate("B", { hash: "h-new" }));
    expect(ids).toEqual(["A"]);
  });

  it("ignores chunks at a different path / line span (different fact identity)", () => {
    insertChunk(db, "A", { path: "/other.md", hash: "h-old" });
    insertChunk(db, "C", { startLine: 9, endLine: 10, hash: "h-old" });
    expect(findSupersededChunkIds(db, candidate("B", { hash: "h-new" }))).toEqual([]);
  });

  it("ignores an already-closed prior interval (only supersedes live facts)", () => {
    insertChunk(db, "A", { hash: "h-old", validityEnd: 1500 });
    expect(findSupersededChunkIds(db, candidate("B", { hash: "h-new" }))).toEqual([]);
  });

  it("does not self-contradict an unchanged re-index (same id or same hash)", () => {
    insertChunk(db, "A", { hash: "h-same" });
    // same hash → genuinely identical content, not a contradiction
    expect(findSupersededChunkIds(db, candidate("B", { hash: "h-same" }))).toEqual([]);
    // same id → re-indexing the very same row
    expect(findSupersededChunkIds(db, candidate("A", { hash: "h-old" }))).toEqual([]);
  });

  // FORK 2026-09-03 regression — enforceEmbeddingMaxInputTokens() splits an over-long chunk
  // into fragments that all inherit the parent's startLine/endLine and differ only by hash.
  // They are ONE fact, not competing revisions, and they are written in the same pass with
  // the same validity_start. Before the `validity_start <` clause each fragment closed its
  // predecessor, so only the last one stayed currently-valid.
  it("does not supersede a sibling fragment written in the SAME indexing pass", () => {
    // three fragments of one over-long line, same span, same pass timestamp
    insertChunk(db, "frag-1", { startLine: 281, endLine: 281, hash: "h-1", validityStart: 5000 });
    insertChunk(db, "frag-2", { startLine: 281, endLine: 281, hash: "h-2", validityStart: 5000 });
    const third = candidate("frag-3", {
      startLine: 281,
      endLine: 281,
      hash: "h-3",
      validityStart: 5000,
    });
    expect(findSupersededChunkIds(db, third)).toEqual([]);
    expect(decideSupersede(db, third).action).toBe("allow");
  });

  it("still supersedes a genuinely earlier revision at the same span", () => {
    insertChunk(db, "old", { startLine: 281, endLine: 281, hash: "h-old", validityStart: 1000 });
    const next = candidate("new", {
      startLine: 281,
      endLine: 281,
      hash: "h-new",
      validityStart: 5000,
    });
    expect(findSupersededChunkIds(db, next)).toEqual(["old"]);
  });

  it("leaves every fragment of a split chunk currently-valid after a full pass", () => {
    const pass = 5000;
    const frags = ["f1", "f2", "f3", "f4"];
    for (const id of frags) {
      // persist, then run the writer exactly as manager-embedding-ops does per chunk
      insertChunk(db, id, { startLine: 281, endLine: 281, hash: `h-${id}`, validityStart: pass });
      supersedeContradictions(db, {
        ...candidate(id, {
          startLine: 281,
          endLine: 281,
          hash: `h-${id}`,
          validityStart: pass,
        }),
      });
    }
    const open = db
      .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE start_line = 281 AND validity_end IS NULL`)
      .get() as { n: number };
    expect(open.n).toBe(frags.length);
  });
});

describe("decideSupersede (gate becomes a validity-writer)", () => {
  it("returns allow when nothing contradicts", () => {
    const d = decideSupersede(db, candidate("B"));
    expect(d.action).toBe("allow");
  });

  it("DEFAULTS to supersede (non-lossy) when a prior fact contradicts", () => {
    insertChunk(db, "A", { hash: "h-old" });
    const d = decideSupersede(db, candidate("B", { hash: "h-new" }));
    expect(d.action).toBe("supersede");
    if (d.action === "supersede") {
      expect(d.supersedes).toEqual(["A"]);
      expect(d.reason).toContain("supersedes");
    }
  });

  it("preserves the legacy warn mode without acting", () => {
    insertChunk(db, "A", { hash: "h-old" });
    const d = decideSupersede(db, candidate("B", { hash: "h-new" }), "warn");
    expect(d.action).toBe("warn");
  });
});

describe("applySupersede (closes the prior interval, non-lossy)", () => {
  it("a contradicting write CLOSES the prior interval and stamps superseded_by", () => {
    insertChunk(db, "A", { hash: "h-old", updatedAt: 1000 });
    insertChunk(db, "B", { hash: "h-new", updatedAt: 5000, validityStart: 5000 });

    const before = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
    const decision = decideSupersede(db, candidate("B", { hash: "h-new", validityStart: 5000 }));
    const applied = applySupersede(db, decision, { id: "B", validityStart: 5000 });

    expect(applied.closed).toEqual(["A"]);
    const row = db
      .prepare("SELECT validity_end AS ve, superseded_by AS sb FROM chunks WHERE id = ?")
      .get("A") as { ve: number; sb: string };
    // prior interval closed exactly at the new fact's validity_start
    expect(row.ve).toBe(5000);
    expect(row.sb).toBe("B");
    // NON-LOSSY: the prior row is retained (no DELETE)
    const after = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
    expect(after).toBe(before);
    // the new fact stays open (currently valid)
    const bRow = db.prepare("SELECT validity_end AS ve FROM chunks WHERE id = ?").get("B") as {
      ve: number | null;
    };
    expect(bRow.ve).toBeNull();
  });

  it("is a no-op for warn/block decisions (both rows stay open — legacy behaviour)", () => {
    insertChunk(db, "A", { hash: "h-old" });
    const warn = decideSupersede(db, candidate("B", { hash: "h-new" }), "warn");
    const applied = applySupersede(db, warn, { id: "B", validityStart: 5000 });
    expect(applied.closed).toEqual([]);
    const row = db.prepare("SELECT validity_end AS ve FROM chunks WHERE id = ?").get("A") as {
      ve: number | null;
    };
    expect(row.ve).toBeNull(); // still open — nothing closed
  });

  it("skips an already-closed prior interval without rewriting history", () => {
    insertChunk(db, "A", { hash: "h-old", validityEnd: 1500 });
    // force a decision that targets A even though it is closed
    const decision: WriteDecision = {
      action: "supersede",
      supersedes: ["A"],
      reason: "manual",
    };
    const applied = applySupersede(db, decision, { id: "B", validityStart: 5000 });
    expect(applied.closed).toEqual([]);
    expect(applied.skipped).toEqual(["A"]);
    const row = db.prepare("SELECT validity_end AS ve FROM chunks WHERE id = ?").get("A") as {
      ve: number;
    };
    expect(row.ve).toBe(1500); // unchanged — no rewrite
  });
});

describe("supersedeContradictions (one-shot writer) + read-path retention", () => {
  it("after supersede: prior row is HIDDEN in 'current' but RETAINED in 'all'/'valid-at'", async () => {
    // A valid from 1000 (open); B (the new revision) inserted valid from 5000 (open).
    insertChunk(db, "A", { hash: "h-old", updatedAt: 1000, validityStart: 1000 });
    insertChunk(db, "B", { hash: "h-new", updatedAt: 5000, validityStart: 5000 });

    const { decision, applied } = supersedeContradictions(db, {
      ...candidate("B", { hash: "h-new", validityStart: 5000 }),
    });
    expect(decision.action).toBe("supersede");
    expect(applied.closed).toEqual(["A"]);

    const vectorOff = async () => false;
    const baseSearch = {
      db,
      vectorTable: "chunks_vec",
      providerModel: "mock-embed",
      queryVec: [1, 0, 0],
      limit: 10,
      snippetMaxChars: 100,
      ensureVectorReady: vectorOff,
      sourceFilterVec: { sql: "", params: [] as string[] },
      sourceFilterChunks: { sql: "", params: [] as string[] },
    };

    // 'current' (default read mode): only the live fact B survives the temporal filter.
    const cur = await searchVector({ ...baseSearch, temporalMode: "current" });
    expect(cur.map((r) => r.id).sort()).toEqual(["B"]);

    // 'all': the superseded fact A is still present and queryable (NON-LOSSY).
    const all = await searchVector({ ...baseSearch, temporalMode: "all" });
    expect(all.map((r) => r.id).sort()).toEqual(["A", "B"]);

    // 'valid-at' inside A's old window (1000 <= 3000 < 5000): A is "what was true then".
    const then = await searchVector({ ...baseSearch, temporalMode: "valid-at", asOfTime: 3000 });
    expect(then.map((r) => r.id)).toEqual(["A"]);

    // 'valid-at' at now (>= 5000): only B.
    const nowSlice = await searchVector({
      ...baseSearch,
      temporalMode: "valid-at",
      asOfTime: 9000,
    });
    expect(nowSlice.map((r) => r.id)).toEqual(["B"]);
  });

  it("no-op when the candidate introduces a brand-new fact (no prior identity)", () => {
    insertChunk(db, "B", { path: "/brand-new.md", hash: "h-new", validityStart: 5000 });
    const { decision, applied } = supersedeContradictions(db, {
      ...candidate("B", { path: "/brand-new.md", hash: "h-new", validityStart: 5000 }),
    });
    expect(decision.action).toBe("allow");
    expect(applied.closed).toEqual([]);
  });

  it("warn mode leaves both facts open (opt-out of the writer)", async () => {
    insertChunk(db, "A", { hash: "h-old", updatedAt: 1000, validityStart: 1000 });
    insertChunk(db, "B", { hash: "h-new", updatedAt: 5000, validityStart: 5000 });
    const { applied } = supersedeContradictions(
      db,
      { ...candidate("B", { hash: "h-new", validityStart: 5000 }) },
      { mode: "warn" },
    );
    expect(applied.closed).toEqual([]);
    const aRow = db.prepare("SELECT validity_end AS ve FROM chunks WHERE id = ?").get("A") as {
      ve: number | null;
    };
    expect(aRow.ve).toBeNull(); // still open
  });
});
