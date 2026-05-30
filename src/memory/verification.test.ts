// Upgrade 6: retrieve verified code by embedding — schema, rankByVerification, coverage mapper.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankByVerification } from "./manager-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";
import type { VerificationStatus } from "./storage/types.js";
import {
  coveredFraction,
  mapCoverageToChunks,
  statusForCoverage,
  type IstanbulCoverage,
} from "./verification-mapper.js";

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
  path: string,
  startLine: number,
  endLine: number,
) {
  d.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, path, "memory", startLine, endLine, `h-${id}`, "mock", `code ${id}`, "[1,0,0]", 1000);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-verify-"));
  db = open();
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("verification schema", () => {
  it("adds columns idempotently with the right defaults", () => {
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
    for (const c of [
      "verification_status",
      "test_coverage_percent",
      "verified_by",
      "verification_timestamp",
    ]) {
      expect(cols.filter((x) => x === c)).toHaveLength(1);
    }
    insertChunk(db, "c1", "/a.ts", 1, 10);
    const row = db
      .prepare(
        "SELECT verification_status AS vs, test_coverage_percent AS tc FROM chunks WHERE id = ?",
      )
      .get("c1") as { vs: string; tc: number | null };
    expect(row.vs).toBe("unverified");
    expect(row.tc).toBeNull();
  });
});

describe("rankByVerification", () => {
  const mk = (id: string, score: number, status: VerificationStatus, cov?: number) => ({
    id,
    score,
    verificationStatus: status,
    testCoveragePercent: cov ?? null,
  });

  it("boosts a verified chunk above an unverified one with higher raw cosine", () => {
    // unverified 0.6 * 1.0 = 0.60 ; verified 0.45 * 1.5 = 0.675 → verified wins
    const ranked = rankByVerification([mk("u", 0.6, "unverified"), mk("v", 0.45, "verified")]);
    expect(ranked.map((r) => r.id)).toEqual(["v", "u"]);
    expect(ranked[0].score).toBeCloseTo(0.675, 5);
  });

  it("penalizes failed (×0.5) but does not drop it", () => {
    const ranked = rankByVerification([mk("f", 0.9, "failed"), mk("u", 0.5, "unverified")]);
    // failed 0.9*0.5=0.45 ; unverified 0.5*1.0=0.5 → unverified first, failed retained
    expect(ranked.map((r) => r.id)).toEqual(["u", "f"]);
    expect(ranked.find((r) => r.id === "f")).toBeDefined();
  });

  it("verificationRequired drops all non-verified rows", () => {
    const ranked = rankByVerification(
      [mk("v", 0.4, "verified"), mk("p", 0.9, "partial"), mk("u", 0.95, "unverified")],
      { verificationRequired: true },
    );
    expect(ranked.map((r) => r.id)).toEqual(["v"]);
  });

  it("minTestCoverage filters by coverage", () => {
    const ranked = rankByVerification(
      [mk("low", 0.9, "partial", 50), mk("high", 0.5, "verified", 90)],
      { minTestCoverage: 80 },
    );
    expect(ranked.map((r) => r.id)).toEqual(["high"]);
  });
});

describe("coverage mapper", () => {
  it("coveredFraction computes the percent of covered lines in a range", () => {
    const file = {
      path: "/a.ts",
      statementMap: {
        "0": { start: { line: 1 }, end: { line: 2 } },
        "1": { start: { line: 3 }, end: { line: 4 } },
        "2": { start: { line: 5 }, end: { line: 6 } },
      },
      s: { "0": 3, "1": 0, "2": 1 }, // lines 1-2 hit, 3-4 not, 5-6 hit
    };
    // range 1..6 → 4 of 6 lines covered → 67
    expect(coveredFraction(file, 1, 6)).toBe(67);
    // range 3..4 → 0 covered
    expect(coveredFraction(file, 3, 4)).toBe(0);
  });

  it("statusForCoverage thresholds at 80", () => {
    expect(statusForCoverage(0)).toBe("unverified");
    expect(statusForCoverage(50)).toBe("partial");
    expect(statusForCoverage(80)).toBe("verified");
    expect(statusForCoverage(100)).toBe("verified");
  });

  it("mapCoverageToChunks stamps status/coverage/verified_by/timestamp", () => {
    insertChunk(db, "full", "/a.ts", 1, 4); // fully covered
    insertChunk(db, "half", "/a.ts", 1, 8); // half covered
    insertChunk(db, "none", "/a.ts", 5, 8); // uncovered
    const coverage: IstanbulCoverage = {
      "/a.ts": {
        path: "/a.ts",
        statementMap: {
          "0": { start: { line: 1 }, end: { line: 4 } },
        },
        s: { "0": 1 }, // lines 1-4 covered, 5-8 not
      },
    };
    const updated = mapCoverageToChunks(db, coverage, {
      testFileFor: () => "/a.test.ts",
      now: 7777,
    });
    expect(updated).toBe(3);
    const get = (id: string) =>
      db
        .prepare(
          "SELECT verification_status AS vs, test_coverage_percent AS tc, verified_by AS vb, verification_timestamp AS ts FROM chunks WHERE id = ?",
        )
        .get(id) as { vs: string; tc: number; vb: string; ts: number };
    expect(get("full").vs).toBe("verified");
    expect(get("full").tc).toBe(100);
    expect(get("full").vb).toBe("/a.test.ts");
    expect(get("full").ts).toBe(7777);
    expect(get("half").vs).toBe("partial"); // 4 of 8 = 50%
    expect(get("none").vs).toBe("unverified");
  });
});
