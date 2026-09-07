/**
 * ENGRAM Phase 2A: Embedding cache.
 * Persists embeddings alongside events as Float32Array binary files.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { recordAlgorithmOutcome } from "../../infra/algorithm-metrics.js";
import { declareInstrument, noteInstrumentFired } from "../../infra/instrument-liveness.js";

// FORK 2026-07-28 — LIVENESS + EFFECTIVENESS for the ENGRAM embedding cache.
//
// WHY THIS CACHE NEEDS AN INSTRUMENT. Its failure mode is completely silent. `vectorSearch()`
// (search-index.ts) calls get() once per event and `continue`s on null, so a cache that resolves
// NOTHING — wrong baseDir, embeddings never written, a dimension change from 768 to 1024 that
// invalidates every stored vector — returns an empty result set that is indistinguishable from
// "the query genuinely matched nothing". No error, no log, no wrong number: just recall quietly
// degrading to zero. A hit rate is the only thing that tells those two apart.
//
// Declared at MODULE scope, fired inside get(). Deliberately NOT at createEmbeddingCache(),
// which succeeds whether or not the cache is ever consulted — registration is STATIC, being on
// the traffic path is DYNAMIC, and only the second is worth anything (instrument-liveness.ts).
declareInstrument({
  id: "engram:embedding-cache",
  kind: "producer",
  description: "engram embedding cache lookups (hit/miss)",
  // Lookups only occur inside a vector/combined search, which is bursty — hours can legitimately
  // pass with no recall at all. The default 30-minute tolerance would report that as broken and
  // train everyone to ignore the alarm. `neverFired` is still flagged immediately, and that is
  // the case that actually matters here.
  expectFireWithinMs: 6 * 60 * 60 * 1000,
  // No `conditional`: verified 2026-07-28 that engram is live on this deployment (the config
  // runs `compaction.mode = "engram"`), so silence here would be a real defect, not config.
});

// SAMPLING — get() is a HOT path: vectorSearch() calls it once per event in the store, so one
// search can be thousands of lookups and an unsampled ledger append would be thousands of lines.
//
// So: liveness is noted on EVERY call (an in-memory counter bump, no I/O — "it never ran" must
// stay visible), while the durable ledger row is SAMPLED at 1-in-100.
//
// ANY ANALYSIS OF THESE ROWS MUST MULTIPLY BY LEDGER_SAMPLE_EVERY (=100). Each outcome class is
// sampled INDEPENDENTLY — one row per 100 lookups OF THAT CLASS, starting with the first:
//     hits   ~= (rows with outcome "hit")  x LEDGER_SAMPLE_EVERY
//     misses ~= (rows with outcome "miss") x LEDGER_SAMPLE_EVERY
// Sampling per class rather than every 100th call of the mixed stream keeps the hit/miss ratio
// free of aliasing against the bursty full-store scans that produce most of the traffic, and
// guarantees the FIRST miss is recorded even when misses are vanishingly rare.
const LEDGER_SAMPLE_EVERY = 100;

// Module-scope, not per-instance: the instrument is a single id, and counting globally bounds the
// ledger write rate no matter how many cache instances a process builds.
let hitLookups = 0;
let missLookups = 0;

function noteEmbeddingCacheLookup(hit: boolean, tier: string): void {
  // Every call: liveness. A Map lookup plus a counter bump; `tier` is a shared string literal,
  // not a built string, so this allocates nothing on the hot path.
  noteInstrumentFired("engram:embedding-cache", tier);

  const n = hit ? hitLookups++ : missLookups++;
  if (n % LEDGER_SAMPLE_EVERY !== 0) {
    return;
  }
  recordAlgorithmOutcome({
    algorithm: "embedding-cache",
    variant: "engram-mem+disk",
    outcome: hit ? "hit" : "miss",
    // Deliberately EMPTY. The quantity of interest is the hit RATE, and a rate is never stored —
    // only the parts, so a later analysis can check its own denominator. One row = one sampled
    // lookup and the ratio comes from counting rows (see the "645%" incident documented in
    // infra/algorithm-metrics.ts for what storing the ratio instead costs).
    metrics: {},
    provenance: {},
  });
}

export interface EmbeddingCache {
  get(eventId: string): Float32Array | null;
  set(eventId: string, embedding: Float32Array): void;
  has(eventId: string): boolean;
  readonly dimensions: number;
}

function embeddingPath(baseDir: string, eventId: string): string {
  return join(baseDir, "embeddings", `${eventId}.vec`);
}

const MAX_MEM_CACHE_SIZE = 2000;

export function createEmbeddingCache(baseDir: string, dimensions: number = 768): EmbeddingCache {
  const embDir = join(baseDir, "embeddings");
  mkdirSync(embDir, { recursive: true });

  // In-memory LRU avoids repeated disk reads for hot embeddings.
  const memCache = new Map<string, Float32Array>();

  function evictOldestIfFull(): void {
    if (memCache.size >= MAX_MEM_CACHE_SIZE) {
      const oldestKey = memCache.keys().next().value;
      if (oldestKey) {
        memCache.delete(oldestKey);
      }
    }
  }

  // FORK 2026-07-28 — the read-through lookup, extracted so that get() has exactly ONE exit and
  // therefore exactly ONE place where hit-vs-miss is decided. `lastLookupTier` is read only
  // immediately after a fully SYNCHRONOUS readThrough() call, so it cannot interleave.
  let lastLookupTier = "miss";

  function readThrough(eventId: string): Float32Array | null {
    const cached = memCache.get(eventId);
    if (cached) {
      lastLookupTier = "hit/mem";
      return cached;
    }

    const path = embeddingPath(baseDir, eventId);
    if (!existsSync(path)) {
      lastLookupTier = "miss/absent";
      return null;
    }

    const buf = readFileSync(path);
    const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (arr.length !== dimensions) {
      lastLookupTier = "miss/dim-mismatch";
      return null;
    }

    evictOldestIfFull();
    memCache.set(eventId, arr);
    lastLookupTier = "hit/disk";
    return arr;
  }

  return {
    dimensions,

    get(eventId: string): Float32Array | null {
      const found = readThrough(eventId);
      // The ONE recording point, fed by the SAME expression that produces the return value:
      // "hit" is literally `found !== null`, so the hit and miss counts cannot drift apart, and
      // any early return added inside readThrough() later stays counted for free.
      noteEmbeddingCacheLookup(found !== null, lastLookupTier);
      return found;
    },

    set(eventId: string, embedding: Float32Array): void {
      if (embedding.length !== dimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${dimensions}, got ${embedding.length}`,
        );
      }
      const path = embeddingPath(baseDir, eventId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      );

      evictOldestIfFull();
      memCache.set(eventId, embedding);
    },

    has(eventId: string): boolean {
      if (memCache.has(eventId)) {
        return true;
      }
      return existsSync(embeddingPath(baseDir, eventId));
    },
  };
}
