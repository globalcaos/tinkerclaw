import type { EnhancementCard, Shortlist } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import {
  applyEdit,
  calibrationPairs,
  CONFIDENT,
  estimateRates,
  evaluateEdit,
  fitCalibrationFrom,
  groupMisses,
  LOW_RANK,
  MAX_EDIT_CHARS,
  missesFrom,
  PI_FLOOR,
  PI_PRIOR,
  proposalsFrom,
  shouldShuffle,
  shuffleList,
  weightOf,
  wmrr,
  type Ranker,
  type ReplayTask,
  type UseLike,
} from "../../../src/shared/thalamus-card-loop.js";

// Tests for the pure half of the nightly card loop: what a pick counts, the misses, the replay metric, the pinned-case rule.

const card = (
  id: string,
  purpose: string,
  over: Partial<EnhancementCard> = {},
): EnhancementCard => ({
  id,
  kind: "skill",
  name: id.split(":")[1],
  family: "other",
  purpose,
  structure: "",
  alsoServed: [],
  version: 1,
  status: "active",
  origin: "seed",
  ...over,
});

/** A word-overlap ranker: the mock of Jev's reading, sensitive to exactly what an edit adds to a card. */
const rank: Ranker = (text, cards) => {
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  const score = (c: EnhancementCard) =>
    (
      `${c.purpose} ${c.structure} ${c.alsoServed.join(" ")}`.toLowerCase().match(/[a-z]+/g) ?? []
    ).filter((w) => words.has(w)).length;
  return [...cards]
    .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
    .map((c) => c.id);
};

const use = (over: Partial<UseLike> = {}): UseLike => ({
  taskId: "t",
  shuffled: false,
  shown: [],
  noneFits: 0.2,
  used: [],
  outcome: "done",
  ...over,
});

const entry = (cardId: string, rank: number, prob: number) => ({ cardId, rank, prob });

describe("what a pick counts", () => {
  it("is 1/pi of its rank: about 1.4 at rank 1 and 20 at rank 4 on the design's prior", () => {
    expect(PI_PRIOR).toEqual([0.7, 0.15, 0.08, 0.05, 0.02, 0.02]);
    const pi = estimateRates([]).pi;
    expect(weightOf(1, pi)).toBeCloseTo(1 / 0.7, 12);
    expect(weightOf(4, pi)).toBeCloseTo(20, 12);
  });

  it("counts a pick the agent made off the list as much as the rarest rank, and never more than 100", () => {
    const pi = estimateRates([]).pi;
    expect(weightOf(undefined, pi)).toBeCloseTo(1 / 0.02, 12);
    expect(weightOf(99, pi)).toBeCloseTo(1 / 0.02, 12);
    expect(weightOf(1, [0, 0])).toBeLessThanOrEqual(1 / PI_FLOOR);
  });

  it("is the prior, marked as a prior, until a list has been shuffled", () => {
    const r = estimateRates([
      use({
        shown: [entry("skill:a", 1, 0.9)],
        used: [{ cardId: "skill:a", onList: true, rank: 1 }],
      }),
    ]);
    expect(r).toMatchObject({ source: "prior", tasks: 0 });
    expect(r.pi).toEqual([...PI_PRIOR]);
  });

  it("measures the rates on shuffled lists only, and follows them as the tasks grow", () => {
    // Every shuffled task: the agent takes rank 2. After 1000 of them pi(2) is near 1 and pi(1) near 0 (floored).
    const uses = Array.from({ length: 1000 }, () =>
      use({
        shuffled: true,
        shown: [entry("skill:a", 1, 0.5), entry("skill:b", 2, 0.3)],
        used: [{ cardId: "skill:b", onList: true, rank: 2 }],
      }),
    );
    const r = estimateRates(uses);
    expect(r.source).toBe("measured");
    expect(r.tasks).toBe(1000);
    expect(r.pi[1]).toBeCloseTo((20 * 0.15 + 1000) / 1020, 12);
    expect(r.pi[0]).toBeCloseTo((20 * 0.7) / 1020, 12);
    // Ten shuffled tasks barely move the prior.
    const few = estimateRates(uses.slice(0, 10));
    expect(Math.abs(few.pi[0] - 0.7)).toBeLessThan(0.25);
    expect(few.pi[1]).toBeCloseTo((20 * 0.15 + 10) / 30, 12);
    // Unshuffled tasks never enter the measurement.
    expect(estimateRates(uses.map((u) => ({ ...u, shuffled: false }))).source).toBe("prior");
  });

  it("ignores a shuffled task that ended in a retry", () => {
    const retried = use({
      shuffled: true,
      outcome: "retried",
      shown: [entry("skill:a", 1, 0.9)],
      used: [{ cardId: "skill:a", onList: true, rank: 1 }],
    });
    expect(estimateRates([retried]).source).toBe("prior");
  });
});

describe("the misses", () => {
  const pi = estimateRates([]);

  it("finds a used card that ranked low, one the list did not have, and a confident top entry that went unused", () => {
    const uses = [
      use({
        taskId: "low",
        shown: [entry("skill:a", 1, 0.3), entry("skill:b", 2, 0.2), entry("skill:c", 3, 0.1)],
        used: [{ cardId: "skill:c", onList: true, rank: 3 }],
      }),
      use({
        taskId: "absent",
        shown: [entry("skill:a", 1, 0.3)],
        used: [{ cardId: "skill:z", onList: false }],
      }),
      use({
        taskId: "unused",
        shown: [entry("skill:a", 1, 0.8)],
        used: [{ cardId: "skill:b", onList: true, rank: 2 }],
      }),
    ];
    const m = missesFrom(uses, pi);
    expect(LOW_RANK).toBe(3);
    expect(CONFIDENT).toBe(0.5);
    expect(m.map((x) => [x.taskId, x.kind, x.cardId])).toEqual([
      ["low", "low-rank", "skill:c"],
      ["absent", "absent", "skill:z"],
      ["unused", "top-unused", "skill:a"],
    ]);
    expect(m[0].weight).toBeCloseTo(1 / 0.08, 12);
    expect(m[1].weight).toBeCloseTo(1 / 0.02, 12);
  });

  it("gives nothing for a first-place pick, a second-place pick, a task that was retried, or a private one", () => {
    const uses = [
      use({
        shown: [entry("skill:a", 1, 0.4)],
        used: [{ cardId: "skill:a", onList: true, rank: 1 }],
      }),
      use({
        shown: [entry("skill:a", 1, 0.4), entry("skill:b", 2, 0.3)],
        used: [{ cardId: "skill:b", onList: true, rank: 2 }],
      }),
      use({
        outcome: "retried",
        shown: [entry("skill:a", 1, 0.9)],
        used: [{ cardId: "skill:z", onList: false }],
      }),
      use({
        private: true,
        shown: [entry("skill:a", 1, 0.9)],
        used: [{ cardId: "skill:z", onList: false }],
      }),
    ];
    expect(missesFrom(uses, pi)).toEqual([]);
  });

  it("counts the owner's correction like any finished task", () => {
    const m = missesFrom(
      [use({ outcome: "corrected", used: [{ cardId: "skill:z", onList: false }] })],
      pi,
    );
    expect(m).toHaveLength(1);
  });

  it("groups misses about one card in one way, heaviest first", () => {
    const misses = [
      { kind: "absent" as const, taskId: "1", cardId: "skill:z", weight: 50 },
      { kind: "absent" as const, taskId: "2", cardId: "skill:z", weight: 50 },
      { kind: "low-rank" as const, taskId: "3", cardId: "skill:c", weight: 12.5 },
    ];
    expect(groupMisses(misses)).toEqual([
      { kind: "absent", cardId: "skill:z", taskIds: ["1", "2"], weight: 100 },
      { kind: "low-rank", cardId: "skill:c", taskIds: ["3"], weight: 12.5 },
    ]);
  });

  it("a history where the agent only ever took the first entry produces no misses and no groups, so no card moves", () => {
    const first = Array.from({ length: 500 }, (_, i) =>
      use({
        taskId: `t${i}`,
        shown: [entry("skill:a", 1, 0.9), entry("skill:b", 2, 0.05)],
        used: [{ cardId: "skill:a", onList: true, rank: 1 }],
      }),
    );
    expect(missesFrom(first, estimateRates(first))).toEqual([]);
    expect(groupMisses(missesFrom(first, estimateRates(first)))).toEqual([]);
  });
});

describe("the replay metric", () => {
  const t = (taskId: string, usedCardId: string, weight: number, pinned = false): ReplayTask => ({
    taskId,
    text: taskId,
    usedCardId,
    weight,
    pinned,
  });

  it("is sum w / rank / sum w, and an unlisted card counts zero", () => {
    const ranks: Record<string, number | undefined> = { a: 1, b: 2, c: undefined };
    const tasks = [t("a", "x", 1), t("b", "x", 3), t("c", "x", 4)];
    // (1/1 + 3/2 + 0) / 8 = 0.3125
    expect(wmrr(tasks, (x) => ranks[x.taskId])).toBeCloseTo(0.3125, 12);
    expect(wmrr([], () => 1)).toBe(0);
  });
});

describe("an edit is kept only when the replay says so", () => {
  // Before any edit card a outranks card b for the clause task (three shared words against one).
  const cards = [
    card("skill:a", "sorts photos by date and compare folders with the"),
    card("skill:b", "checks translations against the source text"),
  ];
  const tasks: ReplayTask[] = [
    {
      taskId: "1",
      text: "compare this clause with the definitions",
      usedCardId: "skill:b",
      weight: 20,
      pinned: false,
    },
    {
      taskId: "2",
      text: "sort my holiday photos",
      usedCardId: "skill:a",
      weight: 1.4,
      pinned: false,
    },
  ];
  const better = cards.map((c) =>
    c.id === "skill:b"
      ? { ...c, alsoServed: ["compare a clause with the definitions"], version: 2 }
      : c,
  );

  it("keeps an edit that lifts a heavily weighted used card", () => {
    const v = evaluateEdit({ tasks, before: cards, after: better, rank });
    expect(v).toMatchObject({ keep: true, why: "kept", pinnedLost: [], n: 2 });
    expect(v.after).toBeGreaterThan(v.before);
  });

  it("refuses an edit that gains nothing, and an empty replay set", () => {
    expect(evaluateEdit({ tasks, before: cards, after: cards, rank })).toMatchObject({
      keep: false,
      why: "no-gain",
    });
    expect(evaluateEdit({ tasks: [], before: cards, after: better, rank })).toMatchObject({
      keep: false,
      why: "empty-replay-set",
    });
  });

  it("a pinned case can never lose rank: an edit that raises the mean but drops a pin is refused", () => {
    // Task 2 is pinned (the owner said skill:a fits). The edit makes skill:b outrank skill:a for photo sorting.
    const pinned = tasks.map((x) => (x.taskId === "2" ? { ...x, pinned: true } : x));
    const greedy = cards.map((c) =>
      c.id === "skill:b"
        ? {
            ...c,
            alsoServed: ["compare a clause with the definitions", "sort holiday photos by date"],
            version: 2,
          }
        : c,
    );
    const free = evaluateEdit({ tasks, before: cards, after: greedy, rank });
    const held = evaluateEdit({ tasks: pinned, before: cards, after: greedy, rank });
    expect(free.keep).toBe(true); // without the pin the gain is taken
    expect(held).toMatchObject({ keep: false, why: "pinned-case-lost", pinnedLost: ["2"] });
    expect(held.after).toBeGreaterThan(held.before);
  });

  it("lets a pinned case stay where it is or improve", () => {
    const pinned = tasks.map((x) => (x.taskId === "1" ? { ...x, pinned: true } : x));
    expect(evaluateEdit({ tasks: pinned, before: cards, after: better, rank }).keep).toBe(true);
  });

  it("never keeps an edit that loses any pin, over many random edits (a fuzz of the rule, not one example)", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const words = [
      "photos",
      "clause",
      "translation",
      "invoice",
      "holiday",
      "definitions",
      "date",
      "source",
      "compare",
      "sort",
    ];
    const makeCards = (): EnhancementCard[] =>
      ["a", "b", "c", "d"].map((x) =>
        card(
          `skill:${x}`,
          Array.from({ length: 3 }, () => words[Math.floor(rnd() * words.length)]).join(" "),
        ),
      );
    let kept = 0;
    let refusedForPin = 0;
    for (let i = 0; i < 400; i++) {
      const before = makeCards();
      const after = before.map((c) => ({
        ...c,
        alsoServed:
          rnd() < 0.5
            ? [Array.from({ length: 3 }, () => words[Math.floor(rnd() * words.length)]).join(" ")]
            : [],
      }));
      const replay: ReplayTask[] = Array.from({ length: 6 }, (_, j) => ({
        taskId: `t${j}`,
        text: Array.from({ length: 3 }, () => words[Math.floor(rnd() * words.length)]).join(" "),
        usedCardId: before[Math.floor(rnd() * before.length)].id,
        weight: 1 + Math.floor(rnd() * 20),
        pinned: rnd() < 0.4,
      }));
      const v = evaluateEdit({ tasks: replay, before, after, rank });
      const rankOf = (cs: EnhancementCard[], text: string, id: string) => {
        const i = rank(text, cs).indexOf(id);
        return i < 0 ? Number.POSITIVE_INFINITY : i + 1;
      };
      const lost = replay.some(
        (x) =>
          x.pinned && rankOf(after, x.text, x.usedCardId) > rankOf(before, x.text, x.usedCardId),
      );
      if (lost) {
        expect(v.keep).toBe(false);
        refusedForPin += 1;
      }
      if (v.keep) {
        kept += 1;
        expect(lost).toBe(false);
        expect(v.after).toBeGreaterThan(v.before);
      }
    }
    // The fuzz must exercise both branches, or it proves nothing.
    expect(kept).toBeGreaterThan(10);
    expect(refusedForPin).toBeGreaterThan(10);
  });
});

describe("applyEdit", () => {
  const c = card("skill:a", "sorts photos", {
    structure: "reads a folder",
    alsoServed: ["x"],
    version: 3,
  });

  it("makes the next version, origin nightly, and leaves the old card as it was", () => {
    const next = applyEdit(c, {
      cardId: "skill:a",
      kind: "also-served",
      text: "  groups   scans by date ",
    })!;
    expect(next).toMatchObject({
      version: 4,
      origin: "nightly",
      alsoServed: ["x", "groups scans by date"],
    });
    expect(c.version).toBe(3);
    expect(c.alsoServed).toEqual(["x"]);
    expect(
      applyEdit(c, { cardId: "skill:a", kind: "structure", text: "walks a tree" })!.structure,
    ).toBe("walks a tree");
    expect(
      applyEdit(c, { cardId: "skill:a", kind: "purpose", text: "sorts photos by date only" })!
        .purpose,
    ).toBe("sorts photos by date only");
  });

  it("refuses an empty edit, a long one, one about another card, and one that changes nothing", () => {
    expect(applyEdit(c, { cardId: "skill:a", kind: "structure", text: "   " })).toBeUndefined();
    expect(
      applyEdit(c, { cardId: "skill:a", kind: "structure", text: "x".repeat(MAX_EDIT_CHARS + 1) }),
    ).toBeUndefined();
    expect(applyEdit(c, { cardId: "skill:b", kind: "structure", text: "ok" })).toBeUndefined();
    expect(applyEdit(c, { cardId: "skill:a", kind: "also-served", text: "x" })).toBeUndefined();
    expect(
      applyEdit(c, { cardId: "skill:a", kind: "structure", text: "reads a folder" }),
    ).toBeUndefined();
  });

  it("keeps at most eight lines of alsoServed, the newest", () => {
    let cur = c;
    for (let i = 0; i < 12; i++)
      cur = applyEdit(cur, { cardId: "skill:a", kind: "also-served", text: `line ${i}` })!;
    expect(cur.alsoServed).toHaveLength(8);
    expect(cur.alsoServed[7]).toBe("line 11");
  });
});

describe("calibration from the ledger", () => {
  const u = (shuffled: boolean, prob: number, hit: boolean): UseLike =>
    use({
      shuffled,
      shown: [entry("skill:a", 1, prob)],
      used: hit ? [{ cardId: "skill:a", onList: true, rank: 1 }] : [],
    });

  it("uses all tasks until enough lists were shuffled, then only the shuffled ones", () => {
    const plain = Array.from({ length: 10 }, () => u(false, 0.6, true));
    const shuf = Array.from({ length: 60 }, (_, i) => u(true, 0.6, i % 10 < 6));
    expect(calibrationPairs(plain).fromShuffled).toBe(false);
    const both = calibrationPairs([...plain, ...shuf]);
    expect(both.fromShuffled).toBe(true);
    expect(both.pairs).toHaveLength(60);
  });

  it("refits a monotone map in which 0.6 keeps its meaning: used about six times in ten", () => {
    const uses = Array.from({ length: 100 }, (_, i) => u(true, 0.6, i % 10 < 6));
    const { map, n } = fitCalibrationFrom(uses, 50);
    expect(n).toBe(100);
    for (let i = 1; i < map.length; i++)
      expect(map[i].mapped).toBeGreaterThanOrEqual(map[i - 1].mapped);
    const at = map.find((m) => Math.abs(m.p - 0.6) < 0.06);
    expect(at?.mapped).toBeCloseTo(0.6, 1);
  });

  it("skips tasks that were retried and lists that showed nothing", () => {
    expect(
      calibrationPairs([use({ outcome: "retried", shown: [entry("skill:a", 1, 0.5)] }), use()])
        .pairs,
    ).toEqual([]);
  });
});

describe("proposals for people, never created", () => {
  const pair = (kind: string, n: number): UseLike[] =>
    Array.from({ length: n }, (_, i) =>
      use({
        taskId: `${kind}${i}`,
        taskKind: kind,
        used: [
          { cardId: "skill:a", onList: true, rank: 1 },
          { cardId: "recipe:b", onList: true, rank: 2 },
        ],
      }),
    );

  it("proposes a merge when the same ordered pair is used together three times for one kind of task, not before", () => {
    expect(proposalsFrom(pair("legal", 2))).toEqual([]);
    const p = proposalsFrom(pair("legal", 3));
    expect(p).toEqual([
      {
        kind: "merge",
        key: "merge:legal:skill:a>recipe:b",
        payload: { taskKind: "legal", first: "skill:a", second: "recipe:b", times: 3 },
      },
    ]);
  });

  it("keeps the order: the reverse pair is another pattern, and mixed kinds do not add up", () => {
    const mixed = [...pair("legal", 2), ...pair("coding", 1)];
    expect(proposalsFrom(mixed)).toEqual([]);
  });

  it("proposes a new enhancement for a kind of task done by hand three times while nothing on the list fit", () => {
    const byHand = (n: number, kind: string) =>
      Array.from({ length: n }, (_, i) =>
        use({ taskId: `h${kind}${i}`, taskKind: kind, noneFits: 0.9, used: [] }),
      );
    expect(proposalsFrom(byHand(2, "legal"))).toEqual([]);
    expect(proposalsFrom(byHand(3, "legal"))).toEqual([
      { kind: "new", key: "new:legal", payload: { taskKind: "legal", times: 3 } },
    ]);
    expect(proposalsFrom(byHand(9, "general"))).toEqual([]);
    expect(proposalsFrom(byHand(3, "legal").map((x) => ({ ...x, noneFits: 0.1 })))).toEqual([]);
  });

  it("counts only finished, non-private tasks", () => {
    const uses = pair("legal", 3).map((x, i) => (i === 0 ? { ...x, private: true } : x));
    expect(proposalsFrom(uses)).toEqual([]);
    expect(
      proposalsFrom(pair("legal", 3).map((x) => ({ ...x, outcome: "retried" as const }))),
    ).toEqual([]);
  });
});

describe("the overnight shuffle", () => {
  const list: Shortlist = {
    entries: [
      { cardId: "skill:a", rank: 1, prob: 0.5 },
      { cardId: "skill:b", rank: 2, prob: 0.3 },
      { cardId: "skill:c", rank: 3, prob: 0.1 },
      { cardId: "skill:d", rank: 4, prob: 0.05 },
    ],
    noneFitsProb: 0.05,
    shown: true,
    reason: "shown",
    source: "jev",
  };
  const seeded = (seed: number) => {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  };

  it("is a permutation: the same entries with their probabilities, ranks renumbered from one, the original untouched", () => {
    const out = shuffleList(list, seeded(7));
    expect(out.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(new Set(out.entries.map((e) => e.cardId))).toEqual(
      new Set(list.entries.map((e) => e.cardId)),
    );
    for (const e of out.entries)
      expect(e.prob).toBe(list.entries.find((x) => x.cardId === e.cardId)!.prob);
    expect(list.entries.map((e) => e.cardId)).toEqual(["skill:a", "skill:b", "skill:c", "skill:d"]);
    expect({ ...out, entries: [] }).toEqual({ ...list, entries: [] });
  });

  it("is the same for the same draws, and over many draws every card reaches every rank", () => {
    expect(shuffleList(list, seeded(3))).toEqual(shuffleList(list, seeded(3)));
    const seen = new Set<string>();
    for (let s = 1; s <= 200; s++)
      for (const e of shuffleList(list, seeded(s)).entries) seen.add(`${e.cardId}@${e.rank}`);
    expect(seen.size).toBe(16);
  });

  it("only for overnight work, lists of two or more, never private, only when enabled, and on a small draw", () => {
    const ok = { enabled: true, overnight: true, private: false, entries: 3, rand: 0.1 };
    expect(shouldShuffle(ok)).toBe(true);
    expect(shouldShuffle({ ...ok, enabled: false })).toBe(false);
    expect(shouldShuffle({ ...ok, overnight: false })).toBe(false);
    expect(shouldShuffle({ ...ok, private: true })).toBe(false);
    expect(shouldShuffle({ ...ok, entries: 1 })).toBe(false);
    expect(shouldShuffle({ ...ok, rand: 0.2 })).toBe(false);
    expect(shouldShuffle({ ...ok, rand: 0.4, rate: 0.5 })).toBe(true);
  });
});
