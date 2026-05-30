import fs from "node:fs/promises";
/**
 * FORK 2026-05-30 (Upgrade 5): durable checkpointing tests.
 *
 * Covers the pure helpers (summarizeOutput / collectPriorArtifacts /
 * withPriorArtifacts / isStepDone) and the runKit resume path against a mock
 * PlanStore in live mode (no real subagent spawns — the mock flips the row to
 * `done` the moment it goes in_progress, so waitForStepDone returns immediately).
 */
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import {
  summarizeOutput,
  collectPriorArtifacts,
  withPriorArtifacts,
  isStepDone,
  runKit,
  ARTIFACT_DIGEST_MAX,
  type PriorArtifact,
} from "../kit-runner.js";

// ── A minimal in-memory PlanStore stand-in (matches the methods runKit calls) ──
interface StepCall {
  stepIndex: number;
  status: Plan["steps"][number]["status"];
  note?: string;
  artifact?: string;
}

function makeMockStore(seed?: Plan) {
  let plan: Plan | null = seed ?? null;
  const stepCalls: StepCall[] = [];
  let closed: { status: string } | null = null;
  return {
    calls: stepCalls,
    getClosed: () => closed,
    getPlan: () => plan,
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
        started: "2026-05-30T00:00:00.000Z",
        updated: "2026-05-30T00:00:00.000Z",
        status: "in_progress",
        currentStep: 0,
        steps: params.steps.map((s) => ({ title: s.title, status: "pending" as const })),
      };
      return JSON.parse(JSON.stringify(plan));
    },
    async step(params: StepCall & { sessionKey: string }): Promise<Plan> {
      stepCalls.push({
        stepIndex: params.stepIndex,
        status: params.status,
        note: params.note,
        artifact: params.artifact,
      });
      if (!plan) throw new Error("no plan");
      const st = plan.steps[params.stepIndex];
      if (!st) throw new Error("step out of range");
      // Mock subagent: as soon as a step goes in_progress, it "completes" — the
      // next get() during waitForStepDone sees it done. This stands in for the
      // real subagent writing the done row.
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

describe("summarizeOutput — bounded artifact digest", () => {
  it("returns empty for null/empty", () => {
    expect(summarizeOutput(null)).toBe("");
    expect(summarizeOutput(undefined)).toBe("");
    expect(summarizeOutput("   ")).toBe("");
  });
  it("is idempotent on short input (just collapses whitespace)", () => {
    expect(summarizeOutput("patched filter at line 2046")).toBe("patched filter at line 2046");
    expect(summarizeOutput("a\n  b   c")).toBe("a b c");
  });
  it("truncates >500 chars with an ellipsis, on a word boundary", () => {
    const long = "word ".repeat(200); // 1000 chars
    const out = summarizeOutput(long);
    expect(out.length).toBeLessThanOrEqual(ARTIFACT_DIGEST_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/); // not cut mid-token near the cap
  });
});

describe("collectPriorArtifacts + withPriorArtifacts", () => {
  const plan: Plan = {
    sessionKey: "s",
    runId: "r",
    intent: "i",
    started: "2026-05-30T00:00:00.000Z",
    updated: "2026-05-30T00:00:00.000Z",
    status: "in_progress",
    currentStep: 2,
    steps: [
      { title: "Explore", status: "done", artifact: "found 3 call sites" },
      { title: "Plan", status: "done", note: "no explicit artifact, derive from note" },
      { title: "Implement", status: "in_progress" },
    ],
  };

  it("collects only done steps before the cutoff, deriving from note when no artifact", () => {
    const prior = collectPriorArtifacts(plan, 2);
    expect(prior.map((p) => p.stepIndex)).toEqual([0, 1]);
    expect(prior[0].artifact).toBe("found 3 call sites");
    expect(prior[1].artifact).toBe("no explicit artifact, derive from note");
  });
  it("excludes steps at/after the cutoff", () => {
    expect(collectPriorArtifacts(plan, 1).map((p) => p.stepIndex)).toEqual([0]);
    expect(collectPriorArtifacts(plan, 0)).toEqual([]);
  });
  it("withPriorArtifacts is a no-op when empty, prepends a block otherwise", () => {
    expect(withPriorArtifacts("TASK", [])).toBe("TASK");
    const prior: PriorArtifact[] = [{ stepIndex: 0, title: "Explore", artifact: "found 3" }];
    const out = withPriorArtifacts("TASK", prior);
    expect(out).toContain("## Prior step outputs");
    expect(out).toContain("Step 1 (Explore): found 3");
    expect(out).toContain("TASK");
  });
});

describe("isStepDone", () => {
  const plan = {
    steps: [{ status: "done" }, { status: "in_progress" }, { status: "pending" }],
  } as unknown as Plan;
  it("true only for done rows", () => {
    expect(isStepDone(plan, 0)).toBe(true);
    expect(isStepDone(plan, 1)).toBe(false);
    expect(isStepDone(plan, 2)).toBe(false);
    expect(isStepDone(plan, 9)).toBe(false);
  });
});

// FORK 2026-05-30: no-op spawn injected via runKit's _spawnStep seam so the mock
// planStore drives step completion without a live gateway (the real spawn helper
// shells out to openclaw-spawn-subagent.mjs, which needs a running gateway).
const noopSpawn = async (_task: string, _label: string) => ({
  ok: true as const,
  runId: "mock-run",
});

describe("runKit — durable resume (live mode, mock store)", () => {
  let kitsDir: string;
  beforeAll(async () => {
    kitsDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-resume-"));
    const md = [
      "---",
      'slug: "fourstep"',
      'title: "Four Step"',
      'summary: "s"',
      'tags: ["fourstep"]',
      'kitRef: "globalcaos/fourstep"',
      "parallelism:",
      "  groups:",
      "    - [0]",
      "    - [1]",
      "    - [2]",
      "    - [3]",
      "---",
      "## Steps",
      "### 1. One",
      "do one",
      "### 2. Two",
      "do two",
      "### 3. Three",
      "do three",
      "### 4. Four",
      "do four",
    ].join("\n");
    await fs.mkdir(path.join(kitsDir, "fourstep"), { recursive: true });
    await fs.writeFile(path.join(kitsDir, "fourstep", "kit.md"), md);
  });
  afterAll(async () => {
    await fs.rm(kitsDir, { recursive: true, force: true });
  });

  function seededPlan(): Plan {
    // steps [done, done, in_progress, pending], currentStep 2 — interrupted at 3/4.
    return {
      sessionKey: "agent:main:main",
      runId: "run-resume-1",
      intent: "Four Step",
      kitRef: "globalcaos/fourstep",
      started: "2026-05-30T00:00:00.000Z",
      updated: "2026-05-30T00:00:00.000Z",
      status: "in_progress",
      currentStep: 2,
      steps: [
        { title: "One", status: "done", artifact: "did one" },
        { title: "Two", status: "done", artifact: "did two" },
        { title: "Three", status: "in_progress" },
        { title: "Four", status: "pending" },
      ],
    };
  }

  it("resumes from currentStep: never re-dispatches done steps 0/1", async () => {
    const store = makeMockStore(seededPlan());
    const res = await runKit({
      kitRef: "globalcaos/fourstep",
      sessionKey: "agent:main:main",
      intent: "Four Step",
      planStore: store as never,
      ownKitsDir: kitsDir,
      _spawnStep: noopSpawn,
      resume: true,
    });
    expect(res.ok).toBe(true);
    // No `set` was called → existing plan kept (runId preserved).
    expect(res.planId).toBe("run-resume-1");
    // Steps 0 and 1 must NEVER be touched by a step() call (idempotent skip).
    const touched = new Set(store.calls.map((c) => c.stepIndex));
    expect(touched.has(0)).toBe(false);
    expect(touched.has(1)).toBe(false);
    // Steps 2 and 3 ARE dispatched.
    expect(touched.has(2)).toBe(true);
    expect(touched.has(3)).toBe(true);
    expect(store.getClosed()?.status).toBe("done");
  });

  it("persists a ≤500-char artifact for each resumed step", async () => {
    const store = makeMockStore(seededPlan());
    await runKit({
      kitRef: "globalcaos/fourstep",
      sessionKey: "agent:main:main",
      intent: "Four Step",
      planStore: store as never,
      ownKitsDir: kitsDir,
      _spawnStep: noopSpawn,
      resume: true,
    });
    const artifactWrites = store.calls.filter((c) => c.artifact !== undefined);
    expect(artifactWrites.length).toBeGreaterThan(0);
    for (const w of artifactWrites) {
      expect(w.artifact!.length).toBeLessThanOrEqual(ARTIFACT_DIGEST_MAX);
      expect(w.artifact!.length).toBeGreaterThan(0);
    }
  });

  it("does NOT resume without resume:true (force fresh restart at step 0)", async () => {
    const store = makeMockStore(seededPlan());
    const res = await runKit({
      kitRef: "globalcaos/fourstep",
      sessionKey: "agent:main:main",
      intent: "Four Step",
      planStore: store as never,
      ownKitsDir: kitsDir,
      _spawnStep: noopSpawn,
      // resume omitted → fresh run
    });
    expect(res.ok).toBe(true);
    // A fresh `set` ran → new runId, NOT the seeded one.
    expect(res.planId).not.toBe("run-resume-1");
    // All four steps dispatched from scratch.
    const touched = new Set(store.calls.map((c) => c.stepIndex));
    expect([0, 1, 2, 3].every((i) => touched.has(i))).toBe(true);
  });

  it("does NOT resume when the in_progress plan's kitRef differs (no hijack)", async () => {
    const other = seededPlan();
    other.kitRef = "globalcaos/something-else";
    const store = makeMockStore(other);
    const res = await runKit({
      kitRef: "globalcaos/fourstep",
      sessionKey: "agent:main:main",
      intent: "Four Step",
      planStore: store as never,
      ownKitsDir: kitsDir,
      _spawnStep: noopSpawn,
      resume: true,
    });
    expect(res.ok).toBe(true);
    expect(res.planId).not.toBe("run-resume-1"); // fresh, not the foreign plan
  });

  it("emits checkpoint heartbeats via onCheckpoint sink (wired, opt-in)", async () => {
    // The mock completes steps instantly so no heartbeat fires in practice; we
    // only assert the sink is accepted and the run still succeeds (smoke).
    const store = makeMockStore(seededPlan());
    const beats: number[] = [];
    const res = await runKit({
      kitRef: "globalcaos/fourstep",
      sessionKey: "agent:main:main",
      intent: "Four Step",
      planStore: store as never,
      ownKitsDir: kitsDir,
      _spawnStep: noopSpawn,
      resume: true,
      onCheckpoint: (ev) => beats.push(ev.stepIndex),
    });
    expect(res.ok).toBe(true);
  });
});
