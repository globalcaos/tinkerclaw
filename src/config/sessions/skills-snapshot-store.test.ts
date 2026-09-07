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
  MIN_EXTERNALIZED_SNAPSHOT_BYTES,
  resolveSkillsSnapshotDir,
} = await import("./skills-snapshot-store.js");

const ENV_FLAG = "OPENCLAW_SESSIONS_SKILLS_SNAPSHOT_REFS";

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
  if (previousFlag === undefined) {
    delete process.env[ENV_FLAG];
  } else {
    process.env[ENV_FLAG] = previousFlag;
  }
  clearSkillsSnapshotRefCacheForTest();
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
});
