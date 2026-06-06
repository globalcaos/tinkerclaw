/**
 * SS5b (2026-06-06): per-spawn budget directives — allow-tools / max-tokens /
 * max-tool-calls.
 * Target: recipe-runner.ts (parseAllowToolsDirective / parseMaxTokensDirective /
 *   parseMaxToolCallsDirective, StepDispatch.{allowTools,maxTokens,maxToolCalls},
 *   the dispatch-build deriveSpawnBudget fail-closed wire, and the spawnOpts threaded
 *   through the _spawnStep seam).
 * Bug-history: an absent max-tokens MUST fall back to the DERIVED (non-frozen)
 *   deriveSpawnBudget bound, not a constant; a garbage `max-tokens:{{nope}}` MUST
 *   fail closed to that same derived bound WITHOUT throwing; the three directives
 *   parse off a step; the spawnOpts MUST reach the spawn seam.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import {
  runRecipe,
  parseAllowToolsDirective,
  parseMaxTokensDirective,
  parseMaxToolCallsDirective,
  type SpawnOpts,
} from "../recipe-runner.js";
import { deriveSpawnBudget } from "../spawn-budget.js";

// Session-keyed scripted store (mirrors recipe-ss5-recovery.integration.test.ts):
// an in_progress step settles `done` with the scripted note for its `${session}::${step}`.
function makeScriptedStore(scripts: Record<string, string[]> = {}) {
  const plans: Record<string, Plan> = {};
  const stepCalls: Array<{ stepIndex: number; status: string; session?: string }> = [];
  const attempts: Record<string, number> = {};
  const closedBy: Record<string, { status: string }> = {};
  let root: string | null = null;
  const copy = (s: string): Plan => JSON.parse(JSON.stringify(plans[s]));
  const scriptFor = (s: string, step: number): string[] =>
    scripts[`${s}::${step}`] ?? scripts[String(step)] ?? ["auto-done"];
  return {
    calls: stepCalls,
    getClosed: () => (root ? (closedBy[root] ?? null) : null),
    closedBy,
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
    async step(p: {
      sessionKey: string;
      stepIndex: number;
      status: Plan["steps"][number]["status"];
      note?: string;
      artifact?: string;
      output?: unknown;
      outputKind?: "json";
      error?: unknown;
    }): Promise<Plan> {
      stepCalls.push({ stepIndex: p.stepIndex, status: p.status, session: p.sessionKey });
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
        if (p.error !== undefined) (st as Plan["steps"][number]).error = p.error as never;
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

// A single-step kit carrying all three SS5b directives with LITERAL values.
const LITERAL_KIT = `---
schema: "kit/1.0"
slug: "spawn-literal"
title: "Spawn Literal"
summary: "a step with allow-tools / max-tokens / max-tool-calls literals"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Spawn Literal

## Steps

### 1. Work
allow-tools: Read, Grep, Edit
max-tokens: 4096
max-tool-calls: 12

Do the work.
`;

// A single-step kit whose max-tokens is a garbage/unresolved template — must fail
// closed to the derived bound. No out: schema, no skill → derived from defaults.
const GARBAGE_KIT = `---
schema: "kit/1.0"
slug: "spawn-garbage"
title: "Spawn Garbage"
summary: "a garbage max-tokens template fails closed to the derived bound"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Spawn Garbage

## Steps

### 1. Work
allow-tools: Read
max-tokens: {{nope}}

Do the work.
`;

describe("SS5b per-spawn budget directives", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss5b-"));
    for (const [slug, md] of [
      ["spawn-literal", LITERAL_KIT],
      ["spawn-garbage", GARBAGE_KIT],
    ] as const) {
      await fs.mkdir(path.join(dir, slug), { recursive: true });
      await fs.writeFile(path.join(dir, slug, "kit.md"), md, "utf-8");
    }
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("parses the three SS5b directives off a step body", () => {
    const body =
      "allow-tools: Read, Grep , Edit\nmax-tokens: 4096\nmax-tool-calls: 12\n\nDo the work.";
    expect(parseAllowToolsDirective(body)).toEqual(["Read", "Grep", "Edit"]);
    expect(parseMaxTokensDirective(body)).toBe("4096");
    expect(parseMaxToolCallsDirective(body)).toBe("12");
    // absent directives → undefined (no fabricated values).
    expect(parseAllowToolsDirective("Just prose.")).toBeUndefined();
    expect(parseMaxTokensDirective("Just prose.")).toBeUndefined();
    expect(parseMaxToolCallsDirective("Just prose.")).toBeUndefined();
  });

  it("threads literal spawnOpts through the _spawnStep seam", async () => {
    const store = makeScriptedStore();
    let captured: SpawnOpts | undefined;
    const res = await runRecipe({
      kitRef: "globalcaos/spawn-literal",
      sessionKey: "sl1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_task: string, _label: string, spawnOpts?: SpawnOpts) => {
        captured = spawnOpts;
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    expect(store.getClosed()?.status).toBe("done");
    expect(captured?.allowTools).toEqual(["Read", "Grep", "Edit"]);
    expect(captured?.maxTokens).toBe(4096);
    expect(captured?.maxToolCalls).toBe(12);
  });

  it("a garbage max-tokens:{{nope}} fails closed to the DERIVED bound without throwing", async () => {
    const store = makeScriptedStore();
    let captured: SpawnOpts | undefined;
    // The garbage kit has no out: schema and no skill, so the derived bound is the
    // default deriveSpawnBudget for those inputs — NOT a frozen constant.
    const expectedDerived = deriveSpawnBudget({
      requiredFieldCount: 0,
      skillInvoked: false,
      fitnessSuccessRate: undefined,
      remainingTokenBudget: undefined,
    });
    const res = await runRecipe({
      kitRef: "globalcaos/spawn-garbage",
      sessionKey: "sg1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_task: string, _label: string, spawnOpts?: SpawnOpts) => {
        captured = spawnOpts;
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true); // did NOT throw on the unresolved template
    expect(store.getClosed()?.status).toBe("done");
    expect(captured?.maxTokens).toBe(expectedDerived);
    // it is a real (positive, finite) derived bound, not NaN / undefined.
    expect(Number.isFinite(captured?.maxTokens)).toBe(true);
    expect(captured?.maxTokens).toBeGreaterThanOrEqual(1);
  });
});
