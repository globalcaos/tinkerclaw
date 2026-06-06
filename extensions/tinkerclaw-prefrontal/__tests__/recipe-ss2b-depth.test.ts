/**
 * SS2b (2026-06-06): uses-depth is DERIVED (floor 3), not a frozen constant.
 * Target: recipe-runner.ts (deriveUsesDepthBudget at the const + depth-check call site).
 * Bible anchor: subagents-and-recipes.md (SS2b verify: block).
 * Bug-history: J16 — MAX_USES_DEPTH=3 was a frozen magic number; it must become a floor-3 derivation
 *   (numerically identical today, but derivation-shaped).
 * Catches: a const MAX_USES_DEPTH literal still present; depth not enforced at the floor.
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

// A kit that uses ITSELF — recursion guarded by the depth floor (3) + cycle guard.
const RECUR_KIT = `---
schema: "kit/1.0"
slug: "deep"
title: "Deep"
summary: "uses a deeper kit"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Deep

## Steps

### 1. Recurse
uses: deeper

Go one level deeper.
`;

// 4 chained kits deep > the floor-3 → the 4th must hit the depth limit.
function chainKit(slug: string, next: string | null): string {
  return `---
schema: "kit/1.0"
slug: "${slug}"
title: "${slug}"
summary: "chain"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# ${slug}

## Steps

### 1. Step
${next ? `uses: ${next}\n` : ""}
Do work.
`;
}

describe("SS2b uses-depth floor (3)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss2b-depth-"));
    // chain: d0 -> d1 -> d2 -> d3 -> d4 (leaf). 5 levels > floor 3 → limit hit.
    const chain = ["d0", "d1", "d2", "d3", "d4"];
    for (let i = 0; i < chain.length; i++) {
      const next = i < chain.length - 1 ? chain[i + 1] : null;
      await fs.mkdir(path.join(dir, chain[i]), { recursive: true });
      await fs.writeFile(path.join(dir, chain[i], "kit.md"), chainKit(chain[i], next), "utf-8");
    }
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("enforces the depth floor (3) — a 5-deep chain hits the limit", async () => {
    const store = makeScriptedStore({ 0: ["did work"] });
    const res = await runRecipe({
      kitRef: "globalcaos/d0",
      sessionKey: "depth1",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
    });
    // d0(depth0)->d1(1)->d2(2)->d3(3) — at depth 3 the floor blocks d3->d4.
    expect(res.ok).toBe(false);
    expect(res.errorMessage ?? "").toMatch(/depth limit|group failed/i);
  });
});
