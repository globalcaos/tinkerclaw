import fs from "node:fs/promises";
/**
 * SS5b (2026-06-06): OVERSEER supervision-loop behavior in runRecipe.
 *
 * The overseer loop (`loop: until OVERSEER_DONE`) does NOT run a frozen loop.max —
 * its per-iteration ceiling is DERIVED via deriveOverseerLoopBudget (J16, never a
 * frozen MAX). On a non-done verdict (a NUDGE) the runner forwards the nudge text
 * through the best-effort onKeepGoing sink; on the OVERSEER_DONE marker it breaks.
 * On exhaustion it falls through to a GRACEFUL partial settlement (design-principle
 * #19 graceful-degrade — never a hard abort).
 *
 * Modeled on recipe-runner-resume.test.ts: a mock PlanStore + an injected
 * _spawnStep drive step completion with no live gateway. The mock scripts the
 * per-iteration done-note so the loop's marker/nudge logic is exercised directly.
 */
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { runRecipe, type TrailEvent } from "../recipe-runner.js";

// HARD_LOOP_MAX is a module-internal const in recipe-runner.ts (the structural
// ceiling, never exported). Mirror its value here for the bound assertions.
const HARD_LOOP_MAX = 25;

// no-op spawn injected via runRecipe's _spawnStep seam (same pattern as the resume
// test): the mock planStore drives completion, so no real subagent is needed.
const noopSpawn = async (_task: string, _label: string) => ({
  ok: true as const,
  runId: "mock-run",
});

// A mock PlanStore that SCRIPTS the per-iteration done-note. The runner marks a
// step `in_progress` both at the group pre-mark (no progressNote) AND once per loop
// dispatch (with a progressNote). To align the script with what the LOOP actually
// reads back via readNote(), the cursor only advances on a loop dispatch — i.e. an
// `in_progress` call that carries a `note` (the loop's "loop N/M · ..." progress
// label). The note-less group pre-mark seeds the first scripted verdict without
// consuming it, so script[0] is the verdict the loop's first pass reads.
function makeScriptedStore(
  scripts: Record<number, string[]>,
  fallback = "still working; gaps remain",
) {
  let plan: Plan | null = null;
  const stepCalls: Array<{ stepIndex: number; status: string; note?: string }> = [];
  let closed: { status: string } | null = null;
  const cursor: Record<number, number> = {};
  // Verdict CURRENTLY visible on a step (what readNote() returns). Set when a step
  // is (re)dispatched; the loop reads it on the next readNote().
  const visibleNote: Record<number, string> = {};
  const peekNote = (stepIndex: number): string => {
    const seq = scripts[stepIndex] ?? [];
    const i = cursor[stepIndex] ?? 0;
    return i < seq.length ? seq[i] : fallback;
  };
  const advance = (stepIndex: number): void => {
    cursor[stepIndex] = (cursor[stepIndex] ?? 0) + 1;
  };
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
        started: "2026-06-06T00:00:00.000Z",
        updated: "2026-06-06T00:00:00.000Z",
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
      stepCalls.push({ stepIndex: params.stepIndex, status: params.status, note: params.note });
      if (!plan) throw new Error("no plan");
      const st = plan.steps[params.stepIndex];
      if (!st) throw new Error("step out of range");
      if (params.status === "in_progress") {
        // Mock supervisor: a freshly dispatched pass "completes" with the current
        // scripted verdict, which the loop wrapper then reads via readNote().
        st.status = "done";
        // A note-bearing in_progress is a LOOP dispatch → consume the verdict the
        // loop is about to read, then advance for the next pass. The note-less
        // group pre-mark only surfaces the current verdict (does not advance).
        const isLoopDispatch = params.note !== undefined;
        const verdict = peekNote(params.stepIndex);
        visibleNote[params.stepIndex] = verdict;
        st.note = verdict;
        if (isLoopDispatch) advance(params.stepIndex);
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

async function writeOverseerKit(kitsDir: string): Promise<void> {
  const md = [
    "---",
    'slug: "overseer"',
    'title: "Overseer"',
    'summary: "s"',
    'tags: ["overseer"]',
    'kitRef: "globalcaos/overseer"',
    "parallelism:",
    "  groups:",
    "    - [0]",
    "---",
    "## Steps",
    "### 1. Supervise",
    "loop: until OVERSEER_DONE max 20",
    "",
    "supervise the task until it is done",
  ].join("\n");
  await fs.mkdir(path.join(kitsDir, "overseer"), { recursive: true });
  await fs.writeFile(path.join(kitsDir, "overseer", "kit.md"), md);
}

describe("runRecipe — OVERSEER supervision loop (SS5b)", () => {
  let kitsDir: string;
  beforeAll(async () => {
    kitsDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-overseer-"));
    await writeOverseerKit(kitsDir);
  });
  afterAll(async () => {
    await fs.rm(kitsDir, { recursive: true, force: true });
  });

  it("breaks on OVERSEER_DONE; calls onKeepGoing only for the non-done verdicts", async () => {
    // Scripted verdicts: a nudge then the done marker. fitnessSuccessRate:0 (a fully
    // unreliable recipe) earns the loop enough DERIVED passes to reach the marker on
    // the 2nd verdict — the per-iteration ceiling is derived, never the author's
    // loop.max (J16 design-principle #19), so the marker must land within the bound.
    const store = makeScriptedStore({ 0: ["gap A", "OVERSEER_DONE"] });
    const keepGoing: Array<{ sessionKey: string; message: string }> = [];
    const trail: TrailEvent[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/overseer",
      sessionKey: "agent:main:main",
      intent: "Overseer",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: noopSpawn,
      fitnessSuccessRate: 0,
      onKeepGoing: (sessionKey, message) => keepGoing.push({ sessionKey, message }),
      onTrail: (ev) => trail.push(ev),
    });
    expect(res.ok).toBe(true);
    // (a) onKeepGoing fired for the non-done verdict only, NOT the done one.
    expect(keepGoing.map((k) => k.message)).toEqual(["gap A"]);
    for (const k of keepGoing) expect(k.sessionKey).toBe("agent:main:main");
    // (b) the loop broke on the marker after exactly 2 LOOP dispatches
    //     (1 nudge + the done verdict). Loop dispatches carry a progress note.
    const loopDispatches = store.calls.filter(
      (c) => c.status === "in_progress" && c.note !== undefined,
    );
    expect(loopDispatches.length).toBe(2);
    // (c) every observed working bound is >=1 and <= HARD_LOOP_MAX (and <= loop.max).
    const pressures = trail.filter((t) => t.kind === "overseer-pressure");
    expect(pressures.length).toBeGreaterThan(0);
    for (const p of pressures) {
      const wb = (p.payload as { workingBound?: number }).workingBound;
      expect(typeof wb).toBe("number");
      expect(wb!).toBeGreaterThanOrEqual(1);
      expect(wb!).toBeLessThanOrEqual(HARD_LOOP_MAX);
      expect(wb!).toBeLessThanOrEqual((p.payload as { loopMax?: number }).loopMax ?? HARD_LOOP_MAX);
    }
    expect(store.getClosed()?.status).toBe("done");
  });

  it("a never-done sequence stops at the derived bound and settles a partial without throwing", async () => {
    // No marker ever emitted → the loop must stop at the DERIVED ceiling, NOT spin
    // to loop.max (20). With fitnessSuccessRate:1 (uncertainty 0) and no shrinking
    // gap, the derived bound collapses fast — proving the derived value (not the
    // author's loop.max) governs the overseer loop.
    const store = makeScriptedStore({ 0: [] }, "still working; the same gap remains");
    const keepGoing: string[] = [];
    const trail: TrailEvent[] = [];
    const res = await runRecipe({
      kitRef: "globalcaos/overseer",
      sessionKey: "agent:main:main",
      intent: "Overseer",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: noopSpawn,
      fitnessSuccessRate: 1,
      onKeepGoing: (_sessionKey, message) => keepGoing.push(message),
      onTrail: (ev) => trail.push(ev),
    });
    // (d) never hard-aborts: the run succeeds and a partial loop note is settled.
    expect(res.ok).toBe(true);
    const loopDispatches = store.calls.filter(
      (c) => c.status === "in_progress" && c.note !== undefined,
    ).length;
    // stopped at the derived ceiling, far below loop.max (20) and HARD_LOOP_MAX (25).
    expect(loopDispatches).toBeGreaterThanOrEqual(1);
    expect(loopDispatches).toBeLessThan(20);
    expect(loopDispatches).toBeLessThanOrEqual(HARD_LOOP_MAX);
    // every non-done pass nudged.
    expect(keepGoing.length).toBe(loopDispatches);
    // working bound stayed in [1, HARD_LOOP_MAX] throughout.
    for (const p of trail.filter((t) => t.kind === "overseer-pressure")) {
      const wb = (p.payload as { workingBound?: number }).workingBound!;
      expect(wb).toBeGreaterThanOrEqual(1);
      expect(wb).toBeLessThanOrEqual(HARD_LOOP_MAX);
    }
    expect(store.getClosed()?.status).toBe("done");
  });

  it("never throws into the run when the onKeepGoing sink throws (best-effort)", async () => {
    const store = makeScriptedStore({ 0: ["gap A", "OVERSEER_DONE"] });
    const res = await runRecipe({
      kitRef: "globalcaos/overseer",
      sessionKey: "agent:main:main",
      intent: "Overseer",
      planStore: store as never,
      ownRecipesDir: kitsDir,
      _spawnStep: noopSpawn,
      onKeepGoing: () => {
        throw new Error("sink boom");
      },
    });
    expect(res.ok).toBe(true);
  });
});
