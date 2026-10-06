import { describe, expect, it } from "vitest";
import type { JevVerdict } from "../infra/jev/types.js";
import {
  buildRankQuestions,
  interpretRanking,
  localRanking,
  FLAT_RANK_QUESTION_ID,
  MAX_SECTIONS,
  rankedList,
  rankItems,
  type RankItem,
} from "./enhancement-rank.js";
import type { Candidate, RecallDoc } from "./enhancement-recall.js";

const item = (id: string, sections: string[] = [], recallSection?: string): RankItem => ({
  cardId: id,
  kind: "recipe",
  text: `${id} text`,
  sections,
  ...(recallSection ? { recallSection } : {}),
});

const verdict = (
  questionId: string,
  answer: string,
  probs: Record<string, number> = {},
  over: Partial<JevVerdict> = {},
): JevVerdict => ({
  id: `v-${questionId}`,
  situationId: "s",
  questionId,
  questionVersion: 1,
  type: "choice",
  answer,
  prob: probs[answer] ?? 0.9,
  confidence: 0.9,
  ...(Object.keys(probs).length ? { probs } : {}),
  cacheHit: false,
  latencyMs: 400,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  ts: 0,
  ...over,
});

const skipped = (questionId: string, why: NonNullable<JevVerdict["skipped"]>): JevVerdict =>
  verdict(questionId, "", {}, { skipped: why, prob: 0, confidence: 0 });

describe("buildRankQuestions", () => {
  it("asks one mode question per item and a part question only for items that have sections", () => {
    const items = [item("recipe:a", ["Pick dates", "Book"]), item("recipe:b")];
    const built = buildRankQuestions(items);
    expect(built.questions.map((q) => q.id)).toEqual([
      "rank-mode-1",
      "rank-part-1",
      "rank-mode-2",
      "rank-flat",
    ]);
    expect(built.byItem[1].part).toBeUndefined();
  });

  it("adds one comparative question: the candidates c1..cN and none, so they compete for one answer", () => {
    const built = buildRankQuestions([item("recipe:a"), item("recipe:b"), item("recipe:c")]);
    const flat = built.questions.find((q) => q.id === FLAT_RANK_QUESTION_ID)!;
    expect(Object.keys(flat.criteria as object)).toEqual(["c1", "c2", "c3", "none"]);
    expect((flat.criteria as Record<string, string>).c2).toBe("recipe:b text");
    expect(flat.type).toBe("choice");
  });

  it("asks no comparative question for an empty list", () => {
    expect(buildRankQuestions([]).questions).toEqual([]);
  });

  it("offers the real section titles under s1..sN plus none, and USE / INSPIRE / NO for the mode", () => {
    const built = buildRankQuestions([item("recipe:a", ["Pick dates", "Book"])]);
    const [mode, part] = built.questions;
    expect(Object.keys(mode.criteria as object)).toEqual(["USE", "INSPIRE", "NO"]);
    expect(part.criteria).toEqual({
      s1: "Pick dates",
      s2: "Book",
      none: expect.any(String),
    });
    expect(mode.type).toBe("choice");
    expect(mode.fields).toEqual(["request"]);
  });

  it("puts the card's own text in the instructions so the answer is about that card", () => {
    const built = buildRankQuestions([item("recipe:a", ["x"])]);
    expect(built.questions[0].instructions).toContain("recipe:a text");
    expect(built.questions[1].instructions).toContain("recipe:a text");
  });

  it("question ids are unique and kebab-case for fifteen items", () => {
    const items = Array.from({ length: 15 }, (_, i) => item(`recipe:r${i}`, ["a", "b"]));
    const ids = buildRankQuestions(items).questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(31);
    expect(ids.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
  });
});

describe("rankItems", () => {
  const doc = (id: string, sections: string[]): RecallDoc => ({
    id,
    kind: "recipe",
    slug: id.split(":")[1],
    title: `Title ${id}`,
    summary: "does a thing",
    tags: [],
    sections,
    composes: [],
  });
  const docs = new Map([
    [
      "recipe:a",
      doc(
        "recipe:a",
        Array.from({ length: 12 }, (_, i) => `Part ${i}`),
      ),
    ],
    ["recipe:b", doc("recipe:b", ["One", "One", " Two "])],
  ]);

  it("bounds the sections and keeps duplicates out", () => {
    const [a, b] = rankItems(
      [
        { cardId: "recipe:a", score: 1, via: ["text"] },
        { cardId: "recipe:b", score: 1, via: ["text"] },
      ] satisfies Candidate[],
      docs,
    );
    expect(a.sections).toHaveLength(MAX_SECTIONS);
    expect(b.sections).toEqual(["One", "Two"]);
  });

  it("keeps the section recall matched on, even past the bound", () => {
    const [a] = rankItems(
      [{ cardId: "recipe:a", score: 1, via: ["text"], section: "Part 11" }],
      docs,
    );
    expect(a.sections[0]).toBe("Part 11");
    expect(a.recallSection).toBe("Part 11");
    expect(a.sections).toHaveLength(MAX_SECTIONS);
  });

  it("skips a candidate the catalogue does not hold and caps at fifteen", () => {
    const many: Candidate[] = Array.from({ length: 20 }, () => ({
      cardId: "recipe:b",
      score: 1,
      via: ["text"],
    }));
    expect(rankItems([{ cardId: "recipe:zzz", score: 1, via: ["text"] }], docs)).toEqual([]);
    expect(rankItems(many, docs)).toHaveLength(15);
  });
});

describe("interpretRanking: ordering", () => {
  const items = [
    item("recipe:a", ["A1", "A2"]),
    item("recipe:b", ["B1"]),
    item("recipe:c"),
    item("recipe:d", ["D1"]),
  ];
  const built = buildRankQuestions(items);

  it("sorts each group by the probability Jev gave the mode and splits USE from INSPIRE", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "USE", { USE: 0.55, INSPIRE: 0.3, NO: 0.15 }),
      verdict("rank-mode-2", "INSPIRE", { USE: 0.1, INSPIRE: 0.8, NO: 0.1 }),
      verdict("rank-part-2", "s1"),
      verdict("rank-mode-3", "USE", { USE: 0.9, INSPIRE: 0.05, NO: 0.05 }),
      verdict("rank-mode-4", "INSPIRE", { USE: 0.1, INSPIRE: 0.6, NO: 0.3 }),
      verdict("rank-part-4", "s1"),
    ]);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:c", "recipe:a"]);
    expect(r.inspire.map((e) => e.cardId)).toEqual(["recipe:b", "recipe:d"]);
    expect(r.source).toBe("jev");
    expect(r.skip).toBeUndefined();
    expect(r.use.every((e) => e.source === "jev")).toBe(true);
    expect(r.answered).toBe(4);
  });

  it("names the section Jev picked, by its real title", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "INSPIRE", { INSPIRE: 0.7 }),
      verdict("rank-part-1", "s2"),
      verdict("rank-mode-2", "NO"),
      verdict("rank-mode-3", "NO"),
      verdict("rank-mode-4", "NO"),
    ]);
    expect(r.inspire[0]).toMatchObject({ cardId: "recipe:a", section: "A2", sectionSource: "jev" });
  });

  it("drops a candidate Jev answers NO and counts it", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "USE", { USE: 0.8 }),
      verdict("rank-mode-2", "NO"),
      verdict("rank-mode-3", "NO"),
      verdict("rank-mode-4", "NO"),
    ]);
    expect(rankedList(r).map((e) => e.cardId)).toEqual(["recipe:a"]);
    expect(r.dropped).toBe(3);
  });

  it("puts entries Jev did not answer after the ones it did, in recall order, labelled local", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-3", "USE", { USE: 0.4 }),
      // 1, 2, 4: no answer at all
    ]);
    expect(r.use.map((e) => [e.cardId, e.source])).toEqual([
      ["recipe:c", "jev"],
      ["recipe:a", "local"],
      ["recipe:b", "local"],
      ["recipe:d", "local"],
    ]);
    expect(r.source).toBe("mixed");
    expect(r.skip).toBe("invalid");
  });

  it("breaks a tie by recall order", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "USE", { USE: 0.5 }),
      verdict("rank-mode-3", "USE", { USE: 0.5 }),
      verdict("rank-mode-2", "NO"),
      verdict("rank-mode-4", "NO"),
    ]);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:a", "recipe:c"]);
  });

  it("uses the chosen answer's own probability when Jev gave no table", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "USE", {}, { prob: 0.2 }),
      verdict("rank-mode-3", "USE", {}, { prob: 0.7 }),
      verdict("rank-mode-2", "NO"),
      verdict("rank-mode-4", "NO"),
    ]);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:c", "recipe:a"]);
  });
});

describe("interpretRanking: the comparative answer is the sort key, the mode answers decide membership", () => {
  const items = [item("recipe:a"), item("recipe:b"), item("recipe:c"), item("recipe:d")];
  const built = buildRankQuestions(items);
  const modes = [
    verdict("rank-mode-1", "USE", { USE: 0.97 }),
    verdict("rank-mode-2", "USE", { USE: 0.9 }),
    verdict("rank-mode-3", "USE", { USE: 0.6 }),
    verdict("rank-mode-4", "NO"),
  ];

  it("orders USE entries by their share of the comparative answer, not by how sure each mode answer was", () => {
    const r = interpretRanking(items, built, [
      ...modes,
      verdict("rank-flat", "c3", { c1: 0.02, c2: 0.03, c3: 0.9, c4: 0, none: 0.05 }),
    ]);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:c", "recipe:b", "recipe:a"]);
    expect(r.use.map((e) => e.score)).toEqual([0.9, 0.03, 0.02]);
    expect(r.useScoreBasis).toBe("comparative");
  });

  it("orders INSPIRE entries by the probability of INSPIRE: the comparative question gives partial fits nothing to sort on", () => {
    const withParts = [item("recipe:a"), item("recipe:b"), item("recipe:c")];
    const r = interpretRanking(withParts, buildRankQuestions(withParts), [
      verdict("rank-mode-1", "INSPIRE", { INSPIRE: 0.4 }),
      verdict("rank-mode-2", "INSPIRE", { INSPIRE: 0.9 }),
      verdict("rank-mode-3", "USE", { USE: 0.8 }),
      // the comparative answer picked the USE card and left the partial fits at about nothing, a hair apart
      verdict("rank-flat", "c3", { c1: 0.01, c2: 0, c3: 0.99 }),
    ]);
    expect(r.inspire.map((e) => e.cardId)).toEqual(["recipe:b", "recipe:a"]);
    expect(r.inspire.map((e) => e.score)).toEqual([0.9, 0.4]);
    expect(r.use.map((e) => e.score)).toEqual([0.99]);
  });

  it("a candidate Jev says NO to stays out however the comparative answer scored it", () => {
    const r = interpretRanking(items, built, [
      ...modes,
      verdict("rank-flat", "c4", { c1: 0.1, c2: 0.1, c3: 0.1, c4: 0.7 }),
    ]);
    expect(rankedList(r).map((e) => e.cardId)).not.toContain("recipe:d");
  });

  it("falls back to the mode probabilities when the comparative answer is skipped, missing or malformed", () => {
    const base = [...modes];
    const asRanked = (extra: JevVerdict[]) => interpretRanking(items, built, [...base, ...extra]);
    for (const r of [
      asRanked([]),
      asRanked([skipped("rank-flat", "timeout")]),
      asRanked([verdict("rank-flat", "c9", { c9: 1 })]),
      asRanked([verdict("rank-flat", "c1", { c1: Number.NaN })]),
    ]) {
      expect(r.use.map((e) => e.cardId)).toEqual(["recipe:a", "recipe:b", "recipe:c"]);
      expect(r.useScoreBasis).toBe("mode");
    }
  });

  it("breaks a tie in the comparative share by the mode probability, then by recall order", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "USE", { USE: 0.5 }),
      verdict("rank-mode-2", "USE", { USE: 0.9 }),
      verdict("rank-mode-3", "USE", { USE: 0.5 }),
      verdict("rank-mode-4", "NO"),
      verdict("rank-flat", "none", { c1: 0, c2: 0, c3: 0, c4: 0, none: 1 }),
    ]);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:b", "recipe:a", "recipe:c"]);
    expect(r.useScoreBasis).toBe("comparative");
  });
});

describe("interpretRanking: an answer outside the finite set degrades to local", () => {
  const items = [item("recipe:a", ["A1"], "A1"), item("recipe:b", ["B1"]), item("recipe:c")];
  const built = buildRankQuestions(items);

  it("a mode that is not USE, INSPIRE or NO leaves that candidate local at its recall position", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "MAYBE"),
      verdict("rank-mode-2", "USE", { USE: 0.9 }),
      verdict("rank-mode-3", "NO"),
    ]);
    const a = rankedList(r).find((e) => e.cardId === "recipe:a")!;
    expect(a.source).toBe("local");
    expect(a.recallRank).toBe(0);
    // recall found it through a section, so local claims inspiration and names that section, as its own
    expect(a).toMatchObject({ mode: "INSPIRE", section: "A1", sectionSource: "local" });
    expect(r.skip).toBe("invalid");
    expect(r.source).toBe("mixed");
  });

  it("a part id Jev was not offered keeps the mode but not the section, and says so", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-2", "INSPIRE", { INSPIRE: 0.9 }),
      verdict("rank-part-2", "s9"),
      verdict("rank-mode-1", "NO"),
      verdict("rank-mode-3", "NO"),
    ]);
    const b = r.inspire[0];
    expect(b).toMatchObject({ cardId: "recipe:b", source: "jev", mode: "INSPIRE" });
    expect(b.section).toBeUndefined();
    expect(r.skip).toBe("invalid");
  });

  it("a part answered none is a valid answer: no section, no degrade", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-2", "INSPIRE", { INSPIRE: 0.9 }),
      verdict("rank-part-2", "none"),
      verdict("rank-mode-1", "NO"),
      verdict("rank-mode-3", "NO"),
    ]);
    expect(r.inspire[0].section).toBeUndefined();
    expect(r.skip).toBeUndefined();
  });

  it("an INSPIRE with no part answer falls back to recall's own section, labelled local", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "INSPIRE", { INSPIRE: 0.9 }),
      verdict("rank-mode-2", "NO"),
      verdict("rank-mode-3", "NO"),
    ]);
    expect(r.inspire[0]).toMatchObject({ section: "A1", sectionSource: "local", source: "jev" });
  });

  it("a verdict of the wrong type is not an answer", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "USE", { USE: 1 }, { type: "score", answer: 3 }),
      verdict("rank-mode-2", "NO"),
      verdict("rank-mode-3", "NO"),
    ]);
    expect(rankedList(r).find((e) => e.cardId === "recipe:a")?.source).toBe("local");
  });

  it("no valid mode at all: the whole list is local, in recall order, and the reason is reported", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "MAYBE"),
      verdict("rank-mode-2", "??"),
      verdict("rank-mode-3", "USE-ish"),
    ]);
    expect(r.source).toBe("local");
    expect(r.skip).toBe("invalid");
    expect(rankedList(r).every((e) => e.source === "local")).toBe(true);
    expect(
      rankedList(r)
        .map((e) => e.recallRank)
        .toSorted(),
    ).toEqual([0, 1, 2]);
  });

  it("Jev answering NO to every candidate is Jev's answer, not a fallback: empty lists, source jev, no skip", () => {
    const r = interpretRanking(items, built, [
      verdict("rank-mode-1", "NO"),
      verdict("rank-mode-2", "NO"),
      verdict("rank-mode-3", "NO"),
    ]);
    expect(rankedList(r)).toEqual([]);
    expect(r).toMatchObject({ source: "jev", dropped: 3, answered: 3 });
    expect(r.skip).toBeUndefined();
  });

  it("an empty answer list reads as error", () => {
    const r = interpretRanking(items, built, []);
    expect(r).toMatchObject({ source: "local", skip: "error" });
  });
});

describe("interpretRanking: skip reasons from Jev itself", () => {
  const items = [item("recipe:a"), item("recipe:b")];
  const built = buildRankQuestions(items);

  it.each(["timeout", "breaker-open", "not-allowed", "error"] as const)(
    "every verdict skipped with %s labels the local list with that reason",
    (why) => {
      const r = interpretRanking(items, built, [
        skipped("rank-mode-1", why),
        skipped("rank-mode-2", why),
      ]);
      expect(r.source).toBe("local");
      expect(r.skip).toBe(why);
      expect(rankedList(r).map((e) => e.cardId)).toEqual(["recipe:a", "recipe:b"]);
      expect(r.answered).toBe(0);
    },
  );
});

describe("localRanking", () => {
  it("keeps recall order, labels every entry local and carries the reason and the detail", () => {
    const r = localRanking([item("recipe:a"), item("recipe:b", ["B1"], "B1")], "not-allowed", {
      skipDetail: "private-source",
    });
    expect(r.source).toBe("local");
    expect(r.skip).toBe("not-allowed");
    expect(r.skipDetail).toBe("private-source");
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:a"]);
    expect(r.inspire.map((e) => e.cardId)).toEqual(["recipe:b"]);
    expect(rankedList(r).every((e) => e.source === "local" && e.score === 0)).toBe(true);
  });

  it("an empty candidate list is an empty local result", () => {
    const r = localRanking([], "error");
    expect(r).toMatchObject({ use: [], inspire: [], source: "local" });
  });
});
