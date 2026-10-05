import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import {
  resetCompactionLedgerForTest,
  settleCompactionLedgerSeedsForTest,
} from "../infra/compaction-ledger.js";
import { emitCompactionTelemetry } from "../infra/compaction-telemetry.js";
import type { EventLedgerGroup } from "../infra/events/emit.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { buildGatewaySessionRow } from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A7: the sessions.list row
// carries the entry's compactionCount and the compaction LEDGER's figures (A4), read from memory.
//
// CONTROL: before A4 / A7 src/infra/compaction-ledger.ts did not exist, so this file fails to
// import and every test is red.

/** Every read this row must NOT make, counted (failures.md M21), plus the stand-in worker. */
const probes = vi.hoisted(() => ({
  storeReads: 0,
  sqliteLoads: 0,
  /** The session keys of each seed request that reached the (stand-in) events writer. */
  seedRequests: [] as string[][],
  /** What the stand-in worker answers per session key; an unlisted key has no rows. */
  history: new Map<string, EventLedgerGroup[]>(),
}));

vi.mock("../config/sessions/store-load.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/store-load.js")>();
  return {
    ...actual,
    loadSessionStore: (...args: Parameters<typeof actual.loadSessionStore>) => {
      probes.storeReads += 1;
      return actual.loadSessionStore(...args);
    },
    loadSessionStoreEntry: (...args: Parameters<typeof actual.loadSessionStoreEntry>) => {
      probes.storeReads += 1;
      return actual.loadSessionStoreEntry(...args);
    },
    hasSessionStoreEntry: (...args: Parameters<typeof actual.hasSessionStoreEntry>) => {
      probes.storeReads += 1;
      return actual.hasSessionStoreEntry(...args);
    },
  };
});

vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    requireNodeSqlite: () => {
      probes.sqliteLoads += 1;
      return actual.requireNodeSqlite();
    },
  };
});

// The events writer's WORKER, stood in for: the ledger's only way to earlier processes' rows.
vi.mock("../infra/events/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/events/emit.js")>();
  return {
    ...actual,
    queryPriorBootLedger: async (query: { sessionKeys: readonly string[] }) => {
      probes.seedRequests.push([...query.sessionKeys]);
      return new Map(
        query.sessionKeys.map((key): [string, EventLedgerGroup[]] => [
          key,
          probes.history.get(key) ?? [],
        ]),
      );
    },
  };
});

const SESSION_KEY = "agent:main:tinker:a7-ledger";
const CFG = {
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
} as OpenClawConfig;
const LEDGER_FIELDS = ["compactions", "evictions", "droppedTokens", "lastCompactionAt"] as const;

function buildRow(key = SESSION_KEY, entry?: SessionEntry): GatewaySessionRow {
  return buildGatewaySessionRow({
    cfg: CFG,
    storePath: "",
    store: entry ? { [key]: entry } : {},
    key,
    entry,
  });
}

afterEach(() => {
  resetCompactionLedgerForTest();
  clearSessionStoreCacheForTest();
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  probes.storeReads = 0;
  probes.sqliteLoads = 0;
  probes.seedRequests.length = 0;
  probes.history.clear();
});

describe("sessions.list row: compaction counters (context-window-panel.md §6.1 A7)", () => {
  test("unseeded: compactionCount passes through and every ledger field is ABSENT (P10)", () => {
    const row = buildRow(SESSION_KEY, { updatedAt: 1, compactionCount: 3 } as SessionEntry);
    expect(row.compactionCount).toBe(3);
    const wire = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    for (const field of LEDGER_FIELDS) {
      expect(row, field).not.toHaveProperty(field);
      expect(wire, field).not.toHaveProperty(field);
    }
  });

  test("an entry that never recorded a count carries no compactionCount, not a 0", () => {
    expect(buildRow(SESSION_KEY, { updatedAt: 1 } as SessionEntry)).not.toHaveProperty(
      "compactionCount",
    );
  });

  test("once seeded the row carries the ledger's figures: earlier processes plus this one", async () => {
    probes.history.set(SESSION_KEY, [
      { trigger: "manual", rows: 2, droppedTokens: 1_000, droppedKnown: 2, lastTsMs: 1_000 },
      { trigger: "evict", rows: 1, droppedTokens: 40, droppedKnown: 1, lastTsMs: 2_000 },
    ]);
    buildRow();
    await settleCompactionLedgerSeedsForTest();
    // An eviction is not a compaction: its later timestamp does not move lastCompactionAt.
    expect(buildRow()).toMatchObject({
      compactions: 2,
      evictions: 1,
      droppedTokens: 1_040,
      lastCompactionAt: 1_000,
    });

    // A compaction in THIS process, through the A1 owner (the ledger's one writer).
    const before = Date.now();
    emitCompactionTelemetry(
      { runId: "run-a7", sessionKey: SESSION_KEY },
      {
        phase: "end",
        trigger: "cli-internal",
        lane: "cc-bridge",
        provenance: "exact",
        completed: true,
        tokensBefore: 900,
        tokensAfter: 100,
      },
    );
    const row = buildRow();
    expect(row).toMatchObject({ compactions: 3, evictions: 1, droppedTokens: 1_840 });
    expect(row.lastCompactionAt).toBeGreaterThanOrEqual(before);
  });

  test("failures.md M21: no store read, no database load; the seed is ONE batched worker request", async () => {
    // Positive controls: both spies are wired, so the zeros below cannot come from a dead spy.
    loadSessionStore(path.join(os.tmpdir(), "openclaw-a7-no-store", "sessions.json"), {
      skipCache: true,
    });
    expect(probes.storeReads).toBeGreaterThan(0);
    requireNodeSqlite();
    expect(probes.sqliteLoads).toBeGreaterThan(0);

    probes.storeReads = 0;
    probes.sqliteLoads = 0;
    const keys = [SESSION_KEY, `${SESSION_KEY}-b`, `${SESSION_KEY}-c`];
    for (const key of keys) {
      buildRow(key);
    }
    const coldRowReads = probes.storeReads;
    expect(probes.sqliteLoads).toBe(0);
    // Nothing was asked while the rows were built: the seed leaves on a microtask, as ONE
    // request for all three sessions.
    expect(probes.seedRequests).toEqual([]);
    await settleCompactionLedgerSeedsForTest();
    expect(probes.seedRequests).toEqual([keys]);

    probes.storeReads = 0;
    for (const key of keys) {
      expect(buildRow(key)).toMatchObject({ compactions: 0, evictions: 0, droppedTokens: 0 });
    }
    expect(probes.storeReads).toBe(coldRowReads);
    expect(probes.sqliteLoads).toBe(0);
    // A seeded session is never asked again.
    await settleCompactionLedgerSeedsForTest();
    expect(probes.seedRequests).toHaveLength(1);
  });
});
