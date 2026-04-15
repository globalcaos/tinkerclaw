/**
 * Hippocampus O(1) Concept Index
 *
 * Pre-computes a map of {concept_token → [memory chunk IDs]} so that
 * known-concept queries skip the hybrid search entirely and return in O(1).
 *
 * Design sketch (paper J2 — Concept Index for O(1) Memory Retrieval):
 *
 *   - On every ingested memory chunk, extract the top-K concept anchors
 *     (named entities, project names, persistent tags). Each concept gets
 *     an importance score based on frequency × recency × distinctiveness.
 *   - Store {concept → Set<chunkId>} plus {concept → importance} in a
 *     JSON sidecar at `indexDir/anchors.json`.
 *   - On query, if the query text contains any indexed concept with
 *     importance >= threshold, return those chunks directly, bypassing
 *     the FTS+vector hybrid path. Fall back to hybrid if no concept hits.
 *   - Importance decays over time; chunks below importanceThreshold are
 *     pruned on a nightly sweep.
 *
 * This is the first real retrieval short-circuit — it's the fork's
 * flagship memory win and the thing most likely to be measurably faster
 * than upstream's pure hybrid path for a personal assistant that keeps
 * seeing the same concepts (names, places, projects, recurring topics).
 *
 * v0.1 status: skeleton + in-memory cache only. Persistence + ingestion
 * pipeline + scoring are scaffolded but not yet wired. This is enough to
 * demonstrate the plugin integration pattern and the hook surface; the
 * real retrieval speedup will land in v0.2 once we have persistent
 * storage and an ingestion pass that backfills from the existing memory
 * corpus.
 */

import fs from "node:fs";
import path from "node:path";

export interface HippocampusIndexConfig {
  indexDir: string;
  minConceptLength: number;
  importanceThreshold: number;
}

export interface ConceptEntry {
  chunkIds: Set<string>;
  importance: number;
  lastSeenAtMs: number;
}

export class HippocampusIndex {
  private readonly cfg: HippocampusIndexConfig;
  private readonly concepts = new Map<string, ConceptEntry>();
  private loaded = false;

  constructor(cfg: HippocampusIndexConfig) {
    this.cfg = cfg;
  }

  /** Load the on-disk index into memory. Lazy — called on first query. */
  load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const anchorsPath = this.anchorsPath();
    if (!fs.existsSync(anchorsPath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(anchorsPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<
        string,
        { chunkIds: string[]; importance: number; lastSeenAtMs: number }
      >;
      for (const [concept, entry] of Object.entries(parsed)) {
        if (typeof concept !== "string" || concept.length < this.cfg.minConceptLength) {
          continue;
        }
        this.concepts.set(concept, {
          chunkIds: new Set(entry.chunkIds),
          importance: entry.importance,
          lastSeenAtMs: entry.lastSeenAtMs,
        });
      }
    } catch (err) {
      // Corrupt index is recoverable — next ingestion will rebuild from corpus.
      // We log via the plugin logger from the caller; here we just clear.
      this.concepts.clear();
      throw err;
    }
  }

  /**
   * Look up a query text and return chunk IDs for any concept matches whose
   * importance is above the threshold. Returns empty set if no known concept
   * hits — caller should fall through to hybrid search.
   */
  lookup(queryText: string): Set<string> {
    if (!this.loaded) {
      this.load();
    }
    const hits = new Set<string>();
    if (this.concepts.size === 0) {
      return hits;
    }
    const tokens = this.tokenize(queryText);
    for (const token of tokens) {
      const entry = this.concepts.get(token);
      if (!entry) {
        continue;
      }
      if (entry.importance < this.cfg.importanceThreshold) {
        continue;
      }
      for (const chunkId of entry.chunkIds) {
        hits.add(chunkId);
      }
    }
    return hits;
  }

  /**
   * Ingest a chunk: extract concepts, update the index.
   *
   * v0.1: naive tokenizer + importance = frequency. v0.2 will plug a proper
   * entity extractor and importance = frequency × recency × distinctiveness.
   */
  ingest(chunkId: string, text: string): void {
    if (!this.loaded) {
      this.load();
    }
    const tokens = this.tokenize(text);
    const now = Date.now();
    const freq = new Map<string, number>();
    for (const t of tokens) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    for (const [concept, count] of freq.entries()) {
      const existing = this.concepts.get(concept);
      if (existing) {
        existing.chunkIds.add(chunkId);
        existing.importance = Math.min(1, existing.importance + count * 0.01);
        existing.lastSeenAtMs = now;
      } else {
        this.concepts.set(concept, {
          chunkIds: new Set([chunkId]),
          importance: Math.min(1, count * 0.01),
          lastSeenAtMs: now,
        });
      }
    }
  }

  /** Persist the index to disk. Call on nightly sweep and on shutdown. */
  persist(): void {
    const anchorsPath = this.anchorsPath();
    fs.mkdirSync(path.dirname(anchorsPath), { recursive: true });
    const serialized: Record<
      string,
      { chunkIds: string[]; importance: number; lastSeenAtMs: number }
    > = {};
    for (const [concept, entry] of this.concepts.entries()) {
      serialized[concept] = {
        chunkIds: Array.from(entry.chunkIds),
        importance: entry.importance,
        lastSeenAtMs: entry.lastSeenAtMs,
      };
    }
    const tmpPath = `${anchorsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(serialized, null, 2));
    fs.renameSync(tmpPath, anchorsPath);
  }

  /** Prune concepts below threshold. Call on nightly sweep. */
  prune(): number {
    let removed = 0;
    for (const [concept, entry] of this.concepts.entries()) {
      if (entry.importance < this.cfg.importanceThreshold) {
        this.concepts.delete(concept);
        removed += 1;
      }
    }
    return removed;
  }

  /** Basic stats for diagnostics. */
  stats(): { conceptCount: number; totalChunkRefs: number } {
    let total = 0;
    for (const e of this.concepts.values()) {
      total += e.chunkIds.size;
    }
    return { conceptCount: this.concepts.size, totalChunkRefs: total };
  }

  private tokenize(text: string): string[] {
    // v0.1 tokenizer: lowercase, split on non-word, filter to min length.
    // v0.2 will replace with a proper entity extractor (capitalized phrases,
    // proper nouns, project tags like @project, etc.)
    return (text.toLowerCase().match(/[a-z][a-z0-9_-]*/g) ?? []).filter(
      (t) => t.length >= this.cfg.minConceptLength,
    );
  }

  private anchorsPath(): string {
    const expanded = this.cfg.indexDir.startsWith("~")
      ? path.join(process.env.HOME ?? "", this.cfg.indexDir.slice(1))
      : this.cfg.indexDir;
    return path.join(expanded, "anchors.json");
  }
}
