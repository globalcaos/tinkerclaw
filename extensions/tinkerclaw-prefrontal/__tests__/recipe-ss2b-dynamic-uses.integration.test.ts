/**
 * SS2b (2026-06-06): dynamic uses: resolution + sub-kit returnValue propagation.
 * Target: recipe-runner.ts (resolveKitRefTemplate, executeOnce resolve-before-guard,
 *   carry sub-kit returnValue up).
 * Bible anchor: subagents-and-recipes.md (SS2b verify: block).
 * Bug-history: a {{steps.N.out.worker}} uses: must dispatch the RESOLVED kit; a plain uses:
 *   recipe with no out: must keep its old prose "composed X" behavior (no regression).
 * Catches: dynamic ref left literal at dispatch; returnValue lost; plain-uses behavior change.
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

// A worker kit that returns a typed value (via return:) so the parent can thread it.
const ECHO_KIT = `---
schema: "kit/1.0"
slug: "echo"
title: "Echo"
summary: "returns a typed value"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Echo

## Steps

### 1. Emit
out: {"type":"object","properties":{"echoed":{"type":"string"}},"required":["echoed"]}
return:

Emit the echoed value.
`;

// A host kit that picks a worker dynamically and uses it.
const DYN_KIT = `---
schema: "kit/1.0"
slug: "dyn-host"
title: "Dynamic Host"
summary: "dispatches a worker chosen at runtime"
tags: ["demo"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Dynamic Host

## Steps

### 1. Pick
out: {"type":"object","properties":{"worker":{"type":"string"}},"required":["worker"]}

Pick a worker kit.

### 2. Run
out: {"type":"object","properties":{"echoed":{"type":"string"}},"required":["echoed"]}
uses: {{steps.1.out.worker}}

Run the chosen worker.
`;

// A plain (static, untyped) uses: host — the no-regression control.
const PLAIN_KIT = `---
schema: "kit/1.0"
slug: "plain-host"
title: "Plain Host"
summary: "static uses, no out:"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Plain Host

## Steps

### 1. Run
uses: echo

Run the echo worker statically.
`;

describe("SS2b dynamic uses: + returnValue", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss2b-dyn-"));
    for (const [slug, md] of [
      ["echo", ECHO_KIT],
      ["dyn-host", DYN_KIT],
      ["plain-host", PLAIN_KIT],
    ] as const) {
      await fs.mkdir(path.join(dir, slug), { recursive: true });
      await fs.writeFile(path.join(dir, slug, "kit.md"), md, "utf-8");
    }
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves a {{steps.N.out.worker}} uses: and dispatches the chosen kit", async () => {
    const store = makeScriptedStore({
      // dyn-host step 0 (Pick) yields the worker name; echo step 0 yields the value.
      0: ['```json\n{"worker": "echo"}\n```', '```json\n{"echoed": "hi"}\n```'],
    });
    const spawned: string[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/dyn-host",
      sessionKey: "d1",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_t: string, label: string) => {
        spawned.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    // the sub-kit echo was dispatched (its step-0 label appears)
    expect(spawned.some((l) => l.startsWith("globalcaos/echo:step-"))).toBe(true);
  });

  it("carries the sub-kit returnValue up to the parent step's output", async () => {
    const store = makeScriptedStore({
      0: ['```json\n{"worker": "echo"}\n```', '```json\n{"echoed": "carried"}\n```'],
    });
    const res = await runRecipe({
      kitRef: "globalcaos/dyn-host",
      sessionKey: "d2",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
    });
    expect(res.ok).toBe(true);
    // step 2's persisted output is the sub-kit's returnValue (the echo's typed return:).
    const step2Out = store.calls.filter((c) => c.stepIndex === 1 && c.output !== undefined).pop();
    expect(step2Out?.output).toEqual({ echoed: "carried" });
  });

  it("NO REGRESSION: a plain static uses: with no out: keeps the prose composed-note", async () => {
    const store = makeScriptedStore({ 0: ["echoed something"] });
    const res = await runRecipe({
      kitRef: "globalcaos/plain-host",
      sessionKey: "p1",
      intent: "test",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
    });
    expect(res.ok).toBe(true);
    expect(store.getClosed()?.status).toBe("done");
    // the parent step still settles done with the "composed …" digest (no output field forced).
    const step1Done = store.calls.filter((c) => c.stepIndex === 0 && c.status === "done").pop();
    expect(step1Done?.artifact ?? "").toMatch(/composed globalcaos\/echo/);
  });
});
