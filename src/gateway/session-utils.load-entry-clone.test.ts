import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  loadGatewaySessionRow,
  loadSessionEntry,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

// FORK 2026-09-21 — loadSessionEntry stopped cloning the whole store on every
// call. These pin the copy contract: entry is a private copy, store is a lazy
// private copy, and store[matchedKey] === entry.

async function withStore(
  prefix: string,
  run: (storePath: string) => void | Promise<void>,
): Promise<void> {
  resetConfigRuntimeState();
  clearSessionStoreCacheForTest();
  try {
    await withStateDirEnv(prefix, async ({ stateDir }) => {
      const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:main:main": { sessionId: "sess-main", updatedAt: 2, label: "orig" },
            "agent:main:other": { sessionId: "sess-other", updatedAt: 1, label: "other" },
          },
          null,
          2,
        ),
        "utf8",
      );
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      await run(storePath);
    });
  } finally {
    clearSessionStoreCacheForTest();
    resetConfigRuntimeState();
  }
}

describe("loadSessionEntry clone contract", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
    resetConfigRuntimeState();
  });

  test("mutating the returned entry does not change a later load", async () => {
    await withStore("session-utils-load-entry-clone-entry-", () => {
      const first = loadSessionEntry("agent:main:main");
      expect(first.entry?.label).toBe("orig");
      first.entry!.label = "mutated";

      const second = loadSessionEntry("agent:main:main");
      expect(second.entry?.label).toBe("orig");
      expect(second.entry).not.toBe(first.entry);
    });
  });

  test("mutating the returned store does not leak into the cache", async () => {
    await withStore("session-utils-load-entry-clone-store-", (storePath) => {
      const first = loadSessionEntry("agent:main:main");
      first.store["agent:main:other"]!.label = "leaked";
      delete first.store["agent:main:main"];
      first.store["agent:main:injected"] = { sessionId: "x", updatedAt: 3 };

      const cached = loadSessionStore(storePath, { clone: false });
      expect(cached["agent:main:other"]?.label).toBe("other");
      expect(cached["agent:main:main"]?.sessionId).toBe("sess-main");
      expect(cached["agent:main:injected"]).toBeUndefined();

      const second = loadSessionEntry("agent:main:main");
      expect(second.entry?.sessionId).toBe("sess-main");
      expect(second.store["agent:main:other"]?.label).toBe("other");
    });
  });

  test("store is lazy, memoised, enumerable, and store[matchedKey] is the returned entry", async () => {
    await withStore("session-utils-load-entry-clone-identity-", () => {
      const loaded = loadSessionEntry("agent:main:main");
      const descriptor = Object.getOwnPropertyDescriptor(loaded, "store");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.enumerable).toBe(true);

      const store = loaded.store;
      expect(loaded.store).toBe(store);
      expect(store["agent:main:main"]).toBe(loaded.entry);
      expect(Object.keys(store).toSorted()).toEqual(["agent:main:main", "agent:main:other"]);

      // Identity survives mutation through either handle.
      loaded.entry!.label = "via-entry";
      expect(store["agent:main:main"]?.label).toBe("via-entry");
    });
  });

  test("a missing session yields no entry and a full-store clone on demand", async () => {
    await withStore("session-utils-load-entry-clone-missing-", () => {
      const loaded = loadSessionEntry("agent:main:does-not-exist");
      expect(loaded.entry).toBeUndefined();
      expect(loaded.legacyKey).toBeUndefined();
      expect(loaded.store["agent:main:main"]?.sessionId).toBe("sess-main");
    });
  });
});

// FORK 2026-09-23 — the 09-21 change above still paid a whole-store clone per
// call: resolveGatewaySessionStoreTarget's lookup loaded the store with the
// default clone:true just to scan its keys. A live profile had ~20% of the main
// thread there (chat.history, and loadGatewaySessionRow on every
// sessions.changed / server-chat event snapshot).

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

/** Warm the cache and return its own object (what every clone:false hit returns). */
function warmCachedStore(storePath: string): Record<string, SessionEntry> {
  loadSessionStore(storePath, { clone: false });
  const cached = loadSessionStore(storePath, { clone: false });
  expect(loadSessionStore(storePath, { clone: false })).toBe(cached);
  return cached;
}

/** structuredClone calls whose argument is a whole store (the cached one, or any store-shaped copy). */
function wholeStoreClones(
  spy: { mock: { calls: unknown[][] } },
  cached: Record<string, SessionEntry>,
): number {
  const storeKeys = Object.keys(cached);
  return spy.mock.calls.filter(([arg]) => {
    if (arg === cached) {
      return true;
    }
    return !!arg && typeof arg === "object" && storeKeys.every((key) => Object.hasOwn(arg, key));
  }).length;
}

describe("single-session gateway reads never structuredClone the whole store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearSessionStoreCacheForTest();
    resetConfigRuntimeState();
  });

  test("loadSessionEntry, read the way chat.history reads it", async () => {
    await withStore("session-utils-no-store-clone-entry-", (storePath) => {
      const cached = warmCachedStore(storePath);
      const cloneSpy = vi.spyOn(globalThis, "structuredClone");

      const { cfg, storePath: loadedPath, entry } = loadSessionEntry("agent:main:main");

      expect(cfg).toBeTruthy();
      expect(loadedPath).toBe(storePath);
      expect(entry?.sessionId).toBe("sess-main");
      expect(wholeStoreClones(cloneSpy, cached)).toBe(0);
      // The entry itself is what gets copied.
      expect(cloneSpy.mock.calls.some(([arg]) => arg === cached["agent:main:main"])).toBe(true);
    });
  });

  test("loadGatewaySessionRow (server-chat buildSessionEventSnapshot, sessions.changed)", async () => {
    await withStore("session-utils-no-store-clone-row-", (storePath) => {
      const cached = warmCachedStore(storePath);
      const cloneSpy = vi.spyOn(globalThis, "structuredClone");

      const row = loadGatewaySessionRow("agent:main:main");

      expect(row?.key).toBe("agent:main:main");
      expect(row?.sessionId).toBe("sess-main");
      expect(wholeStoreClones(cloneSpy, cached)).toBe(0);
    });
  });

  test("resolveGatewaySessionStoreTarget clones nothing at all", async () => {
    await withStore("session-utils-no-store-clone-target-", (storePath) => {
      warmCachedStore(storePath);
      const cloneSpy = vi.spyOn(globalThis, "structuredClone");

      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:main:MAIN" });

      expect(target.canonicalKey).toBe("agent:main:main");
      expect(target.storeKeys).toContain("agent:main:main");
      expect(cloneSpy).not.toHaveBeenCalled();
    });
  });

  test("the borrowed cached store is never mutated on these paths (deep-frozen)", async () => {
    await withStore("session-utils-no-store-clone-frozen-", (storePath) => {
      const cached = deepFreeze(warmCachedStore(storePath));

      // A write to the shared object anywhere below throws (ES modules are strict).
      const loaded = loadSessionEntry("agent:main:main");
      const row = loadGatewaySessionRow("agent:main:main");
      loadGatewaySessionRow("agent:main:other");
      loadSessionEntry("agent:main:does-not-exist");

      expect(row?.sessionId).toBe("sess-main");
      loaded.entry!.label = "caller-owned";
      expect(loadSessionStore(storePath, { clone: false })).toBe(cached);
      expect(cached["agent:main:main"]?.label).toBe("orig");
    });
  });

  test("the deleted-legacy-main lookup does not clone the store either", async () => {
    resetConfigRuntimeState();
    clearSessionStoreCacheForTest();
    await withStateDirEnv("session-utils-no-store-clone-deleted-main-", async ({ stateDir }) => {
      const liveDir = path.join(stateDir, "agents", "ops", "sessions");
      const deletedDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(liveDir, { recursive: true });
      fs.mkdirSync(deletedDir, { recursive: true });
      fs.writeFileSync(
        path.join(liveDir, "sessions.json"),
        JSON.stringify({ "agent:ops:main": { sessionId: "sess-live", updatedAt: 10 } }),
      );
      fs.writeFileSync(
        path.join(deletedDir, "sessions.json"),
        JSON.stringify({ "agent:main:main": { sessionId: "sess-deleted-main", updatedAt: 20 } }),
      );
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "ops", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      const first = resolveGatewaySessionStoreTarget({ cfg, key: "agent:main:main" });
      const cached = deepFreeze(warmCachedStore(first.storePath));
      const cloneSpy = vi.spyOn(globalThis, "structuredClone");

      const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:main:main" });
      const loaded = loadSessionEntry("agent:main:main");

      expect(target.storePath).toBe(first.storePath);
      expect(loaded.entry?.sessionId).toBe("sess-deleted-main");
      expect(wholeStoreClones(cloneSpy, cached)).toBe(0);
    });
  });
});
