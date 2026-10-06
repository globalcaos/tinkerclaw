import { describe, expect, it } from "vitest";
import {
  keyPhrases,
  nameLikeWords,
  learnTriggers,
  MAX_PHRASES,
  MIN_TASKS,
  PHRASE_CHARS,
  splitCases,
  triggerEdit,
  type TriggerCase,
} from "./enhancement-triggers.js";
import { MAX_EDIT_CHARS } from "./thalamus-card-loop.js";
import { localRank, seedCards, type EnhancementCard } from "./thalamus-enhancements.js";

const listing = (name: string, description: string) => ({
  kind: "skill" as const,
  name,
  description,
});
const CARDS: EnhancementCard[] = seedCards([
  listing("patent-writer", "Drafts a patent application from an invention disclosure."),
  listing("photo-sorter", "Shows one photo at a time and records a keep or delete decision."),
  listing("translation-checker", "Compares a translation with its source text."),
  listing("amazon-shopper", "Compares Amazon listings and ranks them by price per unit."),
]);
const rank = (text: string, cards: readonly EnhancementCard[]) =>
  localRank(text, cards).map((r) => r.cardId);

let t = 1_000;
const kase = (
  text: string,
  cardId: string,
  onList = false,
  over: Partial<TriggerCase> = {},
): TriggerCase => ({
  taskId: `t${t}`,
  ts: (t += 1_000),
  text,
  used: [{ cardId, onList }],
  ...over,
});

describe("keyPhrases", () => {
  const ex = (...texts: string[]) => texts.map((text, i) => ({ taskId: `e${i}`, text }));

  it("needs the phrase in at least two different tasks", () => {
    expect(keyPhrases(ex("draft a dog toilet utility model"), ["something else"])).toEqual([]);
    expect(MIN_TASKS).toBe(2);
    const got = keyPhrases(
      ex("write the claims for the dog toilet filing", "prepare the dog toilet drawings"),
      ["rank amazon listings by price", "plan a family trip"],
    );
    expect(got).toContain("dog toilet");
  });

  it("drops a phrase that the other tasks use just as much", () => {
    const bg = [
      "please check the report",
      "please check the invoice",
      "please check the plan",
      "check the list please",
    ];
    const got = keyPhrases(ex("check the dog toilet claims", "check the dog toilet drawings"), bg);
    expect(got.some((p) => p === "check")).toBe(false);
    expect(got).toContain("dog toilet");
  });

  it("is bounded: at most three phrases, each short, never starting or ending on a filler word", () => {
    const got = keyPhrases(
      ex(
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      ),
      [],
    );
    expect(got.length).toBeLessThanOrEqual(MAX_PHRASES);
    for (const p of got) {
      expect(p.length).toBeLessThanOrEqual(PHRASE_CHARS);
      expect(p).not.toMatch(/^(the|a|an|to|of|and) | (the|a|an|to|of|and)$/);
    }
    expect(keyPhrases(ex("send it to the", "send it to the"), [])).toEqual([]);
  });

  it("does not offer a phrase and a part of it", () => {
    const got = keyPhrases(
      ex("write the utility model claims", "check the utility model claims"),
      [],
    );
    for (const a of got) for (const b of got) if (a !== b) expect(a.includes(b)).toBe(false);
  });

  it("is deterministic and ignores the envelope of the prompt", () => {
    const a = keyPhrases(
      ex("[Tue 2026-10-06 08:43 GMT+2] dog toilet claims", "dog toilet drawings"),
      [],
    );
    const b = keyPhrases(
      ex("dog toilet claims", "[Tue 2026-10-06 09:00 GMT+2] dog toilet drawings"),
      [],
    );
    expect(a).toEqual(b);
    expect(a.join(" ")).not.toMatch(/gmt|2026/);
  });
});

describe("names are not taught", () => {
  it("finds the words that are always capitalised and never open a request", () => {
    const names = nameLikeWords([
      "send the plan to Sasha today",
      "ask Sasha about the trip",
      "Sasha wants the dates",
      "show the flights to Bryce and Sasha",
    ]);
    // "Sasha" opens one request, but is capitalised everywhere else and never seen in lower case
    expect([...names].sort()).toEqual(["bryce", "sasha"]);
    expect(nameLikeWords(["Plan the trip", "plan the trip again"]).has("plan")).toBe(false);
    expect(nameLikeWords(["the Motorhome", "a motorhome"]).has("motorhome")).toBe(false);
  });

  it("keyPhrases leaves a name out and keeps the ordinary phrase beside it", () => {
    const got = keyPhrases(
      [
        { taskId: "a", text: "send the motorhome holiday dates to Sasha" },
        { taskId: "b", text: "check the motorhome holiday dates with Sasha" },
        { taskId: "c", text: "update the motorhome holiday dates for Sasha" },
      ],
      ["rank amazon listings", "sort photos by date"],
    );
    expect(got.join(" ")).not.toContain("sasha");
    expect(got.join(" ")).toContain("motorhome holiday");
  });
});

describe("triggerEdit", () => {
  it("is one also-served line of the phrases", () => {
    expect(triggerEdit("skill:x", ["dog toilet", "utility model"])).toEqual({
      cardId: "skill:x",
      kind: "also-served",
      text: "dog toilet, utility model",
    });
  });
  it("is none for no phrases or a line over the edit limit", () => {
    expect(triggerEdit("skill:x", [])).toBeUndefined();
    expect(triggerEdit("skill:x", ["x".repeat(MAX_EDIT_CHARS + 1)])).toBeUndefined();
  });
});

describe("splitCases", () => {
  it("trains on the earlier cases, validates on the later, and the two never share a timestamp", () => {
    const cs = Array.from({ length: 10 }, (_, i) => ({ ts: (i % 5) * 10, id: i }));
    const { train, validation } = splitCases(cs);
    expect(Math.max(...train.map((c) => c.ts))).toBeLessThan(
      Math.min(...validation.map((c) => c.ts)),
    );
    expect(train.length + validation.length).toBe(10);
  });
  it("one case is all training", () => {
    expect(splitCases([{ ts: 1 }]).validation).toEqual([]);
  });
});

describe("learnTriggers", () => {
  const train = (): TriggerCase[] => [
    kase("Write the claims for the dog toilet filing", "skill:patent-writer"),
    kase("Prepare the dog toilet drawings for the filing", "skill:patent-writer"),
    kase("rank amazon listings by price per gigabyte", "skill:amazon-shopper", true),
    kase("check my translation against the source text", "skill:translation-checker", true),
  ];
  const later = (): TriggerCase[] => [
    kase("Review the dog toilet description once more", "skill:patent-writer"),
    kase("Answer the examiner about the dog toilet", "skill:patent-writer"),
    kase(
      "check the translation of the contract against the source text",
      "skill:translation-checker",
      true,
    ),
    kase("compare amazon listings by price", "skill:amazon-shopper", true),
  ];

  it("learns the shared phrase from earlier tasks and keeps it because later tasks improve", () => {
    const r = learnTriggers({ cases: [...train(), ...later()], cards: CARDS, rank });
    const a = r.attempts.find((x) => x.cardId === "skill:patent-writer")!;
    expect(a.phrases).toContain("dog toilet");
    expect(a.kept).toBe(true);
    expect(a.why).toBe("kept");
    expect(a.after).toBeGreaterThan(a.before);
    expect(a.hit3After).toBeGreaterThan(a.hit3Before);
    const card = r.cards.find((c) => c.id === "skill:patent-writer")!;
    expect(card.alsoServed.join(" ")).toContain("dog toilet");
    expect(card.version).toBe(2);
    expect(card.origin).toBe("nightly");
    expect(r.kept).toBe(1);
  });

  it("never reads the validation tasks when it chooses phrases", () => {
    const cs = [...train(), ...later()];
    // made last, so they are the newest cases and fall in the validation part
    cs.push(kase("Review the dog toilet zeppelin zeppelin", "skill:patent-writer"));
    cs.push(kase("Answer the examiner about the zeppelin", "skill:patent-writer"));
    const r = learnTriggers({ cases: cs, cards: CARDS, rank });
    expect(
      splitCases(cs)
        .validation.map((c) => c.text)
        .join(" "),
    ).toContain("zeppelin");
    expect(r.attempts.flatMap((a) => a.phrases).join(" ")).not.toContain("zeppelin");
  });

  it("does not touch the cards it was given, and leaves a card with too few off-list tasks alone", () => {
    const before = JSON.stringify(CARDS);
    const cs = [
      kase("single dog toilet task", "skill:patent-writer"),
      kase("check my translation against the source text", "skill:translation-checker", true),
      kase("rank amazon listings by price per gigabyte", "skill:amazon-shopper", true),
      kase(
        "check the contract translation against the source text",
        "skill:translation-checker",
        true,
      ),
    ];
    const r = learnTriggers({ cases: cs, cards: CARDS, rank });
    expect(JSON.stringify(CARDS)).toBe(before);
    expect(r.attempts.find((a) => a.cardId === "skill:patent-writer")).toBeUndefined();
    expect(r.cards).toEqual(CARDS);
  });

  it("an on-list use is no off-list example", () => {
    const cs = [
      kase("Write the claims for the dog toilet filing", "skill:patent-writer", true),
      kase("Prepare the dog toilet drawings for the filing", "skill:patent-writer", true),
      ...later(),
    ];
    expect(learnTriggers({ cases: cs, cards: CARDS, rank }).attempts).toEqual([]);
  });

  // A retriever whose behaviour is obvious: a card scores 10 when one of its learned lines is in the text, 5 when a word of its name is.
  const stub = (text: string, cards: readonly EnhancementCard[]): string[] =>
    cards
      .map((c) => {
        const learned = c.alsoServed.some((line) =>
          line.split(", ").some((ph) => text.toLowerCase().includes(ph)),
        )
          ? 10
          : 0;
        const named = c.name.split("-").some((w) => text.toLowerCase().includes(w)) ? 5 : 0;
        return { id: c.id, s: learned + named };
      })
      .filter((x) => x.s > 0)
      .toSorted((x, y) => y.s - x.s || (x.id < y.id ? -1 : 1))
      .map((x) => x.id);

  it("refuses an edit that does not help the later tasks", () => {
    const cs = [
      ...train(),
      // the later patent tasks do not use the phrase, so the edit changes nothing for them
      kase("renew the trademark registration before the deadline", "skill:patent-writer"),
      kase("answer the examiner about the novelty objection", "skill:patent-writer"),
    ];
    const r = learnTriggers({ cases: cs, cards: CARDS, rank: stub });
    const a = r.attempts.find((x) => x.cardId === "skill:patent-writer")!;
    expect(a.kept).toBe(false);
    expect(a.why).toBe("no-gain");
    expect(a.after).toBe(a.before);
    expect(r.cards.find((c) => c.id === "skill:patent-writer")!.version).toBe(1);
    expect(r.kept).toBe(0);
  });

  it("refuses an edit that costs an owner-pinned case its rank, whatever else it gains", () => {
    const pinned = kase(
      "check the translation of the dog toilet manual",
      "skill:translation-checker",
      true,
      {
        pinned: ["skill:translation-checker"],
      },
    );
    const cs = [
      ...train(),
      kase("Review the dog toilet description once more", "skill:patent-writer"),
      pinned,
    ];
    const r = learnTriggers({ cases: cs, cards: CARDS, rank: stub });
    const a = r.attempts.find((x) => x.cardId === "skill:patent-writer")!;
    expect(a.after).toBeGreaterThan(a.before - 1e-9);
    expect(a.kept).toBe(false);
    expect(a.why).toBe("pinned-case-lost");
    expect(stub(pinned.text, r.cards)[0]).toBe("skill:translation-checker");
  });

  it("changes at most the number of cards it is allowed to in one pass", () => {
    const names = ["alpha", "bravo", "charlie", "delta"];
    const many = seedCards(names.map((n) => listing(`card-${n}`, `Does the ${n} thing.`)));
    const cs: TriggerCase[] = [];
    for (const n of names) {
      cs.push(kase(`do the ${n}${n} procedure now`, `skill:card-${n}`));
      cs.push(kase(`run the ${n}${n} procedure again`, `skill:card-${n}`));
    }
    for (const n of names) cs.push(kase(`please do the ${n}${n} procedure`, `skill:card-${n}`));
    const r = learnTriggers({ cases: cs, cards: many, rank, maxCards: 2 });
    expect(r.attempts.length).toBeLessThanOrEqual(2);
  });
});
