/**
 * Tests — Upgrade 1: recipe-evolution proposal operator.
 *
 * Focus: the AUTONOMY-FIRST conditional gate (2026-05-31). Every MutationProposal
 * used to be hardcoded needsHumanReview:true; it is now CONDITIONAL — a
 * high-confidence (successRate FAR below the floor) + well-evidenced
 * (runs >= autoMinRuns) + reversible (always — never-delete archive) corrective
 * proposal is flagged autoPromotable:true with needsHumanReview:false.
 *
 * Also covers proposeMutations triggers + the runSleepConsolidation count
 * (recipeMutationsAutoPromotable) + the absent-dep regression guard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { createInitialConsolidationState, type Episode } from "./episode-detection.js";
import { createEventStore, type EventStore } from "./event-store.js";
import { createRecipeArchive, type RecipeArchive } from "./recipe-archive.js";
import {
  AUTO_MIN_RUNS,
  DEFAULT_RECIPE_EVOLUTION_CONFIG,
  isAutoPromotable,
  proposeMutations,
} from "./recipe-evolution.js";
import { type RecipeFitness } from "./recipe-fitness.js";
import { runSleepConsolidation } from "./sleep-consolidation.js";

let tmpDir: string;
let store: EventStore;
let artifactStore: ArtifactStore;
let archive: RecipeArchive;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-recipe-evo-"));
  store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });
  artifactStore = createArtifactStore({ baseDir: tmpDir });
  archive = createRecipeArchive({ baseDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-05-31T10:00:00Z";

/** Build a RecipeFitness with explicit runs/successes; successRate set directly. */
function fitness(overrides: Partial<RecipeFitness> = {}): RecipeFitness {
  return {
    recipeId: "owner/slug",
    version: 1,
    runs: 10,
    successes: 0,
    successRate: 0.1,
    avgLatencyMs: 0,
    avgTokenCost: 0,
    difficulty: 1,
    lastUpdated: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isAutoPromotable — the bounded-autonomy gate in isolation
// ---------------------------------------------------------------------------
describe("isAutoPromotable", () => {
  const cfg = DEFAULT_RECIPE_EVOLUTION_CONFIG;

  it("default thresholds are coherent: autoMinRuns > minRuns and matches AUTO_MIN_RUNS", () => {
    expect(cfg.autoMinRuns).toBe(AUTO_MIN_RUNS);
    expect(AUTO_MIN_RUNS).toBe(8);
    expect(cfg.autoMinRuns).toBeGreaterThan(cfg.minRuns);
  });

  it("high-confidence (rate far below floor) + high runs → true", () => {
    // floor 0.5 * autoFloorRatio 0.5 = 0.25 threshold; 0.1 is far below.
    expect(isAutoPromotable(fitness({ successRate: 0.1, runs: cfg.autoMinRuns }), cfg)).toBe(true);
  });

  it("rate below floor but NOT far below (between floor*ratio and floor) → false", () => {
    // 0.4 < floor 0.5 (so a proposal IS made) but > 0.25 → not auto-promotable.
    expect(isAutoPromotable(fitness({ successRate: 0.4, runs: 20 }), cfg)).toBe(false);
  });

  it("rate exactly at the far-below threshold (floor*ratio) → true (inclusive)", () => {
    expect(isAutoPromotable(fitness({ successRate: 0.25, runs: 10 }), cfg)).toBe(true);
  });

  it("far below floor but too few runs (< autoMinRuns) → false", () => {
    expect(isAutoPromotable(fitness({ successRate: 0.1, runs: cfg.autoMinRuns - 1 }), cfg)).toBe(
      false,
    );
  });

  it("runs exactly at autoMinRuns → true (inclusive boundary)", () => {
    expect(isAutoPromotable(fitness({ successRate: 0.1, runs: cfg.autoMinRuns }), cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// proposeMutations — wiring the gate into actual proposals
// ---------------------------------------------------------------------------
describe("proposeMutations", () => {
  it("runs < minRuns → no proposals at all", () => {
    expect(proposeMutations(fitness({ runs: 2, successRate: 0.05 }))).toHaveLength(0);
  });

  it("high success rate → no proposals", () => {
    expect(proposeMutations(fitness({ successRate: 0.9, runs: 20, successes: 18 }))).toHaveLength(
      0,
    );
  });

  it("low (but not far-below) success rate + low runs → corrective proposals, all human-gated", () => {
    // 0.4 < floor 0.5 (proposals made) but > 0.25, and only 4 runs (< autoMinRuns 8).
    const proposals = proposeMutations(fitness({ successRate: 0.4, runs: 4 }));
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    for (const p of proposals) {
      expect(p.autoPromotable).toBe(false);
      expect(p.needsHumanReview).toBe(true);
    }
  });

  it("HIGH-confidence + HIGH-runs → corrective proposals are autoPromotable, needsHumanReview false", () => {
    const proposals = proposeMutations(fitness({ successRate: 0.1, runs: 12 }));
    const corrective = proposals.filter((p) => p.op === "tighten_criteria" || p.op === "add_step");
    expect(corrective.length).toBe(2);
    for (const p of corrective) {
      expect(p.autoPromotable).toBe(true);
      expect(p.needsHumanReview).toBe(false);
      expect(p.rationale).toMatch(/auto-promotable/);
    }
  });

  it("borderline: enough runs but rate only just-under floor → NOT autoPromotable", () => {
    const proposals = proposeMutations(fitness({ successRate: 0.45, runs: 20 }));
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    for (const p of proposals) {
      expect(p.autoPromotable).toBe(false);
      expect(p.needsHumanReview).toBe(true);
    }
  });

  it("latency-regression proposal is NEVER autoPromotable (efficiency stays human-gated)", () => {
    // High success rate so no corrective proposals; force a latency regression via history.
    const history: RecipeFitness[] = [
      fitness({ successRate: 0.9, runs: 5, avgLatencyMs: 100 }),
      fitness({ successRate: 0.9, runs: 6, avgLatencyMs: 100 }),
    ];
    const current = fitness({ successRate: 0.9, runs: 7, successes: 6, avgLatencyMs: 1000 });
    const proposals = proposeMutations(current, [...history, current]);
    const latency = proposals.find((p) => p.op === "remove_step" || p.op === "reorder");
    expect(latency).toBeDefined();
    expect(latency?.autoPromotable).toBe(false);
    expect(latency?.needsHumanReview).toBe(true);
  });

  it("respects a custom config (lower autoMinRuns / floor ratio)", () => {
    // With autoMinRuns 2 and autoFloorRatio 1 (so threshold == floor), a rate of
    // 0.4 over 3 runs becomes auto-promotable.
    const proposals = proposeMutations(fitness({ successRate: 0.4, runs: 3 }), [], {
      autoMinRuns: 2,
      autoFloorRatio: 1,
    });
    const corrective = proposals.filter((p) => p.op === "tighten_criteria" || p.op === "add_step");
    expect(corrective.length).toBe(2);
    for (const p of corrective) {
      expect(p.autoPromotable).toBe(true);
      expect(p.needsHumanReview).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// runSleepConsolidation integration — recipeMutationsAutoPromotable count
// ---------------------------------------------------------------------------
function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "ep",
    startEventId: "s",
    endEventId: "e",
    startTime: NOW,
    endTime: NOW,
    turnCount: 1,
    topic: "recipe run",
    participants: ["agent"],
    outcome: "abandoned",
    keyDecisions: [],
    sourceEventIds: [],
    ...overrides,
  };
}

describe("runSleepConsolidation recipe-evolution autoPromotable count", () => {
  it("absent dep → no recipeMutations* fields (regression guard, byte-identical)", async () => {
    store.append({
      kind: "user_message",
      content: "hi",
      tokens: 1,
      turnId: 0,
      sessionKey: "test",
      metadata: {},
    });
    const state = createInitialConsolidationState();
    const result = await runSleepConsolidation(store, artifactStore, state);
    expect(result.recipeMutationsProposed).toBeUndefined();
    expect(result.recipeMutationsAutoPromotable).toBeUndefined();
    expect(result.summariesGenerated).toBeGreaterThan(0);
  });

  it("high-confidence recipe (pre-seeded archive, then a failing episode) → autoPromotable counted", async () => {
    const rid = "owner/flaky-recipe";
    // Pre-seed the archive so the recipe already has many failing runs; the
    // consolidation pass folds in one more, keeping the rate far below floor.
    archive.putVariant(
      rid,
      1,
      "body",
      fitness({ recipeId: rid, runs: AUTO_MIN_RUNS + 2, successes: 0, successRate: 0.08 }),
    );

    // One failing episode tagged recipe:<rid>.
    const e = store.append({
      kind: "user_message",
      content: "ran the flaky recipe",
      tokens: 10,
      turnId: 0,
      sessionKey: "test",
      metadata: { tags: [`recipe:${rid}`], taskId: "t1" },
    });

    const state = createInitialConsolidationState();
    // detectEpisodes runs over the appended event; the episode inherits the tag.
    const result = await runSleepConsolidation(store, artifactStore, state, {
      manifestBaseDir: tmpDir,
      recipeEvolution: { archive },
    });

    expect(result.recipeMutationsProposed).toBeGreaterThanOrEqual(2);
    // Both corrective proposals are autoPromotable for this far-below-floor recipe.
    expect(result.recipeMutationsAutoPromotable).toBe(result.recipeMutationsProposed);
    // Touch the appended event id so lint doesn't flag it unused.
    expect(e.id).toBeTruthy();
  });

  it("low-evidence recipe (fresh, few runs) → proposals not autoPromotable", async () => {
    const rid = "owner/new-recipe";
    // No pre-seed: the single failing episode yields runs=1 (< autoMinRuns), and
    // Laplace makes 0/1 → successRate (0+1)/(1+2)=0.33, which is < floor 0.5 so a
    // proposal IS made, but 0.33 > 0.25 threshold AND runs 1 < 8 → not auto.
    store.append({
      kind: "user_message",
      content: "ran the new recipe",
      tokens: 10,
      turnId: 0,
      sessionKey: "test",
      metadata: { tags: [`recipe:${rid}`], taskId: "t1" },
    });

    const state = createInitialConsolidationState();
    const result = await runSleepConsolidation(store, artifactStore, state, {
      manifestBaseDir: tmpDir,
      recipeEvolution: { archive },
    });

    // runs=1 < minRuns(3) → proposeMutations returns nothing → 0 proposals, 0 auto.
    expect(result.recipeMutationsProposed).toBe(0);
    expect(result.recipeMutationsAutoPromotable).toBe(0);
  });
});
