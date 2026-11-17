/**
 * FORK 2026-10-29: the 30-day spend's cache of whole days (store.ts `closedDaysSpend`, read for the feed's eur30)
 * belongs to the database file, and holds only while nothing but this process's stores has committed to it.
 * - A store opened through a symlink and one opened through the real path share one cache: a backdated verdict written
 *   through either drops the days the other summed, and the days one summed the other reads. Keyed by resolve(), each
 *   had a cache of its own, and the one that had summed the days went on serving the old total.
 * - A commit by another connection (a script, another process) makes the next 30-day spend sum every day again, with
 *   one store open on the file or two. A live verdict through a sibling store keeps the days, and a closed store
 *   drops out of the check.
 * Every database here is a temp file under the OS temp folder.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSituation } from "./situation.js";
import { spendBetween, spendLast30Days, type Spend } from "./spend.js";
import { AmygdalaStore } from "./store.js";
import type { Situation, Verdict } from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 30 * DAY;
/** The config's default rate. */
const RATE = 0.92;
/** 11 Nov 10:30 in Madrid. Its window opens 12 Oct 11:30 summer time; the whole days run from 13 Oct to 10 Nov. */
const NOW = Date.UTC(2026, 10, 11, 9, 30);
/** Range sums one 30-day spend runs: the two live edges and the 29 whole days between them. */
const ALL = 31;
/** The same with every whole day cached: the two edges only. */
const CACHED = 2;

const dirs: string[] = [];
const stores: AmygdalaStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    s.close();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "amy-spend-key-"));
  dirs.push(d);
  return d;
}

function openStore(path: string): AmygdalaStore {
  const s = new AmygdalaStore(path);
  stores.push(s);
  return s;
}

function situation(id: string, ts: number): Situation {
  const s = buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "tab-a",
      turnId: "tab-a#1",
      now: ts,
      tool: "Bash",
      toolInput: { command: `ls /work/demo/${id}` },
    },
    { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
  );
  return { ...s, id };
}

/** Verdict number `k` of situation "live". Its cost is a whole multiple of 2^-12 USD, so sums in any order agree. */
function verdict(id: string, ts: number, k: number): Verdict {
  return {
    id,
    situationId: "live",
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
    ts,
  };
}

/** A verdict every 3 h over the 33 days before NOW. */
function seed(store: AmygdalaStore): void {
  store.saveSituation(situation("live", NOW - 33 * DAY));
  const vs: Verdict[] = [];
  let k = 0;
  for (let ts = NOW - 33 * DAY; ts < NOW; ts += 3 * HOUR) {
    vs.push(verdict(`g${k}`, ts, k));
    k += 1;
  }
  store.saveVerdicts(vs);
}

/** A verdict committed by a connection of its own, as a script or another process writes one: no store sees it. */
function outsideVerdict(path: string, id: string, ts: number, k: number): void {
  const db = new Database(path);
  try {
    db.prepare(
      "INSERT INTO verdicts(id, situation_id, question_id, question_version, type, cache_hit, tokens_in, tokens_out, cost_usd, ts) VALUES (?, 'live', 'danger-level', 1, 'score', 0, ?, ?, ?, ?)",
    ).run(id, 100 + k, 5 + (k % 3), ((k % 7) + 1) / 4096, ts);
  } finally {
    db.close();
  }
}

/** The 30-day spend at NOW through `store`, and how many range sums the store ran for it. */
function windowed(store: AmygdalaStore): { spend: Spend; sums: number } {
  const spy = vi.spyOn(store, "verdictSpend");
  try {
    const spend = spendLast30Days(store, NOW, RATE);
    return { spend, sums: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

/** The 30-day spend through `store` equals one SUM over the window, and took `sums` range sums. */
function check(store: AmygdalaStore, sums: number): void {
  const w = windowed(store);
  expect(w.spend).toEqual(spendBetween(store, NOW - WINDOW, NOW, RATE));
  expect(w.sums).toBe(sums);
}

describe("the 30-day spend cache belongs to the database file", () => {
  it("is shared by a store opened through a symlink and one opened through the real path", () => {
    const root = tempDir();
    const real = join(root, "data", "amygdala.sqlite");
    const a = openStore(real);
    seed(a);
    mkdirSync(join(root, "elsewhere"));
    const link = join(root, "elsewhere", "amygdala.sqlite");
    symlinkSync(real, link);
    // Two names for one file: resolve() keeps them apart, realpath does not.
    expect(resolve(link)).not.toBe(resolve(real));
    expect(realpathSync(link)).toBe(realpathSync(real));
    const b = openStore(link);

    check(a, ALL);
    // A replay stamps its verdicts with the exchange's own time: ten days back, inside a day a has cached.
    b.saveVerdicts([verdict("back-b", NOW - 10 * DAY, 2)]);
    check(a, ALL);
    // The days a summed are b's too, and a backdated verdict through a drops them for b.
    check(b, CACHED);
    a.saveVerdicts([verdict("back-a", NOW - 20 * DAY, 4)]);
    check(b, ALL);
    // A live verdict through b lands after every cached day: the days stay for a.
    check(a, CACHED);
    b.saveVerdicts([verdict("live-b", NOW - 1000, 3)]);
    check(a, CACHED);
  });

  it("is summed again after a commit by another connection", () => {
    const path = join(tempDir(), "amygdala.sqlite");
    const store = openStore(path);
    seed(store);
    check(store, ALL);
    check(store, CACHED);
    outsideVerdict(path, "outside-1", NOW - 5 * DAY, 3);
    check(store, ALL);
    check(store, CACHED);
  });

  it("is summed again after an outside commit with two stores open, and a closed store drops out", () => {
    const path = join(tempDir(), "amygdala.sqlite");
    const a = openStore(path);
    seed(a);
    const b = openStore(path);
    check(a, ALL);
    // b's commit moves a's data_version and not b's own, and b's write path kept the days: they stay.
    b.saveVerdicts([verdict("live-b", NOW - 1000, 3)]);
    check(a, CACHED);
    // A commit from outside moves both.
    outsideVerdict(path, "outside-2", NOW - 6 * DAY, 5);
    check(a, ALL);
    // Closed, b is no longer read; a alone still sees an outside commit.
    b.close();
    check(a, CACHED);
    outsideVerdict(path, "outside-3", NOW - 7 * DAY, 6);
    check(a, ALL);
  });
});
