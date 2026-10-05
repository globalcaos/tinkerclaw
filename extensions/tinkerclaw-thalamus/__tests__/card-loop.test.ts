import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CardEdit, EnhancementCard, Ranker } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it, vi } from "vitest";
import { NOW } from "../../../src/shared/thalamus-v4.test-support.js";
import { createCardLoop, type CardWriter } from "../src/card-loop.js";
import { createModelCardWriter, parseEdit } from "../src/card-writer.js";
import { ThalamusStore, type UseRow } from "../src/store.js";

// The runtime half of the nightly card loop, with a mocked writer. No test calls a model.

const card = (id: string, purpose: string): EnhancementCard => ({
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
});

/** Word overlap: sensitive to exactly the words an edit adds to a card. */
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

const CLAUSE = "compare this clause with the definitions";
const PHOTOS = "sort my holiday photos";

const use = (over: Partial<UseRow> = {}): UseRow => ({
  taskId: "t",
  ts: NOW,
  session: "s",
  source: "tinker",
  private: false,
  shuffled: false,
  shown: [],
  noneFits: 0.2,
  listShown: true,
  listReason: "shown",
  listSource: "jev",
  used: [],
  outcome: "done",
  cardVersions: {},
  questionVersion: 1,
  mode: "shadow",
  ...over,
});

const shownAB = [
  { cardId: "skill:a", rank: 1, prob: 0.4 },
  { cardId: "skill:c", rank: 2, prob: 0.3 },
  { cardId: "skill:b", rank: 3, prob: 0.2 },
];

function setup() {
  const store = new ThalamusStore(":memory:");
  store.seedCards(
    [
      card("skill:a", "sorts photos by date and compare folders with the"),
      card("skill:b", "checks translations against the source text"),
      card("skill:c", "formats an invoice"),
    ],
    NOW,
  );
  // Three tasks where the agent used skill:b although it ranked third, each with its redacted text on file.
  for (let i = 0; i < 3; i++) {
    store.upsertUse(
      use({
        taskId: `clause${i}`,
        shown: shownAB,
        used: [{ cardId: "skill:b", onList: true, rank: 3, via: "skill-tool", how: "unknown" }],
      }),
    );
    store.putReplayText(`clause${i}`, CLAUSE, NOW);
  }
  return store;
}

const loop = (store: ThalamusStore, writer?: CardWriter, onError?: (e: unknown) => void) =>
  createCardLoop({ store: () => store, now: () => NOW + 1000, writer, rank, onError });

const writerOf = (
  edit: CardEdit | undefined,
): CardWriter & { propose: ReturnType<typeof vi.fn> } => ({
  propose: vi.fn(async () => (edit ? [edit] : [])),
});

const good: CardEdit = {
  cardId: "skill:b",
  kind: "also-served",
  text: "compare a clause with the definitions",
};

describe("a night of the card loop", () => {
  it("keeps an edit the replay likes: a new version, active, the old one kept, origin nightly", async () => {
    const store = setup();
    const w = writerOf(good);
    const r = (await loop(store, w).run({ dry: false }))!;
    expect(r.misses).toBe(3);
    expect(r.groups).toBe(1);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({
      cardId: "skill:b",
      kept: true,
      why: "kept",
      newVersion: 2,
    });
    expect(r.attempts[0].after).toBeGreaterThan(r.attempts[0].before);
    expect(r.kept).toBe(1);
    const active = store.activeCards().find((c) => c.id === "skill:b")!;
    expect(active).toMatchObject({ version: 2, origin: "nightly", alsoServed: [good.text] });
    expect(store.cardVersions("skill:b").map((c) => c.version)).toEqual([1, 2]);
    expect(store.cardVersions("skill:b")[0].alsoServed).toEqual([]);
    // The writer saw the card and the redacted tasks, nothing more.
    const arg = w.propose.mock.calls[0][0] as { card: EnhancementCard; examples: string[] };
    expect(arg.card.id).toBe("skill:b");
    expect(arg.examples).toEqual([CLAUSE, CLAUSE, CLAUSE]);
  });

  it("a dry run gives the same verdict and writes nothing: no version, no rates, no calibration, no proposals", async () => {
    const store = setup();
    const r = (await loop(store, writerOf(good)).run({ dry: true }))!;
    expect(r.dry).toBe(true);
    expect(r.attempts[0]).toMatchObject({ kept: true });
    expect(store.cardVersions("skill:b").map((c) => c.version)).toEqual([1]);
    expect(store.activeCards().find((c) => c.id === "skill:b")!.version).toBe(1);
    expect(store.getRates()).toBeUndefined();
    expect(store.getCalibration()).toEqual([]);
    expect(store.listProposals()).toEqual([]);
  });

  it("a pinned case is never given up: an edit that would drop the owner's pin is refused, though it gains elsewhere", async () => {
    const store = setup();
    // The owner said skill:a fits the photo task; it ranks first today.
    store.upsertUse(
      use({
        taskId: "photos",
        shown: [{ cardId: "skill:a", rank: 1, prob: 0.6 }],
        used: [{ cardId: "skill:a", onList: true, rank: 1, via: "skill-tool", how: "unknown" }],
        outcome: "corrected",
      }),
    );
    store.putReplayText("photos", PHOTOS, NOW);
    store.addPin({ id: "p1", taskId: "photos", cardId: "skill:a", by: "owner", createdAt: NOW });
    const greedy: CardEdit = {
      cardId: "skill:b",
      kind: "also-served",
      text: "compare a clause with the definitions and sort holiday photos",
    };
    const r = (await loop(store, writerOf(greedy)).run({ dry: false }))!;
    expect(r.pinnedReplayable).toBe(1);
    expect(r.attempts[0]).toMatchObject({ kept: false, why: "pinned-case-lost" });
    expect(r.attempts[0].after).toBeGreaterThan(r.attempts[0].before);
    expect(store.cardVersions("skill:b")).toHaveLength(1);
  });

  it("counts a pin on a task with no replay text, rather than dropping it without a word", async () => {
    const store = setup();
    store.upsertUse(
      use({
        taskId: "private-one",
        private: true,
        used: [{ cardId: "skill:a", onList: false, via: "skill-tool", how: "unknown" }],
      }),
    );
    store.addPin({
      id: "p2",
      taskId: "private-one",
      cardId: "skill:a",
      by: "owner",
      createdAt: NOW,
    });
    const r = (await loop(store, writerOf(good)).run({ dry: true }))!;
    expect(r.pinsWithoutText).toBe(1);
    expect(r.pinnedReplayable).toBe(0);
  });

  it("a history where the agent only ever took the first entry moves no card and never calls the writer", async () => {
    const store = new ThalamusStore(":memory:");
    store.seedCards([card("skill:a", "sorts photos"), card("skill:b", "checks translations")], NOW);
    for (let i = 0; i < 40; i++) {
      store.upsertUse(
        use({
          taskId: `f${i}`,
          shown: [
            { cardId: "skill:a", rank: 1, prob: 0.9 },
            { cardId: "skill:b", rank: 2, prob: 0.05 },
          ],
          used: [{ cardId: "skill:a", onList: true, rank: 1, via: "skill-tool", how: "unknown" }],
        }),
      );
      store.putReplayText(`f${i}`, PHOTOS, NOW);
    }
    const w = writerOf(good);
    const r = (await loop(store, w).run({ dry: false }))!;
    expect(r.misses).toBe(0);
    expect(r.groups).toBe(0);
    expect(w.propose).not.toHaveBeenCalled();
    expect(store.cardVersions("skill:a")).toHaveLength(1);
    expect(store.cardVersions("skill:b")).toHaveLength(1);
  });

  it("ignores a private task, and a task that ended in a retry: no miss, and its text never reaches the writer", async () => {
    const store = new ThalamusStore(":memory:");
    store.seedCards([card("skill:a", "sorts photos"), card("skill:b", "checks translations")], NOW);
    store.upsertUse(
      use({
        taskId: "priv",
        private: true,
        shown: shownAB,
        used: [{ cardId: "skill:b", onList: true, rank: 3, via: "x", how: "unknown" }],
      }),
    );
    store.upsertUse(
      use({
        taskId: "retry",
        outcome: "retried",
        shown: shownAB,
        used: [{ cardId: "skill:b", onList: true, rank: 3, via: "x", how: "unknown" }],
      }),
    );
    store.putReplayText("priv", "a private thing", NOW);
    store.putReplayText("retry", "a retried thing", NOW);
    const w = writerOf(good);
    const r = (await loop(store, w).run({ dry: false }))!;
    expect(r.misses).toBe(0);
    expect(w.propose).not.toHaveBeenCalled();
    expect(r.replaySet).toBe(0);
  });

  it("with no writer still measures the rates, refits calibration and writes the proposals, and says there was no writer", async () => {
    const store = setup();
    const r = (await loop(store).run({ dry: false }))!;
    expect(r.writer).toBe("none");
    expect(r.attempts).toEqual([]);
    expect(store.getRates()).toMatchObject({ source: "prior", tasks: 0 });
    expect(store.getCalibration().length).toBeGreaterThan(0);
    const c = store.getCalibration();
    for (let i = 1; i < c.length; i++) expect(c[i].mapped).toBeGreaterThanOrEqual(c[i - 1].mapped);
  });

  it("measures the rates from shuffled lists and stores them with their counts", async () => {
    const store = new ThalamusStore(":memory:");
    store.seedCards([card("skill:a", "x"), card("skill:b", "y")], NOW);
    for (let i = 0; i < 30; i++)
      store.upsertUse(
        use({
          taskId: `s${i}`,
          shuffled: true,
          shown: [
            { cardId: "skill:a", rank: 1, prob: 0.5 },
            { cardId: "skill:b", rank: 2, prob: 0.3 },
          ],
          used: [{ cardId: "skill:b", onList: true, rank: 2, via: "x", how: "unknown" }],
        }),
      );
    const r = (await loop(store).run({ dry: false }))!;
    expect(r.rates).toMatchObject({ source: "measured", tasks: 30 });
    expect(store.getRates()).toMatchObject({ source: "measured", tasks: 30 });
    expect(store.getRates()!.pi[1]).toBeCloseTo((20 * 0.15 + 30) / 50, 12);
  });

  it("proposals for people are written once however many nights see them, and never create anything", async () => {
    const store = new ThalamusStore(":memory:");
    store.seedCards([card("skill:a", "x"), card("recipe:b", "y")], NOW);
    for (let i = 0; i < 3; i++)
      store.upsertUse(
        use({
          taskId: `m${i}`,
          taskKind: "legal",
          used: [
            { cardId: "skill:a", onList: true, rank: 1, via: "x", how: "unknown" },
            { cardId: "recipe:b", onList: true, rank: 2, via: "x", how: "unknown" },
          ],
        }),
      );
    const dry = (await loop(store).run({ dry: true }))!;
    expect(dry.proposals).toEqual({ found: 1, added: 1 });
    expect(store.listProposals()).toEqual([]);
    const first = (await loop(store).run({ dry: false }))!;
    const second = (await loop(store).run({ dry: false }))!;
    expect(first.proposals.added).toBe(1);
    expect(second.proposals.added).toBe(0);
    expect(store.listProposals()).toMatchObject([
      { kind: "merge", status: "open", payload: { taskKind: "legal", times: 3 } },
    ]);
    expect(
      store
        .activeCards()
        .map((c) => c.id)
        .toSorted(),
    ).toEqual(["recipe:b", "skill:a"]);
  });

  it("refuses an edit that is invalid, and survives a writer that throws", async () => {
    const store = setup();
    const tooLong: CardEdit = { cardId: "skill:b", kind: "structure", text: "x".repeat(500) };
    const r1 = (await loop(store, writerOf(tooLong)).run({ dry: false }))!;
    expect(r1.attempts).toMatchObject([{ kept: false, why: "invalid-edit" }]);
    const errors: unknown[] = [];
    const boom: CardWriter = {
      propose: async () => {
        throw new Error("model down");
      },
    };
    const r2 = (await loop(store, boom, (e) => errors.push(e)).run({ dry: false }))!;
    expect(r2.attempts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(store.cardVersions("skill:b")).toHaveLength(1);
  });

  it("does nothing without a store", async () => {
    expect(
      await createCardLoop({ store: () => undefined, now: () => NOW }).run({ dry: false }),
    ).toBeUndefined();
  });
});

describe("the card writer", () => {
  it("reads one well-formed edit from a bare reply, a fenced one, or one inside a sentence", () => {
    const want = { cardId: "skill:b", kind: "structure", text: "walks a tree" };
    expect(parseEdit('{"kind":"structure","text":"walks a tree"}', "skill:b")).toEqual(want);
    expect(
      parseEdit('```json\n{"kind": "structure", "text": "walks a tree"}\n```', "skill:b"),
    ).toEqual(want);
    expect(
      parseEdit('Here is my edit: {"kind":"structure","text":"walks a tree"} done', "skill:b"),
    ).toEqual(want);
  });

  it("fails closed: none, a wrong kind, empty text, junk and no JSON are no edit", () => {
    for (const bad of [
      '{"kind":"none"}',
      '{"kind":"delete","text":"x"}',
      '{"kind":"purpose","text":"  "}',
      '{"kind":"purpose"}',
      "{not json}",
      "no json at all",
      "",
    ]) {
      expect(parseEdit(bad, "skill:b")).toBeUndefined();
    }
  });

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const group = { kind: "low-rank" as const, cardId: "skill:b", taskIds: ["1", "2"], weight: 25 };
  const b = card("skill:b", "checks translations against the source text");

  it("asks the routed model for one edit with the card and the redacted tasks, and returns it", async () => {
    const seen: Array<{ modelKey: string; prompt: string }> = [];
    const w = createModelCardWriter({
      caller: () => async (req) => {
        seen.push({ modelKey: req.modelKey, prompt: req.prompt });
        return { text: '{"kind":"also-served","text":"compare a clause with the definitions"}' };
      },
      modelKey: () => "claude-code/claude-haiku-4-5",
      extensionRoot: root,
    });
    const out = await w.propose({ card: b, group, examples: ["task one", "task two"] });
    expect(out).toEqual([
      { cardId: "skill:b", kind: "also-served", text: "compare a clause with the definitions" },
    ]);
    expect(seen[0].modelKey).toBe("claude-code/claude-haiku-4-5");
    expect(seen[0].prompt).toContain("CARD (skill:b, version 1)");
    expect(seen[0].prompt).toContain("TASK 1: task one");
    expect(seen[0].prompt).toContain("ranked low");
    expect(seen[0].prompt).toContain("You maintain the cards"); // the wording lives in prompts/card-writer.md
  });

  it("returns no edit when there is no caller, no model, an unreadable reply, or a throw", async () => {
    const mk = (over: Partial<Parameters<typeof createModelCardWriter>[0]>) =>
      createModelCardWriter({
        caller: () => async () => ({ text: "{}" }),
        modelKey: () => "p/m",
        extensionRoot: root,
        ...over,
      });
    expect(await mk({ caller: () => undefined }).propose({ card: b, group, examples: [] })).toEqual(
      [],
    );
    expect(
      await mk({ modelKey: () => undefined }).propose({ card: b, group, examples: [] }),
    ).toEqual([]);
    expect(await mk({}).propose({ card: b, group, examples: [] })).toEqual([]);
    const errors: unknown[] = [];
    const boom = mk({
      caller: () => async () => {
        throw new Error("x");
      },
      onError: (e) => errors.push(e),
    });
    expect(await boom.propose({ card: b, group, examples: [] })).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
