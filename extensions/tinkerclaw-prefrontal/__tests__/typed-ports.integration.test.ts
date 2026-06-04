/**
 * SS1 (2026-06-04): end-to-end typed-ports integration.
 *
 * Drives runRecipe against a SCRIPTED mock PlanStore (the only way to settle a
 * step without a live gateway — the mock flips a row to `done` the moment it goes
 * in_progress, like recipe-runner-resume.test.ts, but with per-step scripted
 * notes so we can simulate a first-bad-then-good output that forces ONE schema
 * re-dispatch). Asserts: the typed edge binds downstream, a mismatch re-dispatches,
 * the validated output persists, and a mis-wired recipe is rejected at seed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { runRecipe } from "../recipe-runner.js";

interface StepCall {
  stepIndex: number;
  status: Plan["steps"][number]["status"];
  note?: string;
  artifact?: string;
  output?: unknown;
}

// Mock store: on in_progress, auto-complete the step with the next scripted note
// for that step index (so waitForStepDone returns); on done/error, record the row
// (including the structured output) so binding + assertions can read it back.
function makeScriptedStore(scripts: Record<number, string[]>) {
  let plan: Plan | null = null;
  const stepCalls: StepCall[] = [];
  const attempts: Record<number, number> = {};
  let closed: { status: string } | null = null;
  const copy = (): Plan => JSON.parse(JSON.stringify(plan));
  return {
    calls: stepCalls,
    getClosed: () => closed,
    async get(_sessionKey: string): Promise<Plan | null> {
      return plan ? copy() : null;
    },
    async set(params: {
      sessionKey: string;
      intent: string;
      runId: string;
      kitRef?: string;
      steps: Array<{ title: string }>;
    }): Promise<Plan> {
      plan = {
        sessionKey: params.sessionKey,
        runId: params.runId,
        intent: params.intent,
        kitRef: params.kitRef,
        started: "2026-06-04T00:00:00.000Z",
        updated: "2026-06-04T00:00:00.000Z",
        status: "in_progress",
        currentStep: 0,
        steps: params.steps.map((s) => ({ title: s.title, status: "pending" as const })),
      };
      return copy();
    },
    async step(params: StepCall & { sessionKey: string; outputKind?: "json" }): Promise<Plan> {
      stepCalls.push({
        stepIndex: params.stepIndex,
        status: params.status,
        note: params.note,
        artifact: params.artifact,
        output: params.output,
      });
      if (!plan) throw new Error("no plan");
      const st = plan.steps[params.stepIndex];
      if (!st) throw new Error("step out of range");
      if (params.status === "in_progress") {
        const n = attempts[params.stepIndex] ?? 0;
        attempts[params.stepIndex] = n + 1;
        const notes = scripts[params.stepIndex] ?? ["auto-done"];
        st.note = notes[Math.min(n, notes.length - 1)];
        st.status = "done";
        plan.currentStep = params.stepIndex;
      } else {
        st.status = params.status;
        if (params.note !== undefined) st.note = params.note;
        if (params.artifact !== undefined) st.artifact = params.artifact;
        if (params.output !== undefined) st.output = params.output;
        if (params.outputKind !== undefined) st.outputKind = params.outputKind;
      }
      return copy();
    },
    async close(params: { status: string }): Promise<{ ok: true; archivedTo: string }> {
      closed = { status: params.status };
      return { ok: true, archivedTo: "/dev/null" };
    },
  };
}

const KIT_MD = `---
schema: "kit/1.0"
slug: "typed-e2e"
title: "Typed E2E"
summary: "demo"
tags: ["demo"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Typed E2E

## Steps

### 1. Produce
out: {"type":"object","properties":{"passed":{"type":"boolean"}},"required":["passed"]}

Report whether the build passed.

### 2. Consume
in: [{"name":"passed","from":"steps.1.out.passed"}]

The build passed = {{steps.1.out.passed}}. Act on it.
`;

describe("typed ports end-to-end", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "typed-e2e-"));
    await fs.mkdir(path.join(dir, "typed-e2e"), { recursive: true });
    await fs.writeFile(path.join(dir, "typed-e2e", "kit.md"), KIT_MD, "utf-8");
    // mis-wired variant: in port references a field the producer doesn't declare.
    await fs.mkdir(path.join(dir, "bad-wire"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "bad-wire", "kit.md"),
      KIT_MD.replace('slug: "typed-e2e"', 'slug: "bad-wire"').replace(
        "steps.1.out.passed",
        "steps.1.out.NOPE",
      ),
      "utf-8",
    );
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("binds the typed edge and re-dispatches once on a bad first reply", async () => {
    // step 0 (Produce): first in_progress yields an invalid output ({} — missing
    // required `passed`), second yields a valid one → exactly one re-dispatch.
    const store = makeScriptedStore({
      0: ["{}", '```json\n{"passed": true}\n```'],
      1: ["consumed"],
    });
    const tasksSeen: string[] = [];
    let step1Calls = 0;

    const result = await runRecipe({
      kitRef: "globalcaos/typed-e2e",
      sessionKey: "e2e-1",
      intent: "demo run",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (task: string) => {
        tasksSeen.push(task);
        if (task.includes("Step 1/")) step1Calls++;
        return { ok: true as const, runId: "mock" };
      },
    });

    expect(result.ok).toBe(true);
    // One re-dispatch ⇒ step 0 spawned at least twice.
    expect(step1Calls).toBeGreaterThanOrEqual(2);

    // Step 2's task had the typed field bound (not the literal template).
    const step2Task = tasksSeen.find((t) => t.includes("Step 2/"));
    expect(step2Task).toBeDefined();
    expect(step2Task!).toContain("The build passed = true");
    expect(step2Task!).not.toContain("{{steps.1.out.passed}}");

    // Step 0's validated structured output was persisted.
    const outputWrite = store.calls.find((c) => c.stepIndex === 0 && c.output !== undefined);
    expect(outputWrite?.output).toEqual({ passed: true });
    expect(store.getClosed()?.status).toBe("done");
  }, 30_000);

  it("rejects a mis-wired recipe at seed time", async () => {
    const store = makeScriptedStore({});
    const result = await runRecipe({
      kitRef: "globalcaos/bad-wire",
      sessionKey: "e2e-bad",
      intent: "demo",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true as const, runId: "mock" }),
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/port-wiring/i);
  });
});
