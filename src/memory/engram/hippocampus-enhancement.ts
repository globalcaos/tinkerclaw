/**
 * HIPPOCAMPUS Enhancement — Phase 2
 *
 * Adds three capabilities to the existing concept index:
 *   1. Importance scoring  — weighted boost per chunk metadata.
 *   2. Deduplication       — Jaccard-based similarity; merges near-duplicates.
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
  /** Paths of chunks considered "related" (0.7–0.9 Jaccard). */
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
   * Jaccard threshold above which two chunks are merged (keep richer).
   * Default: 0.9.
   */
  mergeThreshold?: number;
  /**
   * Jaccard threshold above which two chunks are flagged as related.
   * Default: 0.7.
   */
  relatedThreshold?: number;
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
 * Apply importance weighting to a raw score.
 * Formula: base_score * (1 + 0.15 * (importance - 5) / 5)
 */
export function weightedScore(baseScore: number, importance: number): number {
  return baseScore * (1 + (0.15 * (importance - 5)) / 5);
}

/** Return the "richer" of two chunks — the one with more preview text. */
function richer(a: IndexChunk, b: IndexChunk): IndexChunk {
  return (a.preview?.length ?? 0) >= (b.preview?.length ?? 0) ? a : b;
}

// ---------------------------------------------------------------------------
// Core: deduplication within a single anchor cluster
// ---------------------------------------------------------------------------

function deduplicateCluster(
  chunks: IndexChunk[],
  opts: Required<EnhanceOptions>,
): IndexChunk[] {
  const { mergeThreshold, relatedThreshold } = opts;
  const result: IndexChunk[] = [];
  const sets = chunks.map((c) => wordSet(c.preview ?? ""));

  const merged = new Set<number>(); // indices already consumed by a merge

  for (let i = 0; i < chunks.length; i++) {
    if (merged.has(i)) continue;

    let current = chunks[i];

    for (let j = i + 1; j < chunks.length; j++) {
      if (merged.has(j)) continue;

      const sim = jaccard(sets[i], sets[j]);

      if (sim >= mergeThreshold) {
        // Merge: keep richer chunk, mark other as consumed
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
  };

  const raw = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf-8")) as HippocampusIndex)
    : {};

  const enhanced: HippocampusIndex = {};

  for (const [anchor, chunks] of Object.entries(raw)) {
    // 1. Apply importance weighting to scores
    const weighted: IndexChunk[] = chunks.map((c) => {
      const importance = c.importance ?? opts.defaultImportance;
      return {
        ...c,
        importance,
        score: weightedScore(c.score, importance),
      };
    });

    // 2. Deduplicate within the cluster
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

/**
 * Hot in-memory buffer for same-day events.
 * Searchable immediately without a nightly rebuild.
 * On query: returns matching episodic events first.
 */
export class EpisodicBuffer {
  private readonly events: EpisodicEvent[] = [];

  /** Add an event to the episodic buffer. */
  add(event: EpisodicEvent): void {
    this.events.push(event);
  }

  /** Return all events from today (local date). */
  todayEvents(): EpisodicEvent[] {
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    return this.events.filter((e) => e.timestamp.startsWith(today));
  }

  /**
   * Score and return today's events that match `query`.
   * Uses word-overlap Jaccard against event content.
   */
  search(query: string, topN = 10): EpisodicSearchResult[] {
    const qSet = wordSet(query);
    if (qSet.size === 0) return [];

    const today = new Date().toISOString().slice(0, 10);

    const scored: EpisodicSearchResult[] = this.events
      .filter((e) => e.timestamp.startsWith(today))
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

  /** Number of events in the buffer (all time, not just today). */
  size(): number {
    return this.events.length;
  }

  /** Clear all events (useful in tests). */
  clear(): void {
    this.events.length = 0;
  }
}
