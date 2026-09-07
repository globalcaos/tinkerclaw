import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createModelSelectionState, formatQuotaAwareAutoNotice } from "./model-selection.js";

const quotaMocks = vi.hoisted(() => ({
  resolveQuotaAwareAutoModel: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  profiles: {} as Record<string, { provider: string }>,
}));

vi.mock("../../agents/quota-aware-auto-model.js", () => quotaMocks);

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: vi.fn(async () => []),
}));

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: authMocks.profiles }),
}));

// The empty-ladder assertion drives the REAL runWithModelFallback, because the
// point of that test is the composition with the 317825d0f7a guard. Reporting
// no auth-profile source keeps it on the pure candidate path instead of profile
// rotation, which is a different mechanism and not what is under test here.
vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: () => false,
}));

const AUTO_PROVIDER = "claude-code";
const AUTO_MODEL = "claude-opus-5";
const SUBSTITUTE_PROVIDER = "openai-codex";
const SUBSTITUTE_MODEL = "gpt-5.6-sol";
const REASON = "claude-code 5-hour window exhausted (resets 15:00)";
const EXPECTED_NOTICE = `↪️ Auto: ${REASON}, using ${SUBSTITUTE_PROVIDER}/${SUBSTITUTE_MODEL}`;

function makeCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: `${AUTO_PROVIDER}/${AUTO_MODEL}`,
          fallbacks: [],
        },
      },
    },
  } as OpenClawConfig;
}

function makeEntry(overrides: Record<string, unknown> = {}): SessionEntry {
  return {
    sessionId: "session-id",
    updatedAt: 0,
    ...overrides,
  } as SessionEntry;
}

function exhausted() {
  return {
    provider: SUBSTITUTE_PROVIDER,
    model: SUBSTITUTE_MODEL,
    reason: REASON,
  };
}

function createState(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  hasModelDirective?: boolean;
  hasResolvedHeartbeatModelOverride?: boolean;
}) {
  return createModelSelectionState({
    cfg: params.cfg,
    agentCfg: params.cfg.agents?.defaults,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    defaultProvider: AUTO_PROVIDER,
    defaultModel: AUTO_MODEL,
    provider: AUTO_PROVIDER,
    model: AUTO_MODEL,
    hasModelDirective: params.hasModelDirective ?? false,
    hasResolvedHeartbeatModelOverride: params.hasResolvedHeartbeatModelOverride,
  });
}

beforeEach(() => {
  quotaMocks.resolveQuotaAwareAutoModel.mockReset();
  quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(null);
  authMocks.profiles = {};
});

describe("createModelSelectionState quota-aware Auto substitution", () => {
  it("substitutes the Auto primary and discloses it when the window is exhausted", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());
    const cfg = makeCfg();
    const sessionEntry = makeEntry();
    const sessionKey = "agent:main:tinker:tab1";

    const state = await createState({
      cfg,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
    });

    // The resolver is PURE: `snapshot` and `nowMs` are arguments, never read from inside it, so
    // that a decision is reproducible in a test and the gateway cannot disagree with the browser
    // from a second hidden clock. `allowedModelKeys` goes IN rather than being filtered out of the
    // result, so the ladder can fall through to rung 2 when rung 1 is not routable.
    expect(quotaMocks.resolveQuotaAwareAutoModel).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        provider: AUTO_PROVIDER,
        model: AUTO_MODEL,
        nowMs: expect.any(Number),
      }),
    );
    const callArgs = quotaMocks.resolveQuotaAwareAutoModel.mock.calls[0]?.[0];
    expect(callArgs).toHaveProperty("snapshot");
    expect(callArgs).toHaveProperty("allowedModelKeys");
    expect(state.provider).toBe(SUBSTITUTE_PROVIDER);
    expect(state.model).toBe(SUBSTITUTE_MODEL);
    expect(state.quotaSubstitution).toMatchObject({
      originalProvider: AUTO_PROVIDER,
      originalModel: AUTO_MODEL,
      provider: SUBSTITUTE_PROVIDER,
      model: SUBSTITUTE_MODEL,
      reason: REASON,
    });
    expect(state.quotaSubstitution?.notice).toBe(EXPECTED_NOTICE);
    expect(state.quotaSubstitution?.notice).toBe(
      formatQuotaAwareAutoNotice({
        reason: REASON,
        provider: SUBSTITUTE_PROVIDER,
        model: SUBSTITUTE_MODEL,
      }),
    );

    // Nothing is persisted. A written override would survive resets_at and
    // would later be indistinguishable from a user pin.
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.providerOverride).toBeUndefined();
  });

  it("leaves a healthy Auto turn untouched and emits no notice", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(null);
    const cfg = makeCfg();

    const state = await createState({ cfg });

    expect(quotaMocks.resolveQuotaAwareAutoModel).toHaveBeenCalledTimes(1);
    expect(state.provider).toBe(AUTO_PROVIDER);
    expect(state.model).toBe(AUTO_MODEL);
    expect(state.quotaSubstitution).toBeUndefined();
  });

  it("never consults the quota ladder when the session holds a user pin", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());
    const cfg = makeCfg();
    const sessionEntry = makeEntry({
      providerOverride: AUTO_PROVIDER,
      modelOverride: AUTO_MODEL,
    });

    const state = await createState({ cfg, sessionEntry });

    expect(quotaMocks.resolveQuotaAwareAutoModel).not.toHaveBeenCalled();
    expect(state.provider).toBe(AUTO_PROVIDER);
    expect(state.model).toBe(AUTO_MODEL);
    expect(state.quotaSubstitution).toBeUndefined();
  });

  it("never consults the quota ladder for an inline model directive", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());

    const state = await createState({ cfg: makeCfg(), hasModelDirective: true });

    expect(quotaMocks.resolveQuotaAwareAutoModel).not.toHaveBeenCalled();
    expect(state.quotaSubstitution).toBeUndefined();
  });

  it("never consults the quota ladder for a resolved heartbeat model", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());

    const state = await createState({
      cfg: makeCfg(),
      hasResolvedHeartbeatModelOverride: true,
    });

    expect(quotaMocks.resolveQuotaAwareAutoModel).not.toHaveBeenCalled();
    expect(state.quotaSubstitution).toBeUndefined();
  });

  it("runs a substituted turn with an EMPTY fallback ladder", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());
    const cfg = makeCfg();

    const state = await createState({ cfg });
    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: state.provider,
        model: state.model,
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        },
      }),
    ).rejects.toThrow();

    // Composition with 317825d0f7a, not a bypass: swapping the PRIMARY puts the
    // turn on another provider, so the configured fallbacks resolve to [] and
    // the guard declines to append the config primary. The substitute is the
    // only candidate — and claude-code, whose window is spent, is never retried.
    expect(calls).toEqual([{ provider: SUBSTITUTE_PROVIDER, model: SUBSTITUTE_MODEL }]);
  });

  it("CONTROL: an unsubstituted Auto turn still falls back to the config primary", async () => {
    // Same command, substitution off. Without this control the assertion above
    // would pass just as happily against a runWithModelFallback that never
    // builds a ladder at all — it is the DIFFERENCE that proves the empty
    // ladder came from the provider swap.
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(null);
    const cfg = makeCfg();

    const state = await createState({ cfg });
    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: state.provider,
        model: state.model,
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        },
      }),
    ).rejects.toThrow();

    expect(calls).toEqual([{ provider: AUTO_PROVIDER, model: AUTO_MODEL }]);
  });

  it("discloses on BOTH of two consecutive substituted turns", async () => {
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());
    const cfg = makeCfg();

    const first = await createState({ cfg });
    const second = await createState({ cfg });

    expect(first.quotaSubstitution?.notice).toBe(EXPECTED_NOTICE);
    expect(second.quotaSubstitution?.notice).toBe(EXPECTED_NOTICE);
  });

  it("snaps back with no stored state once the window resets", async () => {
    const cfg = makeCfg();
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValueOnce(exhausted());

    const held = await createState({ cfg });
    const snappedBack = await createState({ cfg });

    expect(held.model).toBe(SUBSTITUTE_MODEL);
    expect(snappedBack.provider).toBe(AUTO_PROVIDER);
    expect(snappedBack.model).toBe(AUTO_MODEL);
    expect(snappedBack.quotaSubstitution).toBeUndefined();
  });

  it("keeps a stored auth-profile pin that matches the Auto provider", async () => {
    // The authProfileOverride reconciliation DELETES a pin whose provider does
    // not match `provider`. It must therefore see the Auto selection, not the
    // substitute — otherwise a spent token window permanently discards the
    // architect's auth-profile pick, a persisted side effect this feature is
    // required not to have.
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());
    authMocks.profiles = { "cc-main": { provider: AUTO_PROVIDER } };
    const sessionKey = "agent:main:tinker:tab1";
    const sessionEntry = makeEntry({ authProfileOverride: "cc-main" });

    const state = await createState({
      cfg: makeCfg(),
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
    });

    expect(state.provider).toBe(SUBSTITUTE_PROVIDER);
    expect(sessionEntry.authProfileOverride).toBe("cc-main");
  });

  it("CONTROL: a stored auth-profile pin for the SUBSTITUTE provider is still cleared", async () => {
    // The opposite half of the ordering proof. If the substitution ran before
    // the reconciliation, these two outcomes would be exactly inverted: this
    // pin would be kept and the matching one above would be deleted.
    quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(exhausted());
    authMocks.profiles = { "codex-main": { provider: SUBSTITUTE_PROVIDER } };
    const sessionKey = "agent:main:tinker:tab1";
    const sessionEntry = makeEntry({ authProfileOverride: "codex-main" });

    const state = await createState({
      cfg: makeCfg(),
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
    });

    expect(state.provider).toBe(SUBSTITUTE_PROVIDER);
    expect(sessionEntry.authProfileOverride).toBeUndefined();
  });
});
