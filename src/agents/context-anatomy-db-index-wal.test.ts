import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  checkpointAnatomyWal,
  closeAnatomyDb,
  insertAnatomyEvent,
  openAnatomyDb,
  setAnatomyDbPathForTests,
} from "./context-anatomy-db.js";
import type { ContextAnatomyEvent } from "./context-anatomy.js";

// FORK 2026-08-28 (gateway event-loop stall hunt). Two independent regressions are pinned here,
// both of which were invisible precisely because SQLite reports them as SLOWNESS rather than as
// an error:
//   1. no index on (run_id, round_number) -> updateAnatomyResponse() full-SCANs the table;
//   2. no explicit WAL checkpoint -> the -wal sidecar grew to 36 MB on the live DB.
// Every assertion below is paired with a CONTROL that shows the OLD behaviour genuinely failing,
// because an "is it fast / is it truncated" assertion with no control passes just as happily
// against a broken fixture.
//
// Isolated tmp DB per test (same reason as context-anatomy-tree.test.ts): these helpers write
// REAL rows, so pointing them at the production DB would pollute it.

const dir = mkdtempSync(join(tmpdir(), "anatomy-index-wal-"));
let seq = 0;
let dbPath = "";
let clock = 1_000_000;

function insert(runId: string, roundNumber: number): void {
  insertAnatomyEvent({
    turn: 1,
    roundNumber,
    compactionCycle: 0,
    timestamp: new Date(clock).toISOString(),
    timestampMs: clock++,
    model: "claude-opus-5",
    provider: "anthropic",
    sessionKey: "agent:main:main",
    topics: [],
    contextSent: {},
    contextWindow: {},
    memoriesInjected: { autoRecall: [], searched: [] },
    runId,
  } as unknown as ContextAnatomyEvent);
}

function walSize(): number {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch {
    return -1;
  }
}

beforeEach(() => {
  dbPath = join(dir, `anatomy-${seq++}.db`);
  setAnatomyDbPathForTests(dbPath);
});

afterAll(() => {
  closeAnatomyDb();
  setAnatomyDbPathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

// The predicate updateAnatomyResponse() actually issues (context-anatomy-db.ts, `WHERE run_id = ?
// AND round_number = ?`). Kept literal rather than exported from the module so that changing the
// real query without thinking about its plan makes this test go red.
const UPDATE_PREDICATE =
  "UPDATE anatomy_events SET duration_ms = COALESCE(?, duration_ms) WHERE run_id = ? AND round_number = ?";

describe("idx_run_round — the (run_id, round_number) update predicate", () => {
  test("plans as an index SEARCH; without the index the same query is a full SCAN (control)", () => {
    const database = openAnatomyDb();
    insert("run-a", 0);
    insert("run-b", 1);

    const planOf = (): string =>
      (
        database.prepare(`EXPLAIN QUERY PLAN ${UPDATE_PREDICATE}`).all(null, "run-a", 0) as Array<{
          detail: string;
        }>
      )
        .map((r) => r.detail)
        .join(" | ");

    expect(planOf()).toContain("USING INDEX idx_run_round");

    // CONTROL: same table, same rows, ONLY the index removed. This is the pre-fix behaviour, and
    // on the live 44,516-row copy it was the difference between a 67.13 ms and a 0.01 ms UPDATE
    // — 67 ms of blocked event loop, because better-sqlite3 is synchronous.
    database.exec("DROP INDEX idx_run_round");
    const withoutIndex = planOf();
    expect(withoutIndex).toContain("SCAN anatomy_events");
    expect(withoutIndex).not.toContain("idx_run_round");
  });
});

describe("checkpointAnatomyWal — explicit WAL truncation", () => {
  test("resets the -wal sidecar to zero bytes when no reader holds an older snapshot", () => {
    openAnatomyDb();
    for (let i = 0; i < 200; i++) {
      insert(`run-${i}`, 0);
    }
    expect(walSize()).toBeGreaterThan(0);

    const result = checkpointAnatomyWal();
    expect(result.truncated).toBe(true);
    // The file size is the claim that matters. SQLite reports log:0/checkpointed:0 on a
    // successful TRUNCATE, so the return value alone cannot distinguish "reset the log" from
    // "did nothing at all".
    expect(walSize()).toBe(0);
  });

  test("reports truncated=false — not a throw, not a false success — when a reader pins an older snapshot", () => {
    const database = openAnatomyDb();
    for (let i = 0; i < 200; i++) {
      insert(`run-${i}`, 0);
    }
    checkpointAnatomyWal(); // start from a clean log so the frames below are unambiguous

    // A second connection pins an OLD snapshot: it opens its read transaction FIRST, and only
    // then does the writer append frames. Order matters — a reader that is already on the newest
    // snapshot does NOT block a TRUNCATE checkpoint, so the obvious construction (open reader
    // after writing) silently proves nothing and passes against the unfixed code too.
    const reader = new Database(dbPath, { readonly: true });
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) AS n FROM anatomy_events").get();
      for (let i = 200; i < 400; i++) {
        insert(`run-${i}`, 0);
      }
      const walBefore = walSize();
      expect(walBefore).toBeGreaterThan(0);

      const started = Date.now();
      const result = checkpointAnatomyWal();
      const elapsed = Date.now() - started;

      // THE CONTROL FOR THE RETURN VALUE. SQLite raised nothing at all here — `busy` is a result
      // column, not an exception — so the natural implementation
      // (`try { exec(...); return true } catch { return false }`, which is what the shared
      // src/infra/sqlite-wal.ts helper does) would report SUCCESS while the log below is
      // provably untouched. Measured on this fixture: {busy:1, log:506, checkpointed:254}.
      expect(result.truncated).toBe(false);
      expect(result.log).toBeGreaterThan(0);
      expect(walSize()).toBe(walBefore);

      // THE CONTROL FOR THE BLOCKING TIME. A starved TRUNCATE blocks for the WHOLE busy_timeout:
      // measured 2026-08-28 at 5,026 ms with busy_timeout=5000 versus 251 ms at 250. Five
      // seconds of frozen event loop is the freeze this change exists to remove, so a regression
      // that drops the narrowed window fails here rather than in production.
      expect(elapsed).toBeLessThan(2000);

      // ...and the steady-state timeout is restored, or every ordinary query silently inherits
      // the 250 ms checkpoint window.
      expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      reader.close();
    }
  });
});
