import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { AmygdalaStore } from "./store.js";
import type { Decision, Field, Seam, Situation } from "./types.js";

const miss = <T>(): Field<T> => ({ value: null, origin: "missing" });

const dirs: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Closed after the test even when an assertion fails first (a second close is a no-op). */
function keep<T extends { close(): void }>(handle: T): T {
  handles.push(handle);
  return handle;
}

/**
 * A store file under the OS temp dir as it stood before 2026-10-29: the versioned schema at its
 * version and no s_turn or d_sit, so opening it takes the in-place upgrade an existing store gets.
 */
function preIndexStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "amy-turn-idx-"));
  dirs.push(dir);
  const path = join(dir, "amygdala.sqlite");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  db.close();
  return path;
}

/** s_turn and d_sit as `table(columns)`, read back from sqlite_master and index_info. */
function turnIndexes(path: string): Record<string, string> {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'index' AND name IN ('s_turn', 'd_sit')",
      )
      .all() as Array<{ name: string; tbl: string }>;
    return Object.fromEntries(
      rows.map((r): [string, string] => {
        const cols = db.pragma(`index_info(${r.name})`) as Array<{ name: string }>;
        return [r.name, `${r.tbl}(${cols.map((c) => c.name).join(", ")})`];
      }),
    );
  } finally {
    db.close();
  }
}

function planOf(db: Database.Database, sql: string, params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(" | ");
}

/**
 * The one statement a store method prepares, captured while it runs, so the plans checked below are
 * those of the shipped SQL and not of a copy that could drift from it.
 */
function sqlOf(call: () => unknown): string {
  const spy = vi.spyOn(Database.prototype, "prepare");
  try {
    call();
    const sources = spy.mock.calls.map(([source]) => source);
    expect(sources, "the method prepares one statement per call").toHaveLength(1);
    return sources[0];
  } finally {
    spy.mockRestore();
  }
}

/** The three stop-seam turn queries and the tab feed's query, with the arguments used here. */
function shippedQueries(st: AmygdalaStore) {
  return {
    flagged: { sql: sqlOf(() => st.flaggedDecisionsForTurn("sess#1")), params: ["sess#1"] },
    unjudged: { sql: sqlOf(() => st.unjudgedPassesForTurn("sess#1", 30)), params: ["sess#1", 30] },
    start: { sql: sqlOf(() => st.turnStartTs("sess#1")), params: ["sess#1"] },
    tab: { sql: sqlOf(() => st.decisionsSinceForSession(1030, "sess")), params: [1030, "sess"] },
  };
}

const PROCEED: Decision["response"] = { kind: "proceed" };
const HOLD: Decision["response"] = { kind: "hold", ruleOrQuestion: "q", releasable: "user-only" };
const NOTE: Decision["response"] = {
  kind: "note",
  templateId: "t",
  slots: {},
  channel: "additionalContext",
};
const SEND_BACK: Decision["response"] = {
  kind: "send-back",
  templateId: "t",
  slots: {},
  attempt: 1,
};

function situation(id: string, turnId: string, seam: Seam, ts: number): Situation {
  return {
    id,
    ts,
    sessionKey: turnId.split("#")[0],
    turnId,
    seam,
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
    holdNeeds: miss(),
    candidates: miss(),
    scheduledJobs: miss(),
    contextCounts: miss(),
    turnKind: miss(),
    ownedTargets: miss(),
  };
}

/**
 * One tab's two turns (sess#1 with flagged and unjudged rows, sess#2 with neither) and another tab's
 * turn, in insert (rowid) order. The insert order differs from the time order on purpose, so the
 * lists expected below hold only while ORDER BY d.ts, d.rowid is applied: d-stop is stored first,
 * d-hold's step came before d-note's but was decided after it, and d-pass-review-failed and d-pass
 * share a decision time that the earlier insert wins.
 */
function seed(st: AmygdalaStore): void {
  const step = (
    id: string,
    turnId: string,
    seam: Seam,
    at: number,
    decidedAt: number,
    response: Decision["response"],
    family: Decision["family"] = "safety",
    review?: "done" | "failed",
  ): void => {
    const situationId = `s-${id}`;
    const decision: Decision = {
      situationId,
      response,
      family,
      reasonCode: "rc",
      verdictIds: [],
      mode: "enforce",
      enforced: false,
      degraded: false,
    };
    st.saveSituation(situation(situationId, turnId, seam, at));
    st.saveDecision(decision, { id, seam, ts: decidedAt });
    if (review) {
      st.saveReview({
        decisionId: id,
        sessionKey: turnId.split("#")[0],
        turnId,
        ts: decidedAt + 100,
        status: review,
        kind: "pass",
      });
    }
  };
  step("d-stop", "sess#1", "stop", 1070, 1071, SEND_BACK, "double-check");
  step("d-prompt", "sess#1", "prompt", 1000, 1001, PROCEED);
  step("d-hold", "sess#1", "pre-tool", 1010, 1035, HOLD);
  step("d-note", "sess#1", "pre-tool", 1020, 1021, NOTE, "personality");
  step("d-pass-review-failed", "sess#1", "pre-tool", 1031, 1032, PROCEED, "efficiency", "failed");
  step("d-pass", "sess#1", "pre-tool", 1030, 1032, PROCEED);
  step("d-fallback", "sess#1", "pre-tool", 1040, 1041, PROCEED, "fallback");
  step("d-judged", "sess#1", "pre-tool", 1050, 1051, PROCEED, "second-opinion", "done");
  step("e-prompt", "sess#2", "prompt", 1005, 1006, PROCEED);
  step("e-fallback", "sess#2", "pre-tool", 1015, 1016, PROCEED, "fallback");
  step("e-judged", "sess#2", "pre-tool", 1025, 1026, PROCEED, "safety", "done");
  step("e-post", "sess#2", "post-tool", 1045, 1046, PROCEED, "personality");
  step("e-stop", "sess#2", "stop", 1055, 1056, PROCEED, "double-check");
  step("o-hold", "other#1", "pre-tool", 1012, 1013, HOLD);
}

// FORK 2026-10-29: the stop seam's turn queries walked every stored decision through d_ts, on the
// gateway's main thread before the hook got its answer (live store, 273k decisions: 1.5-2.2 s warm
// per stop). s_turn and d_sit turn them into index seeks. These tests read the plans of the SQL the
// store really prepares and check each against a control: the plans before the indexes, and the tab
// feed's query without the CROSS JOIN that keeps it on its time-window plan.
describe("stop-seam turn indexes", () => {
  it("an existing store gains s_turn(turn_id, ts) and d_sit(situation_id) on open, and reopens", () => {
    const path = preIndexStore();
    expect(turnIndexes(path)).toEqual({});
    keep(new AmygdalaStore(path)).close();
    const built = { s_turn: "situations(turn_id, ts)", d_sit: "decisions(situation_id)" };
    expect(turnIndexes(path)).toEqual(built);
    keep(new AmygdalaStore(path)).close();
    expect(turnIndexes(path)).toEqual(built);
  });

  it("the turn queries seek through s_turn and d_sit; the tab feed keeps its time-window plan", () => {
    const path = preIndexStore();
    const st = keep(new AmygdalaStore(path));
    seed(st);
    const q = shippedQueries(st);
    const db = keep(new Database(path, { readonly: true }));
    for (const query of [q.flagged, q.unjudged]) {
      const plan = planOf(db, query.sql, query.params);
      expect(plan).toContain("USING INDEX s_turn");
      expect(plan).toContain("USING INDEX d_sit");
      expect(plan).not.toMatch(/\bSCAN\b/);
    }
    const start = planOf(db, q.start.sql, q.start.params);
    expect(start).toContain("USING COVERING INDEX s_turn");
    expect(start).not.toMatch(/\bSCAN\b/);
    // The tab feed reads decisions by time first, so its cost follows the window, not the tab's age.
    expect(planOf(db, q.tab.sql, q.tab.params)).toMatch(/^SEARCH d USING INDEX d_ts\b/);
    // Control: as a plain JOIN, the same query starts from s_sess and walks the tab's whole history.
    expect(q.tab.sql).toContain(" CROSS JOIN ");
    const plain = q.tab.sql.replace(" CROSS JOIN ", " JOIN ");
    expect(planOf(db, plain, q.tab.params)).toMatch(/^SEARCH s USING INDEX s_sess\b/);
  });

  it("the turn queries return the same rows in the same order, with the indexes and without", () => {
    const path = preIndexStore();
    const st = keep(new AmygdalaStore(path));
    seed(st);
    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
    expect(ids(st.flaggedDecisionsForTurn("sess#1"))).toEqual(["d-note", "d-hold", "d-stop"]);
    expect(st.flaggedDecisionsForTurn("sess#1")[0]).toEqual({
      id: "d-note",
      seam: "pre-tool",
      ts: 1021,
      situationId: "s-d-note",
      response: NOTE,
      family: "personality",
      reasonCode: "rc",
      verdictIds: [],
      mode: "enforce",
      enforced: false,
      degraded: false,
    });
    expect(ids(st.unjudgedPassesForTurn("sess#1"))).toEqual(["d-pass-review-failed", "d-pass"]);
    expect(ids(st.unjudgedPassesForTurn("sess#1", 1))).toEqual(["d-pass-review-failed"]);
    expect(st.turnStartTs("sess#1")).toBe(1000);
    expect(st.flaggedDecisionsForTurn("sess#2")).toEqual([]);
    expect(st.unjudgedPassesForTurn("sess#2")).toEqual([]);
    expect(st.turnStartTs("sess#2")).toBe(1005);
    expect(st.flaggedDecisionsForTurn("nope#1")).toEqual([]);
    expect(st.unjudgedPassesForTurn("nope#1")).toEqual([]);
    expect(st.turnStartTs("nope#1")).toBeNull();
    expect(ids(st.decisionsSinceForSession(1030, "sess"))).toEqual([
      "d-pass-review-failed",
      "d-pass",
      "d-hold",
      "d-fallback",
      "e-post",
      "d-judged",
      "e-stop",
      "d-stop",
    ]);
    expect(ids(st.decisionsSinceForSession(0, "other"))).toEqual(["o-hold"]);

    // Control: the same SQL on the same file after dropping s_turn and d_sit (the plans before
    // 2026-10-29, which walk every decision) returns exactly the same rows in the same order.
    const q = shippedQueries(st);
    const db = keep(new Database(path));
    const run = () => Object.values(q).map(({ sql, params }) => db.prepare(sql).all(...params));
    const withIndexes = run();
    db.exec("DROP INDEX s_turn; DROP INDEX d_sit");
    expect(planOf(db, q.flagged.sql, q.flagged.params)).toMatch(/\bSCAN d\b/);
    expect(planOf(db, q.unjudged.sql, q.unjudged.params)).toMatch(/\bSCAN d\b/);
    expect(planOf(db, q.start.sql, q.start.params)).not.toContain("INDEX");
    expect(run()).toEqual(withIndexes);
  });
});
