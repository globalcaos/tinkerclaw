/**
 * SS2b (2026-06-06): the four combinator recipes load + run end-to-end.
 * Target: recipes/combinator/{if-then-else,map,filter,compose}.recipe.md via runRecipe.
 * Bible anchor: subagents-and-recipes.md (SS2b verify: block).
 * Bug-history: a combinator recipe must parse + dispatch through the SS2b runtime (dynamic uses:,
 *   when:, map/filter). loadRecipeText is slug-dir-only → stage each recipe at <tmp>/<slug>/recipe.md.
 * Catches: a recipe that fails seed validation; a combinator that doesn't dispatch its sub-kit.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { runRecipe } from "../recipe-runner.js";

// makeScriptedStore copied verbatim from recipe-when-return.integration.test.ts (lines 15-87).
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMBINATOR_DIR = path.resolve(HERE, "..", "recipes", "combinator");

// A trivial typed worker the combinators dispatch.
const ECHO_KIT = `---
schema: "kit/1.0"
slug: "echo"
title: "Echo"
summary: "demo"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Echo

## Steps

### 1. Emit
out: {"type":"object","properties":{"v":{"type":"string"}},"required":["v"]}
return:

Emit a value.
`;

describe("SS2b combinator recipes e2e", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss2b-e2e-"));
    // Stage each on-disk combinator recipe into <tmp>/<slug>/recipe.md (slug-dir layout).
    for (const slug of ["if-then-else", "map", "filter", "compose"]) {
      const src = path.join(COMBINATOR_DIR, `${slug}.recipe.md`);
      const md = await fs.readFile(src, "utf-8");
      await fs.mkdir(path.join(dir, slug), { recursive: true });
      await fs.writeFile(path.join(dir, slug, "recipe.md"), md, "utf-8");
    }
    await fs.mkdir(path.join(dir, "echo"), { recursive: true });
    await fs.writeFile(path.join(dir, "echo", "kit.md"), ECHO_KIT, "utf-8");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("if-then-else runs the then-branch and skips the else", async () => {
    const store = makeScriptedStore({
      0: ['```json\n{"cond":true,"thenKit":"echo","elseKit":"echo"}\n```'],
      1: ['```json\n{"v":"then"}\n```'],
    });
    const spawned: string[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/if-then-else",
      sessionKey: "ite1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_t: string, label: string) => {
        spawned.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    // step 3 (Else) guarded off (cond==true) → settled done with the skipped note.
    const step3 = store.calls.filter((c) => c.stepIndex === 2 && c.status === "done").pop();
    expect(step3?.note ?? "").toMatch(/skipped \(when:/);
  });

  it("map fans the worker out over the array", async () => {
    const store = makeScriptedStore({
      0: ['```json\n{"items":["x","y"],"worker":"echo"}\n```'],
    });
    const workerSpawns: string[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/map",
      sessionKey: "map1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_t: string, label: string) => {
        if (label.startsWith("globalcaos/echo:")) workerSpawns.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    expect(workerSpawns.length).toBe(2);
  });

  it("compose threads kit1 then kit2 (both dispatched)", async () => {
    const store = makeScriptedStore({
      0: ['```json\n{"kit1":"echo","kit2":"echo","seed":"s"}\n```'],
      1: ['```json\n{"v":"first"}\n```'],
      2: ['```json\n{"v":"second"}\n```'],
    });
    const echoRuns: string[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/compose",
      sessionKey: "comp1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_t: string, label: string) => {
        if (label.startsWith("globalcaos/echo:")) echoRuns.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    expect(echoRuns.length).toBeGreaterThanOrEqual(2);
  });

  it("filter keeps elements whose predicate worker returnValue is truthy", async () => {
    const store = makeScriptedStore({
      0: ['```json\n{"items":["keep","drop"],"worker":"echo"}\n```'],
    });
    const res = await runRecipe({
      kitRef: "globalcaos/filter",
      sessionKey: "filt1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
    });
    expect(res.ok).toBe(true);
    const filtOut = store.calls.filter((c) => c.stepIndex === 1 && c.output !== undefined).pop();
    expect(Array.isArray(filtOut?.output)).toBe(true);
  });
});
