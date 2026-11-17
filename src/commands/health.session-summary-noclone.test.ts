import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthHandlers } from "../gateway/server-methods/health.js";
import { getHealthSnapshot } from "./health.js";

// FORK 2026-10-29: pins two health-path cuts of a whole-store structuredClone of
// sessions.json (failures.md M21). buildSessionSummary borrows the store read-only
// (clone:false), and a health RPC answered from cache no longer starts an admin
// background refresh whose snapshot health-state.ts never keeps.

const state = vi.hoisted(() => ({
  storePath: "/tmp/openclaw-health-noclone/sessions.json",
  config: {} as Record<string, unknown>,
  loadSessionStore: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => state.config,
  loadConfig: () => state.config,
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: () => state.storePath,
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStore(...args),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

// The RPC handler's own imports. ./health.js reaches neither module, so these stubs leave
// getHealthSnapshot's graph untouched; ws-log.ts would also pull in an openclaw/plugin-sdk
// import that only the repo's vitest alias (or a built dist/) resolves.
vi.mock("./status.js", () => ({
  getStatusSummary: vi.fn(),
}));

vi.mock("../gateway/ws-log.js", () => ({
  formatForLog: (value: unknown) => String(value),
}));

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

describe("health session summary (failures.md M21)", () => {
  beforeEach(() => {
    state.config = {};
    state.loadSessionStore.mockReset();
  });

  it("borrows the store with clone:false and summarizes a deep-frozen store", async () => {
    const now = Date.now();
    const store = deepFreeze({
      global: { sessionId: "s-global", updatedAt: now },
      unknown: { sessionId: "s-unknown", updatedAt: now },
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: now - 60_000,
        deliveryContext: { channel: "webchat", to: "tab-1" },
      },
      "agent:main:tinker:recent": { sessionId: "s-recent", updatedAt: now - 1_000 },
      "agent:main:tinker:idle": { sessionId: "s-idle" },
    });
    // Positive control: the freeze bites, so any write on the summary path would throw.
    expect(() => {
      store["agent:main:main"].updatedAt = 0;
    }).toThrow(TypeError);
    state.loadSessionStore.mockReturnValue(store);

    const snap = await getHealthSnapshot({ probe: false });

    expect(state.loadSessionStore).toHaveBeenCalledTimes(1);
    expect(state.loadSessionStore).toHaveBeenCalledWith(state.storePath, { clone: false });
    expect(snap.sessions.path).toBe(state.storePath);
    expect(snap.sessions.count).toBe(3);
    expect(snap.sessions.recent.map((row) => row.key)).toEqual([
      "agent:main:tinker:recent",
      "agent:main:main",
      "agent:main:tinker:idle",
    ]);
    expect(snap.sessions.recent[2]).toMatchObject({ updatedAt: null, age: null });
  });
});

describe("health RPC answered from cache (failures.md M21)", () => {
  function createHealthContext(cached: Record<string, unknown> | null) {
    return {
      getHealthCache: () => cached,
      refreshHealthSnapshot: vi.fn(async () => ({ ok: true, ts: Date.now() })),
      logHealth: { error: vi.fn() },
    };
  }

  async function callHealth(scopes: string[], context: ReturnType<typeof createHealthContext>) {
    const respond = vi.fn();
    await healthHandlers.health({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: context as never,
      client: { connect: { role: "operator", scopes } } as never,
      isWebchatConnect: () => false,
    });
    return respond;
  }

  it("still refreshes in the background after a non-admin cache hit", async () => {
    const cached = { ok: true, ts: Date.now() };
    const context = createHealthContext(cached);

    const respond = await callHealth(["operator.read"], context);

    expect(respond).toHaveBeenCalledWith(true, cached, undefined, { cached: true });
    expect(context.refreshHealthSnapshot).toHaveBeenCalledTimes(1);
    expect(context.refreshHealthSnapshot).toHaveBeenCalledWith({
      probe: false,
      includeSensitive: false,
    });
  });

  it("starts no sensitive background refresh after an admin cache hit", async () => {
    const cached = { ok: true, ts: Date.now() };
    const context = createHealthContext(cached);

    const respond = await callHealth(["operator.admin"], context);

    expect(respond).toHaveBeenCalledWith(true, cached, undefined, { cached: true });
    expect(context.refreshHealthSnapshot).not.toHaveBeenCalled();
  });

  it("still builds a sensitive snapshot for an admin caller with no cache", async () => {
    const context = createHealthContext(null);

    const respond = await callHealth(["operator.admin"], context);

    expect(context.refreshHealthSnapshot).toHaveBeenCalledWith({
      probe: false,
      includeSensitive: true,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
  });
});
