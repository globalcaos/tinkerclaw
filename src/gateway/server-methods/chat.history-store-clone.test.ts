import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { clearSessionStoreCacheForTest, loadSessionStore } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

// FORK 2026-09-23 — chat.history (~10/min from the Tinker UI) must not deep-clone
// the whole session store. It read only `entry`, yet a live profile showed the
// whole-store structuredClone still paid per call: the key-resolution lookup
// inside resolveGatewaySessionStoreTarget loaded the store with clone:true.

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

describe("chat.history never structuredClones the whole session store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearSessionStoreCacheForTest();
    resetConfigRuntimeState();
  });

  test("the real handler copies at most the entry, and never mutates the cached store", async () => {
    resetConfigRuntimeState();
    clearSessionStoreCacheForTest();
    await withStateDirEnv("chat-history-store-clone-", async ({ stateDir }) => {
      const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      const storeKeys = ["agent:main:main", "agent:main:other", "agent:main:third"];
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": { sessionId: "sess-main", updatedAt: 3, thinkingLevel: "low" },
          "agent:main:other": { sessionId: "sess-other", updatedAt: 2 },
          "agent:main:third": { sessionId: "sess-third", updatedAt: 1 },
        }),
      );
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      // Warm the cache; the second clone:false read is a hit on the cache's own object.
      loadSessionStore(storePath, { clone: false });
      const cached = deepFreeze(loadSessionStore(storePath, { clone: false }));
      expect(loadSessionStore(storePath, { clone: false })).toBe(cached);

      const cloneSpy = vi.spyOn(globalThis, "structuredClone");
      const respond = vi.fn() as unknown as RespondFn;
      const logGateway = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const context = {
        logGateway,
        loadGatewayModelCatalog: async () => [],
      } as unknown as GatewayRequestContext;

      await chatHandlers["chat.history"]({
        req: { id: "req-history" } as never,
        params: { sessionKey: "agent:main:main" },
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ sessionKey: "agent:main:main", sessionId: "sess-main" }),
      );
      const wholeStoreClones = cloneSpy.mock.calls.filter(
        ([arg]) =>
          arg === cached ||
          (!!arg && typeof arg === "object" && storeKeys.every((key) => Object.hasOwn(arg, key))),
      );
      expect(wholeStoreClones).toHaveLength(0);
      expect(loadSessionStore(storePath, { clone: false })).toBe(cached);
      // Let the fire-and-forget managed-image cleanup settle inside the temp state dir.
      await new Promise((resolve) => setImmediate(resolve));
    });
  });
});
