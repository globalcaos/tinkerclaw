/**
 * SS4 (2026-06-06): optimizeRecipe orchestrator — read archives → struggle → propose
 *   → gated apply.
 * Target: recipe-optimize.ts (optimizeRecipe).
 * Bible anchor: subagents-and-recipes.md (SS4 verify: block).
 * Bug-history: AUTO-APPLY must be OFF by default — SS4 PROPOSES unless
 *   RECIPE_AUTOAPPLY_ENABLED. apply must reuse the snapshot-reversible 5-rail path.
 * Catches: applying when the kill-switch is off; not proposing a struggling step;
 *   re-measure delta missing.
 */
import { describe, it, expect, vi } from "vitest";
import type { Plan, PlanStep } from "../../../src/gateway/protocol/schema/prefrontal-plan.js";
import { optimizeRecipe, type OptimizeDeps } from "../recipe-optimize.js";

function plan(
  kitRef: string,
  runId: string,
  steps: Array<Pick<PlanStep, "title" | "status"> & { error?: PlanStep["error"] }>,
): Plan {
  return {
    sessionKey: `s::${runId}`,
    runId,
    intent: "t",
    kitRef,
    started: "2026-06-06T00:00:00.000Z",
    updated: "2026-06-06T00:00:01.000Z",
    status: "done",
    currentStep: 0,
    steps: steps.map((s) => ({
      title: s.title,
      status: s.status,
      ...(s.error ? { error: s.error } : {}),
    })),
  } as Plan;
}

const KIT = "globalcaos/demo";
const ok = (t: string): { title: string; status: PlanStep["status"] } => ({
  title: t,
  status: "done",
});
const err = (
  t: string,
  kind: string,
): { title: string; status: PlanStep["status"]; error: PlanStep["error"] } => ({
  title: t,
  status: "error",
  error: { kind, message: `${kind}`, recoverable: kind === "timeout" },
});

// A recipe whose step 1 fails 8/10 (timeout), step 0 always ok.
function strugglingArchives(): Plan[] {
  return Array.from({ length: 10 }, (_, i) =>
    plan(KIT, `r${i}`, [ok("Setup"), i < 8 ? err("Act", "timeout") : ok("Act")]),
  );
}

function makeDeps(over: Partial<OptimizeDeps> = {}): OptimizeDeps {
  return {
    readArchivedPlans: over.readArchivedPlans ?? (async () => strugglingArchives()),
    baseVersion: over.baseVersion ?? 4,
    applyProposal:
      over.applyProposal ??
      (async () => ({ recipeId: KIT, applied: true, reason: "applied", archivePath: "/a/x.md" })),
    env: over.env ?? ({} as NodeJS.ProcessEnv),
  };
}

describe("optimizeRecipe", () => {
  it("PROPOSES the struggling step but does NOT apply when RECIPE_AUTOAPPLY_ENABLED is off", async () => {
    const apply = vi.fn(async () => ({ recipeId: KIT, applied: true, reason: "applied" as const }));
    const res = await optimizeRecipe(
      KIT,
      makeDeps({ applyProposal: apply, env: {} as NodeJS.ProcessEnv }),
    );
    expect(res.proposed.length).toBe(1);
    expect(res.proposed[0].op).toBe("rewrite_step_text");
    expect(res.proposed[0].payload).toMatchObject({ stepIndex: 1 });
    expect(apply).not.toHaveBeenCalled(); // proposes-only by default
    expect(res.applied).toEqual([]);
    // re-measure baseline captured.
    expect(res.struggleBefore.strugglingStepIndexes).toContain(1);
  });

  it("APPLIES the gated proposal when RECIPE_AUTOAPPLY_ENABLED=true (snapshot-reversible path)", async () => {
    const apply = vi.fn(async () => ({
      recipeId: KIT,
      applied: true,
      reason: "applied" as const,
      archivePath: "/a/x.md",
    }));
    const res = await optimizeRecipe(
      KIT,
      makeDeps({
        applyProposal: apply,
        env: { RECIPE_AUTOAPPLY_ENABLED: "true" } as NodeJS.ProcessEnv,
      }),
    );
    expect(apply).toHaveBeenCalledTimes(1);
    // it forwards a rewrite_step_text ApplyProposalInput carrying the stepIndex.
    const arg = apply.mock.calls[0][0] as { op: string; payload?: { stepIndex?: number } };
    expect(arg.op).toBe("rewrite_step_text");
    expect(arg.payload?.stepIndex).toBe(1);
    expect(res.applied.length).toBe(1);
    expect(res.snapshots).toContain("/a/x.md");
  });

  it("no struggling step → no proposals, no apply (idempotent on a healthy recipe)", async () => {
    const healthy = Array.from({ length: 6 }, (_, i) =>
      plan(KIT, `h${i}`, [ok("Setup"), ok("Act")]),
    );
    const apply = vi.fn(async () => ({ recipeId: KIT, applied: true, reason: "applied" as const }));
    const res = await optimizeRecipe(
      KIT,
      makeDeps({
        readArchivedPlans: async () => healthy,
        applyProposal: apply,
        env: { RECIPE_AUTOAPPLY_ENABLED: "true" } as NodeJS.ProcessEnv,
      }),
    );
    expect(res.proposed).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("no archives → empty report, never throws", async () => {
    const res = await optimizeRecipe(KIT, makeDeps({ readArchivedPlans: async () => [] }));
    expect(res.struggleBefore.steps).toEqual([]);
    expect(res.proposed).toEqual([]);
  });
});
