import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 48 * 60 * 60;
const DEFAULT_ACTIVITY_GRACE_SECONDS = 600;
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

export function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveAgentActivityGraceSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.activityGraceSeconds);
  if (raw === undefined) {
    return DEFAULT_ACTIVITY_GRACE_SECONDS;
  }
  // 0 (or below) explicitly disables the sliding activity window (legacy fixed
  // wall-clock timeout); handle before clamping so 0 never becomes 1.
  if (raw <= 0) {
    return 0;
  }
  return Math.max(raw, 1);
}

export function resolveAgentActivityGraceMs(cfg?: OpenClawConfig): number {
  return Math.min(resolveAgentActivityGraceSeconds(cfg) * 1000, MAX_SAFE_TIMEOUT_MS);
}

export function resolveAgentMaxRunSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.maxRunSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveAgentMaxRunMs(cfg?: OpenClawConfig): number {
  return Math.min(resolveAgentMaxRunSeconds(cfg) * 1000, MAX_SAFE_TIMEOUT_MS);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const clampTimeoutMs = (valueMs: number) =>
    Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
  const defaultMs = clampTimeoutMs(resolveAgentTimeoutSeconds(opts.cfg) * 1000);
  // Use the maximum timer-safe timeout to represent "no timeout" when explicitly set to 0.
  const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideSeconds * 1000);
  }
  return defaultMs;
}
