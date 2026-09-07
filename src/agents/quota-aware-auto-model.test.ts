import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UsageSnapshot } from "../infra/usage-snapshot-store.js";
import {
  COST_CEILING_MULTIPLIER,
  COST_UNVERIFIED_MARKER,
  QUOTA_COVERED_PROVIDERS,
  explainQuotaAwareAutoLadder,
  resolveQuotaAwareAutoModel,
  type LadderCandidate,
  type QuotaAwareAutoLadder,
  type ResolveQuotaAwareAutoModelParams,
} from "./quota-aware-auto-model.js";

// nowMs is always injected — never Date.now() — so every case is deterministic.
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z
const FIVE_HOUR_RESET = Date.UTC(2026, 8, 1, 15, 0, 0);
const SEVEN_DAY_RESET = Date.UTC(2026, 8, 3, 16, 0, 0);

const DEEPSEEK = "openrouter/deepseek/deepseek-v4-flash-0731";

type ModelFixture = { intelligenceIndex?: number; relCost?: number };

/**
 * Fixtures are literal, NEVER the live ~/.openclaw/openclaw.json — a test that reads the running
 * config goes red on a nightly price refresh and tells you nothing about the ladder.
 *
 * The cast exists only because `relCost` is not on `AgentModelEntryConfig` until spec §7.2 /
 * unit A1 lands. Drop it when the config type carries the field.
 */
function cfgOf(models: Record<string, ModelFixture>): OpenClawConfig {
  return { agents: { defaults: { models } } } as unknown as OpenClawConfig;
}

/** The live 2026-08-29 numbers from the design doc's §A.3 table, pinned as literals. */
const CATALOG: Record<string, ModelFixture> = {
  "claude-code/claude-opus-5": { intelligenceIndex: 63.0532452071291, relCost: 0.2232 },
  "claude-code/claude-fable-5": { intelligenceIndex: 62.0726622017462, relCost: 0.4464 },
  "openai-codex/gpt-5.6-sol": { intelligenceIndex: 60.9298701329203, relCost: 0.2679 },
  "xai/grok-4.6": { intelligenceIndex: 60.92297113115, relCost: 0.0536 },
  "openrouter/moonshotai/kimi-k3": { intelligenceIndex: 59.6994671342592, relCost: 15 },
  "openrouter/z-ai/glm-5.3": { intelligenceIndex: 59.5134408119521, relCost: 3.96 },
  "google/gemini-3.7-flash": { intelligenceIndex: 56.0301180773699, relCost: 3.75 },
  "claude-code/claude-sonnet-5": { intelligenceIndex: 55.261211717405, relCost: 0.0893 },
  [DEEPSEEK]: { intelligenceIndex: 51.7665776089032, relCost: 0.0899 },
};

function anthropicSnapshot(anthropic: UsageSnapshot["providers"]["anthropic"]): UsageSnapshot {
  return { lastSuccessfulFetch: NOW - 60_000, providers: { anthropic } };
}

const ANTHROPIC_SPENT = anthropicSnapshot({
  fiveHourUtilization: 100,
  sevenDayUtilization: 100,
  fiveHourResetAt: FIVE_HOUR_RESET,
  sevenDayResetAt: SEVEN_DAY_RESET,
});

const ANTHROPIC_HEALTHY = anthropicSnapshot({
  fiveHourUtilization: 42,
  sevenDayUtilization: 61,
  fiveHourResetAt: FIVE_HOUR_RESET,
  sevenDayResetAt: SEVEN_DAY_RESET,
});

function params(
  over: Partial<ResolveQuotaAwareAutoModelParams> = {},
): ResolveQuotaAwareAutoModelParams {
  return {
    cfg: cfgOf(CATALOG),
    provider: "claude-code",
    model: "claude-opus-5",
    snapshot: ANTHROPIC_SPENT,
    nowMs: NOW,
    ...over,
  };
}

function verdict(ladder: QuotaAwareAutoLadder, key: string): LadderCandidate {
  const found = ladder.candidates.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`candidate not in ladder: ${key}`);
  }
  return found;
}

function eligible(ladder: QuotaAwareAutoLadder): string[] {
  return ladder.candidates.filter((c) => c.exclusions.length === 0).map((c) => c.key);
}

describe("agents/quota-aware-auto-model", () => {
  describe("step 0 — no substitution while the original provider has window", () => {
    it("returns null when there is no snapshot at all", () => {
      expect(resolveQuotaAwareAutoModel(params({ snapshot: undefined }))).toBeNull();
    });

    it("returns null when the snapshot carries no provider rows", () => {
      const empty: UsageSnapshot = { lastSuccessfulFetch: NOW, providers: {} };
      expect(resolveQuotaAwareAutoModel(params({ snapshot: empty }))).toBeNull();
    });

    it("returns null when the original provider is healthy", () => {
      expect(resolveQuotaAwareAutoModel(params({ snapshot: ANTHROPIC_HEALTHY }))).toBeNull();
    });

    it("returns null at 100% once the window has already rolled over", () => {
      const rolled = anthropicSnapshot({
        fiveHourUtilization: 100,
        sevenDayUtilization: 100,
        fiveHourResetAt: NOW - 1,
        sevenDayResetAt: NOW - 1,
      });
      expect(resolveQuotaAwareAutoModel(params({ snapshot: rolled }))).toBeNull();
    });

    it("never substitutes away from a provider the snapshot cannot see (the coverage gap)", () => {
      const out = resolveQuotaAwareAutoModel(params({ provider: "xai", model: "grok-4.6" }));
      expect(out).toBeNull();
    });

    it("explain() reports the healthy provider without building a ladder", () => {
      const ladder = explainQuotaAwareAutoLadder(params({ snapshot: ANTHROPIC_HEALTHY }));
      expect(ladder.exhaustion).toBeNull();
      expect(ladder.candidates).toEqual([]);
      expect(ladder.selected).toBeNull();
    });
  });

  describe("the ladder from claude-code/claude-opus-5 with Anthropic spent", () => {
    it("selects openai-codex/gpt-5.6-sol and names the window in the reason", () => {
      expect(resolveQuotaAwareAutoModel(params())).toEqual({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reason:
          "claude-code 5-hour window exhausted (resets 15:00 UTC) — " +
          "Auto routed claude-code/claude-opus-5 -> openai-codex/gpt-5.6-sol",
      });
    });

    it("leaves exactly [gpt-5.6-sol, grok-4.6, deepseek-v4-flash-0731] eligible, in AA order", () => {
      expect(eligible(explainQuotaAwareAutoLadder(params()))).toEqual([
        "openai-codex/gpt-5.6-sol",
        "xai/grok-4.6",
        DEEPSEEK,
      ]);
    });

    it("takes gpt-5.6-sol over the 5x cheaper grok-4.6 it beats by 0.007 AA", () => {
      // Strict intelligence order, no tolerance band and no cost tie-break. Deliberate.
      const ladder = explainQuotaAwareAutoLadder(params());
      expect(verdict(ladder, "openai-codex/gpt-5.6-sol").selected).toBe(true);
      expect(verdict(ladder, "xai/grok-4.6").selected).toBe(false);
      expect(verdict(ladder, "xai/grok-4.6").relCost).toBeLessThan(0.2679);
    });

    it("puts the ceiling at 1.5x the original relCost", () => {
      const ladder = explainQuotaAwareAutoLadder(params());
      expect(COST_CEILING_MULTIPLIER).toBe(1.5);
      expect(ladder.ceiling).toBeCloseTo(0.3348, 12);
      expect(ladder.costVetoDisabled).toBe(false);
      expect(ladder.exhaustion?.label).toBe("5-hour");
      expect(ladder.exhaustion?.window.resetAtMs).toBe(FIVE_HOUR_RESET);
    });

    it("returns null when nothing survives the ladder", () => {
      const cat: Record<string, ModelFixture> = {
        "claude-code/claude-opus-5": { intelligenceIndex: 63, relCost: 0.2232 },
        "claude-code/claude-sonnet-5": { intelligenceIndex: 55, relCost: 0.0893 },
        "openrouter/moonshotai/kimi-k3": { intelligenceIndex: 59, relCost: 15 },
      };
      expect(resolveQuotaAwareAutoModel(params({ cfg: cfgOf(cat) }))).toBeNull();
    });
  });

  describe("every excluded model is excluded for a NAMED reason", () => {
    const ladder = explainQuotaAwareAutoLadder(params());

    it("claude-fable-5: cost first, and ALSO the same exhausted provider", () => {
      expect(verdict(ladder, "claude-code/claude-fable-5").exclusions).toEqual([
        "cost-veto",
        "provider-exhausted",
      ]);
    });

    it("claude-sonnet-5: exhausted provider ONLY — 0.0893 is well under the ceiling", () => {
      const candidate = verdict(ladder, "claude-code/claude-sonnet-5");
      expect(candidate.exclusions).toEqual(["provider-exhausted"]);
      expect(candidate.relCost).toBe(0.0893);
    });

    it("kimi-k3, glm-5.3 and gemini-3.7-flash: cost only", () => {
      expect(verdict(ladder, "openrouter/moonshotai/kimi-k3").exclusions).toEqual(["cost-veto"]);
      expect(verdict(ladder, "openrouter/z-ai/glm-5.3").exclusions).toEqual(["cost-veto"]);
      expect(verdict(ladder, "google/gemini-3.7-flash").exclusions).toEqual(["cost-veto"]);
    });
  });

  describe("the cost veto is a strict `> ceiling` test", () => {
    const cat: Record<string, ModelFixture> = {
      "claude-code/claude-opus-5": { intelligenceIndex: 60, relCost: 1 },
      "openai/over-the-ceiling": { intelligenceIndex: 55, relCost: 1.5000001 },
      "xai/at-the-ceiling": { intelligenceIndex: 50, relCost: 1.5 },
    };

    it("admits exactly 1.5x and vetoes a hair above it", () => {
      const ladder = explainQuotaAwareAutoLadder(params({ cfg: cfgOf(cat) }));
      expect(verdict(ladder, "openai/over-the-ceiling").exclusions).toEqual(["cost-veto"]);
      expect(verdict(ladder, "xai/at-the-ceiling").exclusions).toEqual([]);
      expect(ladder.selected?.model).toBe("at-the-ceiling");
    });
  });

  describe("a missing relCost never passes silently as free", () => {
    it("keeps a candidate with no relCost but FLAGS it in the reason", () => {
      const cat = { ...CATALOG, "openai-codex/gpt-5.6-sol": { intelligenceIndex: 60.93 } };
      const ladder = explainQuotaAwareAutoLadder(params({ cfg: cfgOf(cat) }));
      const candidate = verdict(ladder, "openai-codex/gpt-5.6-sol");
      expect(candidate.exclusions).toEqual([]);
      expect(candidate.costUnverified).toBe(true);
      expect(candidate.selected).toBe(true);
      expect(ladder.selected?.reason).toContain(COST_UNVERIFIED_MARKER);
      expect(ladder.selected?.reason).toContain("no relCost for openai-codex/gpt-5.6-sol");
    });

    it("disables the whole veto when the ORIGINAL has no relCost, and says so", () => {
      const cat = { ...CATALOG, "claude-code/claude-opus-5": { intelligenceIndex: 63.05 } };
      const ladder = explainQuotaAwareAutoLadder(params({ cfg: cfgOf(cat) }));
      expect(ladder.ceiling).toBeUndefined();
      expect(ladder.costVetoDisabled).toBe(true);
      // With no ceiling the 67x kimi is NOT dropped on cost — exactly the silent failure the
      // flag exists to make visible.
      expect(verdict(ladder, "openrouter/moonshotai/kimi-k3").exclusions).toEqual([]);
      expect(ladder.selected?.reason).toContain(COST_UNVERIFIED_MARKER);
      expect(ladder.selected?.reason).toContain("(original)");
    });
  });

  describe("the optional routability filter", () => {
    it("marks unroutable candidates and falls through to the next survivor", () => {
      const allowed = new Set(["claude-code/claude-opus-5", "xai/grok-4.6", DEEPSEEK]);
      const ladder = explainQuotaAwareAutoLadder(params({ allowedModelKeys: allowed }));
      expect(verdict(ladder, "openai-codex/gpt-5.6-sol").exclusions).toEqual(["not-routable"]);
      expect(ladder.selected).toEqual({
        provider: "xai",
        model: "grok-4.6",
        reason: expect.stringContaining("Auto routed claude-code/claude-opus-5 -> xai/grok-4.6"),
      });
    });
  });

  describe("models the config cannot rank", () => {
    it("drops a model with no intelligenceIndex instead of ranking it last", () => {
      const cat = { ...CATALOG, "xai/mystery": { relCost: 0.001 } };
      const ladder = explainQuotaAwareAutoLadder(params({ cfg: cfgOf(cat) }));
      expect(ladder.unranked).toContain("xai/mystery");
      expect(ladder.candidates.some((c) => c.key === "xai/mystery")).toBe(false);
    });
  });

  describe("the Anthropic pool is spent only when EVERY OAuth account is", () => {
    it("does not substitute while one account still has headroom", () => {
      // The collapsed scalars are the MAX across accounts and read 100/100 here; driving off
      // them instead of accounts[] would substitute a pool that still has capacity.
      const snapshot = anthropicSnapshot({
        fiveHourUtilization: 100,
        sevenDayUtilization: 100,
        accounts: [
          { label: "cli-sv", fiveHourUtilization: 100, sevenDayUtilization: 100 },
          { label: "cli-gm", fiveHourUtilization: 12, sevenDayUtilization: 40 },
        ],
      });
      expect(resolveQuotaAwareAutoModel(params({ snapshot }))).toBeNull();
    });

    it("substitutes when all accounts are spent, naming the SOONEST reset", () => {
      const snapshot = anthropicSnapshot({
        fiveHourUtilization: 100,
        sevenDayUtilization: 100,
        accounts: [
          {
            label: "cli-sv",
            fiveHourUtilization: 100,
            sevenDayUtilization: 100,
            fiveHourResetAt: Date.UTC(2026, 8, 1, 16, 30, 0),
          },
          {
            label: "cli-gm",
            fiveHourUtilization: 100,
            sevenDayUtilization: 100,
            fiveHourResetAt: FIVE_HOUR_RESET,
          },
        ],
      });
      const out = resolveQuotaAwareAutoModel(params({ snapshot }));
      expect(out?.model).toBe("gpt-5.6-sol");
      expect(out?.reason).toContain("claude-code 5-hour window exhausted (resets 15:00 UTC)");
    });
  });

  describe("window labelling", () => {
    it("reports the 7-day window when only that one is spent", () => {
      const snapshot = anthropicSnapshot({
        fiveHourUtilization: 30,
        sevenDayUtilization: 100,
        fiveHourResetAt: FIVE_HOUR_RESET,
        sevenDayResetAt: SEVEN_DAY_RESET,
      });
      const out = resolveQuotaAwareAutoModel(params({ snapshot }));
      expect(out?.reason).toContain("claude-code 7-day window exhausted (resets 16:00 UTC)");
    });

    it("stays exhausted with no published reset, and says exactly that", () => {
      const snapshot = anthropicSnapshot({ fiveHourUtilization: 100, sevenDayUtilization: 100 });
      const out = resolveQuotaAwareAutoModel(params({ snapshot }));
      expect(out?.reason).toContain("(no published reset)");
    });
  });

  // FORK 2026-08-29: these were written against `providers.google` (rpdUsed / rpdLimit). That
  // field was declared on UsageSnapshot but written by NO producer, and ea34b99e32d deleted it in
  // favour of the provider-agnostic `windows` map. Rewritten against `windows`, which is what the
  // budget panel actually publishes — so these now exercise a path with a live producer behind it.
  describe("non-Anthropic provider windows", () => {
    const spentGoogle: UsageSnapshot = {
      lastSuccessfulFetch: NOW,
      providers: {
        anthropic: {
          fiveHourUtilization: 100,
          sevenDayUtilization: 100,
          fiveHourResetAt: FIVE_HOUR_RESET,
        },
      },
      windows: {
        google: [{ label: "daily request", usedPercent: 100 }],
      },
    };
    const cheapGemini: Record<string, ModelFixture> = {
      ...CATALOG,
      "google/gemini-3.7-flash": { intelligenceIndex: 56.03, relCost: 0.01 },
    };

    it("skips a candidate whose published window is spent, on quota not cost", () => {
      const ladder = explainQuotaAwareAutoLadder(
        params({ cfg: cfgOf(cheapGemini), snapshot: spentGoogle }),
      );
      expect(verdict(ladder, "google/gemini-3.7-flash").exclusions).toEqual(["provider-exhausted"]);
    });

    it("takes the FIRST exhausted entry as the binding window, not the last", () => {
      const twoWindows: UsageSnapshot = {
        lastSuccessfulFetch: NOW,
        providers: { anthropic: { fiveHourUtilization: 100, sevenDayUtilization: 100 } },
        // shortest first, per the UsageSnapshot.windows order contract
        windows: {
          google: [
            { label: "daily request", usedPercent: 100 },
            { label: "monthly", usedPercent: 100 },
          ],
        },
      };
      const ladder = explainQuotaAwareAutoLadder(
        params({ cfg: cfgOf(cheapGemini), snapshot: twoWindows }),
      );
      expect(verdict(ladder, "google/gemini-3.7-flash").exclusions).toEqual(["provider-exhausted"]);
    });

    it("treats a provider ABSENT from windows as unknown, never as exhausted", () => {
      const noGoogle: UsageSnapshot = {
        lastSuccessfulFetch: NOW,
        providers: { anthropic: { fiveHourUtilization: 100, sevenDayUtilization: 100 } },
        windows: {},
      };
      const ladder = explainQuotaAwareAutoLadder(
        params({ cfg: cfgOf(cheapGemini), snapshot: noGoogle }),
      );
      expect(verdict(ladder, "google/gemini-3.7-flash").exclusions).toEqual([]);
    });

    it("leaves a candidate alone when its published window still has headroom", () => {
      const headroom: UsageSnapshot = {
        lastSuccessfulFetch: NOW,
        providers: { anthropic: { fiveHourUtilization: 100, sevenDayUtilization: 100 } },
        windows: { google: [{ label: "daily request", usedPercent: 99.9 }] },
      };
      const ladder = explainQuotaAwareAutoLadder(
        params({ cfg: cfgOf(cheapGemini), snapshot: headroom }),
      );
      expect(verdict(ladder, "google/gemini-3.7-flash").exclusions).toEqual([]);
    });
  });

  it("declares exactly which providers it can see quota for STATICALLY", () => {
    // A guessed coverage rule is how this feature would look green while skipping nothing.
    // Only the Anthropic OAuth pool is guaranteed by code in this module; every other provider is
    // covered IF AND ONLY IF the live snapshot carries `windows` for it (asserted below), so the
    // constant deliberately no longer lists "google" — that was true of a field no producer wrote.
    expect(QUOTA_COVERED_PROVIDERS).toEqual(["anthropic", "claude-code"]);
    expect(QUOTA_COVERED_PROVIDERS).not.toContain("openrouter");
  });

  it("extends coverage DYNAMICALLY to any provider present in windows", () => {
    // The other half of the coverage contract: the constant is the floor, not the ceiling. Without
    // this, dropping the windows lookup would still leave the constant test green.
    const spentXai: UsageSnapshot = {
      lastSuccessfulFetch: NOW,
      providers: { anthropic: { fiveHourUtilization: 100, sevenDayUtilization: 100 } },
      windows: { xai: [{ label: "weekly", usedPercent: 100 }] },
    };
    const ladder = explainQuotaAwareAutoLadder(params({ snapshot: spentXai }));
    expect(verdict(ladder, "xai/grok-4.6").exclusions).toEqual(["provider-exhausted"]);
  });
});
