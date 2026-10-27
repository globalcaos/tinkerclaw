/**
 * A session-store save that holds the lock for 10 s or more says which phase took the time
 * (2026-10-09: one 5.9 MB save held sessions.json for 124 s while deletes waited up to 497 s,
 * and the `store.save` row carries only the total). Same fake-CLOCK approach as
 * store-lock-events.test.ts: only `Date` is faked, so the 12 s below is a number this test
 * chose, spent inside the atomic write.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  resetSessionStoreLockRuntimeForTests,
  saveSessionStore,
} from "./store.js";
import type { SessionEntry } from "./types.js";

const warnMock = vi.hoisted(() => vi.fn());
const slowWriteMs = vi.hoisted(() => ({ value: 0 }));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "sessions/store" ? { ...logger, warn: warnMock } : logger;
    },
  };
});

vi.mock("../../infra/json-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/json-files.js")>();
  return {
    ...actual,
    writeTextAtomic: async (...args: Parameters<typeof actual.writeTextAtomic>) => {
      vi.setSystemTime(Date.now() + slowWriteMs.value);
      return await actual.writeTextAtomic(...args);
    },
  };
});

function fixtureStore(): Record<string, SessionEntry> {
  return {
    "agent:main:tinker:a": { sessionId: "a", updatedAt: 1 } as SessionEntry,
    "agent:main:tinker:b": { sessionId: "b", updatedAt: 2 } as SessionEntry,
  };
}

function slowSaveWarnings(): string[] {
  return warnMock.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.startsWith("slow session store save"));
}

describe("slow session store save warning", () => {
  let dir: string;

  beforeEach(async () => {
    warnMock.mockClear();
    slowWriteMs.value = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "store-slow-save-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetSessionStoreLockRuntimeForTests();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("names the write as the slow phase when the atomic write takes 12 s", async () => {
    slowWriteMs.value = 12_000;

    await saveSessionStore(path.join(dir, "sessions.json"), fixtureStore(), {
      skipMaintenance: true,
    });

    const warnings = slowSaveWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("12000ms");
    expect(warnings[0]).toContain("write 12000ms");
    expect(warnings[0]).toContain("maintenance 0ms");
    expect(warnings[0]).toContain("2 entries");
  });

  it("stays quiet for a fast save", async () => {
    await saveSessionStore(path.join(dir, "sessions.json"), fixtureStore(), {
      skipMaintenance: true,
    });

    expect(slowSaveWarnings()).toEqual([]);
  });
});
