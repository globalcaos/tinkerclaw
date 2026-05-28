import { describe, it, expect } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { collectStepResults } from "../kit-runner.js";

function planWith(
  steps: Array<{ title: string; status: Plan["steps"][number]["status"]; note?: string }>,
): Plan {
  return {
    sessionKey: "agent:main:main",
    runId: "test-run",
    intent: "test",
    started: "2026-05-28T00:00:00.000Z",
    updated: "2026-05-28T00:00:00.000Z",
    status: "done",
    currentStep: 0,
    steps: steps.map((s) => ({ title: s.title, status: s.status, note: s.note })),
  };
}

describe("collectStepResults", () => {
  it("returns title + note for each done step, in step order", () => {
    const plan = planWith([
      { title: "Explore", status: "done", note: "found 3 call sites in app.ts" },
      { title: "Implement", status: "done", note: "patched filter at line 2046" },
    ]);
    expect(collectStepResults(plan)).toEqual([
      { stepIndex: 0, title: "Explore", status: "done", note: "found 3 call sites in app.ts" },
      { stepIndex: 1, title: "Implement", status: "done", note: "patched filter at line 2046" },
    ]);
  });

  it("includes error/timeout steps with their note and a null note when absent", () => {
    const plan = planWith([
      { title: "A", status: "done" },
      { title: "B", status: "error", note: "step timed out after 10 minutes" },
    ]);
    expect(collectStepResults(plan)).toEqual([
      { stepIndex: 0, title: "A", status: "done", note: null },
      { stepIndex: 1, title: "B", status: "error", note: "step timed out after 10 minutes" },
    ]);
  });
});
