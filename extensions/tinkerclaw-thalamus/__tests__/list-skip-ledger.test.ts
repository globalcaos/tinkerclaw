import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { JevQuestion, JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import { seedCards, type EnhancementCard } from "openclaw/plugin-sdk/fork-thalamus";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { loadQuestions } from "../src/reads/questions.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type AskFn,
  type ReaderConfig,
  type ReadInput,
} from "../src/reads/routing-reader.js";
import { createShortlistSeam } from "../src/shortlist-seam.js";
import { ThalamusStore, type UseRow } from "../src/store.js";
import { createUseTracker } from "../src/use-tracker.js";

// Broca retrieval v2, phase C: the ledger row says WHY a list was local (the review of 2026-10-05 could not count it)
// and how long the Jev call itself took, even when the prompt had moved on. The budget the prompt waits is a setting.

const tmp = mkdtempSync(join(tmpdir(), "thalamus-skip-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const questions = loadQuestions(join(dirname(fileURLToPath(import.meta.url)), "..", "questions"));
const cards: EnhancementCard[] = seedCards([
  {
    kind: "skill",
    name: "translation-checker",
    description: "Compares a translation with its source and repeats until they match.",
  },
  {
    kind: "skill",
    name: "photo-sorter",
    description: "Shows one photo at a time and records a keep or delete.",
  },
]);
const byId = new Map(cards.map((c) => [c.id, c]));

describe("the short-list budget is a setting that defaults to 1500 ms", () => {
  it("defaults to 1500 and takes the operator's value", () => {
    expect(parseConfig(undefined).shortlist.budgetMs).toBe(1500);
    expect(parseConfig({ shortlist: { budgetMs: 600 } }).shortlist.budgetMs).toBe(600);
    expect(parseConfig({ shortlist: { budgetMs: "fast" } }).shortlist.budgetMs).toBe(1500);
  });
});

describe("the ledger gains the skip columns in place", () => {
  const row = (over: Partial<UseRow> = {}): UseRow => ({
    taskId: "t1",
    ts: 1,
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
    mode: "shadow",
    ...over,
  });

  it("round-trips the reason, its detail and the Jev call time", () => {
    const store = new ThalamusStore(":memory:");
    store.upsertUse(row({ skipReason: "not-allowed", skipDetail: "private-source", jevMs: 640 }));
    expect(store.getUse("t1")).toMatchObject({
      skipReason: "not-allowed",
      skipDetail: "private-source",
      jevMs: 640,
    });
  });

  it("a row without a skip reason reads back without one", () => {
    const store = new ThalamusStore(":memory:");
    store.upsertUse(row());
    const got = store.getUse("t1")!;
    expect(got.skipReason).toBeUndefined();
    expect(got.skipDetail).toBeUndefined();
    expect(got.jevMs).toBeUndefined();
  });

  it("opens a ledger file made before the columns, keeps its rows, and adds them", () => {
    const file = join(tmp, "old.sqlite");
    const old = new Database(file);
    old.exec(`CREATE TABLE enh_uses(
      task_id TEXT PRIMARY KEY, ts INT, session TEXT, source TEXT, private INT, shuffled INT,
      shown_json TEXT, none_fits REAL, list_shown INT, list_reason TEXT, list_source TEXT,
      used_json TEXT, outcome TEXT, card_versions_json TEXT, question_version INT, mode TEXT);`);
    old
      .prepare(
        `INSERT INTO enh_uses VALUES('old1',5,'s','tinker',0,0,'[]',1,0,'not-asked','local','[]','done','{}',0,'shadow')`,
      )
      .run();
    old.close();
    const store = new ThalamusStore(file);
    expect(store.getUse("old1")).toMatchObject({ taskId: "old1", listSource: "local" });
    expect(store.getUse("old1")!.skipReason).toBeUndefined();
    store.upsertUse(row({ taskId: "new1", skipReason: "timeout", jevMs: 2100 }));
    expect(store.getUse("new1")).toMatchObject({ skipReason: "timeout", jevMs: 2100 });
  });
});

describe("the ledger carries the mode and source of each shown entry (Broca retrieval v2, phase F)", () => {
  const shownRow = (taskId: string, shown: UseRow["shown"]): UseRow => ({
    taskId,
    ts: 5,
    session: "s",
    source: "tinker",
    private: false,
    shuffled: false,
    shown,
    noneFits: 0.1,
    listShown: true,
    listReason: "shown",
    listSource: "jev",
    used: [],
    outcome: "done",
    cardVersions: {},
    questionVersion: 0,
    mode: "shadow",
  });
  const columns = (file: string, id: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db
        .prepare("SELECT shown_modes m, shown_sources s FROM enh_uses WHERE task_id=?")
        .get(id) as {
        m: string | null;
        s: string | null;
      };
    } finally {
      db.close();
    }
  };

  it("writes both columns in list order and keeps the fields on the entries", () => {
    const file = join(tmp, "modes.sqlite");
    const store = new ThalamusStore(file);
    store.upsertUse(
      shownRow("a", [
        { cardId: "skill:x", rank: 1, prob: 0.9, mode: "USE", source: "jev" },
        {
          cardId: "recipe:y",
          rank: 2,
          prob: 0,
          mode: "INSPIRE",
          source: "local",
          section: "Decide",
        },
        { cardId: "skill:z", rank: 3, prob: 0.2 },
      ]),
    );
    expect(columns(file, "a")).toEqual({ m: "USE,INSPIRE,?", s: "jev,local,?" });
    expect(store.getUse("a")!.shown[1]).toMatchObject({
      mode: "INSPIRE",
      source: "local",
      section: "Decide",
    });
    store.close();
  });

  it("an empty list writes empty columns", () => {
    const file = join(tmp, "empty.sqlite");
    const store = new ThalamusStore(file);
    store.upsertUse(shownRow("e", []));
    expect(columns(file, "e")).toEqual({ m: "", s: "" });
    store.close();
  });

  it("opens a file made with the phase C columns but not these, keeps its rows, and adds them", () => {
    const file = join(tmp, "phase-c.sqlite");
    const old = new Database(file);
    old.exec(`CREATE TABLE enh_uses(
      task_id TEXT PRIMARY KEY, ts INT, session TEXT, source TEXT, private INT, shuffled INT,
      shown_json TEXT, none_fits REAL, list_shown INT, list_reason TEXT, list_source TEXT,
      used_json TEXT, outcome TEXT, card_versions_json TEXT, question_version INT, mode TEXT,
      task_kind TEXT, skip_reason TEXT, skip_detail TEXT, jev_ms INT);`);
    old
      .prepare(
        `INSERT INTO enh_uses(task_id,ts,session,source,private,shuffled,shown_json,none_fits,list_shown,list_reason,list_source,used_json,outcome,card_versions_json,question_version,mode,skip_reason,jev_ms)
         VALUES('c1',5,'s','tinker',0,0,'[{"cardId":"skill:x","rank":1,"prob":0.5}]',0.5,1,'shown','jev','[]','done','{}',0,'shadow','timeout',900)`,
      )
      .run();
    old.close();
    const store = new ThalamusStore(file);
    expect(store.getUse("c1")).toMatchObject({ taskId: "c1", skipReason: "timeout", jevMs: 900 });
    expect(columns(file, "c1")).toEqual({ m: null, s: null });
    store.upsertUse(
      shownRow("c2", [{ cardId: "skill:x", rank: 1, prob: 1, mode: "USE", source: "jev" }]),
    );
    expect(columns(file, "c2")).toEqual({ m: "USE", s: "jev" });
    expect(store.getUse("c1")!.shown).toHaveLength(1);
    store.close();
  });
});

type Input = ReadInput & { runId: string };
const input = (over: Partial<Input> = {}): Input => ({
  id: "t1",
  runId: "run-1",
  ts: 1,
  sessionKey: "s",
  text: "Compare my translation with the source text and repeat until they match.",
  source: "tinker",
  trigger: "user",
  synthetic: true,
  ...over,
});

function setup(ask: AskFn | undefined, cfg: Partial<ReaderConfig> = {}, budgetMs = 500) {
  const store = new ThalamusStore(":memory:");
  const reader = new RoutingReader({
    ask,
    questions,
    cards: () => cards,
    config: { ...DEFAULT_READER_CONFIG, jevEnabled: true, ...cfg },
  });
  const tracker = createUseTracker({
    store: () => store,
    cards: () => byId,
    attribute: () => [],
    now: () => 1,
    mode: () => "shadow",
  });
  const seam = createShortlistSeam({
    reader,
    cards: () => cards,
    mode: () => "shadow",
    budgetMs: () => budgetMs,
    tracker,
  });
  return { seam, tracker, store };
}

const skippedAll =
  (why: NonNullable<JevVerdict["skipped"]>): AskFn =>
  async (_s, qs: JevQuestion[]) =>
    qs.map((q) => ({
      id: q.id,
      situationId: "t1",
      questionId: q.id,
      questionVersion: q.version,
      type: q.type,
      answer: q.type === "choice" ? "" : 0,
      prob: 0,
      confidence: 0,
      cacheHit: false,
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      skipped: why,
      ts: 1,
    }));

describe("the seam records why the list was local", () => {
  it("a private source: not-allowed, with the gate's reason, and no call", async () => {
    let called = 0;
    const { seam, tracker, store } = setup(async () => {
      called += 1;
      return [];
    });
    await seam.prepare(input({ source: "channel:whatsapp" }));
    tracker.finish("run-1", "done");
    expect(called).toBe(0);
    expect(store.getUse("run-1")).toMatchObject({
      skipReason: "not-allowed",
      skipDetail: "private-source",
    });
  });

  it("a real conversation with real sending off: not-allowed, real-not-allowed", async () => {
    const { seam, tracker, store } = setup(async () => []);
    await seam.prepare(input({ synthetic: false }));
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")).toMatchObject({
      skipReason: "not-allowed",
      skipDetail: "real-not-allowed",
    });
  });

  it("Jev still in flight when the budget ends: timeout, and the call's own time arrives later", async () => {
    const slow: AskFn = () =>
      new Promise<JevVerdict[]>((resolve) => setTimeout(() => resolve([]), 120));
    const { seam, tracker, store } = setup(slow, {}, 30);
    const out = await seam.prepare(input());
    expect(out.list.source).toBe("local");
    // the call finishes after the prompt has gone on, before the task ends
    await new Promise((r) => setTimeout(r, 250));
    tracker.finish("run-1", "done");
    const got = store.getUse("run-1")!;
    expect(got.skipReason).toBe("timeout");
    expect(got.jevMs).toBeGreaterThanOrEqual(100);
  });

  it("the client says breaker-open: the row says breaker-open", async () => {
    const { seam, tracker, store } = setup(skippedAll("breaker-open"));
    await seam.prepare(input());
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.skipReason).toBe("breaker-open");
  });

  it("the client says timeout: the row says timeout", async () => {
    const { seam, tracker, store } = setup(skippedAll("timeout"));
    await seam.prepare(input());
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.skipReason).toBe("timeout");
  });

  it("an ask that throws: error", async () => {
    const { seam, tracker, store } = setup(async () => {
      throw new Error("down");
    });
    await seam.prepare(input());
    tracker.finish("run-1", "done");
    expect(store.getUse("run-1")?.skipReason).toBe("error");
  });

  it("Jev answered: no skip reason, and the call time is recorded", async () => {
    const ask: AskFn = async (_s, qs) => {
      await new Promise((r) => setTimeout(r, 20));
      return qs.map((q) => ({
        id: q.id,
        situationId: "t1",
        questionId: q.id,
        questionVersion: q.version,
        type: q.type,
        answer:
          q.type === "choice" ? (q.id === "enh-flat" ? "skill:translation-checker" : "none") : 0.2,
        prob: 1,
        confidence: 0.9,
        probs:
          q.type === "choice"
            ? q.id === "enh-flat"
              ? { "skill:translation-checker": 0.9, none: 0.1 }
              : { none: 1 }
            : undefined,
        cacheHit: false,
        latencyMs: 20,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        ts: 1,
      })) as JevVerdict[];
    };
    const { seam, tracker, store } = setup(ask);
    const out = await seam.prepare(input());
    tracker.finish("run-1", "done");
    const got = store.getUse("run-1")!;
    expect(out.usedJev).toBe(true);
    expect(got.skipReason).toBeUndefined();
    expect(got.jevMs).toBeGreaterThanOrEqual(15);
  });
});
