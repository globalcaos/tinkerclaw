/**
 * SS5a (2026-06-06): catchable recovery — retry / fallback / continue-partial.
 * Target: recipe-runner.ts (parseOnErrorDirective, StepDispatch.onError, checkOnErrorRefs,
 *   markError(note,err?), executeOnce error classification, the no-loop recovery driver,
 *   the 'done-partial' settlement + group handler).
 * Bible anchor: subagents-and-recipes.md (SS5a verify: block).
 * Bug-history: a non-recoverable error (guard-eval) must NOT be retried; a transient failure
 *   must recover on retry; continue-partial must NOT abort the plan; fallback dispatches the kit.
 * Catches: retry on a hard limit; a failed step aborting under continue-partial; fallback not run.
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
  error?: unknown;
  session?: string;
}

// Session-keyed mock (copied from recipe-ss2b-dynamic-uses.integration.test.ts) +
// SS5a `failOn`/`failOnce`: a `${session}::${step}` key in `failOn` makes that
// step's in_progress settle as status:"error"; `failOnce` makes it fail only on
// the FIRST attempt (so a retry can recover a transient failure).
function makeScriptedStore(
  scripts: Record<string, string[]>,
  failOn: Set<string> = new Set(),
  failOnce: Set<string> = new Set(),
) {
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
    async step(p: StepCall & { sessionKey: string; outputKind?: "json" }): Promise<Plan> {
      stepCalls.push({
        stepIndex: p.stepIndex,
        status: p.status,
        note: p.note,
        artifact: p.artifact,
        output: p.output,
        error: p.error,
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
        const shouldFail = failOn.has(key) || (failOnce.has(key) && n === 0);
        if (shouldFail) {
          st.status = "error";
          st.note = `scripted failure (attempt ${n + 1})`;
          plan.currentStep = p.stepIndex;
        } else {
          const notes = scriptFor(p.sessionKey, p.stepIndex);
          st.note = notes[Math.min(n, notes.length - 1)];
          st.status = "done";
          plan.currentStep = p.stepIndex;
        }
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

// A plain step kit whose single step is transiently flaky; onError retries it.
const RETRY_KIT = `---
schema: "kit/1.0"
slug: "retry-host"
title: "Retry Host"
summary: "a transiently flaky step recovered by onError: retry"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Retry Host

## Steps

### 1. Flaky
onError: retry 3

Do the flaky thing.
`;

// A worker the fallback dispatches, and a host whose step fails then falls back to it.
const FALLBACK_WORKER = `---
schema: "kit/1.0"
slug: "rescue"
title: "Rescue"
summary: "the recovery kit"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Rescue

## Steps

### 1. Rescue

Recover the failed work.
`;

const FALLBACK_KIT = `---
schema: "kit/1.0"
slug: "fb-host"
title: "Fallback Host"
summary: "a failing step caught by onError: fallback kit:rescue"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Fallback Host

## Steps

### 1. Risky
onError: fallback kit:rescue

Try the risky thing.
`;

// A map host whose worker fails on one element; continue-partial drops it.
const WORKER_KIT = `---
schema: "kit/1.0"
slug: "el-worker"
title: "Element Worker"
summary: "processes one element"
tags: ["demo"]
parallelism:
  groups:
    - [0]
---

# Element Worker

## Steps

### 1. Do
out: {"type":"object","properties":{"v":{"type":"string"}},"required":["v"]}
return:

Process {{item}} (index {{index}}).
`;

const MAP_PARTIAL_KIT = `---
schema: "kit/1.0"
slug: "map-partial"
title: "Map Partial"
summary: "maps a worker; a failed element is dropped via continue-partial"
tags: ["demo"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Map Partial

## Steps

### 1. Produce
out: {"type":"object","properties":{"items":{"type":"array"},"worker":{"type":"string"}},"required":["items","worker"]}

Produce the array.

### 2. Map
out: {"type":"array"}
map: steps.1.out.items
uses: {{steps.1.out.worker}}
onError: continue-partial

Map the worker over each element; drop a failed element.
`;

// A guarded step whose guard EVALUATION errors (non-recoverable) — onError: retry
// must NOT retry it. The `when:` references a real earlier field (passes the seed
// checkWhenRefs gate) but compares it to a non-ref, non-JSON token, so evaluateWhen
// THROWS (a WhenEvalError) at runtime — exercising the guard-eval non-recoverable path.
const GUARD_FAIL_KIT = `---
schema: "kit/1.0"
slug: "guard-host"
title: "Guard Host"
summary: "a guard-eval error is non-recoverable; retry is skipped"
tags: ["demo"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Guard Host

## Steps

### 1. Produce
out: {"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}

Produce x.

### 2. Guarded
when: steps.1.out.x == broken-expression
onError: retry 5

This step's guard is malformed; evaluation errors.
`;

describe("SS5a catchable recovery", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss5a-"));
    for (const [slug, md] of [
      ["retry-host", RETRY_KIT],
      ["rescue", FALLBACK_WORKER],
      ["fb-host", FALLBACK_KIT],
      ["el-worker", WORKER_KIT],
      ["map-partial", MAP_PARTIAL_KIT],
      ["guard-host", GUARD_FAIL_KIT],
    ] as const) {
      await fs.mkdir(path.join(dir, slug), { recursive: true });
      await fs.writeFile(path.join(dir, slug, "kit.md"), md, "utf-8");
    }
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("retry recovers a transient failure (step fails once, then succeeds)", async () => {
    const store = makeScriptedStore(
      { "r1::0": ["recovered"] },
      new Set(),
      new Set(["r1::0"]), // step 0 fails only on the first attempt
    );
    const res = await runRecipe({
      kitRef: "globalcaos/retry-host",
      sessionKey: "r1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
    });
    expect(res.ok).toBe(true);
    expect(store.getClosed()?.status).toBe("done");
    // step 0 was dispatched at least twice (the failure + the recovering retry).
    const inProg = store.calls.filter(
      (c) => c.stepIndex === 0 && c.session === "r1" && c.status === "in_progress",
    );
    expect(inProg.length).toBeGreaterThanOrEqual(2);
  });

  it("fallback kit succeeds when the host step fails", async () => {
    const store = makeScriptedStore({}, new Set(["fb1::0"])); // host step 0 always fails
    const spawned: string[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/fb-host",
      sessionKey: "fb1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async (_t: string, label: string) => {
        spawned.push(label);
        return { ok: true, runId: "mock" };
      },
    });
    expect(res.ok).toBe(true);
    expect(store.getClosed()?.status).toBe("done");
    // the rescue kit was dispatched in the fallback sub-session.
    expect(spawned.some((l) => l.startsWith("globalcaos/rescue:step-"))).toBe(true);
    expect(Object.keys(store.closedBy).some((k) => k.includes("::fallback::0"))).toBe(true);
  });

  it("map + continue-partial drops a failed element and keeps survivors (no abort)", async () => {
    const store = makeScriptedStore(
      {
        "mp1::0": ['```json\n{"items":["a","b","c"],"worker":"el-worker"}\n```'],
        // each el-worker sub-run (bare "0" fallback) returns a typed value.
        "0": ['```json\n{"v":"ok"}\n```'],
      },
      // the worker for element index 1 (sub-session mp1::map::1::1) fails always.
      new Set(["mp1::map::1::1::0"]),
    );
    const res = await runRecipe({
      kitRef: "globalcaos/map-partial",
      sessionKey: "mp1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
    });
    expect(res.ok).toBe(true);
    expect(store.getClosed()?.status).toBe("done"); // NOT aborted
    // step 2 persisted a partial array (2 survivors of 3) carrying an error envelope.
    const mapOut = store.calls
      .filter((c) => c.stepIndex === 1 && c.session === "mp1" && c.output !== undefined)
      .pop();
    expect(Array.isArray(mapOut?.output)).toBe(true);
    expect((mapOut?.output as unknown[]).length).toBe(2);
    const partialRow = store.calls
      .filter((c) => c.stepIndex === 1 && c.session === "mp1" && c.error !== undefined)
      .pop();
    expect(partialRow?.error).toBeTruthy();
  });

  it("a non-recoverable error (guard-eval) is NOT retried — it aborts", async () => {
    const store = makeScriptedStore({
      "g1::0": ['```json\n{"x":1}\n```'],
    });
    const res = await runRecipe({
      kitRef: "globalcaos/guard-host",
      sessionKey: "g1",
      intent: "t",
      planStore: store as never,
      ownRecipesDir: dir,
      _spawnStep: async () => ({ ok: true, runId: "mock" }),
    });
    expect(res.ok).toBe(false);
    expect(store.getClosed()?.status).toBe("aborted");
    // step 1 (guarded) was dispatched in_progress AT MOST ONCE — no retry on a
    // non-recoverable guard-eval error.
    const guardInProg = store.calls.filter(
      (c) => c.stepIndex === 1 && c.session === "g1" && c.status === "in_progress",
    );
    expect(guardInProg.length).toBeLessThanOrEqual(1);
    // the persisted error is a guard-eval-error (recoverable:false).
    const errRow = store.calls
      .filter((c) => c.stepIndex === 1 && c.session === "g1" && c.status === "error")
      .pop();
    expect((errRow?.error as { kind?: string } | undefined)?.kind).toBe("guard-eval-error");
  });
});
