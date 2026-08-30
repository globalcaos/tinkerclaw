import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCaches,
  invalidateSessionStoreCache,
  readSessionStoreCache,
  writeSessionStoreCache,
} from "./store-cache.js";
import type { SessionEntry } from "./types.js";

// FORK 2026-07-21 — shadow revalidation + clone:false cache hits. A 27 MB
// sessions.json re-parsed on every TTL lapse (and structuredClone'd on every
// hit) was the gateway's standing event-loop blocker; these tests pin the
// cheap paths so they cannot regress silently.
describe("session store cache — clone:false hits and shadow revalidation", () => {
  const storePath = "/tmp/store-cache-shadow-test/sessions.json";
  const store = { "agent:main:test": { updatedAt: 1 } as unknown as SessionEntry };
  const stat = { mtimeMs: 1000, sizeBytes: 42 };

  beforeEach(() => {
    vi.useFakeTimers();
    clearSessionStoreCaches();
    writeSessionStoreCache({ storePath, store, ...stat });
  });

  afterEach(() => {
    clearSessionStoreCaches();
    vi.useRealTimers();
  });

  it("clone:false returns the cached object itself; default still clones", () => {
    const a = readSessionStoreCache({ storePath, ...stat, clone: false });
    const b = readSessionStoreCache({ storePath, ...stat, clone: false });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    const cloned = readSessionStoreCache({ storePath, ...stat });
    expect(cloned).not.toBeNull();
    expect(cloned).not.toBe(a);
    expect(cloned).toEqual(a);
  });

  it("revalidates from the shadow after TTL expiry when mtime+size are unchanged", () => {
    vi.advanceTimersByTime(10 * 60_000); // far past the 45s TTL
    const hit = readSessionStoreCache({ storePath, ...stat, clone: false });
    expect(hit).not.toBeNull();
    expect(hit?.["agent:main:test"]).toBeTruthy();
  });

  it("does NOT resurrect the shadow when the file changed or stat is missing", () => {
    vi.advanceTimersByTime(10 * 60_000);
    expect(readSessionStoreCache({ storePath, mtimeMs: 2000, sizeBytes: 42 })).toBeNull();
    expect(readSessionStoreCache({ storePath, mtimeMs: undefined, sizeBytes: 42 })).toBeNull();
  });

  it("invalidate clears the shadow too", () => {
    invalidateSessionStoreCache(storePath);
    expect(readSessionStoreCache({ storePath, ...stat })).toBeNull();
  });

  it("mtime mismatch on a live cache entry invalidates shadow as well", () => {
    expect(readSessionStoreCache({ storePath, mtimeMs: 2000, sizeBytes: 42 })).toBeNull();
    // The mismatch above must have wiped the shadow — same stale stat cannot revive it.
    expect(readSessionStoreCache({ storePath, ...stat })).toBeNull();
  });
});
