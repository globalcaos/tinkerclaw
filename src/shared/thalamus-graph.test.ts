import { describe, expect, it } from "vitest";
import {
  buildGraph,
  criticalPath,
  fanOutChoice,
  GraphError,
  HEDGE_MAX_SHARE,
  hedgeDue,
  ready,
  sharedStartBreakEven,
  sharedStartGroups,
  splitAtBoundaries,
  unitsFor,
  withinCaps,
  withTiming,
  writesCollide,
} from "./thalamus-graph.js";
import type { Unit } from "./thalamus-v4-types.js";

const unit = (id: string, over: Partial<Unit> = {}): Unit => ({
  id,
  task: id,
  kind: "work",
  inputs: [],
  outputs: [],
  writes: [],
  estIn: 1000,
  estOut: 200,
  model: "auto",
  urgency: "waiting",
  private: false,
  ...over,
});

// a -> b -> d and a -> c -> d, with c slower than b.
const diamond = () =>
  buildGraph([
    unit("a", { outputs: ["A"] }),
    unit("b", { inputs: ["A"], outputs: ["B"] }),
    unit("c", { inputs: ["A"], outputs: ["C"] }),
    unit("d", { inputs: ["B", "C"] }),
  ]);

describe("buildGraph", () => {
  it("adds an input edge from the unit that makes an output to each unit that needs it", () => {
    const g = diamond();
    expect(g.edges).toEqual([
      { from: "a", to: "b", why: "input" },
      { from: "a", to: "c", why: "input" },
      { from: "b", to: "d", why: "input" },
      { from: "c", to: "d", why: "input" },
    ]);
    expect(g.order).toEqual(["a", "b", "c", "d"]);
  });

  it("puts an input nobody makes outside the plan: no edge", () => {
    const g = buildGraph([unit("a", { inputs: ["the user's request"] })]);
    expect(g.edges).toEqual([]);
  });

  it("orders two units that change the same thing, in plan order, and leaves the rest free", () => {
    const g = buildGraph([
      unit("x", { writes: ["src/a.ts"] }),
      unit("y", { writes: ["src/b.ts"] }),
      unit("z", { writes: ["src/a.ts", "src/c.ts"] }),
    ]);
    expect(g.edges).toEqual([{ from: "x", to: "z", why: "same-write" }]);
  });

  it("adds no same-write edge between units the inputs already order, in either direction", () => {
    const g = buildGraph([
      unit("late", { inputs: ["E"], writes: ["f"] }),
      unit("early", { outputs: ["E"], writes: ["f"] }),
    ]);
    expect(g.edges).toEqual([{ from: "early", to: "late", why: "input" }]);
  });

  it("is checked from the declared changes: a unit that declares none is never ordered against another", () => {
    expect(writesCollide(unit("p"), unit("q", { writes: ["f"] }))).toBe(false);
    expect(buildGraph([unit("p"), unit("q", { writes: ["f"] })]).edges).toEqual([]);
  });

  it("refuses a duplicate id, an output made twice, a unit that waits for itself and a cycle", () => {
    expect(() => buildGraph([unit("a"), unit("a")])).toThrow(/duplicate unit id "a"/);
    expect(() =>
      buildGraph([unit("a", { outputs: ["X"] }), unit("b", { outputs: ["X"] })]),
    ).toThrow(/output "X" is made by both/);
    expect(() => buildGraph([unit("a", { inputs: ["X"], outputs: ["X"] })])).toThrow(
      /its own output/,
    );
    expect(() =>
      buildGraph([
        unit("a", { inputs: ["B"], outputs: ["A"] }),
        unit("b", { inputs: ["A"], outputs: ["B"] }),
      ]),
    ).toThrow(GraphError);
  });
});

describe("criticalPath and slack", () => {
  it("finds the longest chain and gives the shorter branch its slack", () => {
    const g = diamond();
    const t = criticalPath(g, { a: 2, b: 3, c: 10, d: 1 });
    expect(t.criticalPath).toEqual(["a", "c", "d"]);
    expect(t.length).toBe(13);
    expect(t.slackSec).toEqual({ a: 0, b: 7, c: 0, d: 0 });
    expect(t.earliestStart).toEqual({ a: 0, b: 2, c: 2, d: 12 });
  });

  it("puts units on the critical path at zero slack and gives the sums a hand-checkable total", () => {
    const g = buildGraph([
      unit("r1", { outputs: ["R1"] }),
      unit("r2", { outputs: ["R2"] }),
      unit("r3", { outputs: ["R3"] }),
      unit("join", { inputs: ["R1", "R2", "R3"] }),
    ]);
    const t = criticalPath(g, { r1: 4, r2: 9, r3: 6, join: 2 });
    expect(t.criticalPath).toEqual(["r2", "join"]);
    expect(t.slackSec).toEqual({ r1: 5, r2: 0, r3: 3, join: 0 });
    // Finishing time: slack plus duration never exceeds the path's length from the unit's earliest start.
    for (const id of ["r1", "r3"])
      expect(t.earliestStart[id] + { r1: 4, r3: 6 }[id as "r1"]! + t.slackSec[id]).toBe(9);
  });

  it("breaks a tie toward the unit listed first, the same every time", () => {
    const g = buildGraph([
      unit("p", { outputs: ["P"] }),
      unit("q", { outputs: ["Q"] }),
      unit("r", { inputs: ["P", "Q"] }),
    ]);
    const a = criticalPath(g, { p: 5, q: 5, r: 1 }).criticalPath;
    const b = criticalPath(g, { p: 5, q: 5, r: 1 }).criticalPath;
    expect(a).toEqual(["p", "r"]);
    expect(b).toEqual(a);
  });

  it("counts a unit with no duration as zero, and an empty plan as nothing", () => {
    expect(criticalPath(diamond(), {}).length).toBe(0);
    const empty = criticalPath(buildGraph([]), {});
    expect(empty).toMatchObject({ criticalPath: [], length: 0 });
  });

  it("withTiming fills the graph's path and slack and leaves the rest as it was", () => {
    const g = diamond();
    const timed = withTiming(g, { a: 1, b: 1, c: 5, d: 1 });
    expect(timed.criticalPath).toEqual(["a", "c", "d"]);
    expect(timed.slackSec.b).toBe(4);
    expect(timed.edges).toBe(g.edges);
  });
});

describe("ready", () => {
  const none = { done: new Set<string>(), running: new Set<string>() };

  it("starts every unit whose inputs are done, least slack first", () => {
    const g = withTiming(diamond(), { a: 2, b: 3, c: 10, d: 1 });
    expect(ready(g, none)).toEqual(["a"]);
    expect(ready(g, { done: new Set(["a"]), running: new Set() })).toEqual(["c", "b"]);
    expect(ready(g, { done: new Set(["a", "b"]), running: new Set(["c"]) })).toEqual([]);
    expect(ready(g, { done: new Set(["a", "b", "c"]), running: new Set() })).toEqual(["d"]);
  });

  it("never offers a unit that is running or done", () => {
    const g = diamond();
    expect(ready(g, { done: new Set(["a"]), running: new Set(["b"]) })).toEqual(["c"]);
  });

  it("does not start a unit whose declared change collides with a running one, even with no edge between them", () => {
    const g = buildGraph([unit("x", { writes: ["f"] }), unit("y", { writes: ["g"] })]);
    // Edit the plan while it runs: y now also changes f. The edges are stale; the check at start time is not.
    const edited = { ...g, units: [g.units[0], { ...g.units[1], writes: ["g", "f"] }] };
    expect(ready(edited, { done: new Set(), running: new Set(["x"]) })).toEqual([]);
    expect(ready(g, { done: new Set(), running: new Set(["x"]) })).toEqual(["y"]);
  });

  it("releases the later of two same-write units only when the earlier is done", () => {
    const g = buildGraph([unit("x", { writes: ["f"] }), unit("y", { writes: ["f"] })]);
    expect(ready(g, none)).toEqual(["x"]);
    expect(ready(g, { done: new Set(["x"]), running: new Set() })).toEqual(["y"]);
  });
});

describe("withinCaps", () => {
  const c = (id: string, provider: string) => ({ id, provider });

  it("admits in order while each provider stays under its cap, and defers the rest in order", () => {
    const out = withinCaps(
      [c("1", "p"), c("2", "p"), c("3", "q"), c("4", "p"), c("5", "q")],
      { p: 1 },
      { p: 3, q: 1 },
    );
    expect(out.admitted.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(out.deferred.map((x) => x.id)).toEqual(["4", "5"]);
  });

  it("does not limit a provider with no cap listed", () => {
    const out = withinCaps([c("1", "z"), c("2", "z"), c("3", "z")], {}, {});
    expect(out.admitted).toHaveLength(3);
  });

  it("counts calls already in flight against the cap", () => {
    const out = withinCaps([c("1", "p")], { p: 4 }, { p: 4 });
    expect(out.admitted).toEqual([]);
    expect(out.deferred).toHaveLength(1);
  });
});

describe("shared start", () => {
  it("groups siblings by the start they share; a group of one is dropped", () => {
    const groups = sharedStartGroups([
      unit("r1", { sharedStart: { id: "defs", tokens: 9000 } }),
      unit("r2", { sharedStart: { id: "defs", tokens: 9000 } }),
      unit("solo", { sharedStart: { id: "other", tokens: 100 } }),
      unit("plain"),
    ]);
    expect([...groups.keys()]).toEqual(["defs"]);
    expect(groups.get("defs")?.map((u) => u.id)).toEqual(["r1", "r2"]);
  });

  // One model reads the start from its cache after the first sibling writes it: write 1.25x, read 0.1x the input
  // price of 1.0. Each sibling on its own cheaper model pays 0.5 for the same tokens.
  const shared = { inputPerMTok: 1, writeMult: 1.25, readMult: 0.1 };

  it("flips at the computed number of siblings", () => {
    // Shared: S x (1.25 + (n-1) x 0.1). Independent: S x 0.5 x n.  n=2: 1.35 vs 1.0; n=3: 1.45 vs 1.5.
    const at = (n: number) =>
      fanOutChoice({ n, sharedTokens: 1_000_000, shared, ownInputPerMTok: Array(n).fill(0.5) });
    expect(at(2).mode).toBe("independent");
    expect(at(3).mode).toBe("shared-start");
    expect(at(2).sharedCost).toBeCloseTo(1.35, 10);
    expect(at(2).ownCost).toBeCloseTo(1.0, 10);
    expect(at(3).sharedCost).toBeCloseTo(1.45, 10);
    expect(at(3).ownCost).toBeCloseTo(1.5, 10);
    expect(sharedStartBreakEven({ shared, ownInputPerMTok: 0.5 })).toBe(3);
  });

  it("never prefers a shared start when a read costs no less than the plain price on the siblings' own model", () => {
    expect(
      sharedStartBreakEven({
        shared: { inputPerMTok: 1, writeMult: 1.25, readMult: 0.6 },
        ownInputPerMTok: 0.5,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the shared start on a tie, and with no siblings costs nothing", () => {
    const tie = fanOutChoice({
      n: 1,
      sharedTokens: 1_000_000,
      shared: { inputPerMTok: 1, writeMult: 1, readMult: 0.1 },
      ownInputPerMTok: [1],
    });
    expect(tie.mode).toBe("shared-start");
    expect(fanOutChoice({ n: 0, sharedTokens: 5, shared, ownInputPerMTok: [] })).toMatchObject({
      sharedCost: 0,
      ownCost: 0,
    });
  });
});

describe("splitAtBoundaries", () => {
  const para = (n: number) => `Paragraph ${n}. ${"word ".repeat(40)}`.trim();

  it("gives the text back exactly when the pieces are joined, every piece within the budget", () => {
    const text = Array.from({ length: 60 }, (_, i) => para(i)).join("\n\n");
    const pieces = splitAtBoundaries(text, 400);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join("")).toBe(text);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(400 * 4);
  });

  it("cuts at a heading before a blank line, and a blank line before a line end", () => {
    const body = "x".repeat(300);
    const text = `${body}\n\n${body}\n# Heading\n${body}\n\n${body}`;
    const pieces = splitAtBoundaries(text, 250);
    expect(pieces[0].endsWith("\n")).toBe(true);
    expect(pieces[1].startsWith("# Heading")).toBe(true);
  });

  it("keeps a short text whole, returns nothing for nothing, and cuts a text with no boundary at the budget", () => {
    expect(splitAtBoundaries("short", 100)).toEqual(["short"]);
    expect(splitAtBoundaries("", 100)).toEqual([]);
    const solid = "y".repeat(10_000);
    const pieces = splitAtBoundaries(solid, 500);
    expect(pieces.join("")).toBe(solid);
    expect(pieces.every((p) => p.length <= 2000)).toBe(true);
  });
});

describe("hedgeDue", () => {
  const base = {
    onCritical: true,
    hedged: false,
    elapsedSec: 31,
    usualSec: 20,
    margin: 1.5,
    hedgedSoFar: 0,
    planUnits: 14,
  };

  it("fires for a critical-path unit past its usual time times the margin, and not before", () => {
    expect(hedgeDue(base)).toBe(true);
    expect(hedgeDue({ ...base, elapsedSec: 30 })).toBe(false);
    expect(hedgeDue({ ...base, elapsedSec: 30.01 })).toBe(true);
  });

  it("never for a unit off the critical path, nor twice for one unit", () => {
    expect(hedgeDue({ ...base, onCritical: false })).toBe(false);
    expect(hedgeDue({ ...base, hedged: true })).toBe(false);
  });

  it("never past a fifth of the plan's units", () => {
    expect(HEDGE_MAX_SHARE).toBe(0.2);
    expect(hedgeDue({ ...base, hedgedSoFar: 1 })).toBe(true); // floor(14 x 0.2) = 2
    expect(hedgeDue({ ...base, hedgedSoFar: 2 })).toBe(false);
    expect(hedgeDue({ ...base, planUnits: 4 })).toBe(false); // floor(0.8) = 0: a tiny plan hedges nothing
  });

  it("does nothing with no usual time or no margin", () => {
    expect(hedgeDue({ ...base, usualSec: 0 })).toBe(false);
    expect(hedgeDue({ ...base, margin: 0 })).toBe(false);
  });
});

describe("unitsFor", () => {
  const whole = unit("whole");
  const planned = [unit("a"), unit("b")];
  it("keeps a chain or a single answer as one unit, however the planner cut it, and lets parts be a graph", () => {
    expect(unitsFor("chain", planned, whole)).toEqual([whole]);
    expect(unitsFor("answer", planned, whole)).toEqual([whole]);
    expect(unitsFor("parts", planned, whole)).toEqual(planned);
    expect(unitsFor("parts", [], whole)).toEqual([whole]);
  });
});
