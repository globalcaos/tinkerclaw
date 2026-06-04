/**
 * SS3 Task 4 — `invoke skill:` execute integration.
 *
 * Drives runRecipe against a scripted mock PlanStore (auto-completes a step on
 * in_progress, like typed-ports.integration.test.ts) + a fake skill library.
 * Asserts: the skill's procedure is injected into the task, the skill's
 * outputSchema validates the output (reusing the SS1 typed-output path), the
 * validated output persists, onSkillOutcome fires once on success, and a
 * missing/deprecated skill fails closed (firing onSkillOutcome=false).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import type { Skill } from "../../../src/memory/storage/types.js";
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
    async get(): Promise<Plan | null> {
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

function typedSkill(over: Partial<Skill> = {}): Skill {
  return {
    skillId: "typed-x",
    version: 1,
    name: "typed-x",
    description: "do a typed thing",
    prerequisites: [],
    steps: ["do the thing", "return ok"],
    testCases: [],
    successMetrics: { invocations: 0, successes: 0, successRate: 0.5, lastInvoked: null },
    sourceEpisodeIds: [],
    created: "2026-06-04T00:00:00.000Z",
    deprecated: false,
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    ...over,
  };
}

function fakeLib(skills: Record<string, Skill | undefined>) {
  return { read: (id: string) => skills[id] } as never;
}

const SKILL_KIT = `---
schema: "kit/1.0"
slug: "skill-e2e"
title: "Skill E2E"
summary: "demo"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Skill E2E

## Steps

### 1. Apply
invoke skill: typed-x

Apply the skill to the task.
`;

describe("invoke skill: execute (SS3 Task 4)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-exec-"));
    await fs.mkdir(path.join(dir, "skill-e2e"), { recursive: true });
    await fs.writeFile(path.join(dir, "skill-e2e", "kit.md"), SKILL_KIT, "utf-8");
    // missing-skill variant: same kit, references a skill the library lacks.
    await fs.mkdir(path.join(dir, "skill-missing"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "skill-missing", "kit.md"),
      SKILL_KIT.replace('slug: "skill-e2e"', 'slug: "skill-missing"').replace(
        "invoke skill: typed-x",
        "invoke skill: nope",
      ),
      "utf-8",
    );
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("injects the skill procedure, validates typed output, persists it, fires onSkillOutcome(true)", async () => {
    const store = makeScriptedStore({ 0: ['```json\n{"ok": true}\n```'] });
    const outcomes: Array<[string, boolean]> = [];
    const tasksSeen: string[] = [];

    const result = await runRecipe({
      kitRef: "globalcaos/skill-e2e",
      sessionKey: "skill-1",
      intent: "demo",
      planStore: store as never,
      ownRecipesDir: dir,
      skillLibrary: fakeLib({ "typed-x": typedSkill() }),
      onSkillOutcome: (id, ok) => outcomes.push([id, ok]),
      _spawnStep: async (task: string) => {
        tasksSeen.push(task);
        return { ok: true as const, runId: "mock" };
      },
    });

    expect(result.ok).toBe(true);
    const applyTask = tasksSeen.find((t) => t.includes("Step 1/"));
    expect(applyTask).toBeDefined();
    expect(applyTask!).toContain("Skill typed-x procedure:");
    expect(applyTask!).toContain("do the thing");
    // The skill's outputSchema drove the structured-output instruction.
    expect(applyTask!).toContain("Structured output required");

    const outputWrite = store.calls.find((c) => c.stepIndex === 0 && c.output !== undefined);
    expect(outputWrite?.output).toEqual({ ok: true });
    expect(outcomes).toEqual([["typed-x", true]]);
  }, 30_000);

  it("fails closed on a missing skill and fires onSkillOutcome(false)", async () => {
    const store = makeScriptedStore({ 0: ["whatever"] });
    const outcomes: Array<[string, boolean]> = [];

    const result = await runRecipe({
      kitRef: "globalcaos/skill-missing",
      sessionKey: "skill-2",
      intent: "demo",
      planStore: store as never,
      ownRecipesDir: dir,
      skillLibrary: fakeLib({ "typed-x": typedSkill() }), // "nope" is absent
      onSkillOutcome: (id, ok) => outcomes.push([id, ok]),
      _spawnStep: async () => ({ ok: true as const, runId: "mock" }),
    });

    expect(result.ok).toBe(false);
    expect(outcomes).toEqual([["nope", false]]);
  }, 30_000);

  it("fails closed on a deprecated skill", async () => {
    const store = makeScriptedStore({ 0: ['```json\n{"ok": true}\n```'] });
    const outcomes: Array<[string, boolean]> = [];
    const result = await runRecipe({
      kitRef: "globalcaos/skill-e2e",
      sessionKey: "skill-3",
      intent: "demo",
      planStore: store as never,
      ownRecipesDir: dir,
      skillLibrary: fakeLib({ "typed-x": typedSkill({ deprecated: true }) }),
      onSkillOutcome: (id, ok) => outcomes.push([id, ok]),
      _spawnStep: async () => ({ ok: true as const, runId: "mock" }),
    });
    expect(result.ok).toBe(false);
    expect(outcomes).toEqual([["typed-x", false]]);
  }, 30_000);
});
