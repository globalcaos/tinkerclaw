import { describe, expect, it } from "vitest";
import { buildEegSpendClock, type EegClockSample } from "./eeg-spend-clock.js";

const NOW = 1_000_000;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

function sample(
  key: string,
  start: number,
  end: number | undefined,
  euros: number,
): EegClockSample {
  return { key, startedAt: start, endedAt: end, euros };
}

function height(clock: ReturnType<typeof buildEegSpendClock>, key: string): number {
  const s = clock.spans.get(key);
  if (!s) throw new Error(`no span for ${key}`);
  return s.yEnd - s.yStart;
}

describe("eeg spend clock — the architect's five requirements", () => {
  // "if one tab was running and no other tabs were at that point, its trace should have nobody
  // else on" — alone, a call's height IS its cost, exactly as in the single-session instrument.
  it("a call running ALONE has height equal to its own euros", () => {
    const c = buildEegSpendClock([sample("a", 0, 1000, 3)], NOW);
    expect(near(height(c, "a"), 3)).toBe(true);
    expect(near(c.total, 3)).toBe(true);
  });

  // "if another tab starts mid turn, then the other trace should be represented" — and the chosen
  // trade-off: the grid stays honest, so an overlapped strand is drawn TALLER than its own cost.
  it("two identical overlapping calls each span the COMBINED advance", () => {
    const c = buildEegSpendClock([sample("a", 0, 1000, 2), sample("b", 0, 1000, 2)], NOW);
    expect(near(c.total, 4)).toBe(true);
    expect(near(height(c, "a"), 4)).toBe(true);
    expect(near(height(c, "b"), 4)).toBe(true);
  });

  it("a call that overlaps only PART of another grows by just the overlapping spend", () => {
    // a: [0,1000) €2 (rate 0.002/ms). b: [500,1000) €1 (rate 0.002/ms).
    // a spans 0 -> 3 (its own 2 + b's 1). b spans 2 -> 3? No: at t=500 S = 0.002*500 = 1.
    const c = buildEegSpendClock([sample("a", 0, 1000, 2), sample("b", 500, 1000, 1)], NOW);
    expect(near(c.total, 3)).toBe(true);
    expect(near(c.spans.get("a")!.yStart, 0)).toBe(true);
    expect(near(c.spans.get("a")!.yEnd, 3)).toBe(true);
    expect(near(c.spans.get("b")!.yStart, 1)).toBe(true);
    expect(near(height(c, "b"), 2)).toBe(true); // its own €1 + a's €1 spent alongside
  });

  // "it is not temporal, the EEG does not run empty if nothing is happening, it stops"
  it("an idle gap advances the paper by NOTHING, however long", () => {
    const short = buildEegSpendClock([sample("a", 0, 10, 1), sample("b", 20, 30, 1)], NOW);
    const long = buildEegSpendClock(
      [sample("a", 0, 10, 1), sample("b", 9_999_999, 9_999_999 + 10, 1)],
      NOW,
    );
    expect(near(short.total, 2)).toBe(true);
    expect(near(long.total, 2)).toBe(true);
    expect(near(short.spans.get("b")!.yStart, long.spans.get("b")!.yStart)).toBe(true);
  });

  // "there is a specific synchronization between them" — one shared monotone map from real time.
  it("S is monotone non-decreasing across every breakpoint", () => {
    const c = buildEegSpendClock(
      [sample("a", 0, 400, 2), sample("b", 100, 900, 5), sample("c", 850, 1200, 1)],
      NOW,
    );
    let prev = -Infinity;
    for (let t = -100; t <= 1400; t += 7) {
      const y = c.yOf(t);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });
});

describe("eeg spend clock — conservation (the invariant the design exists to protect)", () => {
  // If this fails, the €1 grid is lying about money, which is the entire point of choosing
  // "grid = total spend" over "strand length = own spend".
  it("total paper advance ALWAYS equals total euros, for arbitrary overlapping input", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rnd() * 12);
      const samples: EegClockSample[] = [];
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const start = Math.floor(rnd() * 5000);
        const dur = Math.floor(rnd() * 900); // deliberately includes 0 -> step samples
        const euros = rnd() * 4;
        sum += euros;
        samples.push(sample(`s${i}`, start, start + dur, euros));
      }
      const c = buildEegSpendClock(samples, NOW);
      expect(Math.abs(c.total - sum)).toBeLessThan(1e-6);
    }
  });

  it("counts a zero-duration call as a full STEP, not as nothing", () => {
    const c = buildEegSpendClock([sample("a", 500, 500, 2.5)], NOW);
    expect(near(c.total, 2.5)).toBe(true);
    expect(near(height(c, "a"), 2.5)).toBe(true);
  });

  it("stacks simultaneous steps deterministically by key", () => {
    const one = buildEegSpendClock([sample("b", 5, 5, 1), sample("a", 5, 5, 1)], NOW);
    const two = buildEegSpendClock([sample("a", 5, 5, 1), sample("b", 5, 5, 1)], NOW);
    expect(one.spans.get("a")!.yStart).toBe(two.spans.get("a")!.yStart);
    expect(one.spans.get("a")!.yStart).toBeLessThan(one.spans.get("b")!.yStart);
  });
});

describe("eeg spend clock — generalisation, not replacement", () => {
  // The old renderer stacked one session's samples by cumulative euros. With no concurrency the
  // clock must reproduce exactly that, or this is a rewrite of the single-session look rather than
  // an extension of it.
  it("reproduces plain cumulative stacking for a sequential single session", () => {
    const c = buildEegSpendClock(
      [sample("a", 0, 100, 1), sample("b", 200, 300, 2), sample("c", 400, 500, 0.5)],
      NOW,
    );
    expect(near(c.spans.get("a")!.yStart, 0)).toBe(true);
    expect(near(c.spans.get("a")!.yEnd, 1)).toBe(true);
    expect(near(c.spans.get("b")!.yStart, 1)).toBe(true);
    expect(near(c.spans.get("b")!.yEnd, 3)).toBe(true);
    expect(near(c.spans.get("c")!.yStart, 3)).toBe(true);
    expect(near(c.spans.get("c")!.yEnd, 3.5)).toBe(true);
    expect(near(c.total, 3.5)).toBe(true);
  });
});

describe("eeg spend clock — degenerate input must never poison the axis", () => {
  it("returns an empty clock for no samples", () => {
    const c = buildEegSpendClock([], NOW);
    expect(c.total).toBe(0);
    expect(c.yOf(123)).toBe(0);
  });

  it("treats a live sample (no endedAt) as running until now", () => {
    const c = buildEegSpendClock([sample("a", NOW - 1000, undefined, 2)], NOW);
    expect(near(c.total, 2)).toBe(true);
    expect(near(c.yOf(NOW), 2)).toBe(true);
    expect(near(c.yOf(NOW - 500), 1)).toBe(true);
  });

  // REGRESSION (2026-08-08b) — caught by SCREENSHOTTING the live panel, not by reading code.
  // `announce:v1:…` runs never receive a final effort event, so they carry no endedAt. Believing
  // them still live made each accrue across the ENTIRE ledger: 10px bars spanning 7011px of a
  // 7056px paper, burying every real strand. An unstamped run from days ago is a data gap, not a
  // call still running.
  it("does NOT let an unstamped OLD run accrue across the whole ledger", () => {
    const stale = NOW - 3 * 24 * 60 * 60 * 1000; // three days ago, never stamped
    const c = buildEegSpendClock(
      [sample("stale", stale, undefined, 1), sample("recent", NOW - 2000, NOW - 1000, 4)],
      NOW,
    );
    const staleSpan = c.spans.get("stale")!;
    // it becomes a STEP: its own euro, not the whole paper
    expect(near(staleSpan.yEnd - staleSpan.yStart, 1)).toBe(true);
    expect(staleSpan.yEnd - staleSpan.yStart).toBeLessThan(c.total);
    // and the money is still fully counted — conservation must not pay for the fix
    expect(near(c.total, 5)).toBe(true);
  });

  it("still believes a RECENT unstamped run is live, so the leading edge stays honest", () => {
    const c = buildEegSpendClock(
      [sample("live", NOW - 60_000, undefined, 2), sample("done", NOW - 90_000, NOW - 80_000, 1)],
      NOW,
    );
    const liveSpan = c.spans.get("live")!;
    expect(liveSpan.yEnd - liveSpan.yStart).toBeGreaterThan(0);
    expect(near(c.yOf(NOW), 3)).toBe(true);
  });

  it("clamps negative, NaN and inverted samples instead of making S non-monotone", () => {
    const c = buildEegSpendClock(
      [
        sample("neg", 0, 100, -5),
        sample("nan", 100, 200, Number.NaN),
        { key: "inverted", startedAt: 500, endedAt: 100, euros: 1 },
      ],
      NOW,
    );
    expect(c.total).toBeGreaterThanOrEqual(0);
    expect(near(c.total, 1)).toBe(true); // only the valid euro survives, as a step
    expect(Number.isFinite(c.yOf(300))).toBe(true);
  });

  it("clamps yOf outside the sample range", () => {
    const c = buildEegSpendClock([sample("a", 100, 200, 1)], NOW);
    expect(c.yOf(-99999)).toBe(0);
    expect(near(c.yOf(99999), 1)).toBe(true);
  });
});
