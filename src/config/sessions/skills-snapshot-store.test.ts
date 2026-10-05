import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

const mocks = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      subsystem: "test",
      isEnabled: () => false,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: mocks.logWarn,
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: () => logger,
    };
    return logger;
  },
}));

const {
  clearSkillsSnapshotRefCacheForTest,
  externalizeSessionStoreSkillsSnapshots,
  externalizeSkillsSnapshot,
  hydrateSessionStoreSkillsSnapshots,
  hydrateSkillsSnapshot,
  isSkillsSnapshotExternalizationEnabled,
  MIN_EXTERNALIZED_SNAPSHOT_BYTES,
  resolveSkillsSnapshotDir,
  skillsSnapshotContentHash,
} = await import("./skills-snapshot-store.js");
// The RAW loader: ~12 modules import it directly, bypassing store.ts's wrapper.
const { loadSessionStore: loadSessionStoreRaw } = await import("./store-load.js");
const { saveSessionStore } = await import("./store.js");
const { clearSessionStoreCaches } = await import("./store-cache.js");

const ENV_FLAG = "OPENCLAW_SESSIONS_SKILLS_SNAPSHOT_REFS";

// Explicit maintenance so the raw loader never consults the real runtime config.
const MAINTENANCE = {
  mode: "warn" as const,
  pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};

// Comfortably above the inline threshold so externalisation actually engages.
const BIG_PROMPT = "skills catalog line\n".repeat(200);
const BIG_SKILLS = Array.from({ length: 40 }, (_, i) => ({
  name: `skill-${i}`,
  description: `a reasonably long description for skill ${i}`.repeat(3),
})) as unknown as NonNullable<SessionSkillSnapshot["resolvedSkills"]>;

let tmpRoot: string;
let storePath: string;
let previousFlag: string | undefined;

function snapshotDir(): string {
  return resolveSkillsSnapshotDir(storePath);
}

function listSidecars(): string[] {
  try {
    return fs.readdirSync(snapshotDir()).sort();
  } catch {
    return [];
  }
}

function entryWith(snapshot: SessionSkillSnapshot): SessionEntry {
  return { sessionId: "s", updatedAt: 1, skillsSnapshot: snapshot } as unknown as SessionEntry;
}

/** Externalise a store and write it where the raw loader will read it. */
async function writeExternalizedStore(store: Record<string, SessionEntry>): Promise<void> {
  const persisted = await externalizeSessionStoreSkillsSnapshots({ storePath, store });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(persisted, null, 2), "utf8");
}

beforeEach(() => {
  previousFlag = process.env[ENV_FLAG];
  process.env[ENV_FLAG] = "1";
  mocks.logWarn.mockClear();
  clearSkillsSnapshotRefCacheForTest();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-snapshot-store-"));
  // Mirrors the real layout: <agentDir>/sessions/sessions.json
  storePath = path.join(tmpRoot, "agents", "main", "sessions", "sessions.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousFlag === undefined) {
    delete process.env[ENV_FLAG];
  } else {
    process.env[ENV_FLAG] = previousFlag;
  }
  clearSkillsSnapshotRefCacheForTest();
  clearSessionStoreCaches();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("skills snapshot externalisation", () => {
  it("puts sidecars in a SIBLING of sessions/, and never escapes a flat store dir", () => {
    expect(snapshotDir()).toBe(path.join(tmpRoot, "agents", "main", "skills-snapshots"));
    // A store that is not <dir>/sessions/<file> keeps its sidecars beside itself.
    expect(resolveSkillsSnapshotDir(path.join(tmpRoot, "sessions.json"))).toBe(
      path.join(tmpRoot, "skills-snapshots"),
    );
  });

  it("round-trips prompt and resolvedSkills through content-addressed sidecars", async () => {
    const snapshot: SessionSkillSnapshot = {
      prompt: BIG_PROMPT,
      skills: [{ name: "alpha" }],
      skillFilter: ["alpha"],
      resolvedSkills: BIG_SKILLS,
      version: 7,
    };

    const persisted = await externalizeSkillsSnapshot({ storePath, snapshot });
    expect(persisted).not.toBe(snapshot);
    expect(persisted.prompt).toBeUndefined();
    expect(persisted.resolvedSkills).toBeUndefined();
    expect(persisted.promptRef).toMatch(/^[0-9a-f]{16}$/);
    expect(persisted.resolvedSkillsRef).toMatch(/^[0-9a-f]{16}$/);
    // The persisted entry must be dramatically smaller than the inline one.
    expect(JSON.stringify(persisted).length).toBeLessThan(JSON.stringify(snapshot).length / 4);

    clearSkillsSnapshotRefCacheForTest(); // force a real read back from disk
    const hydrated = hydrateSkillsSnapshot({ storePath, snapshot: persisted });
    expect(hydrated).toEqual(snapshot);
    expect(hydrated).not.toHaveProperty("promptRef");
    expect(hydrated).not.toHaveProperty("resolvedSkillsRef");
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("writes ONE sidecar for two entries that share the same prompt", async () => {
    const store: Record<string, SessionEntry> = {
      a: entryWith({ prompt: BIG_PROMPT, skills: [], version: 1 }),
      b: entryWith({ prompt: BIG_PROMPT, skills: [], version: 1 }),
      c: entryWith({ prompt: `${BIG_PROMPT}different`, skills: [], version: 1 }),
    };

    const persisted = await externalizeSessionStoreSkillsSnapshots({ storePath, store });

    const refA = (persisted.a.skillsSnapshot as { promptRef?: string }).promptRef;
    const refB = (persisted.b.skillsSnapshot as { promptRef?: string }).promptRef;
    const refC = (persisted.c.skillsSnapshot as { promptRef?: string }).promptRef;
    expect(refA).toBe(refB);
    expect(refC).not.toBe(refA);
    expect(listSidecars()).toEqual([`${refA}.txt`, `${refC}.txt`].sort());

    // The caller's store is untouched: in-memory readers keep the inline prompt.
    expect(store.a.skillsSnapshot?.prompt).toBe(BIG_PROMPT);
  });

  it("leaves a legacy inline entry untouched, on both sides", async () => {
    const legacy: SessionSkillSnapshot = { prompt: "tiny", skills: [{ name: "a" }], version: 2 };

    const persisted = await externalizeSkillsSnapshot({ storePath, snapshot: legacy });
    expect(persisted).toBe(legacy); // identity: nothing worth externalising
    expect(listSidecars()).toEqual([]);

    const hydrated = hydrateSkillsSnapshot({ storePath, snapshot: legacy });
    expect(hydrated).toBe(legacy); // identity: hydrate is a no-op
    expect(hydrated.prompt).toBe("tiny");
  });

  it("keeps hydrating after the flag is turned off (write once, read always)", async () => {
    const snapshot: SessionSkillSnapshot = { prompt: BIG_PROMPT, skills: [], version: 3 };
    const persisted = await externalizeSkillsSnapshot({ storePath, snapshot });

    process.env[ENV_FLAG] = "0";
    const store: Record<string, SessionEntry> = { a: entryWith(persisted as SessionSkillSnapshot) };
    // Externalisation is off ...
    expect(await externalizeSessionStoreSkillsSnapshots({ storePath, store })).toBe(store);
    // ... but hydration still restores what an earlier run wrote. A rollback of
    // the flag must never strand data on disk.
    hydrateSessionStoreSkillsSnapshots({ storePath, store });
    expect(store.a.skillsSnapshot?.prompt).toBe(BIG_PROMPT);
  });

  it("a missing sidecar yields prompt '' with exactly one warn, and never throws", () => {
    const orphan = {
      promptRef: "0123456789abcdef",
      skills: [],
      version: 4,
    } as unknown as SessionSkillSnapshot;

    const first = hydrateSkillsSnapshot({ storePath, snapshot: orphan });
    const second = hydrateSkillsSnapshot({ storePath, snapshot: orphan });

    expect(first.prompt).toBe("");
    expect(second.prompt).toBe("");
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it("does not externalise below the inline threshold", async () => {
    const small = "x".repeat(MIN_EXTERNALIZED_SNAPSHOT_BYTES - 1);
    const snapshot: SessionSkillSnapshot = { prompt: small, skills: [], version: 5 };
    expect(await externalizeSkillsSnapshot({ storePath, snapshot })).toBe(snapshot);
    expect(listSidecars()).toEqual([]);
  });

  it("is ON by default; the env var is only a kill switch", () => {
    delete process.env[ENV_FLAG];
    expect(isSkillsSnapshotExternalizationEnabled()).toBe(true);
    for (const off of ["0", "false", "off", "no", " OFF "]) {
      process.env[ENV_FLAG] = off;
      expect(isSkillsSnapshotExternalizationEnabled()).toBe(false);
    }
    for (const on of ["1", "true", "on", "yes", ""]) {
      process.env[ENV_FLAG] = on;
      expect(isSkillsSnapshotExternalizationEnabled()).toBe(true);
    }
  });

  it("the RAW store-load loader hydrates, so direct importers never see empty prompts", async () => {
    delete process.env[ENV_FLAG]; // the default path, as it runs in production
    const snapshot: SessionSkillSnapshot = {
      prompt: BIG_PROMPT,
      skills: [{ name: "alpha" }],
      resolvedSkills: BIG_SKILLS,
      version: 8,
    };
    await writeExternalizedStore({ a: entryWith(snapshot) });

    // Precondition: the file on disk really holds refs, not payloads.
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
      string,
      { skillsSnapshot: { prompt?: string; promptRef?: string; resolvedSkills?: unknown } }
    >;
    expect(onDisk.a.skillsSnapshot.prompt).toBeUndefined();
    expect(onDisk.a.skillsSnapshot.resolvedSkills).toBeUndefined();
    expect(onDisk.a.skillsSnapshot.promptRef).toMatch(/^[0-9a-f]{16}$/);

    clearSkillsSnapshotRefCacheForTest(); // force a real read back from disk
    const loaded = loadSessionStoreRaw(storePath, {
      skipCache: true,
      maintenanceConfig: MAINTENANCE,
    });
    expect(loaded.a.skillsSnapshot?.prompt).toBe(BIG_PROMPT);
    expect(loaded.a.skillsSnapshot?.resolvedSkills).toEqual(BIG_SKILLS);
    expect(loaded.a.skillsSnapshot).not.toHaveProperty("promptRef");
    expect(loaded.a.skillsSnapshot).not.toHaveProperty("resolvedSkillsRef");
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("entries sharing a snapshot hydrate to the SAME resolvedSkills array, through a clone too", async () => {
    const shared = (): SessionSkillSnapshot => ({
      prompt: BIG_PROMPT,
      skills: [],
      resolvedSkills: structuredClone(BIG_SKILLS),
      version: 9,
    });
    await writeExternalizedStore({ a: entryWith(shared()), b: entryWith(shared()) });
    clearSkillsSnapshotRefCacheForTest();

    const raw = loadSessionStoreRaw(storePath, {
      skipCache: true,
      clone: false,
      maintenanceConfig: MAINTENANCE,
    });
    const rawA = raw.a.skillsSnapshot?.resolvedSkills;
    expect(rawA).toEqual(BIG_SKILLS);
    expect(raw.b.skillsSnapshot?.resolvedSkills).toBe(rawA);

    // A later load reuses the memoised parse ...
    const again = loadSessionStoreRaw(storePath, {
      skipCache: true,
      clone: false,
      maintenanceConfig: MAINTENANCE,
    });
    expect(again.a.skillsSnapshot?.resolvedSkills).toBe(rawA);

    // ... and structuredClone keeps the sharing, which is the whole point:
    // N entries on one ref cost ONE array per clone, not N.
    const cloned = loadSessionStoreRaw(storePath, {
      skipCache: true,
      maintenanceConfig: MAINTENANCE,
    });
    expect(cloned.a.skillsSnapshot?.resolvedSkills).not.toBe(rawA);
    expect(cloned.b.skillsSnapshot?.resolvedSkills).toBe(cloned.a.skillsSnapshot?.resolvedSkills);
  });
});

describe("content addresses are memoised across saves (plan task 11)", () => {
  type Skills = NonNullable<SessionSkillSnapshot["resolvedSkills"]>;
  const ENTRIES = 150;
  const DISTINCT = 20;
  const SAVE = { skipMaintenance: true };

  function catalog(variant: number): Skills {
    return Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${variant}-${i}`,
      description: `a reasonably long description for skill ${i}`.repeat(3),
      sourceInfo: { source: "workspace", scope: "project" },
    })) as unknown as Skills;
  }

  /** 150 entries that share 20 resolvedSkills arrays and one prompt, like the live store. */
  function sharedStore(): { store: Record<string, SessionEntry>; catalogs: Skills[] } {
    const catalogs = Array.from({ length: DISTINCT }, (_, v) => catalog(v));
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < ENTRIES; i += 1) {
      store[`agent:main:s${i}`] = {
        sessionId: `s${i}`,
        updatedAt: i + 1,
        skillsSnapshot: {
          prompt: BIG_PROMPT,
          skills: [],
          resolvedSkills: catalogs[i % DISTINCT],
          version: 1,
        },
      } as SessionEntry;
    }
    return { store, catalogs };
  }

  const expectedRef = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

  function refsOnDisk(): Record<string, { promptRef?: string; resolvedSkillsRef?: string }> {
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
      string,
      { skillsSnapshot: { promptRef?: string; resolvedSkillsRef?: string } }
    >;
    return Object.fromEntries(Object.entries(onDisk).map(([k, v]) => [k, v.skillsSnapshot]));
  }

  function hashCalls(spy: { mock: { calls: unknown[][] } }) {
    const texts = spy.mock.calls.map(([text]) => String(text));
    // resolvedSkills JSON is an array; BIG_PROMPT never starts with "[".
    const skills = texts.filter((text) => text.startsWith("[")).length;
    return { skills, prompts: texts.length - skills };
  }

  it("150 entries on 20 shared arrays, saved twice, hash each distinct payload once", async () => {
    const hash = vi.spyOn(skillsSnapshotContentHash, "contentRef");
    const { store, catalogs } = sharedStore();

    await saveSessionStore(storePath, store, SAVE);
    await saveSessionStore(storePath, store, SAVE);

    const afterTwoSaves = hashCalls(hash);
    expect(afterTwoSaves.skills).toBeLessThanOrEqual(DISTINCT);
    expect(afterTwoSaves.prompts).toBeLessThanOrEqual(1);

    // A structuredClone'd store (every clone:true loader) holds NEW array
    // objects with the same content: the memo is keyed by content, so no rehash.
    await saveSessionStore(storePath, structuredClone(store), SAVE);
    expect(hashCalls(hash)).toEqual(afterTwoSaves);

    // The memoised refs are the true content addresses.
    const refs = refsOnDisk();
    for (let i = 0; i < ENTRIES; i += 1) {
      const ref = refs[`agent:main:s${i}`];
      expect(ref.resolvedSkillsRef).toBe(expectedRef(JSON.stringify(catalogs[i % DISTINCT])));
      expect(ref.promptRef).toBe(expectedRef(BIG_PROMPT));
    }
  });

  it("an array mutated IN PLACE between saves gets a fresh ref, never a stale one", async () => {
    const { store, catalogs } = sharedStore();
    await saveSessionStore(storePath, store, SAVE);
    const before = refsOnDisk();

    // The READ-ONLY contract forbids this, but a violation must cost CPU, not data.
    const mutated = catalogs[3] as unknown as Array<{ name: string; description: string }>;
    mutated[0].description = "rewritten in place";
    mutated.push({ name: "added-in-place", description: "pushed" });
    await saveSessionStore(storePath, store, SAVE);
    const after = refsOnDisk();

    for (let i = 0; i < ENTRIES; i += 1) {
      const key = `agent:main:s${i}`;
      if (i % DISTINCT === 3) {
        expect(after[key].resolvedSkillsRef).not.toBe(before[key].resolvedSkillsRef);
        expect(after[key].resolvedSkillsRef).toBe(expectedRef(JSON.stringify(catalogs[3])));
      } else {
        expect(after[key].resolvedSkillsRef).toBe(before[key].resolvedSkillsRef);
      }
    }

    // And the mutated content is what comes back from disk.
    clearSkillsSnapshotRefCacheForTest();
    clearSessionStoreCaches();
    const loaded = loadSessionStoreRaw(storePath, {
      skipCache: true,
      maintenanceConfig: MAINTENANCE,
    });
    expect(loaded["agent:main:s3"].skillsSnapshot?.resolvedSkills).toEqual(catalogs[3]);
    expect(loaded["agent:main:s4"].skillsSnapshot?.resolvedSkills).toEqual(catalogs[4]);
  });
});
