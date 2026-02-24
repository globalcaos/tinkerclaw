/**
 * HIPPOCAMPUS Enhancement — Phase 2
 *
 * Adds three capabilities to the existing concept index:
 *   1. Importance scoring  — weighted boost per chunk metadata,
 *                            now computed from recency, access frequency,
 *                            and connection count.
 *   2. Deduplication       — similarity-based (Jaccard or cosine TF);
 *                            merges near-duplicates, flags related chunks.
 *   3. Episodic tier       — hot in-memory buffer for same-day events,
 *                            searchable without a nightly rebuild.
 *
 * Does NOT modify hippocampus-hook.ts or hippocampus-bridge.ts.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Index types
// ---------------------------------------------------------------------------

export interface IndexChunk {
  path: string;
  line: number;
  score: number;
  source: string;
  preview: string;
  /** 1–10; default 5 when absent. */
  importance?: number;
  /** ISO-8601 creation/modification timestamp; used for recency scoring. */
  timestamp?: string;
  /** Number of times this chunk has been accessed; used for frequency scoring. */
  accessCount?: number;
  /** Paths of chunks considered "related" (similarity in 0.7–0.9 band). */
  related?: string[];
  /** True when this chunk was formed by merging a near-duplicate. */
  merged?: boolean;
}

export type HippocampusIndex = Record<string, IndexChunk[]>;

export interface EnhanceOptions {
  /**
   * Importance to assume for chunks that carry no importance field (1–10).
   * Default: 5.
   */
  defaultImportance?: number;
  /**
   * Similarity threshold above which two chunks are merged (keep richer).
   * Default: 0.9.
   */
  mergeThreshold?: number;
  /**
   * Similarity threshold above which two chunks are flagged as related.
   * Default: 0.7.
   */
  relatedThreshold?: number;
  /**
   * Similarity method to use for deduplication.
   * - "jaccard"  — fast Jaccard on word sets (default; backward-compatible).
   * - "cosine"   — cosine similarity on TF word vectors (more nuanced).
   * Default: "jaccard".
   */
  similarityMethod?: "jaccard" | "cosine";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenise text into a word-set (words ≥ 3 chars, lower-cased). */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/** Jaccard similarity between two word-sets. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Cosine similarity between two text strings using term-frequency (TF) vectors.
 *
 * Each word (≥ 3 chars, lower-cased) is a dimension. Weights are raw counts.
 * Returns a value in [0, 1]:  1 = identical vocab distribution, 0 = no overlap.
 *
 * Cosine is more sensitive to word frequency than Jaccard, and typically
 * produces higher values for near-duplicate passages.
 */
export function cosineSimText(a: string, b: string): number {
  const tokens = (t: string) =>
    t
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3);

  const tokA = tokens(a);
  const tokB = tokens(b);

  if (tokA.length === 0 && tokB.length === 0) return 1;
  if (tokA.length === 0 || tokB.length === 0) return 0;

  // Build term-frequency maps
  const tfA = new Map<string, number>();
  const tfB = new Map<string, number>();
  for (const t of tokA) tfA.set(t, (tfA.get(t) ?? 0) + 1);
  for (const t of tokB) tfB.set(t, (tfB.get(t) ?? 0) + 1);

  // Dot product
  let dot = 0;
  let normA = 0;
  let normB = 0;

  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);
  for (const term of allTerms) {
    const va = tfA.get(term) ?? 0;
    const vb = tfB.get(term) ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Apply importance weighting to a raw score.
 * Formula: base_score * (1 + 0.15 * (importance - 5) / 5)
 */
export function weightedScore(baseScore: number, importance: number): number {
  return baseScore * (1 + (0.15 * (importance - 5)) / 5);
}

/**
 * Compute an effective importance score (1–10) for a chunk by combining:
 *
 * - **Base importance** — the stored `chunk.importance` field (default: 5).
 * - **Recency bonus**   — +2 within 24 h, +1 within 7 days, 0 otherwise.
 *   Derived from `chunk.timestamp` (ISO-8601).
 * - **Access frequency bonus** — log-scaled, capped at +2.
 *   Derived from `chunk.accessCount`.
 * - **Connection count bonus** — +1 per 3 links, capped at +1.
 *   Derived from `chunk.related?.length`.
 *
 * Result is clamped to [1, 10].
 */
export function computeImportance(
  chunk: IndexChunk,
  opts: { defaultImportance?: number; now?: Date } = {},
): number {
  const base = chunk.importance ?? opts.defaultImportance ?? 5;
  const now = opts.now ?? new Date();

  // Recency bonus
  let recencyBonus = 0;
  if (chunk.timestamp) {
    const ageMs = now.getTime() - new Date(chunk.timestamp).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 1) recencyBonus = 2;
    else if (ageDays < 7) recencyBonus = 1;
  }

  // Access frequency bonus: log1p scaled to [0, 2]
  // accessCount=0→0, 1→~0.69, 7→~1.04, 53→~2.0
  const accessBonus = Math.min(2, Math.log1p(chunk.accessCount ?? 0));

  // Connection count bonus: +1 per 3 related links, capped at +1
  const connectionBonus = Math.min(1, Math.floor((chunk.related?.length ?? 0) / 3));

  return Math.min(10, Math.max(1, base + recencyBonus + accessBonus + connectionBonus));
}

/** Return the "richer" of two chunks — the one with more preview text. */
function richer(a: IndexChunk, b: IndexChunk): IndexChunk {
  return (a.preview?.length ?? 0) >= (b.preview?.length ?? 0) ? a : b;
}

// ---------------------------------------------------------------------------
// Core: deduplication within a single anchor cluster
// ---------------------------------------------------------------------------

/**
 * Compute pairwise similarity between two chunks using the configured method.
 * "jaccard"  — Jaccard on word sets (fast, set-based, default).
 * "cosine"   — cosine on TF word vectors (frequency-aware, higher values).
 */
function chunkSimilarity(
  a: string,
  b: string,
  method: "jaccard" | "cosine",
  setA: Set<string>,
  setB: Set<string>,
): number {
  if (method === "cosine") return cosineSimText(a, b);
  return jaccard(setA, setB);
}

function deduplicateCluster(
  chunks: IndexChunk[],
  opts: Required<EnhanceOptions>,
): IndexChunk[] {
  const { mergeThreshold, relatedThreshold, similarityMethod } = opts;
  const result: IndexChunk[] = [];
  const previews = chunks.map((c) => c.preview ?? "");
  const sets = previews.map((p) => wordSet(p));

  const merged = new Set<number>(); // indices already consumed by a merge

  for (let i = 0; i < chunks.length; i++) {
    if (merged.has(i)) continue;

    let current = chunks[i];

    for (let j = i + 1; j < chunks.length; j++) {
      if (merged.has(j)) continue;

      const sim = chunkSimilarity(previews[i], previews[j], similarityMethod, sets[i], sets[j]);

      if (sim >= mergeThreshold) {
        // Merge: keep richer chunk (more preview text = more links), mark other consumed
        const kept = richer(current, chunks[j]);
        current = { ...kept, merged: true };
        merged.add(j);
      } else if (sim >= relatedThreshold) {
        // Flag as related; don't merge
        const related = current.related ?? [];
        if (!related.includes(chunks[j].path)) {
          current = { ...current, related: [...related, chunks[j].path] };
        }
      }
      // sim < relatedThreshold → distinct; nothing to do
    }

    result.push(current);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: enhanceIndex
// ---------------------------------------------------------------------------

/**
 * Load the HIPPOCAMPUS index at `indexPath`, apply importance scoring and
 * deduplication, then write the result back to the same file.
 *
 * Importance is now computed dynamically via `computeImportance()`, which
 * factors in recency, access frequency, and connection count in addition to
 * the stored `importance` field.
 *
 * Returns the enhanced index for inspection / testing.
 */
export function enhanceIndex(
  indexPath: string,
  options: EnhanceOptions = {},
): HippocampusIndex {
  const opts: Required<EnhanceOptions> = {
    defaultImportance: options.defaultImportance ?? 5,
    mergeThreshold: options.mergeThreshold ?? 0.9,
    relatedThreshold: options.relatedThreshold ?? 0.7,
    similarityMethod: options.similarityMethod ?? "jaccard",
  };

  const now = new Date();

  const raw = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf-8")) as HippocampusIndex)
    : {};

  const enhanced: HippocampusIndex = {};

  for (const [anchor, chunks] of Object.entries(raw)) {
    // 1. Compute effective importance (recency + frequency + connections)
    //    and apply importance weighting to scores.
    const weighted: IndexChunk[] = chunks.map((c) => {
      const importance = computeImportance(c, { defaultImportance: opts.defaultImportance, now });
      return {
        ...c,
        importance,
        score: weightedScore(c.score, importance),
      };
    });

    // 2. Deduplicate within the cluster using the configured similarity method
    const deduped = deduplicateCluster(weighted, opts);

    enhanced[anchor] = deduped;
  }

  writeFileSync(indexPath, JSON.stringify(enhanced, null, 2));
  return enhanced;
}

// ---------------------------------------------------------------------------
// EpisodicBuffer
// ---------------------------------------------------------------------------

export interface EpisodicEvent {
  id: string;
  timestamp: string; // ISO-8601
  content: string;
  source?: string;
  importance?: number;
}

export interface EpisodicSearchResult {
  event: EpisodicEvent;
  score: number;
  tier: "episodic";
}

/** Default TTL for episodic buffer entries: 24 hours in milliseconds. */
export const EPISODIC_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hot in-memory buffer for same-day events.
 * Searchable immediately without a nightly rebuild.
 * On query: returns matching episodic events first.
 * Entries older than 24 h are automatically expired on each operation.
 */
export class EpisodicBuffer {
  private readonly events: EpisodicEvent[] = [];
  /** TTL in ms; defaults to 24 h. Override for testing. */
  private readonly ttlMs: number;

  constructor(ttlMs = EPISODIC_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Prune entries older than `ttlMs` from the front of the buffer.
   * The buffer is append-only and timestamps are monotonically non-decreasing,
   * so a single linear scan from the front suffices.
   */
  expire(now = Date.now()): void {
    const cutoff = now - this.ttlMs;
    // Find first index whose timestamp is within the TTL window.
    const firstValid = this.events.findIndex(
      (e) => new Date(e.timestamp).getTime() >= cutoff,
    );
    if (firstValid === -1) {
      // All events have expired.
      this.events.length = 0;
    } else if (firstValid > 0) {
      this.events.splice(0, firstValid);
    }
  }

  /** Add an event to the episodic buffer. */
  add(event: EpisodicEvent): void {
    this.events.push(event);
  }

  /**
   * Return all events within the TTL window (last 24 h by default).
   * Automatically calls `expire()` to remove stale entries first.
   */
  recentEvents(now = Date.now()): EpisodicEvent[] {
    this.expire(now);
    return [...this.events];
  }

  /** @deprecated Use `recentEvents()`. Kept for backward compatibility. */
  todayEvents(): EpisodicEvent[] {
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    return this.events.filter((e) => e.timestamp.startsWith(today));
  }

  /**
   * Score and return recent events (within TTL) that match `query`.
   * Uses word-overlap Jaccard against event content.
   * Automatically expires stale entries before searching.
   */
  search(query: string, topN = 10, now = Date.now()): EpisodicSearchResult[] {
    const qSet = wordSet(query);
    if (qSet.size === 0) return [];

    this.expire(now);
    const cutoff = now - this.ttlMs;

    const scored: EpisodicSearchResult[] = this.events
      .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
      .map((e) => {
        const importance = e.importance ?? 5;
        const sim = jaccard(qSet, wordSet(e.content));
        return {
          event: e,
          // Apply importance weighting to the similarity score
          score: weightedScore(sim, importance),
          tier: "episodic" as const,
        };
      })
      .filter((r) => r.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }

  /**
   * Combined query: episodic results first, then semantic results from a
   * caller-supplied function, deduped by event id / path.
   */
  combinedQuery(
    query: string,
    semanticFn: (q: string) => unknown[],
    topN = 10,
  ): unknown[] {
    const episodic = this.search(query, topN);
    const semantic = semanticFn(query);

    const seen = new Set<string>(episodic.map((r) => r.event.id));

    const combined: unknown[] = [...episodic];
    for (const item of semantic) {
      const id =
        (item as { id?: string; path?: string }).id ??
        (item as { path?: string }).path ??
        "";
      if (!seen.has(id)) {
        combined.push(item);
        seen.add(id);
      }
    }

    return combined.slice(0, topN);
  }

  /** Number of events currently in the buffer (includes expired; call expire() first for accurate count). */
  size(): number {
    return this.events.length;
  }

  /** Clear all events (useful in tests). */
  clear(): void {
    this.events.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — shared episodic buffer for the current process.
// ---------------------------------------------------------------------------

/**
 * Shared process-level episodic buffer.
 * Import and use this instance so all subsystems share the same hot buffer.
 *
 * @example
 * ```ts
 * import { sharedEpisodicBuffer } from "./hippocampus-enhancement.js";
 * sharedEpisodicBuffer.add({ id, timestamp, content });
 * const hits = sharedEpisodicBuffer.search("query");
 * ```
 */
export const sharedEpisodicBuffer = new EpisodicBuffer();
