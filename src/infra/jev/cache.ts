/**
 * Verdict cache (design doc §1 C5): a small TTL + LRU map, and the cache key that ties a verdict to the
 * question version and the exact field values it was asked about.
 */
import { createHash } from "node:crypto";
import type { JevQuestion } from "./types.js";

export class TtlLru<V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly map = new Map<string, { v: V; at: number }>();

  constructor(o: { max?: number; ttlMs?: number; now?: () => number } = {}) {
    this.max = o.max ?? 2000;
    this.ttlMs = o.ttlMs ?? 600_000;
    this.now = o.now ?? Date.now;
  }

  get size(): number {
    return this.map.size;
  }

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    // Re-insert so Map iteration order is recency order.
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, { v, at: this.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function cacheKey(
  q: Pick<JevQuestion, "id" | "version">,
  fieldValues: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${q.id}@${q.version}`)
    .update(JSON.stringify(canonical(fieldValues)))
    .digest("hex");
}
