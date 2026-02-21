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
