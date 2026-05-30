/**
 * Tree-of-Thoughts / LATS — reasoning tree data structure + algebra.
 *
 * Pure, deterministic, NO I/O and NO LLM. This is the in-memory branch store
 * the thought-search driver (`thought-search.ts`) walks. Every method is
 * synchronous and side-effect-free beyond mutating the tree's own node map, so
 * the whole structure is unit-testable with an injected (mock) scorer.
 *
 * This operationalizes the fractal prompt's "Fractal Branching — each branch
 * must be thought through to its end" doctrine as an executable
 * expand → evaluate → prune → backtrack search, rather than a post-hoc
 * reflection instruction. See the J3 Fractal Reasoning improvement notes
 * (Upgrade 10) for the design rationale.
 */

import { generateULID } from "../memory/engram/event-store.js";

/** Lifecycle of a branch node within the search. */
export type BranchStatus = "open" | "expanded" | "pruned" | "leaf";

/**
 * A single node (thought) in the reasoning tree.
 *
 * `score` is `null` until {@link ReasoningTree.evaluate} runs against it. The
 * root node is created with `score === null` and `depth === 0`.
 */
export interface BranchNode {
  id: string;
  content: string;
  /** Heuristic / model value of this thought; null = not yet evaluated. */
  score: number | null;
  depth: number;
  /** null only for the root. */
  parentId: string | null;
  childIds: string[];
  status: BranchStatus;
}

/** Serialized form suitable for persistence as a MemoryEvent payload. */
export interface SerializedTree {
  rootId: string;
  nodes: BranchNode[];
  edges: Array<{ from: string; to: string }>;
  /** Root → best leaf path (ids), highest scoring leaf last. */
  winningPath: string[];
}

/**
 * In-memory tree of {@link BranchNode}s with the search algebra used by LATS /
 * Tree-of-Thoughts: expand, evaluate, select a beam frontier, prune, backtrack,
 * and pick the best leaf.
 */
export class ReasoningTree {
  readonly root: BranchNode;
  private readonly nodes: Map<string, BranchNode> = new Map();

  constructor(rootContent: string, rootId?: string) {
    this.root = {
      id: rootId ?? generateULID(),
      content: rootContent,
      score: null,
      depth: 0,
      parentId: null,
      childIds: [],
      status: "open",
    };
    this.nodes.set(this.root.id, this.root);
  }

  /** Lookup a node by id (undefined if absent). */
  getNode(id: string): BranchNode | undefined {
    return this.nodes.get(id);
  }

  /** All nodes in insertion order. */
  allNodes(): BranchNode[] {
    return [...this.nodes.values()];
  }

  /** Number of nodes including the root. */
  size(): number {
    return this.nodes.size;
  }

  /**
   * Create child nodes under `parent`, one per generated thought. Children are
   * created `status: "open"` with `depth = parent.depth + 1`. The parent is
   * marked `"expanded"` (unless it was pruned, which is preserved). Returns the
   * newly created children in input order. Empty input is a no-op returning [].
   */
  expand(parent: BranchNode, generated: string[]): BranchNode[] {
    const owned = this.nodes.get(parent.id);
    if (!owned) {
      throw new Error(`expand: parent ${parent.id} is not in this tree`);
    }
    const children: BranchNode[] = [];
    for (const content of generated) {
      const child: BranchNode = {
        id: generateULID(),
        content,
        score: null,
        depth: owned.depth + 1,
        parentId: owned.id,
        childIds: [],
        status: "open",
      };
      this.nodes.set(child.id, child);
      owned.childIds.push(child.id);
      children.push(child);
    }
    if (children.length > 0 && owned.status !== "pruned") {
      owned.status = "expanded";
    }
    return children;
  }

  /**
   * Score a node with the injected scorer. Pure: the scorer receives the node's
   * content and returns a number; we only store it. A pruned node can still be
   * (re)evaluated — pruning affects selection, not scorability.
   */
  evaluate(node: BranchNode, scorer: (content: string) => number): void {
    const owned = this.nodes.get(node.id);
    if (!owned) {
      throw new Error(`evaluate: node ${node.id} is not in this tree`);
    }
    owned.score = scorer(owned.content);
  }

  /**
   * Beam selection: return the top-`beamWidth` *open* (selectable) nodes by
   * score, descending. "Selectable" = status `"open"` (never `pruned`,
   * `expanded`, or `leaf`). Unevaluated nodes (score null) sort to the bottom.
   * Ties break by id for determinism. Returns fewer than `beamWidth` when fewer
   * are open; returns [] when none are open or beamWidth <= 0.
   */
  selectFrontier(beamWidth: number): BranchNode[] {
    if (beamWidth <= 0) return [];
    const open = [...this.nodes.values()].filter((n) => n.status === "open");
    open.sort((a, b) => {
      const sa = a.score ?? Number.NEGATIVE_INFINITY;
      const sb = b.score ?? Number.NEGATIVE_INFINITY;
      if (sb !== sa) return sb - sa;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return open.slice(0, beamWidth);
  }

  /**
   * Mark every *open*, evaluated node whose score is strictly below `threshold`
   * as `"pruned"`. Unevaluated nodes (score null) are left untouched. Returns
   * the pruned nodes.
   */
  prune(threshold: number): BranchNode[] {
    const pruned: BranchNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.status === "open" && node.score !== null && node.score < threshold) {
        node.status = "pruned";
        pruned.push(node);
      }
    }
    return pruned;
  }

  /**
   * Backtrack: when the beam frontier is empty (dead end), find the best
   * remaining *open* node anywhere in the tree to resume from. Returns the
   * highest-scoring open node, or null when the tree has no open nodes left
   * (search exhausted). This is the "recover a sibling / ancestor" move.
   */
  backtrack(): BranchNode | null {
    const open = this.selectFrontier(Number.MAX_SAFE_INTEGER);
    return open.length > 0 ? open[0] : null;
  }

  /**
   * Mark a node as a terminal leaf of the search (it will no longer be
   * expanded). Idempotent; pruned nodes are not promoted to leaves.
   */
  markLeaf(node: BranchNode): void {
    const owned = this.nodes.get(node.id);
    if (!owned) {
      throw new Error(`markLeaf: node ${node.id} is not in this tree`);
    }
    if (owned.status !== "pruned") {
      owned.status = "leaf";
    }
  }

  /**
   * Leaf candidates = evaluated nodes that are not pruned and have no children
   * (the explored frontier tips), plus any node explicitly marked `"leaf"`.
   * Used by {@link bestLeaf}.
   */
  leaves(): BranchNode[] {
    const out: BranchNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.status === "pruned") continue;
      const isFrontierTip = node.childIds.length === 0 && node.id !== this.root.id;
      const isMarkedLeaf = node.status === "leaf";
      if (isFrontierTip || isMarkedLeaf) {
        out.push(node);
      }
    }
    return out;
  }

  /**
   * The highest-scoring leaf. Unevaluated leaves (score null) are treated as
   * `-Infinity`. Ties break by id for determinism. Falls back to the root when
   * the tree was never expanded (so callers always get a node back).
   */
  bestLeaf(): BranchNode {
    const candidates = this.leaves();
    if (candidates.length === 0) return this.root;
    let best = candidates[0];
    for (const node of candidates) {
      const sNode = node.score ?? Number.NEGATIVE_INFINITY;
      const sBest = best.score ?? Number.NEGATIVE_INFINITY;
      if (sNode > sBest || (sNode === sBest && node.id < best.id)) {
        best = node;
      }
    }
    return best;
  }

  /**
   * Reconstruct the root → `node` path (ids) via parent pointers. The returned
   * array starts at the root and ends at `node`.
   */
  pathTo(node: BranchNode): string[] {
    const path: string[] = [];
    let cursor: BranchNode | undefined = this.nodes.get(node.id);
    while (cursor) {
      path.unshift(cursor.id);
      cursor = cursor.parentId ? this.nodes.get(cursor.parentId) : undefined;
    }
    return path;
  }

  /** Serialize to a plain object (round-trippable via {@link ReasoningTree.deserialize}). */
  serialize(): SerializedTree {
    const nodes = this.allNodes().map((n) => ({ ...n, childIds: [...n.childIds] }));
    const edges: Array<{ from: string; to: string }> = [];
    for (const node of this.nodes.values()) {
      for (const childId of node.childIds) {
        edges.push({ from: node.id, to: childId });
      }
    }
    return {
      rootId: this.root.id,
      nodes,
      edges,
      winningPath: this.pathTo(this.bestLeaf()),
    };
  }

  /** Rebuild a tree from {@link serialize} output. */
  static deserialize(data: SerializedTree): ReasoningTree {
    const rootSer = data.nodes.find((n) => n.id === data.rootId);
    if (!rootSer) {
      throw new Error("deserialize: rootId not found among nodes");
    }
    const tree = new ReasoningTree(rootSer.content, rootSer.id);
    tree.root.score = rootSer.score;
    tree.root.status = rootSer.status;
    tree.root.childIds = [...rootSer.childIds];
    for (const ser of data.nodes) {
      if (ser.id === data.rootId) continue;
      tree.nodes.set(ser.id, { ...ser, childIds: [...ser.childIds] });
    }
    return tree;
  }
}
