import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  seedCards,
  shortlistContext,
  type EnhancementCard,
  type RankedEntry,
  type RankResult,
  type TaskRankInput,
  type TaskRanking,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it, vi } from "vitest";
import type { ThalamusMode } from "../src/config.js";
import { loadQuestions } from "../src/reads/questions.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type AskFn,
  type ReaderConfig,
  type ReadInput,
} from "../src/reads/routing-reader.js";
import { createShortlistSeam } from "../src/shortlist-seam.js";
import { ThalamusStore } from "../src/store.js";
import { createUseTracker } from "../src/use-tracker.js";

const questions = loadQuestions(join(dirname(fileURLToPath(import.meta.url)), "..", "questions"));
const cards: EnhancementCard[] = seedCards([
  {
    kind: "skill",
    name: "translation-checker",
    path: "/s/tc/SKILL.md",
    description: "Compares a translation with its source and repeats until they match.",
  },
  {
    kind: "skill",
    name: "photo-sorter",
    description: "Shows one photo at a time and records a keep or delete decision.",
  },
  {
    kind: "skill",
    name: "gateway-restart",
    description: "Restarts the gateway and checks the chats continue.",
  },
]);
const byId = new Map(cards.map((c) => [c.id, c]));

const input = (
  over: Partial<ReadInput & { runId: string }> = {},
): ReadInput & { runId: string } => ({
  id: "t1",
  runId: "run-1",
  ts: 1,
  sessionKey: "s",
  text: "Compare my translation with the source text and repeat until they match.",
  source: "tinker",
  trigger: "user",
  ...over,
});

function setup(
  mode: ThalamusMode,
  o: {
    ask?: AskFn;
    cfg?: Partial<ReaderConfig>;
    cards?: EnhancementCard[];
    budgetMs?: number;
    inject?: boolean;
    ranking?: (i: TaskRankInput) => Promise<TaskRanking> | undefined;
  } = {},
) {
  const store = new ThalamusStore(":memory:");
  const list = o.cards ?? cards;
  const reader = new RoutingReader({
    ask: o.ask,
    questions,
    cards: () => list,
    config: { ...DEFAULT_READER_CONFIG, ...o.cfg },
  });
  const tracker = createUseTracker({
    store: () => store,
    cards: () => byId,
    attribute: () => [],
    now: () => 1,
    mode: () => mode,
  });
  const seam = createShortlistSeam({
    reader,
    cards: () => list,
    mode: () => mode,
    ...(o.inject === undefined ? {} : { inject: () => o.inject as boolean }),
    ...(o.ranking ? { ranking: o.ranking } : {}),
    budgetMs: () => o.budgetMs ?? 500,
    tracker,
  });
  return { seam, tracker, store };
}

describe("the short-list seam: shadow computes and records, only enforce hands over", () => {
  it("shadow leaves the agent's context untouched and still records the list", async () => {
    const { seam, tracker, store } = setup("shadow");
    const out = await seam.prepare(input());
    expect(out.text).toBeUndefined();
    expect(out.injected).toBe(false);
    expect(out.list.shown).toBe(true);
    expect(out.list.entries[0].cardId).toBe("skill:translation-checker");
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")).toMatchObject({ listShown: true, mode: "shadow" });
    expect(store.getUse("run-1")!.shown[0].cardId).toBe("skill:translation-checker");
  });

  // 2026-10-02 18:20: the gateway's restart resume went to the agent behind this advice, and the architect saw a prompt he
  // never wrote. A note from the gateway, a skill or another agent is not a task from the user: no list for it.
  it("an agent's or the gateway's message gets no advice, in enforce too", async () => {
    const { seam } = setup("enforce");
    for (const text of [
      "[System] The gateway restarted and interrupted your previous turn. Resume it.",
      "[Fri 2026-10-02 18:19 GMT+2] [System] continue the translation",
      "[System · longjob] the translation check finished",
      "[injected: claude-code] compare my translation with the source text",
      '<cross-session-message from="x" from-name="w">compare the translation</cross-session-message>',
      "⟦AGENT:Parallel worker⟧ compare my translation with the source text",
      "[Sat 2026-10-03 08:40 GMT+2] ⟦OVERSEER⟧ check the translation loop",
    ]) {
      const out = await seam.prepare(input({ text }));
      expect(out.injected, text).toBe(false);
      expect(out.text, text).toBeUndefined();
    }
    expect((await seam.prepare(input())).injected).toBe(true);
  });

  it("enforce adds exactly the list, and nothing else", async () => {
    const { seam } = setup("enforce");
    const out = await seam.prepare(input());
    expect(out.injected).toBe(true);
    expect(out.text).toBe(shortlistContext(out.list, byId));
    expect(out.text).toContain("translation-checker");
    expect(out.text).toContain("None of these may fit");
  });

  it("enforce with enforce.shortlist off still records the list but injects nothing, as shadow does", async () => {
    const { seam, tracker, store } = setup("enforce", { inject: false });
    const out = await seam.prepare(input());
    expect(out.injected).toBe(false);
    expect(out.text).toBeUndefined();
    expect(out.list.shown).toBe(true);
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")).toMatchObject({ listShown: true, mode: "enforce" });
  });

  it("enforce with enforce.shortlist on injects the list", async () => {
    const { seam } = setup("enforce", { inject: true });
    const out = await seam.prepare(input());
    expect(out.injected).toBe(true);
    expect(out.text).toContain("translation-checker");
  });

  it("off computes nothing and adds nothing", async () => {
    const { seam, tracker } = setup("off");
    const out = await seam.prepare(input());
    expect(out).toMatchObject({ injected: false, usedJev: false });
    expect(out.text).toBeUndefined();
    expect(tracker.open()).toBe(0);
  });

  it("adds nothing even in enforce when the list is not shown", async () => {
    const { seam } = setup("enforce");
    const out = await seam.prepare(input({ text: "what is the weather like" }));
    expect(out.list.shown).toBe(false);
    expect(out.text).toBeUndefined();
    expect(out.injected).toBe(false);
  });

  it("adds nothing in enforce when there are no cards at all", async () => {
    const { seam } = setup("enforce", { cards: [] });
    const out = await seam.prepare(input());
    expect(out.injected).toBe(false);
    expect(out.list.reason).toBe("not-asked");
  });

  it("is advice: the note never orders, and always allows none", async () => {
    const { seam } = setup("enforce");
    const out = await seam.prepare(input());
    expect(out.text).toMatch(/advice/);
    expect(out.text).toMatch(/take none/);
    expect(out.text).not.toMatch(/\b(must|you have to|required)\b/i);
  });
});

describe("the short-list seam: never late, never wrong about privacy", () => {
  it("falls back to the instant local list when Jev is slower than the budget", async () => {
    const slow: AskFn = () => new Promise(() => {});
    const { seam } = setup("enforce", { ask: slow, cfg: { jevEnabled: true }, budgetMs: 30 });
    const t0 = Date.now();
    const out = await seam.prepare(input({ synthetic: true }));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out.list.source).toBe("local");
    expect(out.usedJev).toBe(false);
  });

  it("falls back when Jev throws", async () => {
    const boom: AskFn = async () => {
      throw new Error("down");
    };
    const { seam } = setup("shadow", { ask: boom, cfg: { jevEnabled: true } });
    const out = await seam.prepare(input({ synthetic: true }));
    expect(out.list.source).toBe("local");
  });

  it("makes no Jev call for a private source, and the list comes from local word matching", async () => {
    const ask = vi.fn<AskFn>(async () => []);
    const { seam, tracker, store } = setup("shadow", {
      ask,
      cfg: { jevEnabled: true, sendRealSituations: true },
    });
    const out = await seam.prepare(input({ source: "channel:whatsapp" }));
    expect(ask).not.toHaveBeenCalled();
    expect(out.list.source).toBe("local");
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")).toMatchObject({ private: true, source: "channel:whatsapp" });
  });

  it("makes no Jev call for a real conversation unless real sending is on", async () => {
    const ask = vi.fn<AskFn>(async () => []);
    const { seam } = setup("shadow", { ask, cfg: { jevEnabled: true } });
    await seam.prepare(input());
    expect(ask).not.toHaveBeenCalled();
  });
});

// Broca retrieval v2, phase E: the seam reads the one ranked result per task the matcher hook reads too.
describe("the short-list seam on the shared ranking", () => {
  const entry = (
    cardId: string,
    mode: "USE" | "INSPIRE",
    source: "jev" | "local",
    score: number,
    section?: string,
  ): RankedEntry => ({
    cardId,
    mode,
    source,
    score,
    modeScore: score,
    recallRank: 0,
    ...(section ? { section, sectionSource: source } : {}),
  });
  const ranked = (over: Partial<RankResult> = {}): TaskRanking => ({
    ranked: true,
    runId: "run-1",
    basis: "own",
    result: {
      use: [entry("skill:translation-checker", "USE", "jev", 0.9)],
      inspire: [entry("skill:photo-sorter", "INSPIRE", "jev", 0.4, "Decide")],
      source: "jev",
      asked: 2,
      answered: 2,
      dropped: 0,
      jevMs: 290,
      ...over,
    },
  });
  const tinker = { sessionKey: "agent:main:tinker:abc" };

  it("builds the list from the ranking and records the mode, source and section of each entry", async () => {
    const ranking = vi.fn(() => Promise.resolve(ranked()));
    const { seam, tracker, store } = setup("enforce", { ranking });
    const out = await seam.prepare(input(tinker));
    expect(ranking).toHaveBeenCalledTimes(1);
    expect(ranking.mock.calls[0][0]).toMatchObject({
      runId: "run-1",
      sessionKey: tinker.sessionKey,
    });
    expect(out.usedJev).toBe(true);
    expect(out.list.entries.map((e) => [e.cardId, e.mode, e.source, e.section])).toEqual([
      ["skill:translation-checker", "USE", "jev", undefined],
      ["skill:photo-sorter", "INSPIRE", "jev", "Decide"],
    ]);
    expect(out.text).toContain('the "Decide" part');
    tracker.finish("run-1", "done");
    const row = store.getUse("run-1")!;
    expect(row.shown.map((e) => [e.mode, e.source])).toEqual([
      ["USE", "jev"],
      ["INSPIRE", "jev"],
    ]);
    expect(row.listSource).toBe("jev");
    expect(row.jevMs).toBe(290);
  });

  it("carries the skip reason of a partly local ranking into the ledger row", async () => {
    const ranking = () =>
      Promise.resolve(
        ranked({
          use: [entry("skill:translation-checker", "USE", "local", 0)],
          inspire: [],
          source: "local",
          skip: "timeout",
        }),
      );
    const { seam, tracker, store } = setup("shadow", { ranking });
    const out = await seam.prepare(input(tinker));
    expect(out.usedJev).toBe(false);
    expect(out.text).toBeUndefined();
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")).toMatchObject({ listSource: "local", skipReason: "timeout" });
  });

  it("shows nothing, and records why, when the prompt is not owed a list", async () => {
    const ranking = () =>
      Promise.resolve<TaskRanking>({ ranked: false, runId: "run-1", why: "follow-up-no-context" });
    const { seam, tracker, store } = setup("enforce", { ranking });
    const out = await seam.prepare(input({ ...tinker, text: "yes do it" }));
    expect(out.list.shown).toBe(false);
    expect(out.text).toBeUndefined();
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")).toMatchObject({
      listShown: false,
      skipDetail: "follow-up-no-context",
    });
  });

  it("shows nothing and records `local-quiet` when the ranker had only recall's order to offer", async () => {
    const ranking = () =>
      Promise.resolve<TaskRanking>({ ranked: false, runId: "run-1", why: "local-quiet" });
    const { seam, tracker, store } = setup("enforce", { ranking });
    const out = await seam.prepare(input(tinker));
    expect(out.list.shown).toBe(false);
    expect(out.text).toBeUndefined();
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")).toMatchObject({ listShown: false, skipDetail: "local-quiet" });
  });

  it("falls back to the instant local list when the ranking is late", async () => {
    const ranking = () => new Promise<TaskRanking>(() => undefined);
    const { seam, tracker, store } = setup("shadow", { ranking, budgetMs: 20 });
    const out = await seam.prepare(input(tinker));
    expect(out.usedJev).toBe(false);
    expect(out.list.entries[0]?.cardId).toBe("skill:translation-checker");
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.skipReason).toBe("timeout");
  });

  it("keeps the flat read for a session that is not interactive, and never asks the ranking", async () => {
    const ranking = vi.fn(() => Promise.resolve(ranked()));
    const { seam } = setup("shadow", { ranking });
    const out = await seam.prepare(
      input({ sessionKey: "agent:main:whatsapp:1", source: "channel:whatsapp" }),
    );
    expect(ranking).not.toHaveBeenCalled();
    expect(out.list.entries[0].cardId).toBe("skill:translation-checker");
    expect(out.list.entries[0].mode).toBeUndefined();
  });

  it.each([
    "System (untrusted): exec completed",
    "<task-notification><task-id>x</task-id></task-notification>",
    "[Tue 2026-10-06 08:43 GMT+2] ⟦AGENT:📈 Thalamus⟧ Turn 03",
  ])("gives a marked notice no list and never asks the ranking: %s", async (text) => {
    const ranking = vi.fn(() => Promise.resolve(ranked()));
    const { seam } = setup("enforce", { ranking });
    const out = await seam.prepare(input({ ...tinker, text }));
    expect(ranking).not.toHaveBeenCalled();
    expect(out.list.shown).toBe(false);
    expect(out.text).toBeUndefined();
  });

  it("without a ranking dependency it reads as before", async () => {
    const { seam } = setup("shadow");
    const out = await seam.prepare(input(tinker));
    expect(out.list.entries[0].cardId).toBe("skill:translation-checker");
  });
});
