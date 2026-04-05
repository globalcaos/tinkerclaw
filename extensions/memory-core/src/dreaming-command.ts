import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  resolveMemoryLightSleepConfig,
  resolveMemoryRemSleepConfig,
  resolveMemorySleepConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";

type SleepPhaseName = "light" | "deep" | "rem";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeSleepPhase(value: unknown): SleepPhaseName | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "light" || normalized === "deep" || normalized === "rem") {
    return normalized;
  }
  return null;
}

function resolveMemoryCorePluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  return asRecord(entry?.config) ?? {};
}

function updateSleepEnabledInConfig(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  const entries = { ...(cfg.plugins?.entries ?? {}) };
  const existingEntry = asRecord(entries["memory-core"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  const existingSleep = asRecord(existingConfig.sleep) ?? {};
  entries["memory-core"] = {
    ...existingEntry,
    config: {
      ...existingConfig,
      sleep: {
        ...existingSleep,
        enabled,
      },
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function updateSleepPhaseEnabledInConfig(
  cfg: OpenClawConfig,
  phase: SleepPhaseName,
  enabled: boolean,
): OpenClawConfig {
  const entries = { ...(cfg.plugins?.entries ?? {}) };
  const existingEntry = asRecord(entries["memory-core"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  const existingSleep = asRecord(existingConfig.sleep) ?? {};
  const existingPhases = asRecord(existingSleep.phases) ?? {};
  const existingPhase = asRecord(existingPhases[phase]) ?? {};
  entries["memory-core"] = {
    ...existingEntry,
    config: {
      ...existingConfig,
      sleep: {
        ...existingSleep,
        phases: {
          ...existingPhases,
          [phase]: {
            ...existingPhase,
            enabled,
          },
        },
      },
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function formatEnabled(value: boolean): string {
  return value ? "on" : "off";
}

function formatPhaseGuide(): string {
  return [
    "- light: sorts recent memory traces into the daily note.",
    "- deep: promotes durable memories into MEMORY.md and handles recovery when memory is thin.",
    "- rem: writes reflection and pattern notes into the daily note.",
  ].join("\n");
}

function formatStatus(cfg: OpenClawConfig): string {
  const pluginConfig = resolveMemoryCorePluginConfig(cfg);
  const sleep = resolveMemorySleepConfig({
    pluginConfig,
    cfg,
  });
  const deep = resolveShortTermPromotionDreamingConfig({ pluginConfig, cfg });
  const light = resolveMemoryLightSleepConfig({ pluginConfig, cfg });
  const rem = resolveMemoryRemSleepConfig({ pluginConfig, cfg });
  const timezone = sleep.timezone ? ` (${sleep.timezone})` : "";

  return [
    "Sleep status:",
    `- enabled: ${formatEnabled(sleep.enabled)}${timezone}`,
    `- storage: ${sleep.storage.mode}${sleep.storage.separateReports ? " + reports" : ""}`,
    `- verboseLogging: ${formatEnabled(sleep.verboseLogging)}`,
    `- light: ${formatEnabled(light.enabled)} · cadence=${light.enabled ? light.cron : "disabled"} · lookbackDays=${light.lookbackDays} · limit=${light.limit}`,
    `- deep: ${formatEnabled(deep.enabled)} · cadence=${deep.enabled ? deep.cron : "disabled"} · limit=${deep.limit} · minScore=${deep.minScore} · minRecallCount=${deep.minRecallCount} · minUniqueQueries=${deep.minUniqueQueries} · recencyHalfLifeDays=${deep.recencyHalfLifeDays} · maxAgeDays=${deep.maxAgeDays ?? "none"}`,
    `- rem: ${formatEnabled(rem.enabled)} · cadence=${rem.enabled ? rem.cron : "disabled"} · lookbackDays=${rem.lookbackDays} · limit=${rem.limit} · minPatternStrength=${rem.minPatternStrength}`,
  ].join("\n");
}

function formatUsage(includeStatus: string): string {
  return [
    "Usage: /sleep status",
    "Usage: /sleep on|off",
    "Usage: /sleep enable light|deep|rem",
    "Usage: /sleep disable light|deep|rem",
    "",
    includeStatus,
    "",
    "Phases:",
    formatPhaseGuide(),
  ].join("\n");
}

export function registerSleepCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "sleep",
    description: "Configure memory sleep phases and durable promotion behavior.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const [firstToken = "", secondToken = ""] = args
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => token.toLowerCase());
      const currentConfig = api.runtime.config.loadConfig();

      if (
        !firstToken ||
        firstToken === "help" ||
        firstToken === "options" ||
        firstToken === "phases"
      ) {
        return { text: formatUsage(formatStatus(currentConfig)) };
      }

      if (firstToken === "status") {
        return { text: formatStatus(currentConfig) };
      }

      if (firstToken === "on" || firstToken === "off") {
        const enabled = firstToken === "on";
        const nextConfig = updateSleepEnabledInConfig(currentConfig, enabled);
        await api.runtime.config.writeConfigFile(nextConfig);
        return {
          text: [`Sleep ${enabled ? "enabled" : "disabled"}.`, "", formatStatus(nextConfig)].join(
            "\n",
          ),
        };
      }

      const phase = normalizeSleepPhase(secondToken);
      if ((firstToken === "enable" || firstToken === "disable") && phase) {
        const enabled = firstToken === "enable";
        const nextConfig = updateSleepPhaseEnabledInConfig(currentConfig, phase, enabled);
        await api.runtime.config.writeConfigFile(nextConfig);
        return {
          text: [
            `${phase.toUpperCase()} sleep ${enabled ? "enabled" : "disabled"}.`,
            "",
            formatStatus(nextConfig),
          ].join("\n"),
        };
      }

      return { text: formatUsage(formatStatus(currentConfig)) };
    },
  });
}

export const registerDreamingCommand = registerSleepCommand;
