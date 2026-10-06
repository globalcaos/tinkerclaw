import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/schema.js";
import { AmygdalaStore } from "../src/store.js";
import type { Change, Decision, Field, Question, Situation, Verdict } from "../src/types.js";

const miss = <T>(): Field<T> => ({ value: null, origin: "missing" });

describe("deleteReplayTurn", () => {
  it("removes a replay turn's rows and refuses a live turn id", () => {
    const st = new AmygdalaStore(":memory:");
    st.saveSituation({ ...situation("r1", 5), turnId: "k#replay-5", sessionKey: "k" });
    st.saveSituation({ ...situation("l1", 6), turnId: "k#1", sessionKey: "k" });
    expect(() => st.deleteReplayTurn("k#1")).toThrow(/only replay turns/);
    st.deleteReplayTurn("k#replay-5");
    expect(st.situationRecord("r1")).toBeUndefined();
    expect(st.situationRecord("l1")).toBeDefined();
    st.close();
  });
});

// FORK 2026-10-06 — every Tinker page load sent two amygdala2.feed calls, and each ran ~7 s of
// synchronous SQLite: one full SCAN of verdicts per decision (measured on the live 1.34 GB store,
// 166,865 rows: 20.4 ms per lookup, up to 400 per feed). The gateway's one event loop was blocked
// for it, so the chat history he was waiting for came back after 15 s instead of 0.5 s.
describe("verdict indexes", () => {
  it("an existing store gains the situation and time indexes, and the feed's lookup uses them", () => {
    const dir = mkdtempSync(join(tmpdir(), "amy-idx-"));
    try {
      const path = join(dir, "amygdala.sqlite");
      new AmygdalaStore(path).close();
      const db = new Database(path, { readonly: true });
      const names = (
        db.prepare("PRAGMA index_list(verdicts)").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(["v_sit", "v_ts"]));
      const plan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM verdicts WHERE situation_id = ? ORDER BY ts, rowid",
          )
          .all("x") as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toContain("USING INDEX v_sit");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("turnIdsNewestFirst", () => {
  it("orders a tab's turns by their latest step, newest first, and ignores other tabs", () => {
    const st = new AmygdalaStore(":memory:");
    const at = (id: string, turnId: string, sessionKey: string, ts: number) =>
      st.saveSituation({ ...situation(id, ts), turnId, sessionKey });
    at("a", "k#1", "k", 10);
    at("b", "k#2", "k", 20);
    at("c", "k#1", "k", 15);
    at("d", "o#9", "other", 99);
    expect(st.turnIdsNewestFirst("k")).toEqual(["k#2", "k#1"]);
    st.close();
  });
});

function situation(id: string, ts: number): Situation {
  return {
    id,
    ts,
    sessionKey: "sess",
    turnId: "turn",
    seam: "pre-tool",
    originKind: "synthetic",
    tool: { value: "test-tool", origin: "observed" },
    args: miss(),
    command: miss(),
    effectClass: { value: "read", origin: "derived" },
    targets: miss(),
    targetHistory: miss(),
    scratch: miss(),
    toolRecord: miss(),
    request: miss(),
    restatement: miss(),
    expectation: miss(),
    draftCommitments: miss(),
    repeatedErrors: miss(),
    stepsSinceNewFact: miss(),
    recentHolds: miss(),
    standingFacts: miss(),
    similarIncidents: miss(),
    reply: miss(),
    claims: miss(),
    provenance: miss(),
  };
}

function verdict(id: string, sitId: string, over: Partial<Verdict> = {}): Verdict {
  return {
    id,
    situationId: sitId,
    questionId: "q1",
    questionVersion: 1,
    type: "noul",
    answer: true,
    prob: 0.8,
    confidence: 0.9,
    cacheHit: false,
    latencyMs: 12,
    tokensIn: 100,
    tokensOut: 5,
    costUsd: 0.001,
    ts: 1000,
    ...over,
  };
}

function question(id: string, version: number): Question {
  return {
    id,
    version,
    family: "safety",
    seams: ["pre-tool"],
    type: "noul",
    criteria: ["a", "b"],
    instructions: "test-question",
    fields: ["tool"],
    cutoff: { kind: "prob", at: 0.5 },
    purpose: "p",
    origin: "seed",
    retirement: "r",
    mustCatch: [],
    status: "active",
    name: "Test",
  };
}

function decision(sitId: string, verdictIds: string[]): Decision {
  return {
    situationId: sitId,
    response: { kind: "hold", ruleOrQuestion: "q1", releasable: "user-only" },
    family: "safety",
    reasonCode: "rc",
    verdictIds,
    mode: "enforce",
    enforced: true,
    degraded: false,
  };
}

function change(id: string, ts: number, over: Partial<Change> = {}): Change {
  return {
    id,
    ts,
    questionId: "q1",
    fromVersion: 1,
    toVersion: 2,
    kind: "tighten",
    exceptional: false,
    status: "pending",
    replay: {
      cases: 3,
      relaxed: 0,
      tightened: 1,
      mustCatchTotal: 2,
      mustCatchLost: 0,
      heldOutBetter: null,
      liveCalls: 0,
    },
    proposedBy: "code",
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("AmygdalaStore schema", () => {
  it("applies twice without error and reports user_version 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "amyg-store-"));
    dirs.push(dir);
    const file = join(dir, "a.sqlite");
    const a = new AmygdalaStore(file);
    expect(a.schemaVersion()).toBe(1);
    expect(SCHEMA_VERSION).toBe(1);
    a.close();
    const b = new AmygdalaStore(file);
    expect(b.schemaVersion()).toBe(1);
    b.close();
  });

  it("creates a 0700 folder for a file database and reopens with its data", () => {
    const dir = mkdtempSync(join(tmpdir(), "amyg-store-"));
    dirs.push(dir);
    const sub = join(dir, "data");
    const file = join(sub, "amygdala.sqlite");
    const a = new AmygdalaStore(file);
    a.saveSituation(situation("s1", 5));
    a.close();
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    const b = new AmygdalaStore(file);
    expect(b.situationRecord("s1")?.id).toBe("s1");
    b.close();
  });
});

describe("AmygdalaStore round trips", () => {
  it("situations, verdicts, decisions, interventions", () => {
    const st = new AmygdalaStore(":memory:");
    st.saveSituation(situation("s1", 10), { tool: "redacted" });
    expect(st.situationRecord("s1")).toEqual(situation("s1", 10));
    const v = verdict("v1", "s1", { type: "choice", answer: "x", probs: { x: 0.7, y: 0.3 } });
    const skipped = verdict("v2", "s1", { skipped: "timeout", cacheHit: true });
    st.saveVerdicts([v, skipped]);
    expect(st.queryVerdicts({ situationId: "s1" })).toEqual([v, skipped]);
    st.saveDecision(decision("s1", ["v1"]), { id: "d1", seam: "pre-tool", ts: 20 });
    expect(st.getDecision("d1")).toEqual({
      ...decision("s1", ["v1"]),
      id: "d1",
      seam: "pre-tool",
      ts: 20,
    });
    expect(st.getDecision("nope")).toBeUndefined();
    expect(st.decisionsSince(21)).toEqual([]);
    expect(st.decisionsSince(20)).toHaveLength(1);
    st.close();
  });

  it("labels, precedents, contexts", () => {
    const st = new AmygdalaStore(":memory:");
    const label = {
      id: "l1",
      targetId: "d1",
      targetKind: "decision" as const,
      kind: "useful" as const,
      value: 1 as const,
      source: "user" as const,
      weight: 2 as const,
      ts: 5,
    };
    st.addLabel(label);
    expect(st.labelsFor("d1")).toEqual([label]);
    expect(st.labelsFor("other")).toEqual([]);

    const p = {
      id: "p1",
      featureKey: "fk",
      tokens: ["a", "b"],
      incidentRef: "inc",
      label: "should-hold" as const,
      ts: 7,
      hits: 0,
    };
    st.addPrecedent(p);
    st.bumpPrecedent("p1");
    expect(st.allPrecedents()).toEqual([{ ...p, hits: 1 }]);

    expect(st.getContext("c", "q")).toBeUndefined();
    st.bumpContext("c", "q", { alarms: 1 }, 10);
    st.bumpContext("c", "q", { alarms: 2, falseAlarms: 1, confirms: 3 }, 20);
    expect(st.getContext("c", "q")).toEqual({
      contextKey: "c",
      questionId: "q",
      alarms: 3,
      falseAlarms: 1,
      confirms: 3,
      lastTs: 20,
    });
    st.close();
  });

  it("question versions are immutable; setActive upserts", () => {
    const st = new AmygdalaStore(":memory:");
    st.saveQuestionVersion(question("q1", 1), "seed", 1);
    expect(st.getQuestionVersion("q1", 1)).toEqual(question("q1", 1));
    expect(st.getQuestionVersion("q1", 2)).toBeUndefined();
    expect(() => st.saveQuestionVersion(question("q1", 1), "seed", 2)).toThrow();
    st.saveQuestionVersion(question("q1", 2), "code", 3);

    expect(st.activeVersion("q1")).toBeUndefined();
    st.setActive("q1", 1, null, 4);
    expect(st.activeVersion("q1")).toBe(1);
    st.setActive("q1", 2, "ch1", 5);
    expect(st.activeVersion("q1")).toBe(2);
    st.close();
  });

  it("context overrides and changes", () => {
    const st = new AmygdalaStore(":memory:");
    expect(st.getContextOverride("q1", "c")).toBeUndefined();
    st.saveContextOverride({
      questionId: "q1",
      contextKey: "c",
      cutoff: { kind: "prob", at: 0.9 },
      changeId: "ch1",
    });
    expect(st.getContextOverride("q1", "c")).toEqual({ kind: "prob", at: 0.9 });
    st.removeContextOverride("q1", "c");
    expect(st.getContextOverride("q1", "c")).toBeUndefined();

    st.saveChange(change("ch1", 10));
    st.saveChange(change("ch2", 20, { questionId: "q2", status: "applied" }), 999);
    expect(st.getChange("ch1")).toEqual({ ...change("ch1", 10), blockedUntil: null });
    expect(st.getChange("ch2")?.blockedUntil).toBe(999);
    expect(st.listChanges().map((c) => c.id)).toEqual(["ch2", "ch1"]);
    expect(st.listChanges({ status: "pending" }).map((c) => c.id)).toEqual(["ch1"]);
    expect(st.listChanges({ questionId: "q2" }).map((c) => c.id)).toEqual(["ch2"]);
    expect(st.listChanges({ sinceTs: 15 }).map((c) => c.id)).toEqual(["ch2"]);
    st.updateChangeStatus("ch1", "undone");
    expect(st.getChange("ch1")?.status).toBe("undone");
    st.updateChangeStatus("ch1", "undone", 55);
    expect(st.getChange("ch1")?.blockedUntil).toBe(55);
    st.close();
  });
});

describe("AmygdalaStore holds", () => {
  it("getOpenHold finds only open holds", () => {
    const st = new AmygdalaStore(":memory:");
    expect(st.getOpenHold("sig")).toBeUndefined();
    st.saveHold({
      id: "h1",
      decisionId: "d1",
      stepSig: "sig",
      goalFp: "g",
      needs: ["listing"],
      ts: 1,
    });
    expect(st.getOpenHold("sig")).toEqual({
      id: "h1",
      decisionId: "d1",
      stepSig: "sig",
      goalFp: "g",
      needs: ["listing"],
      state: "open",
    });
    st.updateHold("h1", { state: "released", releasedBy: "user" });
    expect(st.getOpenHold("sig")).toBeUndefined();
    st.close();
  });
});

describe("AmygdalaStore interventions", () => {
  it("filters and orders newest first", () => {
    const st = new AmygdalaStore(":memory:");
    st.saveSituation(situation("s", 1));
    st.saveDecision(decision("s", []), { id: "d", seam: "pre-tool", ts: 2 });
    const mk = (id: string, ts: number) => ({
      id,
      decisionId: "d",
      kind: "hold" as const,
      state: "open" as const,
      ts,
    });
    st.openIntervention(mk("i1", 10));
    st.openIntervention(mk("i2", 20));
    st.openIntervention(mk("i3", 30));
    st.closeIntervention("i2", "released", 25, "user");
    expect(st.listInterventions().map((i) => i.id)).toEqual(["i3", "i2", "i1"]);
    expect(st.listInterventions({ state: "open" }).map((i) => i.id)).toEqual(["i3", "i1"]);
    expect(st.listInterventions({ sinceTs: 20 }).map((i) => i.id)).toEqual(["i3", "i2"]);
    expect(st.listInterventions({ limit: 1 }).map((i) => i.id)).toEqual(["i3"]);
    const closed = st.listInterventions({ state: "released" })[0];
    expect(closed.closedTs).toBe(25);
    st.close();
  });
});

describe("AmygdalaStore turn state and retention", () => {
  it("sendBackAttempts / bumpSendBack", () => {
    const st = new AmygdalaStore(":memory:");
    expect(st.sendBackAttempts("s", "t")).toBe(0);
    expect(st.bumpSendBack("s", "t")).toBe(1);
    expect(st.bumpSendBack("s", "t")).toBe(2);
    expect(st.sendBackAttempts("s", "t")).toBe(2);
    expect(st.sendBackAttempts("s", "other")).toBe(0);
    st.close();
  });

  it("pruneRecords nulls record_json but keeps verdicts (situation row stays)", () => {
    const st = new AmygdalaStore(":memory:");
    st.saveSituation(situation("old", 100), { keep: true });
    st.saveSituation(situation("new", 900));
    st.saveVerdicts([verdict("v1", "old")]);
    expect(st.pruneRecords(500)).toBe(1);
    expect(st.pruneRecords(500)).toBe(0);
    expect(st.situationRecord("old")).toBeUndefined();
    expect(st.situationRecord("new")).toBeDefined();
    expect(st.queryVerdicts({ situationId: "old" })).toHaveLength(1);
    st.close();
  });

  it("queryVerdicts filters", () => {
    const st = new AmygdalaStore(":memory:");
    st.saveSituation(situation("s1", 1));
    st.saveVerdicts([
      verdict("v1", "s1", { ts: 10 }),
      verdict("v2", "s1", { ts: 20, questionId: "q2" }),
      verdict("v3", "s1", { ts: 30, questionVersion: 2 }),
    ]);
    expect(st.queryVerdicts({ questionId: "q1" }).map((v) => v.id)).toEqual(["v1", "v3"]);
    expect(st.queryVerdicts({ questionId: "q1", version: 2 }).map((v) => v.id)).toEqual(["v3"]);
    expect(st.queryVerdicts({ sinceTs: 20 }).map((v) => v.id)).toEqual(["v2", "v3"]);
    st.close();
  });
});
