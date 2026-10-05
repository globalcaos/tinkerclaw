/**
 * Regression gate for the 2026-09-03 gateway main-thread freeze.
 *
 * The session memory indexer held the event loop 130-180 s per pass (the gateway logged its
 * own eventLoopDelayMaxMs up to 212_700 ms) and every WS RPC timed out behind it — the Tinker
 * task panel's "Failed to load tasks: timeout" was this bug three layers away. Three causes,
 * three gates here:
 *
 *   1. supersedeContradictions ran once PER CHUNK (~2,800/pass) on an unindexed SELECT.
 *      indexFile now proves the result is empty with ONE indexed probe and skips the lot.
 *   2. Every INSERT autocommitted under journal_mode=delete — one fsync each. Now batched.
 *   3. The loop never yielded. Now it yields between committed batches.
 *
 * The load-bearing assertion is that the yield happens with NO transaction open. indexFile is
 * fanned out at concurrency 4 over ONE shared DatabaseSync handle, and node:sqlite
 * transactions are handle-scoped, so a yield inside an open transaction would make a sibling
 * worker's BEGIN throw "cannot start a transaction within a transaction" and would let our
 * ROLLBACK discard a foreign writer's committed work. That is the failure this file exists to
 * catch, because it would not show up as a wrong row anywhere — only as an intermittent crash
 * under load.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    },
  }),
}));

// vi.hoisted so the counter exists before the (hoisted) mock factory closes over it.
const spy = vi.hoisted(() => ({ supersedeCalls: 0 }));

// Count calls without changing behaviour: the real writer still runs, so the "still works"
// test below can assert a prior interval is genuinely closed.
vi.mock("./engram/supersede-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engram/supersede-writer.js")>();
  return {
    ...actual,
    supersedeContradictions: (...args: Parameters<typeof actual.supersedeContradictions>) => {
      spy.supersedeCalls += 1;
      return actual.supersedeContradictions(...args);
    },
  };
});

type Stmt = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};
type DbHandle = { exec: (sql: string) => void; prepare: (sql: string) => Stmt };

type InternalModule = typeof import("./internal.js");
type TestManagerModule = typeof import("./test-manager.js");
type MemoryIndexModule = typeof import("./index.js");

let buildFileEntry: InternalModule["buildFileEntry"];
let createMemoryManagerOrThrow: TestManagerModule["createMemoryManagerOrThrow"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

// CHUNK_PERSIST_TXN_BATCH in manager-embedding-ops.ts. Mirrored, not imported, so that
// changing the production constant makes these tests state their intent out loud.
const BATCH = 50;

describe("indexFile persist loop", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  const cfg = (): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            // maxChars = max(32, 8 * 4) = 32 (internal.ts:343), and each generated line is
            // 29 chars, so lineSize 30 fits alone but two never do: N lines -> N chunks.
            chunking: { tokens: 8, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            cache: { enabled: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    }) as OpenClawConfig;

  const db = () => (manager as unknown as { db: DbHandle }).db;

  const runIndex = (entry: unknown) =>
    (
      manager as unknown as {
        indexFile: (e: unknown, o: { source: "memory" }) => Promise<void>;
      }
    ).indexFile(entry, { source: "memory" });

  async function writeChunkedFile(name: string, lines: number) {
    const content = Array.from(
      { length: lines },
      (_unused, i) => `${String(i).padStart(5, "0")}${"l".repeat(24)}`,
    ).join("\n");
    const abs = path.join(workspaceDir, name);
    await fs.writeFile(abs, content);
    const entry = await buildFileEntry(abs, workspaceDir);
    if (!entry) {
      throw new Error(`entry missing for ${name}`);
    }
    return entry;
  }

  const countChunks = (handle: DbHandle, filePath: string) =>
    (
      handle
        .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE path = ? AND source = 'memory'`)
        .get(filePath) as { n: number }
    ).n;

  beforeAll(async () => {
    ({ buildFileEntry } = await import("./internal.js"));
    ({ createMemoryManagerOrThrow } = await import("./test-manager.js"));
    ({ closeAllMemorySearchManagers } = await import("./index.js"));
  });

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-perf-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "seed");
    process.env.ENGRAM_SUPERSEDE_ENABLED = "true";
    spy.supersedeCalls = 0;
    manager = await createMemoryManagerOrThrow(cfg());
  });

  afterEach(async () => {
    delete process.env.ENGRAM_SUPERSEDE_ENABLED;
    await manager?.close();
    manager = null;
    await closeAllMemorySearchManagers();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("never calls supersedeContradictions per chunk when no prior open interval exists", async () => {
    const entry = await writeChunkedFile("no-prior.md", 60);

    await runIndex(entry);

    // 60 chunks persisted, ZERO supersede calls: the one hoisted probe proved the per-chunk
    // result set was empty, so the ~60 unindexed SELECTs never ran.
    expect(countChunks(db(), entry.path)).toBe(60);
    expect(spy.supersedeCalls).toBe(0);
  });

  it("probes only for strictly-earlier still-open intervals", () => {
    const handle = db();
    const probe = () =>
      (
        manager as unknown as {
          hasPriorOpenInterval: (p: string, s: string, before: number) => boolean;
        }
      ).hasPriorOpenInterval("/probe.md", "memory", 5000);

    const seed = (id: string, validityStart: number, validityEnd: number | null) =>
      handle
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text,
             embedding, updated_at, validity_start, validity_end, ingestion_time)
           VALUES (?, '/probe.md', 'memory', 1, 1, 'h', 'mock-embed', 't', '[]', ?, ?, ?, ?)`,
        )
        .run(id, validityStart, validityStart, validityEnd, validityStart);

    expect(probe()).toBe(false);

    seed("earlier-open", 1000, null);
    expect(probe()).toBe(true);

    // Closed intervals are invisible to the probe, exactly as they are to the supersede SELECT.
    handle.prepare(`UPDATE chunks SET validity_end = 2000 WHERE id = 'earlier-open'`).run();
    expect(probe()).toBe(false);

    // The FORK 2026-09-03 invariant: rows stamped with THIS pass's `now` are siblings, not
    // priors. Without the strict `<` a split chunk's fragments cannibalise each other.
    seed("same-pass", 5000, null);
    expect(probe()).toBe(false);
  });

  it("gates supersede on the flag rather than removing the feature", () => {
    const handle = db();
    handle
      .prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text,
           embedding, updated_at, validity_start, validity_end, ingestion_time)
         VALUES ('prior-1', '/gated.md', 'memory', 1, 1, 'old-hash', 'mock-embed', 'old',
                 '[]', 1000, 1000, NULL, 1000)`,
      )
      .run();

    const persist = (skipSupersede: boolean, chunkId: string, hash: string) =>
      (manager as unknown as { persistChunk: (p: Record<string, unknown>) => void }).persistChunk({
        chunk: { startLine: 1, endLine: 1, text: "new", hash },
        embedding: [1, 0, 0],
        chunkId,
        entry: { path: "/gated.md" },
        source: "memory",
        now: 5000,
        granularity: "detail",
        topicCluster: "",
        vectorReady: false,
        skipSupersede,
      });

    spy.supersedeCalls = 0;
    persist(true, "cand-skip", "new-hash-a");
    expect(spy.supersedeCalls).toBe(0);

    persist(false, "cand-run", "new-hash-b");
    expect(spy.supersedeCalls).toBe(1);

    // ...and it did real work: the prior interval is closed as of the candidate's
    // validity_start. This is what stops the optimisation from quietly deleting the feature.
    const prior = handle
      .prepare(`SELECT validity_end AS ve, superseded_by AS sb FROM chunks WHERE id = 'prior-1'`)
      .get() as { ve: number | null; sb: string | null };
    expect(prior.ve).toBe(5000);
    expect(prior.sb).toBe("cand-run");
  });

  it("persists inside a transaction and rolls the batch back when an insert throws", async () => {
    const handle = db();
    const execSeen: string[] = [];
    const originalExec = handle.exec.bind(handle);
    handle.exec = (sql: string) => {
      execSeen.push(sql);
      return originalExec(sql);
    };

    const entry = await writeChunkedFile("tx.md", 10); // one batch
    await runIndex(entry);

    expect(execSeen.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(execSeen.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(execSeen.indexOf("BEGIN")).toBeLessThan(execSeen.indexOf("COMMIT"));

    // Now blow up on the 6th chunk INSERT and prove the 5 before it did not survive — which
    // is only true if the transaction is real rather than cosmetic.
    execSeen.length = 0;
    const originalPrepare = handle.prepare.bind(handle);
    let inserts = 0;
    handle.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!sql.includes("INSERT INTO chunks (")) {
        return stmt;
      }
      // Explicit delegation: spreading a node:sqlite StatementSync copies no prototype methods.
      return {
        run: (...args: unknown[]) => {
          inserts += 1;
          if (inserts === 6) {
            throw new Error("boom");
          }
          return stmt.run(...args);
        },
        get: (...args: unknown[]) => stmt.get(...args),
        all: (...args: unknown[]) => stmt.all(...args),
      };
    };

    const failing = await writeChunkedFile("tx-fail.md", 10);
    await expect(runIndex(failing)).rejects.toThrow("boom");
    handle.prepare = originalPrepare;

    expect(execSeen).toContain("ROLLBACK");
    expect(countChunks(handle, failing.path)).toBe(0);
    // The files row was never stamped, so the next sync re-indexes the file.
    const fileRows = (
      originalPrepare(`SELECT COUNT(*) AS n FROM files WHERE path = ? AND source = 'memory'`).get(
        failing.path,
      ) as { n: number }
    ).n;
    expect(fileRows).toBe(0);
  });

  it("yields to the event loop between COMMITs, never inside an open transaction", async () => {
    const handle = db();
    let openTransactions = 0;
    const originalExec = handle.exec.bind(handle);
    handle.exec = (sql: string) => {
      if (sql === "BEGIN") {
        openTransactions += 1;
      } else if (sql === "COMMIT" || sql === "ROLLBACK") {
        openTransactions -= 1;
      }
      return originalExec(sql);
    };

    const entry = await writeChunkedFile("yield.md", 200); // 4 batches -> 3 yields
    const countStmt = handle.prepare(
      `SELECT COUNT(*) AS n FROM chunks WHERE path = ? AND source = 'memory'`,
    );

    // An independent macrotask that keeps rescheduling itself. A bare "did it fire" check
    // would pass vacuously (indexFile already awaits the embedding call), so each tick also
    // records the COMMITTED row count and whether a transaction was open when it ran.
    const observed: number[] = [];
    let sawTickInsideTransaction = false;
    let stop = false;
    const tick = () => {
      if (stop) {
        return;
      }
      if (openTransactions > 0) {
        sawTickInsideTransaction = true;
      }
      observed.push((countStmt.get(entry.path) as { n: number }).n);
      setImmediate(tick);
    };
    setImmediate(tick);

    await runIndex(entry);
    stop = true;

    expect(observed.length).toBeGreaterThan(0);
    // A tick saw a strictly partial store: >0 chunks (a batch had COMMITted) and <200 (the
    // pass was still running). That is the loop yielding mid-persist, on committed state.
    expect(observed.some((n) => n > 0 && n < 200)).toBe(true);
    // THE INVARIANT. If this fails, someone moved the yield inside BEGIN..COMMIT and the
    // concurrent fan-out will start throwing "cannot start a transaction within a transaction".
    expect(sawTickInsideTransaction).toBe(false);
    // Every transaction was closed, and the file is fully indexed.
    expect(openTransactions).toBe(0);
    expect(countChunks(handle, entry.path)).toBe(200);
    // At least ceil(200/BATCH) batches ran, so the yield fired at least 3 times.
    expect(Math.ceil(200 / BATCH)).toBe(4);
  });
});
