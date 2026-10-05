import { formatThinkingLevels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pickOwnedModel } from "../infra/thalamus-call-router.js";
import {
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
} from "./model-selection.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    return { provider, model };
  }
  const provider = undefined;
  const model = trimmed;
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  /** The child's task and label: what Thalamus prices when it owns a spawn that names no model. */
  task?: string;
  label?: string;
}) {
  // FORK 2026-10-03 (the architect: "Make sure Thalamus is owner of all those model choices when it is working"). A spawn that
  // names no model is priced by Thalamus when it owns the `subagent` site; the configured default stays the fallback.
  // A model named on purpose is never replaced: the spawn's own, or one configured for sub-agents or for the target
  // agent. With no resolver, or one in shadow, this is exactly the old path.
  const owned =
    !params.modelOverride?.trim() &&
    params.task?.trim() &&
    !resolveSubagentConfiguredModelSelection({ cfg: params.cfg, agentId: params.targetAgentId })
      ? pickOwnedModel("subagent", {
          prompt: params.task,
          ...(params.label ? { label: params.label } : {}),
          ...(params.thinkingOverrideRaw ? { thinking: params.thinkingOverrideRaw } : {}),
        })
      : undefined;
  const resolvedModel =
    owned?.model ??
    resolveSubagentSpawnModelSelection({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      modelOverride: params.modelOverride,
    });

  let thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw ?? owned?.thinking,
  });
  // Thalamus's effort is advice: one this model does not accept is dropped, never turned into a failed spawn.
  if (thinkingPlan.status === "error" && !params.thinkingOverrideRaw && owned?.thinking) {
    thinkingPlan = resolveSubagentThinkingOverride({
      cfg: params.cfg,
      targetAgentConfig: params.targetAgentConfig,
      thinkingOverrideRaw: undefined,
    });
  }
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(resolvedModel);
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  return {
    status: "ok" as const,
    resolvedModel,
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      ...(resolvedModel
        ? {
            model: resolvedModel,
            modelOverrideSource: params.modelOverride?.trim() ? "user" : "auto",
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
    },
  };
}
