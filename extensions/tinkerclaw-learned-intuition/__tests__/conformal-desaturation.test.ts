/**
 * FORK 2026-06-10 (Phase 0 — de-saturation): regression tests proving the
 * conformal prediction layer no longer collapses to {safe,needs-review,dangerous}
 * on every action.
 *
 * Root cause (verified against 1229 live evaluations in training.sqlite): the
 * frozen default quantile 0.9 makes the inclusion rule `(1 - p) <= q` admit ANY
 * outcome class with probability >= 0.1, and the `anyDangerous` shortcut admits
 * "dangerous" whenever any net's stop >= 0.1. One genuinely mushy ensemble member
 * (arch E, observed allow≈0.43 / escalate≈0.26 / stop≈0.30 on essentially every
 * input) therefore poisoned the set to size-3 → determineGate returned soft_block
 * on 1229/1229 rows (zero allows). These tests lock in the de-saturated behavior.
 */
import { describe, it, expect } from "vitest";
import { AmygdalaGate } from "../src/gate.js";
import type { AmygdalaConfig, PrudenceOutput } from "../src/types.js";

const cfg = {
  trust: { alpha_prudence: 0.15 },
  prudence: { conservative_override_threshold: 0.9, disagreement_threshold: 0.3 },
} as unknown as AmygdalaConfig;

function p(allow: number, escalate: number, stop: number, confidence = 0.7): PrudenceOutput {
  return { gate_probabilities: { allow, escalate, stop }, confidence, ambiguity_score: 0.4 };
}

type ByArch = Record<"a" | "b" | "c" | "d" | "e", PrudenceOutput>;

// Values lifted from the real per-arch outputs in the live store:
const confidentAllow = p(0.9, 0.05, 0.05, 0.85);
const mushyE = p(0.43, 0.26, 0.3, 0.5); // arch E: spreads probability, low confidence

interface GateInternals {
  conformalPredict(b: ByArch): string[];
  determineGate(c: PrudenceOutput, s: string[], b: ByArch, d: number): string;
}

describe("AMYGDALA conformal de-saturation (Phase 0)", () => {
  it("one mushy ensemble member does not poison the prediction set to all-three", () => {
    const gate = new AmygdalaGate(cfg) as unknown as GateInternals;
    const byArch: ByArch = {
      a: confidentAllow,
      b: confidentAllow,
      c: confidentAllow,
      d: confidentAllow,
      e: mushyE,
    };
    const set = gate.conformalPredict(byArch);
    expect(set).not.toContain("dangerous");
    expect(set).toEqual(["safe"]);
  });

  it("a confident-allow ensemble is allowed, not soft-blocked", () => {
    const gate = new AmygdalaGate(cfg) as unknown as GateInternals;
    const byArch: ByArch = {
      a: confidentAllow,
      b: confidentAllow,
      c: confidentAllow,
      d: confidentAllow,
      e: mushyE,
    };
    const set = gate.conformalPredict(byArch);
    const combined = p(0.81, 0.09, 0.1, 0.78); // ~ the live combined means
    expect(gate.determineGate(combined, set, byArch, 0.15)).toBe("allow");
  });

  it("still flags when a network genuinely favors stop (danger not silenced)", () => {
    const gate = new AmygdalaGate(cfg) as unknown as GateInternals;
    const dangerNet = p(0.2, 0.1, 0.7, 0.8);
    const byArch: ByArch = {
      a: dangerNet,
      b: confidentAllow,
      c: confidentAllow,
      d: confidentAllow,
      e: mushyE,
    };
    const set = gate.conformalPredict(byArch);
    expect(set).toContain("dangerous");
    const combined = p(0.55, 0.1, 0.35, 0.75);
    expect(gate.determineGate(combined, set, byArch, 0.15)).not.toBe("allow");
  });
});
