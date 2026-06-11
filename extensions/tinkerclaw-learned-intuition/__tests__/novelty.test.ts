import { describe, it, expect } from "vitest";
import { NoveltyIndex } from "../src/novelty.js";

function vec(seed: number, dim = 32): Float32Array {
  const v = new Float32Array(dim);
  // deterministic pseudo-vector
  let s = seed * 2654435761;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return v;
}

describe("NoveltyIndex", () => {
  it("is disabled below the minimum reference size", () => {
    const idx = new NoveltyIndex({ minRef: 100 });
    idx.load([vec(1), vec(2), vec(3)]);
    expect(idx.enabled).toBe(false);
    expect(idx.score(vec(99))).toBeNull();
  });

  it("scores a far-from-reference vector as more novel than a near one", () => {
    const idx = new NoveltyIndex({ minRef: 10, k: 5 });
    // a tight cluster around vec(1)
    const cluster: Float32Array[] = [];
    for (let i = 0; i < 60; i++) {
      const base = vec(1);
      const jittered = new Float32Array(base.length);
      for (let d = 0; d < base.length; d++) jittered[d] = base[d] + (i % 7) * 1e-3;
      cluster.push(jittered);
    }
    idx.load(cluster);
    expect(idx.enabled).toBe(true);
    const near = idx.score(vec(1))!;
    const far = idx.score(vec(9999))!;
    expect(near).toBeLessThan(far);
  });

  it("habituates: a vector becomes less novel after being added repeatedly", () => {
    const idx = new NoveltyIndex({ minRef: 10, k: 5, recalibrateEvery: 100000 });
    const cluster: Float32Array[] = [];
    for (let i = 0; i < 60; i++) cluster.push(vec(100 + i));
    idx.load(cluster);
    const probe = vec(424242);
    const before = idx.score(probe)!;
    for (let i = 0; i < 15; i++) idx.add(probe);
    const after = idx.score(probe)!;
    expect(after).toBeLessThan(before); // the once-novel thing is now familiar
  });

  it("calibrate produces a finite threshold when enabled", () => {
    const idx = new NoveltyIndex({ minRef: 10, k: 5 });
    const cluster: Float32Array[] = [];
    for (let i = 0; i < 80; i++) cluster.push(vec(200 + i));
    idx.load(cluster);
    const t = idx.calibrate();
    expect(t).not.toBeNull();
    expect(Number.isFinite(t!)).toBe(true);
    expect(t!).toBeGreaterThanOrEqual(0);
  });

  it("respects the ring capacity", () => {
    const idx = new NoveltyIndex({ minRef: 5, cap: 50 });
    const refs: Float32Array[] = [];
    for (let i = 0; i < 200; i++) refs.push(vec(i));
    idx.load(refs);
    expect(idx.size).toBe(50);
    for (let i = 0; i < 20; i++) idx.add(vec(1000 + i));
    expect(idx.size).toBe(50);
  });
});
