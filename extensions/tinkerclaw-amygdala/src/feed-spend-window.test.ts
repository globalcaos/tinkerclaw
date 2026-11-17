/**
 * FORK 2026-10-29: the feed's cheap reads answer as the reads they replace did.
 * - The 30-day spend adds cached whole days to two live edges. It must equal one SUM over [now - 30 x 24 h, now) at
 *   any `now`: over the 25 h day of 2026-10-25, at a local midnight, after a replay writes or deletes past verdicts,
 *   after a prune, and when those writes come through a second store open on the same file.
 * - todayCounts counts by kind in SQL and must equal counting the parsed rows.
 * - The feed reads its decisions once and must return what each helper reading the store itself returned.
 * Every database here is a temp file under the OS temp folder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "./config.js";
import { questionRows, rebuildEvents } from "./feed.js";
import { QuestionBook } from "./question-book.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { buildSituation } from "./situation.js";
import { dayBounds, spendBetween, spendLast30Days, spendToday, type Spend } from "./spend.js";
import { AmygdalaStore } from "./store.js";
import type { Intervention, Response, Situation, Verdict } from "./types.js";

const EXT = fileURLToPath(new URL("..", import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 30 * DAY;
/** The config's default rate, so the runtime's figures compare with these. */
const RATE = 0.92;

const dirs: string[] = [];
const stores: AmygdalaStore[] = [];
const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) {
    r.stop();
  }
  for (const s of stores.splice(0)) {
    s.close();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "amy-feed-cheap-"));
  dirs.push(d);
  return d;
}

function openStore(path: string): AmygdalaStore {
  const s = new AmygdalaStore(path);
  stores.push(s);
  return s;
}

function situation(
  id: string,
  ts: number,
  sessionKey = "tab-a",
  turnId = `${sessionKey}#1`,
): Situation {
  const s = buildSituation(
    {
      seam: "pre-tool",
      sessionKey,
      turnId,
      now: ts,
      tool: "Bash",
      toolInput: { command: `ls /work/demo/${id}` },
    },
    { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
  );
  return { ...s, id };
}

/**
 * Verdict number `k` of a fixture. Its cost is a whole multiple of 2^-12 USD, so sums added in any order give the same
 * float and a windowed total compares with one SUM exactly. Every 5th is a cache hit and every 11th was skipped.
 */
function verdict(
  id: string,
  ts: number,
  situationId: string,
  k: number,
  over: Partial<Verdict> = {},
): Verdict {
  return {
    id,
    situationId,
    questionId: "danger-level",
    questionVersion: 1,
    type: "score",
    answer: k % 4,
    prob: 0.25,
    confidence: 0.9,
    cacheHit: k % 5 === 0,
    latencyMs: 40,
    tokensIn: 100 + k,
    tokensOut: 5 + (k % 3),
    costUsd: ((k % 7) + 1) / 4096,
    ...(k % 11 === 0 ? { skipped: "timeout" as const } : {}),
    ts,
    ...over,
  };
}

// Madrid times (dayBounds' default zone). Every window below holds the 25 h day of 2026-10-25.
const A = Date.UTC(2026, 10, 10, 11, 0); // 10 Nov 12:00
const B = Date.UTC(2026, 10, 10, 22, 59, 59, 999); // 10 Nov 23:59:59.999; its window opens 12 Oct 00:59 summer time
const C = Date.UTC(2026, 10, 10, 23, 0); // 11 Nov 00:00, a local midnight
const D = C + 1;
const E = Date.UTC(2026, 10, 11, 9, 30); // 11 Nov 10:30
const F = Date.UTC(2026, 10, 11, 22, 30); // 11 Nov 23:30; its window opens 13 Oct 00:30 summer time
const NOWS = [A, B, C, D, E, F];

/** A verdict every 3 h over 35 days, and one on each side of every edge of the windows above and of their days. */
function seedWindow(store: AmygdalaStore): void {
  store.saveSituation(situation("live", A - 33 * DAY));
  const vs: Verdict[] = [];
  let k = 0;
  for (let ts = A - 33 * DAY; ts < F + DAY; ts += 3 * HOUR) {
    vs.push(verdict(`g${k}`, ts, "live", k));
    k += 1;
  }
  for (const now of NOWS) {
    const oldestEnd = dayBounds(now - WINDOW).end;
    const todayStart = dayBounds(now).start;
    const edges = [
      now - WINDOW - 1,
      now - WINDOW,
      oldestEnd - 1,
      oldestEnd,
      todayStart - 1,
      todayStart,
      now - 1,
      now,
    ];
    for (const ts of edges) {
      vs.push(verdict(`e${k}`, ts, "live", k));
      k += 1;
    }
  }
  store.saveVerdicts(vs);
}

/** The 30-day spend at `now`, and how many range sums the store ran for it. */
function windowed(store: AmygdalaStore, now: number): { spend: Spend; sums: number } {
  const spy = vi.spyOn(store, "verdictSpend");
  try {
    const spend = spendLast30Days(store, now, RATE);
    return { spend, sums: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

/** One SUM over the whole window: the feed's eur30 before 2026-10-29. */
function naive(store: AmygdalaStore, now: number): Spend {
  return spendBetween(store, now - WINDOW, now, RATE);
}

describe("spendLast30Days: the 30-day spend from cached whole days", () => {
  it("equals one SUM over [now - 30 days, now) at each now, and sums each whole day once", () => {
    const store = openStore(join(tempDir(), "amygdala.sqlite"));
    seedWindow(store);
    // Verdicts stamped later today than A: spendToday counts them, the window must not.
    expect(spendBetween(store, A, dayBounds(A).end, RATE).usd).toBeGreaterThan(0);
    const sums: number[] = [];
    for (const now of NOWS) {
      const w = windowed(store, now);
      expect(w.spend).toEqual(naive(store, now));
      sums.push(w.sums);
    }
    // A: both edges and the 29 whole days between them. B: the same day; its oldest day moved one on and every whole
    // day was summed already. C: the day that just ended is summed once. D, E and F: the two edges only.
    expect(sums).toEqual([31, 2, 3, 2, 2, 2]);
  });

  it("a replay's past verdicts, their deletion and a prune drop the cached days, through either store on the file", () => {
    const path = join(tempDir(), "amygdala.sqlite");
    const a = openStore(path);
    seedWindow(a);
    // A second store on the same file: the gateway runs register() more than once in one process.
    const b = openStore(path);
    const check = (sums: number): void => {
      const w = windowed(a, E);
      expect(w.spend).toEqual(naive(a, E));
      expect(w.sums).toBe(sums);
    };
    // At E: the two edges and the 29 whole days from 13 Oct to 10 Nov.
    const ALL = 31;
    check(ALL);
    check(2);

    // A verdict stamped now lands in today, after every cached day: they stay.
    b.saveVerdicts([verdict("now-1", E - 1000, "live", 3)]);
    check(2);

    // A replay of an exchange ten days back stamps its verdicts with that time, inside a cached day.
    const at = E - 10 * DAY;
    const turnId = `tab-a#replay-${at}`;
    b.saveSituation(situation("rp", at, "tab-a", turnId));
    b.saveVerdicts([verdict("rp-1", at, "rp", 2), verdict("rp-2", at + 60_000, "rp", 4)]);
    check(ALL);
    check(2);

    // Replaying it again first deletes what it recorded.
    b.deleteReplayTurn(turnId);
    check(ALL);
    check(2);

    // Retention nulls old records and moves no verdict; the cached days are dropped all the same.
    expect(b.pruneRecords(E - 20 * DAY)).toBeGreaterThan(0);
    check(ALL);
  });
});

describe("todayCounts and the feed, reading today's decisions once", () => {
  const NOW = Date.UTC(2026, 10, 10, 15, 0); // 10 Nov 16:00 in Madrid
  const TAB = "agent:main:tinker:tab-a";
  const OTHER = "agent:main:tinker:tab-b";

  /** Two tabs: a decision yesterday, seven today (one stamped later than now), with verdicts and interventions. */
  function seed(store: AmygdalaStore): void {
    const { start } = dayBounds(NOW);
    const hold: Response = {
      kind: "hold",
      ruleOrQuestion: "danger-level",
      releasable: "user-only",
    };
    const ask: Response = {
      kind: "ask",
      askId: "which-copy",
      options: [
        { id: "a", label: "Copy A" },
        { id: "b", label: "Copy B" },
      ],
    };
    const note: Response = {
      kind: "note",
      templateId: "t-note",
      slots: {},
      channel: "additionalContext",
    };
    const rows: {
      id: string;
      ts: number;
      tab: string;
      response: Response;
      state?: Intervention["state"];
    }[] = [
      { id: "y1", ts: start - 1, tab: TAB, response: hold, state: "open" },
      { id: "d0", ts: start, tab: TAB, response: ask, state: "released" },
      { id: "d1", ts: start + HOUR, tab: TAB, response: { kind: "proceed" } },
      { id: "d2", ts: start + 4 * HOUR, tab: OTHER, response: hold, state: "denied" },
      { id: "d3", ts: start + 5 * HOUR, tab: TAB, response: note, state: "settled" },
      { id: "d4", ts: start + 6 * HOUR, tab: OTHER, response: { kind: "refusal" }, state: "open" },
      { id: "d5", ts: start + 7 * HOUR, tab: TAB, response: { kind: "proceed" } },
      { id: "d6", ts: NOW + HOUR, tab: TAB, response: hold, state: "open" },
    ];
    let k = 1;
    for (const r of rows) {
      const sid = `s-${r.id}`;
      store.saveSituation(situation(sid, r.ts, r.tab));
      const vs = [
        verdict(`v-${r.id}-1`, r.ts, sid, k),
        verdict(`v-${r.id}-2`, r.ts, sid, k + 1, {
          questionId: "runs-or-quotes",
          type: "noul",
          answer: 0.2,
        }),
      ];
      k += 2;
      store.saveVerdicts(vs);
      store.saveDecision(
        {
          situationId: sid,
          response: r.response,
          family: "safety",
          reasonCode: "table-d3-low[danger-level]",
          verdictIds: vs.map((v) => v.id),
          mode: "shadow",
          enforced: false,
          degraded: false,
        },
        { id: r.id, seam: "pre-tool", ts: r.ts },
      );
      if (r.state) {
        store.openIntervention({
          id: `iv-${r.id}`,
          decisionId: r.id,
          kind: r.response.kind,
          state: r.state,
          ts: r.ts,
        });
      }
    }
    // Judged: today's d2 agreed, yesterday's y1 did not. A feed that let yesterday into today's rows shows 0.5.
    for (const [target, value] of [
      ["d2", 1],
      ["y1", -1],
    ] as const) {
      store.addLabel({
        id: `l-${target}`,
        targetId: target,
        targetKind: "decision",
        kind: "judge",
        value,
        source: "user",
        weight: 3,
        ts: NOW - HOUR,
      });
    }
    // A month of older verdicts, so the 30-day spend has whole days to cache.
    store.saveSituation(situation("old", NOW - 32 * DAY));
    const old: Verdict[] = [];
    for (let ts = NOW - 32 * DAY; ts < start; ts += 6 * HOUR) {
      old.push(verdict(`o${k}`, ts, "old", k));
      k += 1;
    }
    store.saveVerdicts(old);
  }

  function setup(): { rt: Runtime; store: AmygdalaStore; book: QuestionBook; start: number } {
    const root = tempDir();
    const dataDir = join(root, "data");
    const store = openStore(join(dataDir, "amygdala.sqlite"));
    seed(store);
    const rt = createRuntime({
      config: parseConfig({ dataDir, hooks: { enabled: false } }),
      extensionRoot: EXT,
      gatewayPort: 1,
      v31: { readPluginConfig: () => undefined, settingsPath: join(root, "none.json") },
      apiKey: () => undefined,
      jevOn: () => false,
      emit: () => {},
      now: () => NOW,
      logger: { info() {}, warn() {}, error() {} },
      families: [],
    });
    runtimes.push(rt);
    rt.start();
    const book = new QuestionBook({
      seedDir: join(EXT, "questions"),
      overlayDir: join(dataDir, "questions.d"),
    });
    return { rt, store, book, start: dayBounds(NOW).start };
  }

  it("todayCounts counts by kind in SQL as counting the parsed rows did", () => {
    const { rt, store, start } = setup();
    // As todayCounts read them before 2026-10-29: every decision since today's start, parsed, by response kind.
    const rows = store.decisionsSince(start);
    const old = {
      checks: rows.length,
      held: rows.filter((r) => r.response.kind === "hold").length,
      asked: rows.filter((r) => r.response.kind === "ask").length,
    };
    // Yesterday's hold stays out; the first ms of today and a decision stamped later today than now count.
    expect(old).toEqual({ checks: 7, held: 2, asked: 1 });
    expect(rt.feed().counts).toEqual(old);
    const st = rt.status();
    expect({ checks: st.checksToday, held: st.heldToday, asked: st.askedToday }).toEqual(old);
  });

  it("the feed, reading its decisions once, returns what each helper reading the store itself returned", () => {
    const { rt, store, book, start } = setup();
    // As the page asks (amygdala-ui.ts): the last 36 h for every tab, and the same for one tab.
    const since = NOW - 36 * HOUR;
    const all = rt.feed({ limit: 400, sinceTs: since });
    expect(all.decisions).toEqual(store.decisionsSince(since).slice(-400).toReversed());
    const rebuilt = rebuildEvents(store, book, { since, limit: 400 });
    expect(rebuilt.decisionEvents.length).toBeGreaterThan(0);
    expect(rebuilt.interventions).toHaveLength(6);
    expect(all.decisionEvents).toEqual(rebuilt.decisionEvents);
    expect(all.interventions).toEqual(rebuilt.interventions);
    // Today's rows are a suffix of the 36 h read; yesterday's judged decision stays out of today's agreement.
    const questions = questionRows(store, book, start);
    expect(questions.find((q) => q.id === "danger-level")?.right).toBe(1);
    expect(all.questions).toEqual(questions);
    expect(all.counts).toEqual({ checks: 7, held: 2, asked: 1 });
    expect(all.status).toEqual(rt.status());
    expect(all.spend).toEqual({ ...spendToday(store, NOW, RATE), eur30: naive(store, NOW).eur });

    const tab = rt.feed({ sessionKey: TAB, limit: 400, sinceTs: since });
    const tabRebuilt = rebuildEvents(store, book, { since, limit: 400, sessionKey: TAB });
    expect(tab.decisions).toEqual(
      store.decisionsSinceForSession(since, TAB).slice(-400).toReversed(),
    );
    expect(tab.decisionEvents).toEqual(tabRebuilt.decisionEvents);
    expect(tab.interventions).toEqual(tabRebuilt.interventions);
    expect(tab.questions).toEqual(questions);

    // The default feed (since today's start), a short limit, a window shorter than today, an empty tab key.
    const today = rt.feed();
    expect(today.decisions).toEqual(store.decisionsSince(start).slice(-200).toReversed());
    expect(today.decisionEvents).toEqual(
      rebuildEvents(store, book, { since: start, limit: 200 }).decisionEvents,
    );
    expect(today.questions).toEqual(questions);
    const short = rt.feed({ limit: 3 });
    expect(short.decisions).toEqual(store.decisionsSince(start).slice(-3).toReversed());
    expect(short.decisionEvents).toEqual(
      rebuildEvents(store, book, { since: start, limit: 3 }).decisionEvents,
    );
    expect(rt.feed({ sinceTs: NOW - HOUR }).questions).toEqual(questions);
    const empty = rt.feed({ sessionKey: "" });
    expect(empty.decisions).toEqual(today.decisions);
    expect(empty.decisionEvents).toEqual([]);
    expect(empty.interventions).toEqual([]);
  });
});
