import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSkillsSnapshotRefCacheForTest } from "./skills-snapshot-store.js";
import { clearSessionStoreCaches } from "./store-cache.js";
import { hasSessionStoreEntry, loadSessionStoreEntry } from "./store-load.js";
import { loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

// FORK 2026-09-23 — single-entry reads must cost O(entry), not O(store). A live
// CPU profile had ~20% of the gateway main thread in structuredClone of the
// whole sessions.json (3.6 MB, ~194 entries) for one-key lookups.

const SKILLS_ENV = "OPENCLAW_SESSIONS_SKILLS_SNAPSHOT_REFS";
const TTL_ENV = "OPENCLAW_SESSION_CACHE_TTL_MS";

// Explicit maintenance so a cold load never consults the runtime config.
const MAINTENANCE = {
  mode: "warn" as const,
  pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};
const LOAD = { maintenanceConfig: MAINTENANCE };

// Above the inline threshold, so the default save really writes sidecar refs.
const BIG_PROMPT = "skills catalog line\n".repeat(200);
const BIG_SKILLS = Array.from({ length: 40 }, (_, i) => ({
  name: `skill-${i}`,
  description: `a reasonably long description for skill ${i}`.repeat(3),
})) as unknown as NonNullable<SessionSkillSnapshot["resolvedSkills"]>;

function fixtureStore(): Record<string, SessionEntry> {
  return {
    "agent:main:hydrated": {
      sessionId: "s-hydrated",
      updatedAt: 3,
      label: "hydrated",
      skillsSnapshot: {
        prompt: BIG_PROMPT,
        skills: [{ name: "alpha" }],
        resolvedSkills: structuredClone(BIG_SKILLS),
        version: 1,
      },
    },
    "agent:main:plain": {
      sessionId: "s-plain",
      updatedAt: 2,
      label: "plain",
      origin: { provider: "webchat" },
    },
    "agent:main:other": { sessionId: "s-other", updatedAt: 1 },
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
function cachedStore(storePath: string): Record<string, SessionEntry> {
  return loadSessionStore(storePath, { ...LOAD, clone: false });
}

let tmpRoot: string;
let storePath: string;
let previousSkillsEnv: string | undefined;
let previousTtlEnv: string | undefined;

beforeEach(() => {
  previousSkillsEnv = process.env[SKILLS_ENV];
  previousTtlEnv = process.env[TTL_ENV];
  delete process.env[SKILLS_ENV];
  delete process.env[TTL_ENV];
  clearSessionStoreCaches();
  clearSkillsSnapshotRefCacheForTest();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "store-load-entry-"));
  storePath = path.join(tmpRoot, "agents", "main", "sessions", "sessions.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionStoreCaches();
  clearSkillsSnapshotRefCacheForTest();
  if (previousSkillsEnv === undefined) {
    delete process.env[SKILLS_ENV];
  } else {
    process.env[SKILLS_ENV] = previousSkillsEnv;
  }
  if (previousTtlEnv === undefined) {
    delete process.env[TTL_ENV];
  } else {
    process.env[TTL_ENV] = previousTtlEnv;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadSessionStoreEntry / hasSessionStoreEntry", () => {
  it.each([
    { name: "default (sidecar refs on disk)", killSwitch: undefined, expectRefs: true },
    { name: "kill switch (inline snapshots on disk)", killSwitch: "0", expectRefs: false },
  ])("an entry deep-equals loadSessionStore(path)[key] — $name", async (mode) => {
    if (mode.killSwitch !== undefined) {
      process.env[SKILLS_ENV] = mode.killSwitch;
    }
    const original = fixtureStore();
    await saveSessionStore(storePath, structuredClone(original), { skipMaintenance: true });
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
      string,
      { skillsSnapshot?: { prompt?: string; promptRef?: string } }
    >;
    // Precondition: the mode really changed what is persisted.
    expect(typeof onDisk["agent:main:hydrated"]?.skillsSnapshot?.promptRef === "string").toBe(
      mode.expectRefs,
    );

    // Cold caches: the accessor must hydrate through the real load path.
    clearSessionStoreCaches();
    clearSkillsSnapshotRefCacheForTest();
    const hydrated = loadSessionStoreEntry(storePath, "agent:main:hydrated", LOAD);
    expect(hydrated?.skillsSnapshot?.prompt).toBe(BIG_PROMPT);
    expect(hydrated?.skillsSnapshot).not.toHaveProperty("promptRef");
    expect(hydrated?.skillsSnapshot).not.toHaveProperty("resolvedSkillsRef");

    const full = loadSessionStore(storePath, LOAD);
    for (const key of ["agent:main:hydrated", "agent:main:plain", "agent:main:other"]) {
      expect(loadSessionStoreEntry(storePath, key, LOAD)).toEqual(full[key]);
      expect(loadSessionStoreEntry(storePath, key, LOAD)).toEqual(original[key]);
      expect(hasSessionStoreEntry(storePath, key, LOAD)).toBe(true);
    }
    expect(hydrated).toEqual(full["agent:main:hydrated"]);

    // A missing key, and a key that only exists on Object.prototype.
    expect(full["agent:main:missing"]).toBeUndefined();
    expect(loadSessionStoreEntry(storePath, "agent:main:missing", LOAD)).toBeUndefined();
    expect(hasSessionStoreEntry(storePath, "agent:main:missing", LOAD)).toBe(false);
    expect(loadSessionStoreEntry(storePath, "constructor", LOAD)).toBeUndefined();
    expect(hasSessionStoreEntry(storePath, "constructor", LOAD)).toBe(false);
  });

  it("a stored ref still hydrates after the kill switch is thrown", async () => {
    await saveSessionStore(storePath, fixtureStore(), { skipMaintenance: true });
    process.env[SKILLS_ENV] = "0";
    clearSessionStoreCaches();
    clearSkillsSnapshotRefCacheForTest();
    const entry = loadSessionStoreEntry(storePath, "agent:main:hydrated", LOAD);
    expect(entry?.skillsSnapshot?.prompt).toBe(BIG_PROMPT);
    expect(entry?.skillsSnapshot?.resolvedSkills).toEqual(BIG_SKILLS);
    expect(entry).toEqual(loadSessionStore(storePath, LOAD)["agent:main:hydrated"]);
  });

  it("clones ONLY the entry: the whole store is never structuredCloned on a cache hit", async () => {
    await saveSessionStore(storePath, fixtureStore(), { skipMaintenance: true });
    const cached = cachedStore(storePath);
    expect(cachedStore(storePath)).toBe(cached); // a warm hit, not a reload

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const entry = loadSessionStoreEntry(storePath, "agent:main:hydrated", LOAD);
    expect(entry).toEqual(cached["agent:main:hydrated"]);
    expect(entry).not.toBe(cached["agent:main:hydrated"]);
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(cloneSpy.mock.calls[0]?.[0]).toBe(cached["agent:main:hydrated"]);

    cloneSpy.mockClear();
    expect(loadSessionStoreEntry(storePath, "agent:main:missing", LOAD)).toBeUndefined();
    expect(cloneSpy).not.toHaveBeenCalled();

    // CONTROL: the default loader on the same warm cache does clone the store,
    // so the spy would have caught it.
    loadSessionStore(storePath, LOAD);
    expect(cloneSpy.mock.calls.some(([arg]) => arg === cached)).toBe(true);
  });

  it("hasSessionStoreEntry never clones; ignoreCase matches normalized keys", async () => {
    await saveSessionStore(storePath, fixtureStore(), { skipMaintenance: true });
    cachedStore(storePath); // warm

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    expect(hasSessionStoreEntry(storePath, "agent:main:plain", LOAD)).toBe(true);
    expect(hasSessionStoreEntry(storePath, "AGENT:Main:Plain", LOAD)).toBe(false);
    expect(
      hasSessionStoreEntry(storePath, " AGENT:Main:Plain ", { ...LOAD, ignoreCase: true }),
    ).toBe(true);
    expect(hasSessionStoreEntry(storePath, "agent:main:nope", { ...LOAD, ignoreCase: true })).toBe(
      false,
    );
    expect(cloneSpy).not.toHaveBeenCalled();
  });

  it("neither accessor mutates the cache, and a caller's mutation never leaks back", async () => {
    await saveSessionStore(storePath, fixtureStore(), { skipMaintenance: true });
    // Frozen: any write to the shared cached object below would throw.
    const cached = deepFreeze(cachedStore(storePath));

    const entry = loadSessionStoreEntry(storePath, "agent:main:hydrated", LOAD)!;
    expect(hasSessionStoreEntry(storePath, "agent:main:hydrated", LOAD)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(false);
    entry.label = "mutated";
    entry.skillsSnapshot!.prompt = "mutated";
    entry.skillsSnapshot!.resolvedSkills!.length = 0;

    const again = loadSessionStoreEntry(storePath, "agent:main:hydrated", LOAD);
    expect(again?.label).toBe("hydrated");
    expect(again?.skillsSnapshot?.prompt).toBe(BIG_PROMPT);
    expect(again?.skillsSnapshot?.resolvedSkills).toEqual(BIG_SKILLS);
    expect(cachedStore(storePath)).toBe(cached);
    expect(cached["agent:main:hydrated"]?.label).toBe("hydrated");
  });

  it("sees a disk change exactly when loadSessionStore does (same mtime+size checks)", async () => {
    const writeRaw = (label: string, mtime: Date) => {
      fs.writeFileSync(
        storePath,
        JSON.stringify({ "agent:main:plain": { sessionId: "s-plain", updatedAt: 2, label } }),
      );
      fs.utimesSync(storePath, mtime, mtime);
    };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const t0 = new Date(Date.now() - 60_000);
    writeRaw("v1", t0);
    expect(loadSessionStoreEntry(storePath, "agent:main:plain", LOAD)?.label).toBe("v1");

    // Different size and mtime: both readers reload.
    const t1 = new Date(t0.getTime() + 10_000);
    writeRaw("v2-longer", t1);
    expect(loadSessionStoreEntry(storePath, "agent:main:plain", LOAD)?.label).toBe("v2-longer");
    expect(loadSessionStore(storePath, LOAD)["agent:main:plain"]?.label).toBe("v2-longer");

    // Same size AND same mtime: the cache cannot tell, so both keep serving v2.
    writeRaw("v3-sameln", t1);
    expect(loadSessionStoreEntry(storePath, "agent:main:plain", LOAD)?.label).toBe("v2-longer");
    expect(loadSessionStore(storePath, LOAD)["agent:main:plain"]?.label).toBe("v2-longer");
    expect(hasSessionStoreEntry(storePath, "agent:main:plain", LOAD)).toBe(true);

    // A deletion with a new mtime is seen by both.
    fs.writeFileSync(storePath, JSON.stringify({}));
    fs.utimesSync(storePath, new Date(t1.getTime() + 10_000), new Date(t1.getTime() + 10_000));
    expect(hasSessionStoreEntry(storePath, "agent:main:plain", LOAD)).toBe(false);
    expect(loadSessionStoreEntry(storePath, "agent:main:plain", LOAD)).toBeUndefined();
    expect(loadSessionStore(storePath, LOAD)["agent:main:plain"]).toBeUndefined();
  });
});
