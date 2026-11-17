// FORK 2026-10-29: the core memory index under the embedder governor
// (TINKER_UI_DESIGN_BIBLE/embedder-fit.md): word-only indexing without a provider, dormancy and the
// drain, deadlines that abort, the breaker, per-batch cache progress, the reindex seed, the
// mtime/size fast path, probe searches, and closing a manager whose settings changed. Every test
// runs in a temp HOME and OPENCLAW_STATE_DIR against a fake embedder, so nothing reaches a network
// or the real state dir. The fit record is the reference bench the governor tests use.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __resetEmbedderFitForTest,
  cheapFingerprint,
  writeEmbedderFit,
  type FitDecision,
  type Measured,
} from "../fork/embedder-fit.js";
import {
  __resetEmbedGovernorsForTest,
  governEmbeddingProvider,
  governorFor,
  type EmbedGovernor,
} from "../fork/embedder-governor.js";
import "./test-runtime-mocks.js";
import type { EmbedCallOptions, EmbeddingProvider } from "./embeddings.js";
import type { MemoryIndexManager } from "./manager.js";

const hoisted = vi.hoisted(() => ({
  makeProvider: null as null | (() => unknown),
  createCalls: [] as Array<{ consumer?: string; fitDecided?: boolean }>,
  builtEntries: [] as string[],
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async (options: { consumer?: string; fitDecided?: boolean }) => {
    hoisted.createCalls.push({ consumer: options.consumer, fitDecided: options.fitDecided });
    const provider = hoisted.makeProvider?.() ?? null;
    return provider
      ? { provider, requestedProvider: "auto" }
      : {
          provider: null,
          requestedProvider: "none",
          providerUnavailableReason: "test: word index only",
        };
  },
}));

// Count the files a sync reads and hashes, without changing what it does.
vi.mock("./internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./internal.js")>();
  return {
    ...actual,
    buildFileEntry: async (...args: Parameters<typeof actual.buildFileEntry>) => {
      hoisted.builtEntries.push(args[0]);
      return await actual.buildFileEntry(...args);
    },
  };
});

type ManagerModule = typeof import("./manager.js");
let ManagerClass: ManagerModule["MemoryIndexManager"];
let closeAllMemoryIndexManagers: ManagerModule["closeAllMemoryIndexManagers"];

const BASE = "http://127.0.0.1:11434";
const MODEL = "granite-embedding:30m";
const FTS_ONLY = "fts-only";
const MIB = 2 ** 20;
const quietLog = { info: () => {}, warn: () => {} };

let root = "";
let workspaceDir = "";
let memoryDir = "";
let indexPath = "";

beforeAll(async () => {
  ({ MemoryIndexManager: ManagerClass, closeAllMemoryIndexManagers } =
    await import("./manager.js"));
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mem-embedder-fit-"));
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  // The safe reindex (a temp file, the seed, the swap) is the production path: test that one.
  vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "0");
  await fs.mkdir(path.join(root, "home"), { recursive: true });
  workspaceDir = path.join(root, "workspace");
  memoryDir = path.join(workspaceDir, "memory");
  indexPath = path.join(root, "index.sqlite");
  await fs.mkdir(memoryDir, { recursive: true });
  __resetEmbedderFitForTest();
  __resetEmbedGovernorsForTest({
    log: quietLog,
    loadavg: () => [0, 0, 0],
    logicalCores: () => 4,
    readPsi: null,
  });
  hoisted.makeProvider = null;
  hoisted.createCalls.length = 0;
  hoisted.builtEntries.length = 0;
});

afterEach(async () => {
  await closeAllMemoryIndexManagers();
  __resetEmbedGovernorsForTest();
  __resetEmbedderFitForTest();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function measured(value: number, unit: string): Measured {
  return { value, unit, provenance: "local-measured", source: "test fixture" };
}

/** granite-embedding:30m as the fit measured it on the reference host (338.2 tokens/s). */
function seedFitRecord(decision: Partial<FitDecision> = {}): void {
  writeEmbedderFit({
    schemaVersion: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    fingerprint: cheapFingerprint(),
    inventory: {
      ollama: { baseUrl: BASE, reachable: true, models: [{ name: MODEL, digest: "sha256:0" }] },
      nodeLlamaCpp: false,
      remoteKeys: [],
    },
    candidates: [
      {
        provider: "ollama",
        model: MODEL,
        coldLoadMs: 7200,
        queryP50Ms: 77,
        queryP95Ms: 1672,
        tokensPerSec: measured(338.2, "tokens/s"),
        tokensPerSecLow95: 300,
        tokensPerSecHigh95: 375,
        batchDispersion: 2,
        overheadMs: 60,
        rssBytes: 92 * MIB,
        sanityOk: true,
      },
    ],
    corpus: {
      files: 7719,
      tokens: measured(10_144_896, "tokens"),
      ingestTokensPerDay: measured(266_194, "tokens/day"),
      burstFactor: measured(6.12, "peak day / mean day"),
      chunkTokens: 400,
      overlapTokens: 80,
    },
    missCostSec: measured(21.57, "s"),
    nonEnglishShare: measured(0.022, "share"),
    fitWallSeconds: measured(150, "s"),
    decision: {
      mode: "memory",
      provider: "ollama",
      model: MODEL,
      dormantUntilDemand: false,
      demandBreakEvenPerDay: 0,
      reasons: ["fixture decision"],
      verdicts: [],
      ...decision,
    },
    consent: { remote: null },
    tool: { command: "openclaw embedder fit", version: "test" },
    history: [],
  });
}

type FakeEmbedder = EmbeddingProvider & {
  calls: number;
  signals: AbortSignal[];
  behaviour: "ok" | "hang" | "http500";
  failOnCall?: number;
};

/** A count vector over two words, [alpha, zebra, 1], so the vector half has something to rank. */
function vectorOf(text: string): number[] {
  const lower = text.toLowerCase();
  return [lower.split("alpha").length - 1, lower.split("zebra").length - 1, 1];
}

function fakeEmbedder(): FakeEmbedder {
  const fake: FakeEmbedder = {
    id: "ollama",
    model: MODEL,
    // Without it the Ollama default cap (1,400 bytes) would split the 1,600-character chunks.
    maxInputTokens: 8192,
    calls: 0,
    signals: [],
    behaviour: "ok",
    async embedBatch(texts: string[], opts?: EmbedCallOptions): Promise<number[][]> {
      fake.calls += 1;
      if (opts?.signal) {
        fake.signals.push(opts.signal);
      }
      if (fake.behaviour === "hang") {
        // A server that never answers; like fetch, it gives up only when its signal aborts.
        return await new Promise<number[][]>((_, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        });
      }
      if (fake.behaviour === "http500" || fake.calls === fake.failOnCall) {
        throw new Error("Ollama embeddings HTTP 500: model runner has unexpectedly stopped");
      }
      return texts.map(vectorOf);
    },
    async embedQuery(text: string, opts?: EmbedCallOptions): Promise<number[]> {
      const [vector] = await fake.embedBatch([text], opts);
      return vector ?? [];
    },
  };
  return fake;
}

/** What createEmbeddingProvider hands the manager: the fake, wrapped by its endpoint's governor. */
function useGovernedEmbedder(fake: FakeEmbedder): EmbedGovernor {
  const provider = governEmbeddingProvider(fake, {
    consumer: "memory-index",
    baseUrl: BASE,
    mode: "fit",
  });
  hoisted.makeProvider = () => provider;
  const governor = governorFor(provider);
  if (!governor) {
    throw new Error("expected a governed provider");
  }
  return governor;
}

function cfgFor(
  params: {
    provider?: string;
    onSearch?: boolean;
    onSessionStart?: boolean;
    query?: { maxResults?: number };
  } = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: params.provider ?? "auto",
          store: { path: indexPath, vector: { enabled: false } },
          chunking: { tokens: 400, overlap: 0 },
          sync: {
            watch: false,
            onSessionStart: params.onSessionStart ?? false,
            onSearch: params.onSearch ?? false,
          },
          query: { minScore: 0, ...params.query },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

type ManagerInternals = {
  db: DatabaseSync;
  dirty: boolean;
  closed: boolean;
  providerKey: string;
  sync: MemoryIndexManager["sync"];
  runSafeReindex: (params: unknown) => Promise<void>;
  runUnsafeReindex: (params: unknown) => Promise<void>;
  openDatabaseAtPath: (dbPath: string) => DatabaseSync;
};

function internals(manager: MemoryIndexManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

async function openManager(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
  const manager = await ManagerClass.get({ cfg, agentId: "main" });
  if (!manager) {
    throw new Error("manager missing");
  }
  return manager;
}

async function writeMemory(name: string, text: string): Promise<string> {
  const abs = path.join(memoryDir, name);
  await fs.writeFile(abs, text);
  return abs;
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

function modelsOf(manager: MemoryIndexManager, relPath?: string): string[] {
  const db = internals(manager).db;
  const rows = (
    relPath
      ? db.prepare(`SELECT DISTINCT model FROM chunks WHERE path = ? ORDER BY model`).all(relPath)
      : db.prepare(`SELECT DISTINCT model FROM chunks ORDER BY model`).all()
  ) as Array<{ model: string }>;
  return rows.map((row) => row.model);
}

function countReindexes(manager: MemoryIndexManager): { count: number } {
  const target = internals(manager);
  const counter = { count: 0 };
  for (const name of ["runSafeReindex", "runUnsafeReindex"] as const) {
    const original = target[name].bind(manager);
    target[name] = async (params) => {
      counter.count += 1;
      await original(params);
    };
  }
  return counter;
}

function captureSyncs(manager: MemoryIndexManager): Array<Promise<void>> {
  const started: Array<Promise<void>> = [];
  const target = internals(manager);
  const sync = target.sync.bind(manager);
  target.sync = (params) => {
    const run = sync(params);
    started.push(run);
    return run;
  };
  return started;
}

/** Record the SQL of every statement prepared on the manager's handles, and of each .all(). */
function watchStatements(manager: MemoryIndexManager): { prepared: string[]; all: string[] } {
  const seen = { prepared: [] as string[], all: [] as string[] };
  const wrap = (db: DatabaseSync): DatabaseSync => {
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
      seen.prepared.push(sql);
      const statement = prepare(sql);
      return new Proxy(statement, {
        get(target, prop) {
          if (prop === "all") {
            return (...args: unknown[]) => {
              seen.all.push(sql);
              return (target as unknown as { all: (...a: unknown[]) => unknown[] }).all(...args);
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return db;
  };
  const target = internals(manager);
  wrap(target.db);
  const open = target.openDatabaseAtPath.bind(manager);
  target.openDatabaseAtPath = (dbPath) => wrap(open(dbPath));
  return seen;
}

describe("the core memory index under the embedder governor", () => {
  it("indexes words with no provider, finds them, and does not rebuild on the next sync", async () => {
    await writeMemory("2026-10-01.md", "# Notes\nThe zebra crossing near the station.\n");
    const manager = await openManager(cfgFor());
    // An unset provider resolves through the fit (no record here: 'none'), so it is fit-decided.
    expect(hoisted.createCalls).toEqual([{ consumer: "memory-index", fitDecided: true }]);
    const reindexes = countReindexes(manager);

    await manager.sync({ reason: "test" });
    expect(reindexes.count).toBe(1);
    const db = internals(manager).db;
    expect(count(db, `SELECT COUNT(*) AS n FROM chunks`)).toBeGreaterThan(0);
    expect(modelsOf(manager)).toEqual([FTS_ONLY]);
    expect(count(db, `SELECT COUNT(*) AS n FROM chunks WHERE embedding <> '[]'`)).toBe(0);
    expect(
      count(db, `SELECT COUNT(*) AS n FROM chunks_fts WHERE model = ?`, FTS_ONLY),
    ).toBeGreaterThan(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'chunks_vec'`)).toBe(0);

    const results = await manager.search("zebra station");
    expect(results.map((r) => r.path)).toContain("memory/2026-10-01.md");

    internals(manager).dirty = true;
    await manager.sync({ reason: "test" });
    expect(reindexes.count).toBe(1);
  });

  it("keeps a dormant index word-only, then drains it to vectors once real demand arms it", async () => {
    seedFitRecord({ dormantUntilDemand: true, demandBreakEvenPerDay: 1 });
    const fake = fakeEmbedder();
    const governor = useGovernedEmbedder(fake);
    await writeMemory("2026-10-02.md", "Alpha project kickoff notes.\n");
    const manager = await openManager(cfgFor({ onSearch: true }));

    await manager.sync({ reason: "test" });
    expect(fake.calls).toBe(0);
    expect(modelsOf(manager)).toEqual([FTS_ONLY]);
    expect(governor.admit("index")).toEqual({ ok: false, reason: "dormant" });
    expect(governor.snapshot().derived.pendingTokens).toBeGreaterThan(0);

    const syncs = captureSyncs(manager);
    // The first real search is demand. Nothing is embedded yet, so words answer it.
    const first = await manager.search("alpha kickoff", { caller: "agent" });
    expect(first.map((r) => r.path)).toContain("memory/2026-10-02.md");
    expect(syncs).toHaveLength(0);
    expect(fake.calls).toBe(0);

    // Demand now meets Q* (1 a day): the next search starts the background sync that drains.
    await manager.search("alpha kickoff", { caller: "agent" });
    expect(syncs).toHaveLength(1);
    await Promise.all(syncs);
    expect(modelsOf(manager)).toEqual([MODEL]);
    expect(fake.calls).toBeGreaterThan(0);
    expect(governor.snapshot().derived.pendingTokens).toBe(0);
  });

  it("serves keyword results within the query budget when the embedder hangs, and aborts the hung batch", async () => {
    seedFitRecord();
    const fake = fakeEmbedder();
    const governor = useGovernedEmbedder(fake);
    await writeMemory("2026-10-03.md", "Alpha release checklist.\n");
    const manager = await openManager(cfgFor());
    await manager.sync({ reason: "test" });
    expect(modelsOf(manager)).toEqual([MODEL]);

    fake.behaviour = "hang";
    const budgetMs = governor.budget("query").queryDeadlineMs;
    const started = Date.now();
    const results = await manager.search("alpha checklist", { caller: "agent" });
    expect(Date.now() - started).toBeLessThan(budgetMs);
    expect(results.map((r) => r.path)).toContain("memory/2026-10-03.md");
    expect(fake.signals.at(-1)?.aborted).toBe(true);

    // A batch sent to the hung embedder is abandoned at its deadline: the signal the provider got
    // is aborted, the call is not retried, and the new file is indexed words only, so the sync
    // still resolves.
    await writeMemory("2026-10-04.md", "Alpha retro notes.\n");
    internals(manager).dirty = true;
    const callsBefore = fake.calls;
    await manager.sync({ reason: "test" });
    expect(fake.calls).toBe(callsBefore + 1);
    expect(fake.signals.at(-1)?.aborted).toBe(true);
    expect(modelsOf(manager, "memory/2026-10-04.md")).toEqual([FTS_ONLY]);
    expect(modelsOf(manager, "memory/2026-10-03.md")).toEqual([MODEL]);
  });

  it("opens the breaker after F endpoint failures and indexes the rest of the sync words only, without throwing", async () => {
    seedFitRecord();
    const fake = fakeEmbedder();
    fake.behaviour = "http500";
    const governor = useGovernedEmbedder(fake);
    for (let i = 1; i <= 8; i++) {
      await writeMemory(`2026-09-0${i}.md`, `Alpha note number ${i}.\n`);
    }
    const manager = await openManager(cfgFor());

    await expect(manager.sync({ reason: "test" })).resolves.toBeUndefined();
    const breaker = governor.snapshot().breaker;
    expect(breaker.state).toBe("open");
    // One call per file until the breaker opened at its derived threshold F; none after it.
    expect(fake.calls).toBe(breaker.consecutiveFailures);
    expect(fake.calls).toBeGreaterThanOrEqual(2);
    expect(fake.calls).toBeLessThan(8);
    expect(modelsOf(manager)).toEqual([FTS_ONLY]);
    expect(count(internals(manager).db, `SELECT COUNT(DISTINCT path) AS n FROM chunks`)).toBe(8);
  });

  it("keeps the batches that succeeded in the cache when a later batch of the file fails", async () => {
    seedFitRecord();
    const fake = fakeEmbedder();
    fake.failOnCall = 3;
    useGovernedEmbedder(fake);
    // Six chunks of about 393 tokens: the fit's 1,128-token batch plan puts two in each, so there
    // are three batches, and the third fails.
    const paragraphs = Array.from(
      { length: 6 },
      (_, i) => `Paragraph ${i} ${"alpha ".repeat(260)}`,
    );
    await writeMemory("2026-10-05.md", paragraphs.join("\n"));
    const manager = await openManager(cfgFor());
    const cached = () =>
      count(
        internals(manager).db,
        `SELECT COUNT(*) AS n FROM embedding_cache WHERE model = ?`,
        MODEL,
      );

    await manager.sync({ reason: "test" });
    expect(fake.calls).toBe(3);
    expect(cached()).toBe(4);
    expect(modelsOf(manager, "memory/2026-10-05.md")).toEqual([FTS_ONLY]);

    // Recovered: the drain re-indexes the file and embeds only the batch that failed.
    fake.failOnCall = undefined;
    await manager.sync({ reason: "test" });
    expect(fake.calls).toBe(4);
    expect(cached()).toBe(6);
    expect(modelsOf(manager, "memory/2026-10-05.md")).toEqual([MODEL]);
  });

  it("seeds a reindex with this provider's cache rows only, copied inside SQLite and never read whole", async () => {
    seedFitRecord();
    const fake = fakeEmbedder();
    useGovernedEmbedder(fake);
    await writeMemory("2026-10-06.md", "Alpha seed check.\n");
    const manager = await openManager(cfgFor());
    await manager.sync({ reason: "test" });

    const live = internals(manager).db;
    const key = internals(manager).providerKey;
    const own = count(
      live,
      `SELECT COUNT(*) AS n FROM embedding_cache WHERE provider = 'ollama' AND model = ? AND provider_key = ?`,
      MODEL,
      key,
    );
    expect(own).toBeGreaterThan(0);
    const insert = live.prepare(
      `INSERT INTO embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, '[1,2]', 2, 1)`,
    );
    insert.run("openai", "text-embedding-3-small", "other-key", "foreign-1");
    insert.run("ollama", MODEL, "other-key", "foreign-2");
    insert.run("ollama", "nomic-embed-text", key, "foreign-3");

    const statements = watchStatements(manager);
    const callsBefore = fake.calls;
    await manager.sync({ force: true });
    // Take the evidence before this test runs any query of its own on the watched handles.
    const allOverCache = statements.all.filter((sql) => sql.includes("embedding_cache"));
    const seeded = statements.prepared.some((sql) =>
      /INSERT INTO embedding_cache[\s\S]+SELECT[\s\S]+FROM seed_src\.embedding_cache/.test(sql),
    );

    // Object.is, not .not.toBe: on a mismatch vitest deep-compares both handles, and a closed
    // DatabaseSync throws from its getters.
    expect(Object.is(internals(manager).db, live)).toBe(false);
    expect(seeded).toBe(true);
    // The only .all() over the cache is the lookup by hash; nothing read the cache whole.
    expect(allOverCache.every((sql) => sql.includes("hash IN ("))).toBe(true);
    // Every vector came from the seeded cache: the forced reindex embedded nothing.
    expect(fake.calls).toBe(callsBefore);
    const rows = internals(manager)
      .db.prepare(`SELECT provider, model, provider_key AS key FROM embedding_cache`)
      .all() as Array<{ provider: string; model: string; key: string }>;
    expect(rows).toHaveLength(own);
    expect(
      rows.every((row) => row.provider === "ollama" && row.model === MODEL && row.key === key),
    ).toBe(true);
  });

  it("neither reads nor hashes an unchanged file on a later sync", async () => {
    const files = await Promise.all(
      ["2026-10-11.md", "2026-10-12.md", "2026-10-13.md"].map((name, i) =>
        writeMemory(name, `Alpha file ${i}.\n`),
      ),
    );
    const manager = await openManager(cfgFor());
    await manager.sync({ reason: "test" });
    expect(hoisted.builtEntries.toSorted()).toEqual(files.toSorted());

    hoisted.builtEntries.length = 0;
    internals(manager).dirty = true;
    await manager.sync({ reason: "test" });
    expect(hoisted.builtEntries).toEqual([]);
    // Skipped files still count as active: their rows were not pruned as stale.
    expect(count(internals(manager).db, `SELECT COUNT(*) AS n FROM files`)).toBe(3);

    // A changed file is read again, and only that one.
    const changed = files[0];
    await fs.writeFile(changed, "Alpha file 0, edited.\n");
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(changed, later, later);
    internals(manager).dirty = true;
    await manager.sync({ reason: "test" });
    expect(hoisted.builtEntries).toEqual([changed]);
  });

  it("answers a probe from words only: no warm-up, no sync, no embedding call, no demand", async () => {
    seedFitRecord();
    const fake = fakeEmbedder();
    const governor = useGovernedEmbedder(fake);
    await writeMemory("2026-10-07.md", "Alpha probe target.\n");
    const manager = await openManager(cfgFor({ onSearch: true, onSessionStart: true }));
    await manager.sync({ reason: "test" });
    expect(modelsOf(manager)).toEqual([MODEL]);

    internals(manager).dirty = true; // a normal search would start a sync now
    const syncs = captureSyncs(manager);
    const callsBefore = fake.calls;
    const results = await manager.search("alpha probe", {
      caller: "probe",
      sessionKey: "probe-session",
    });
    expect(results.map((r) => r.path)).toContain("memory/2026-10-07.md");
    expect(syncs).toHaveLength(0);
    expect(fake.calls).toBe(callsBefore);
    const today = governor.snapshot().days.at(-1);
    expect([today?.agent, today?.rpc, today?.probe, today?.internal]).toEqual([0, 0, 0, 0]);
  });

  it("closes the manager of an index whose settings changed", async () => {
    const first = await openManager(cfgFor({ provider: "none", query: { maxResults: 5 } }));
    // An explicit provider is a pin, not the fit's decision.
    expect(hoisted.createCalls.at(-1)).toEqual({ consumer: "memory-index", fitDecided: false });
    const second = await openManager(cfgFor({ provider: "none", query: { maxResults: 7 } }));
    // Object.is for the same reason as in the seed test: `first` now holds a closed handle.
    expect(Object.is(second, first)).toBe(false);
    expect(internals(first).closed).toBe(true);
    // Its database handle is released too.
    expect(() => internals(first).db.prepare("SELECT 1")).toThrow();
    expect(second.status().files).toBe(0);
  });
});
