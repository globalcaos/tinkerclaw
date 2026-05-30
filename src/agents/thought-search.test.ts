import { describe, expect, it } from "vitest";
import {
  runThoughtSearch,
  pruneBelowMean,
  type GenerateFn,
  type ScoreFn,
  type SearchBudgets,
} from "./thought-search.js";

/**
 * Deterministic generator: each call appends a letter index to the parent
 * content so paths are uniquely identifiable, e.g. "root" → "root.0", "root.1".
 * Each thought costs `tokensPer` tokens.
 */
const makeGenerator = (tokensPer = 1): GenerateFn => {
  return async (parentContent: string, k: number) => {
    const out = [];
    for (let i = 0; i < k; i++) {
      out.push({ text: `${parentContent}.${i}`, tokens: tokensPer });
    }
    return out;
  };
};

/** Deterministic scorer: score = length of content (longer path = deeper = higher). */
const lengthScorer: ScoreFn = (content: string) => content.length;

const baseBudgets = (over: Partial<SearchBudgets> = {}): SearchBudgets => ({
  maxDepth: 3,
  branchingFactor: 2,
  beamWidth: 2,
  maxTokens: 1_000_000,
  maxLatencyMs: 1_000_000,
  ...over,
});

describe("runThoughtSearch", () => {
  it("returns a valid result even when nothing useful is generated", async () => {
    const emptyGen: GenerateFn = async () => [];
    const res = await runThoughtSearch("root", emptyGen, lengthScorer, baseBudgets());
    // Root is the fallback best leaf.
    expect(res.best.content).toBe("root");
    expect(res.answer).toBe("root");
    expect(res.trace.rootId).toBe(res.best.id);
  });

  it("respects maxDepth: the tree never goes deeper than D", async () => {
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      lengthScorer,
      baseBudgets({ maxDepth: 2, branchingFactor: 2, beamWidth: 2 }),
    );
    const maxDepth = Math.max(...res.trace.nodes.map((n) => n.depth));
    expect(maxDepth).toBeLessThanOrEqual(2);
    expect(res.depthReached).toBeLessThanOrEqual(2);
  });

  it("respects branchingFactor: each expansion produces at most K children", async () => {
    // Generator over-produces; loop must clamp to K.
    const overProducer: GenerateFn = async (parent, _k) => {
      return [0, 1, 2, 3, 4].map((i) => ({ text: `${parent}.${i}`, tokens: 1 }));
    };
    const res = await runThoughtSearch(
      "r",
      overProducer,
      lengthScorer,
      baseBudgets({ maxDepth: 1, branchingFactor: 3, beamWidth: 5 }),
    );
    // root + at most 3 children
    const children = res.trace.nodes.filter((n) => n.parentId === res.trace.rootId);
    expect(children.length).toBeLessThanOrEqual(3);
    expect(children.length).toBe(3);
  });

  it("respects beamWidth: each level carries at most M open nodes forward", async () => {
    // With beamWidth 1, after each level only one node is expanded → tree is a
    // chain plus the unexpanded siblings of each level.
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      lengthScorer,
      baseBudgets({ maxDepth: 3, branchingFactor: 2, beamWidth: 1 }),
    );
    // expanded nodes (those with children) per level beyond root should be 1.
    const expandedAtDepth: Record<number, number> = {};
    for (const n of res.trace.nodes) {
      if (n.childIds.length > 0) {
        expandedAtDepth[n.depth] = (expandedAtDepth[n.depth] ?? 0) + 1;
      }
    }
    // depth 0 (root) expanded once; depth 1 expanded at most 1 (beam=1); etc.
    for (const [depth, count] of Object.entries(expandedAtDepth)) {
      if (Number(depth) >= 1) expect(count).toBeLessThanOrEqual(1);
    }
  });

  it("enforces the token budget: halts early but still returns a valid best leaf", async () => {
    // Each thought costs 10 tokens; cap at 15 → only the first expansion (2
    // children = 20 tokens) runs, then the loop must stop.
    const res = await runThoughtSearch(
      "r",
      makeGenerator(10),
      lengthScorer,
      baseBudgets({ maxDepth: 5, branchingFactor: 2, beamWidth: 2, maxTokens: 15 }),
    );
    expect(res.stopReason).toBe("token-budget");
    expect(res.tokensUsed).toBeGreaterThan(15);
    // The shallow tree still yields a leaf deeper than / equal to root.
    expect(res.best.content.length).toBeGreaterThanOrEqual("r".length);
    expect(res.trace.nodes.length).toBeGreaterThan(1);
  });

  it("enforces the latency budget: maxLatencyMs <= 0 returns after one level", async () => {
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      lengthScorer,
      baseBudgets({ maxDepth: 5, maxLatencyMs: 0 }),
    );
    expect(res.stopReason).toBe("latency-budget");
    expect(res.depthReached).toBe(1);
    const maxDepth = Math.max(...res.trace.nodes.map((n) => n.depth));
    expect(maxDepth).toBe(1);
  });

  it("enforces the latency budget mid-run using an injected clock", async () => {
    // Fake clock jumps past the budget on the 2nd reading.
    let ticks = 0;
    const fakeNow = () => {
      ticks++;
      return ticks <= 1 ? 0 : 10_000;
    };
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      lengthScorer,
      baseBudgets({ maxDepth: 5, maxLatencyMs: 100 }),
      fakeNow,
    );
    expect(res.stopReason).toBe("latency-budget");
  });

  it("enforces the step budget", async () => {
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      lengthScorer,
      baseBudgets({ maxDepth: 5, beamWidth: 3, branchingFactor: 3, maxSteps: 2 }),
    );
    expect(res.stopReason).toBe("step-budget");
    expect(res.steps).toBeLessThanOrEqual(2);
  });

  it("selects the deterministic best leaf given fixed scores", async () => {
    // lengthScorer makes deeper = better, so the best leaf is on the deepest
    // fully-explored path. With branching ".0/.1" the greedy beam keeps deepest.
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      lengthScorer,
      baseBudgets({ maxDepth: 3, branchingFactor: 2, beamWidth: 2 }),
    );
    // Deepest leaf content should be at depth 3: "r.x.y.z" form.
    expect(res.best.depth).toBe(3);
    expect(res.best.content.split(".")).toHaveLength(4); // r + 3 segments
    // Winning path runs root → ... → best.
    expect(res.trace.winningPath[0]).toBe(res.trace.rootId);
    expect(res.trace.winningPath[res.trace.winningPath.length - 1]).toBe(res.best.id);
  });

  it("recovers via backtrack when the greedy frontier dead-ends through pruning", async () => {
    // beamWidth=1 means only the single best depth-1 node (r.0, score 100)
    // advances; its sibling r.1 (score 50) stays *open* but unexpanded. At
    // depth 2 the greedy r.0's children all score below the (positive) prune
    // threshold and get pruned, emptying the frontier. backtrack() must then
    // recover the still-open r.1 sibling rather than terminating empty-handed.
    const gen = makeGenerator();
    const scorer: ScoreFn = (content: string) => {
      if (content === "r.0") return 100; // greedy winner at depth 1
      if (content === "r.1") return 50; // lower, parked open by beam=1
      if (content.startsWith("r.0.")) return 1; // dead end — pruned at depth 2
      if (content.startsWith("r.1.")) return 200; // hidden gold below the sibling
      return content.length;
    };
    const res = await runThoughtSearch("r", gen, scorer, {
      maxDepth: 3,
      branchingFactor: 2,
      beamWidth: 1,
      maxTokens: 1_000_000,
      maxLatencyMs: 1_000_000,
      // Constant cutoff of 10: prunes the depth-2 dead-end children (score 1)
      // off the greedy r.0 path, so the next frontier is the still-open r.1
      // sibling — whose own children (score 200) survive and win.
      pruneThreshold: () => 10,
    });
    // The winning leaf must come from the r.1 lineage (the hidden gold),
    // proving the search recovered the sibling instead of dying on r.0.
    expect(res.best.content.startsWith("r.1.")).toBe(true);
    expect(res.best.score).toBe(200);
    expect(res.best.id).not.toBe(res.trace.rootId);
  });

  it("backtrack engages when a whole level is pruned out", async () => {
    // Force every depth-1 child to be pruned by a brutal threshold, leaving the
    // frontier empty → backtrack must find SOME open node or exhaust.
    const gen = makeGenerator();
    const res = await runThoughtSearch("r", gen, () => -100, {
      maxDepth: 2,
      branchingFactor: 2,
      beamWidth: 2,
      maxTokens: 1_000_000,
      maxLatencyMs: 1_000_000,
      pruneThreshold: () => 0, // everything (-100) prunes
    });
    // All children pruned, nothing open → search exhausts but still returns root.
    expect(res.stopReason).toBe("exhausted");
    expect(res.best.id).toBe(res.trace.rootId);
  });

  it("is fully deterministic: identical inputs yield identical winning paths", async () => {
    const run = () =>
      runThoughtSearch(
        "r",
        makeGenerator(),
        lengthScorer,
        baseBudgets({ maxDepth: 2, branchingFactor: 2, beamWidth: 2 }),
      );
    const a = await run();
    const b = await run();
    expect(a.best.content).toBe(b.best.content);
    expect(a.best.depth).toBe(b.best.depth);
    expect(a.tokensUsed).toBe(b.tokensUsed);
    expect(a.steps).toBe(b.steps);
  });

  it("supports an async (Promise-returning) scorer", async () => {
    const asyncScorer: ScoreFn = async (content: string) => content.length;
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      asyncScorer,
      baseBudgets({ maxDepth: 2 }),
    );
    expect(res.best.depth).toBe(2);
  });

  it("reports stopReason max-depth when budgets are generous", async () => {
    const res = await runThoughtSearch(
      "r",
      makeGenerator(),
      lengthScorer,
      baseBudgets({ maxDepth: 2 }),
    );
    expect(res.stopReason).toBe("max-depth");
  });
});

describe("pruneBelowMean", () => {
  it("returns the mean of the scores", () => {
    expect(pruneBelowMean([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns -Infinity for an empty level", () => {
    expect(pruneBelowMean([])).toBe(Number.NEGATIVE_INFINITY);
  });
});
