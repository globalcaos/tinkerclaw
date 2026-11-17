import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldSwitchToLiveModel } from "./live-model-switch.js";

// FORK 2026-10-29: pins the clone-free read in shouldSwitchToLiveModel (failures.md M21).
// It runs after every run attempt and reads one entry's flag, so it asks for a private
// skipCache parse with clone:false and must never write to what that parse returns.

const STORE_PATH = "/tmp/openclaw-live-switch-noclone/sessions.json";

const state = vi.hoisted(() => ({
  loadSessionStore: vi.fn(),
  updateSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStore(...args),
  updateSessionStore: (...args: unknown[]) => state.updateSessionStore(...args),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: (...args: unknown[]) => state.resolveStorePath(...args),
}));

vi.mock("./embedded-agent-runner/runs.js", () => ({
  abortEmbeddedPiRun: vi.fn(() => false),
  requestEmbeddedRunModelSwitch: vi.fn(),
  consumeEmbeddedRunModelSwitch: vi.fn(),
}));

vi.mock("./model-selection.js", () => ({
  normalizeStoredOverrideModel: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(),
  resolvePersistedSelectedModelRef: vi.fn(),
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

describe("shouldSwitchToLiveModel session read (failures.md M21)", () => {
  beforeEach(() => {
    state.loadSessionStore.mockReset();
    state.updateSessionStore.mockReset();
    state.resolveStorePath.mockReset().mockReturnValue(STORE_PATH);
  });

  it("returns undefined for a deep-frozen entry with liveModelSwitchPending=false", () => {
    const store = deepFreeze({
      main: {
        sessionId: "s-1",
        liveModelSwitchPending: false,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        deliveryContext: { channel: "webchat", to: "tab-1" },
      },
    });
    // Positive control: the freeze bites, so a write on this path would throw.
    expect(() => {
      store.main.liveModelSwitchPending = true;
    }).toThrow(TypeError);
    state.loadSessionStore.mockReturnValue(store);

    const result = shouldSwitchToLiveModel({
      cfg: { session: { store: STORE_PATH } },
      sessionKey: "main",
      agentId: "main",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      currentProvider: "anthropic",
      currentModel: "claude-opus-4-6",
    });

    expect(result).toBeUndefined();
    expect(state.loadSessionStore).toHaveBeenCalledTimes(1);
    expect(state.loadSessionStore).toHaveBeenCalledWith(STORE_PATH, {
      skipCache: true,
      clone: false,
    });
    expect(state.updateSessionStore).not.toHaveBeenCalled();
  });
});
