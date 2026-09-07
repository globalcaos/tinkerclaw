import { describe, expect, it } from "vitest";
import { buildProviderWindows, type ExtraUsage } from "../index.js";

/**
 * Guards `buildProviderWindows` — the function that turns the vendor payloads the budget panel
 * already fetches into `UsageSnapshot.windows` (src/infra/usage-snapshot-store.ts).
 *
 * Two properties here are load-bearing and have no other enforcement anywhere in the tree:
 *   1. each provider's array is SHORTEST WINDOW FIRST, because a consumer takes the FIRST
 *      exhausted entry as the binding window;
 *   2. a provider with no signal is ABSENT, never a 0%-used entry — absence must read as
 *      UNKNOWN, and a fabricated 0% would read as "has headroom".
 * Both fail silently in production if broken, which is why they are pinned with a control.
 */

const NO_USAGE: ExtraUsage = {
  xai: null,
  copilot: null,
  gemini: null,
  chatgpt: null,
  openaiCosts: null,
};

describe("buildProviderWindows", () => {
  it("CONTROL: with no payloads, publishes NOTHING — absence, not a fabricated 0%", () => {
    // This is the pre-2026-08-29 world: the snapshot carried Anthropic and nothing else.
    expect(buildProviderWindows(null)).toEqual({});
    expect(buildProviderWindows(NO_USAGE)).toEqual({});
    // The distinction that matters to a consumer: "not in the map" must be reachable.
    expect("xai" in buildProviderWindows(NO_USAGE)).toBe(false);
  });

  it("widens the snapshot past Anthropic: xai, copilot and google each get a window", () => {
    const out = buildProviderWindows({
      ...NO_USAGE,
      xai: {
        usage_pct: 78,
        period_type: "weekly",
        period_end: "2026-09-01T00:00:00.000Z",
        fetchedAt: "2026-08-29T10:00:00.000Z",
      },
      copilot: { premium_used_pct: 41, chat_used_pct: 12 },
      gemini: { rpm_used: 3, rpm_limit: 60, rpd_used: 250, rpd_limit: 1000 },
    });

    expect(out.xai).toEqual([
      { label: "weekly", usedPercent: 78, resetAtMs: Date.parse("2026-09-01T00:00:00.000Z") },
    ]);
    // Copilot publishes percent_remaining only — no reset instant may be invented.
    expect(out["github-copilot"]).toEqual([
      { label: "monthly-chat", usedPercent: 12 },
      { label: "monthly-premium", usedPercent: 41 },
    ]);
    expect(out.google).toEqual([{ label: "daily", usedPercent: 25 }]);
  });

  it("orders Codex windows SHORTEST FIRST even when the payload lists them longest first", () => {
    // The control: the source object's own key order is Weekly-then-5h. A producer that simply
    // appended in iteration order would emit ["Weekly", "5h"] and a consumer taking the first
    // exhausted entry would wait for the WEEKLY reset while the 5-hour bucket is the real block.
    const chatgpt = {
      models: {
        Weekly: {
          rate_limits: { limit_requests: "1000", remaining_requests: "900" },
          resets_at: "2026-09-03T00:00:00.000Z",
        },
        "5h": {
          rate_limits: { limit_requests: "100", remaining_requests: "0" },
          resets_at: "2026-08-29T15:00:00.000Z",
        },
      },
    };
    expect(Object.keys(chatgpt.models)).toEqual(["Weekly", "5h"]); // control: input is misordered

    const out = buildProviderWindows({ ...NO_USAGE, chatgpt });
    expect(out["openai-codex"]?.map((w) => w.label)).toEqual(["5h", "Weekly"]);

    // …and the binding window a consumer would pick is the 5-hour one, fully spent.
    const binding = out["openai-codex"]?.find((w) => w.usedPercent >= 100);
    expect(binding?.label).toBe("5h");
    expect(binding?.resetAtMs).toBe(Date.parse("2026-08-29T15:00:00.000Z"));
  });

  it("normalises every timestamp through one parser: bad ISO becomes undefined, not 0 or NaN", () => {
    const out = buildProviderWindows({
      ...NO_USAGE,
      xai: { usage_pct: 10, period_type: "monthly", period_end: "not-a-date", fetchedAt: "" },
    });
    // undefined = UNKNOWN reset. 0 or NaN would read as "resets at the epoch" / "resets now".
    expect(out.xai?.[0]?.resetAtMs).toBeUndefined();
    expect(out.xai?.[0]).not.toHaveProperty("resetAtMs", 0);
  });

  it("clamps to 0-100 and never divides by a zero denominator", () => {
    const hot = buildProviderWindows({
      ...NO_USAGE,
      xai: { usage_pct: 140, fetchedAt: "" },
      copilot: { premium_used_pct: -5, chat_used_pct: 200 },
    });
    expect(hot.xai?.[0]?.usedPercent).toBe(100);
    expect(hot["github-copilot"]).toEqual([
      { label: "monthly-chat", usedPercent: 100 },
      { label: "monthly-premium", usedPercent: 0 },
    ]);

    // rpd_limit 0 would make (used/limit)*100 = NaN or Infinity; the provider must drop out
    // of the map entirely rather than publish a garbage percentage.
    const noLimit = buildProviderWindows({
      ...NO_USAGE,
      gemini: { rpm_used: 0, rpm_limit: 0, rpd_used: 7, rpd_limit: 0 },
    });
    expect("google" in noLimit).toBe(false);
  });

  it("documents the KNOWN GAP: openrouter is never present, at any input", () => {
    // openrouter is hard-excluded from the cooldown machinery
    // (src/agents/auth-profiles/usage-state.ts#isAuthCooldownBypassedForProvider) and no fetcher
    // reports windows for it, so every Kimi / Qwen / GLM / DeepSeek model routed through it is
    // invisible here. This test exists so that stops being a comment nobody re-checks: if a
    // future commit starts publishing openrouter windows, it fails and the gap note gets updated.
    const everything = buildProviderWindows({
      xai: { usage_pct: 50, fetchedAt: "" },
      copilot: { premium_used_pct: 50, chat_used_pct: 50 },
      gemini: { rpm_used: 1, rpm_limit: 60, rpd_used: 1, rpd_limit: 100 },
      chatgpt: {
        models: { "5h": { rate_limits: { limit_requests: "10", remaining_requests: "5" } } },
      },
      openaiCosts: { monthSpend: 42, dailyBreakdown: [] },
    });
    expect(Object.keys(everything).sort()).toEqual([
      "github-copilot",
      "google",
      "openai-codex",
      "xai",
    ]);
    expect("openrouter" in everything).toBe(false);
    // Dollars are not a window: month-to-date spend has no denominator at this layer.
    expect("openai" in everything).toBe(false);
  });
});
