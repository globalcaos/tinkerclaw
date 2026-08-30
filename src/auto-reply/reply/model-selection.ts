import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  buildConfiguredModelCatalog,
  buildAllowedModelSet,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  resolvePersistedOverrideModelRef,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { resolveQuotaAwareAutoModel } from "../../agents/quota-aware-auto-model.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getUsageSnapshot } from "../../infra/usage-snapshot-store.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { formatProviderModelRef } from "../model-runtime.js";
import type { ThinkLevel } from "./directives.js";
export {
  resolveModelDirectiveSelection,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";

type ModelCatalog = ModelCatalogEntry[];

/**
 * Set only on a turn where the quota-aware Auto ladder replaced the Auto
 * selection because the selected provider's token window is spent.
 *
 * Resolved per turn and PERSISTED NOWHERE: no `modelOverride`/`providerOverride`
 * write and no new `SessionEntry` field (a new field would also have to be
 * registered in FALLBACK_SELECTION_STATE_KEYS / snapshotFallbackSelectionState
 * in agent-runner-execution.ts or it could never roll back). Because it is
 * recomputed every turn, "held until resets_at, then snapped back" falls out of
 * the quota state itself — self-healing, and nothing that a later reader could
 * mistake for a user pin.
 */
export type QuotaAwareAutoSubstitution = {
  /** The Auto selection that was displaced. */
  originalProvider: string;
  originalModel: string;
  /** The substitute that actually runs this turn. */
  provider: string;
  model: string;
  /** Resolver-supplied cause, e.g. "claude-code 5-hour window exhausted (resets 15:00)". */
  reason: string;
  /** Ready-to-send disclosure line; surface it on EVERY turn it is present. */
  notice: string;
};

/**
 * Disclosure carrier for a quota-aware Auto substitution.
 *
 * The `↪️ Model Fallback` notice compares the ACTIVE provider against the
 * SELECTED one. Substituting at selection time makes the substitute *be* the
 * selection everywhere downstream, so those two are equal and that notice stays
 * silent — this substitution therefore needs its own carrier, and it is emitted
 * on EVERY turn it is active. That is the same every-turn rule cross-provider
 * fallback already follows, for the same reason: a sustained silent
 * substitution is indistinguishable from the model picker being ignored.
 */
export function formatQuotaAwareAutoNotice(params: {
  reason: string;
  provider: string;
  model: string;
}): string {
  return `↪️ Auto: ${params.reason}, using ${formatProviderModelRef(params.provider, params.model)}`;
}

type ModelSelectionState = {
  provider: string;
  model: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  resetModelOverride: boolean;
  resolveThinkingCatalog: () => Promise<ModelCatalog | undefined>;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel>;
  /** Default reasoning level from model capability: "on" if model has reasoning, else "off". */
  resolveDefaultReasoningLevel: () => Promise<"on" | "off">;
  needsModelCatalog: boolean;
  /** Present only when the quota ladder substituted this turn's primary.
   *  `quotaSubstitution.notice` MUST reach the user on every such turn. */
  quotaSubstitution?: QuotaAwareAutoSubstitution;
};

export function createFastTestModelSelectionState(params: {
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): ModelSelectionState {
  return {
    provider: params.provider,
    model: params.model,
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    resolveThinkingCatalog: async () => [],
    resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault as ThinkLevel,
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
  };
}

function shouldLogModelSelectionTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

let modelCatalogRuntimePromise:
  | Promise<typeof import("../../agents/model-catalog.runtime.js")>
  | undefined;
let sessionStoreRuntimePromise:
  | Promise<typeof import("../../config/sessions/store.runtime.js")>
  | undefined;

function loadModelCatalogRuntime() {
  modelCatalogRuntimePromise ??= import("../../agents/model-catalog.runtime.js");
  return modelCatalogRuntimePromise;
}

function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return sessionStoreRuntimePromise;
}

export async function createModelSelectionState(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  provider: string;
  model: string;
  hasModelDirective: boolean;
  /** True when heartbeat.model was explicitly resolved for this run.
   *  In that case, skip session-stored overrides so the heartbeat selection wins. */
  hasResolvedHeartbeatModelOverride?: boolean;
}): Promise<ModelSelectionState> {
  const timingEnabled = shouldLogModelSelectionTiming();
  const startMs = timingEnabled ? Date.now() : 0;
  const logStage = (stage: string, extra?: string) => {
    if (!timingEnabled) {
      return;
    }
    const suffix = extra ? ` ${extra}` : "";
    console.log(
      `[model-selection] session=${params.sessionKey ?? "(no-session)"} stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`,
    );
  };
  const {
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey,
    storePath,
    defaultProvider,
    defaultModel,
  } = params;

  let provider = params.provider;
  let model = params.model;

  const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
  const configuredModelCatalog = buildConfiguredModelCatalog({ cfg });
  const needsModelCatalog = params.hasModelDirective;

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = configuredModelCatalog;
  let modelCatalog: ModelCatalog | null = null;
  let resetModelOverride = false;
  const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;
  const directStoredOverride = resolvePersistedOverrideModelRef({
    defaultProvider,
    overrideProvider: sessionEntry?.providerOverride,
    overrideModel: sessionEntry?.modelOverride,
  });

  if (needsModelCatalog) {
    modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
    logStage("catalog-loaded", `entries=${modelCatalog.length}`);
    const allowed = buildAllowedModelSet({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
    });
    allowedModelCatalog = allowed.allowedCatalog;
    allowedModelKeys = allowed.allowedKeys;
    logStage(
      "allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (hasAllowlist) {
    const allowed = buildAllowedModelSet({
      cfg,
      catalog: configuredModelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
    });
    allowedModelCatalog = allowed.allowedCatalog;
    allowedModelKeys = allowed.allowedKeys;
    logStage(
      "configured-allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (configuredModelCatalog.length > 0) {
    logStage("configured-catalog-ready", `entries=${configuredModelCatalog.length}`);
  }

  if (sessionEntry && sessionStore && sessionKey && directStoredOverride) {
    const normalizedOverride = normalizeModelRef(
      directStoredOverride.provider,
      directStoredOverride.model,
    );
    const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
    if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) {
      const { updated } = applyModelOverrideToSessionEntry({
        entry: sessionEntry,
        selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
      });
      if (updated) {
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          await (
            await loadSessionStoreRuntime()
          ).updateSessionStore(storePath, (store) => {
            store[sessionKey] = sessionEntry;
          });
        }
      }
      resetModelOverride = updated;
    }
  }

  const storedOverride = resolveStoredModelOverride({
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey,
    defaultProvider,
  });
  // Skip stored session model override only when an explicit heartbeat.model
  // was resolved. Heartbeat runs without heartbeat.model should still inherit
  // the regular session/parent model override behavior.
  const skipStoredOverride = params.hasResolvedHeartbeatModelOverride === true;

  if (storedOverride?.model && !skipStoredOverride) {
    const normalizedStoredOverride = normalizeModelRef(
      storedOverride.provider || defaultProvider,
      storedOverride.model,
    );
    const key = modelKey(normalizedStoredOverride.provider, normalizedStoredOverride.model);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = normalizedStoredOverride.provider;
      model = normalizedStoredOverride.model;
    }
  }

  if (sessionEntry && sessionStore && sessionKey && sessionEntry.authProfileOverride) {
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
    const profile = store.profiles[sessionEntry.authProfileOverride];
    const providerKey = normalizeProviderId(provider);
    if (!profile || normalizeProviderId(profile.provider) !== providerKey) {
      await clearSessionAuthProfileOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  // AUTO ONLY. A stored session/parent pin, an inline `!model` directive or a
  // resolved heartbeat.model is an explicit choice and hard-stops here — the
  // resolver is not even consulted. That line is the whole design: it is what
  // separates this from the silent substitution 317825d0f7a removed, which
  // overrode explicit pins.
  //
  // The PRIMARY is swapped, not a fallback list handed over. Swapping the
  // provider makes resolveFallbackCandidates (model-fallback.ts) return [] for
  // the configured fallbacks and makes the 317825d0f7a guard decline to append
  // the config primary, so the substitute runs with an EMPTY ladder — that
  // guard's own invariant, reached BY COMPOSITION rather than by bypass. A
  // `fallbacksOverride` array would instead satisfy the guard's bypass
  // precondition and synthesize a cross-provider ladder from nothing, the
  // literal case its comment forbids. model-fallback.ts is untouched.
  //
  // Placed AFTER the authProfileOverride reconciliation above on purpose: that
  // block DELETES a stored auth-profile pin whose provider does not match
  // `provider`. Substituting before it would make a spent token window silently
  // and permanently discard the architect's auth-profile pick — a persisted
  // side effect, which is exactly what this feature must not have. The auth
  // profile is therefore still validated against the Auto selection.
  let quotaSubstitution: QuotaAwareAutoSubstitution | undefined;
  const hasExplicitModelSelection =
    params.hasModelDirective === true ||
    params.hasResolvedHeartbeatModelOverride === true ||
    Boolean(storedOverride?.model);
  if (!hasExplicitModelSelection) {
    // `snapshot` and `nowMs` are ARGUMENTS, never read inside the resolver: it is pure so every
    // decision is reproducible in a test, and so the gateway and the browser cannot disagree about
    // the same window from two hidden clocks (same rule as `src/shared/quota-window.ts`).
    //
    // `allowedModelKeys` goes IN rather than being filtered after: the resolver walks the ladder
    // and returns the first survivor, so handing it the routability filter lets it fall through to
    // rung 2 when rung 1 is not routable. Filtering only the returned choice would abandon the
    // substitution entirely in that case — the caller's own allowlist check below stays as a
    // belt-and-braces guard for an empty set.
    const substitute = resolveQuotaAwareAutoModel({
      cfg,
      provider,
      model,
      allowedModelKeys,
      // `?? undefined`: the store returns `| null`, the resolver's param is `| undefined`. Both
      // mean "no quota data", and the resolver reads either as UNKNOWN — never as headroom.
      snapshot: getUsageSnapshot() ?? undefined,
      nowMs: Date.now(),
    });
    if (substitute) {
      const normalizedSubstitute = normalizeModelRef(substitute.provider, substitute.model);
      const substituteKey = modelKey(normalizedSubstitute.provider, normalizedSubstitute.model);
      // An agent model allowlist is a hard boundary: Auto never routes outside it.
      if (allowedModelKeys.size === 0 || allowedModelKeys.has(substituteKey)) {
        quotaSubstitution = {
          originalProvider: provider,
          originalModel: model,
          provider: normalizedSubstitute.provider,
          model: normalizedSubstitute.model,
          reason: substitute.reason,
          notice: formatQuotaAwareAutoNotice({
            reason: substitute.reason,
            provider: normalizedSubstitute.provider,
            model: normalizedSubstitute.model,
          }),
        };
        provider = normalizedSubstitute.provider;
        model = normalizedSubstitute.model;
        logStage("quota-aware-auto-substituted", `to=${substituteKey}`);
      }
    }
  }

  let thinkingCatalog: ModelCatalog | undefined;
  const resolveThinkingCatalog = async () => {
    if (thinkingCatalog) {
      return thinkingCatalog;
    }
    let catalogForThinking =
      modelCatalog && modelCatalog.length > 0 ? modelCatalog : allowedModelCatalog;
    const selectedCatalogEntry = catalogForThinking?.find(
      (entry) => entry.provider === provider && entry.id === model,
    );
    const shouldHydrateRuntimeCatalog =
      !modelCatalog && (!selectedCatalogEntry || selectedCatalogEntry.reasoning === undefined);
    if (shouldHydrateRuntimeCatalog) {
      modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
      logStage("catalog-loaded-for-thinking", `entries=${modelCatalog.length}`);
      const runtimeSelectedEntry = modelCatalog.find(
        (entry) => entry.provider === provider && entry.id === model,
      );
      catalogForThinking =
        runtimeSelectedEntry || !catalogForThinking || catalogForThinking.length === 0
          ? modelCatalog.length > 0
            ? modelCatalog
            : allowedModelCatalog
          : allowedModelCatalog;
    }
    thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
    return thinkingCatalog;
  };

  let defaultThinkingLevel: ThinkLevel | undefined;
  const resolveDefaultThinkingLevel = async () => {
    if (defaultThinkingLevel) {
      return defaultThinkingLevel;
    }
    const agentThinkingDefault = agentEntry?.thinkingDefault as ThinkLevel | undefined;
    const configuredThinkingDefault = agentCfg?.thinkingDefault as ThinkLevel | undefined;
    const explicitThinkingDefault = agentThinkingDefault ?? configuredThinkingDefault;
    if (explicitThinkingDefault) {
      defaultThinkingLevel = explicitThinkingDefault;
      return defaultThinkingLevel;
    }
    const catalogForThinking = await resolveThinkingCatalog();
    const resolved = resolveThinkingDefault({
      cfg,
      provider,
      model,
      catalog: catalogForThinking,
    });
    defaultThinkingLevel = resolved ?? "off";
    return defaultThinkingLevel;
  };

  const resolveDefaultReasoningLevel = async (): Promise<"on" | "off"> => {
    let catalogForReasoning = modelCatalog ?? allowedModelCatalog;
    if (!catalogForReasoning || catalogForReasoning.length === 0) {
      modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
      logStage("catalog-loaded-for-reasoning", `entries=${modelCatalog.length}`);
      catalogForReasoning = modelCatalog;
    }
    return resolveReasoningDefault({
      provider,
      model,
      catalog: catalogForReasoning,
    });
  };

  return {
    provider,
    model,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    resolveThinkingCatalog,
    resolveDefaultThinkingLevel,
    resolveDefaultReasoningLevel,
    needsModelCatalog,
    quotaSubstitution,
  };
}

export function resolveContextTokens(params: {
  cfg: OpenClawConfig;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): number {
  return (
    params.agentCfg?.contextTokens ??
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      allowAsyncLoad: false,
    }) ??
    DEFAULT_CONTEXT_TOKENS
  );
}
