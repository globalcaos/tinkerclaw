import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";

// Keep deterministic: never read a real openclaw.json.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const cleanupSpy = vi.hoisted(() => vi.fn(async () => ({ removed: 0, scanned: 0 })));

vi.mock("../../gateway/session-archive.runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../../gateway/session-archive.runtime.js")>(
    "../../gateway/session-archive.runtime.js",
  )),
  cleanupArchivedSessionTranscripts: cleanupSpy,
}));

import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  resetArchiveSweepThrottleForTest,
  updateSessionStore,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE: ResolvedSessionMaintenanceConfig = {
  mode: "enforce",
  pruneAfterMs: 30 * DAY_MS,
  maxEntries: 500,
  resetArchiveRetentionMs: 30 * DAY_MS,
  maxDiskBytes: null,
  highWaterBytes: null,
};

function callsFor(reason: string): number {
  return cleanupSpy.mock.calls.filter(
    (call) => (call as unknown as [{ reason?: string }])[0]?.reason === reason,
  ).length;
}

describe("session store save-path maintenance (FORK 2026-09-21)", () => {
  let dir: string;
  let storePath: string;
  let savedCacheTtl: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-throttle-"));
    storePath = path.join(dir, "sessions.json");
    savedCacheTtl = process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();
    resetArchiveSweepThrottleForTest();
    cleanupSpy.mockClear();
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    resetArchiveSweepThrottleForTest();
    if (savedCacheTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = savedCacheTtl;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("runs the no-news archive sweep once across two consecutive saves", async () => {
    const now = Date.now();
    await updateSessionStore(
      storePath,
      (store) => {
        store.a = { sessionId: "session-a", updatedAt: now };
      },
      { maintenanceConfig: MAINTENANCE },
    );
    await updateSessionStore(
      storePath,
      (store) => {
        store.b = { sessionId: "session-b", updatedAt: now };
      },
      { maintenanceConfig: MAINTENANCE },
    );

    expect(callsFor("deleted")).toBe(1);
    expect(callsFor("reset")).toBe(1);
  });

  it("forced maintenance (maintenanceOverride) bypasses the throttle", async () => {
    const now = Date.now();
    for (const key of ["a", "b"]) {
      await updateSessionStore(
        storePath,
        (store) => {
          store[key] = { sessionId: `session-${key}`, updatedAt: now };
        },
        { maintenanceConfig: MAINTENANCE, maintenanceOverride: {} },
      );
    }

    expect(callsFor("deleted")).toBe(2);
  });

  it("keeps systemPromptReport on soft-deleted entries (deletedAt is sticky; a resumed key reads it)", async () => {
    const now = Date.now();
    const report = {
      source: "run",
      generatedAt: now,
    } as unknown as SessionEntry["systemPromptReport"];
    await updateSessionStore(
      storePath,
      (store) => {
        store.live = { sessionId: "live", updatedAt: now, systemPromptReport: report };
        store.gone = {
          sessionId: "gone",
          updatedAt: now,
          deletedAt: now,
          systemPromptReport: report,
        };
      },
      { maintenanceConfig: MAINTENANCE },
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded.live?.systemPromptReport).toEqual(report);
    expect(loaded.gone?.systemPromptReport).toEqual(report);
  });
});
