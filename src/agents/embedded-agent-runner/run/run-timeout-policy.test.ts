import { describe, expect, it } from "vitest";
import { resolveRunTimeoutOnDeadline } from "./run-timeout-policy.js";

describe("resolveRunTimeoutOnDeadline", () => {
  const base = {
    nowMs: 2_700_000,
    runStartedAtMs: 0,
    activityGraceMs: 600_000,
    hardCapMs: 48 * 60 * 60 * 1000,
  };

  it("extends when the run had recent activity", () => {
    const result = resolveRunTimeoutOnDeadline({
      ...base,
      // Last event 10s before the deadline fired — actively working.
      lastActivityAtMs: base.nowMs - 10_000,
    });
    expect(result).toEqual({ action: "extend", extendMs: 590_000 });
  });

  it("aborts when the run has been silent for the full grace window", () => {
    const result = resolveRunTimeoutOnDeadline({
      ...base,
      lastActivityAtMs: base.nowMs - 600_000,
    });
    expect(result).toEqual({ action: "abort" });
  });

  it("aborts at the hard cap even when the run is active", () => {
    const result = resolveRunTimeoutOnDeadline({
      ...base,
      nowMs: base.hardCapMs,
      lastActivityAtMs: base.hardCapMs - 1_000,
    });
    expect(result).toEqual({ action: "abort" });
  });

  it("aborts when activityGraceMs is 0 (legacy fixed wall-clock)", () => {
    const result = resolveRunTimeoutOnDeadline({
      ...base,
      activityGraceMs: 0,
      lastActivityAtMs: base.nowMs - 1,
    });
    expect(result).toEqual({ action: "abort" });
  });

  it("bounds extendMs by the remaining hard-cap budget", () => {
    const result = resolveRunTimeoutOnDeadline({
      ...base,
      // 2 minutes of hard-cap budget left, but 10 minutes of grace remaining.
      nowMs: base.hardCapMs - 120_000,
      lastActivityAtMs: base.hardCapMs - 120_000,
    });
    expect(result).toEqual({ action: "extend", extendMs: 120_000 });
  });

  it("extends by the unspent grace, not the full window", () => {
    const result = resolveRunTimeoutOnDeadline({
      ...base,
      lastActivityAtMs: base.nowMs - 599_999,
    });
    expect(result).toEqual({ action: "extend", extendMs: 1 });
  });
});
