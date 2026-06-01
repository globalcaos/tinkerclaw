// ENGRAM Upgrade 3 (J14): SUPERSEDE-WRITER producer hook.
// Verifies the additive opts.onClosed callback fires (once, with the closed ids + reason)
// only when supersedeContradictions actually closes a prior interval — the seam the
// caller uses to emit a fork.prefrontal.trailEvent kind='recipe-supersede' to the UI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { requireNodeSqlite } from "../sqlite.js";
import { supersedeContradictions } from "./supersede-writer.js";

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

function insertChunk(d: DatabaseSync, id: string, hash: string, validityStart: number): void {
  d.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, validity_start, validity_end, ingestion_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "/fact.md",
    "memory",
    1,
    2,
    hash,
    "mock-embed",
    `text for ${id}`,
    JSON.stringify([1, 0, 0]),
    validityStart,
    validityStart,
    null,
    validityStart,
  );
}

function candidate(id: string, hash: string, validityStart: number) {
  return {
    id,
    path: "/fact.md",
    source: "memory",
    startLine: 1,
    endLine: 2,
    model: "mock-embed",
    hash,
    validityStart,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-supersede-emit-"));
  db = open();
});
afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("supersedeContradictions onClosed producer hook", () => {
  it("fires onClosed once with the closed ids + reason when an interval is closed", () => {
    insertChunk(db, "A", "h-old", 1000);
    insertChunk(db, "B", "h-new", 5000);
    const onClosed = vi.fn();
    const { applied } = supersedeContradictions(db, candidate("B", "h-new", 5000), { onClosed });
    expect(applied.closed).toEqual(["A"]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    const [closedIds, reason] = onClosed.mock.calls[0];
    expect(closedIds).toEqual(["A"]);
    expect(typeof reason).toBe("string");
    expect(reason).toMatch(/supersede/i);
  });

  it("does NOT fire onClosed when there is nothing to supersede (brand-new fact)", () => {
    insertChunk(db, "B", "h-new", 5000);
    const onClosed = vi.fn();
    const { decision } = supersedeContradictions(db, candidate("B", "h-new", 5000), { onClosed });
    expect(decision.action).toBe("allow");
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("does NOT fire onClosed in 'warn' mode (writer opted out)", () => {
    insertChunk(db, "A", "h-old", 1000);
    insertChunk(db, "B", "h-new", 5000);
    const onClosed = vi.fn();
    supersedeContradictions(db, candidate("B", "h-new", 5000), { mode: "warn", onClosed });
    expect(onClosed).not.toHaveBeenCalled();
  });
});
