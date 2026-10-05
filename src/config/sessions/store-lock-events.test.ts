/**
 * TINKER_UI_DESIGN_BIBLE/logging.md §9 step 6 — the CONTROL for the session-store lock
 * rows, which had no rows at all before this change.
 *
 * Time is a fake CLOCK, not fake timers: only `Date` is faked, so promises, microtasks
 * and `setImmediate` still run for real and the drain queue behaves exactly as it does in
 * production, while every `wait_ms` and `dur_ms` in the assertions is a number this test
 * chose. That is what makes "the second writer's wait IS the first writer's hold" an
 * assertion about the code rather than about the machine it ran on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWriteLockTimeoutError } from "../../agents/session-write-lock-error.js";
import {
  clearSessionStoreCacheForTest,
  resetSessionStoreLockRuntimeForTests,
  saveSessionStore,
  setSessionWriteLockAcquirerForTests,
  withSessionStoreLockForTest,
} from "./store.js";
import type { SessionEntry } from "./types.js";

const emitEventMock = vi.hoisted(() => vi.fn());
vi.mock("../../infra/events/emit.js", () => ({ emitEvent: emitEventMock }));

const STORE_PATH = "/tmp/openclaw-store-lock-events.json";
const T0 = 1_700_000_000_000;

type EmittedRecord = {
  label?: string | null;
  durMs?: number | null;
  n1?: number | null;
  n2?: number | null;
  n3?: number | null;
};

function rowsFor(name: string): EmittedRecord[] {
  return emitEventMock.mock.calls
    .filter((call) => call[0] === name)
    .map((call) => (call[1] ?? {}) as EmittedRecord);
}

function okAcquirer() {
  return vi.fn(async () => ({ release: vi.fn(async () => {}) }));
}

describe("session store lock events (logging.md §4.3)", () => {
  beforeEach(() => {
    emitEventMock.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetSessionStoreLockRuntimeForTests();
  });

  it("rows two contending writers whose wait and hold add up", async () => {
    setSessionWriteLockAcquirerForTests(okAcquirer());

    const first = withSessionStoreLockForTest(
      STORE_PATH,
      async () => {
        vi.setSystemTime(T0 + 100);
      },
      { site: "writer-a" },
    );
    const second = withSessionStoreLockForTest(
      STORE_PATH,
      async () => {
        vi.setSystemTime(T0 + 150);
      },
      { site: "writer-b" },
    );
    await Promise.all([first, second]);

    const held = rowsFor("store.lock.held");
    expect(held).toHaveLength(2);
    const [a, b] = held;

    // Writer A waited for nobody and held the lock for 100 ms.
    expect(a.label).toBe("writer-a");
    expect(a.n1).toBe(0);
    expect(a.durMs).toBe(100);
    expect(a.n2).toBe(1);
    expect(a.n3).toBe(10_000);

    // Writer B arrived while A held it: its wait is EXACTLY A's hold, its arrival depth
    // counts A, and the two spans tile the whole 150 ms window with no gap.
    expect(b.label).toBe("writer-b");
    expect(b.n1).toBe(a.durMs);
    expect(b.durMs).toBe(50);
    expect(b.n2).toBe(2);
    expect((b.n1 ?? 0) + (b.durMs ?? 0)).toBe(150);

    expect(rowsFor("store.lock.timeout")).toHaveLength(0);
  });

  it("rows one store.lock.timeout and no hold when the acquire times out", async () => {
    setSessionWriteLockAcquirerForTests(
      vi.fn(async () => {
        vi.setSystemTime(T0 + 250);
        throw new SessionWriteLockTimeoutError({
          timeoutMs: 250,
          owner: "other-process",
          lockPath: `${STORE_PATH}.lock`,
        });
      }),
    );

    await expect(
      withSessionStoreLockForTest(STORE_PATH, async () => {}, {
        site: "writer-c",
        timeoutMs: 250,
      }),
    ).rejects.toBeInstanceOf(SessionWriteLockTimeoutError);

    const timeouts = rowsFor("store.lock.timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({ label: "writer-c", n1: 250, n2: 1 });
    expect(rowsFor("store.lock.held")).toHaveLength(0);
  });

  it("does NOT row a timeout when the acquire fails for another reason", async () => {
    setSessionWriteLockAcquirerForTests(
      vi.fn(async () => {
        throw new Error("EPERM: lock directory is read-only");
      }),
    );

    await expect(
      withSessionStoreLockForTest(STORE_PATH, async () => {}, { site: "writer-d" }),
    ).rejects.toThrow(/EPERM/);

    expect(rowsFor("store.lock.timeout")).toHaveLength(0);
    expect(rowsFor("store.lock.held")).toHaveLength(0);
  });

  it("rows the hold even when the guarded callback throws", async () => {
    setSessionWriteLockAcquirerForTests(okAcquirer());

    await expect(
      withSessionStoreLockForTest(
        STORE_PATH,
        async () => {
          vi.setSystemTime(T0 + 40);
          throw new Error("mutator blew up");
        },
        { site: "writer-e" },
      ),
    ).rejects.toThrow(/mutator blew up/);

    const held = rowsFor("store.lock.held");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ label: "writer-e", durMs: 40, n1: 0 });
  });

  it("records timeout_ms as 0, not NULL, for an unbounded writer", async () => {
    setSessionWriteLockAcquirerForTests(okAcquirer());

    await withSessionStoreLockForTest(STORE_PATH, async () => {}, {
      site: "writer-f",
      timeoutMs: 0,
    });

    expect(rowsFor("store.lock.held")[0]?.n3).toBe(0);
  });

  it("labels an untagged caller with the tag derived from the store path", async () => {
    setSessionWriteLockAcquirerForTests(okAcquirer());

    await withSessionStoreLockForTest(STORE_PATH, async () => {});

    expect(rowsFor("store.lock.held")[0]?.label).toBe("store:openclaw-store-lock-events");
  });

  it("falls back to the derived tag when a caller passes a label emit would drop", async () => {
    setSessionWriteLockAcquirerForTests(okAcquirer());

    await withSessionStoreLockForTest(STORE_PATH, async () => {}, {
      site: "a site with spaces",
    });

    expect(rowsFor("store.lock.held")[0]?.label).toBe("store:openclaw-store-lock-events");
  });
});

describe("session store save events (logging.md §4.3 store.save)", () => {
  let dir: string;

  function fixtureStore(): Record<string, SessionEntry> {
    return {
      "agent:main:main": { sessionId: "s-main", updatedAt: T0 },
      "agent:main:other": { sessionId: "s-other", updatedAt: T0 - 1 },
    };
  }

  // `store.save` is emitted on the NEXT tick (the byte scan stays off the hold).
  async function nextTick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(async () => {
    emitEventMock.mockClear();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-store-save-events-"));
    setSessionWriteLockAcquirerForTests(okAcquirer());
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    resetSessionStoreLockRuntimeForTests();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("rows the bytes actually written and the entry count, under the caller's site", async () => {
    const storePath = path.join(dir, "sessions.json");

    await saveSessionStore(storePath, fixtureStore(), {
      skipMaintenance: true,
      lockSite: "writer-g",
    });
    await nextTick();

    const saves = rowsFor("store.save");
    expect(saves).toHaveLength(1);
    const onDisk = await fs.promises.readFile(storePath);
    expect(saves[0]).toMatchObject({ n1: onDisk.byteLength, n2: 2 });
    expect(saves[0]?.n1).toBeGreaterThan(0);
    expect(rowsFor("store.lock.held")[0]?.label).toBe("writer-g");
  });

  it("rows a byte-identical save as 0 bytes written, not as a missing save", async () => {
    const storePath = path.join(dir, "sessions.json");

    await saveSessionStore(storePath, fixtureStore(), { skipMaintenance: true });
    await saveSessionStore(storePath, fixtureStore(), { skipMaintenance: true });
    await nextTick();

    const saves = rowsFor("store.save");
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ n1: 0, n2: 2 });
    // The untagged saveSessionStore caller carries its own stable site, not the path tag.
    expect(rowsFor("store.lock.held").map((row) => row.label)).toEqual([
      "saveSessionStore",
      "saveSessionStore",
    ]);
  });
});
