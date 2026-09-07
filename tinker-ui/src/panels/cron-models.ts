export type CronModelChoice = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
};

export type CronModelConfigState = {
  hash: string | null;
  agentDefaultModel?: string;
  cronDefaultModel?: string;
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeCronModelChoices(value: unknown): CronModelChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const choices: CronModelChoice[] = [];
  for (const entry of value) {
    const model = recordOf(entry);
    const id = trimmedString(model?.id);
    const provider = trimmedString(model?.provider);
    if (!id || !provider) continue;
    const ref = `${provider}/${id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    choices.push({
      id,
      provider,
      name: trimmedString(model?.name) ?? id,
      alias: trimmedString(model?.alias),
    });
  }
  return choices;
}

export function cronModelRef(model: CronModelChoice): string {
  return `${model.provider}/${model.id}`;
}

export function cronModelLabel(model: CronModelChoice): string {
  const ref = cronModelRef(model);
  return model.name === model.id ? ref : `${model.name} · ${ref}`;
}

export function readCronModelConfigState(snapshot: unknown): CronModelConfigState {
  const root = recordOf(snapshot);
  const config = recordOf(root?.config) ?? recordOf(root?.parsed);
  const cron = recordOf(config?.cron);
  const agents = recordOf(config?.agents);
  const defaults = recordOf(agents?.defaults);
  const configuredAgentModel = defaults?.model;
  const agentDefaultModel =
    trimmedString(configuredAgentModel) ?? trimmedString(recordOf(configuredAgentModel)?.primary);

  return {
    hash: trimmedString(root?.hash) ?? null,
    agentDefaultModel,
    cronDefaultModel: trimmedString(cron?.defaultModel),
  };
}

export function effectiveCronDefaultModel(state: CronModelConfigState): string {
  return state.cronDefaultModel ?? state.agentDefaultModel ?? "system default";
}

export function resolveCronJobModel(
  modelOverride: string | undefined,
  defaultModel: string,
): { model: string; status: "inherited" | "overridden" } {
  const override = trimmedString(modelOverride);
  return override
    ? { model: override, status: "overridden" }
    : { model: defaultModel, status: "inherited" };
}

export function buildCronDefaultModelPatch(model: string | undefined): string {
  return JSON.stringify({
    cron: {
      defaultModel: trimmedString(model) ?? null,
    },
  });
}
