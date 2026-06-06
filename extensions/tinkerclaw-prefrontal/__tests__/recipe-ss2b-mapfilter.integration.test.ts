/**
 * SS2b (2026-06-06): map/filter iteration runtime.
 * Target: recipe-runner.ts (executeOnce map/filter arm, {{item}}/{{index}} injection,
 *   deriveCombinatorFanOut wiring, depth +1 once, aggregation).
 * Bible anchor: subagents-and-recipes.md (SS2b verify: block).
 * Bug-history: per-element worker dispatch is SIBLING dispatch — it must NOT route each element
 *   through a _depth-incrementing runRecipe (that would explode the depth budget).
 * Catches: depth incremented per element; fan-out != arrayLength; {{item}} not substituted.
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

const WORKER_KIT = `---
schema: "kit/1.0"
slug: "upper"
title: "Upper"
summary: "uppercases {{item}}"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Upper

## Steps

### 1. Do
out: {"type":"object","properties":{"v":{"type":"string"}},"required":["v"]}
return:

Uppercase {{item}} (index {{index}}).
`;

const MAP_KIT = `---
schema: "kit/1.0"
slug: "map-host"
title: "Map Host"
summary: "maps a worker over an array"
tags: ["demo"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Map Host

## Steps

### 1. Produce
out: {"type":"object","properties":{"items":{"type":"array"}},"required":["items"]}

Produce the array to map over.

### 2. Map
out: {"type":"array"}
map: steps.1.out.items
uses: {{steps.1.out.worker}}

Run the worker for each element.
`;

describe("SS2b map iteration", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss2b-map-"));
    for (const [slug, md] of [
      ["upper", WORKER_KIT],
      ["map-host", MAP_KIT],
    ] as const) {
      await fs.mkdir(path.join(dir, slug), { recursive: true });
      await fs.writeFile(path.join(dir, slug, "kit.md"), md, "utf-8");
    }
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fans the worker out once per element (fan-out = arrayLength) and aggregates returnValues in order", async () => {
    // step 0 yields {items:[...], worker:"upper"}; each upper run returns {v:...}.
    const store = makeScriptedStore({
      0: ['```json\n{"items":["a","b","c"],"worker":"upper"}\n```'],
      // the worker (upper) step 0 returns a value each time it is run.
      // because each element is a SIBLING dispatch reusing the same sub-session key
      // suffix per index, scripts are keyed by the upper-kit step index (0).
    });
    const workerSpawns: string[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/map-host",
      sessionKey: "m1",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (task: string, label: string) => {
        if (label.startsWith("globalcaos/upper:")) workerSpawns.push(task);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    // fan-out = arrayLength = 3 worker dispatches
    expect(workerSpawns.length).toBe(3);
    // {{item}}/{{index}} substituted per element
    expect(workerSpawns.some((t) => t.includes("Uppercase a (index 0)"))).toBe(true);
    expect(workerSpawns.some((t) => t.includes("Uppercase c (index 2)"))).toBe(true);
    // step 2 (Map) persisted an array output of length 3
    const mapOut = store.calls.filter((c) => c.stepIndex === 1 && c.output !== undefined).pop();
    expect(Array.isArray(mapOut?.output)).toBe(true);
    expect((mapOut?.output as unknown[]).length).toBe(3);
  });
});
