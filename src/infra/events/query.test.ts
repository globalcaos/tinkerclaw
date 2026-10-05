import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashSessionKey } from "./emit.js";
import {
  assertNoRawSessionKeyColumns,
  assertReadOnlySelect,
  EventsQueryError,
  EVENTS_QUERY_RPC_MAX_ROW_CAP,
  openReadOnlyEventsDatabase,
  orderCatalogSilentFirst,
  REDACTED_SESSION_KEY,
  resolveSavedQuery,
  runEventsQuery,
  runIsolatedReadOnlySql,
  runSavedQuery,
} from "./query.js";
import { WORKER_MEMORY_TREND_7D_SQL as SAMPLER_TREND_SQL } from "./samplers/worker-resources.js";
import {
  CATALOG_QUERY_NAME,
  getSavedQuery,
  SAVED_QUERIES,
  WORKER_MEMORY_TREND_7D_SQL,
} from "./saved-queries.js";
import { openEventsDatabase, type EventsDatabase } from "./schema.js";
import { createWriterCore, handleWriterRequest } from "./writer-worker.js";

const HOUR_MS = 3_600_000;
const MiB = 1_048_576;
// A fictional number (the 555-01xx range): the key's shape is what matters, never a real contact.
const RAW_KEY_TAIL = "+15555550142";
const RAW_KEY = `agent:main:whatsapp:${RAW_KEY_TAIL}`;

let tmpDir: string;
let dbPath: string;
let handle: EventsDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "events-query-"));
  dbPath = join(tmpDir, "events.sqlite");
  // The writer's connection stays open throughout, as it does in a running gateway.
  handle = openEventsDatabase(dbPath, { walMaintenance: { checkpointIntervalMs: 0 } });
});

afterEach(() => {
  handle.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

type SeedRow = {
  ts: number;
  name: string;
  kind: string;
  label?: string | null;
  worker?: string | null;
  sessionHash?: string | null;
  dur?: number | null;
  n1?: number | null;
  n2?: number | null;
  n3?: number | null;
  n4?: number | null;
  fields?: string | null;
};

function seed(rows: SeedRow[]): void {
  const insert = handle.db.prepare(
    "INSERT INTO events (ts_ms, name, kind, boot_id, session_hash, session_kind, worker_id, " +
      "label, dur_ms, n1, n2, n3, n4, fields) VALUES (?, ?, ?, 'boot-fixture', ?, ?, ?, ?, ?, ?, " +
      "?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.ts,
      row.name,
      row.kind,
      row.sessionHash ?? null,
      row.sessionHash ? "whatsapp" : null,
      row.worker ?? null,
      row.label ?? null,
      row.dur ?? null,
      row.n1 ?? null,
      row.n2 ?? null,
      row.n3 ?? null,
      row.n4 ?? null,
      row.fields ?? null,
    );
  }
}

/** A growing tinker-bridge worker (+1 MiB/hour) and a flat gateway, over the last day. */
function seedWorkerSeries(): void {
  const start = Date.now() - 24 * HOUR_MS;
  const rows: SeedRow[] = [];
  for (let hour = 0; hour <= 10; hour++) {
    const ts = start + hour * HOUR_MS;
    rows.push({
      ts,
      name: "worker.sample",
      kind: "sample",
      worker: "fixture-growing",
      label: "tinker_bridge",
      n1: (100 + hour) * MiB,
      n4: 120 * MiB,
      fields: '{"source":"cgroup"}',
    });
    rows.push({
      ts,
      name: "worker.sample",
      kind: "sample",
      worker: "fixture-flat",
      label: "gateway",
      n1: 300 * MiB,
      n4: 310 * MiB,
      fields: '{"source":"process"}',
    });
  }
  seed(rows);
}

function seedEverything(): void {
  seedWorkerSeries();
  const now = Date.now();
  const salt = Buffer.alloc(32, 7);
  seed([
    { ts: now - HOUR_MS, name: "store.lock.held", kind: "span", label: "save", dur: 12, n1: 1 },
    { ts: now - HOUR_MS, name: "store.lock.held", kind: "span", label: "save", dur: 40, n1: 2 },
    { ts: now - 2 * HOUR_MS, name: "gw.health.sample", kind: "sample", n1: 20, n2: 1_500 },
    { ts: now - 3 * HOUR_MS, name: "gw.health.sample", kind: "sample", n1: 5, n2: 30 },
    {
      ts: now - 2 * HOUR_MS,
      name: "rpc.minute",
      kind: "rollup",
      label: "chat.history",
      n1: 9,
      n2: 900,
      n3: 400,
    },
    {
      ts: now - HOUR_MS,
      name: "history.minute",
      kind: "rollup",
      label: "reset.byte_cap",
      n1: 3,
      sessionHash: hashSessionKey(salt, RAW_KEY),
    },
    { ts: now - HOUR_MS, name: "history.minute", kind: "rollup", label: "delta", n1: 50 },
    {
      ts: now - HOUR_MS,
      name: "ui.outbox.state",
      kind: "transition",
      label: "proven",
      n1: 1,
      n2: 800,
    },
    {
      ts: now - HOUR_MS,
      name: "ui.outbox.state",
      kind: "transition",
      label: "proven",
      n1: 1,
      n2: 2_000,
    },
    { ts: now - HOUR_MS, name: "ui.outbox.state", kind: "transition", label: "gave_up", n1: 5 },
    {
      ts: now - HOUR_MS,
      name: "algo.outcome",
      kind: "outcome",
      label: "compaction/pointer",
      fields: '{"outcome":"success","metrics":{"tokensBefore":1000,"tokensAfter":200}}',
    },
  ]);
}

const caps = { rowCap: 1_000, timeBudgetMs: 5_000 };

describe("saved queries (logging.md §8.1–§8.2) — CONTROL: no query surface existed before", () => {
  it("every registry entry is admitted by the read-only guard, names only the params it declares, and has a default window when it takes one", () => {
    const names = new Set<string>();
    for (const query of SAVED_QUERIES) {
      expect(names.has(query.name), query.name).toBe(false);
      names.add(query.name);
      expect(() => assertReadOnlySelect(query.sql), query.name).not.toThrow();
      expect(query.sql.includes("@since_ms"), query.name).toBe(query.params.includes("since"));
      expect(query.sql.includes("@label"), query.name).toBe(query.params.includes("label"));
      expect(query.defaultSince !== undefined, query.name).toBe(query.params.includes("since"));
      expect(/session_key|ATTACH/i.test(query.sql), query.name).toBe(false);
    }
  });

  it("every saved query runs against a real seeded database on a read-only connection", () => {
    seedEverything();
    const reader = openReadOnlyEventsDatabase(dbPath);
    try {
      const answers = new Map<string, ReturnType<typeof runSavedQuery>>();
      for (const query of SAVED_QUERIES) {
        const resolved = resolveSavedQuery(query.name, undefined, {
          nowMs: Date.now(),
          maxRowCap: EVENTS_QUERY_RPC_MAX_ROW_CAP,
        });
        answers.set(
          query.name,
          runSavedQuery(reader, { name: query.name, params: resolved.params, ...caps }),
        );
      }
      expect(answers.get("history-resets-by-reason")?.rows).toEqual([
        expect.objectContaining({ reason: "byte_cap", calls: 3 }),
      ]);
      expect(answers.get("lock-hold-p99")?.rows).toEqual([
        expect.objectContaining({ holds: 2, p99_hold_ms: 40, max_hold_ms: 40 }),
      ]);
      expect(answers.get("outbox-proof-latency")?.rows).toEqual([
        expect.objectContaining({ proven: 2, gave_up: 1, p50_proof_ms: 800, max_proof_ms: 2_000 }),
      ]);
      expect(answers.get("loop-stalls-vs-rpc")?.rows).toEqual(
        expect.arrayContaining([expect.objectContaining({ loop_state: "stalled", minutes: 1 })]),
      );
      expect(answers.get("stalled-minute-methods")?.rows).toEqual([
        expect.objectContaining({ method: "chat.history", calls: 9, handler_ms: 900 }),
      ]);
      expect(answers.get("j1-compaction-by-variant")?.rows).toEqual([
        expect.objectContaining({
          variant: "compaction/pointer",
          outcome: "success",
          tokens_after: 200,
        }),
      ]);
      expect(answers.get("worker-memory-daily")?.rowCount).toBeGreaterThan(0);
      const catalog = answers.get(CATALOG_QUERY_NAME);
      const byName = new Map(catalog?.rows.map((row) => [row.name, row]));
      expect(byName.get("history.minute")).toMatchObject({ rows_since: 2 });
      expect(typeof byName.get("history.minute")?.last_ts_ms).toBe("number");
      expect(byName.get("gw.boot")).toMatchObject({ rows_since: 0, last_ts_ms: null });
      // --silent: the declared-and-silent rows come first, the order otherwise kept.
      const silentFirst = orderCatalogSilentFirst(catalog?.rows ?? []);
      expect(silentFirst[0]?.rows_since).toBe(0);
      expect(silentFirst.at(-1)?.rows_since).not.toBe(0);
      // L4: no answer carries the raw session key the seeded hash came from.
      expect(JSON.stringify([...answers.values()])).not.toContain(RAW_KEY_TAIL);
    } finally {
      reader.close();
    }
  });

  it("the worker-trend query returns a positive slope on a seeded growing series", () => {
    seedWorkerSeries();
    const reader = openReadOnlyEventsDatabase(dbPath);
    try {
      const result = runSavedQuery(reader, { name: "worker-memory-trend", params: {}, ...caps });
      expect(result.rows.map((row) => row.worker_id)).toEqual(["fixture-growing", "fixture-flat"]);
      expect(result.rows[0]).toMatchObject({ worker_type: "tinker_bridge", samples: 11 });
      expect(result.rows[0]?.mib_per_hour).toBeGreaterThan(0);
      expect(result.rows[1]?.mib_per_hour).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("the trend SQL has one text: the sampler's copy equals the registry's until it re-exports it", () => {
    expect(SAMPLER_TREND_SQL).toBe(WORKER_MEMORY_TREND_7D_SQL);
    expect(getSavedQuery("worker-memory-trend")?.sql).toBe(WORKER_MEMORY_TREND_7D_SQL);
  });

  it("resolveSavedQuery refuses unknown names and keys, bad windows and labels, and caps the rows", () => {
    const opts = { nowMs: 1_790_000_000_000, maxRowCap: EVENTS_QUERY_RPC_MAX_ROW_CAP };
    const refused = (fn: () => unknown) => {
      expect(fn).toThrow(EventsQueryError);
    };
    refused(() => resolveSavedQuery("no-such-query", undefined, opts));
    refused(() => resolveSavedQuery("worker-memory-trend", { since: "3d" }, opts));
    refused(() => resolveSavedQuery("history-resets-by-reason", { label: "x" }, opts));
    refused(() => resolveSavedQuery("worker-memory-daily", { since: "7 days" }, opts));
    refused(() => resolveSavedQuery("worker-memory-daily", { since: "9999d" }, opts));
    refused(() => resolveSavedQuery("worker-memory-daily", { label: "has space" }, opts));
    refused(() => resolveSavedQuery("worker-memory-daily", ["7d"], opts));
    refused(() => resolveSavedQuery("worker-memory-daily", undefined, { ...opts, limit: 0 }));
    refused(() =>
      resolveSavedQuery("worker-memory-daily", undefined, {
        ...opts,
        limit: EVENTS_QUERY_RPC_MAX_ROW_CAP + 1,
      }),
    );
    const resolved = resolveSavedQuery(
      "worker-memory-daily",
      { since: "2h", label: "gateway" },
      opts,
    );
    expect(resolved.params).toEqual({
      since_ms: Math.floor((opts.nowMs - 2 * HOUR_MS) / 60_000) * 60_000,
      label: "gateway",
    });
    expect(resolved.rowCap).toBe(1_000);
    expect(resolveSavedQuery("worker-memory-trend", {}, opts).params).toEqual({});
  });
});

describe("read-only by construction (logging.md §8.2)", () => {
  it("the guard admits one SELECT or WITH…SELECT and refuses writes, ATTACH, PRAGMA, VACUUM and a second statement", () => {
    for (const sql of [
      "SELECT 1",
      "select name from events where label = 'x;DELETE FROM events' -- DROP TABLE events",
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c LIMIT 3;",
      "SELECT replace(label, 'a', 'b') AS r FROM events /* ; DELETE */",
      'SELECT "delete" FROM (SELECT 1 AS "delete")',
    ]) {
      expect(() => assertReadOnlySelect(sql), sql).not.toThrow();
    }
    for (const sql of [
      "DELETE FROM events",
      "INSERT INTO events (ts_ms) VALUES (1)",
      "UPDATE events SET label = 'x'",
      "DROP TABLE events",
      "CREATE TEMP TABLE t (x)",
      `ATTACH DATABASE '${join(tmpDir, "other.sqlite")}' AS other`,
      "PRAGMA query_only = OFF",
      `VACUUM INTO '${join(tmpDir, "copy.sqlite")}'`,
      "SELECT 1; DELETE FROM events",
      "WITH x AS (SELECT 1) DELETE FROM events",
      "WITH x AS (SELECT 1) INSERT INTO events (ts_ms) SELECT 1",
      "SELECT 'unterminated",
      "",
    ]) {
      expect(() => assertReadOnlySelect(sql), sql).toThrow(EventsQueryError);
    }
  });

  it("the connection refuses a write on its own, without the guard — TEMP included", () => {
    seed([{ ts: Date.now(), name: "gw.boot", kind: "mark", label: "abc1234" }]);
    const reader = openReadOnlyEventsDatabase(dbPath);
    try {
      expect(() => reader.exec("DELETE FROM events")).toThrow(/readonly/i);
      expect(() => reader.exec("INSERT INTO meta (key, value) VALUES ('k', 'v')")).toThrow(
        /readonly/i,
      );
      expect(() => reader.exec("CREATE TEMP TABLE scratch (x)")).toThrow(/readonly/i);
    } finally {
      reader.close();
    }
    const left = handle.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
    expect(left.n).toBe(1);
  });

  it("a read-only open never creates a file", () => {
    expect(() => openReadOnlyEventsDatabase(join(tmpDir, "missing.sqlite"))).toThrow();
  });
});

describe("limits: the row cap and the time budget", () => {
  const counter =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 100) SELECT x FROM c";

  it("the row cap stops the answer and says so; a complete answer says nothing", () => {
    const reader = openReadOnlyEventsDatabase(dbPath);
    try {
      const capped = runEventsQuery(reader, counter, null, { rowCap: 5, timeBudgetMs: 5_000 });
      expect(capped.rows.map((row) => row.x)).toEqual([1, 2, 3, 4, 5]);
      expect(capped.truncated).toBe("row_cap");
      const whole = runEventsQuery(reader, counter, null, { rowCap: 100, timeBudgetMs: 5_000 });
      expect(whole.rowCount).toBe(100);
      expect(whole.truncated).toBeNull();
    } finally {
      reader.close();
    }
  });

  it("the time budget stops the answer between rows (a clock that advances 10 ms per read)", () => {
    const reader = openReadOnlyEventsDatabase(dbPath);
    let t = 0;
    const now = () => {
      t += 10;
      return t;
    };
    try {
      const stopped = runEventsQuery(reader, counter, null, {
        rowCap: 1_000,
        timeBudgetMs: 35,
        now,
      });
      expect(stopped.truncated).toBe("time_budget");
      expect(stopped.rowCount).toBeGreaterThan(0);
      expect(stopped.rowCount).toBeLessThan(10);
    } finally {
      reader.close();
    }
  });

  it("the isolated runner answers a SELECT with a row cap, on a child process", async () => {
    seedWorkerSeries();
    const result = await runIsolatedReadOnlySql({
      dbPath,
      sql: "SELECT worker_id, n1 FROM events ORDER BY id",
      rowCap: 3,
      timeBudgetMs: 10_000,
    });
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe("row_cap");
    expect(result.columns).toEqual(["worker_id", "n1"]);
  });

  it("the isolated runner KILLS a query stuck inside one step past its budget (the hard wall)", async () => {
    const started = Date.now();
    // One step that never returns: an aggregate over an unbounded recursive CTE. No per-row check
    // can stop it, and neither can worker.terminate(); only the SIGKILL can.
    const runaway = runIsolatedReadOnlySql({
      dbPath,
      sql: "SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c)",
      rowCap: 10,
      timeBudgetMs: 200,
    });
    await expect(runaway).rejects.toMatchObject({ code: "time_budget" });
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it("the isolated runner refuses a write before it starts, and the file is untouched", async () => {
    seed([{ ts: Date.now(), name: "gw.boot", kind: "mark", label: "abc1234" }]);
    await expect(
      runIsolatedReadOnlySql({
        dbPath,
        sql: "DELETE FROM events",
        rowCap: 10,
        timeBudgetMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "not_read_only" });
    await expect(
      runIsolatedReadOnlySql({
        dbPath,
        sql: `VACUUM INTO '${join(tmpDir, "copy.sqlite")}'`,
        rowCap: 10,
        timeBudgetMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "not_read_only" });
    const left = handle.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
    expect(left.n).toBe(1);
  });
});

describe("L4 on the way out: no raw session key in an answer", () => {
  it("a column named like a session key is refused", () => {
    expect(() => assertNoRawSessionKeyColumns(["day", "session_key"])).toThrow(EventsQueryError);
    expect(() => assertNoRawSessionKeyColumns(["sessionKey"])).toThrow(EventsQueryError);
    expect(() => assertNoRawSessionKeyColumns(["session_hash", "session_kind"])).not.toThrow();
  });

  it("a cell that parses as a raw session key is redacted and counted (a producer leaked it into a label)", () => {
    seed([
      {
        ts: Date.now() - HOUR_MS,
        name: "worker.sample",
        kind: "sample",
        worker: "w-1",
        label: RAW_KEY,
        n1: MiB,
      },
    ]);
    const reader = openReadOnlyEventsDatabase(dbPath);
    try {
      const result = runSavedQuery(reader, {
        name: "worker-memory-daily",
        params: { since_ms: 0, label: null },
        ...caps,
      });
      expect(result.redactedSessionKeys).toBe(1);
      expect(result.rows[0]?.worker_type).toBe(REDACTED_SESSION_KEY);
      expect(JSON.stringify(result)).not.toContain(RAW_KEY_TAIL);
    } finally {
      reader.close();
    }
  });
});

describe("the writer thread's `query` request (writer-worker.ts)", () => {
  it("answers a saved query by name on its own read-only connection, and an unknown name as an error", () => {
    seedWorkerSeries();
    const core = createWriterCore(handle, { saltId: "cafe0123cafe0123", bootId: "boot-1" });
    try {
      const answer = handleWriterRequest(core, {
        id: 11,
        type: "query",
        name: "worker-memory-trend",
        params: {},
        rowCap: 10,
        timeBudgetMs: 5_000,
      });
      expect(answer).toMatchObject({ id: 11, ok: true, type: "query" });
      if (answer.type === "query") {
        expect(answer.result.rows[0]).toMatchObject({ worker_id: "fixture-growing" });
      }
      const unknown = handleWriterRequest(core, {
        id: 12,
        type: "query",
        name: "DROP TABLE events",
        params: {},
        rowCap: 10,
        timeBudgetMs: 5_000,
      });
      expect(unknown).toMatchObject({ id: 12, ok: false, type: "error" });
    } finally {
      core.closeReader();
    }
  });
});
