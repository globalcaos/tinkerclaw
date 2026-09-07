/**
 * FORK: tinkerclaw-pulse-panel — website-visits pollers.
 *
 * Real providers (Plausible, Umami, GoatCounter, GA4, Search Console) all
 * require a site ID + an API key or OAuth. Until the user wires one of those,
 * `demo.website.visits` produces a deterministic but realistic-looking value
 * so the Graphs section has something to render. Each call returns a
 * slightly different number anchored to today's date, with a mild upward
 * trend day-over-day. Swap the registry entry once a real provider is wired.
 */
import type { PollerFn } from "./index.js";

function deterministicNoise(seed: number): number {
  // Mulberry32 — small deterministic PRNG. Two calls with the same seed
  // return the same float in [0, 1). We use Date.now() / minute as the seed
  // so a poll-every-minute cadence produces a steady walk, not a flat line.
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}

export const demoWebsiteVisits: PollerFn = async (_args) => {
  const minutesSinceEpoch = Math.floor(Date.now() / 60_000);
  const noise = deterministicNoise(minutesSinceEpoch);
  // Anchor at ~120 visits/day with ±40 noise and a tiny upward drift over
  // a 30-day window so the graph has visible structure.
  const dayIndex = Math.floor(Date.now() / 86_400_000) % 30;
  const baseline = 120 + dayIndex * 1.5;
  const value = Math.round(baseline + (noise - 0.5) * 80);
  return Math.max(0, value);
};
