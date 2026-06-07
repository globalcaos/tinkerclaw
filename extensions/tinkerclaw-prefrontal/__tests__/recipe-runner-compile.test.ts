import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { checkPortWiring, runRecipe, type CompileStep } from "../recipe-runner.js";
import { isRecoverableKind } from "../recipe-types.js";

const produce: CompileStep = {
  title: "Produce",
  out: { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] },
  in: undefined,
};

describe("checkPortWiring (plan-compile)", () => {
  it("passes a correctly wired pair", () => {
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.1.out.passed" }],
    };
    expect(checkPortWiring([produce, consume])).toEqual([]);
  });
  it("fails when the producer declares no out: schema", () => {
    const plain: CompileStep = { title: "Plain" };
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.1.out.passed" }],
    };
    const errs = checkPortWiring([plain, consume]);
    expect(errs.join(" ")).toMatch(/step 1.*no out:/i);
  });
  it("fails when the producer's schema lacks the referenced field", () => {
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.1.out.missing" }],
    };
    expect(checkPortWiring([produce, consume]).join(" ")).toMatch(/missing/i);
  });
  it("fails when from references a later or non-existent step", () => {
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.9.out.passed" }],
    };
    expect(checkPortWiring([produce, consume]).join(" ")).toMatch(
      /step 9.*does not exist|precede/i,
    );
  });
});

// ── SS-params: missing-var clear-fail gate (Unit 4) ──────────────────────────
// Asserts (1) the missing-var kind is NON-recoverable (retry can't conjure a
// value); (2) a recipe declaring a required param run with NO value fails CLEARLY
// with a structured missing-var error AND dispatches ZERO subagents; (3) the same
// recipe WITH the value seeds normally (the gate is purely the fail-clearly
// backstop, not a stopper). Harness modeled on recipe-run-no-stopper.test.ts.

function makeMockStore() {
  let plan: Plan | null = null;
  const stepCalls: Array<{ stepIndex: number; status: Plan["steps"][number]["status"] }> = [];
  let closed: { status: string } | null = null;
  return {
    calls: stepCalls,
    getClosed: () => closed,
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
        started: "2026-06-07T00:00:00.000Z",
        updated: "2026-06-07T00:00:00.000Z",
        status: "in_progress",
        currentStep: 0,
        steps: params.steps.map((s) => ({ title: s.title, status: "pending" as const })),
      };
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
      plan = null;
      return { ok: true, archivedTo: "/dev/null" };
    },
  };
}

describe("checkRequiredVars (missing-var clear-fail gate)", () => {
  let kitsDir: string;
  beforeAll(async () => {
    kitsDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-missing-var-"));
    // A 1-step recipe declaring ONE required param (referenced in the step body so
    // the seed-time checkParamRefs gate is satisfied). Inline-flow params: block.
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

  function makeSpawnSpy() {
    const calls: Array<{ task: string; label: string }> = [];
    const spawn = async (task: string, label: string) => {
      calls.push({ task, label });
      return { ok: true as const, runId: "spy-run" };
    };
    return { calls, spawn };
  }

  it("missing-var is NON-recoverable (retry cannot conjure a value)", () => {
    expect(isRecoverableKind("missing-var")).toBe(false);
  });

  it("a required param run with NO value → clear-fail, ZERO subagents dispatched", async () => {
    const store = makeMockStore();
    const spy = makeSpawnSpy();
    const res = await runRecipe({
      kitRef: "globalcaos/needsvar",
      sessionKey: "agent:main:main",
      intent: "Needs Var",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      // parameters OMITTED → the required `target` is unresolved.
    });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("missing-var");
    expect(res.error?.recoverable).toBe(false);
    const missingVars = res.error?.details?.missingVars as
      | Array<{ name: string; prompt: string }>
      | undefined;
    expect(missingVars).toEqual([{ name: "target", prompt: "the funnel target domain" }]);
    // The error message is non-empty and names the missing var + its prompt.
    expect(res.errorMessage ?? "").toMatch(/target/);
    expect(res.errorMessage ?? "").toMatch(/funnel target domain/);
    // NO dispatch, NO plan seeded (failed before any spawn).
    expect(spy.calls.length).toBe(0);
    expect(store.calls.length).toBe(0);
    expect(store.getClosed()).toBeNull();
  });

  it("the SAME recipe WITH the value seeds + dispatches normally", async () => {
    const store = makeMockStore();
    const spy = makeSpawnSpy();
    const res = await runRecipe({
      kitRef: "globalcaos/needsvar",
      sessionKey: "agent:main:main",
      intent: "Needs Var",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: spy.spawn,
      parameters: { target: "thetinkerzone.com" },
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(spy.calls.length).toBe(1);
    // The required value substituted into the dispatched task body.
    expect(spy.calls[0].task).toMatch(/thetinkerzone\.com/);
    expect(store.getClosed()?.status).toBe("done");
  });
});
