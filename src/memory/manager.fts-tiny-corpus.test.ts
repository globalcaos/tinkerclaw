// FORK 2026-10-29: keyword search in a word index of one or two chunks
// (TINKER_UI_DESIGN_BIBLE/embedder-fit.md, WANT 6: word search always answers). FTS5's bm25
// floors the IDF of any term found in at least half the rows to 1e-6, so with one or two rows
// every keyword hit scores about 1e-6 per term, and minScore (0.35 by default) used to drop them
// all: a fresh clone with one short memory file found nothing by its words. Below three rows the
// hits now skip the cut and keep their bm25 order; from three rows up the cut applies as before.
// Each test runs a real SQLite file with the real FTS5 schema, in a temp HOME and
// OPENCLAW_STATE_DIR, with the query defaults a fresh clone gets.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./manager.js";
import { createOpenAIEmbeddingProviderMock } from "./test-embeddings-mock.js";

type FakeEmbedder = {
  query: (text: string) => Promise<number[]>;
  batch: (texts: string[]) => Promise<number[][]>;
};

const hoisted = vi.hoisted(() => ({
  /** The hybrid test's embedder. Null: no provider, the word index only. */
  embedder: null as null | FakeEmbedder,
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => {
    const embedder = hoisted.embedder;
    if (!embedder) {
      return {
        provider: null,
        requestedProvider: "none",
        providerUnavailableReason: "test: word index only",
      };
    }
    return createOpenAIEmbeddingProviderMock({
      embedQuery: embedder.query,
      embedBatch: embedder.batch,
    });
  },
}));

type ManagerModule = typeof import("./manager.js");
let ManagerClass: ManagerModule["MemoryIndexManager"];
let closeAllMemoryIndexManagers: ManagerModule["closeAllMemoryIndexManagers"];

/** The model of the provider createOpenAIEmbeddingProviderMock returns. */
const FAKE_MODEL = "text-embedding-3-small";

let root = "";
let workspaceDir = "";
let memoryDir = "";
let indexPath = "";

beforeAll(async () => {
  ({ MemoryIndexManager: ManagerClass, closeAllMemoryIndexManagers } =
    await import("./manager.js"));
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mem-fts-tiny-"));
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  await fs.mkdir(path.join(root, "home"), { recursive: true });
  workspaceDir = path.join(root, "workspace");
  memoryDir = path.join(workspaceDir, "memory");
  indexPath = path.join(root, "index.sqlite");
  await fs.mkdir(memoryDir, { recursive: true });
  hoisted.embedder = null;
});

afterEach(async () => {
  await closeAllMemoryIndexManagers();
  hoisted.embedder = null;
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

/** No query overrides: minScore, the hybrid weights and the rest are a fresh clone's defaults. */
function cfgFor(provider: "none" | "openai" = "none"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider,
          store: { path: indexPath, vector: { enabled: false } },
          chunking: { tokens: 400, overlap: 0 },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          // The fake embedder answers in process; nothing may go to a batch API.
          remote: { batch: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

type ManagerInternals = {
  db: DatabaseSync;
  dirty: boolean;
  settings: ResolvedMemorySearchConfig;
};

function internals(manager: MemoryIndexManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

async function openSynced(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
  const manager = await ManagerClass.get({ cfg, agentId: "main" });
  if (!manager) {
    throw new Error("manager missing");
  }
  await manager.sync({ reason: "test" });
  return manager;
}

async function writeMemory(name: string, text: string): Promise<void> {
  await fs.writeFile(path.join(memoryDir, name), text);
}

function count(manager: MemoryIndexManager, sql: string, ...params: string[]): number {
  return Number(
    (
      internals(manager)
        .db.prepare(sql)
        .get(...params) as { n: number }
    ).n,
  );
}

function ftsRows(manager: MemoryIndexManager): number {
  return count(manager, `SELECT COUNT(*) AS n FROM chunks_fts`);
}

/** Eight tokens, like each bed note, so bm25's length normalisation treats every row alike. */
const IRRIGATION_NOTE = "Garden log: the irrigation timer skipped a cycle.\n";
const bedNote = (i: number) => `Garden log: watered bed ${i} before noon today.\n`;

describe("the minScore cut on keyword hits, by the size of the word index", () => {
  it("finds the only chunk of a one-chunk index by its word", async () => {
    await writeMemory("irrigation.md", "The irrigation relay sits behind the shed.\n");
    const manager = await openSynced(cfgFor());
    expect(ftsRows(manager)).toBe(1);

    const results = await manager.search("irrigation");
    expect(results.map((r) => r.path)).toEqual(["memory/irrigation.md"]);
  });

  it("control: that hit scores under minScore, so the old filter returned nothing", async () => {
    await writeMemory("irrigation.md", "The irrigation relay sits behind the shed.\n");
    const manager = await openSynced(cfgFor());
    const { minScore } = internals(manager).settings.query;
    expect(minScore).toBeGreaterThan(0);

    const results = await manager.search("irrigation");
    expect(results).toHaveLength(1);
    // The IDF floor at work: one query term with IDF 1e-6 gives at most 1e-6 × (k1 + 1).
    expect(results[0]?.score).toBeLessThan(1e-5);
    // The cut this path applied before the fix keeps none of it.
    expect(results.filter((r) => r.score >= minScore)).toEqual([]);
  });

  it("ranks the fuller match first in a two-chunk index and cuts neither", async () => {
    await writeMemory("pump.md", "Irrigation relay wiring for the garden pump.\n");
    await writeMemory("garage.md", "Relay notes for the garage door opener.\n");
    const manager = await openSynced(cfgFor());
    expect(ftsRows(manager)).toBe(2);

    // Only one chunk holds the word, and only that chunk comes back.
    const single = await manager.search("irrigation");
    expect(single.map((r) => r.path)).toEqual(["memory/pump.md"]);

    // Both hold "relay" and one holds "irrigation" too: that one ranks first, and both stay.
    const both = await manager.search("irrigation relay");
    expect(both.map((r) => r.path)).toEqual(["memory/pump.md", "memory/garage.md"]);
    expect(both[0]?.score).toBeGreaterThan(both[1]?.score ?? Number.POSITIVE_INFINITY);
  });

  it("still cuts at ten chunks: a chunk that only shares the common word is dropped", async () => {
    await writeMemory("irrigation.md", IRRIGATION_NOTE);
    for (let i = 0; i < 9; i++) {
      await writeMemory(`bed-${i}.md`, bedNote(i));
    }
    const manager = await openSynced(cfgFor());
    expect(ftsRows(manager)).toBe(10);

    const results = await manager.search("irrigation garden");
    expect(results.map((r) => r.path)).toEqual(["memory/irrigation.md"]);
  });

  it("counts the rows again after a sync, so an index that grows past two rows gets the cut back", async () => {
    await writeMemory("irrigation.md", IRRIGATION_NOTE);
    const manager = await openSynced(cfgFor());
    // One row: a hit on the common word alone stays, and the row count is now cached.
    const before = await manager.search("garden");
    expect(before.map((r) => r.path)).toEqual(["memory/irrigation.md"]);

    for (let i = 0; i < 9; i++) {
      await writeMemory(`bed-${i}.md`, bedNote(i));
    }
    internals(manager).dirty = true;
    await manager.sync({ reason: "test" });
    expect(ftsRows(manager)).toBe(10);

    // A stale count of one row would keep the nine notes that only say "garden".
    const after = await manager.search("irrigation garden");
    expect(after.map((r) => r.path)).toEqual(["memory/irrigation.md"]);
  });

  it("keeps a two-chunk index's keyword hit in the hybrid merge; a vector-only hit keeps its cut", async () => {
    let queryEmbeds = 0;
    // The query embeds on axis 0. The irrigation note lies on axis 1 (cosine 0), so only its
    // words can find it; the tomato note leans 0.29 toward the query, under the cut on its own.
    hoisted.embedder = {
      query: async () => {
        queryEmbeds += 1;
        return [1, 0, 0];
      },
      batch: async (texts) =>
        texts.map((text) => (/irrigation/i.test(text) ? [0, 1, 0] : [0.3, 1, 0])),
    };
    await writeMemory("irrigation.md", "The irrigation relay sits behind the shed.\n");
    await writeMemory("tomatoes.md", "Tomatoes want a warm afternoon and a deep soak.\n");
    const manager = await openSynced(cfgFor("openai"));
    expect(ftsRows(manager)).toBe(2);
    const vectorised = count(
      manager,
      `SELECT COUNT(*) AS n FROM chunks WHERE model = ? AND embedding <> '[]'`,
      FAKE_MODEL,
    );
    expect(vectorised).toBe(2);

    const results = await manager.search("irrigation");
    // The query was embedded, so this search took the hybrid merge, not the word-only path.
    expect(queryEmbeds).toBe(1);
    expect(results.map((r) => r.path)).toEqual(["memory/irrigation.md"]);
    // Its merged score, 0.3 × a floored bm25 score, is under the relaxed bar the old code used.
    const { minScore, hybrid } = internals(manager).settings.query;
    expect(results[0]?.score).toBeLessThan(Math.min(minScore, hybrid.textWeight));
  });
});
