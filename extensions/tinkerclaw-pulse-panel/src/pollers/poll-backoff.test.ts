/**
 * FORK 2026-10-07 — a metric that keeps failing must back off instead of being
 * retried on every tick. Before this, a metric with no observation counted as
 * overdue forever and logged one warning per tick per plugin load.
 */
import { describe, expect, it } from "vitest";
import { isDue } from "./index.js";

const MIN = 60_000;
const SIX_HOURS = 6 * 3600;

describe("isDue", () => {
  it("polls a healthy metric one cadence after its last observation", () => {
    expect(isDue(10 * MIN, 0, 600)).toBe(true);
    expect(isDue(10 * MIN, 1, 600)).toBe(false);
  });

  it("does not retry a failed metric on the next 60 s tick", () => {
    expect(isDue(1 * MIN, 0, SIX_HOURS, { at: 0, count: 1 })).toBe(false);
    expect(isDue(2 * MIN, 0, SIX_HOURS, { at: 0, count: 1 })).toBe(true);
  });

  it("doubles the wait with each consecutive failure", () => {
    expect(isDue(7 * MIN, 0, SIX_HOURS, { at: 0, count: 3 })).toBe(false);
    expect(isDue(8 * MIN, 0, SIX_HOURS, { at: 0, count: 3 })).toBe(true);
  });

  it("never waits longer than the metric's own cadence", () => {
    expect(isDue(SIX_HOURS * 1000 - 1, 0, SIX_HOURS, { at: 0, count: 30 })).toBe(false);
    expect(isDue(SIX_HOURS * 1000, 0, SIX_HOURS, { at: 0, count: 30 })).toBe(true);
  });
});
