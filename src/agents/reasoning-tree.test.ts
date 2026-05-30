import { describe, expect, it } from "vitest";
import { ReasoningTree, type BranchNode } from "./reasoning-tree.js";

/** Deterministic scorer: maps fixed content strings to fixed scores. */
const scoreByMap = (map: Record<string, number>) => (content: string) => map[content] ?? 0;

describe("ReasoningTree", () => {
  it("constructs a root node at depth 0, open, no parent, unscored", () => {
    const tree = new ReasoningTree("root prompt");
    expect(tree.root.depth).toBe(0);
    expect(tree.root.parentId).toBeNull();
    expect(tree.root.status).toBe("open");
    expect(tree.root.score).toBeNull();
    expect(tree.root.content).toBe("root prompt");
    expect(tree.size()).toBe(1);
  });

  it("expand creates N children with correct parentId, depth, and open status", () => {
    const tree = new ReasoningTree("root");
    const children = tree.expand(tree.root, ["a", "b", "c"]);
    expect(children).toHaveLength(3);
    for (const c of children) {
      expect(c.parentId).toBe(tree.root.id);
      expect(c.depth).toBe(1);
      expect(c.status).toBe("open");
      expect(c.score).toBeNull();
    }
    expect(tree.root.childIds).toEqual(children.map((c) => c.id));
    expect(tree.root.status).toBe("expanded");
    expect(tree.size()).toBe(4);
  });

  it("expand with empty input is a no-op and leaves parent open", () => {
    const tree = new ReasoningTree("root");
    const children = tree.expand(tree.root, []);
    expect(children).toHaveLength(0);
    expect(tree.root.status).toBe("open");
    expect(tree.size()).toBe(1);
  });

  it("expand throws if parent is not in the tree", () => {
    const tree = new ReasoningTree("root");
    const orphan: BranchNode = {
      id: "ZZZ",
      content: "x",
      score: null,
      depth: 0,
      parentId: null,
      childIds: [],
      status: "open",
    };
    expect(() => tree.expand(orphan, ["a"])).toThrow(/not in this tree/);
  });

  it("evaluate sets scores from the injected deterministic scorer", () => {
    const tree = new ReasoningTree("root");
    const [a, b] = tree.expand(tree.root, ["a", "b"]);
    const scorer = scoreByMap({ a: 0.9, b: 0.2 });
    tree.evaluate(a, scorer);
    tree.evaluate(b, scorer);
    expect(tree.getNode(a.id)?.score).toBe(0.9);
    expect(tree.getNode(b.id)?.score).toBe(0.2);
  });

  it("selectFrontier returns exactly the top-M open nodes by score, descending", () => {
    const tree = new ReasoningTree("root");
    const children = tree.expand(tree.root, ["a", "b", "c", "d"]);
    const scorer = scoreByMap({ a: 0.5, b: 0.9, c: 0.1, d: 0.7 });
    for (const c of children) tree.evaluate(c, scorer);
    const top2 = tree.selectFrontier(2);
    expect(top2.map((n) => n.content)).toEqual(["b", "d"]);
  });

  it("selectFrontier returns fewer than M when fewer open nodes exist", () => {
    const tree = new ReasoningTree("root");
    const children = tree.expand(tree.root, ["a", "b"]);
    for (const c of children) tree.evaluate(c, scoreByMap({ a: 1, b: 2 }));
    expect(tree.selectFrontier(5)).toHaveLength(2);
  });

  it("selectFrontier with beamWidth <= 0 returns []", () => {
    const tree = new ReasoningTree("root");
    tree.expand(tree.root, ["a"]);
    expect(tree.selectFrontier(0)).toEqual([]);
    expect(tree.selectFrontier(-1)).toEqual([]);
  });

  it("selectFrontier excludes expanded/pruned/leaf nodes (only open are selectable)", () => {
    const tree = new ReasoningTree("root");
    const [a, b] = tree.expand(tree.root, ["a", "b"]);
    tree.evaluate(a, scoreByMap({ a: 1 }));
    tree.evaluate(b, scoreByMap({ b: 1 }));
    // expand a → a becomes "expanded", so it should not appear in frontier
    tree.expand(a, ["a1"]);
    const frontier = tree.selectFrontier(10);
    const contents = frontier.map((n) => n.content);
    expect(contents).toContain("b");
    expect(contents).toContain("a1");
    expect(contents).not.toContain("a"); // expanded
    expect(contents).not.toContain("root"); // expanded root
  });

  it("prune flips low scorers to pruned and excludes them from the frontier", () => {
    const tree = new ReasoningTree("root");
    const children = tree.expand(tree.root, ["a", "b", "c"]);
    const scorer = scoreByMap({ a: 0.8, b: 0.1, c: 0.05 });
    for (const c of children) tree.evaluate(c, scorer);
    const pruned = tree.prune(0.5);
    expect(pruned.map((n) => n.content).sort()).toEqual(["b", "c"]);
    expect(tree.getNode(children[1].id)?.status).toBe("pruned");
    const frontier = tree.selectFrontier(10);
    expect(frontier.map((n) => n.content)).toEqual(["a"]);
  });

  it("prune leaves unevaluated (score null) nodes untouched", () => {
    const tree = new ReasoningTree("root");
    const [a, b] = tree.expand(tree.root, ["a", "b"]);
    tree.evaluate(a, scoreByMap({ a: 0.1 }));
    // b is unevaluated
    tree.prune(0.5);
    expect(tree.getNode(a.id)?.status).toBe("pruned");
    expect(tree.getNode(b.id)?.status).toBe("open");
  });

  it("bestLeaf returns the maximum-score leaf and its path reconstructs via parentId", () => {
    const tree = new ReasoningTree("root");
    const [a, b] = tree.expand(tree.root, ["a", "b"]);
    tree.evaluate(a, scoreByMap({ a: 0.3 }));
    tree.evaluate(b, scoreByMap({ b: 0.6 }));
    const [a1] = tree.expand(a, ["a1"]);
    tree.evaluate(a1, scoreByMap({ a1: 0.95 }));
    const best = tree.bestLeaf();
    expect(best.content).toBe("a1");
    const path = tree.pathTo(best);
    expect(path).toEqual([tree.root.id, a.id, a1.id]);
  });

  it("bestLeaf ignores pruned leaves", () => {
    const tree = new ReasoningTree("root");
    const [a, b] = tree.expand(tree.root, ["a", "b"]);
    tree.evaluate(a, scoreByMap({ a: 0.99 }));
    tree.evaluate(b, scoreByMap({ b: 0.5 }));
    tree.prune(0.9); // prunes b
    // a scores 0.99 but is also above threshold; prune only removed b
    tree.prune(1.0); // now prunes a too
    // both pruned → no leaves → falls back to root
    expect(tree.bestLeaf().id).toBe(tree.root.id);
  });

  it("bestLeaf falls back to the root when the tree was never expanded", () => {
    const tree = new ReasoningTree("root only");
    expect(tree.bestLeaf().id).toBe(tree.root.id);
  });

  it("backtrack returns the best open node when frontier is dead, null when exhausted", () => {
    const tree = new ReasoningTree("root");
    const [a, b, c] = tree.expand(tree.root, ["a", "b", "c"]);
    tree.evaluate(a, scoreByMap({ a: 0.2 }));
    tree.evaluate(b, scoreByMap({ b: 0.7 }));
    tree.evaluate(c, scoreByMap({ c: 0.4 }));
    // best open is b
    expect(tree.backtrack()?.content).toBe("b");
    // prune everything → exhausted
    tree.prune(Number.POSITIVE_INFINITY);
    expect(tree.backtrack()).toBeNull();
  });

  it("deterministic tie-break by id keeps selection stable", () => {
    const tree = new ReasoningTree("root", "ROOT");
    const children = tree.expand(tree.root, ["a", "b", "c"]);
    // all equal scores → order must be by id ascending
    for (const c of children) tree.evaluate(c, () => 0.5);
    const sortedByIdAsc = [...children].sort((x, y) => (x.id < y.id ? -1 : 1));
    const frontier = tree.selectFrontier(3);
    expect(frontier.map((n) => n.id)).toEqual(sortedByIdAsc.map((n) => n.id));
  });

  it("markLeaf marks a node leaf but never promotes a pruned node", () => {
    const tree = new ReasoningTree("root");
    const [a, b] = tree.expand(tree.root, ["a", "b"]);
    tree.evaluate(a, scoreByMap({ a: 0.1 }));
    tree.prune(0.5); // a pruned
    tree.markLeaf(a);
    expect(tree.getNode(a.id)?.status).toBe("pruned");
    tree.markLeaf(b);
    expect(tree.getNode(b.id)?.status).toBe("leaf");
  });

  it("serialize round-trips nodes, edges, and winningPath via deserialize", () => {
    const tree = new ReasoningTree("root");
    const [a, b] = tree.expand(tree.root, ["a", "b"]);
    tree.evaluate(a, scoreByMap({ a: 0.3 }));
    tree.evaluate(b, scoreByMap({ b: 0.8 }));
    const [b1] = tree.expand(b, ["b1"]);
    tree.evaluate(b1, scoreByMap({ b1: 0.9 }));

    const ser = tree.serialize();
    expect(ser.rootId).toBe(tree.root.id);
    expect(ser.nodes).toHaveLength(4);
    expect(ser.edges).toEqual(
      expect.arrayContaining([
        { from: tree.root.id, to: a.id },
        { from: tree.root.id, to: b.id },
        { from: b.id, to: b1.id },
      ]),
    );
    expect(ser.winningPath).toEqual([tree.root.id, b.id, b1.id]);

    const restored = ReasoningTree.deserialize(ser);
    expect(restored.size()).toBe(4);
    expect(restored.bestLeaf().content).toBe("b1");
    expect(restored.serialize().winningPath).toEqual(ser.winningPath);
  });

  it("deserialize throws when rootId is missing from nodes", () => {
    const tree = new ReasoningTree("root");
    const ser = tree.serialize();
    ser.rootId = "DOES-NOT-EXIST";
    expect(() => ReasoningTree.deserialize(ser)).toThrow(/rootId not found/);
  });
});
