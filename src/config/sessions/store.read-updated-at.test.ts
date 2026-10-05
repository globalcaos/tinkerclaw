import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCaches } from "./store-cache.js";
import { loadSessionStore, readSessionUpdatedAt } from "./store.js";
import type { SessionEntry } from "./types.js";

// FORK 2026-09-23 — readSessionUpdatedAt runs on every inbound channel message
// (WhatsApp, Slack, Discord, Signal, iMessage envelopes) to read ONE number. It
// used to structuredClone the whole sessions.json for it.

const MAINTENANCE = {
  mode: "warn" as const,
  pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};

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

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  clearSessionStoreCaches();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-updated-at-"));
  storePath = path.join(tmpDir, "sessions.json");
  const store: Record<string, SessionEntry> = {
    "agent:main:whatsapp:direct:a": { sessionId: "s-a", updatedAt: 100 },
    // A legacy mixed-case variant of the same session, fresher than the canonical key.
    "agent:main:whatsapp:direct:B": { sessionId: "s-b-legacy", updatedAt: 300 },
    "agent:main:whatsapp:direct:b": { sessionId: "s-b", updatedAt: 200 },
  };
  fs.writeFileSync(storePath, JSON.stringify(store));
  // Warm the cache from disk with explicit maintenance (no runtime config read).
  loadSessionStore(storePath, { clone: false, maintenanceConfig: MAINTENANCE });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionStoreCaches();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readSessionUpdatedAt", () => {
  it("resolves the key the way resolveSessionStoreEntry does", () => {
    expect(readSessionUpdatedAt({ storePath, sessionKey: "agent:main:whatsapp:direct:a" })).toBe(
      100,
    );
    expect(readSessionUpdatedAt({ storePath, sessionKey: " AGENT:main:WhatsApp:direct:A " })).toBe(
      100,
    );
    // Freshest case variant wins.
    expect(readSessionUpdatedAt({ storePath, sessionKey: "agent:main:whatsapp:direct:b" })).toBe(
      300,
    );
    expect(
      readSessionUpdatedAt({ storePath, sessionKey: "agent:main:whatsapp:direct:missing" }),
    ).toBeUndefined();
  });

  it("never structuredClones or mutates the cached store", () => {
    const cached = deepFreeze(loadSessionStore(storePath, { clone: false }));
    expect(loadSessionStore(storePath, { clone: false })).toBe(cached);
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");

    expect(readSessionUpdatedAt({ storePath, sessionKey: "agent:main:whatsapp:direct:b" })).toBe(
      300,
    );
    expect(
      readSessionUpdatedAt({ storePath, sessionKey: "agent:main:whatsapp:direct:missing" }),
    ).toBeUndefined();

    expect(cloneSpy).not.toHaveBeenCalled();
    expect(loadSessionStore(storePath, { clone: false })).toBe(cached);
  });
});
