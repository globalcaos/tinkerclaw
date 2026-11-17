import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery ORs the query's keywords", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
    // extractKeywords lowercases, splits on punctuation (the underscore too), drops bare numbers.
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"foo" OR "bar" OR "baz"');
    // Stop words leave a natural-language question; quotes in the input never reach FTS5.
    expect(buildFtsQuery("how did we fix the backup cron timeout?")).toBe(
      '"fix" OR "backup" OR "cron" OR "timeout"',
    );
    expect(buildFtsQuery('say "cheese" now')).toBe('"say" OR "cheese"');
    // CJK: extractKeywords emits every character and every bigram of a run.
    expect(buildFtsQuery("金银价格")).toBe(
      '"金" OR "银" OR "价" OR "格" OR "金银" OR "银价" OR "价格"',
    );
    expect(buildFtsQuery("価格 2026年")).toBe('"価" OR "格" OR "価格" OR "年"');
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("?!")).toBeNull();
  });

  it("buildFtsQuery ORs the raw tokens when no keyword survives", () => {
    expect(buildFtsQuery("what is that")).toBe('"what" OR "is" OR "that"');
    expect(buildFtsQuery("hi")).toBe('"hi"');
    expect(buildFtsQuery("2026")).toBe('"2026"');
  });

  it("buildFtsQuery finds rows an AND of every token misses, fullest match first", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      // The real schema, so the tokenizer under test is the one the index uses.
      const { ftsAvailable } = ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        cacheEnabled: false,
        ftsTable: "chunks_fts",
        ftsEnabled: true,
      });
      expect(ftsAvailable).toBe(true);
      const insert = db.prepare(
        "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, 'memory', 'm', 1, 1)",
      );
      const rows: Array<[string, string]> = [
        ["target", "The backup cron hit its timeout; the fix raised the limit."],
        ["cron-only", "The cron schedule for the weather digest runs at seven."],
        ["backup-only", "Backup photos go to the external disk on Sundays."],
        ["unrelated", "Release notes for the documentation site."],
      ];
      for (const [id, text] of rows) {
        insert.run(text, id, `memory/${id}.md`);
      }
      const match = (query: string) =>
        (
          db
            .prepare("SELECT id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)")
            .all(query) as Array<{ id: string }>
        ).map((row) => row.id);

      const question = "how did we fix the backup cron timeout?";
      // What this builder returned before 2026-10-29: every raw token, ANDed. No row has all 8.
      const andQuery =
        '"how" AND "did" AND "we" AND "fix" AND "the" AND "backup" AND "cron" AND "timeout"';
      expect(match(andQuery)).toEqual([]);

      const orQuery = buildFtsQuery(question);
      expect(orQuery).not.toBeNull();
      const ids = match(orQuery ?? "");
      // The row with all four keywords ranks first; rows with one keyword still come back.
      expect(ids[0]).toBe("target");
      expect(ids.slice(1).toSorted()).toEqual(["backup-only", "cron-only"]);
    } finally {
      db.close();
    }
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1, 1);
  });

  it("bm25RankToScore preserves FTS5 BM25 relevance ordering", () => {
    const strongest = bm25RankToScore(-4.2);
    const middle = bm25RankToScore(-2.1);
    const weakest = bm25RankToScore(-0.5);

    expect(strongest).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(weakest);
    expect(strongest).not.toBe(middle);
    expect(middle).not.toBe(weakest);
  });

  it("mergeHybridResults unions by id and combines weighted scores", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(b?.score).toBeCloseTo(0.3 * 1.0);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1.0);
  });
});
