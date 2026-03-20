// src/agents/billing-gate.ts
// FORK: Pre-flight billing check for the model fallback candidate loop.
// Blocks metered models when budget caps are exceeded or primary has headroom.
// On any error or missing data, defaults to blocking metered (safety bag).

import { getUsageSnapshot } from "../infra/usage-snapshot-store.js";

export interface BillingGateResult {
  allowed: boolean;
  reason:
    | "flat_or_free"
    | "is_primary"
    | "budget_ok"
    | "over_cap"
    | "primary_has_headroom"
    | "usage_data_unavailable";
}

interface ModelBillingConfig {
  billing?: "flat" | "metered" | "free";
  monthlyCapUsd?: number;
}

const STALENESS_MS = 3_600_000; // 1 hour
const HEADROOM_THRESHOLD = 70; // seven_day utilization % below which primary is "healthy"

/**
 * Check whether a candidate model is allowed by billing rules.
 *
 * @param candidateModelId  Full model ID, e.g. "openai/gpt-5.2-pro"
 * @param primaryModelId    Configured primary model ID
 * @param modelsConfig      Map of model ID → billing config from openclaw.json
 */
export function isCandidateAllowed(
  candidateModelId: string,
  primaryModelId: string,
  modelsConfig: Record<string, ModelBillingConfig>,
): BillingGateResult {
  try {
    // 1. Primary is always allowed
    if (candidateModelId === primaryModelId) {
      return { allowed: true, reason: "is_primary" };
    }

    // 2. Look up billing tier
    const cfg = modelsConfig[candidateModelId];
    const billing = cfg?.billing ?? "flat";

    if (billing === "flat" || billing === "free") {
      return { allowed: true, reason: "flat_or_free" };
    }

    // 3. Candidate is metered — check budget
    const snapshot = getUsageSnapshot();

    if (!snapshot || Date.now() - snapshot.lastSuccessfulFetch > STALENESS_MS) {
      return { allowed: false, reason: "usage_data_unavailable" };
    }

    // 4. Check provider monthly spend vs cap
    const provider = candidateModelId.split("/")[0]; // e.g. "openai"
    const monthlyCapUsd = cfg?.monthlyCapUsd ?? 0;

    if (monthlyCapUsd === 0) {
      // No cap configured → metered model is effectively blocked
      return { allowed: false, reason: "over_cap" };
    }

    if (provider === "openai" && snapshot.providers.openai) {
      if (snapshot.providers.openai.monthSpendUsd >= monthlyCapUsd) {
        return { allowed: false, reason: "over_cap" };
      }
    } else if (provider === "google") {
      // Google has no monthSpendUsd in snapshot — skip cap check, headroom check still applies
    } else {
      // Unknown provider with no spend data — block (safety bag)
      return { allowed: false, reason: "over_cap" };
    }

    // 5. Check if primary provider has headroom
    const primaryProvider = primaryModelId.split("/")[0];
    if (primaryProvider === "anthropic" && snapshot.providers.anthropic) {
      if (snapshot.providers.anthropic.sevenDayUtilization < HEADROOM_THRESHOLD) {
        return { allowed: false, reason: "primary_has_headroom" };
      }
    }

    // 6. All checks passed — metered model allowed
    return { allowed: true, reason: "budget_ok" };
  } catch {
    return { allowed: false, reason: "usage_data_unavailable" };
  }
}
