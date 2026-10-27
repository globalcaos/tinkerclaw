import { describe, expect, it } from "vitest";
import { exaggerateIntonation, trackPitch } from "./voice-intonation.js";

// A voice-like glide from 100 to 200 Hz (three harmonics), 2 s at 24 kHz.
function glide(sr: number, seconds: number): Float32Array {
  const n = sr * seconds;
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (2 * Math.PI * 100 * Math.pow(2, i / n)) / sr;
    x[i] = Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph);
  }
  return x;
}

describe("exaggerateIntonation", () => {
  const sr = 24000;
  const hop = 240;
  const win = 960;
  const x = glide(sr, 2);
  const ends = (a: Float32Array) => {
    const p = trackPitch(a, sr, hop, win);
    return { start: p[10], end: p[p.length - 10] };
  };

  it("widens the contour around the mean: lows lower, highs higher, same length", () => {
    const before = ends(x);
    const y = exaggerateIntonation(x, sr, 2);
    const after = ends(y);
    expect(y.length).toBe(x.length);
    // mean ≈ 141 Hz; k = 2 maps 104 → ~77 and 190 → ~256 (2026-10-22 measured 78 / 258)
    expect(after.start).toBeLessThan(before.start * 0.85);
    expect(after.end).toBeGreaterThan(before.end * 1.2);
  });

  it("k = 1 returns the input unchanged", () => {
    expect(exaggerateIntonation(x, sr, 1)).toBe(x);
  });
});
