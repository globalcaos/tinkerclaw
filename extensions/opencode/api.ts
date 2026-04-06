import {
  applyAgentDefaultModelPrimary,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "./onboard.js";
export {
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
} from "./onboard.js";

const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set([
  "opencode/claude-opus-4-5",
  "opencode-zen/claude-opus-4-5",
]);

export const OPENCODE_ZEN_DEFAULT_MODEL = OPENCODE_ZEN_DEFAULT_MODEL_REF;

export function applyOpencodeZenModelDefault(
  cfg: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig,
): {
  next: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig;
  changed: boolean;
} {
  const current = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  const normalizedCurrent =
    current && LEGACY_OPENCODE_ZEN_DEFAULT_MODELS.has(current)
      ? OPENCODE_ZEN_DEFAULT_MODEL
      : current;
  if (normalizedCurrent === OPENCODE_ZEN_DEFAULT_MODEL) {
    return { next: cfg, changed: false };
  }
  return {
    next: applyAgentDefaultModelPrimary(cfg, OPENCODE_ZEN_DEFAULT_MODEL),
    changed: true,
  };
}
