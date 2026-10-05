import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../node-sqlite.js";
import {
  classifySessionKind,
  createEventWriter,
  type EventWriter,
  type WriterWorkerRequest,
  type WriterWorkerResponse,
} from "./emit.js";

let tmpDir: string;
const writers: EventWriter[] = [];
const dbs: DatabaseSync[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "events-emit-"));
});

afterEach(async () => {
  for (const writer of writers.splice(0)) {
    await writer.stop();
  }
  for (const db of dbs.splice(0)) {
    db.close();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function writerEnv(): NodeJS.ProcessEnv {
  return { OPENCLAW_EVENTS_DB_PATH: join(tmpDir, "events.sqlite") };
}

/** Timers effectively off: the tests drive flushes explicitly. */
function makeWriter(options: Parameters<typeof createEventWriter>[0] = {}): EventWriter {
  const writer = createEventWriter({
    env: writerEnv(),
    statsIntervalMs: 0,
    maintenanceIntervalMs: 0,
    flushIntervalMs: 3_600_000,
    ...options,
  });
  writers.push(writer);
  return writer;
}

function openDb(): DatabaseSync {
  const { DatabaseSync: Database } = requireNodeSqlite();
  const db = new Database(join(tmpDir, "events.sqlite"));
  dbs.push(db);
  return db;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("classifySessionKind (§7.5 closed set, via the canonical parser family)", () => {
  it("maps every family and falls back to `other`", () => {
    expect(classifySessionKind("agent:main:main")).toBe("main");
    expect(classifySessionKind("agent:main:tinker:ms39dshj")).toBe("tinker");
    expect(classifySessionKind("agent:main:whatsapp:+15555550100")).toBe("whatsapp");
    expect(classifySessionKind("agent:main:cron:nightly:run:abc")).toBe("cron");
    expect(classifySessionKind("agent:main:subagent:xyz")).toBe("subagent");
    expect(classifySessionKind("subagent:xyz")).toBe("subagent");
    expect(classifySessionKind("agent:main:telegram:group:123")).toBe("other");
    expect(classifySessionKind("something-else")).toBe("other");
  });
});

describe("emitEvent contract (§7.5) — CONTROL: these modules did not exist before this change", () => {
  it("drops and counts an undeclared name; a declared one lands (real worker, temp db)", async () => {
    const writer = makeWriter();
    writer.emit("no.such.event", { n1: 1 });
    writer.emit("gw.boot", {
      label: "abc1234",
      fields: { node_version: "v22.0.0", plugin_count: 3 },
    });
    await writer.flush();
    const stats = writer.stats();
    expect(stats.unknownNames["no.such.event"]).toBe(1);
    expect(stats.droppedByReason.unknown_name).toBe(1);
    expect(stats.written).toBe(1);
    await writer.stop();
    const rows = openDb().prepare("SELECT name, label, kind FROM events").all() as Array<{
      name: string;
      label: string;
      kind: string;
    }>;
    expect(rows).toEqual([{ name: "gw.boot", label: "abc1234", kind: "mark" }]);
  }, 30_000);

  it("removes and counts an undeclared field key and a mistyped value", async () => {
    const writer = makeWriter();
    writer.emit("gw.boot", {
      fields: {
        node_version: "v22.0.0",
        bogus: "free text with spaces that must never land",
        plugin_count: "not a number",
      },
    });
    await writer.flush();
    const stats = writer.stats();
    expect(stats.undeclaredKeys).toBe(1);
    expect(stats.invalidValues).toBeGreaterThanOrEqual(1);
    await writer.stop();
    const row = openDb().prepare("SELECT fields FROM events WHERE name = 'gw.boot'").get() as {
      fields: string;
    };
    const fields = JSON.parse(row.fields) as Record<string, unknown>;
    expect(fields).toEqual({ node_version: "v22.0.0" });
    expect(row.fields).not.toContain("free text");
  }, 30_000);

  it("a session key carrying a phone-number-shaped string appears in NO column", async () => {
    // A fictional NANP 555-01xx number, the repo's fixture convention: never a real line.
    const rawKey = "agent:main:whatsapp:+15555550142";
    const writer = makeWriter();
    writer.emit("gw.boot", { sessionKey: rawKey, fields: { node_version: "v22.0.0" } });
    await writer.flush();
    await writer.stop();
    const row = openDb().prepare("SELECT * FROM events WHERE name = 'gw.boot'").get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain("5555550142");
    expect(JSON.stringify(row)).not.toContain(rawKey);
    expect(row.session_kind).toBe("whatsapp");
    expect(row.session_hash).toMatch(/^[0-9a-f]{16}$/);
  }, 30_000);

  it("L4: a RAW session key in a label, an id or a field refuses the whole record", async () => {
    // CONTROL: before this change ID_VALUE and LABEL_VALUE BOTH accept `agent:main:webchat:peer-1`,
    // so the label, run_id and field records below were stored with the key verbatim in their
    // column, and only query.ts's read-side redaction stood between it and a READ-scope client.
    // Run against the pre-change emit.ts this test fails: no `session_key_in_column` drops,
    // 9 records written, 5 `gw.boot` rows instead of 1, and `leaked.n` = 3 (the `::agent:` worker
    // id alone was already blanked by ID_VALUE's leading-character rule — its row still landed).
    const rawKey = "agent:main:webchat:peer-1";
    const writer = makeWriter();
    writer.emit("gw.boot", { label: rawKey });
    writer.emit("gw.boot", { label: "ok", runId: rawKey });
    // The canonical parser DROPS empty segments, so this parses too — a `startsWith` guard would
    // miss it, and ID_VALUE (which rejects a leading `:`) only blanked the slot and kept the row.
    writer.emit("gw.boot", { label: "ok", workerId: "::agent:main:x" });
    writer.emit("gw.boot", { label: "ok", fields: { node_version: rawKey } });
    // A real producer's values must survive untouched, including every `agent`-ish lookalike: the
    // guard is the canonical parser, not a prefix rule, so none of these is refused.
    for (const label of ["agents.list.main", "agentic:thing:x", "agent:main", "queue_full"]) {
      writer.emit("fts.fallback", { label });
    }
    writer.emit("gw.boot", { label: "ok", runId: "run-chat", workerId: "fts-4100-17-1" });
    await writer.flush();
    const stats = writer.stats();
    // One refused RECORD each: the reason lives in droppedByReason, whose total IS `dropped`, so n2
    // of `logs.writer.stats` keeps meaning "records that never reached the database".
    expect(stats.droppedByReason.session_key_in_column).toBe(4);
    expect(stats.written).toBe(5);
    await writer.stop();

    const db = openDb();
    const boots = db.prepare("SELECT count(*) AS n FROM events WHERE name = 'gw.boot'").get() as {
      n: number;
    };
    expect(boots.n).toBe(1);
    const kept = db
      .prepare("SELECT count(*) AS n FROM events WHERE name = 'fts.fallback'")
      .get() as { n: number };
    expect(kept.n).toBe(4);
    const leaked = db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE label LIKE 'agent:main:%' " +
          "OR run_id LIKE '%agent:main%' OR worker_id LIKE '%agent:main%' " +
          "OR fields LIKE '%agent:main%'",
      )
      .get() as { n: number };
    expect(leaked.n).toBe(0);
  }, 30_000);

  it("the salt persists: a second writer hashes the same key to the same value", async () => {
    const rawKey = "agent:main:tinker:stablekey";
    const first = makeWriter();
    first.emit("gw.boot", { sessionKey: rawKey });
    await first.flush();
    await first.stop();
    const second = makeWriter();
    second.emit("gw.boot", { sessionKey: rawKey });
    await second.flush();
    await second.stop();
    const hashes = openDb()
      .prepare("SELECT DISTINCT session_hash AS h FROM events WHERE session_hash IS NOT NULL")
      .all() as Array<{ h: string }>;
    expect(hashes).toHaveLength(1);
  }, 30_000);

  it("overflow drops the NEWEST record and counts it", async () => {
    const writer = makeWriter({ queueMax: 3 });
    for (const label of ["c1", "c2", "c3", "c4"]) {
      writer.emit("gw.boot", { label });
    }
    expect(writer.stats().droppedByReason.queue_full).toBe(1);
    await writer.flush();
    await writer.stop();
    const labels = openDb()
      .prepare("SELECT label FROM events WHERE name = 'gw.boot' ORDER BY id")
      .all() as Array<{ label: string }>;
    expect(labels.map((row) => row.label)).toEqual(["c1", "c2", "c3"]);
  }, 30_000);

  it("the production path is refused under VITEST: the writer comes up disabled", () => {
    const writer = createEventWriter({ env: { VITEST: "1" } });
    writers.push(writer);
    expect(writer.stats().enabled).toBe(false);
    writer.emit("gw.boot", {});
    expect(writer.stats().droppedByReason.test_runner).toBe(1);
    expect(writer.stats().dbPath).toBeNull();
  });

  it("a crashed worker respawns after its backoff, and the counters say what was lost", async () => {
    interface FakeWorker extends EventEmitter {
      postMessage(request: WriterWorkerRequest): void;
      ref(): void;
      unref(): void;
      terminate(): Promise<number>;
    }
    const spawned: FakeWorker[] = [];
    let mode: "ack" | "silent-crash" = "ack";
    const spawn = (): Worker => {
      const fake = new EventEmitter() as FakeWorker;
      fake.ref = () => {};
      fake.unref = () => {};
      fake.terminate = () => {
        setImmediate(() => fake.emit("exit", 1));
        return Promise.resolve(0);
      };
      fake.postMessage = (request: WriterWorkerRequest) => {
        if (mode === "silent-crash") {
          // No ack: the batch is in flight when the worker dies.
          setImmediate(() => fake.emit("exit", 1));
          return;
        }
        if (request.type === "insert") {
          const response: WriterWorkerResponse = {
            id: request.id,
            ok: true,
            type: "insert",
            inserted: request.rows.length,
          };
          setImmediate(() => fake.emit("message", response));
        }
      };
      spawned.push(fake);
      return fake as unknown as Worker;
    };

    const writer = makeWriter({ spawn: () => spawn(), respawnBackoffMs: 50 });
    mode = "silent-crash";
    writer.emit("gw.boot", { label: "lost1" });
    writer.emit("gw.boot", { label: "lost2" });
    await writer.flush();
    let stats = writer.stats();
    expect(stats.droppedByReason.worker_crash).toBe(2);
    expect(spawned).toHaveLength(1);
    // A dead thread is gone, not idle: no id (and no stale heap number) survives its teardown.
    expect(stats.writerThread).toBeNull();

    // Inside the backoff: nothing is spawned, records stay queued.
    mode = "ack";
    writer.emit("gw.boot", { label: "kept" });
    await writer.flush();
    expect(spawned).toHaveLength(1);
    expect(writer.stats().queueDepth).toBe(1);

    await sleep(60);
    await writer.flush();
    stats = writer.stats();
    expect(spawned).toHaveLength(2);
    expect(stats.respawns).toBe(1);
    expect(stats.written).toBe(1);
    expect(stats.queueDepth).toBe(0);
    // The respawned thread is a NEW worker for the worker-resources sampler: its own id (the
    // spawn ordinal), and no heap reading until its own stats probe answers.
    expect(stats.writerThread).toEqual({
      workerId: `events-writer-${process.pid}-2`,
      isolate: null,
      memBytes: null,
      peakBytes: null,
    });
  });

  it("end to end: emitted rows read back through the catalog views (§7.3)", async () => {
    const writer = makeWriter();
    writer.emit("fts.fallback", { label: "crash" });
    writer.emit("gw.health.sample", { n1: 5, n2: 10, n3: 0.5, n4: 0.2, fields: { gc_count: 1 } });
    await writer.flush();
    const refreshed = await writer.refreshDbStats();
    expect(refreshed.dbBytes).toBeGreaterThan(0);
    await writer.stop();
    const db = openDb();
    const fallback = db.prepare('SELECT "kind" FROM v_fts_fallback').get() as { kind: string };
    expect(fallback.kind).toBe("crash");
    const health = db
      .prepare("SELECT loop_p99_ms, loop_max_ms, gc_count FROM v_gw_health_sample")
      .get() as { loop_p99_ms: number; loop_max_ms: number; gc_count: number };
    expect(health.loop_p99_ms).toBe(5);
    expect(health.loop_max_ms).toBe(10);
    expect(health.gc_count).toBe(1);
  }, 30_000);

  it("the stats probe carries the writer THREAD's own isolate, under a per-spawn id", async () => {
    // CONTROL: before this change the `stats` answer carried db/wal bytes and schemaVersion only,
    // and EventWriterStats had no `writerThread`: every assertion below read `undefined`.
    const writer = makeWriter();
    // No thread yet: nothing to chart, and a stats probe never spawns one to measure.
    expect((await writer.refreshDbStats()).writerThread).toBeNull();
    writer.emit("fts.fallback", { label: "crash" });
    await writer.flush();
    const thread = (await writer.refreshDbStats()).writerThread;
    expect(thread?.workerId).toBe(`events-writer-${process.pid}-1`);
    const isolate = thread?.isolate ?? null;
    expect(isolate).not.toBeNull();
    const total = isolate?.totalHeapBytes ?? 0;
    expect(total).toBeGreaterThan(0);
    // The worker's own resourceLimits (WRITER_MAX_OLD_GENERATION_MB) bound it, not this isolate's.
    expect(isolate?.heapLimitBytes ?? 0).toBeGreaterThan(total);
    // Committed heap + external: the thread's own memory, never the process RSS it shares.
    expect(thread?.memBytes).toBe(total + (isolate?.externalBytes ?? 0));
    expect(thread?.peakBytes ?? 0).toBeGreaterThanOrEqual(thread?.memBytes ?? Infinity);
    // The THREAD's age, not the process's: the writer started after this test process did.
    expect(isolate?.uptimeMs ?? Infinity).toBeLessThan(process.uptime() * 1000);
    await writer.stop();
    expect(writer.stats().writerThread).toBeNull();
  }, 30_000);
});
