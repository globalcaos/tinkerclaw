import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevQuestion, JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import { rankedList, type RankItem } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import { loadQuestions } from "../src/reads/questions.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type AskFn,
  type ReaderConfig,
  type ReadInput,
} from "../src/reads/routing-reader.js";

// Phase C of the Broca retrieval v2 build: Jev ranks recall's candidates into USE and INSPIRE groups. Jev is mocked
// throughout; the live check against the real service is a separate script.

const questions = loadQuestions(join(dirname(fileURLToPath(import.meta.url)), "..", "questions"));
const NOW = 1_800_000_000_000;

const ITEMS: RankItem[] = [
  {
    cardId: "recipe:family-trip",
    kind: "recipe",
    text: "Plan a family trip.",
    sections: ["Pick dates", "Flights", "Motorhome"],
  },
  {
    cardId: "recipe:review-site",
    kind: "recipe",
    text: "A page the family reviews.",
    sections: ["Build the page", "Collect the choice"],
  },
  { cardId: "skill:pdf-tools", kind: "skill", text: "Extract text from a PDF.", sections: [] },
];

const input = (over: Partial<ReadInput> = {}): ReadInput => ({
  id: "t1",
  ts: NOW,
  sessionKey: "s",
  text: "Plan the summer motorhome holiday for the family.",
  source: "tinker",
  trigger: "user",
  synthetic: true,
  ...over,
});

const on: ReaderConfig = { ...DEFAULT_READER_CONFIG, jevEnabled: true };

const choice = (
  q: JevQuestion,
  answer: string,
  probs: Record<string, number> = {},
  over: Partial<JevVerdict> = {},
): JevVerdict => ({
  id: `v-${q.id}`,
  situationId: "t1",
  questionId: q.id,
  questionVersion: q.version,
  type: "choice",
  answer,
  prob: probs[answer] ?? 0.9,
  confidence: 0.9,
  ...(Object.keys(probs).length ? { probs } : {}),
  cacheHit: false,
  latencyMs: 120,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  ts: NOW,
  ...over,
});

/** A scripted Jev: answers each question id from the map, counts the calls, remembers the budget it was given. */
function scripted(answers: Record<string, [answer: string, probs?: Record<string, number>]>) {
  const calls: JevQuestion[][] = [];
  const budgets: Array<number | undefined> = [];
  const ask: AskFn = async (_sit, qs, opt) => {
    calls.push(qs);
    budgets.push(opt?.budgetMs);
    return qs.map((q) => {
      const a = answers[q.id];
      return a ? choice(q, a[0], a[1]) : choice(q, "NO");
    });
  };
  return { ask, calls, budgets };
}

const reader = (ask: AskFn | undefined, over: Partial<ReaderConfig> = {}) =>
  new RoutingReader({ ask, questions, cards: () => [], config: { ...on, ...over } });

describe("rankCandidates: one request, ordered USE and INSPIRE groups", () => {
  it("asks once, with a mode question per candidate and a part question where there are sections", async () => {
    const jev = scripted({});
    await reader(jev.ask).rankCandidates(input(), ITEMS);
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0].map((q) => q.id)).toEqual([
      "rank-mode-1",
      "rank-part-1",
      "rank-mode-2",
      "rank-part-2",
      "rank-mode-3",
      "rank-flat",
    ]);
  });

  it("returns the USE group and the INSPIRE group, each sorted, each entry labelled jev with its section", async () => {
    const jev = scripted({
      "rank-mode-1": ["USE", { USE: 0.85, INSPIRE: 0.1, NO: 0.05 }],
      "rank-mode-2": ["INSPIRE", { USE: 0.1, INSPIRE: 0.7, NO: 0.2 }],
      "rank-part-2": ["s2"],
      "rank-mode-3": ["USE", { USE: 0.4, INSPIRE: 0.1, NO: 0.5 }],
    });
    const r = await reader(jev.ask).rankCandidates(input(), ITEMS);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:family-trip", "skill:pdf-tools"]);
    expect(r.inspire).toHaveLength(1);
    expect(r.inspire[0]).toMatchObject({
      cardId: "recipe:review-site",
      source: "jev",
      mode: "INSPIRE",
      section: "Collect the choice",
      sectionSource: "jev",
    });
    expect(r.source).toBe("jev");
    expect(r.skip).toBeUndefined();
    expect(r.jevMs).toBeGreaterThanOrEqual(0);
  });

  it("sorts by the comparative answer when Jev gives one, and says so", async () => {
    const jev = scripted({
      "rank-mode-1": ["USE", { USE: 0.99 }],
      "rank-mode-2": ["USE", { USE: 0.9 }],
      "rank-mode-3": ["NO"],
      "rank-flat": ["c2", { c1: 0.1, c2: 0.8, c3: 0, none: 0.1 }],
    });
    const r = await reader(jev.ask).rankCandidates(input(), ITEMS);
    expect(r.use.map((e) => e.cardId)).toEqual(["recipe:review-site", "recipe:family-trip"]);
    expect(r.useScoreBasis).toBe("comparative");
  });

  it("passes its budget to the ask, defaulting to the reader's own", async () => {
    const jev = scripted({});
    await reader(jev.ask, { budgetMs: 2600 }).rankCandidates(input(), ITEMS);
    await reader(jev.ask, { budgetMs: 2600 }).rankCandidates(input(), ITEMS, { budgetMs: 1500 });
    expect(jev.budgets).toEqual([2600, 1500]);
  });

  it("an empty candidate list makes no call", async () => {
    const jev = scripted({});
    const r = await reader(jev.ask).rankCandidates(input(), []);
    expect(jev.calls).toHaveLength(0);
    expect(rankedList(r)).toEqual([]);
  });
});

describe("rankCandidates: an answer outside the offered ids degrades to local, never to Jev", () => {
  it("a mode Jev was not offered leaves that candidate local at its recall position", async () => {
    const jev = scripted({
      "rank-mode-1": ["PERHAPS"],
      "rank-mode-2": ["USE", { USE: 0.9 }],
      "rank-mode-3": ["NO"],
    });
    const r = await reader(jev.ask).rankCandidates(input(), ITEMS);
    const trip = rankedList(r).find((e) => e.cardId === "recipe:family-trip")!;
    expect(trip).toMatchObject({ source: "local", recallRank: 0 });
    expect(r.use.map((e) => [e.cardId, e.source])).toEqual([
      ["recipe:review-site", "jev"],
      ["recipe:family-trip", "local"],
    ]);
    expect(r.source).toBe("mixed");
    expect(r.skip).toBe("invalid");
  });

  it("a section id Jev was not offered is not taken as the section", async () => {
    const jev = scripted({
      "rank-mode-2": ["INSPIRE", { INSPIRE: 0.9 }],
      "rank-part-2": ["s7"],
    });
    const r = await reader(jev.ask).rankCandidates(input(), ITEMS);
    expect(r.inspire[0].cardId).toBe("recipe:review-site");
    expect(r.inspire[0].section).toBeUndefined();
  });

  it("all answers invalid: the list is local in recall order and says invalid", async () => {
    const jev = scripted({
      "rank-mode-1": ["x"],
      "rank-mode-2": ["y"],
      "rank-mode-3": ["z"],
    });
    const r = await reader(jev.ask).rankCandidates(input(), ITEMS);
    expect(r.source).toBe("local");
    expect(r.skip).toBe("invalid");
    expect(rankedList(r).map((e) => e.cardId)).toEqual([
      "recipe:family-trip",
      "recipe:review-site",
      "skill:pdf-tools",
    ]);
    expect(rankedList(r).every((e) => e.source === "local")).toBe(true);
  });
});

describe("rankCandidates: the privacy gate is the one RoutingReader uses", () => {
  it("makes no Jev call for a private source and reports not-allowed with the reason", async () => {
    const jev = scripted({});
    const r = await reader(jev.ask).rankCandidates(input({ source: "channel:whatsapp" }), ITEMS);
    expect(jev.calls).toHaveLength(0);
    expect(r).toMatchObject({ source: "local", skip: "not-allowed", skipDetail: "private-source" });
    expect(rankedList(r).map((e) => e.cardId)).toEqual(ITEMS.map((i) => i.cardId));
  });

  it("asks for a private source the operator approved, and for no other", async () => {
    const jev = scripted({});
    await reader(jev.ask, { jevApprovedSources: ["channel:whatsapp"] }).rankCandidates(
      input({ source: "channel:whatsapp" }),
      ITEMS,
    );
    expect(jev.calls).toHaveLength(1);
    await reader(jev.ask, { jevApprovedSources: ["channel:whatsapp"] }).rankCandidates(
      input({ source: "channel:mail" }),
      ITEMS,
    );
    expect(jev.calls).toHaveLength(1);
  });

  it("keeps a real conversation local unless real sending is on", async () => {
    const jev = scripted({});
    const r = await reader(jev.ask).rankCandidates(input({ synthetic: false }), ITEMS);
    expect(jev.calls).toHaveLength(0);
    expect(r).toMatchObject({ skip: "not-allowed", skipDetail: "real-not-allowed" });
    await reader(jev.ask, { sendRealSituations: true }).rankCandidates(
      input({ synthetic: false }),
      ITEMS,
    );
    expect(jev.calls).toHaveLength(1);
  });

  it("still keeps a private real source local when real sending is on", async () => {
    const jev = scripted({});
    await reader(jev.ask, { sendRealSituations: true }).rankCandidates(
      input({ synthetic: false, source: "channel:sms" }),
      ITEMS,
    );
    expect(jev.calls).toHaveLength(0);
  });

  it("while Jev is dormant (no token) it ranks locally and asks nothing", async () => {
    const jev = scripted({});
    const r = new RoutingReader({
      ask: jev.ask,
      questions,
      cards: () => [],
      config: { ...on },
      jevOn: () => false,
    });
    const out = await r.rankCandidates(input(), ITEMS);
    expect(out).toMatchObject({ skip: "not-allowed", skipDetail: "no-key" });
    expect(jev.calls).toHaveLength(0);
  });

  it("makes no call when Jev is off or there is no way to ask", async () => {
    const jev = scripted({});
    const off = await reader(jev.ask, { jevEnabled: false }).rankCandidates(input(), ITEMS);
    expect(off).toMatchObject({ skip: "not-allowed", skipDetail: "jev-off" });
    const noKey = await reader(undefined).rankCandidates(input(), ITEMS);
    expect(noKey).toMatchObject({ skip: "not-allowed", skipDetail: "no-key" });
    expect(jev.calls).toHaveLength(0);
  });
});

describe("rankCandidates: every way Jev can be silent gets its own label", () => {
  const skipAll =
    (why: NonNullable<JevVerdict["skipped"]>): AskFn =>
    async (_s, qs) =>
      qs.map((q) => choice(q, "", {}, { skipped: why, prob: 0, confidence: 0 }));

  it.each(["timeout", "breaker-open", "not-allowed", "error"] as const)(
    "a client that skips every question with %s gives a local list labelled %s",
    async (why) => {
      const r = await reader(skipAll(why)).rankCandidates(input(), ITEMS);
      expect(r).toMatchObject({ source: "local", skip: why });
      expect(rankedList(r)).toHaveLength(3);
    },
  );

  it("an ask that never answers is cut at the budget and labelled timeout, in about the budget", async () => {
    const hang: AskFn = () => new Promise<JevVerdict[]>(() => undefined);
    const t0 = Date.now();
    const r = await reader(hang).rankCandidates(input(), ITEMS, { budgetMs: 60 });
    const took = Date.now() - t0;
    expect(r).toMatchObject({ source: "local", skip: "timeout" });
    expect(r.jevMs).toBeGreaterThanOrEqual(50);
    expect(took).toBeLessThan(500);
    expect(rankedList(r).map((e) => e.cardId)).toEqual(ITEMS.map((i) => i.cardId));
  });

  it("an ask that rejects is labelled error", async () => {
    const r = await reader(async () => {
      throw new Error("network");
    }).rankCandidates(input(), ITEMS);
    expect(r).toMatchObject({ source: "local", skip: "error" });
  });

  it("an ask that throws before returning a promise is labelled error too", async () => {
    const r = await reader((() => {
      throw new Error("sync");
    }) as unknown as AskFn).rankCandidates(input(), ITEMS);
    expect(r).toMatchObject({ source: "local", skip: "error" });
  });

  it("an ask that fails after the budget does not become an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const slowFail: AskFn = () =>
        new Promise<JevVerdict[]>((_res, rej) => setTimeout(() => rej(new Error("late")), 80));
      const r = await reader(slowFail).rankCandidates(input(), ITEMS, { budgetMs: 20 });
      expect(r.skip).toBe("timeout");
      await new Promise((res) => setTimeout(res, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});
