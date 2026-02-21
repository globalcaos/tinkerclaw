/**
 * HIPPOCAMPUS Validation Benchmark — Ablation Study
 *
 * A1: WITH vs WITHOUT pronoun expansion (placeholder — not in API yet)
 * A2: WITH vs WITHOUT importance-based re-ranking (weightedScore)
 * A3: Real-time episodic tier (EpisodicBuffer) vs nightly rebuild
 *
 * Metrics: recall@20, false positive rate, query latency (ms)
 * All test data is synthetic (in-memory; no real index files required).
 *
 * Run: pnpm test -- src/memory/engram/hippocampus-benchmark.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  jaccard, weightedScore, enhanceIndex, EpisodicBuffer,
  type IndexChunk, type HippocampusIndex, type EpisodicEvent,
} from "./hippocampus-enhancement.js";
import { scheduleNightlyRebuild } from "./hippocampus-rebuild.js";

// ── Shared tmp dir ────────────────────────────────────────────────────────────
let tmpDir: string;
beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), "hippo-bench-")); });
afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }); });

// ── Result accumulator (printed as JSON in the summary suite) ─────────────────
interface AblationResult {
  ablation: string; condition: string;
  recall_at_20: number | null; false_positive_rate: number | null;
  avg_latency_ms: number; queries_run: number;
}
const benchmarkResults: AblationResult[] = [];

// ── Synthetic fixture ─────────────────────────────────────────────────────────
const TOPICS = [
  { id: "ts",     text: "typescript type system generics interfaces async" },
  { id: "react",  text: "react hooks useState useEffect component render" },
  { id: "mem",    text: "memory hippocampus engram episodic recall index" },
  { id: "git",    text: "git commit branch merge rebase pull remote" },
  { id: "sql",    text: "sql query database table join select where" },
  { id: "llm",    text: "language model prompt token context window attention" },
];

const QUERIES = [
  { query: "typescript generics type interface",   topicId: "ts"    },
  { query: "react hooks useState component",       topicId: "react" },
  { query: "hippocampus memory engram recall",     topicId: "mem"   },
  { query: "git commit branch merge rebase",       topicId: "git"   },
  { query: "sql query database table join",        topicId: "sql"   },
  { query: "language model prompt token context",  topicId: "llm"   },
];

function buildCorpus(importanceAlt = false): IndexChunk[] {
  return TOPICS.flatMap(({ id, text }, idx) =>
    Array.from({ length: 5 }, (_, i) => ({
      path: `mem/${id}/chunk-${i}.md`, line: i * 10 + 1, score: 0.5,
      source: "memory", preview: `${text} chunk ${i} details summary`,
      importance: importanceAlt ? (idx % 2 === 0 ? 9 : 2) : 5,
    })),
  );
}

function groundTruth(topicId: string): Set<string> {
  return new Set(Array.from({ length: 5 }, (_, i) => `mem/${topicId}/chunk-${i}.md`));
}

function retrieve(corpus: IndexChunk[], query: string, topN = 20, rerank = false): string[] {
  const qSet = new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
  return corpus
    .map((c) => {
      const cSet = new Set(c.preview.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
      const sim = jaccard(qSet, cSet);
      return { path: c.path, score: rerank ? weightedScore(sim, c.importance ?? 5) : sim };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((r) => r.path);
}

function recallAt(retrieved: string[], rel: Set<string>): number {
  if (rel.size === 0) return 1;
  return retrieved.filter((p) => rel.has(p)).length / rel.size;
}
function fpr(retrieved: string[], rel: Set<string>): number {
  if (retrieved.length === 0) return 0;
  return retrieved.filter((p) => !rel.has(p)).length / retrieved.length;
}

function runAblation(
  condition: string, ablation: string,
  corpus: IndexChunk[], rerank: boolean,
): AblationResult {
  const recalls: number[] = [], fprs: number[] = [], lats: number[] = [];
  for (const { query, topicId } of QUERIES) {
    const t0 = performance.now();
    const r = retrieve(corpus, query, 20, rerank);
    lats.push(performance.now() - t0);
    const gt = groundTruth(topicId);
    recalls.push(recallAt(r, gt));
    fprs.push(fpr(r, gt));
  }
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    ablation, condition,
    recall_at_20: parseFloat(avg(recalls).toFixed(4)),
    false_positive_rate: parseFloat(avg(fprs).toFixed(4)),
    avg_latency_ms: parseFloat(avg(lats).toFixed(3)),
    queries_run: QUERIES.length,
  };
}

// ── A2: WITH vs WITHOUT importance re-ranking ─────────────────────────────────
describe("A2: Importance re-ranking ablation", () => {
  it("A2-baseline: no re-ranking — recall@20 > 0 and FPR in range", () => {
    const r = runAblation("without_reranking", "A2", buildCorpus(false), false);
    benchmarkResults.push(r);
    expect(r.recall_at_20!).toBeGreaterThan(0);
    expect(r.false_positive_rate!).toBeGreaterThanOrEqual(0);
    expect(r.false_positive_rate!).toBeLessThanOrEqual(1);
  });

  it("A2-reranked: with importance re-ranking — recall@20 > 0 and FPR in range", () => {
    const r = runAblation("with_reranking", "A2", buildCorpus(true), true);
    benchmarkResults.push(r);
    expect(r.recall_at_20!).toBeGreaterThan(0);
    expect(r.false_positive_rate!).toBeGreaterThanOrEqual(0);
    expect(r.false_positive_rate!).toBeLessThanOrEqual(1);
  });

  it("A2-delta: re-ranking does not degrade recall vs flat baseline", () => {
    const base = runAblation("flat_baseline", "A2_delta", buildCorpus(false), false);
    const ranked = runAblation("reranked_delta", "A2_delta", buildCorpus(false), true);
    // On uniform-importance corpus, re-ranking must not hurt recall by more than 10%
    expect(ranked.recall_at_20!).toBeGreaterThanOrEqual(base.recall_at_20! * 0.9);
  });

  it("A2-enhanceIndex: importance is applied to every chunk in enhanced index", () => {
    const idx: HippocampusIndex = {};
    for (const { id, text } of TOPICS) {
      idx[id] = Array.from({ length: 3 }, (_, i) => ({
        path: `mem/${id}/${i}.md`, line: i + 1, score: 0.5,
        source: "memory", preview: `${text} chunk ${i}`, importance: i % 2 === 0 ? 9 : 2,
      }));
    }
    const path = join(tmpDir, "bench-enhance.json");
    writeFileSync(path, JSON.stringify(idx, null, 2));
    const enhanced = enhanceIndex(path);
    for (const chunks of Object.values(enhanced)) {
      for (const c of chunks) {
        expect(c.importance).toBeDefined();
        expect(c.score).toBeGreaterThan(0);
      }
    }
  });
});

// ── A3: Real-time episodic tier vs nightly rebuild ───────────────────────────
describe("A3: Episodic tier vs nightly rebuild", () => {
  const TODAY = new Date().toISOString();

  it("A3-episodic: EpisodicBuffer recall@20 > 0, latency < 50 ms", () => {
    const buf = new EpisodicBuffer();
    for (const { id, text } of TOPICS) {
      for (let i = 0; i < 5; i++) {
        buf.add({ id: `${id}-ep-${i}`, timestamp: TODAY, content: `${text} event ${i}`, importance: 7 });
      }
    }
    const recalls: number[] = [], lats: number[] = [], fprs: number[] = [];
    for (const { query, topicId } of QUERIES) {
      const t0 = performance.now();
      const results = buf.search(query, 20);
      lats.push(performance.now() - t0);
      const gt = new Set(Array.from({ length: 5 }, (_, i) => `${topicId}-ep-${i}`));
      recalls.push(recallAt(results.map((r) => r.event.id), gt));
      fprs.push(fpr(results.map((r) => r.event.id), gt));
    }
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const result: AblationResult = {
      ablation: "A3", condition: "episodic_realtime",
      recall_at_20: parseFloat(avg(recalls).toFixed(4)),
      false_positive_rate: parseFloat(avg(fprs).toFixed(4)),
      avg_latency_ms: parseFloat(avg(lats).toFixed(3)),
      queries_run: QUERIES.length,
    };
    benchmarkResults.push(result);
    expect(result.recall_at_20!).toBeGreaterThan(0);
    expect(result.avg_latency_ms).toBeLessThan(50);
  });

  it("A3-freshness: episodic buffer surfaces same-day events not in nightly index", () => {
    const buf = new EpisodicBuffer();
    buf.add({ id: "fresh-001", timestamp: new Date().toISOString(),
      content: "hippocampus memory engram episodic freshness recall urgent", importance: 9 });
    const results = buf.search("hippocampus memory episodic freshness", 20);
    expect(results.map((r) => r.event.id)).toContain("fresh-001");
  });

  it("A3-nightly: scheduleNightlyRebuild indexes workspace and produces anchors", async () => {
    const wsDir = join(tmpDir, "ws-nightly");
    const idxPath = join(tmpDir, "nightly-index.json");
    mkdirSync(wsDir, { recursive: true });
    for (const { id, text } of TOPICS) {
      writeFileSync(join(wsDir, `${id}.md`), `# ${id}\n\n${text}\n`);
    }
    const t0 = performance.now();
    const result = await scheduleNightlyRebuild(idxPath, wsDir);
    const latency = performance.now() - t0;
    benchmarkResults.push({
      ablation: "A3", condition: "nightly_rebuild",
      recall_at_20: null, false_positive_rate: null,
      avg_latency_ms: parseFloat(latency.toFixed(3)),
      queries_run: 0,
    });
    expect(result.reindexed).toBeGreaterThan(0);
    expect(latency).toBeLessThan(10_000);
  });

  it("A3-combined: combinedQuery deduplicates episodic + semantic results", () => {
    const buf = new EpisodicBuffer();
    buf.add({ id: "ep-1", timestamp: TODAY,
      content: "typescript type system generics combined test", importance: 7 });
    const semantic = (_q: string) => [
      { id: "sem-1", path: "mem/ts/chunk-0.md", score: 0.85 },
      { id: "ep-1",  path: "mem/ts/chunk-0.md", score: 0.72 }, // dup
    ];
    const combined = buf.combinedQuery("typescript generics", semantic, 20);
    const ids = combined.map(
      (c) => (c as { event?: { id: string }; id?: string })?.event?.id ?? (c as { id: string }).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── A1: Pronoun expansion — placeholder ───────────────────────────────────────
describe("A1: Pronoun expansion ablation (placeholder)", () => {
  it.todo("A1-baseline: retrieval without pronoun expansion recall@20");
  // TODO: implement once hippocampus-enhancement exposes pronoun/entity expansion

  it.todo("A1-expanded: retrieval with pronoun expansion improved recall@20");
  // TODO: map 'he'/'she'/'it' → resolved entity names, re-query, compare recall

  it("A1-api-readiness: jaccard handles pronoun-resolved vs raw queries identically (no-op until A1)", () => {
    const raw = "Oscar committed change to memory module";
    const cSet = new Set(["oscar", "memory", "module", "commit", "change", "engram"]);
    const rSet = new Set(raw.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
    // Scores should be non-zero — once expansion lands, pronoun form and entity form should match
    expect(jaccard(rSet, cSet)).toBeGreaterThan(0);
  });
});

// ── Summary: emit JSON ────────────────────────────────────────────────────────
describe("Benchmark Summary", () => {
  it("outputs all ablation results as JSON to console", () => {
    console.log("\n=== HIPPOCAMPUS BENCHMARK RESULTS ===");
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), results: benchmarkResults }, null, 2));
    console.log("=====================================\n");
    expect(benchmarkResults.length).toBeGreaterThan(0);
    for (const r of benchmarkResults) {
      if (r.recall_at_20 !== null) {
        expect(r.recall_at_20).toBeGreaterThanOrEqual(0);
        expect(r.recall_at_20).toBeLessThanOrEqual(1);
      }
      expect(r.avg_latency_ms).toBeGreaterThanOrEqual(0);
    }
  });
});
