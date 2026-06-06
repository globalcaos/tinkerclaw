import fs from "node:fs/promises";
/**
 * AGENT-FREEDOM contract guard (regression).
 *
 * Locks the default runRecipe dispatch path as LIVE (no confirmation "stopper"
 * between seed and spawn). It drives runRecipe with an injected mock planStore
 * and a spy `_spawnStep`, against a minimal in-memory 1-step recipe (ownRecipesDir
 * pointed at a tmp slug-dir containing recipe.md). It asserts the contract:
 *
 *   (a) with dryRun:false  AND  with dryRun OMITTED  → the run reaches dispatch:
 *       `_spawnStep` IS invoked (no confirmation awaited between seed and spawn),
 *       and the result carries NO dryRunPlan.
 *   (b) with dryRun:true   → `_spawnStep` is NEVER invoked and the result carries
 *       a dryRunPlan.
 *
 * This unit is PURELY a regression guard — it modifies no production source. If
 * anyone reintroduces a between-seed-and-spawn approval gate on the default path,
 * (a) breaks. Harness modeled on recipe-runner-resume.test.ts (injects planStore
 * + _spawnStep).
 */
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { runRecipe } from "../recipe-runner.js";

// ── Minimal in-memory PlanStore stand-in (only the methods runRecipe calls) ──
// Mirrors recipe-runner-resume.test.ts: a step going `in_progress` auto-completes,
// so waitForStepDone returns immediately without a live gateway.
interface StepCall {
  stepIndex: number;
  status: Plan["steps"][number]["status"];
  note?: string;
  artifact?: string;
}

function makeMockStore(seed?: Plan) {
  let plan: Plan | null = seed ?? null;
  const stepCalls: StepCall[] = [];
  let closed: { status: string } | null = null;
  return {
    calls: stepCalls,
    getClosed: () => closed,
    getPlan: () => plan,
    async get(_sessionKey: string): Promise<Plan | null> {
      return plan ? JSON.parse(JSON.stringify(plan)) : null;
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
        started: "2026-06-06T00:00:00.000Z",
        updated: "2026-06-06T00:00:00.000Z",
        status: "in_progress",
        currentStep: 0,
        steps: params.steps.map((s) => ({ title: s.title, status: "pending" as const })),
      };
      return JSON.parse(JSON.stringify(plan));
    },
    async step(params: StepCall & { sessionKey: string }): Promise<Plan> {
      stepCalls.push({
        stepIndex: params.stepIndex,
        status: params.status,
        note: params.note,
        artifact: params.artifact,
      });
      if (!plan) throw new Error("no plan");
      const st = plan.steps[params.stepIndex];
      if (!st) throw new Error("step out of range");
      if (params.status === "in_progress") {
        st.status = "done";
        st.note = `auto-done step ${params.stepIndex}`;
        plan.currentStep = params.stepIndex;
      } else {
        st.status = params.status;
        if (params.note !== undefined) st.note = params.note;
        if (params.artifact !== undefined) st.artifact = params.artifact;
      }
      return JSON.parse(JSON.stringify(plan));
    },
    async close(params: { status: string }): Promise<{ ok: true; archivedTo: string }> {
      closed = { status: params.status };
      plan = null;
      return { ok: true, archivedTo: "/dev/null" };
    },
  };
}

describe("runRecipe — AGENT-FREEDOM: default path dispatches live (no stopper)", () => {
  let kitsDir: string;
  beforeAll(async () => {
    kitsDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-no-stopper-"));
    // A minimal 1-step recipe. Single parallelism group [0].
    const md = [
      "---",
      'slug: "onestep"',
      'title: "One Step"',
      'summary: "s"',
      'tags: ["onestep"]',
      'kitRef: "globalcaos/onestep"',
      "parallelism:",
      "  groups:",
      "    - [0]",
      "---",
      "## Steps",
      "### 1. One",
      "do one",
    ].join("\n");
    await fs.mkdir(path.join(kitsDir, "onestep"), { recursive: true });
    await fs.writeFile(path.join(kitsDir, "onestep", "recipe.md"), md);
  });
  afterAll(async () => {
    await fs.rm(kitsDir, { recursive: true, force: true });
  });

  // A spy spawn: records every dispatch and reports success so the mock store
  // (which flips in_progress → done) settles the run. Identical signature to the
  // resume test's noopSpawn, plus a call counter.
  function makeSpawnSpy() {
    const calls: Array<{ task: string; label: string }> = [];
    const spawn = async (task: string, label: string) => {
      calls.push({ task, label });
      return { ok: true as const, runId: "spy-run" };
    };
    return { calls, spawn };
  }

  it("(a) dryRun:false → reaches dispatch (_spawnStep invoked, no dryRunPlan)", async () => {
    const store = makeMockStore();
    const spy = makeSpawnSpy();
    const res = await runRecipe({
      kitRef: "globalcaos/onestep",
      sessionKey: "agent:main:main",
      intent: "One Step",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      dryRun: false,
    });
    expect(res.ok).toBe(true);
    // The single step was dispatched — no confirmation gate between seed and spawn.
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0].label).toBe("globalcaos/onestep:step-0");
    // Live path, not a dry run.
    expect(res.dryRunPlan).toBeUndefined();
    // The run actually drove the step through the store and closed `done`.
    expect(store.calls.some((c) => c.stepIndex === 0)).toBe(true);
    expect(store.getClosed()?.status).toBe("done");
  });

  it("(a') dryRun OMITTED → still reaches dispatch (default is live, not a stopper)", async () => {
    const store = makeMockStore();
    const spy = makeSpawnSpy();
    const res = await runRecipe({
      kitRef: "globalcaos/onestep",
      sessionKey: "agent:main:main",
      intent: "One Step",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      // dryRun omitted → MUST behave as live dispatch
    });
    expect(res.ok).toBe(true);
    expect(spy.calls.length).toBe(1);
    expect(res.dryRunPlan).toBeUndefined();
    expect(store.getClosed()?.status).toBe("done");
  });

  it("(b) dryRun:true → NEVER spawns, returns a dryRunPlan", async () => {
    const store = makeMockStore();
    const spy = makeSpawnSpy();
    const res = await runRecipe({
      kitRef: "globalcaos/onestep",
      sessionKey: "agent:main:main",
      intent: "One Step",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    // No dispatch at all in dry-run mode.
    expect(spy.calls.length).toBe(0);
    // No step rows were written (the store was never advanced).
    expect(store.calls.length).toBe(0);
    // The plan is returned for inspection instead of being executed.
    expect(res.dryRunPlan).toBeDefined();
    expect(res.dryRunPlan?.kitRef).toBe("globalcaos/onestep");
    expect(res.dryRunPlan?.totalSteps).toBe(1);
  });
});
