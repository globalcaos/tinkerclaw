import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEmbeddingCache, type EmbeddingCache } from "../src/embedding-cache.js";
import { createEventStore, type EventStore } from "../src/event-store.js";
import { cosineSimilarity, vectorSearch } from "../src/vector-search.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for zero-norm vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for dimension mismatch", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("handles scaled vectors (same direction)", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

describe("vectorSearch", () => {
  let baseDir: string;
  let store: EventStore;
  let cache: EmbeddingCache;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "vector-search-test-"));
    store = createEventStore({ baseDir, sessionKey: "test" });
    cache = createEmbeddingCache(baseDir, 3);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns empty results for empty store", () => {
    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, store, cache);
    expect(results).toEqual([]);
  });

  it("returns empty when no embeddings cached", () => {
    store.append({
      turnId: 1,
      sessionKey: "test",
      kind: "user_message",
      content: "hello",
      tokens: 1,
      metadata: {},
    });
    const results = vectorSearch(new Float32Array([1, 0, 0]), store, cache);
    expect(results).toEqual([]);
  });

  it("returns scored results sorted by similarity", () => {
    const e1 = store.append({
      turnId: 1,
      sessionKey: "test",
      kind: "user_message",
      content: "first",
      tokens: 1,
      metadata: {},
    });
    const e2 = store.append({
      turnId: 2,
      sessionKey: "test",
      kind: "user_message",
      content: "second",
      tokens: 1,
      metadata: {},
    });

    cache.set(e1.id, new Float32Array([0.9, 0.1, 0.0]));
    cache.set(e2.id, new Float32Array([0.5, 0.5, 0.0]));

    const results = vectorSearch(new Float32Array([1, 0, 0]), store, cache);
    expect(results.length).toBe(2);
    expect(results[0].eventId).toBe(e1.id);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects topK limit", () => {
    for (let i = 0; i < 5; i++) {
      const e = store.append({
        turnId: i,
        sessionKey: "test",
        kind: "user_message",
        content: `event ${i}`,
        tokens: 1,
        metadata: {},
      });
      cache.set(e.id, new Float32Array([1 - i * 0.1, i * 0.1, 0]));
    }
    const results = vectorSearch(new Float32Array([1, 0, 0]), store, cache, 2);
    expect(results.length).toBe(2);
  });

  it("skips zero-similarity events", () => {
    const e1 = store.append({
      turnId: 1,
      sessionKey: "test",
      kind: "user_message",
      content: "positive",
      tokens: 1,
      metadata: {},
    });
    const e2 = store.append({
      turnId: 2,
      sessionKey: "test",
      kind: "user_message",
      content: "orthogonal",
      tokens: 1,
      metadata: {},
    });

    cache.set(e1.id, new Float32Array([1, 0, 0]));
    cache.set(e2.id, new Float32Array([0, 1, 0]));

    const results = vectorSearch(new Float32Array([1, 0, 0]), store, cache);
    expect(results.length).toBe(1);
    expect(results[0].eventId).toBe(e1.id);
  });
});
