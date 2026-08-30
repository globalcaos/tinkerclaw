import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import {
  resolveMaintenanceConfigFromInput,
  resolveSessionEntryMaintenanceHighWater,
} from "./store-maintenance.js";
import { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fixtureSuite = createFixtureSuite("openclaw-pruning-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Unit tests — each function called with explicit override parameters.
// No config loading needed; overrides bypass resolveMaintenanceConfig().
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - 1 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store.fresh).toBeDefined();
  });
});

describe("capEntryCount", () => {
  it("over limit: keeps N most recent by updatedAt, deletes rest", () => {
    const now = Date.now();
    const store = makeStore([
      ["oldest", makeEntry(now - 4 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["mid", makeEntry(now - 2 * DAY_MS)],
      ["recent", makeEntry(now - 1 * DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store.newest).toBeDefined();
    expect(store.recent).toBeDefined();
    expect(store.mid).toBeDefined();
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });
});

describe("resolveMaintenanceConfigFromInput", () => {
  it("defaults to enforcing session maintenance", () => {
    const maintenance = resolveMaintenanceConfigFromInput();

    expect(maintenance.mode).toBe("enforce");
  });

  it("batches normal entry-count maintenance for production-sized caps", () => {
    expect(resolveSessionEntryMaintenanceHighWater(2)).toBe(3);
    expect(resolveSessionEntryMaintenanceHighWater(50)).toBe(75);
    expect(resolveSessionEntryMaintenanceHighWater(500)).toBe(550);
  });
});

describe("getActiveSessionMaintenanceWarning", () => {
  it("warns when the active session is outside the retained recent entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["newest", makeEntry(now)],
      ["recent", makeEntry(now - 1)],
      ["active", makeEntry(now - 2)],
      ["old", makeEntry(now - 3)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 2,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
    expect(warning?.wouldPrune).toBe(false);
  });

  it("preserves insertion order tie behavior from stable sorting", () => {
    const now = Date.now();
    const store = makeStore([
      ["same-before", makeEntry(now)],
      ["active", makeEntry(now)],
      ["same-after", makeEntry(now)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 1,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FORK 2026-08-11 (the architect) — regression: entry maintenance is a plain LRU, so a
// background lane that mints sessions faster than the user talks will evict the
// user's own conversations. On 2026-08-10 the fractal-reflection lane (~70/day)
// pushed 16 real chats out of the 500-entry default cap and emptied the Tinker
// session panel down to `main`. Conversation lanes are protected BY CLASS: a
// chat is not disposable because it has been quiet.
// ---------------------------------------------------------------------------

describe("conversation sessions are never evicted by maintenance", () => {
  const CHAT_KEYS = [
    "agent:main:main",
    "agent:main:heartbeat",
    "agent:main:tinker:msok3d30",
    "agent:main:dashboard:0f4c1e22-1111-2222-3333-444455556666",
    "agent:main:whatsapp:direct:+34600000000",
  ];

  it("keeps stale chat keys that pruneStaleEntries would otherwise drop", () => {
    const now = Date.now();
    const store = makeStore([
      ...CHAT_KEYS.map((key) => [key, makeEntry(now - 400 * DAY_MS)] as [string, SessionEntry]),
      ["agent:main:subagent:dead", makeEntry(now - 400 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(Object.keys(store).sort()).toEqual([...CHAT_KEYS].sort());
  });

  it("evicts background lanes instead of chats when capEntryCount is over budget", () => {
    const now = Date.now();
    // Background lane is FRESH, chats are OLD — pure LRU would evict the chats.
    const store = makeStore([
      ...CHAT_KEYS.map((key) => [key, makeEntry(now - 10 * DAY_MS)] as [string, SessionEntry]),
      ...Array.from(
        { length: 20 },
        (_, i) =>
          [`agent:main:fractal-reflection:${i}`, makeEntry(now - i)] as [string, SessionEntry],
      ),
    ]);

    const evicted = capEntryCount(store, 5);

    expect(evicted).toBe(20);
    for (const key of CHAT_KEYS) {
      expect(store[key], `${key} must survive the cap`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// FORK 2026-08-11 (the architect) — conversation keys are preserved by CLASS.
// Regression for the 2026-08-10 incident: the fractal-reflection lane minted
// ~70 fresh sessions/day against the 500-entry default cap, and the LRU evicted
// 16 of the architect's real (quiet) conversations, emptying the Tinker session
// panel down to `main`. Recency must never decide whether a chat survives.
// ---------------------------------------------------------------------------

describe("conversation keys survive entry maintenance", () => {
  const CHAT_KEYS = [
    "agent:main:main",
    "agent:main:heartbeat",
    "agent:main:tinker:msok3d30",
    "agent:main:dashboard:2f1c9a44",
    "agent:main:whatsapp:direct:+34600000000",
  ];

  it("capEntryCount evicts background lanes instead of quiet conversations", () => {
    const now = Date.now();
    // Every chat is ancient; every background lane is seconds old.
    const store = makeStore([
      ...CHAT_KEYS.map((key) => [key, makeEntry(now - 60 * DAY_MS)] as [string, SessionEntry]),
      ...Array.from(
        { length: 8 },
        (_unused, i) =>
          [`agent:main:fractal-reflection:${i}`, makeEntry(now - i)] as [string, SessionEntry],
      ),
    ]);

    const removed = capEntryCount(store, 6, { log: false });

    expect(removed).toBeGreaterThan(0);
    for (const key of CHAT_KEYS) {
      expect(store[key], `${key} must survive the cap`).toBeDefined();
    }
    // Only background lanes were evicted.
    expect(Object.keys(store).filter((k) => k.includes("fractal-reflection")).length).toBe(
      8 - removed,
    );
  });

  it("pruneStaleEntries never prunes a conversation, however old", () => {
    const now = Date.now();
    const store = makeStore([
      ...CHAT_KEYS.map((key) => [key, makeEntry(now - 400 * DAY_MS)] as [string, SessionEntry]),
      ["agent:main:subagent:abc", makeEntry(now - 400 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, { log: false });

    expect(pruned).toBe(1);
    expect(store["agent:main:subagent:abc"]).toBeUndefined();
    for (const key of CHAT_KEYS) {
      expect(store[key], `${key} must survive pruning`).toBeDefined();
    }
  });
});
