import { describe, expect, it } from "vitest";
import type { JevVerdict } from "../infra/jev/types.js";
import {
  buildEnhancementQuestions,
  buildFitQuestion,
  buildShortlist,
  calibrate,
  cardText,
  CARD_TEXT_CHARS,
  familyOf,
  FAMILY_QUESTION_ID,
  FLAT_MAX_OPTIONS,
  FLAT_QUESTION_ID,
  fitCalibration,
  groupFamilies,
  jointProbabilities,
  localRank,
  localShortlist,
  MAX_CHOICE_OPTIONS,
  MAX_MEMBERS_PER_QUESTION,
  MEMBER_QUESTION_PREFIX,
  NONE_KEY,
  notAsked,
  questionVersionOf,
  seedCards,
  withFits,
  type EnhancementCard,
  type EnhancementListing,
  type EnhancementTemplate,
} from "./thalamus-enhancements.js";
import { NOW } from "./thalamus-v4.test-support.js";

const template: EnhancementTemplate = {
  familyInstructions: "family-instructions",
  memberInstructions: "member-instructions",
  fitInstructions: "fit-instructions {card}",
  familyNoneText: "no family",
  memberNoneText: "none here",
  fitOptions: { "made-for": "a", "by-structure": "b", "covers-part": "c" },
};

const listing = (
  name: string,
  description = "",
  kind: EnhancementListing["kind"] = "skill",
  triggers?: string[],
) => ({
  kind,
  name,
  description,
  triggers,
});

const verdict = (
  questionId: string,
  probs: Record<string, number>,
  confidence = 0.9,
  extra: Partial<JevVerdict> = {},
): JevVerdict => {
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  return {
    id: `v-${questionId}`,
    situationId: "s",
    questionId,
    questionVersion: 1,
    type: "choice",
    answer: top,
    prob: probs[top],
    probs,
    confidence,
    cacheHit: false,
    latencyMs: 90,
    tokensIn: 100,
    tokensOut: 0,
    costUsd: 0,
    ts: NOW,
    ...extra,
  };
};

describe("cards", () => {
  it("seeds version-1 cards with a family, the purpose from description and triggers, and an empty structure", () => {
    const [c] = seedCards([
      listing("pdf-tools", "Extract text from a PDF.", "skill", ["extract pdf", "ocr"]),
    ]);
    expect(c).toMatchObject({
      id: "skill:pdf-tools",
      kind: "skill",
      family: "documents",
      version: 1,
      status: "active",
      origin: "seed",
      structure: "",
      alsoServed: [],
    });
    expect(c.purpose).toBe("Extract text from a PDF. Triggers: extract pdf; ocr");
  });

  it("carries a structure line and a path when the listing has them", () => {
    const [c] = seedCards([
      {
        kind: "recipe",
        name: "loop",
        path: "/r/loop.md",
        description: "x",
        structure: "repeat until match",
      },
    ]);
    expect(c.structure).toBe("repeat until match");
    expect(c.path).toBe("/r/loop.md");
  });

  it("keeps the first of a duplicated listing, skips an empty name, and names by kind", () => {
    const cards = seedCards([
      listing("a", "one"),
      listing("a", "two"),
      listing(" ", "blank"),
      listing("a", "recipe copy", "recipe"),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["skill:a", "recipe:a"]);
    expect(cards[0].purpose).toBe("one");
  });

  it("falls back to the name when there is no description, and to 'other' when no rule matches", () => {
    const [c] = seedCards([listing("zzz")]);
    expect(c.purpose).toBe("zzz");
    expect(c.family).toBe("other");
  });

  it("assigns families by keyword", () => {
    expect(familyOf(listing("gmail-helper", "Draft replies in Gmail"))).toBe("messages");
    expect(familyOf(listing("amazon-shopper", "Best price on Amazon"))).toBe("shopping");
    expect(familyOf(listing("gateway-restart", "Restart the gateway"))).toBe("operations");
  });

  it("bounds the text Jev reads and adds structure and learned lines", () => {
    const [c] = seedCards([listing("x", "y".repeat(1000))]);
    expect(cardText(c).length).toBeLessThanOrEqual(CARD_TEXT_CHARS);
    const rich: EnhancementCard = { ...c, purpose: "P", structure: "S", alsoServed: ["A", "B"] };
    expect(cardText(rich)).toBe("P Works by: S Also served: A; B");
  });
});

const bigRegistry = (n: number, families: string[]): EnhancementCard[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `skill:e${i}`,
    kind: "skill" as const,
    name: `e${i}`,
    family: families[i % families.length],
    purpose: `purpose ${i}`,
    structure: "",
    alsoServed: [],
    version: 1,
    status: "active" as const,
    origin: "seed" as const,
  }));

describe("families and the 255-option limit", () => {
  it("fits a registry of 300 enhancements over six families into legal questions", () => {
    const cards = bigRegistry(300, [
      "coding",
      "writing",
      "messages",
      "documents",
      "shopping",
      "media",
    ]);
    const g = groupFamilies(cards);
    expect(g.families).toHaveLength(6);
    expect(g.spilled).toEqual([]);
    const { questions } = buildEnhancementQuestions(
      g,
      new Map(cards.map((c) => [c.id, c])),
      template,
    );
    expect(questions).toHaveLength(7);
    for (const q of questions) {
      expect(Object.keys(q.criteria as object).length, q.id).toBeLessThanOrEqual(
        MAX_CHOICE_OPTIONS,
      );
    }
  });

  it("asks ONE flat question over every card when the registry and 'none' fit, 210 cards included", () => {
    const cards = bigRegistry(210, [
      "coding",
      "writing",
      "messages",
      "documents",
      "shopping",
      "media",
    ]);
    const built = buildEnhancementQuestions(
      groupFamilies(cards),
      new Map(cards.map((c) => [c.id, c])),
      template,
    );
    expect(built.flat).toBe(true);
    expect(built.questions.map((q) => q.id)).toEqual([FLAT_QUESTION_ID]);
    const options = Object.keys(built.questions[0].criteria as object);
    expect(options).toHaveLength(211);
    expect(options).toContain(NONE_KEY);
    expect(options.length).toBeLessThanOrEqual(FLAT_MAX_OPTIONS);
    expect(built.questions[0].instructions).toBe("member-instructions");
    expect((built.questions[0].criteria as Record<string, string>)["skill:e209"]).toBe(
      "purpose 209",
    );
    expect((built.questions[0].criteria as Record<string, string>)[NONE_KEY]).toBe("none here");
  });

  it("keeps a margin under 255: 249 cards are flat, 250 go to families", () => {
    const run = (n: number) => {
      const cards = bigRegistry(n, ["a", "b", "c"]);
      return buildEnhancementQuestions(
        groupFamilies(cards),
        new Map(cards.map((c) => [c.id, c])),
        template,
      );
    };
    expect(FLAT_MAX_OPTIONS).toBeLessThan(MAX_CHOICE_OPTIONS);
    expect(run(FLAT_MAX_OPTIONS - 1).flat).toBe(true);
    expect(run(FLAT_MAX_OPTIONS).flat).toBe(false);
    expect(run(FLAT_MAX_OPTIONS).questions[0].id).toBe(FAMILY_QUESTION_ID);
  });

  it("uses families above the limit: 300 cards ask the family question, not the flat one", () => {
    const cards = bigRegistry(300, [
      "coding",
      "writing",
      "messages",
      "documents",
      "shopping",
      "media",
    ]);
    const built = buildEnhancementQuestions(
      groupFamilies(cards),
      new Map(cards.map((c) => [c.id, c])),
      template,
    );
    expect(built.flat).toBe(false);
    expect(built.questions.map((q) => q.id)).toContain(FAMILY_QUESTION_ID);
    expect(built.questions.map((q) => q.id)).not.toContain(FLAT_QUESTION_ID);
  });

  it("gives the flat question a version that changes with a card and not otherwise", () => {
    const cards = bigRegistry(20, ["a", "b"]);
    const build = (cs: EnhancementCard[]) =>
      buildEnhancementQuestions(groupFamilies(cs), new Map(cs.map((c) => [c.id, c])), template);
    expect(build(cards).version).toBe(build(cards).version);
    expect(
      build(cards.map((c, i) => (i === 3 ? { ...c, alsoServed: ["new"] } : c))).version,
    ).not.toBe(build(cards).version);
  });

  it("splits a family of 600 into three parts of at most 254", () => {
    const g = groupFamilies(bigRegistry(600, ["coding"]));
    expect(g.families.map((f) => f.id)).toEqual(["coding-p1", "coding-p2", "coding-p3"]);
    expect(g.families.map((f) => f.memberIds.length)).toEqual([254, 254, 92]);
    expect(Math.max(...g.families.map((f) => f.memberIds.length))).toBeLessThanOrEqual(
      MAX_MEMBERS_PER_QUESTION,
    );
  });

  it("leaves the smallest families to local matching when there are more than 254 of them", () => {
    const cards = bigRegistry(
      300,
      Array.from({ length: 300 }, (_, i) => `fam${String(i).padStart(3, "0")}`),
    );
    // Give the first ten families two members each so the tail is the one that spills.
    for (let i = 0; i < 10; i++)
      cards[i + 100] = { ...cards[i + 100], family: `fam${String(i).padStart(3, "0")}` };
    const g = groupFamilies(cards);
    expect(g.families).toHaveLength(MAX_MEMBERS_PER_QUESTION);
    // Moving ten cards leaves 290 families; 254 are kept and the 36 smallest (one card each) spill.
    expect(g.spilled).toHaveLength(36);
    const { questions } = buildEnhancementQuestions(
      g,
      new Map(cards.map((c) => [c.id, c])),
      template,
    );
    expect(Object.keys(questions[0].criteria as object).length).toBeLessThanOrEqual(
      MAX_CHOICE_OPTIONS,
    );
    // The families that kept two members are not the ones that spilled.
    const kept = new Set(g.families.map((f) => f.id));
    for (let i = 0; i < 10; i++) expect(kept.has(`fam${String(i).padStart(3, "0")}`)).toBe(true);
  });

  it("ignores retired cards", () => {
    const cards = bigRegistry(4, ["coding"]);
    cards[1] = { ...cards[1], status: "retired" };
    expect(groupFamilies(cards).families[0].memberIds).toHaveLength(3);
  });

  it("builds the questions: a family question, one within-family question each, 'none' in every one", () => {
    const cards = bigRegistry(6, ["coding", "writing"]);
    const g = groupFamilies(cards, (f) => `family ${f}`);
    const { questions, families } = buildEnhancementQuestions(
      g,
      new Map(cards.map((c) => [c.id, c])),
      template,
      { flatMaxOptions: 0 },
    );
    expect(questions.map((q) => q.id)).toEqual([
      FAMILY_QUESTION_ID,
      `${MEMBER_QUESTION_PREFIX}coding`,
      `${MEMBER_QUESTION_PREFIX}writing`,
    ]);
    expect(families).toHaveLength(2);
    expect(Object.keys(questions[0].criteria as object)).toEqual([NONE_KEY, "coding", "writing"]);
    expect((questions[1].criteria as Record<string, string>)[NONE_KEY]).toBe("none here");
    expect((questions[1].criteria as Record<string, string>)["skill:e0"]).toBe("purpose 0");
    for (const q of questions) {
      expect(q.type).toBe("choice");
      expect(q.fields).toEqual(["request"]);
    }
  });

  it("gives a new version when a card changes and the same version when nothing does", () => {
    const cards = bigRegistry(6, ["coding", "writing"]);
    const build = (cs: EnhancementCard[]) =>
      buildEnhancementQuestions(groupFamilies(cs), new Map(cs.map((c) => [c.id, c])), template, {
        flatMaxOptions: 0,
      });
    const a = build(cards);
    const b = build(cards);
    expect(b.version).toBe(a.version);
    const changed = cards.map((c, i) => (i === 0 ? { ...c, alsoServed: ["something new"] } : c));
    const c = build(changed);
    expect(c.version).not.toBe(a.version);
    expect(c.questions[1].version).not.toBe(a.questions[1].version);
    expect(c.questions[2].version).toBe(a.questions[2].version);
  });

  it("builds a fit question for one entry with the card text in the instructions", () => {
    const [card] = bigRegistry(1, ["coding"]);
    const q = buildFitQuestion(card, 2, template);
    expect(q.id).toBe("enh-fit-2");
    expect(q.instructions).toBe("fit-instructions purpose 0");
    expect(Object.keys(q.criteria as object)).toEqual(["made-for", "by-structure", "covers-part"]);
  });

  it("hashes to a positive integer that depends on both the options and the instructions", () => {
    const a = questionVersionOf({ x: "1" }, "i");
    expect(a).toBeGreaterThan(0);
    expect(questionVersionOf({ x: "2" }, "i")).not.toBe(a);
    expect(questionVersionOf({ x: "1" }, "j")).not.toBe(a);
    expect(questionVersionOf({ x: "1" }, "i")).toBe(a);
  });
});

describe("joint probabilities", () => {
  const cards = bigRegistry(4, ["coding", "writing"]); // coding: e0,e2  writing: e1,e3
  const families = groupFamilies(cards).families;

  const set = (over: JevVerdict[] = []) => [
    verdict(FAMILY_QUESTION_ID, { coding: 0.6, writing: 0.3, [NONE_KEY]: 0.1 }),
    verdict(`${MEMBER_QUESTION_PREFIX}coding`, {
      "skill:e0": 0.7,
      "skill:e2": 0.2,
      [NONE_KEY]: 0.1,
    }),
    verdict(`${MEMBER_QUESTION_PREFIX}writing`, {
      "skill:e1": 0.5,
      "skill:e3": 0.25,
      [NONE_KEY]: 0.25,
    }),
    ...over,
  ];

  it("multiplies the family answer by the within-family answer", () => {
    const j = jointProbabilities(set(), families);
    expect(j.probs.get("skill:e0")).toBeCloseTo(0.42, 10);
    expect(j.probs.get("skill:e2")).toBeCloseTo(0.12, 10);
    expect(j.probs.get("skill:e1")).toBeCloseTo(0.15, 10);
    expect(j.probs.get("skill:e3")).toBeCloseTo(0.075, 10);
    expect(j.complete).toBe(true);
  });

  it("sums a card's mass over every family that lists it (the marginal)", () => {
    const shared = [
      { id: "a", memberIds: ["skill:x", "skill:y"] },
      { id: "b", memberIds: ["skill:x"] },
    ] as unknown as typeof families;
    const j = jointProbabilities(
      [
        verdict(FAMILY_QUESTION_ID, { a: 0.5, b: 0.4, [NONE_KEY]: 0.1 }),
        verdict(`${MEMBER_QUESTION_PREFIX}a`, { "skill:x": 0.6, "skill:y": 0.2, [NONE_KEY]: 0.2 }),
        verdict(`${MEMBER_QUESTION_PREFIX}b`, { "skill:x": 0.5, [NONE_KEY]: 0.5 }),
      ],
      shared,
    );
    expect(j.probs.get("skill:x")).toBeCloseTo(0.5 * 0.6 + 0.4 * 0.5, 10);
    expect(j.probs.get("skill:y")).toBeCloseTo(0.1, 10);
  });

  it("reads a flat answer as the ranking itself: card probabilities and the 'none' mass", () => {
    const j = jointProbabilities(
      [verdict(FLAT_QUESTION_ID, { "skill:e0": 0.5, "skill:e1": 0.3, [NONE_KEY]: 0.2 }, 0.4)],
      [],
    );
    expect(j.complete).toBe(true);
    expect(j.noneFits).toBeCloseTo(0.2, 10);
    expect([...j.probs]).toEqual([
      ["skill:e0", 0.5],
      ["skill:e1", 0.3],
    ]);
    expect(j.confidence).toBeCloseTo(0.4, 10);
  });

  it("treats a skipped flat answer as no answer, and drops a card id nobody listed", () => {
    const skipped = jointProbabilities(
      [{ ...verdict(FLAT_QUESTION_ID, { "skill:e0": 1 }), skipped: "timeout" }],
      [],
    );
    expect(skipped).toMatchObject({ complete: false, noneFits: 1 });
    expect(skipped.probs.size).toBe(0);
    const listed = [{ id: "all", purpose: "", memberIds: ["skill:e0"] }];
    const j = jointProbabilities(
      [verdict(FLAT_QUESTION_ID, { "skill:e0": 0.6, "skill:ghost": 0.3, [NONE_KEY]: 0.1 })],
      listed,
    );
    expect([...j.probs.keys()]).toEqual(["skill:e0"]);
  });

  it("builds the list by the 80% share from a flat ranking, and lets 'none fits' lead", () => {
    const flat = jointProbabilities(
      [
        verdict(FLAT_QUESTION_ID, {
          "skill:a": 0.45,
          "skill:b": 0.25,
          "skill:c": 0.15,
          "skill:d": 0.1,
          [NONE_KEY]: 0.05,
        }),
      ],
      [],
    );
    const list = buildShortlist(flat);
    expect(list.entries.map((e) => e.cardId)).toEqual(["skill:a", "skill:b", "skill:c"]);
    expect(list.shown).toBe(true);
    const none = buildShortlist(
      jointProbabilities([verdict(FLAT_QUESTION_ID, { "skill:a": 0.3, [NONE_KEY]: 0.7 })], []),
    );
    expect(none.shown).toBe(false);
    expect(none.reason).toBe("none-leads");
  });

  it("sums to one with the 'none' mass", () => {
    const j = jointProbabilities(set(), families);
    const total = [...j.probs.values()].reduce((s, p) => s + p, 0) + j.noneFits;
    expect(total).toBeCloseTo(1, 9);
    expect(j.noneFits).toBeCloseTo(0.1 + 0.6 * 0.1 + 0.3 * 0.25, 10);
  });

  it("takes the lowest confidence among the verdicts used", () => {
    const vs = set();
    vs[2] = verdict(
      `${MEMBER_QUESTION_PREFIX}writing`,
      { "skill:e1": 0.5, "skill:e3": 0.25, [NONE_KEY]: 0.25 },
      0.4,
    );
    expect(jointProbabilities(vs, families).confidence).toBeCloseTo(0.4, 10);
  });

  it("puts a family with no answer into 'none fits', never into a card", () => {
    const vs = set().filter((v) => v.questionId !== `${MEMBER_QUESTION_PREFIX}writing`);
    const j = jointProbabilities(vs, families);
    expect(j.complete).toBe(false);
    expect(j.probs.has("skill:e1")).toBe(false);
    expect(j.noneFits).toBeCloseTo(0.1 + 0.06 + 0.3, 10);
    expect([...j.probs.values()].reduce((s, p) => s + p, 0) + j.noneFits).toBeCloseTo(1, 9);
  });

  it("treats a skipped verdict as no answer", () => {
    const vs = set();
    vs[1] = { ...vs[1], skipped: "timeout" };
    const j = jointProbabilities(vs, families);
    expect(j.complete).toBe(false);
    expect(j.probs.has("skill:e0")).toBe(false);
  });

  it("gives an all-none result when the family question was not answered", () => {
    const j = jointProbabilities([], families);
    expect(j).toMatchObject({ noneFits: 1, complete: false, confidence: 0 });
    expect(j.probs.size).toBe(0);
    expect(jointProbabilities([{ ...set()[0], skipped: "error" }], families).noneFits).toBe(1);
  });

  it("normalises probabilities that do not sum to one and ignores negatives", () => {
    const vs = [
      verdict(FAMILY_QUESTION_ID, { coding: 3, [NONE_KEY]: 1, writing: -5 }),
      verdict(`${MEMBER_QUESTION_PREFIX}coding`, { "skill:e0": 1, [NONE_KEY]: 1 }),
    ];
    const j = jointProbabilities(vs, families);
    expect(j.probs.get("skill:e0")).toBeCloseTo(0.75 * 0.5, 10);
    expect([...j.probs.values()].reduce((s, p) => s + p, 0) + j.noneFits).toBeCloseTo(1, 9);
  });
});

describe("the short list", () => {
  const mk = (probs: Record<string, number>, noneFits: number) => ({
    probs: new Map(Object.entries(probs)),
    noneFits,
  });

  it("takes the shortest run of entries that holds 80 per cent", () => {
    const l = buildShortlist(mk({ a: 0.5, b: 0.2, c: 0.12, d: 0.05, e: 0.03 }, 0.1));
    expect(l.entries.map((e) => e.cardId)).toEqual(["a", "b", "c"]);
    expect(l.shown).toBe(true);
    expect(l.reason).toBe("shown");
    expect(l.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(l.entries[0].prob).toBeCloseTo(0.5, 10);
    expect(l.noneFitsProb).toBeCloseTo(0.1, 10);
  });

  it("stops at one entry that holds 80 per cent alone", () => {
    expect(buildShortlist(mk({ a: 0.85, b: 0.05 }, 0.1)).entries).toHaveLength(1);
  });

  it("never lists more than six", () => {
    // Twelve near-equal entries and a small "none": 80 per cent would take eleven, so the cap decides.
    const probs = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`e${i}`, 0.95 / 12]));
    const l = buildShortlist(mk(probs, 0.05));
    expect(l.entries).toHaveLength(6);
    expect(l.shown).toBe(true);
  });

  it("does not show a list when 'none of these fits' leads", () => {
    const l = buildShortlist(mk({ a: 0.3, b: 0.2 }, 0.5));
    expect(l).toMatchObject({ entries: [], shown: false, reason: "none-leads" });
    expect(l.noneFitsProb).toBeCloseTo(0.5, 10);
  });

  it("treats a tie with 'none' as none leading", () => {
    expect(buildShortlist(mk({ a: 0.5 }, 0.5)).reason).toBe("none-leads");
  });

  it("cuts the list where 'none of these fits' appears", () => {
    const l = buildShortlist(mk({ a: 0.4, b: 0.1 }, 0.3), { share: 0.95 });
    expect(l.entries.map((e) => e.cardId)).toEqual(["a"]);
    expect(l.shown).toBe(true);
  });

  it("is empty when there is nothing to rank", () => {
    expect(buildShortlist(mk({}, 1)).reason).toBe("empty");
    expect(buildShortlist(mk({}, 0)).shown).toBe(false);
  });

  it("orders ties the same way every time", () => {
    const a = buildShortlist(mk({ b: 0.3, a: 0.3, c: 0.1 }, 0.1), { share: 1 });
    const b = buildShortlist(mk({ c: 0.1, a: 0.3, b: 0.3 }, 0.1), { share: 1 });
    expect(a.entries.map((e) => e.cardId)).toEqual(b.entries.map((e) => e.cardId));
    expect(a.entries[0].cardId).toBe("a");
  });

  it("passes the probabilities through the calibration map", () => {
    const map = [
      { p: 0.2, mapped: 0.1 },
      { p: 0.8, mapped: 0.6 },
    ];
    const l = buildShortlist(mk({ a: 0.8, b: 0.1 }, 0.1), { calibration: map });
    expect(l.entries[0].prob).toBeCloseTo(0.6, 10);
  });

  it("marks a local list as local", () => {
    expect(buildShortlist(mk({ a: 0.9 }, 0.1), { source: "local" }).source).toBe("local");
    expect(notAsked()).toMatchObject({ shown: false, reason: "not-asked", entries: [] });
  });

  it("says the top two fit together only when both cover part", () => {
    const list = buildShortlist(mk({ a: 0.4, b: 0.35, c: 0.1 }, 0.15), { share: 0.99 });
    const fit = (v: "made-for" | "by-structure" | "covers-part") => ({
      value: v,
      conf: 0.9,
      source: "jev" as const,
    });
    const both = withFits(
      list,
      new Map([
        ["a", fit("covers-part")],
        ["b", fit("covers-part")],
      ]),
    );
    expect(both.together).toEqual(["a", "b"]);
    expect(both.entries[0].fit?.value).toBe("covers-part");
    const one = withFits(
      list,
      new Map([
        ["a", fit("made-for")],
        ["b", fit("covers-part")],
      ]),
    );
    expect(one.together).toBeUndefined();
    expect(withFits(list, new Map()).together).toBeUndefined();
  });
});

describe("calibration", () => {
  it("is the identity with no map, and clamps its input", () => {
    expect(calibrate(0.37, undefined)).toBe(0.37);
    expect(calibrate(0.37, [])).toBe(0.37);
    expect(calibrate(2, [])).toBe(1);
    expect(calibrate(-1, [])).toBe(0);
  });

  it("interpolates between points and holds the ends", () => {
    const map = [
      { p: 0.2, mapped: 0.1 },
      { p: 0.6, mapped: 0.5 },
    ];
    expect(calibrate(0.4, map)).toBeCloseTo(0.3, 10);
    expect(calibrate(0.05, map)).toBe(0.1);
    expect(calibrate(0.99, map)).toBe(0.5);
  });

  it("fits a monotone map: 0.6 keeps its meaning", () => {
    // Jev says 0.6 and the enhancement is used six times in ten.
    const pairs = Array.from({ length: 100 }, (_, i) => ({ p: 0.6, hit: i < 60 }));
    const map = fitCalibration(pairs);
    expect(calibrate(0.6, map)).toBeCloseTo(0.6, 10);
  });

  it("never decreases, even when the data does", () => {
    const pairs = [
      ...Array.from({ length: 50 }, (_, i) => ({ p: 0.15, hit: i < 30 })), // 0.6 hit at low p
      ...Array.from({ length: 50 }, (_, i) => ({ p: 0.85, hit: i < 10 })), // 0.2 hit at high p
    ];
    const map = fitCalibration(pairs);
    for (let i = 1; i < map.length; i++)
      expect(map[i].mapped).toBeGreaterThanOrEqual(map[i - 1].mapped);
    for (let p = 0; p <= 1; p += 0.05)
      expect(calibrate(p, map)).toBeGreaterThanOrEqual(
        calibrate(Math.max(0, p - 0.05), map) - 1e-12,
      );
  });

  it("returns an empty map for no data", () => {
    expect(fitCalibration([])).toEqual([]);
  });
});

describe("local matching does not pad a weak list", () => {
  const many = seedCards(
    Array.from({ length: 200 }, (_, i) => ({
      kind: "skill" as const,
      name: `skill-${i}`,
      description: `Handles topic${i} things and runs the file step for topic${i}.`,
    })),
  );

  it("shows nothing when only generic words match many cards", () => {
    // "run the file" matches the shared words of every card and none of their own.
    const l = localShortlist("please run the file", many);
    expect(l.shown).toBe(false);
  });

  it("lists one clear match alone, and leads with it", () => {
    const l = localShortlist("please do the topic7 things", many);
    expect(l.shown).toBe(true);
    expect(l.entries.map((e) => e.cardId)).toEqual(["skill:skill-7"]);
    expect(l.entries[0].prob).toBeGreaterThan(0.7);
  });

  it("never returns a flat run of low-probability entries", () => {
    for (const q of ["run the file step", "things", "handles the file", "topic files runs"]) {
      const l = localShortlist(q, many);
      if (l.shown) expect(l.entries[0].prob, q).toBeGreaterThan(0.3);
    }
  });
});

describe("local matching wants more than one shared word", () => {
  const some = seedCards([
    { kind: "skill", name: "clock", description: "Tells the current time in any city." },
    { kind: "skill", name: "photos", description: "Sorts photos by date." },
  ]);

  it("does not list a card for a single shared word", () => {
    expect(localShortlist("what time is it", some).shown).toBe(false);
    expect(localRank("what time is it", some)[0]).toMatchObject({
      cardId: "skill:clock",
      overlap: 1,
    });
  });

  it("lists it when two words are shared, even in a registry of two", () => {
    const l = localShortlist("tell me the current time in Paris", some);
    expect(l.shown).toBe(true);
    expect(l.entries[0].cardId).toBe("skill:clock");
  });

  it('does not let question words make a match: "what" and "when" are not topics', () => {
    const chatty = seedCards([
      {
        kind: "skill",
        name: "guesser",
        description: "Stop guessing what it costs and when it runs, in real time.",
      },
    ]);
    expect(localShortlist("what time is it", chatty).shown).toBe(false);
    expect(localRank("what when where why", chatty)).toEqual([]);
  });

  it("counts distinct words, not repeats", () => {
    expect(localRank("time time time time", some)[0].overlap).toBe(1);
  });
});

describe("local matching", () => {
  const cards = seedCards([
    listing(
      "translation-checker",
      "Compares a translation with its source and repeats until they match.",
    ),
    listing("photo-sorter", "Shows one photo at a time and records a keep or delete decision."),
    listing("gateway-restart", "Restarts the gateway and checks the chats continue."),
  ]);

  it("ranks the obvious card first", () => {
    const r = localRank("please compare my translation with the source text", cards);
    expect(r[0].cardId).toBe("skill:translation-checker");
    expect(r.every((x, i) => i === 0 || r[i - 1].score >= x.score)).toBe(true);
  });

  it("finds nothing for a request with no usable words", () => {
    expect(localRank("a an the", cards)).toEqual([]);
    expect(localRank("anything", [])).toEqual([]);
  });

  it("ignores retired cards", () => {
    const retired = cards.map((c) =>
      c.name === "translation-checker" ? { ...c, status: "retired" as const } : c,
    );
    expect(
      localRank("compare translation with source", retired).map((r) => r.cardId),
    ).not.toContain("skill:translation-checker");
  });

  it("shows a strong match as a local list and shows nothing for a weak one", () => {
    const strong = localShortlist(
      "compare my translation with the source text and repeat until they match",
      cards,
    );
    expect(strong).toMatchObject({ shown: true, source: "local" });
    expect(strong.entries[0].cardId).toBe("skill:translation-checker");
    const weak = localShortlist("what is the weather", cards);
    expect(weak.shown).toBe(false);
  });
});
