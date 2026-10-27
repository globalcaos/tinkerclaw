// The anticipation note's memory pointers (2026-10-25): found for the owner's own prompt, recorded in watch, shown only
// in inject + enforce, and measured by the round the agent opened them in.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  seedCards,
  shortlistContext,
  type EnhancementCard,
  type PointerHit,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import { anticipateReport } from "../src/anticipate-report.js";
import { parseConfig, type AnticipateMode, type ThalamusMode } from "../src/config.js";
import type { PointerFind } from "../src/pointer-sources.js";
import { loadQuestions } from "../src/reads/questions.js";
import { DEFAULT_READER_CONFIG, RoutingReader } from "../src/reads/routing-reader.js";
import { createShortlistSeam, type PrepareInput } from "../src/shortlist-seam.js";
import { ThalamusStore, type UseRow } from "../src/store.js";
import { createUseTracker } from "../src/use-tracker.js";

const questions = loadQuestions(join(dirname(fileURLToPath(import.meta.url)), "..", "questions"));
const cards: EnhancementCard[] = seedCards([
  {
    kind: "skill",
    name: "translation-checker",
    path: "/s/tc/SKILL.md",
    description: "Compares a translation with its source and repeats until they match.",
  },
]);
const byId = new Map(cards.map((c) => [c.id, c]));

const NOTE: PointerHit = {
  kind: "note",
  id: "/home/o/memory/reference_translation_glossary.md",
  label: "The client's glossary for translations, and which terms stay in English",
  cover: 0.8,
  terms: 3,
  date: "2026-10-01",
};
const CHAT: PointerHit = {
  kind: "chat",
  id: "95c8c758-aaaa-bbbb-cccc-ddddeeeeffff",
  label: "Check the Catalan translation of the brochure",
  cover: 0.6,
  terms: 3,
  date: "2026-09-12",
};

const input = (over: Partial<PrepareInput> = {}): PrepareInput => ({
  id: "t1",
  runId: "run-1",
  ts: 1,
  sessionKey: "agent:main:tinker:abc",
  text: "Compare my translation with the source text and repeat until they match.",
  source: "tinker",
  trigger: "user",
  ...over,
});

function setup(
  mode: ThalamusMode,
  anticipate: AnticipateMode,
  o: { find?: (text: string) => PointerFind; inject?: boolean } = {},
) {
  const store = new ThalamusStore(":memory:");
  const reader = new RoutingReader({
    questions,
    cards: () => cards,
    config: { ...DEFAULT_READER_CONFIG },
  });
  const tracker = createUseTracker({
    store: () => store,
    cards: () => byId,
    attribute: () => [],
    now: () => 1,
    mode: () => mode,
  });
  const asked: string[] = [];
  const seam = createShortlistSeam({
    reader,
    cards: () => cards,
    mode: () => mode,
    ...(o.inject === undefined ? {} : { inject: () => o.inject as boolean }),
    budgetMs: () => 500,
    tracker,
    pointers: {
      mode: () => anticipate,
      find: (text) => {
        asked.push(text);
        return o.find ? o.find(text) : { notes: [NOTE], chats: [CHAT] };
      },
    },
  });
  return { seam, tracker, store, asked };
}

describe("memory pointers: shown only in inject + enforce, recorded in watch", () => {
  it("watch (the default) records the pointers and leaves the note exactly as before", async () => {
    const { seam, tracker, store } = setup("enforce", "watch");
    const out = await seam.prepare(input());
    expect(out.text).toBe(shortlistContext(out.list, byId));
    expect(out.text).not.toContain("Earlier work");
    expect(out.pointers?.map((p) => p.id)).toEqual([NOTE.id, CHAT.id]);
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.pointers).toEqual([
      { kind: "note", id: NOTE.id, cover: 0.8, terms: 3, injected: false },
      { kind: "chat", id: CHAT.id, cover: 0.6, terms: 3, injected: false },
    ]);
  });

  it("inject in enforce puts one line per pointer on the desk", async () => {
    const { seam, tracker, store } = setup("enforce", "inject");
    const out = await seam.prepare(input());
    expect(out.injected).toBe(true);
    expect(out.text).toContain(`- note: ${NOTE.label} (${NOTE.id})`);
    expect(out.text).toContain(`- past chat 2026-09-12: "${CHAT.label}" (session 95c8c758;`);
    expect(out.text).toContain("translation-checker");
    expect(out.text?.split("\n").at(-1)).toBe("None of these may fit; use your own judgment.");
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.pointers?.every((p) => p.injected)).toBe(true);
  });

  it("inject shows the pointers alone when no tool fits", async () => {
    const { seam } = setup("enforce", "inject");
    const out = await seam.prepare(
      input({ text: "where did we leave the glossary for the brochure work" }),
    );
    expect(out.list.shown).toBe(false);
    expect(out.injected).toBe(true);
    expect(out.text?.split("\n")[0]).toMatch(/^Earlier work that may already hold/);
  });

  it("inject in shadow, or with enforce.shortlist off, shows nothing and records the pointers as watched", async () => {
    for (const [mode, inject] of [
      ["shadow", undefined],
      ["enforce", false],
    ] as const) {
      const { seam, tracker, store } = setup(mode, "inject", { inject });
      const out = await seam.prepare(input());
      expect(out.text, mode).toBeUndefined();
      tracker.finish("run-1", "done");
      expect(
        store.getUse("run-1")?.pointers?.some((p) => p.injected),
        mode,
      ).toBe(false);
    }
  });

  it("off looks for nothing and records nothing", async () => {
    const { seam, tracker, store, asked } = setup("enforce", "off");
    const out = await seam.prepare(input());
    expect(out.pointers).toBeUndefined();
    expect(asked).toEqual([]);
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.pointers).toBeUndefined();
    expect(store.getUse("run-1")?.pointerSkip).toBeUndefined();
  });

  it("nothing when nothing fits: no line and no header", async () => {
    const { seam } = setup("enforce", "inject", { find: () => ({ notes: [], chats: [] }) });
    const out = await seam.prepare(
      input({ text: "where did we leave the glossary for the brochure work" }),
    );
    expect(out.text).toBeUndefined();
    expect(out.injected).toBe(false);
  });
});

describe("memory pointers: only the owner's own prompt, never a private source", () => {
  it("a cron run, a subagent, a channel chat or a runtime notice gets no pointers, and the ledger says why", async () => {
    const cases: Array<[Partial<PrepareInput>, string]> = [
      [{ trigger: "cron" }, "subagent-or-cron"],
      [{ sessionKey: "agent:main:subagent:x" }, "subagent-or-cron"],
      [
        { sessionKey: "agent:main:whatsapp:group:123", source: "channel:whatsapp" },
        "subagent-or-cron",
      ],
      [{ provenanceKind: "inter_session" }, "provenance"],
      [{ sessionKey: "agent:main:main", source: "channel:whatsapp" }, "private-source"],
    ];
    for (const [over, why] of cases) {
      const { seam, tracker, store, asked } = setup("enforce", "inject");
      const out = await seam.prepare(input(over));
      expect(out.pointers, why).toBeUndefined();
      expect(out.text ?? "", why).not.toContain("Earlier work");
      expect(asked, why).toEqual([]);
      tracker.finish("run-1", "done");
      expect(store.getUse("run-1")?.pointerSkip, JSON.stringify(over)).toBe(why);
    }
  });

  it("a follow-up with no subject of its own is matched on the turn before it", async () => {
    const { seam, asked } = setup("enforce", "inject");
    await seam.prepare(
      input({
        text: "do it again",
        previousUserText: "Check the Catalan translation of the brochure against the glossary",
      }),
    );
    expect(asked).toEqual(["Check the Catalan translation of the brochure against the glossary"]);
  });

  it("an index that is still building is recorded, and the prompt goes on", async () => {
    const { seam, tracker, store } = setup("enforce", "inject", {
      find: () => ({ skip: "index-building" }),
    });
    const out = await seam.prepare(input());
    expect(out.text).toBe(shortlistContext(out.list, byId));
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.pointerSkip).toBe("index-building");
  });
});

describe("rounds: does round 1 already know where to look", () => {
  it("counts the run's model calls and the round a tool first touched a pointer", async () => {
    const { seam, tracker, store } = setup("enforce", "inject");
    await seam.prepare(input());
    tracker.onCall("run-1", { phase: "usage", callIndex: 0 });
    tracker.onCall("run-1", { phase: "end", callIndex: 0 });
    tracker.onToolStart("run-1", { name: "Read", args: { file_path: NOTE.id } });
    tracker.onCall("run-1", { phase: "usage", callIndex: 1 });
    tracker.onToolStart("run-1", {
      name: "Bash",
      args: { command: `python3 -I sessions.py ask ${CHAT.id.slice(0, 8)} "what did we decide"` },
    });
    tracker.onCall("run-1", { phase: "end", callIndex: 1 });
    tracker.onCall("run-1", { phase: "end", callIndex: 2 });
    const row = tracker.finish("run-1", "done");
    expect(row?.rounds).toBe(3);
    expect(row?.pointers?.map((p) => [p.kind, p.usedRound])).toEqual([
      ["note", 1],
      ["chat", 2],
    ]);
    expect(store.getUse("run-1")).toMatchObject({ rounds: 3 });
  });

  it("a call event of a run with no list is ignored", () => {
    const { tracker } = setup("enforce", "inject");
    tracker.onCall("stranger", { phase: "end", callIndex: 4 });
    expect(tracker.open()).toBe(0);
  });

  it("the report splits tasks by pointers shown, watched or none", () => {
    const row = (over: Partial<UseRow>): UseRow => ({
      taskId: Math.random().toString(36),
      ts: 100,
      session: "s",
      source: "tinker",
      private: false,
      shuffled: false,
      shown: [],
      noneFits: 1,
      listShown: false,
      listReason: "not-asked",
      listSource: "local",
      used: [],
      outcome: "done",
      cardVersions: {},
      questionVersion: 0,
      mode: "enforce",
      ...over,
    });
    const p = (injected: boolean, usedRound?: number) => ({
      kind: "note" as const,
      id: "/m/a.md",
      cover: 0.7,
      terms: 3,
      injected,
      ...(usedRound ? { usedRound } : {}),
    });
    const r = anticipateReport(
      [
        row({ rounds: 4 }),
        row({ rounds: 1, pointerSkip: "index-building" }),
        row({ rounds: 3, pointers: [p(false, 3)] }),
        row({ rounds: 5, pointers: [p(false)] }),
        row({ rounds: 1, pointers: [p(true, 1)] }),
        row({ ts: 1, rounds: 9, pointers: [p(true, 9)] }),
      ],
      50,
    );
    expect(r.tasks).toBe(5);
    expect(r.none).toMatchObject({ tasks: 2, meanRounds: 2.5, oneRound: 0.5, pointerOpened: 0 });
    expect(r.watched).toMatchObject({
      tasks: 2,
      meanRounds: 4,
      pointerOpened: 1,
      meanOpenRound: 3,
      roundsBeforeOpen: 2,
    });
    expect(r.shown).toMatchObject({ tasks: 1, oneRound: 1, pointerOpened: 1, meanOpenRound: 1 });
    expect(r.skips).toEqual({ "index-building": 1 });
    expect(r.found).toEqual({ note: 3, chat: 0 });
  });
});

describe("anticipate config", () => {
  it("defaults to watch, with the agent workspace's notes and the ask-session catalogue", () => {
    const c = parseConfig({});
    expect(c.anticipate).toMatchObject({ mode: "watch", noteDirs: [], maxNotes: 2, maxChats: 1 });
    expect(c.anticipate.chatCatalog).toMatch(/ask-session\/catalog\.sqlite$/);
  });

  it("a misspelt mode is off; caps are clamped; an empty catalogue path switches the chat leg off", () => {
    const c = parseConfig({
      anticipate: {
        mode: "on",
        maxNotes: 9,
        maxChats: -1,
        chatCatalog: "",
        noteDirs: ["~/notes", ""],
      },
    });
    expect(c.anticipate.mode).toBe("off");
    expect(c.anticipate.maxNotes).toBe(3);
    expect(c.anticipate.maxChats).toBe(0);
    expect(c.anticipate.chatCatalog).toBe("");
    expect(c.anticipate.noteDirs).toHaveLength(1);
    expect(c.anticipate.noteDirs[0]).not.toContain("~");
    expect(parseConfig({ anticipate: { mode: "inject" } }).anticipate.mode).toBe("inject");
  });
});
