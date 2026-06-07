/**
 * BROCA P1.1 (2026-06-07): the ask-for-missing durable-pause branch in the runner.
 * Spec: docs/superpowers/specs/2026-06-07-broca-ask-for-missing-microdesign.md §3.A.
 *
 * Covers:
 *  - deriveAskTimeoutMs RESPONDS to its inputs (2 vars > 1 var; low fitness > high;
 *    always >= the base floor) — it is J16-derived, NOT a frozen constant.
 *  - non-interactive default => the SHIPPED clear-fail; onAskVar NEVER called; the
 *    plan is NEVER seeded/blocked (store untouched).
 *  - interactive + _askResolver returns {var:value} => the plan is set
 *    blocked-awaiting-input BEFORE the ask, onAskVar fires exactly once, the plan
 *    flips back to in_progress, _spawnStep dispatches, and the run is ok:true.
 *  - interactive + _askResolver returns null => the plan IS blocked during the wait,
 *    the final result is the clear-fail, and NO step is dispatched.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { runRecipe, deriveAskTimeoutMs } from "../recipe-runner.js";

// A mock plan-store that records setStatus transitions and exposes the live
// plan-level status, so the test can assert the durable pause ordering. Mirrors
// makeMockStore in recipe-runner-compile.test.ts + adds setStatus (BROCA P1.1).
function makeAskStore() {
  let plan: Plan | null = null;
  const stepCalls: Array<{ stepIndex: number; status: Plan["steps"][number]["status"] }> = [];
  const statusLog: Array<Plan["status"]> = [];
  let closed: { status: string } | null = null;
  const copy = (): Plan | null => (plan ? JSON.parse(JSON.stringify(plan)) : null);
  return {
    calls: stepCalls,
    statusLog,
    getClosed: () => closed,
    getStatus: () => plan?.status ?? null,
    isSeeded: () => plan !== null,
    async get(_sessionKey: string): Promise<Plan | null> {
      return copy();
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
        started: "2026-06-07T00:00:00.000Z",
        updated: "2026-06-07T00:00:00.000Z",
        status: "in_progress",
        currentStep: 0,
        steps: params.steps.map((s) => ({ title: s.title, status: "pending" as const })),
      };
      return JSON.parse(JSON.stringify(plan));
    },
    async setStatus(_sessionKey: string, status: Plan["status"]): Promise<Plan> {
      if (!plan) throw new Error("setStatus: no plan");
      plan.status = status;
      statusLog.push(status);
      return JSON.parse(JSON.stringify(plan));
    },
    async step(params: {
      sessionKey: string;
      stepIndex: number;
      status: Plan["steps"][number]["status"];
      note?: string;
      artifact?: string;
    }): Promise<Plan> {
      stepCalls.push({ stepIndex: params.stepIndex, status: params.status });
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
      return { ok: true, archivedTo: "/dev/null" };
    },
  };
}

function makeSpawnSpy() {
  const calls: Array<{ task: string; label: string }> = [];
  const spawn = async (task: string, label: string) => {
    calls.push({ task, label });
    return { ok: true as const, runId: "spy-run" };
  };
  return { calls, spawn };
}

describe("deriveAskTimeoutMs (J16-derived ask timeout, never frozen)", () => {
  it("RESPONDS: more missing vars => longer timeout", () => {
    const one = deriveAskTimeoutMs({ missingVarCount: 1, stepCount: 3 });
    const two = deriveAskTimeoutMs({ missingVarCount: 2, stepCount: 3 });
    expect(two).toBeGreaterThan(one);
  });
  it("RESPONDS: lower fitness (more uncertainty) => longer timeout", () => {
    const low = deriveAskTimeoutMs({ missingVarCount: 1, stepCount: 3, fitnessSuccessRate: 0.1 });
    const high = deriveAskTimeoutMs({ missingVarCount: 1, stepCount: 3, fitnessSuccessRate: 0.9 });
    expect(low).toBeGreaterThan(high);
  });
  it("never drops below the base floor", () => {
    // base = 60000 + 30000*1 + 5000*min(3,12) = 105000; a high-fitness run never
    // goes below that floor (the (1+uncertainty) scale is always >= 1).
    const base = 60000 + 30000 * 1 + 5000 * 3;
    const t = deriveAskTimeoutMs({ missingVarCount: 1, stepCount: 3, fitnessSuccessRate: 1 });
    expect(t).toBeGreaterThanOrEqual(base);
  });
});

describe("runRecipe ask-for-missing durable-pause branch (BROCA P1.1)", () => {
  let kitsDir: string;
  beforeAll(async () => {
    kitsDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-ask-"));
    // A 1-step recipe declaring ONE required param, referenced in the body so the
    // seed-time checkParamRefs gate is satisfied.
    const md = [
      "---",
      'slug: "needsvar"',
      'title: "Needs Var"',
      'summary: "s"',
      'tags: ["needsvar"]',
      'kitRef: "globalcaos/needsvar"',
      "params:",
      '  target: { type: "string", required: true, description: "the funnel target domain" }',
      "parallelism:",
      "  groups:",
      "    - [0]",
      "---",
      "## Steps",
      "### 1. One",
      "work on {{target}}",
    ].join("\n");
    await fs.mkdir(path.join(kitsDir, "needsvar"), { recursive: true });
    await fs.writeFile(path.join(kitsDir, "needsvar", "recipe.md"), md);
  });
  afterAll(async () => {
    await fs.rm(kitsDir, { recursive: true, force: true });
  });

  it("non-interactive default => clear-fail; onAskVar never called; plan never blocked", async () => {
    const store = makeAskStore();
    const spy = makeSpawnSpy();
    let askCount = 0;
    const res = await runRecipe({
      kitRef: "globalcaos/needsvar",
      sessionKey: "agent:ask:nonint",
      intent: "Needs Var",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      onAskVar: () => {
        askCount++;
      },
      // interactiveMode OMITTED (defaults false) → the shipped clear-fail.
      // parameters OMITTED → target unresolved.
    });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("missing-var");
    expect(askCount).toBe(0);
    // The plan was never seeded or blocked (store untouched on the clear-fail path).
    expect(store.isSeeded()).toBe(false);
    expect(store.statusLog).toEqual([]);
    expect(spy.calls.length).toBe(0);
  });

  it("interactive + resolver returns {var:value} => blocked-before-ask, onAskVar once, back to in_progress, dispatched, ok:true", async () => {
    const store = makeAskStore();
    const spy = makeSpawnSpy();
    let askCount = 0;
    let statusAtAsk: string | null = null;
    const res = await runRecipe({
      kitRef: "globalcaos/needsvar",
      sessionKey: "agent:ask:ok",
      intent: "Needs Var",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      interactiveMode: true,
      onAskVar: (ev) => {
        askCount++;
        // The durable pause must be written BEFORE the ask fires.
        statusAtAsk = store.getStatus();
        expect(ev.missingVars).toEqual([{ name: "target", prompt: "the funnel target domain" }]);
      },
      _askResolver: async (ev) => {
        // The resolver runs DURING the blocked window.
        expect(store.getStatus()).toBe("blocked-awaiting-input");
        expect(ev.timeoutMs).toBeGreaterThan(0);
        return { target: "thetinkerzone.com" };
      },
    });
    expect(askCount).toBe(1);
    expect(statusAtAsk).toBe("blocked-awaiting-input");
    // The status walked blocked -> in_progress.
    expect(store.statusLog).toEqual(["blocked-awaiting-input", "in_progress"]);
    // It fell through to dispatch with the now-resolved value.
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0].task).toMatch(/thetinkerzone\.com/);
    expect(store.getClosed()?.status).toBe("done");
  });

  it("interactive + resolver returns null => plan blocked during wait, final clear-fail, no dispatch", async () => {
    const store = makeAskStore();
    const spy = makeSpawnSpy();
    let askCount = 0;
    let statusDuringWait: string | null = null;
    const res = await runRecipe({
      kitRef: "globalcaos/needsvar",
      sessionKey: "agent:ask:null",
      intent: "Needs Var",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      interactiveMode: true,
      onAskVar: () => {
        askCount++;
      },
      _askResolver: async () => {
        statusDuringWait = store.getStatus();
        return null; // timeout / decline
      },
    });
    expect(askCount).toBe(1);
    // The plan WAS blocked while the resolver was awaited.
    expect(statusDuringWait).toBe("blocked-awaiting-input");
    // Final outcome is the clear-fail; the plan stays blocked on disk (never flipped).
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("missing-var");
    expect(store.getStatus()).toBe("blocked-awaiting-input");
    expect(store.statusLog).toEqual(["blocked-awaiting-input"]);
    // No step dispatched, plan not closed.
    expect(spy.calls.length).toBe(0);
    expect(store.getClosed()).toBeNull();
  });
});
