/**
 * FORK 2026-09-08 (the architect, work tab, minutes after the Sol report: "Now Grok is triggering in
 * Auto, this is insane. Thalamus should select opus first, right?").
 *
 * The failover machinery persists the candidate it fell back to as a session override with
 * `modelOverrideSource: "auto"` (agent-runner-execution.ts, `buildFallbackSelectionState`) — so
 * the NEXT turn keeps the fallback instead of re-hitting a dead primary. Sensible upstream, where
 * nothing else routes. In this fork `createModelSelectionState` then read that stored override as
 * an EXPLICIT selection (`Boolean(storedOverride?.model)`), which hard-stops the quota veto and
 * THALAMUS: the session that fell back to grok at 11:36 was still on grok at 12:00 with opus
 * available and the dial at balanced, and the picker read Auto the whole time. The bible's own
 * words on the router: "a written override would be indistinguishable from a user pin next turn"
 * — this is that override, written by the runner instead of the router.
 *
 * An auto-sourced override is now the STARTING point (so a build with no THALAMUS catalog and no
 * quota data still keeps the fallback, exactly as `model-selection.test.ts` "preserves
 * auto-failover overrides across turns until reset" pins) but NOT an explicit choice: the quota
 * substitution and THALAMUS run over it. A user-sourced pin, and a legacy pin with no source, stay
 * explicit — `agent-scope.ts` and `reset-preserved-selection.ts` already draw that line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CONTEXT_TOKEN_CACHE } from "../../agents/context-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createModelSelectionState } from "./model-selection.js";

const quotaMocks = vi.hoisted(() => ({
  resolveQuotaAwareAutoModel: vi.fn(),
}));

vi.mock("../../agents/quota-aware-auto-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/quota-aware-auto-model.js")>()),
  resolveQuotaAwareAutoModel: quotaMocks.resolveQuotaAwareAutoModel,
}));

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: vi.fn(async () => []),
}));

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

const DEFAULT_PROVIDER = "claude-code";
const DEFAULT_MODEL = "claude-opus-5";
const SESSION_KEY = "agent:main:tinker:worktab";

function makeEntry(overrides: Record<string, unknown> = {}): SessionEntry {
  return { sessionId: "session-id", updatedAt: 0, ...overrides } as SessionEntry;
}

async function resolve(entry: SessionEntry, sessionKey = SESSION_KEY) {
  const cfg = {
    agents: {
      defaults: { model: { primary: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`, fallbacks: [] } },
    },
  } as OpenClawConfig;
  const sessionStore = { [sessionKey]: entry };
  return createModelSelectionState({
    cfg,
    agentCfg: cfg.agents?.defaults,
    sessionEntry: entry,
    sessionStore,
    sessionKey,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    hasModelDirective: false,
  });
}

beforeEach(() => {
  quotaMocks.resolveQuotaAwareAutoModel.mockReset();
});
afterEach(() => {
  MODEL_CONTEXT_TOKEN_CACHE.clear();
});

describe("a stored override written by auto-failover is a starting point, not a pin", () => {
  it("still keeps the fallback when nothing routes over it (the upstream contract)", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(undefined);
    const entry = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.6",
      modelOverrideSource: "auto",
    });
    const state = await resolve(entry);
    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.6");
    // Nothing was reset or rewritten: the fallback survives until the router moves it.
    expect(entry.modelOverride).toBe("grok-4.6");
    expect(entry.modelOverrideSource).toBe("auto");
  });

  it("lets the quota-aware Auto path run over it -- the ladder starts from the fallback", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      reason: "xai spent",
    });
    const entry = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.6",
      modelOverrideSource: "auto",
    });
    const state = await resolve(entry);
    // The resolver was consulted at all -- which the explicit gate used to forbid -- and it was
    // consulted FROM the fallback, not from the default.
    expect(quotaMocks.resolveQuotaAwareAutoModel).toHaveBeenCalledTimes(1);
    expect(quotaMocks.resolveQuotaAwareAutoModel.mock.calls[0]?.[0]).toMatchObject({
      provider: "xai",
      model: "grok-4.6",
    });
    expect(state.provider).toBe(DEFAULT_PROVIDER);
    expect(state.model).toBe(DEFAULT_MODEL);
    expect(state.quotaSubstitution).toBeDefined();
  });

  it("a USER pin is still explicit: the router is never consulted", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      reason: "xai spent",
    });
    const entry = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.6",
      modelOverrideSource: "user",
    });
    const state = await resolve(entry);
    expect(quotaMocks.resolveQuotaAwareAutoModel).not.toHaveBeenCalled();
    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.6");
  });

  it("a LEGACY pin with no source is treated as the user's, like everywhere else", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      reason: "xai spent",
    });
    const entry = makeEntry({ providerOverride: "xai", modelOverride: "grok-4.6" });
    const state = await resolve(entry);
    expect(quotaMocks.resolveQuotaAwareAutoModel).not.toHaveBeenCalled();
    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.6");
  });

  it("an auto-sourced PARENT override is inherited as a starting point too, not as a pin", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      reason: "xai spent",
    });
    const parent = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.6",
      modelOverrideSource: "auto",
    });
    const child = makeEntry();
    const cfg = {
      agents: { defaults: { model: { primary: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}` } } },
    } as OpenClawConfig;
    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry: child,
      sessionStore: { [SESSION_KEY]: parent, [`${SESSION_KEY}:topic:7`]: child },
      sessionKey: `${SESSION_KEY}:topic:7`,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      hasModelDirective: false,
    });
    expect(quotaMocks.resolveQuotaAwareAutoModel).toHaveBeenCalledTimes(1);
    expect(quotaMocks.resolveQuotaAwareAutoModel.mock.calls[0]?.[0]).toMatchObject({
      provider: "xai",
      model: "grok-4.6",
    });
    expect(state.provider).toBe(DEFAULT_PROVIDER);
  });
});
