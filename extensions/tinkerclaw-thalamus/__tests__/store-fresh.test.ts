import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { ThalamusStore, type FreshPointRow } from "../src/store.js";

const tmp = mkdtempSync(join(tmpdir(), "thalamus-store-fresh-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const fp = (over: Partial<FreshPointRow> = {}): FreshPointRow => ({
  id: "run-1:digest:t1",
  ts: 1000,
  session: "agent:main:tinker:x",
  runId: "run-1",
  callIndex: 3,
  kind: "digest",
  mode: "shadow",
  acted: false,
  reason: "pays",
  model: "claude-code/claude-haiku-4-5",
  family: "anthropic",
  detail: { resultTokens: 20_000, margin: 1.4 },
  ...over,
});

describe("schema 2", () => {
  it("upgrades a version-1 file in place and keeps what it held", () => {
    const file = join(tmp, "v1.sqlite");
    // The version-1 tables as they were shipped in D1, written out literally.
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES('schema_version','1');
      CREATE TABLE decisions(
        id TEXT PRIMARY KEY, ts INT, session TEXT, run_id TEXT, call_index INT, lane TEXT, mode TEXT,
        task_read TEXT, step_read TEXT, situation_ref TEXT, dial_idx INT, private INT, degraded INT,
        incumbent TEXT, chosen TEXT, chosen_effort TEXT, chosen_feed TEXT, pick TEXT, pick_effort TEXT,
        switch_kind TEXT, switch_reason TEXT, n_star REAL, applied INT, would_change INT,
        price REAL, incumbent_price REAL, money_basis TEXT, reserved_reason TEXT,
        options_json TEXT, vetoes_json TEXT, ladder_json TEXT, compute_ms REAL);
      INSERT INTO decisions(id,ts,run_id,call_index,lane,mode) VALUES('old',1,'r',0,'embedded','shadow');
    `);
    raw.close();
    const s = new ThalamusStore(file);
    expect(s.schemaVersion()).toBe(2);
    s.insertFreshPoint(fp());
    expect(s.counts().freshPoints).toBe(1);
    s.close();
    const again = new ThalamusStore(file);
    expect(again.schemaVersion()).toBe(2);
    expect(again.listFreshPoints()).toHaveLength(1);
    expect(again.getDecision("old")).toBeDefined();
    again.close();
  });
});

describe("fresh points", () => {
  it("round-trips and filters by run, kind and time, newest first", () => {
    const s = new ThalamusStore(":memory:");
    s.insertFreshPoint(fp());
    s.insertFreshPoint(
      fp({ id: "run-1:check", kind: "check", ts: 2000, reason: "picked", acted: true }),
    );
    s.insertFreshPoint(fp({ id: "run-2:digest:t9", runId: "run-2", ts: 3000 }));
    expect(s.listFreshPoints().map((r) => r.id)).toEqual([
      "run-2:digest:t9",
      "run-1:check",
      "run-1:digest:t1",
    ]);
    expect(s.listFreshPoints({ runId: "run-1" })).toHaveLength(2);
    expect(s.listFreshPoints({ kind: "check" })[0]).toMatchObject({
      acted: true,
      reason: "picked",
      family: "anthropic",
    });
    expect(s.listFreshPoints({ sinceTs: 2500 })).toHaveLength(1);
    expect(s.listFreshPoints({ runId: "run-1", kind: "digest" })[0].detail).toEqual({
      resultTokens: 20_000,
      margin: 1.4,
    });
  });
  it("is idempotent on the id and never stores a body", () => {
    const s = new ThalamusStore(":memory:");
    s.insertFreshPoint(fp());
    s.insertFreshPoint(fp({ reason: "does-not-pay" }));
    expect(s.counts().freshPoints).toBe(1);
    expect(s.listFreshPoints()[0].reason).toBe("does-not-pay");
  });
});

describe("raw results", () => {
  const row = {
    name: "res-aaaaaaaa-1",
    ts: 1000,
    session: "s",
    path: "/tmp/x/res-aaaaaaaa-1",
    bytes: 900,
    tokens: 225,
    tool: "exec",
  };
  it("keeps a row, counts recalls, and finds what is old", () => {
    const s = new ThalamusStore(":memory:");
    s.putRaw({ ...row, digestTokens: 40 });
    expect(s.getRaw(row.name)).toMatchObject({ bytes: 900, digestTokens: 40, recalls: 0 });
    s.noteRecall(row.name, 5000);
    s.noteRecall(row.name, 6000);
    expect(s.getRaw(row.name)).toMatchObject({ recalls: 2, lastRecallTs: 6000 });
    expect(s.rawOlderThan(2000).map((r) => r.name)).toEqual([row.name]);
    expect(s.rawOlderThan(500)).toEqual([]);
    s.deleteRaw(row.name);
    expect(s.getRaw(row.name)).toBeUndefined();
  });
  it("putting the same name again keeps the recall count", () => {
    const s = new ThalamusStore(":memory:");
    s.putRaw(row);
    s.noteRecall(row.name, 5000);
    s.putRaw({ ...row, ts: 9000 });
    expect(s.getRaw(row.name)).toMatchObject({ recalls: 1, ts: 9000 });
  });
});

describe("sub-agent calls", () => {
  it("counts the calls a sub-agent made inside a turn, per session", () => {
    const s = new ThalamusStore(":memory:");
    s.insertSubagentCall({
      id: "a",
      ts: 1,
      session: "s1",
      parentToolUseId: "toolu_1",
      model: "claude-haiku-4-5",
      input: 1598,
      cacheRead: 0,
      output: 12,
    });
    s.insertSubagentCall({
      id: "b",
      ts: 2,
      session: "s1",
      parentToolUseId: "toolu_1",
      model: "claude-haiku-4-5",
    });
    s.insertSubagentCall({ id: "c", ts: 3, session: "s2", parentToolUseId: "toolu_2" });
    expect(s.listSubagentCalls({ session: "s1" }).map((r) => r.id)).toEqual(["b", "a"]);
    expect(s.listSubagentCalls({ session: "s1" })[1]).toMatchObject({
      input: 1598,
      cacheRead: 0,
      output: 12,
    });
    expect(s.counts().subagentCalls).toBe(3);
  });
});

describe("pruning", () => {
  it("drops old fresh points and sub-agent counts with the decisions, and leaves raw rows to the raw store", () => {
    const s = new ThalamusStore(":memory:");
    s.insertFreshPoint(fp({ ts: 100 }));
    s.insertFreshPoint(fp({ id: "new", ts: 5000 }));
    s.insertSubagentCall({ id: "a", ts: 100, session: "s", parentToolUseId: "t" });
    s.putRaw({ name: "res-1", ts: 100, session: "s", path: "/p", bytes: 1, tokens: 1, tool: "x" });
    s.pruneDecisions(1000);
    expect(s.counts()).toMatchObject({ freshPoints: 1, subagentCalls: 0, rawResults: 1 });
  });
});
