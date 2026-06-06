/**
 * SS4 (2026-06-06): per-step struggle reader over the LIVE plan archive.
 * Target: step-struggle.ts (readStepStruggle + the DERIVED thresholds).
 * Bible anchor: subagents-and-recipes.md (SS4 verify: block).
 * Bug-history: J16 "no frozen magic number" — the struggle min-runs + failure-rate
 *   threshold must NOT be constants (no `const MIN_RUNS = 5` / `const FLOOR = 0.4`);
 *   they derive from the sample size + the recipe's own failure spread.
 * Catches: a step flagged on a single failure; a frozen threshold; a clean step flagged;
 *   the SS5a done-partial (a `done` step carrying an error) NOT counted as a failure.
 */
import { describe, it, expect } from "vitest";
import type { Plan, PlanStep } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { parsePlanMd } from "../plan-store.js";
import { readStepStruggle } from "../step-struggle.js";

// Build a Plan with explicit per-step status/error. titles are stable across runs.
function plan(
  kitRef: string,
  runId: string,
  steps: Array<Pick<PlanStep, "title" | "status"> & { error?: PlanStep["error"] }>,
): Plan {
  return {
    sessionKey: `s::${runId}`,
    runId,
    intent: "t",
    kitRef,
    started: "2026-06-06T00:00:00.000Z",
    updated: "2026-06-06T00:00:01.000Z",
    status: "done",
    currentStep: 0,
    steps: steps.map((s) => ({
      title: s.title,
      status: s.status,
      ...(s.error ? { error: s.error } : {}),
    })),
  } as Plan;
}

const KIT = "globalcaos/demo";
const okStep = (t: string): { title: string; status: PlanStep["status"] } => ({
  title: t,
  status: "done",
});
const errStep = (
  t: string,
  kind: string,
): { title: string; status: PlanStep["status"]; error: PlanStep["error"] } => ({
  title: t,
  status: "error",
  error: { kind, message: `${kind} on ${t}`, recoverable: kind === "timeout" },
});

describe("readStepStruggle (per-step failure aggregation)", () => {
  it("returns an empty report for no plans (never throws)", () => {
    const r = readStepStruggle(KIT, []);
    expect(r.kitRef).toBe(KIT);
    expect(r.steps).toEqual([]);
    expect(r.strugglingStepIndexes).toEqual([]);
  });

  it("aggregates per-stepIndex runs/failures/failureRate + dominantKind", () => {
    // step 0 always ok; step 1 fails 3/4 (twice timeout, once spawn-failure → dominant timeout).
    const plans = [
      plan(KIT, "r1", [okStep("Setup"), errStep("Act", "timeout")]),
      plan(KIT, "r2", [okStep("Setup"), errStep("Act", "timeout")]),
      plan(KIT, "r3", [okStep("Setup"), errStep("Act", "spawn-failure")]),
      plan(KIT, "r4", [okStep("Setup"), okStep("Act")]),
    ];
    const r = readStepStruggle(KIT, plans);
    const s0 = r.steps.find((s) => s.stepIndex === 0)!;
    const s1 = r.steps.find((s) => s.stepIndex === 1)!;
    expect(s0).toMatchObject({ title: "Setup", runs: 4, failures: 0, failureRate: 0 });
    expect(s1).toMatchObject({ title: "Act", runs: 4, failures: 3, dominantKind: "timeout" });
    expect(s1.failureRate).toBeCloseTo(0.75, 5);
    // step 1 fails far worse than the recipe baseline → flagged; step 0 never.
    expect(r.strugglingStepIndexes).toContain(1);
    expect(r.strugglingStepIndexes).not.toContain(0);
  });

  it("does NOT flag a step on a single failure (min-runs derives from sample size, floor 2)", () => {
    const plans = [
      plan(KIT, "r1", [okStep("A"), okStep("B")]),
      plan(KIT, "r2", [okStep("A"), errStep("B", "execution-error")]), // 1/2 failures
    ];
    const r = readStepStruggle(KIT, plans);
    // failures(1) < derived minRuns(2) → NOT struggling even though rate is 0.5.
    expect(r.strugglingStepIndexes).not.toContain(1);
  });

  it("threshold is DERIVED from the recipe's own failure spread, not a frozen 0.4", () => {
    // A recipe that fails a LOT everywhere: a step at 0.5 is NOT worse-than-baseline.
    const noisy = Array.from({ length: 6 }, (_, i) =>
      plan(KIT, `n${i}`, [
        errStep("A", "execution-error"),
        i % 2 === 0 ? errStep("B", "timeout") : okStep("B"),
      ]),
    );
    const r = readStepStruggle(KIT, noisy);
    const sA = r.steps.find((s) => s.stepIndex === 0)!;
    const sB = r.steps.find((s) => s.stepIndex === 1)!;
    expect(sA.failureRate).toBeCloseTo(1, 5); // A fails every run
    expect(sB.failureRate).toBeCloseTo(0.5, 5); // B fails half
    // A (the worst step, far above the recipe mean) is flagged; B (around the mean) is not.
    expect(r.strugglingStepIndexes).toContain(0);
    expect(r.strugglingStepIndexes).not.toContain(1);
  });

  it("counts an SS5a done-partial (a done step carrying an error) as a failure", () => {
    const plans = [
      plan(KIT, "r1", [
        {
          title: "Map",
          status: "done",
          error: { kind: "sub-kit-failure", message: "dropped 1", recoverable: false },
        },
      ]),
      plan(KIT, "r2", [
        {
          title: "Map",
          status: "done",
          error: { kind: "sub-kit-failure", message: "dropped 2", recoverable: false },
        },
      ]),
      plan(KIT, "r3", [
        {
          title: "Map",
          status: "done",
          error: { kind: "sub-kit-failure", message: "dropped 1", recoverable: false },
        },
      ]),
    ];
    const r = readStepStruggle(KIT, plans);
    const s0 = r.steps.find((s) => s.stepIndex === 0)!;
    expect(s0.failures).toBe(3);
    expect(s0.dominantKind).toBe("sub-kit-failure");
    expect(r.strugglingStepIndexes).toContain(0);
  });

  it("reads the SAME signal from archived plan MARKDOWN via parsePlanMd (round-trip)", () => {
    // an archived plan md: step 1 errored carrying an error64 envelope.
    const md = `---
schema: prefrontal-plan/1.0
sessionKey: s::r1
runId: r1
intent: "t"
kitRef: ${KIT}
started: 2026-06-06T00:00:00.000Z
updated: 2026-06-06T00:00:01.000Z
status: done
currentStep: 0
---

## Plan

- [x] **0. Setup**
- [!] **1. Act**
  <!-- error64:${Buffer.from(JSON.stringify({ kind: "timeout", message: "x", recoverable: true }), "utf-8").toString("base64")} -->
`;
    const parsed = parsePlanMd(md);
    const r = readStepStruggle(KIT, [parsed]);
    const s1 = r.steps.find((s) => s.stepIndex === 1)!;
    expect(s1).toMatchObject({ title: "Act", failures: 1, dominantKind: "timeout" });
  });
});
