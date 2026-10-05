import { describe, expect, it } from "vitest";
import { seedCards, type EnhancementCard, type Shortlist } from "./thalamus-enhancements.js";
import { MAX_CHARS, PURPOSE_CHARS, shortlistContext } from "./thalamus-shortlist-text.js";

const cards = seedCards([
  {
    kind: "skill",
    name: "translation-checker",
    path: "/s/tc/SKILL.md",
    description: "Compares a translation with its source and repeats until they match.",
  },
  {
    kind: "recipe",
    name: "Photo sorter",
    description: "Shows one photo at a time and records a decision.",
  },
  { kind: "plugin", name: "memory-core", description: "Searches memory." },
]);
const byId = new Map<string, EnhancementCard>(cards.map((c) => [c.id, c]));

const list = (over: Partial<Shortlist> = {}): Shortlist => ({
  entries: [
    { cardId: "skill:translation-checker", rank: 1, prob: 0.624 },
    { cardId: "recipe:Photo sorter", rank: 2, prob: 0.2 },
  ],
  noneFitsProb: 0.1,
  shown: true,
  reason: "shown",
  source: "jev",
  ...over,
});

describe("the note handed to the agent", () => {
  it("says nothing when the list is not shown", () => {
    expect(
      shortlistContext(list({ shown: false, reason: "none-leads", entries: [] }), byId),
    ).toBeUndefined();
    expect(shortlistContext(list({ shown: false }), byId)).toBeUndefined();
  });

  it("lists the entries in order, with the probability and what each is for", () => {
    const t = shortlistContext(list(), byId)!;
    const lines = t.split("\n");
    expect(lines[1]).toMatch(/^1\. skill translation-checker, 62%: Compares a translation/);
    expect(lines[2]).toMatch(/^2\. recipe Photo sorter, 20%: Shows one photo/);
    expect(lines[1]).toContain("(/s/tc/SKILL.md)");
  });

  it("calls it advice and always says that none may fit", () => {
    const t = shortlistContext(list(), byId)!;
    expect(t.split("\n")[0]).toContain("advice");
    expect(t).toContain("take none");
    expect(t.split("\n").at(-1)).toBe("None of these may fit; use your own judgment.");
  });

  it("says how each entry fits when the fit was read", () => {
    const t = shortlistContext(
      list({
        entries: [
          {
            cardId: "skill:translation-checker",
            rank: 1,
            prob: 0.5,
            fit: { value: "made-for", conf: 0.9, source: "jev" },
          },
          {
            cardId: "recipe:Photo sorter",
            rank: 2,
            prob: 0.3,
            fit: { value: "by-structure", conf: 0.9, source: "jev" },
          },
        ],
      }),
      byId,
    )!;
    expect(t).toContain("made for this task");
    expect(t).toContain("not made for this, but it works the same way");
  });

  it("says two entries fit together, by position", () => {
    const t = shortlistContext(
      list({
        entries: [
          {
            cardId: "skill:translation-checker",
            rank: 1,
            prob: 0.4,
            fit: { value: "covers-part", conf: 0.9, source: "jev" },
          },
          {
            cardId: "recipe:Photo sorter",
            rank: 2,
            prob: 0.3,
            fit: { value: "covers-part", conf: 0.9, source: "jev" },
          },
        ],
        together: ["skill:translation-checker", "recipe:Photo sorter"],
      }),
      byId,
    )!;
    expect(t).toContain("1 and 2 each cover part of the task and fit together.");
  });

  it("skips a card it does not know and renumbers, or says nothing when none is known", () => {
    const t = shortlistContext(
      list({
        entries: [
          { cardId: "skill:gone", rank: 1, prob: 0.5 },
          { cardId: "plugin:memory-core", rank: 2, prob: 0.3 },
        ],
      }),
      byId,
    )!;
    expect(t).toContain("1. plugin memory-core, 30%");
    expect(t).not.toContain("gone");
    expect(
      shortlistContext(list({ entries: [{ cardId: "skill:gone", rank: 1, prob: 0.5 }] }), byId),
    ).toBeUndefined();
  });

  it("clips a long purpose and keeps the whole note within its limit", () => {
    const long: EnhancementCard = { ...cards[0], id: "skill:long", purpose: "x".repeat(500) };
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...long,
      id: `skill:l${i}`,
      name: `l${i}`,
      path: `/p/${"y".repeat(200)}`,
    }));
    const map = new Map(many.map((c) => [c.id, c]));
    const t = shortlistContext(
      list({ entries: many.map((c, i) => ({ cardId: c.id, rank: i + 1, prob: 0.1 })) }),
      map,
    )!;
    expect(t.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(t.split("\n")[1].length).toBeLessThan(PURPOSE_CHARS + 260);
  });

  it("never cuts the closing line: too long a note loses its weakest entries, not its last sentence", () => {
    const wide = Array.from({ length: 6 }, (_, i) => ({
      ...cards[0],
      id: `skill:w${i}`,
      name: `w${i}`,
      purpose: "p".repeat(400),
      path: `/p/${"z".repeat(300)}`,
    }));
    const map = new Map(wide.map((c) => [c.id, c]));
    const t = shortlistContext(
      list({ entries: wide.map((c, i) => ({ cardId: c.id, rank: i + 1, prob: 0.15 })) }),
      map,
    )!;
    expect(t.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(t.split("\n").at(-1)).toBe("None of these may fit; use your own judgment.");
    expect(t.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("does not claim two entries fit together when one of them was dropped for length", () => {
    const wide = Array.from({ length: 6 }, (_, i) => ({
      ...cards[0],
      id: `skill:w${i}`,
      name: `w${i}`,
      purpose: "p".repeat(400),
      path: `/p/${"z".repeat(300)}`,
    }));
    const map = new Map(wide.map((c) => [c.id, c]));
    const t = shortlistContext(
      list({
        entries: wide.map((c, i) => ({ cardId: c.id, rank: i + 1, prob: 0.15 })),
        together: ["skill:w0", "skill:w5"],
      }),
      map,
    )!;
    expect(t).not.toContain("fit together");
  });

  it("is a few lines, not a page", () => {
    expect(shortlistContext(list(), byId)!.split("\n").length).toBeLessThanOrEqual(6);
  });
});
