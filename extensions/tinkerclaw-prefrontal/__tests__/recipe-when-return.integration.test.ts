/**
 * SS2a (2026-06-06): when: guard + return:/done: early-exit, end-to-end.
 * Target: recipe-runner.ts (runtime guard skip-as-done; early-exit terminal state + group-loop close).
 * Bible anchor: subagents-and-recipes.md (SS2 verify: block).
 * Bug-history: a guarded-off step must settle DONE not error; a return: must close the plan DONE not abort, and skip later groups.
 * Catches: guard marked error; later-group step dispatched after early-exit; returnValue lost.
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

function makeScriptedStore(scripts: Record<number, string[]>) {
  let plan: Plan | null = null;
  const stepCalls: StepCall[] = [];
  const attempts: Record<number, number> = {};
  let closed: { status: string } | null = null;
  const copy = (): Plan => JSON.parse(JSON.stringify(plan));
  return {
    calls: stepCalls,
    getClosed: () => closed,
    async get(_s: string): Promise<Plan | null> {
      return plan ? copy() : null;
    },
    async set(p: {
      sessionKey: string;
      intent: string;
      runId: string;
      kitRef?: string;
      steps: Array<{ title: string }>;
    }): Promise<Plan> {
      plan = {
        sessionKey: p.sessionKey,
        runId: p.runId,
        intent: p.intent,
        kitRef: p.kitRef,
        started: "2026-06-06T00:00:00.000Z",
        updated: "2026-06-06T00:00:00.000Z",
        status: "in_progress",
        currentStep: 0,
        steps: p.steps.map((s) => ({ title: s.title, status: "pending" as const })),
      };
      return copy();
    },
    async step(p: StepCall & { sessionKey: string; outputKind?: "json" }): Promise<Plan> {
      stepCalls.push({
        stepIndex: p.stepIndex,
        status: p.status,
        note: p.note,
        artifact: p.artifact,
        output: p.output,
      });
      if (!plan) throw new Error("no plan");
      const st = plan.steps[p.stepIndex];
      if (!st) throw new Error("step out of range");
      if (p.status === "in_progress") {
        const n = attempts[p.stepIndex] ?? 0;
        attempts[p.stepIndex] = n + 1;
        const notes = scripts[p.stepIndex] ?? ["auto-done"];
        st.note = notes[Math.min(n, notes.length - 1)];
        st.status = "done";
        plan.currentStep = p.stepIndex;
      } else {
        st.status = p.status;
        if (p.note !== undefined) st.note = p.note;
        if (p.artifact !== undefined) st.artifact = p.artifact;
        if (p.output !== undefined) st.output = p.output;
        if (p.outputKind !== undefined) st.outputKind = p.outputKind;
      }
      return copy();
    },
    async close(p: { status: string }): Promise<{ ok: true; archivedTo: string }> {
      closed = { status: p.status };
      return { ok: true, archivedTo: "/dev/null" };
    },
  };
}

const GUARD_KIT = `---
schema: "kit/1.0"
slug: "guard-demo"
title: "Guard Demo"
summary: "demo"
tags: ["demo"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Guard Demo

## Steps

### 1. Produce
out: {"type":"object","properties":{"passed":{"type":"boolean"}},"required":["passed"]}

Report whether the build passed.

### 2. OnlyIfPassed
when: steps.1.out.passed == true

Runs only when the build passed.
`;

describe("SS2a when: guard", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss2a-guard-"));
    await fs.mkdir(path.join(dir, "guard-demo"), { recursive: true });
    await fs.writeFile(path.join(dir, "guard-demo", "kit.md"), GUARD_KIT, "utf-8");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skips a guarded step as done (no spawn) when the guard is false", async () => {
    const store = makeScriptedStore({ 0: ['```json\n{"passed": false}\n```'] });
    const spawned: string[] = [];
    const res = await runRecipe({
      kitRef: "guard-demo",
      sessionKey: "s1",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_task: string, label: string) => {
        spawned.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    expect(spawned).toContain("guard-demo:step-0");
    expect(spawned).not.toContain("guard-demo:step-1"); // step 2 guarded off → never spawned
    const step1 = store.calls.filter((c) => c.stepIndex === 1 && c.status === "done").pop();
    expect(step1?.note ?? "").toMatch(/skipped \(when:/);
  });

  it("runs a guarded step when the guard is true", async () => {
    const store = makeScriptedStore({ 0: ['```json\n{"passed": true}\n```'], 1: ["did the work"] });
    const spawned: string[] = [];
    const res = await runRecipe({
      kitRef: "guard-demo",
      sessionKey: "s2",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_task: string, label: string) => {
        spawned.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    expect(spawned).toContain("guard-demo:step-1");
  });
});

const EXIT_KIT = `---
schema: "kit/1.0"
slug: "exit-demo"
title: "Exit Demo"
summary: "demo"
tags: ["demo"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
---

# Exit Demo

## Steps

### 1. Check
Look around.

### 2. EarlyExit
out: {"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}
return:

Close the plan here with a verdict.

### 3. NeverRuns
Should not be dispatched.
`;

describe("SS2a return:/done: early-exit", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss2a-exit-"));
    await fs.mkdir(path.join(dir, "exit-demo"), { recursive: true });
    await fs.writeFile(path.join(dir, "exit-demo", "kit.md"), EXIT_KIT, "utf-8");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("closes the plan as done with the exiting step's value and skips later groups", async () => {
    const store = makeScriptedStore({
      0: ["looked"],
      1: ['```json\n{"verdict": "stop here"}\n```'],
    });
    const spawned: string[] = [];
    const res = await runRecipe({
      kitRef: "exit-demo",
      sessionKey: "e1",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_task: string, label: string) => {
        spawned.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    expect(res.returnValue).toEqual({ verdict: "stop here" });
    expect(store.getClosed()?.status).toBe("done"); // NOT "aborted"
    expect(spawned).toContain("exit-demo:step-1");
    expect(spawned).not.toContain("exit-demo:step-2"); // later group never dispatched
  });
});
