/**
 * Tests for hippocampus-enhancement.ts and hippocampus-rebuild.ts
 * Run: pnpm test -- src/memory/engram --reporter=dot
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  jaccard,
  cosineSimText,
  computeImportance,
  weightedScore,
  enhanceIndex,
  EpisodicBuffer,
  type IndexChunk,
  type HippocampusIndex,
} from "./hippocampus-enhancement.js";
import { scheduleNightlyRebuild } from "./hippocampus-rebuild.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `hippo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeIndex(dir: string, index: HippocampusIndex): string {
  const path = join(dir, "hippocampus-index.json");
  writeFileSync(path, JSON.stringify(index, null, 2));
  return path;
}

function makeChunk(preview: string, score = 0.5, importance?: number): IndexChunk {
  return {
    path: `memory/${preview.slice(0, 10).replace(/\s/g, "_")}.md`,
    line: 1,
    score,
    source: "memory",
    preview,
    importance,
  };
}

// ---------------------------------------------------------------------------
// Section 1: Helpers — jaccard + weightedScore
// ---------------------------------------------------------------------------

describe("jaccard()", () => {
  it("returns 1.0 for identical sets", () => {
    const s = new Set(["foo", "bar", "baz"]);
    expect(jaccard(s, s)).toBe(1);
  });

  it("returns 0.0 for disjoint sets", () => {
    expect(jaccard(new Set(["hello"]), new Set(["world"]))).toBe(0);
  });

  it("returns correct value for partial overlap", () => {
    // |{a,b} ∩ {b,c}| = 1, |{a,b,c}| = 3 → 1/3
    const result = jaccard(new Set(["aaa", "bbb"]), new Set(["bbb", "ccc"]));
    expect(result).toBeCloseTo(1 / 3, 5);
  });

  it("handles empty sets gracefully", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(["foo"]), new Set())).toBe(0);
  });
});

describe("weightedScore()", () => {
  it("returns base score unchanged at importance=5", () => {
    expect(weightedScore(0.5, 5)).toBeCloseTo(0.5);
  });

  it("boosts score above base for importance > 5", () => {
    expect(weightedScore(0.5, 10)).toBeGreaterThan(0.5);
  });

  it("reduces score below base for importance < 5", () => {
    expect(weightedScore(0.5, 1)).toBeLessThan(0.5);
  });

  it("applies formula: base * (1 + 0.15 * (imp - 5) / 5)", () => {
    const imp = 8;
    const expected = 0.6 * (1 + 0.15 * (imp - 5) / 5);
    expect(weightedScore(0.6, imp)).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// Section 2: enhanceIndex
// ---------------------------------------------------------------------------

describe("enhanceIndex()", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });

  it("preserves existing anchors and chunks", () => {
    const idx: HippocampusIndex = {
      "alpha beta gamma": [makeChunk("alpha beta gamma delta epsilon zeta")],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path);
    expect(Object.keys(result)).toContain("alpha beta gamma");
    expect(result["alpha beta gamma"]).toHaveLength(1);
  });

  it("applies importance weighting: score changes with non-default importance", () => {
    const baseScore = 0.5;
    const idx: HippocampusIndex = {
      anchor: [
        { ...makeChunk("foo bar baz", baseScore), importance: 10 },
        { ...makeChunk("qux quux corge", baseScore), importance: 1 },
      ],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path);
    const [high, low] = result["anchor"];
    expect(high.score).toBeGreaterThan(baseScore);
    expect(low.score).toBeLessThan(baseScore);
  });

  it("merges chunks with Jaccard similarity > 0.9 (keeps richer)", () => {
    // long has 11 words ≥3 chars, short has 10 of the same → Jaccard ≈ 0.909 (>0.9)
    const long  = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const short = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const idx: HippocampusIndex = {
      "alpha bravo": [
        makeChunk(long, 0.5),
        makeChunk(short, 0.5),
      ],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path, { mergeThreshold: 0.9 });
    // Should be merged down to 1 chunk
    expect(result["alpha bravo"]).toHaveLength(1);
    expect(result["alpha bravo"][0].merged).toBe(true);
    // Richer (longer) preview is kept
    expect(result["alpha bravo"][0].preview).toBe(long);
  });

  it("flags chunks with Jaccard 0.7–0.9 as related without merging", () => {
    // 11 words each, 10 shared → Jaccard = 10/12 ≈ 0.833 (in 0.7-0.9 band)
    const a = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const b = "alpha bravo charlie delta echo foxtrot golf hotel india juliet lima";
    const idx: HippocampusIndex = {
      letters: [makeChunk(a), makeChunk(b)],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path, { mergeThreshold: 0.9, relatedThreshold: 0.7 });
    // Both should survive as distinct chunks (not merged)
    expect(result["letters"]).toHaveLength(2);
    // At least one should carry a related reference
    const hasRelated = result["letters"].some(
      (c) => Array.isArray(c.related) && c.related.length > 0,
    );
    expect(hasRelated).toBe(true);
  });

  it("leaves distinct chunks (<0.7 Jaccard) untouched", () => {
    const a = "completely different topic about cooking recipes";
    const b = "software engineering typescript unit testing practices";
    const idx: HippocampusIndex = {
      mixed: [makeChunk(a), makeChunk(b)],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path, { mergeThreshold: 0.9, relatedThreshold: 0.7 });
    expect(result["mixed"]).toHaveLength(2);
    result["mixed"].forEach((c) => {
      expect(c.merged).toBeUndefined();
    });
  });

  it("writes enhanced index back to disk", () => {
    const idx: HippocampusIndex = { test: [makeChunk("hello world test value")] };
    const path = writeIndex(tmpDir, idx);
    enhanceIndex(path);
    const reread = JSON.parse(readFileSync(path, "utf-8"));
    expect(reread).toBeDefined();
    expect(Object.keys(reread)).toContain("test");
  });
});

// ---------------------------------------------------------------------------
// Section 2b: cosineSimText
// ---------------------------------------------------------------------------

describe("cosineSimText()", () => {
  it("returns 1.0 for identical strings", () => {
    const s = "alpha bravo charlie delta echo foxtrot";
    expect(cosineSimText(s, s)).toBeCloseTo(1, 5);
  });

  it("returns 0.0 for completely disjoint strings", () => {
    expect(cosineSimText("apple orange banana mango", "typescript module import export")).toBe(0);
  });

  it("handles empty strings gracefully", () => {
    expect(cosineSimText("", "")).toBe(1);
    expect(cosineSimText("hello world test", "")).toBe(0);
    expect(cosineSimText("", "hello world test")).toBe(0);
  });

  it("produces high similarity for near-duplicate text (>0.9)", () => {
    // 11-word string vs 10-word string sharing all 10 → cosine ≈ 0.953
    const full = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const subset = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    expect(cosineSimText(full, subset)).toBeGreaterThan(0.9);
  });

  it("produces mid-range similarity for same-length strings differing by one word", () => {
    // 11 words each, 10 shared → cosine = 10/11 ≈ 0.909
    const a = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const b = "alpha bravo charlie delta echo foxtrot golf hotel india juliet lima";
    const sim = cosineSimText(a, b);
    expect(sim).toBeGreaterThan(0.85);
    expect(sim).toBeLessThan(1.0);
  });

  it("is symmetric: sim(a,b) === sim(b,a)", () => {
    const a = "memory hippocampus engram recall search";
    const b = "hippocampus search recall neural memory";
    expect(cosineSimText(a, b)).toBeCloseTo(cosineSimText(b, a), 10);
  });

  it("is sensitive to word frequency (unlike Jaccard)", () => {
    // Text that repeats one word heavily: cosine will weight it
    const a = "dog dog dog cat cat";
    const b = "dog cat";
    // Jaccard would give 1.0 (same set); cosine should give < 1.0
    const sim = cosineSimText(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThanOrEqual(1);
    // Jaccard on sets would be 1 since same vocab — cosine sees different TF
    const setA = new Set(["dog", "cat"]);
    const setB = new Set(["dog", "cat"]);
    expect(jaccard(setA, setB)).toBe(1);
    expect(sim).toBeLessThan(1); // cosine correctly sees TF difference
  });
});

// ---------------------------------------------------------------------------
// Section 2c: computeImportance
// ---------------------------------------------------------------------------

describe("computeImportance()", () => {
  function chunk(overrides: Partial<IndexChunk> = {}): IndexChunk {
    return { path: "test.md", line: 1, score: 0.5, source: "memory", preview: "test", ...overrides };
  }

  it("returns base importance (5) when no metadata present", () => {
    expect(computeImportance(chunk())).toBe(5);
  });

  it("uses stored importance as base when present", () => {
    expect(computeImportance(chunk({ importance: 8 }))).toBeGreaterThanOrEqual(8);
  });

  it("applies recency bonus +2 for chunks created within 24h", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1000 * 60 * 60 * 2).toISOString(); // 2 h ago
    const noTime = chunk({ importance: 5 });
    const withRecent = chunk({ importance: 5, timestamp: recent });
    expect(computeImportance(withRecent, { now })).toBe(
      computeImportance(noTime, { now }) + 2,
    );
  });

  it("applies recency bonus +1 for chunks 1–7 days old", () => {
    const now = new Date();
    const old3d = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3).toISOString();
    const base = computeImportance(chunk({ importance: 5 }), { now });
    expect(computeImportance(chunk({ importance: 5, timestamp: old3d }), { now })).toBe(base + 1);
  });

  it("no recency bonus for chunks older than 7 days", () => {
    const now = new Date();
    const old14d = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString();
    const base = computeImportance(chunk({ importance: 5 }), { now });
    expect(computeImportance(chunk({ importance: 5, timestamp: old14d }), { now })).toBe(base);
  });

  it("applies access frequency bonus (log-scaled, max +2)", () => {
    const base = computeImportance(chunk({ importance: 5, accessCount: 0 }));
    const freq = computeImportance(chunk({ importance: 5, accessCount: 100 }));
    expect(freq).toBeGreaterThan(base);
    expect(freq).toBeLessThanOrEqual(10); // capped at 10
  });

  it("applies connection count bonus (+1 per 3 related links, max +1)", () => {
    const noLinks = computeImportance(chunk({ importance: 5 }));
    const threeLinks = computeImportance(chunk({ importance: 5, related: ["a.md", "b.md", "c.md"] }));
    expect(threeLinks).toBe(noLinks + 1);
    // 6 links still gives +1 (capped)
    const sixLinks = computeImportance(chunk({ importance: 5, related: Array.from({ length: 6 }, (_, i) => `${i}.md`) }));
    expect(sixLinks).toBe(noLinks + 1);
  });

  it("result is clamped to [1, 10]", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 100).toISOString();
    // High base + all bonuses should not exceed 10
    const high = computeImportance(chunk({
      importance: 9,
      timestamp: recent,
      accessCount: 1000,
      related: ["a.md", "b.md", "c.md"],
    }), { now });
    expect(high).toBeLessThanOrEqual(10);

    // Low base clamped to 1
    const low = computeImportance(chunk({ importance: 1 }));
    expect(low).toBeGreaterThanOrEqual(1);
  });

  it("importance is monotonically non-decreasing as metadata richness increases", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1000 * 60).toISOString();
    const base   = computeImportance(chunk({ importance: 5 }), { now });
    const withTs = computeImportance(chunk({ importance: 5, timestamp: recent }), { now });
    const withAcc = computeImportance(chunk({ importance: 5, timestamp: recent, accessCount: 10 }), { now });
    const full   = computeImportance(chunk({ importance: 5, timestamp: recent, accessCount: 10, related: ["x.md", "y.md", "z.md"] }), { now });
    expect(withTs).toBeGreaterThanOrEqual(base);
    expect(withAcc).toBeGreaterThanOrEqual(withTs);
    expect(full).toBeGreaterThanOrEqual(withAcc);
  });
});

// ---------------------------------------------------------------------------
// Section 2d: cosine-based dedup via enhanceIndex
// ---------------------------------------------------------------------------

describe("enhanceIndex() with cosine similarity", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });

  it("merges near-duplicate chunks (cosine > 0.9) — reduces index size", () => {
    // Two chunks that differ by one word out of 11: cosine ≈ 0.953 → merge
    const full   = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const subset = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const idx: HippocampusIndex = {
      "alpha cluster": [makeChunk(full), makeChunk(subset), makeChunk(subset)],
    };
    const path = writeIndex(tmpDir, idx);
    const before = idx["alpha cluster"].length; // 3
    const result = enhanceIndex(path, { similarityMethod: "cosine", mergeThreshold: 0.9 });
    // Dedup should reduce to fewer chunks
    expect(result["alpha cluster"].length).toBeLessThan(before);
    expect(result["alpha cluster"][0].merged).toBe(true);
  });

  it("merged entries retain the richer (longer) preview content", () => {
    // sparse: 5 words; rich: same 5 + 1 extra.
    // cosine = 5 / sqrt(5 * 6) ≈ 0.913 → above default mergeThreshold 0.9.
    const sparse = "alpha bravo charlie delta echo";
    const rich   = "alpha bravo charlie delta echo foxtrot";
    const idx: HippocampusIndex = {
      anchor: [makeChunk(sparse), makeChunk(rich)],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path, { similarityMethod: "cosine", mergeThreshold: 0.9 });
    expect(result["anchor"]).toHaveLength(1);
    // Rich (longer) version must be kept
    expect(result["anchor"][0].preview).toBe(rich);
    expect(result["anchor"][0].merged).toBe(true);
  });

  it("flags related chunks (cosine 0.75–0.9) without merging", () => {
    // 11 words each, 10 shared → cosine ≈ 0.909. Set mergeThreshold to 0.95 to push into related band.
    const a = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const b = "alpha bravo charlie delta echo foxtrot golf hotel india juliet lima";
    const idx: HippocampusIndex = {
      letters: [makeChunk(a), makeChunk(b)],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path, {
      similarityMethod: "cosine",
      mergeThreshold: 0.95,
      relatedThreshold: 0.75,
    });
    // Both chunks survive (not merged at threshold 0.95)
    expect(result["letters"]).toHaveLength(2);
    // At least one carries a related reference
    const hasRelated = result["letters"].some(
      (c) => Array.isArray(c.related) && c.related.length > 0,
    );
    expect(hasRelated).toBe(true);
  });

  it("importance scoring uses computeImportance (recency bonus applied)", () => {
    const now = new Date();
    const recentTs = new Date(now.getTime() - 1000 * 60 * 30).toISOString(); // 30 min ago

    const idx: HippocampusIndex = {
      anchor: [
        // Recent chunk (importance 5 + recency +2 = 7)
        { path: "a.md", line: 1, score: 0.5, source: "memory", preview: "some content here", importance: 5, timestamp: recentTs },
        // Old chunk (importance 5, no bonus)
        { path: "b.md", line: 1, score: 0.5, source: "memory", preview: "different topic about other things" },
      ],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path);
    const recent = result["anchor"].find((c) => c.path === "a.md")!;
    const old    = result["anchor"].find((c) => c.path === "b.md")!;
    // Recent chunk should have higher effective importance → higher weighted score
    expect(recent.importance).toBeGreaterThan(old.importance ?? 5);
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it("highly accessed chunks receive higher importance scores", () => {
    const idx: HippocampusIndex = {
      accessed: [
        { path: "hot.md", line: 1, score: 0.5, source: "memory", preview: "frequently accessed topic", importance: 5, accessCount: 50 },
        { path: "cold.md", line: 1, score: 0.5, source: "memory", preview: "rarely accessed topic ever", importance: 5, accessCount: 0 },
      ],
    };
    const path = writeIndex(tmpDir, idx);
    const result = enhanceIndex(path);
    const hot  = result["accessed"].find((c) => c.path === "hot.md")!;
    const cold = result["accessed"].find((c) => c.path === "cold.md")!;
    expect(hot.importance!).toBeGreaterThan(cold.importance!);
    expect(hot.score).toBeGreaterThan(cold.score);
  });
});

// ---------------------------------------------------------------------------
// Section 3: EpisodicBuffer
// ---------------------------------------------------------------------------

describe("EpisodicBuffer", () => {
  let buf: EpisodicBuffer;

  beforeEach(() => {
    buf = new EpisodicBuffer();
  });

  it("returns fresh same-day events when queried", () => {
    buf.add({
      id: "e1",
      timestamp: new Date().toISOString(),
      content: "typescript engram memory recall session test",
    });
    const results = buf.search("engram recall");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tier).toBe("episodic");
  });

  it("does NOT return events from previous days", () => {
    buf.add({
      id: "old",
      timestamp: "2020-01-01T00:00:00.000Z",
      content: "old event content from the past memory recall",
    });
    const results = buf.search("memory recall");
    // Old event should not appear in today-scoped search
    expect(results.every((r) => r.event.id !== "old")).toBe(true);
  });

  it("returns empty array when no events match query", () => {
    buf.add({
      id: "e2",
      timestamp: new Date().toISOString(),
      content: "cats and dogs playing fetch",
    });
    const results = buf.search("quantum physics");
    expect(results).toHaveLength(0);
  });

  it("applies importance weighting to episodic search scores", () => {
    const baseContent = "hippocampus memory index query";
    buf.add({ id: "low", timestamp: new Date().toISOString(), content: baseContent, importance: 1 });
    buf.add({ id: "high", timestamp: new Date().toISOString(), content: baseContent, importance: 10 });

    const results = buf.search("hippocampus memory");
    const lowResult  = results.find((r) => r.event.id === "low")!;
    const highResult = results.find((r) => r.event.id === "high")!;
    expect(highResult.score).toBeGreaterThan(lowResult.score);
  });

  it("combinedQuery returns episodic results ahead of semantic", () => {
    buf.add({
      id: "ep1",
      timestamp: new Date().toISOString(),
      content: "memory engram hippocampus episodic recall query test",
    });

    const semantic = () => [
      { id: "sem1", path: "mem/foo.md", score: 0.9, content: "semantic result" },
    ];

    const combined = buf.combinedQuery("memory engram", semantic);
    expect(combined.length).toBeGreaterThan(0);
    // Episodic item must appear before semantic item
    const firstId = (combined[0] as { event?: { id: string }; id?: string })?.event?.id
      ?? (combined[0] as { id: string }).id;
    expect(firstId).toBe("ep1");
  });

  it("combinedQuery deduplicates by event id", () => {
    buf.add({ id: "dup1", timestamp: new Date().toISOString(), content: "overlap term testing" });

    // Semantic function returns same id
    const semantic = () => [{ id: "dup1", score: 0.8 }];

    const combined = buf.combinedQuery("overlap term", semantic);
    const ids = combined.map(
      (c) =>
        (c as { event?: { id: string }; id?: string })?.event?.id ??
        (c as { id: string }).id,
    );
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("size() tracks total buffer count", () => {
    expect(buf.size()).toBe(0);
    buf.add({ id: "a", timestamp: new Date().toISOString(), content: "foo bar baz" });
    buf.add({ id: "b", timestamp: new Date().toISOString(), content: "qux quux" });
    expect(buf.size()).toBe(2);
  });

  it("clear() empties the buffer", () => {
    buf.add({ id: "x", timestamp: new Date().toISOString(), content: "some content" });
    buf.clear();
    expect(buf.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 4: scheduleNightlyRebuild
// ---------------------------------------------------------------------------

describe("scheduleNightlyRebuild()", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });

  it("creates an index file when none exists", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const wsDir = join(tmpDir, "ws");
    mkdirSync(wsDir, { recursive: true });

    const result = await scheduleNightlyRebuild(indexPath, wsDir);
    expect(existsSync(indexPath)).toBe(true);
    expect(result).toMatchObject({ pruned: expect.any(Number), reindexed: expect.any(Number), anchors: expect.any(Number) });
  });

  it("is idempotent — second call with unchanged files reports 0 re-indexed", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const wsDir = join(tmpDir, "ws");
    mkdirSync(wsDir, { recursive: true });

    // Create a file
    writeFileSync(join(wsDir, "notes.md"), "# Notes\n\nSome content here.");

    const first  = await scheduleNightlyRebuild(indexPath, wsDir);
    expect(first.reindexed).toBeGreaterThan(0);

    // Second run with no changes
    const second = await scheduleNightlyRebuild(indexPath, wsDir);
    expect(second.reindexed).toBe(0);
  });

  it("detects and re-indexes changed files on second call", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const wsDir = join(tmpDir, "ws");
    mkdirSync(wsDir, { recursive: true });

    const notesPath = join(wsDir, "notes.md");
    writeFileSync(notesPath, "# Notes\n\nOriginal content.");

    await scheduleNightlyRebuild(indexPath, wsDir);

    // Simulate file change (wait a tick to ensure mtime differs)
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(notesPath, "# Notes\n\nUpdated content with new information.");

    const second = await scheduleNightlyRebuild(indexPath, wsDir);
    expect(second.reindexed).toBeGreaterThan(0);
  });

  it("prunes stale absolute-path chunks from the index during reflect phase", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const wsDir = join(tmpDir, "ws");
    mkdirSync(wsDir, { recursive: true });

    // Pre-populate index with a stale absolute path
    const staleIndex: HippocampusIndex = {
      "ghost anchor": [
        {
          path: "/nonexistent/file/that/does/not/exist.md",
          line: 1,
          score: 0.8,
          source: "memory",
          preview: "stale content",
        },
      ],
    };
    writeFileSync(indexPath, JSON.stringify(staleIndex, null, 2));

    const result = await scheduleNightlyRebuild(indexPath, wsDir);
    expect(result.pruned).toBeGreaterThan(0);
  });
});
