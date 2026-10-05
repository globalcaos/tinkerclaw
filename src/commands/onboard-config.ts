import { setConfigValueAtPath } from "../config/config-paths.js";
import type { DmScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolProfileId } from "../config/types.tools.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
): OpenClawConfig {
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
    session: {
      ...baseConfig.session,
      dmScope: baseConfig.session?.dmScope ?? ONBOARDING_DEFAULT_DM_SCOPE,
    },
    tools: {
      ...baseConfig.tools,
      profile: baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
    },
  };
}

export function applySkipBootstrapConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(cfg);
  setConfigValueAtPath(
    next as Record<string, unknown>,
    ["agents", "defaults", "skipBootstrap"],
    true,
  );
  return next;
}

/**
 * FORK 2026-09-22: the agent's name, chosen at install time, becomes the opening
 * sentence of its system prompt (agents.defaults.identityLine).
 */
export const DEFAULT_AGENT_NAME = "Tinker";

export function buildAgentIdentityLine(name: string): string {
  const trimmed = name.trim() || DEFAULT_AGENT_NAME;
  return `You are ${trimmed}, an agent running TinkerClaw, a Claude Code UI enhanced with ideas from other harnesses.`;
}

/** Recover the name from an identity line this module built (for re-runs of setup). */
export function parseAgentNameFromIdentityLine(line: string | undefined): string | undefined {
  const match = /^You are (.+?), an agent running TinkerClaw\b/.exec(line?.trim() ?? "");
  return match?.[1]?.trim() || undefined;
}

export function applyAgentNameConfig(cfg: OpenClawConfig, name: string): OpenClawConfig {
  const next = structuredClone(cfg);
  setConfigValueAtPath(
    next as Record<string, unknown>,
    ["agents", "defaults", "identityLine"],
    buildAgentIdentityLine(name),
  );
  return next;
}
