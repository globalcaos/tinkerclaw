import { describe, it, expect, beforeEach } from "vitest";
import { setUsageSnapshot } from "../infra/usage-snapshot-store.js";
import type { UsageSnapshot } from "../infra/usage-snapshot-store.js";
import { isCandidateAllowed } from "./billing-gate.js";

const MODELS_CONFIG = {
  "anthropic/claude-opus-4-6": { billing: "flat" as const },
  "anthropic/claude-sonnet-4-6": { billing: "flat" as const },
  "openai/gpt-5.2-pro": { billing: "metered" as const, monthlyCapUsd: 20 },
  "openai/o3": { billing: "metered" as const, monthlyCapUsd: 10 },
  "google/gemini-3.1-pro-preview": { billing: "metered" as const, monthlyCapUsd: 5 },
  "ollama/qwen3:14b-q4_K_M": { billing: "free" as const },
};

const PRIMARY = "anthropic/claude-opus-4-6";

function freshSnapshot(overrides?: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    lastSuccessfulFetch: Date.now(),
    providers: {
      anthropic: { sevenDayUtilization: 50, fiveHourUtilization: 10 },
      openai: { monthSpendUsd: 5 },
    },
    ...overrides,
  };
}

describe("billing-gate", () => {
  beforeEach(() => {
    setUsageSnapshot(freshSnapshot());
  });

  it("always allows primary model regardless of billing tier", () => {
    const result = isCandidateAllowed(PRIMARY, PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: true, reason: "is_primary" });
  });

  it("always allows flat-rate models", () => {
    const result = isCandidateAllowed("anthropic/claude-sonnet-4-6", PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: true, reason: "flat_or_free" });
  });

  it("always allows free models", () => {
    const result = isCandidateAllowed("ollama/qwen3:14b-q4_K_M", PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: true, reason: "flat_or_free" });
  });

  it("treats missing billing field as flat (safe default)", () => {
    const config = { "unknown/model": {} };
    const result = isCandidateAllowed("unknown/model", PRIMARY, config);
    expect(result).toEqual({ allowed: true, reason: "flat_or_free" });
  });

  it("blocks metered model when snapshot is null", () => {
    setUsageSnapshot(null);
    const result = isCandidateAllowed("openai/gpt-5.2-pro", PRIMARY, MODELS_CONFIG);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("usage_data_unavailable");
  });

  it("blocks metered model when snapshot is stale (>1 hour)", () => {
    setUsageSnapshot(
      freshSnapshot({
        lastSuccessfulFetch: Date.now() - 3_700_000,
      }),
    );
    const result = isCandidateAllowed("openai/gpt-5.2-pro", PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: false, reason: "usage_data_unavailable" });
  });

  it("blocks metered model when provider spend >= monthlyCapUsd", () => {
    setUsageSnapshot(
      freshSnapshot({
        providers: {
          anthropic: { sevenDayUtilization: 80, fiveHourUtilization: 10 },
          openai: { monthSpendUsd: 25 },
        },
      }),
    );
    const result = isCandidateAllowed("openai/gpt-5.2-pro", PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: false, reason: "over_cap" });
  });

  it("blocks o3 at lower cap than gpt (per-model cap, provider spend)", () => {
    setUsageSnapshot(
      freshSnapshot({
        providers: {
          anthropic: { sevenDayUtilization: 80, fiveHourUtilization: 10 },
          openai: { monthSpendUsd: 12 },
        },
      }),
    );
    const o3 = isCandidateAllowed("openai/o3", PRIMARY, MODELS_CONFIG);
    expect(o3).toEqual({ allowed: false, reason: "over_cap" });

    const gpt = isCandidateAllowed("openai/gpt-5.2-pro", PRIMARY, MODELS_CONFIG);
    expect(gpt).toEqual({ allowed: true, reason: "budget_ok" });
  });

  it("blocks metered model when primary has headroom (<70%)", () => {
    setUsageSnapshot(
      freshSnapshot({
        providers: {
          anthropic: { sevenDayUtilization: 40, fiveHourUtilization: 5 },
          openai: { monthSpendUsd: 2 },
        },
      }),
    );
    const result = isCandidateAllowed("openai/gpt-5.2-pro", PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: false, reason: "primary_has_headroom" });
  });

  it("allows metered model when primary is pressured (>70%) and under cap", () => {
    setUsageSnapshot(
      freshSnapshot({
        providers: {
          anthropic: { sevenDayUtilization: 85, fiveHourUtilization: 30 },
          openai: { monthSpendUsd: 8 },
        },
      }),
    );
    const result = isCandidateAllowed("openai/gpt-5.2-pro", PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: true, reason: "budget_ok" });
  });

  it("blocks metered model when monthlyCapUsd is 0 (default)", () => {
    const config = { "openai/new-model": { billing: "metered" as const } };
    setUsageSnapshot(
      freshSnapshot({
        providers: {
          anthropic: { sevenDayUtilization: 90, fiveHourUtilization: 10 },
          openai: { monthSpendUsd: 0 },
        },
      }),
    );
    const result = isCandidateAllowed("openai/new-model", PRIMARY, config);
    expect(result).toEqual({ allowed: false, reason: "over_cap" });
  });

  it("handles Google model with no monthSpendUsd (cap check skipped)", () => {
    setUsageSnapshot(
      freshSnapshot({
        providers: {
          anthropic: { sevenDayUtilization: 85, fiveHourUtilization: 10 },
        },
      }),
    );
    const result = isCandidateAllowed("google/gemini-3.1-pro-preview", PRIMARY, MODELS_CONFIG);
    expect(result).toEqual({ allowed: true, reason: "budget_ok" });
  });

  it("allows primary even if it is metered (someone else's config)", () => {
    const meteredPrimary = "openai/gpt-5.2-pro";
    const result = isCandidateAllowed(meteredPrimary, meteredPrimary, MODELS_CONFIG);
    expect(result).toEqual({ allowed: true, reason: "is_primary" });
  });

  it("blocks unknown metered provider with no spend data", () => {
    const config = { "manus/agent": { billing: "metered" as const, monthlyCapUsd: 10 } };
    setUsageSnapshot(
      freshSnapshot({
        providers: {
          anthropic: { sevenDayUtilization: 90, fiveHourUtilization: 10 },
        },
      }),
    );
    const result = isCandidateAllowed("manus/agent", PRIMARY, config);
    expect(result).toEqual({ allowed: false, reason: "over_cap" });
  });

  it("returns safe default on internal exception", () => {
    setUsageSnapshot(freshSnapshot());
    const badConfig = null as unknown as Record<string, never>;
    const result = isCandidateAllowed("openai/gpt-5.2-pro", PRIMARY, badConfig);
    expect(result).toEqual({ allowed: false, reason: "usage_data_unavailable" });
  });
});
