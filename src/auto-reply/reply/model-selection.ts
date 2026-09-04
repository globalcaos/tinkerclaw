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
import { readOrcaBias } from "../../infra/orca-bias-store.js";
import { getUsageSnapshot } from "../../infra/usage-snapshot-store.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { relCostLookup } from "../../shared/rel-cost-table.js";
import {
  classifyTaskDomain,
  frontierRungsFor,
  type TaskDomain,
  THALAMUS_BIAS_GAP,
} from "../../shared/thalamus-frontier.js";
import {
  thalamusPlan,
  type CompositionMode,
  type ReservedReason,
  type RungVeto,
} from "../../shared/thalamus-plan.js";
import { supplyStates, type SupplyId, type SupplyState } from "../../shared/thalamus-supply.js";
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

/**
 * Set on a turn where THALAMUS chose the (model, thinking effort) rung, i.e. on
 * every Auto turn with a scored catalog and no explicit pin.
 *
 * Resolved per turn and PERSISTED NOWHERE, for the quota substitution's reason
 * verbatim: a written `modelOverride` would survive the next dial move and would
 * later be indistinguishable from a user pin. Recomputing it every turn is what
 * makes "drag the slider, the next turn obeys it" fall out of the dial's own state.
 */
export type ThalamusAutoRoute = {
  /** The routed rung's provider/model, already normalized. */
  provider: string;
  model: string;
  /** Vendor effort for the rung; "" when the route has no graded ladder. */
  effort: string;
  /** What `classifyTaskDomain` made of the prompt; "general" when it saw no signal. */
  domain: TaskDomain;
  /** AA Intelligence Index of the routed rung (measured, estimated or headline). */
  smart: number;
  /** EUR/Mtok of the routed rung: route relCost x the effort's cost multiplier. */
  cost: number;
  /** The dial position that produced this, already clamped to 0..6. */
  biasIdx: number;
  /** The router's own one-line rationale. */
  reason: string;
  /** Ready-to-send disclosure line. */
  notice: string;
  /**
   * FORK 2026-09-03 — THE RECOVERY LADDER, as `provider/model` strings ready for
   * `fallbacksOverride`. This is the field that fixes "rate limitations stall our thinking":
   * `agents.defaults.model.fallbacks` is `[]` in the live config, so the whole
   * `runWithModelFallback` machinery has been running on an empty ladder. One rung per OTHER
   * supply, because the failure it must survive is a rate limit and a second rung on the same
   * limited supply survives nothing. EMPTY means Thalamus genuinely found no alternative —
   * that is a fact worth surfacing, not a default worth hiding.
   */
  chain: string[];
  /** solo | critic | debate | fan-out — how the turn is composed (Fugu §3.2 tiers). */
  mode: CompositionMode;
  /** debate: the independent answerers; fan-out: the leaf model. */
  panel: string[];
  /** debate / fan-out: who synthesises. Per query, never fixed. */
  chair?: string;
  /** A subscription window is about to destroy surplus; tokens are free and exploration is on. */
  ballistic: boolean;
  /** Set only when a reserved model (Fable) was admitted, and names which of the three
   *  reasons opened it. A reserved model that arrives unexplained is a bug. */
  reservedReason?: ReservedReason;
  /** Rungs ruled out before fitness was even compared, for the panel. */
  vetoes: RungVeto[];
  /** Supply states as the turn saw them — utilization, binding window, shadow price. */
  supplies: SupplyState[];
};

/**
 * Disclosure carrier for a THALAMUS route.
 *
 * A sibling of `formatQuotaAwareAutoNotice` rather than a reuse of it: the two
 * answer different questions ("your provider is spent" vs "the dial and the task
 * chose this rung"), and folding them into one string would make a routine
 * bias-driven pick read as a quota failure.
 *
 * THE STOP IS A NUMBER, NOT A NAME. `BIAS_STOPS` (fast · quick · lean · balanced ·
 * deep · wide · smart) lives in `tinker-ui/src/panels/routing-rationale.ts`, which
 * the gateway must not import; copying the seven labels here would be a second home
 * for one fact, which is the drift `rel-cost-table.ts` and `thalamus-candidates.ts`
 * both exist to end. The denominator comes from `THALAMUS_BIAS_GAP` so "of 6" can
 * never disagree with the dial the router actually read.
 */
export function formatThalamusRouteNotice(params: {
  biasIdx: number;
  domain: string;
  provider: string;
  model: string;
  effort: string;
  reason: string;
}): string {
  const at = params.effort ? ` @${params.effort}` : "";
  return (
    `🧭 THALAMUS: bias ${params.biasIdx}/${THALAMUS_BIAS_GAP.length - 1} · domain ${params.domain}` +
    ` → ${formatProviderModelRef(params.provider, params.model)}${at} — ${params.reason}`
  );
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
  /** Present when THALAMUS chose this turn's (model, effort) rung from the BIAS
   *  dial and the task domain. `thalamusRoute.effort` is the effort the turn
   *  SHOULD run at — see the rung argument in get-reply-directives.ts. */
  thalamusRoute?: ThalamusAutoRoute;
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
  /** The user's message for THIS turn, used ONLY to classify the task domain
   *  (`classifyTaskDomain`). Omitted => domain "general", i.e. the plain bias
   *  pick with no expertise switch. Never logged, never persisted. */
  promptText?: string;
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

  // ── THALAMUS: the BIAS dial and the task domain choose the rung ─────────────
  //
  // FORK 2026-09-02 (the architect): "make sure … Thalamus actually automatically switches
  // among them smartly, following the BIAS selected in the slider … and routes
  // intelligently depending on the task at hand, following the Fugu family of
  // harnesses approach." Until this block the dial wrote ~/.openclaw/orca-bias.json
  // for the ORCA Conductor and NOTHING on the reply path read it, so Auto moved only
  // when a provider's window was spent: the slider was a control with no effect on
  // the turn the architect was typing.
  //
  // PRECEDENCE IS THE SAME LINE THE QUOTA BLOCK DRAWS, which is why this lives
  // INSIDE the same `!hasExplicitModelSelection` guard rather than after it. An
  // inline `!model`, a session/parent pin or a resolved heartbeat.model is an
  // explicit choice and hard-stops the router — the same separation from the silent
  // substitution 317825d0f7a removed. `OPENCLAW_THALAMUS_ROUTING=off` is the kill
  // switch. An agent model allowlist is a hard boundary TWICE: it goes IN to
  // `thalamusCandidates` so the frontier is built only from reachable rungs, and the
  // routed key is re-checked after normalization.
  //
  // IT RUNS AFTER THE QUOTA SUBSTITUTION, DELIBERATELY. `thalamusCandidates` applies
  // `providerQuotaExhaustion` — the very predicate the quota ladder uses, imported
  // rather than re-derived — so a spent provider is already absent from the rungs.
  // Running second therefore means thalamus may SUPERSEDE a quota substitution, but
  // can never route back INTO an exhausted provider. Nothing is persisted, for the
  // quota block's reason: a written override would be indistinguishable from a user
  // pin next turn, and would outlive the dial position that produced it.
  //
  // AN UNPRICED MODEL IS SKIPPED, NEVER DEFAULTED. `relCostLookup` returns undefined
  // on a table miss where `relCostFor` would answer DEFAULT_REL_COST (2.58); a rung
  // placed at an invented price would be ranked, could win the pick, and could
  // cost-veto a genuinely cheaper model on a number nobody published. A rung with no
  // cost cannot be placed on the plane at all, so it is dropped.
  //
  // KEYS ARE NORMALIZED BEFORE THE CATALOG IS BUILT. `allowedModelKeys` is produced
  // by parsing this very `agents.defaults.models` map through `parseModelRef`, so a
  // catalog keyed by the RAW config strings would read as `not-routable` for every
  // entry whose provider or model id normalizes — and the router would be silently
  // inert, with no error and no log. Normalizing here keeps both sides in one space.
  //
  // THE IMPORT IS DYNAMIC for two reasons, and the second one is the load-bearing
  // one: (1) a turn whose catalog publishes no `intelligenceIndex` should not pay to
  // load the module at all, and (2) `thalamus-candidates.ts` re-exports
  // `COST_CEILING_MULTIPLIER` from `agents/quota-aware-auto-model.js`, which several
  // reply tests replace with a PARTIAL `vi.mock` factory; a static import would
  // evaluate that re-export in every one of them and break files this change does
  // not own. The `priced` guard means those fixtures never reach the import.
  let thalamusRoute: ThalamusAutoRoute | undefined;
  if (!hasExplicitModelSelection && process.env.OPENCLAW_THALAMUS_ROUTING !== "off") {
    const configuredModels = cfg.agents?.defaults?.models ?? {};
    const thalamusCatalog: Record<string, { intelligenceIndex: number }> = {};
    for (const [rawKey, entry] of Object.entries(configuredModels)) {
      const index = entry?.intelligenceIndex;
      if (typeof index !== "number" || !Number.isFinite(index)) {
        continue;
      }
      const slash = rawKey.indexOf("/");
      if (slash <= 0 || slash === rawKey.length - 1) {
        continue;
      }
      const ref = normalizeModelRef(rawKey.slice(0, slash), rawKey.slice(slash + 1));
      thalamusCatalog[modelKey(ref.provider, ref.model)] = { intelligenceIndex: index };
    }
    if (Object.keys(thalamusCatalog).length > 0) {
      try {
        const { thalamusCandidates } = await import("../../shared/thalamus-candidates.js");
        const reachable = thalamusCandidates({
          catalog: thalamusCatalog,
          // `?? undefined`: the store returns `| null`, the module's param is
          // `| undefined`. Both mean "no quota data", read as UNKNOWN, never headroom.
          snapshot: getUsageSnapshot() ?? undefined,
          nowMs: Date.now(),
          // The key already carries "provider/model", which is exactly what
          // `relCostKey` wants, so it goes straight through.
          relCostFor: (key) => relCostLookup(key),
          allowedModelKeys: allowedModelKeys.size > 0 ? allowedModelKeys : undefined,
        });
        const rungs = reachable.considered.flatMap((candidate) =>
          candidate.relCost === undefined
            ? []
            : frontierRungsFor(candidate.key, candidate.intelligenceIndex, candidate.relCost),
        );
        const domain = classifyTaskDomain(params.promptText ?? "");
        const nowMs = Date.now();
        // SUPPLIES — the inventory, not the provider list. Absent from `windows` is UNKNOWN,
        // never headroom; `supplyStates` keeps that distinction and prices only what it can see.
        const supplies = supplyStates(getUsageSnapshot()?.windows, nowMs);
        // CONTEXT WINDOWS come from the live catalog, never from a table in this tree: the
        // catalog is the only copy that moves when a vendor raises a limit. A model the catalog
        // does not describe is UNKNOWN and passes the capacity veto (see `fitsContext`).
        const ctxByKey = new Map<string, number>();
        for (const entry of allowedModelCatalog) {
          if (typeof entry.contextWindow === "number" && entry.contextWindow > 0) {
            ctxByKey.set(modelKey(entry.provider, entry.id), entry.contextWindow);
          }
        }
        const plan = thalamusPlan({
          rungs,
          supplies,
          biasIdx: readOrcaBias(),
          domain,
          promptText: params.promptText,
          contextWindowFor: (key) => ctxByKey.get(key),
          // OPENROUTER IS UNFUNDED BY POLICY (the architect, 2026-09-03: "I will keep openrouter
          // without credits unless necessary because we are making too many mistakes trying to
          // route to it, and it is way too expensive for regular use"). It is METERED, so it
          // can never win on the burn term either — this flag only makes the standing decision
          // explicit and reversible with one env var rather than a code edit.
          unfunded:
            process.env.OPENCLAW_THALAMUS_ALLOW_OPENROUTER === "on"
              ? undefined
              : (new Set<SupplyId>(["openrouter"]) as ReadonlySet<SupplyId>),
          nowMs,
        });
        const route = plan?.route;
        logStage(
          "thalamus-considered",
          `catalog=${Object.keys(thalamusCatalog).length} reachable=${reachable.considered.length} rungs=${rungs.length} domain=${domain}` +
            ` supplies=${[...supplies.values()].map((x) => `${x.id}:${Math.round((x.binding?.used ?? 0) * 100)}%${x.spent ? "!" : ""}${x.ballistic ? "*" : ""}`).join(",")}` +
            ` vetoed=${plan?.vetoes.length ?? 0} chain=${plan?.chain.length ?? 0} mode=${plan?.mode ?? "-"}`,
        );
        const routedKey = route?.rung.key ?? "";
        const slash = routedKey.indexOf("/");
        if (route && slash > 0 && slash < routedKey.length - 1) {
          const normalized = normalizeModelRef(
            routedKey.slice(0, slash),
            routedKey.slice(slash + 1),
          );
          const routeKey = modelKey(normalized.provider, normalized.model);
          // An agent model allowlist is a hard boundary: Auto never routes outside it.
          if (allowedModelKeys.size === 0 || allowedModelKeys.has(routeKey)) {
            const movesModel = normalized.provider !== provider || normalized.model !== model;
            // A route that keeps the model but names an EFFORT is still a decision —
            // the rung, not the model, is what was picked off the frontier.
            // A PLAN IS A DECISION EVEN WHEN IT KEEPS THE MODEL. The old guard published a
            // route only when the model or the effort moved, which meant a turn that stayed on
            // Opus carried NO recovery chain — precisely the turn that stalls on a 429. The
            // chain is published whenever there is one.
            if (movesModel || route.rung.effort || (plan && plan.chain.length > 0)) {
              thalamusRoute = {
                provider: normalized.provider,
                model: normalized.model,
                effort: route.rung.effort,
                domain: route.domain,
                smart: route.rung.smart,
                cost: route.rung.cost,
                biasIdx: route.biasIdx,
                reason: plan?.reason ?? route.reason,
                notice: formatThalamusRouteNotice({
                  biasIdx: route.biasIdx,
                  domain: route.domain,
                  provider: normalized.provider,
                  model: normalized.model,
                  effort: route.rung.effort,
                  reason: plan?.reason ?? route.reason,
                }),
                chain: (plan?.chain ?? []).map((r) => r.key),
                mode: plan?.mode ?? "solo",
                panel: plan?.panel ?? [],
                chair: plan?.chair,
                ballistic: plan?.ballistic ?? false,
                reservedReason: plan?.reservedReason,
                vetoes: plan?.vetoes ?? [],
                supplies: plan?.supplies ?? [],
              };
              provider = normalized.provider;
              model = normalized.model;
              logStage(
                "thalamus-routed",
                `to=${routeKey} effort=${route.rung.effort || "(none)"} bias=${route.biasIdx} domain=${route.domain}`,
              );
            }
          } else {
            // Not silent: an allowlist that excludes every rung is indistinguishable
            // from a broken router unless it says so.
            logStage("thalamus-blocked-by-allowlist", `key=${routeKey}`);
          }
        }
      } catch (err) {
        // ROUTING IS AN OPTIMISATION, NEVER A GATE. The turn already has a valid Auto
        // selection before this block runs; a failure here must lose the improvement,
        // not the reply.
        logStage("thalamus-skipped", `error=${String((err as Error)?.message ?? err)}`);
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
    thalamusRoute,
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
