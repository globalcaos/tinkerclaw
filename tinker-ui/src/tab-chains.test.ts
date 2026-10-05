import { describe, expect, it } from "vitest";
import {
  adjacentChainOrder,
  chainOf,
  chainOfSession,
  createRope,
  linkTabs,
  nextChainColor,
  pairChainedRows,
  parseChains,
  rebindChain,
  samplePath,
  serializeChains,
  settleRope,
  stepRope,
  unlinkSession,
  unlinkTab,
  withChainKeys,
} from "./tab-chains.js";

describe("tab chains — pair list", () => {
  it("links a master to a slave with the first colour", () => {
    expect(linkTabs([], "a", "b")).toEqual([{ master: "a", slave: "b", color: 0 }]);
  });

  it("refuses a tab chained to itself", () => {
    expect(linkTabs([], "a", "a")).toEqual([]);
  });

  it("keeps one chain per tab — re-linking either end replaces the old chain", () => {
    let c = linkTabs([], "a", "b");
    c = linkTabs(c, "c", "d");
    c = linkTabs(c, "a", "d");
    expect(c).toEqual([{ master: "a", slave: "d", color: 0 }]);
  });

  it("gives each concurrent loop its own colour and reuses a released one", () => {
    let c = linkTabs([], "a", "b");
    c = linkTabs(c, "c", "d");
    c = linkTabs(c, "e", "f");
    expect(c.map((x) => x.color)).toEqual([0, 1, 2]);
    c = unlinkTab(c, "d");
    expect(nextChainColor(c, "g")).toBe(1);
    c = linkTabs(c, "g", "h");
    expect(chainOf(c, "h")?.color).toBe(1);
    expect(chainOf(c, "a")?.color).toBe(0);
  });

  it("round-trips and tolerates garbage", () => {
    const c = linkTabs([], "a", "b");
    expect(parseChains(serializeChains(c))).toEqual(c);
    expect(serializeChains([])).toBe("[]");
    expect(parseChains("not json")).toEqual([]);
    expect(parseChains('{"x":1}')).toEqual([]);
    expect(parseChains('[{"master":"a"},{"master":"x","slave":"x"},null]')).toEqual([]);
  });
});

describe("tab chains — rope physics", () => {
  it("settles into a sag below both anchors with the ends pinned", () => {
    const a = { x: 100, y: 40 };
    const b = { x: 400, y: 40 };
    const rope = createRope(a, b);
    settleRope(rope, a, b);
    expect(rope[0]).toMatchObject(a);
    expect(rope[rope.length - 1]).toMatchObject(b);
    const lowest = Math.max(...rope.map((p) => p.y));
    expect(lowest).toBeGreaterThan(80);
    // at rest: another step barely moves anything
    expect(stepRope(rope, a, b)).toBeLessThan(0.5);
  });

  it("swings again when an anchor moves", () => {
    const a = { x: 100, y: 40 };
    const b = { x: 400, y: 40 };
    const rope = createRope(a, b);
    settleRope(rope, a, b);
    let moved = 0;
    for (let i = 0; i < 5; i++) moved = Math.max(moved, stepRope(rope, a, { x: 700, y: 40 }));
    expect(moved).toBeGreaterThan(1);
  });

  it("samples link positions at a fixed spacing", () => {
    const pts = samplePath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      10,
    );
    expect(pts).toHaveLength(11);
    expect(pts[3]).toMatchObject({ x: 30, y: 0, angle: 0 });
  });
});

describe("tab chains — the pair behaves as one object (2026-09-25)", () => {
  const match = (a: string, b: string) => a === b || a.endsWith(":" + b) || b.endsWith(":" + a);
  const T = (...ids: string[]) => ids.map((id) => ({ id }));

  it("keeps session keys through a save/load round trip", () => {
    const c = withChainKeys(linkTabs([], "a", "b"), (id) => ({ a: "tinker:A", b: "tinker:B" })[id]);
    expect(parseChains(serializeChains(c))).toEqual([
      { master: "a", slave: "b", color: 0, masterKey: "tinker:A", slaveKey: "tinker:B" },
    ]);
  });

  it("refreshes keys from open tabs and keeps the old key for a closed end", () => {
    let c = withChainKeys(linkTabs([], "a", "b"), (id) => ({ a: "k1", b: "k2" })[id]);
    c = withChainKeys(c, (id) => (id === "a" ? "k1-after-clear" : undefined));
    expect(c[0]).toMatchObject({ masterKey: "k1-after-clear", slaveKey: "k2" });
  });

  it("finds a closed pair from either session, with a gateway-prefixed key", () => {
    const c = withChainKeys(linkTabs([], "a", "b"), (id) => ({ a: "tinker:A", b: "tinker:B" })[id]);
    expect(chainOfSession(c, "agent:main:tinker:B", match)).toMatchObject({
      role: "slave",
      partnerKey: "tinker:A",
    });
    expect(chainOfSession(c, "tinker:A", match)?.role).toBe("master");
    expect(chainOfSession(c, "tinker:Z", match)).toBeUndefined();
  });

  it("rebinds a reopened pair to its new tab ids, keeping colour and keys", () => {
    let c = linkTabs([], "x", "y");
    c = withChainKeys(linkTabs(c, "a", "b"), (id) => ({ a: "kA", b: "kB" })[id]);
    const old = chainOf(c, "a")!;
    const next = rebindChain(c, old, "a2", "b2");
    expect(chainOf(next, "a")).toBeUndefined();
    expect(chainOf(next, "a2")).toMatchObject({ slave: "b2", color: 1, masterKey: "kA" });
    expect(chainOf(next, "x")).toBeDefined();
  });

  it("releases every chain touching a deleted session", () => {
    const c = withChainKeys(linkTabs([], "a", "b"), (id) => ({ a: "kA", b: "kB" })[id]);
    expect(unlinkSession(c, "kB", match)).toEqual([]);
  });

  it("puts the master immediately before the slave when they are linked", () => {
    const c = linkTabs([], "d", "b");
    expect(adjacentChainOrder(T("a", "b", "c", "d"), c).map((t) => t.id)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("brings the partner along when one end is dragged", () => {
    const c = linkTabs([], "b", "c");
    // user dragged the master "b" to the end: the slave follows it
    expect(adjacentChainOrder(T("a", "c", "d", "b"), c, "b").map((t) => t.id)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    // user dragged the slave "c" to the front: the master comes to sit before it
    expect(adjacentChainOrder(T("c", "a", "b", "d"), c, "c").map((t) => t.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("never moves a fixed tab (Main); the partner comes to it", () => {
    const c = linkTabs([], "tab-main", "c");
    const fixed = (id: string) => id === "tab-main";
    expect(
      adjacentChainOrder(T("tab-main", "a", "c"), c, undefined, fixed).map((t) => t.id),
    ).toEqual(["tab-main", "c", "a"]);
  });

  it("is a no-op for pairs already adjacent or not both open", () => {
    const c = linkTabs([], "a", "b");
    expect(adjacentChainOrder(T("a", "b", "c"), c).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(adjacentChainOrder(T("c", "b"), c).map((t) => t.id)).toEqual(["c", "b"]);
  });

  it("lists the slave row directly under its master row in the sessions panel", () => {
    const rows = ["tinker:M", "tinker:X", "tinker:Y", "agent:main:tinker:S"];
    const out = pairChainedRows(
      rows,
      (r) => r,
      [{ masterKey: "tinker:M", slaveKey: "tinker:S" }],
      match,
    );
    expect(out).toEqual(["tinker:M", "agent:main:tinker:S", "tinker:X", "tinker:Y"]);
    expect(pairChainedRows(rows, (r) => r, [{ masterKey: "tinker:M" }], match)).toEqual(rows);
  });
});
