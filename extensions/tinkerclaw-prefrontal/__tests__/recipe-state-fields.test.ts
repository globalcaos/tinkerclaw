/**
 * BROCA visibility (2026-06-06): recipe-state events carry turnId + skillId.
 * Target: recipe-runner.ts (RecipeStateUpdate.turnId/skillId + the emitRecipeState sites).
 * Bible anchor: handoff 2026-06-06-broca-visibility-server-handoff.md; subagents-and-recipes.md.
 * Bug-history: the UI scopes composition to the current prompt (turnId) and colors the
 *   per-step skill (skillId) — both must ride the live recipe-state event, back-compat.
 * Catches: a recipe-state emit missing turnId; the skill step's skillId not surfaced.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { runRecipe, type RecipeStateUpdate } from "../recipe-runner.js";

// Session-keyed mock (one Plan per sessionKey; per-(session,step) attempts; scripts
// keyed `${session}::${step}` with a bare `${step}` fallback) — copied from
// recipe-ss5-recovery.integration.test.ts.
function makeScriptedStore(scripts: Record<string, string[]>) {
  const plans: Record<string, Plan> = {};
  const attempts: Record<string, number> = {};
  const closedBy: Record<string, { status: string }> = {};
  const copy = (s: string): Plan => JSON.parse(JSON.stringify(plans[s]));
  const scriptFor = (s: string, step: number): string[] =>
    scripts[`${s}::${step}`] ?? scripts[String(step)] ?? ["auto-done"];
  return {
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
    async step(p: {
      sessionKey: string;
      stepIndex: number;
      status: Plan["steps"][number]["status"];
      note?: string;
      artifact?: string;
      output?: unknown;
      outputKind?: "json";
    }): Promise<Plan> {
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

const SKILL_KIT = `---
schema: "kit/1.0"
slug: "skill-host"
title: "Skill Host"
summary: "demo"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Skill Host

## Steps

### 1. Echo
invoke skill: echo

Run the echo skill.
`;

// Minimal skill library so the invoke-skill step resolves (no outputSchema → plain
// spawn path, succeeds via the _spawnStep no-op).
const skillLibrary = { read: () => ({ steps: ["do it"], deprecated: false }) } as never;

describe("BROCA recipe-state turnId + skillId", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "broca-state-"));
    await fs.mkdir(path.join(dir, "skill-host"), { recursive: true });
    await fs.writeFile(path.join(dir, "skill-host", "kit.md"), SKILL_KIT, "utf-8");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("every recipe-state event carries turnId = sessionKey; the skill step's event carries skillId", async () => {
    const store = makeScriptedStore({ "tx::0": ["did it"] });
    const states: RecipeStateUpdate[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/skill-host",
      sessionKey: "tx",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
      skillLibrary,
      onRecipeState: (s) => states.push(s),
    });
    expect(res.ok).toBe(true);
    expect(states.length).toBeGreaterThan(0);
    // turnId rides EVERY event and equals the run's sessionKey (stable per turn).
    expect(states.every((s) => s.turnId === "tx")).toBe(true);
    // the skill step's event surfaces the invoked skill id.
    expect(states.some((s) => s.skillId === "echo")).toBe(true);
  });

  it("back-compat: a non-skill step's event has skillId undefined (turnId still present)", async () => {
    const PLAIN_KIT = SKILL_KIT.replace("invoke skill: echo\n\n", "").replace(
      "skill-host",
      "plain-host",
    );
    await fs.mkdir(path.join(dir, "plain-host"), { recursive: true });
    await fs.writeFile(path.join(dir, "plain-host", "kit.md"), PLAIN_KIT, "utf-8");
    const store = makeScriptedStore({ "px::0": ["did it"] });
    const states: RecipeStateUpdate[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/plain-host",
      sessionKey: "px",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
      onRecipeState: (s) => states.push(s),
    });
    expect(res.ok).toBe(true);
    expect(states.every((s) => s.turnId === "px")).toBe(true);
    expect(states.every((s) => s.skillId === undefined)).toBe(true);
  });
});
