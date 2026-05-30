/**
 * Tree-of-Thoughts / LATS — bounded best-first thought search.
 *
 * The async driver that walks a {@link ReasoningTree}: from the root, generate
 * up to K candidate next-thoughts, score each, keep the top-M (beam), expand to
 * `maxDepth`, prune below a threshold, backtrack on dead ends, and stop the
 * moment a token / step / latency budget is crossed. Returns the best leaf plus
 * the full serialized trace.
 *
 * Both the generator (`GenerateFn`) and the scorer (`ScoreFn`) are
 * dependency-injected interfaces, so the loop is provider-agnostic and fully
 * unit-testable with deterministic stubs — NO LLM required. See the J3 Fractal
 * Reasoning improvement notes (Upgrade 10).
 *
 * Design note: the spec's reference driver was named `thought-branching-loop.ts`;
 * this file is its boundary-assigned name `thought-search.ts` and implements the
 * same loop (best-first / beam search over the reasoning tree).
 */

import { ReasoningTree, type BranchNode, type SerializedTree } from "./reasoning-tree.js";

/** A single generated candidate thought plus its token cost. */
export interface GeneratedThought {
  text: string;
  /** Tokens consumed producing this candidate (for the token budget). */
  tokens: number;
}

/**
 * Generator: given a parent thought's content and a branching factor `k`,
 * produce up to `k` candidate next-thoughts. May be async (LLM/cc-bridge) or a
 * pure stub in tests. Returning fewer than `k` is allowed (e.g. dead end).
 */
export type GenerateFn = (
  parentContent: string,
  k: number,
  ctx: SearchContext,
) => Promise<GeneratedThought[]>;

/**
 * Scorer: value a thought's content. Higher = better. May be async (LLM judge)
 * or a synchronous heuristic in tests. Determinism here makes the whole search
 * deterministic.
 */
export type ScoreFn = (content: string, ctx: SearchContext) => Promise<number> | number;

/** Per-search context threaded into the injected functions. */
export interface SearchContext {
  /** The original root prompt the search started from. */
  rootPrompt: string;
  depth: number;
  tokensUsed: number;
}

/** Search budgets. All are hard caps; the loop stops at the first one hit. */
export interface SearchBudgets {
  /** Maximum tree depth (number of expansion levels below the root). */
  maxDepth: number;
  /** Branching factor K: max children generated per node per expansion. */
  branchingFactor: number;
  /** Beam width M: max open nodes carried to the next level. */
  beamWidth: number;
  /** Cumulative generation-token cap. Loop stops once crossed. */
  maxTokens: number;
  /** Wall-clock cap in ms. Loop stops once crossed. <= 0 means "single level". */
  maxLatencyMs: number;
  /** Max total expansion steps (node expansions). Optional belt-and-suspenders. */
  maxSteps?: number;
  /**
   * Prune threshold strategy. A function of the current level's scores → a
   * cutoff; nodes scoring strictly below it are pruned. Defaults to "no prune"
   * (returns -Infinity). Provide e.g. mean, or `top-M floor`, to enable pruning.
   */
  pruneThreshold?: (levelScores: number[]) => number;
}

/** Why the search loop stopped. */
export type StopReason =
  | "max-depth"
  | "token-budget"
  | "latency-budget"
  | "step-budget"
  | "exhausted";

/** Result of a thought search. */
export interface SearchResult {
  /** The winning leaf node. */
  best: BranchNode;
  /** Convenience: `best.content`. */
  answer: string;
  /** The full serialized tree (nodes, edges, winning path). */
  trace: SerializedTree;
  tokensUsed: number;
  /** Number of node expansions performed. */
  steps: number;
  depthReached: number;
  stopReason: StopReason;
}

const DEFAULT_PRUNE = () => Number.NEGATIVE_INFINITY;

/**
 * Run a bounded best-first / LATS-style thought search.
 *
 * The loop, per level:
 *  1. Expand each frontier node into <= K children via `generate`.
 *  2. Evaluate each child via `score`.
 *  3. Prune children below the level threshold.
 *  4. Select the top-M open nodes as the next frontier (beam).
 *  5. If the frontier empties (all pruned/dead), backtrack to the best open
 *     node anywhere; if none remain, stop ("exhausted").
 *  6. Stop early on token / latency / step budgets at any point.
 *
 * Always returns a valid {@link SearchResult} (root is the fallback best leaf if
 * nothing was ever expanded).
 */
export async function runThoughtSearch(
  rootPrompt: string,
  generate: GenerateFn,
  score: ScoreFn,
  budgets: SearchBudgets,
  now: () => number = () => Date.now(),
): Promise<SearchResult> {
  const tree = new ReasoningTree(rootPrompt);
  const pruneThreshold = budgets.pruneThreshold ?? DEFAULT_PRUNE;
  const maxSteps = budgets.maxSteps ?? Number.MAX_SAFE_INTEGER;

  let frontier: BranchNode[] = [tree.root];
  let tokensUsed = 0;
  let steps = 0;
  let depthReached = 0;
  const t0 = now();
  let stopReason: StopReason = "max-depth";

  const budgetExhausted = (): StopReason | null => {
    if (tokensUsed > budgets.maxTokens) return "token-budget";
    // Only an explicit positive latency cap interrupts mid-loop. A maxLatencyMs
    // of <= 0 means "do exactly one level then stop", which is handled by the
    // dedicated single-level check at the end of each level (below) — checking
    // it here would race the real clock and abort at depth 0.
    if (budgets.maxLatencyMs > 0 && now() - t0 > budgets.maxLatencyMs) {
      return "latency-budget";
    }
    if (steps >= maxSteps) return "step-budget";
    return null;
  };

  outer: for (let depth = 1; depth <= budgets.maxDepth; depth++) {
    // Latency budget of <= 0 means: do at most one level then stop.
    const nextLevel: BranchNode[] = [];
    const levelScores: number[] = [];

    for (const node of frontier) {
      const hit = budgetExhausted();
      if (hit) {
        stopReason = hit;
        break outer;
      }

      const ctx: SearchContext = { rootPrompt, depth, tokensUsed };
      const gens = await generate(node.content, budgets.branchingFactor, ctx);
      steps++;

      // Honor K even if the generator over-produces.
      const limited = gens.slice(0, budgets.branchingFactor);
      for (const g of limited) {
        tokensUsed += g.tokens;
      }

      const children = tree.expand(
        node,
        limited.map((g) => g.text),
      );
      for (const child of children) {
        const s = await score(child.content, { rootPrompt, depth, tokensUsed });
        tree.evaluate(child, () => s);
        levelScores.push(s);
      }
      nextLevel.push(...children);

      // Stop mid-level the moment a budget is crossed (after this node's work
      // is fully recorded, so the tree stays consistent).
      const hitAfter = budgetExhausted();
      if (hitAfter) {
        stopReason = hitAfter;
        break outer;
      }
    }

    depthReached = depth;

    // Prune this level, then select the beam.
    if (levelScores.length > 0) {
      tree.prune(pruneThreshold(levelScores));
    }
    frontier = tree.selectFrontier(budgets.beamWidth);

    // Dead end → backtrack to best open node anywhere.
    if (frontier.length === 0) {
      const recovered = tree.backtrack();
      if (recovered) {
        frontier = [recovered];
      } else {
        stopReason = "exhausted";
        break outer;
      }
    }

    // Latency <= 0 budget: a single level only.
    if (budgets.maxLatencyMs <= 0) {
      stopReason = "latency-budget";
      break outer;
    }
  }

  // Promote surviving frontier tips to leaves so bestLeaf sees them.
  for (const node of frontier) {
    if (node.status === "open") {
      tree.markLeaf(node);
    }
  }

  const best = tree.bestLeaf();
  return {
    best,
    answer: best.content,
    trace: tree.serialize(),
    tokensUsed,
    steps,
    depthReached,
    stopReason,
  };
}

/**
 * Convenience prune strategy: cut below the mean of the level's scores. Keeps
 * roughly the better half each level.
 */
export function pruneBelowMean(levelScores: number[]): number {
  if (levelScores.length === 0) return Number.NEGATIVE_INFINITY;
  const sum = levelScores.reduce((a, b) => a + b, 0);
  return sum / levelScores.length;
}
