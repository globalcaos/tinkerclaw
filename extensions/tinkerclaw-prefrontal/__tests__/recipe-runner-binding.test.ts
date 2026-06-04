import { describe, it, expect } from "vitest";
import type { Plan, PlanStep } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { collectPriorArtifacts } from "../recipe-runner.js";

// Minimal Plan-like fixture; align field names with the real Plan type.
function planWith(steps: Array<Partial<PlanStep>>): Plan {
  return {
    sessionKey: "s",
    runId: "r",
    intent: "i",
    started: new Date(0).toISOString(),
    updated: new Date(0).toISOString(),
    status: "in_progress",
    currentStep: steps.length,
    steps: steps.map((s) => ({ title: s.title ?? "t", status: s.status ?? "done", ...s })),
  } as Plan;
}

describe("collectPriorArtifacts carries typed output (SS1)", () => {
  it("includes the structured output of prior typed steps", () => {
    const plan = planWith([
      { title: "Produce", status: "done", artifact: "ok", output: { passed: true } },
      { title: "Consume", status: "pending" },
    ]);
    const prior = collectPriorArtifacts(plan, 1);
    expect(prior[0].output).toEqual({ passed: true });
  });

  it("leaves output undefined for untyped prior steps", () => {
    const plan = planWith([
      { title: "Plain", status: "done", artifact: "ok" },
      { title: "Next", status: "pending" },
    ]);
    expect(collectPriorArtifacts(plan, 1)[0].output).toBeUndefined();
  });
});
