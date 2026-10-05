/**
 * FORK 2026-09-08 (the architect, work tab: "I have Auto model selected, and I see a Sol thinking
 * indicator. It is not only wrong because opus is available, but also because Sol has reached a
 * token limit").
 *
 * THE RACE. Pressing Auto in the Tinker picker fires a fire-and-forget `sessions.patch{model:null}`
 * to clear the pin stored by an earlier `/model openai-codex/gpt-5.6-sol`. On 2026-09-08 that patch
 * took 82-147 s to land (a 12 MB sessions.json behind one lock), while the next `chat.send` went
 * out at once with NO model param -- so `createModelSelectionState` still saw the stored pin, took
 * it as an explicit choice, skipped the quota veto and THALAMUS, and ran the exhausted Sol with an
 * empty ladder. The picker read Auto the whole time.
 *
 * THE FIX. The reset rides the send: the picker sends `model: "auto"`, the directive layer turns
 * that into `resetStoredModelOverride: true` for this state, and the state clears the pin ITSELF --
 * in the same turn, before choosing -- then routes as Auto. No separate patch to wait for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CONTEXT_TOKEN_CACHE } from "../../agents/context-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ]),
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

afterEach(() => {
  MODEL_CONTEXT_TOKEN_CACHE.clear();
});

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-opus-4-6";
const SESSION_KEY = "agent:main:tinker:worktab";

function makeEntry(overrides: Record<string, unknown> = {}): SessionEntry {
  return { sessionId: "session-id", updatedAt: 0, ...overrides } as SessionEntry;
}

async function resolve(params: {
  entry: SessionEntry;
  reset: boolean;
  hasModelDirective?: boolean;
}) {
  const cfg = {} as OpenClawConfig;
  const sessionStore = { [SESSION_KEY]: params.entry };
  const state = await createModelSelectionState({
    cfg,
    agentCfg: cfg.agents?.defaults,
    sessionEntry: params.entry,
    sessionStore,
    sessionKey: SESSION_KEY,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    hasModelDirective: params.hasModelDirective ?? false,
    resetStoredModelOverride: params.reset,
  });
  return { state, sessionStore };
}

describe("createModelSelectionState -- resetStoredModelOverride (the picker's Auto rides the send)", () => {
  it("without the flag, a stored USER pin still wins (the contract this fix must not loosen)", async () => {
    const entry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
    });
    const { state } = await resolve({ entry, reset: false });
    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
    expect(entry.modelOverride).toBe("gpt-4o");
  });

  it("with the flag, the stored USER pin is cleared in the same turn and the defaults are selected", async () => {
    const entry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
    });
    const { state, sessionStore } = await resolve({ entry, reset: true });
    expect(state.provider).toBe(DEFAULT_PROVIDER);
    expect(state.model).toBe(DEFAULT_MODEL);
    // Cleared ON the entry and IN the store -- the next turn must not find it either.
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
    expect(sessionStore[SESSION_KEY]?.modelOverride).toBeUndefined();
    // This is NOT the "override not allowed" reset -- no reverted-to notice must fire for it.
    expect(state.resetModelOverride).toBe(false);
  });

  it("with the flag, a stored AUTO-failover pin is cleared too", async () => {
    const entry = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.6",
      modelOverrideSource: "auto",
    });
    const { state } = await resolve({ entry, reset: true });
    expect(state.provider).toBe(DEFAULT_PROVIDER);
    expect(state.model).toBe(DEFAULT_MODEL);
    expect(entry.modelOverride).toBeUndefined();
  });

  it("with the flag and nothing stored, it is a no-op", async () => {
    const entry = makeEntry();
    const { state } = await resolve({ entry, reset: true });
    expect(state.provider).toBe(DEFAULT_PROVIDER);
    expect(state.model).toBe(DEFAULT_MODEL);
    expect(state.resetModelOverride).toBe(false);
    expect(Object.keys(entry).sort()).toEqual(["sessionId", "updatedAt"]);
  });

  it("does not persist an auth-profile pin's side effects -- only the model fields move", async () => {
    const entry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      thinkingLevel: "high",
      cookiePhrase: "WorkTab",
    });
    await resolve({ entry, reset: true });
    expect(entry.thinkingLevel).toBe("high");
    expect(entry.cookiePhrase).toBe("WorkTab");
  });
});
