import { describe, expect, it } from "vitest";
import {
  buildRankQuestions,
  interpretRanking,
  rankedList,
  type RankItem,
} from "./enhancement-rank.js";
import { firstHit, recordedVerdicts, type Recording } from "./enhancement-replay-rank.js";

const item = (id: string, sections: string[] = [], recallSection?: string): RankItem => ({
  cardId: id,
  kind: "recipe",
  text: `${id} text`,
  sections,
  ...(recallSection ? { recallSection } : {}),
});

const ITEMS = [
  item("recipe:a"),
  item("recipe:b", ["B1"], "B1"),
  item("recipe:c"),
  item("recipe:d"),
];

const run = (rec: Recording) => {
  const built = buildRankQuestions(ITEMS);
  return interpretRanking(ITEMS, built, recordedVerdicts(ITEMS, built, rec));
};

describe("recordedVerdicts: Jev replayed from what it actually said", () => {
  it("answers USE with the recorded probability for a card that was on the recorded Jev list", () => {
    const r = run({
      listSource: "jev",
      shown: [
        { cardId: "recipe:c", prob: 0.7 },
        { cardId: "recipe:a", prob: 0.2 },
      ],
    });
    expect(r.use.filter((e) => e.source === "jev").map((e) => [e.cardId, e.score])).toEqual([
      ["recipe:c", 0.7],
      ["recipe:a", 0.2],
    ]);
    expect(r.useScoreBasis).toBe("comparative");
  });

  it("leaves a card the recorded list did not name without an answer, so it stays local at its recall position", () => {
    const r = run({ listSource: "jev", shown: [{ cardId: "recipe:c", prob: 0.9 }] });
    const rest = rankedList(r).filter((e) => e.source === "local");
    expect(rest.map((e) => e.cardId).toSorted()).toEqual(["recipe:a", "recipe:b", "recipe:d"]);
    expect(r.source).toBe("mixed");
  });

  it("a recorded local list is a silent Jev: every entry local, in recall order", () => {
    const r = run({ listSource: "local", shown: [{ cardId: "recipe:c", prob: 0.9 }] });
    expect(r.source).toBe("local");
    expect(rankedList(r).map((e) => e.recallRank)).toEqual([0, 2, 3, 1]);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:a", "recipe:c", "recipe:d"]);
    expect(r.inspire.map((e) => e.cardId)).toEqual(["recipe:b"]);
  });

  it("a recorded Jev list that names none of the candidates gives Jev nothing to say about them", () => {
    const r = run({ listSource: "jev", shown: [{ cardId: "recipe:zzz", prob: 0.9 }] });
    expect(r.source).toBe("local");
    expect(r.skip).toBe("error");
  });

  it("depends on the recording alone: nothing about what the agent went on to use can reach it", () => {
    const rec: Recording = { listSource: "jev", shown: [{ cardId: "recipe:b", prob: 0.6 }] };
    // the type has no field for the answer; passing extra properties changes nothing
    const a = run(rec);
    const b = run({ ...rec, used: ["recipe:d"] } as Recording);
    expect(b).toEqual(a);
  });
});

describe("firstHit", () => {
  const list = [
    { cardId: "recipe:a", source: "jev" as const },
    { cardId: "recipe:b", source: "local" as const },
    { cardId: "recipe:c", source: "local" as const },
  ];
  it("gives the position and the source of the first used card on the list", () => {
    expect(firstHit(list, new Set(["recipe:c", "recipe:b"]))).toEqual({
      position: 1,
      source: "local",
    });
    expect(firstHit(list, new Set(["recipe:a"]))).toEqual({ position: 0, source: "jev" });
  });
  it("is undefined when none of them is on the list", () => {
    expect(firstHit(list, new Set(["recipe:z"]))).toBeUndefined();
  });
});
