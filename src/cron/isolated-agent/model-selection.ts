import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadModelCatalog,
  normalizeModelSelection,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "./run-model-selection.runtime.js";

type CronSessionModelOverrides = {
  modelOverride?: string;
  providerOverride?: string;
};

export type ResolveCronModelSelectionParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  agentConfigOverride?: {
    model?: unknown;
    subagents?: {
      model?: unknown;
    };
  };
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
};

export type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
    }
  | {
      ok: false;
      error: string;
    };

function formatCronModelRejection(
  field: "payload.model" | "defaultModel",
  modelOverride: string,
  error: string,
): string {
  const source = field === "payload.model" ? "cron payload.model" : "cron.defaultModel";
  if (error.startsWith("model not allowed:")) {
    const modelRef = error.slice("model not allowed:".length).trim();
    return `${source} '${modelOverride}' rejected by agents.defaults.models allowlist: ${modelRef}`;
  }
  return `${source} '${modelOverride}' rejected: ${error}`;
}

export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;

  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalogOnce = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: params.cfgWithAgentDefaults });
    }
    return catalog;
  };

  const subagentModelRaw =
    normalizeModelSelection(params.agentConfigOverride?.subagents?.model) ??
    normalizeModelSelection(params.agentConfigOverride?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model);
  if (subagentModelRaw) {
    const resolvedSubagent = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: subagentModelRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (!("error" in resolvedSubagent)) {
      provider = resolvedSubagent.ref.provider;
      model = resolvedSubagent.ref.model;
    }
  }

  let cronDefaultModelApplied = false;
  const cronDefaultModel = params.cfg.cron?.defaultModel?.trim();
  if (cronDefaultModel) {
    const resolvedCronDefault = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: cronDefaultModel,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedCronDefault) {
      return {
        ok: false,
        error: formatCronModelRejection(
          "defaultModel",
          cronDefaultModel,
          resolvedCronDefault.error,
        ),
      };
    }
    provider = resolvedCronDefault.ref.provider;
    model = resolvedCronDefault.ref.model;
    cronDefaultModelApplied = true;
  }

  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = params.isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalogOnce(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
      hooksGmailModelApplied = true;
    }
  }

  const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      return {
        ok: false,
        error: formatCronModelRejection("payload.model", modelOverride, resolvedOverride.error),
      };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
  }

  if (!modelOverride && !hooksGmailModelApplied && !cronDefaultModelApplied) {
    const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      const sessionProviderOverride =
        params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = resolveAllowedModelRef({
        cfg: params.cfgWithAgentDefaults,
        catalog: await loadCatalogOnce(),
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
      }
    }
  }

  return { ok: true, provider, model };
}
