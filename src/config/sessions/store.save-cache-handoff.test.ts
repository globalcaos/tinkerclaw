import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

// Deterministic: never read a real openclaw.json. Warn-mode maintenance never
// prunes the fixture.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({ session: { maintenance: { mode: "warn" } } }),
}));

import type { MsgContext } from "../../auto-reply/templating.js";
import { clearSkillsSnapshotRefCacheForTest } from "./skills-snapshot-store.js";
import { clearSessionStoreCaches } from "./store-cache.js";
import {
  loadSessionStore,
  recordSessionMetaFromInbound,
  saveSessionStore,
  updateLastRoute,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./store.js";

// FORK 2026-09-24 (plan task 11) — a save used to structuredClone the WHOLE
// store into the object cache (~30 ms on the live 3.7 MB store). The writers
// that build their store privately and hand back ONE entry now let the cache
// adopt the store and copy only that entry. Everything else keeps the clone.

const KEY = "agent:main:main";
const OTHER = "agent:main:other";
const MAINTENANCE = {
  mode: "warn" as const,
  pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};
const TTL_ENV = "OPENCLAW_SESSION_CACHE_TTL_MS";

const BIG_PROMPT = "skills catalog line\n".repeat(200);
const BIG_SKILLS = Array.from({ length: 40 }, (_, i) => ({
  name: `skill-${i}`,
  description: `a reasonably long description for skill ${i}`.repeat(3),
})) as unknown as NonNullable<SessionSkillSnapshot["resolvedSkills"]>;

function snapshot(): SessionSkillSnapshot {
  return {
    prompt: BIG_PROMPT,
    skills: [],
    resolvedSkills: structuredClone(BIG_SKILLS),
    version: 1,
  };
}

function fixtureStore(): Record<string, SessionEntry> {
  const now = Date.now();
  return {
    [KEY]: {
      sessionId: "s-main",
      updatedAt: now,
      label: "main",
      origin: { provider: "webchat" },
      skillsSnapshot: snapshot(),
    },
    [OTHER]: {
      sessionId: "s-other",
      updatedAt: now - 1,
      label: "other",
      skillsSnapshot: snapshot(),
    },
  } as Record<string, SessionEntry>;
}

function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) {
      deepFreeze(child, seen);
    }
    Object.freeze(value);
  }
  return value;
}

/** The cache's own object: what every clone:false hit hands back. */
function cachedStore(): Record<string, SessionEntry> {
  return loadSessionStore(storePath, { clone: false, maintenanceConfig: MAINTENANCE });
}

/** What a cold load of the file produces, without touching the cache. */
function diskStore(): Record<string, SessionEntry> {
  return loadSessionStore(storePath, { skipCache: true, maintenanceConfig: MAINTENANCE });
}

const isWholeStore = (value: unknown) =>
  !!value && typeof value === "object" && Object.hasOwn(value, KEY) && Object.hasOwn(value, OTHER);

function cloneArgs(spy: { mock: { calls: unknown[][] } }) {
  const args = spy.mock.calls.map(([arg]) => arg);
  return {
    wholeStore: args.filter(isWholeStore).length,
    other: args.filter((a) => !isWholeStore(a)),
  };
}

let tmpRoot: string;
let storePath: string;
let previousTtl: string | undefined;

beforeEach(async () => {
  previousTtl = process.env[TTL_ENV];
  delete process.env[TTL_ENV];
  clearSessionStoreCaches();
  clearSkillsSnapshotRefCacheForTest();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "store-save-handoff-"));
  storePath = path.join(tmpRoot, "agents", "main", "sessions", "sessions.json");
  // Warm cache, as on the live gateway.
  await saveSessionStore(storePath, fixtureStore(), { skipMaintenance: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionStoreCaches();
  clearSkillsSnapshotRefCacheForTest();
  if (previousTtl === undefined) {
    delete process.env[TTL_ENV];
  } else {
    process.env[TTL_ENV] = previousTtl;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("single-entry writers hand the saved store to the cache", () => {
  it("updateSessionStoreEntry: no whole-store clone; the returned entry stays the caller's", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const origin = { provider: "webchat", label: "from-patch" };

    const next = await updateSessionStoreEntry({
      storePath,
      sessionKey: KEY,
      update: async () => ({ totalTokens: 42, origin }),
    });

    expect(next?.totalTokens).toBe(42);
    const clones = cloneArgs(clone);
    expect(clones.wholeStore).toBe(0);

    const cached = deepFreeze(cachedStore());
    expect(cached).toEqual(diskStore());
    // The freeze bites: writing the cached object itself throws.
    expect(() => {
      (cached[KEY] as { label?: string }).label = "x";
    }).toThrow(TypeError);

    // What callers do after the save (auto-reply keeps the returned entry as
    // activeSessionEntry and mutates it in place): none of it may reach the cache.
    next!.updatedAt = 1;
    next!.groupActivationNeedsSystemIntro = false;
    origin.label = "mutated after save";
    expect(cachedStore()).toBe(cached);
    expect(cached[KEY].updatedAt).not.toBe(1);
    expect(cached[KEY].origin).toEqual({ provider: "webchat", label: "from-patch" });
    expect(loadSessionStore(storePath, { maintenanceConfig: MAINTENANCE })).toEqual(diskStore());
    // The save's one copy was the returned entry's, for the cache.
    expect(clones.other).toEqual([
      expect.objectContaining({ sessionId: "s-main", totalTokens: 42 }),
    ]);
  });

  it("updateLastRoute: the save adds no whole-store clone; the returned entry stays the caller's", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");

    const next = await updateLastRoute({
      storePath,
      sessionKey: KEY,
      channel: "webchat",
      to: "user-1",
    });

    expect(next?.lastTo).toBe("user-1");
    // The one whole-store clone left is updateLastRoute's own clone:true LOAD
    // under the lock (a read-side follow-up); the save itself adds none.
    expect(cloneArgs(clone).wholeStore).toBe(1);

    const cached = deepFreeze(cachedStore());
    expect(cached).toEqual(diskStore());
    next!.lastTo = "mutated after save";
    if (next!.deliveryContext) {
      next!.deliveryContext.to = "mutated after save";
    }
    expect(cached[KEY].lastTo).toBe("user-1");
    expect(cached[KEY].deliveryContext?.to).toBe("user-1");
    expect(loadSessionStore(storePath, { maintenanceConfig: MAINTENANCE })).toEqual(diskStore());
  });

  it("recordSessionMetaFromInbound: no whole-store clone; the returned entry stays the caller's", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      From: "user-1",
      ChatType: "direct",
    } as MsgContext;

    const next = await recordSessionMetaFromInbound({ storePath, sessionKey: KEY, ctx });

    expect(next?.origin?.from).toBe("user-1");
    const clones = cloneArgs(clone);
    expect(clones.wholeStore).toBe(0);

    const cached = deepFreeze(cachedStore());
    expect(cached).toEqual(diskStore());
    next!.updatedAt = 1;
    next!.origin!.from = "mutated after save";
    expect(cached[KEY].updatedAt).not.toBe(1);
    expect(cached[KEY].origin?.from).toBe("user-1");
    expect(loadSessionStore(storePath, { maintenanceConfig: MAINTENANCE })).toEqual(diskStore());
    expect(clones.other).toEqual([expect.objectContaining({ sessionId: "s-main" })]);
  });
});

describe("the generic and public save paths keep the clone", () => {
  // Audit (plan task 11): updateSessionStore mutators and saveSessionStore callers
  // put objects they keep using into the store (e.g. auth-profiles/session-override
  // stores the run's live sessionEntry, then the run mutates it), and both are
  // plugin-SDK exports. The cache must not share those objects.
  it("updateSessionStore: an entry the caller keeps mutating never reaches the cache", async () => {
    const live = { ...fixtureStore()[KEY], label: "live" };
    await updateSessionStore(
      storePath,
      (store) => {
        store[KEY] = live;
      },
      { skipMaintenance: true },
    );

    const cached = deepFreeze(cachedStore());
    live.label = "caller keeps writing";
    expect(cached[KEY].label).toBe("live");
  });

  it("saveSessionStore: the caller's store object stays the caller's", async () => {
    const mine = fixtureStore();
    mine[KEY].label = "saved";
    await saveSessionStore(storePath, mine, { skipMaintenance: true });

    const cached = deepFreeze(cachedStore());
    mine[KEY].label = "caller keeps writing";
    mine[OTHER] = { ...mine[OTHER], label: "caller replaced" };
    expect(cached[KEY].label).toBe("saved");
    expect(cached[OTHER].label).toBe("other");
  });
});
