import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevQuestion, JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import {
  previousUserTextOf as previousUserText,
  seedCards,
  toHistoryItem,
  type EnhancementCard,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it, vi } from "vitest";
import { loadQuestions } from "../src/reads/questions.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type AskFn,
  type ReaderConfig,
} from "../src/reads/routing-reader.js";
import { createTaskRanker, type TaskRankerDeps } from "../src/task-ranker.js";

// Phase E of the Broca retrieval v2 build: the one ranker the short-list seam and Broca's matcher hook share. Jev is mocked.

const questions = loadQuestions(join(dirname(fileURLToPath(import.meta.url)), "..", "questions"));
const NOW = 1_800_000_000_000;

const listing = (
  name: string,
  description: string,
  kind: "skill" | "recipe" = "skill",
  path?: string,
) => ({
  kind,
  name,
  description,
  ...(path ? { path } : {}),
});
const CARDS: EnhancementCard[] = seedCards([
  listing(
    "plan-family-trip",
    "Plan a family trip, flights, a motorhome and the holiday dates.",
    "recipe",
    "/r/plan-family-trip/recipe.md",
  ),
  listing("flight-scan", "Scan flight prices between two airports for a holiday."),
  listing("trip-planner", "Plan a trip itinerary day by day."),
  listing(
    "review-site",
    "Build a page the family reviews to choose between options.",
    "recipe",
    "/r/review-site/recipe.md",
  ),
  listing("amazon-shopper", "Compare Amazon listings and rank them by price per unit."),
  listing("torrent-scout", "Find a film torrent and verify its files before downloading."),
  listing("pdf-tools", "Extract text and tables from a PDF."),
]);
const FILES: Record<string, string> = {
  "/r/plan-family-trip/recipe.md": `---\ntitle: Plan a family trip\nsummary: flights and a motorhome for the family holiday\ntriggers: [family trip, motorhome holiday]\n---\n### 1. Pick dates\nx\n### 2. Flights\nx\n### 3. Motorhome\nx\n`,
  "/r/review-site/recipe.md": `---\ntitle: Review site\nsummary: a page the family reviews\n---\n### 1. Build the page\nx\n### 2. Collect the choice\nx\n`,
};

const on: ReaderConfig = { ...DEFAULT_READER_CONFIG, jevEnabled: true, sendRealSituations: true };
const choice = (
  q: JevQuestion,
  answer: string,
  probs: Record<string, number> = {},
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
  latencyMs: 100,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  ts: NOW,
});

/** Jev says USE to the first candidate it is asked about, INSPIRE to the first other one that has parts to point at, NO to the rest. */
function jev() {
  const seen: Array<{ text: unknown; ids: string[] }> = [];
  const ask: AskFn = async (sit, qs) => {
    seen.push({ text: (sit.request as { value: unknown }).value, ids: qs.map((q) => q.id) });
    const withParts = qs
      .map((q) => /^rank-part-(\d+)$/.exec(q.id)?.[1])
      .filter((k): k is string => k !== undefined && k !== "1");
    const inspired = withParts[0] ? `rank-mode-${withParts[0]}` : "";
    return qs.map((q) => {
      if (q.id === "rank-mode-1") return choice(q, "USE", { USE: 0.9, INSPIRE: 0.05, NO: 0.05 });
      if (q.id === inspired) return choice(q, "INSPIRE", { USE: 0.1, INSPIRE: 0.8, NO: 0.1 });
      if (q.id === "rank-flat") return choice(q, "c1", { c1: 0.9, none: 0.1 });
      if (q.id.startsWith("rank-part-")) return choice(q, "s1");
      return choice(q, "NO");
    });
  };
  return { ask: vi.fn(ask), seen };
}

function make(
  o: Partial<TaskRankerDeps> & {
    ask?: AskFn;
    cfg?: Partial<ReaderConfig>;
    cards?: EnhancementCard[];
  } = {},
) {
  const cards = o.cards ?? CARDS;
  const reader = new RoutingReader({
    ask: o.ask,
    questions,
    cards: () => cards,
    config: { ...on, ...o.cfg },
  });
  const rank = createTaskRanker({
    reader,
    cards: () => cards,
    readCard: (p) => FILES[p],
    history: () => [],
    recent: () => [],
    budgetMs: () => 1500,
    now: () => NOW,
    ...o,
  });
  return rank;
}

const tinker = { runId: "run-1", sessionKey: "agent:main:tinker:abc", trigger: "user" };
const TRIP = "Plan the summer motorhome holiday for the family with flights to Scotland.";

describe("the shared task ranker", () => {
  it("recalls candidates and has Jev split them, in one request, capped and labelled", async () => {
    const j = jev();
    const out = await make({ ask: j.ask })({ ...tinker, text: TRIP });
    expect(j.ask).toHaveBeenCalledTimes(1);
    expect(out.ranked).toBe(true);
    if (!out.ranked) return;
    expect(out.basis).toBe("own");
    expect(out.result.use.length).toBeLessThanOrEqual(3);
    expect(out.result.inspire.length).toBeLessThanOrEqual(3);
    expect(out.result.use[0]).toMatchObject({ mode: "USE", source: "jev" });
    expect(out.result.inspire[0]).toMatchObject({ mode: "INSPIRE", source: "jev" });
    expect(out.result.inspire[0].section).toBeTruthy();
    // the request carries the task text without any envelope
    expect(j.seen[0].text).toBe(TRIP);
  });

  it("is local and says so when Jev is off", async () => {
    const out = await make({ cfg: { jevEnabled: false } })({ ...tinker, text: TRIP });
    expect(out.ranked).toBe(true);
    if (!out.ranked) return;
    expect(out.result.source).toBe("local");
    expect(out.result.skip).toBe("not-allowed");
    expect(out.result.skipDetail).toBe("jev-off");
    expect([...out.result.use, ...out.result.inspire].every((e) => e.source === "local")).toBe(
      true,
    );
  });

  it.each([
    ["a subagent", { sessionKey: "agent:main:subagent:x" }, "subagent-or-cron"],
    ["a cron job", { sessionKey: "agent:main:cron:x" }, "subagent-or-cron"],
    ["a heartbeat", { trigger: "heartbeat" }, "heartbeat"],
    ["an inter-session message", { provenanceKind: "inter_session" }, "provenance"],
    [
      "a system notice",
      { text: "[System] the gateway restarted and your plans continue" },
      "notice",
    ],
    [
      "an exec notice",
      { text: "System (untrusted): exec finished with code 0 in the build folder" },
      "notice",
    ],
    [
      "a task notification",
      { text: "<task-notification><task-id>a</task-id></task-notification>" },
      "notice",
    ],
    [
      "an agent prompt",
      {
        text: "[Tue 2026-10-06 08:43 GMT+2] ⟦AGENT:📈 Thalamus⟧ Turn 03 of the build, phases E and F",
      },
      "notice",
    ],
  ])("owes %s no recommendation and never asks Jev", async (_n, over, why) => {
    const j = jev();
    const out = await make({ ask: j.ask })({ ...tinker, text: TRIP, ...over });
    expect(out).toEqual({ ranked: false, runId: "run-1", why });
    expect(j.ask).not.toHaveBeenCalled();
  });

  // Broca retrieval v2, phase E (replay section 11): recall's order with no Jev judgement is shown only where the old local list would be.
  it("is quiet when Jev judged nothing and the old local list would show nothing", async () => {
    const j = jev();
    const weak = "could you compare these two documents and tell me which one reads better overall";
    const out = await make({ cfg: { jevEnabled: false }, ask: j.ask })({ ...tinker, text: weak });
    expect(out).toEqual({ ranked: false, runId: "run-1", why: "local-quiet" });
    expect(j.ask).not.toHaveBeenCalled();
  });

  it("shows a local list when the old local list would too", async () => {
    const out = await make({ cfg: { jevEnabled: false } })({ ...tinker, text: TRIP });
    expect(out.ranked).toBe(true);
  });

  it("does not go quiet when Jev judged some of it", async () => {
    const j = jev();
    const weak = "could you compare these two documents and tell me which one reads better overall";
    const out = await make({ ask: j.ask })({ ...tinker, text: weak });
    expect(j.ask).toHaveBeenCalledTimes(1);
    expect(out.ranked).toBe(true);
    if (out.ranked) expect(out.result.source).not.toBe("local");
  });

  it("ranks a context-free follow-up on the previous user turn", async () => {
    const j = jev();
    const out = await make({ ask: j.ask })({
      ...tinker,
      text: "Make it so",
      previousUserText: TRIP,
    });
    expect(out.ranked && out.basis).toBe("previous");
    expect(j.seen[0].text).toBe(TRIP);
  });

  it("skips a context-free follow-up that has nothing before it", async () => {
    const j = jev();
    const out = await make({ ask: j.ask })({ ...tinker, text: "Make it so" });
    expect(out).toEqual({ ranked: false, runId: "run-1", why: "follow-up-no-context" });
    expect(j.ask).not.toHaveBeenCalled();
  });

  it("keeps a short request that names a card", async () => {
    const j = jev();
    const out = await make({ ask: j.ask })({ ...tinker, text: "use pdf-tools" });
    expect(out.ranked && out.basis).toBe("own");
  });

  it("says there are no candidates when nothing in the catalogue matches", async () => {
    const j = jev();
    const out = await make({ ask: j.ask })({
      ...tinker,
      text: "qwertyuiop asdfghjkl zxcvbnm poiuytre lkjhgfds mnbvcxzaq",
    });
    expect(out).toEqual({ ranked: false, runId: "run-1", why: "no-candidates" });
    expect(j.ask).not.toHaveBeenCalled();
  });

  it("follows the catalogue: a card added later is found", async () => {
    let cards = CARDS;
    const reader = new RoutingReader({
      ask: undefined,
      questions,
      cards: () => cards,
      config: { ...on, jevEnabled: false },
    });
    const live = createTaskRanker({
      reader,
      cards: () => cards,
      readCard: (p) => FILES[p],
      history: () => [],
      recent: () => [],
      budgetMs: () => 1500,
      now: () => NOW,
    });
    const text = "convert this spreadsheet of invoices into a ledger of quarterly figures";
    const before = await live({ ...tinker, text });
    expect(before.ranked).toBe(false);
    cards = [
      ...CARDS,
      ...seedCards([
        listing(
          "invoice-ledger",
          "Convert a spreadsheet of invoices into a ledger of quarterly figures.",
        ),
      ]),
    ];
    const after = await live({ ...tinker, text });
    expect(after.ranked).toBe(true);
    if (after.ranked)
      expect([...after.result.use, ...after.result.inspire].map((e) => e.cardId)).toContain(
        "skill:invoice-ledger",
      );
  });

  it("uses what the chat used before and what past tasks used", async () => {
    const text = "carry on with the next part of that";
    const withRecent = await make({
      cfg: { jevEnabled: false },
      recent: () => ["skill:torrent-scout"],
    })({
      ...tinker,
      text: `${text} for the film we were downloading earlier today`,
      previousUserText: undefined,
    });
    expect(
      withRecent.ranked &&
        [...withRecent.result.use, ...withRecent.result.inspire].map((e) => e.cardId),
    ).toContain("skill:torrent-scout");
    const withHistory = await make({
      cfg: { jevEnabled: false },
      history: () => [
        toHistoryItem("rank the amazon listings for a memory card by price per gigabyte", [
          "skill:amazon-shopper",
        ]),
      ],
    })({
      ...tinker,
      text: "rank these listings by price per gigabyte please for the new memory card",
    });
    expect(
      withHistory.ranked &&
        [...withHistory.result.use, ...withHistory.result.inspire].map((e) => e.cardId),
    ).toContain("skill:amazon-shopper");
  });
});

describe("the previous user turn", () => {
  const msgs = [
    { role: "user", content: "download the film Project Hail Mary in the best quality" },
    { role: "assistant", content: [{ type: "text", text: "found three candidates" }] },
    { role: "user", content: [{ type: "text", text: "Make it so" }] },
  ];
  it("is the last user message that is not the current prompt", () => {
    expect(previousUserText(msgs, "Make it so")).toBe(
      "download the film Project Hail Mary in the best quality",
    );
    expect(previousUserText(msgs, "something new")).toBe("Make it so");
  });
  it("is undefined when there is none, or the history is not a list", () => {
    expect(previousUserText([], "x")).toBeUndefined();
    expect(previousUserText(undefined, "x")).toBeUndefined();
    expect(previousUserText([{ role: "assistant", content: "hi" }], "x")).toBeUndefined();
  });
});
