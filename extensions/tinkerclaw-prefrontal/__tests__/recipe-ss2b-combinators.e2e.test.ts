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

interface StepCall {
  stepIndex: number;
  status: Plan["steps"][number]["status"];
  note?: string;
  artifact?: string;
  output?: unknown;
  session?: string;
}

// Session-keyed mock: one Plan per sessionKey (sub-kits get their own session),
// per-(session,step) attempt counters, and scripts keyed by `${session}::${step}`
// with a bare `${step}` fallback (so a uniform sub-kit can be scripted once).
function makeScriptedStore(scripts: Record<string, string[]>) {
  const plans: Record<string, Plan> = {};
  const stepCalls: StepCall[] = [];
  const attempts: Record<string, number> = {};
  const closedBy: Record<string, { status: string }> = {};
  let root: string | null = null;
  const copy = (s: string): Plan => JSON.parse(JSON.stringify(plans[s]));
  const scriptFor = (s: string, step: number): string[] =>
    scripts[`${s}::${step}`] ?? scripts[String(step)] ?? ["auto-done"];
  return {
    calls: stepCalls,
    getClosed: () => (root ? (closedBy[root] ?? null) : null),
    async get(sessionKey: string): Promise<Plan | null> {
      return plans[sessionKey] ? copy(sessionKey) : null;
    },
    async set(p: {
      sessionKey: string;
      intent: string;
      runId: string;
      kitRef?: string;
      steps: Array<{ title: string }>;
    }): Promise<Plan> {
      if (root === null) root = p.sessionKey;
      plans[p.sessionKey] = {
        sessionKey: p.sessionKey,
        runId: p.runId,
        intent: p.intent,
        kitRef: p.kitRef,
        started: "2026-06-06T00:00:00.000Z",
        updated: "2026-06-06T00:00:00.000Z",
        status: "in_progress",
        currentStep: 0,
        steps: p.steps.map((s) => ({ title: s.title, status: "pending" as const })),
      } as Plan;
      return copy(p.sessionKey);
    },
    async step(p: StepCall & { sessionKey: string; outputKind?: "json" }): Promise<Plan> {
      stepCalls.push({
        stepIndex: p.stepIndex,
        status: p.status,
        note: p.note,
        artifact: p.artifact,
        output: p.output,
        session: p.sessionKey,
      });
      const plan = plans[p.sessionKey];
      if (!plan) throw new Error(`no plan for ${p.sessionKey}`);
      const st = plan.steps[p.stepIndex];
      if (!st) throw new Error("step out of range");
      if (p.status === "in_progress") {
        const key = `${p.sessionKey}::${p.stepIndex}`;
        const n = attempts[key] ?? 0;
        attempts[key] = n + 1;
        const notes = scriptFor(p.sessionKey, p.stepIndex);
        st.note = notes[Math.min(n, notes.length - 1)];
        st.status = "done";
        plan.currentStep = p.stepIndex;
      } else {
        st.status = p.status;
        if (p.note !== undefined) st.note = p.note;
        if (p.artifact !== undefined) st.artifact = p.artifact;
        if (p.output !== undefined) st.output = p.output;
        if (p.outputKind !== undefined) (st as Plan["steps"][number]).outputKind = p.outputKind;
      }
      return copy(p.sessionKey);
    },
    async close(p: {
      sessionKey: string;
      status: string;
    }): Promise<{ ok: true; archivedTo: string }> {
      closedBy[p.sessionKey] = { status: p.status };
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
      // root ite1 step 0 (Decide); the then-branch echo runs in ite1::uses::1 at the
      // echo step 0 (bare "0" fallback).
      "ite1::0": ['```json\n{"cond":true,"thenKit":"echo","elseKit":"echo"}\n```'],
      "0": ['```json\n{"v":"x"}\n```'],
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
    // step 3 (Else), in the ROOT session ite1, guarded off (cond==true) → settled
    // done with the skipped note (the else-branch sub-kit never dispatches).
    const step3 = store.calls
      .filter((c) => c.stepIndex === 2 && c.status === "done" && c.session === "ite1")
      .pop();
    expect(step3?.note ?? "").toMatch(/skipped \(when:/);
  });

  it("map fans the worker out over the array", async () => {
    const store = makeScriptedStore({
      // root map1 step 0; each echo element-run (map1::map::1::i) yields its step-0 value.
      "map1::0": ['```json\n{"items":["x","y"],"worker":"echo"}\n```'],
      "0": ['```json\n{"v":"x"}\n```'],
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
      // root comp1 step 0 (Plan); kit1 runs in comp1::uses::1, kit2 in comp1::uses::2,
      // each at the echo step 0 (bare "0" fallback).
      "comp1::0": ['```json\n{"kit1":"echo","kit2":"echo","seed":"s"}\n```'],
      "0": ['```json\n{"v":"x"}\n```'],
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
      // root filt1 step 0; each predicate echo (filt1::filter::1::i) yields a truthy
      // step-0 value, so all elements are kept.
      "filt1::0": ['```json\n{"items":["keep","drop"],"worker":"echo"}\n```'],
      "0": ['```json\n{"v":"x"}\n```'],
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
    // the Filter step's array output lives in the ROOT session filt1 (filter by
    // session so the per-element echo sub-runs don't shadow the parent step).
    const filtOut = store.calls
      .filter((c) => c.stepIndex === 1 && c.session === "filt1" && c.output !== undefined)
      .pop();
    expect(Array.isArray(filtOut?.output)).toBe(true);
  });
});
