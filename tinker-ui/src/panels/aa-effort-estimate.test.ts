import { describe, expect, it } from "vitest";
import { AA_EFFORT_ESTIMATE } from "./aa-effort-estimate.js";
import { AA_EFFORT_INDEX, aaEstimateAt, aaFamilyOf, aaScoreAt } from "./aa-effort-index.js";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

// FORK 2026-09-02 (the architect: "you must certainly be able to find other benchmarks … even
// if you have to approximate"). The estimate table fills effort cells AA never
// published from other public per-effort benchmark runs. These tests pin the contract
// that makes that honest: an estimate never touches a measurement, it always says
// what it rests on, and a ladder never reads as smarter at less effort.
describe("aa-effort-estimate — the estimate contract", () => {
  it("never holds a cell AA measured", () => {
    for (const [fam, row] of Object.entries(AA_EFFORT_ESTIMATE)) {
      for (const eff of Object.keys(row)) {
        expect(
          AA_EFFORT_INDEX[fam]?.[eff as (typeof EFFORTS)[number]],
          `${fam}.${eff}`,
        ).toBeUndefined();
      }
    }
  });

  it("every cell is finite, has a positive σ, a known method and a non-empty basis", () => {
    for (const [fam, row] of Object.entries(AA_EFFORT_ESTIMATE)) {
      for (const [eff, c] of Object.entries(row)) {
        expect(Number.isFinite(c.v), `${fam}.${eff}`).toBe(true);
        expect(c.sd, `${fam}.${eff}`).toBeGreaterThan(0);
        expect(["benchmark-fit", "ladder-shape", "blend"]).toContain(c.method);
        expect(c.basis.length, `${fam}.${eff}`).toBeGreaterThan(0);
      }
    }
  });

  it("reads in ladder order: estimates sit between their measured neighbours and never decrease", () => {
    for (const [fam, row] of Object.entries(AA_EFFORT_ESTIMATE)) {
      const measured = AA_EFFORT_INDEX[fam] ?? {};
      const ladder = EFFORTS.map((e) => ({ e, v: measured[e] ?? row[e]?.v })).filter(
        (x) => x.v !== undefined,
      );
      for (let i = 1; i < ladder.length; i++) {
        // measured cells are AA's own and may dip (gpt-5-mini high < medium); only an
        // ESTIMATE is bound by order, against whatever precedes it
        if (row[ladder[i].e]) {
          expect(ladder[i].v!, `${fam}: ${ladder[i - 1].e}→${ladder[i].e}`).toBeGreaterThanOrEqual(
            ladder[i - 1].v! - 1e-9,
          );
        }
      }
    }
  });

  it("aaEstimateAt refuses where AA measured, and answers where it did not", () => {
    expect(aaScoreAt("claude-code/claude-opus-5", "max")).toBeDefined();
    expect(aaEstimateAt("claude-code/claude-opus-5", "max")).toBeUndefined();
    expect(aaScoreAt("claude-code/claude-sonnet-5", "high")).toBeUndefined();
    const est = aaEstimateAt("claude-code/claude-sonnet-5", "high");
    expect(est).toBeDefined();
    expect(est!.v).toBeLessThan(55.2612);
  });

  // FORK 2026-09-02 (the architect: "No claude models should ever route through openrouter").
  // The case "Opus 5 fast resolves to Opus 5's measured ladder, not a flat line" is DELETED,
  // not relaxed: it existed only to pin the `claude-opus-5-fast` → `claude-opus-5` family
  // alias, and that alias is gone because the route itself is banned — we hold Anthropic
  // directly on the Max 20x plan, while that OpenRouter twin billed $10/$50 per Mtok for an
  // identical measured intelligence. Rewriting it to assert the flat ladder it used to guard
  // against would have kept a green test over a model that can no longer be selected. The
  // surviving invariant now lives in src/shared/reseller-route-policy.test.ts, which asserts
  // the route is vetoed.

  it("reaches a -preview id through the un-suffixed family", () => {
    // Epoch keys `gemini-3.1-pro-preview` without the suffix; the chart id keeps it.
    const est = aaEstimateAt("google/gemini-3.1-pro-preview", "high");
    expect(est).toBeDefined();
  });
});
