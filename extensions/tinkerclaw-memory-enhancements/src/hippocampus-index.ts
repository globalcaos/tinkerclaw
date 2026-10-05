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
import { emitEvent } from "openclaw/plugin-sdk/fork-telemetry";

/**
 * J14 / TINKER_UI_DESIGN_BIBLE/logging.md §4.12 `j.mnemo.lookup` (§9 step 9) — a ROLLUP, not a
 * row per lookup.
 *
 * Lookups are a hot path (one or more per turn, each O(tokens)), and L3 forbids hanging an
 * unbounded row rate off one, so the producer aggregates in memory and writes ONE row per
 * window, stamped at the START of that window (§4's `rollup` convention). A window opens at the
 * first lookup after the previous one closed, so every lookup a row counts happened within
 * MNEMO_LOOKUP_ROLLUP_WINDOW_MS of its stamp — an idle hour never smears one late lookup back
 * onto a stale start time.
 *
 * n1 = lookups, n2 = total_ms (sub-millisecond, from performance.now(): a concept lookup is far
 * below 1 ms, and a Date.now() total would read 0 for almost every window), n3 = index_size
 * (concepts held at flush). Parts and never a mean (design-principles #20): "does concept lookup
 * stay flat as the store grows?" is answered by dividing at query time, against the index size
 * carried in the same row.
 *
 * NO TIMER: a plugin that installs an interval keeps the process awake and has to be torn down.
 * The window is closed lazily by the first lookup after it expires, and by `persist()` (the
 * nightly sweep and shutdown), so the last partial window is never silently lost.
 *
 * KNOWN GAP (at the time of writing): the plugin's index.ts load()s and stats() this index but
 * nothing in production calls lookup() yet, so this row stays empty until retrieval is wired to
 * it. The producer sits here so that wiring needs no second telemetry change.
 */
export const MNEMO_LOOKUP_ROLLUP_WINDOW_MS = 60_000;

let lookupWindowStartMs = 0;
let lookupWindowCount = 0;
let lookupWindowTotalMs = 0;

function flushLookupRollup(indexSize: number): void {
  if (lookupWindowCount === 0) {
    return;
  }
  emitEvent("j.mnemo.lookup", {
    tsMs: lookupWindowStartMs,
    n1: lookupWindowCount,
    n2: lookupWindowTotalMs,
    n3: indexSize,
  });
  lookupWindowCount = 0;
  lookupWindowTotalMs = 0;
}

/** Test seam: drop an in-flight window so one test's lookups cannot leak into the next. */
export function resetMnemoLookupRollup(): void {
  lookupWindowStartMs = 0;
  lookupWindowCount = 0;
  lookupWindowTotalMs = 0;
}

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
    const startedAtMs = Date.now();
    const startedAt = performance.now();
    try {
      return this.lookupInner(queryText);
    } finally {
      // J14 `j.mnemo.lookup`: EVERY lookup counts, including the empty-index short circuit —
      // that is the cheap end of the latency-against-size curve, and dropping it would flatter
      // the very number the paper's claim rests on.
      if (
        lookupWindowCount > 0 &&
        startedAtMs - lookupWindowStartMs >= MNEMO_LOOKUP_ROLLUP_WINDOW_MS
      ) {
        flushLookupRollup(this.concepts.size);
      }
      if (lookupWindowCount === 0) {
        lookupWindowStartMs = startedAtMs;
      }
      lookupWindowCount += 1;
      lookupWindowTotalMs += performance.now() - startedAt;
    }
  }

  private lookupInner(queryText: string): Set<string> {
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
    // Close any partial `j.mnemo.lookup` window here: persist() is the nightly sweep and the
    // shutdown call, so a window that never reached its 60 s still reaches the database.
    flushLookupRollup(this.concepts.size);
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
