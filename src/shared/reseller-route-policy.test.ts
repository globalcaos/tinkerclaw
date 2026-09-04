import { describe, expect, it } from "vitest";
import { DIRECT_SUBSCRIPTION_VENDORS, isRedundantResellerRoute } from "./reseller-route-policy.js";

describe("isRedundantResellerRoute", () => {
  it("vetoes an OpenRouter route to a vendor we hold directly", () => {
    // The exact route that dead-ended the Herbalist tab, and the metered Opus twin that
    // prompted the rule (same intelligence index as claude-code/claude-opus-5, ~50x the cost).
    expect(isRedundantResellerRoute("openrouter/anthropic/claude-fable-5.1")).toBe(true);
    expect(isRedundantResellerRoute("openrouter/anthropic/claude-opus-5-fast")).toBe(true);
    expect(isRedundantResellerRoute("openrouter/openai/gpt-5.3-codex")).toBe(true);
    expect(isRedundantResellerRoute("openrouter/google/gemini-3.5-flash")).toBe(true);
    expect(isRedundantResellerRoute("openrouter/x-ai/grok-4.6")).toBe(true);
  });

  it("leaves OpenRouter-only vendors alone", () => {
    // These have no direct route at all. Vetoing them would delete capability, not save money
    // — which is why the rule is a vendor SET and not startsWith("openrouter/").
    for (const id of [
      "openrouter/z-ai/glm-5.3",
      "openrouter/deepseek/deepseek-v4-pro-0813",
      "openrouter/qwen/qwen3.8-max",
      "openrouter/moonshotai/kimi-k3",
      "openrouter/meta/muse-spark-1.2",
      "openrouter/minimax/minimax-m3",
    ]) {
      expect(isRedundantResellerRoute(id)).toBe(false);
    }
  });

  it("never vetoes a non-OpenRouter route", () => {
    // The direct routes themselves, and a Copilot re-sell: Copilot is deliberately NOT covered
    // here (it is governed by modelIsHiddenFromModelsPanel, and the SMART x COST chart keeps
    // plotting it on purpose as the procurement argument).
    for (const id of [
      "claude-code/claude-opus-5",
      "claude-code/claude-fable-5-1",
      "xai/grok-4.6",
      "openai-codex/gpt-5.6-sol",
      "google/gemini-3.7-flash",
      "github-copilot/gpt-5.5",
      "openai/gpt-5.3-codex",
    ]) {
      expect(isRedundantResellerRoute(id)).toBe(false);
    }
  });

  it("treats a vendor-only or malformed id as nothing to veto", () => {
    // Fewer than three segments carries no model id. Degrading to false keeps a partial id
    // from throwing inside a render path.
    for (const id of ["", "openrouter", "openrouter/", "openrouter/anthropic"]) {
      expect(isRedundantResellerRoute(id)).toBe(false);
    }
  });

  it("matches the vendor namespace case-insensitively", () => {
    expect(isRedundantResellerRoute("openrouter/Anthropic/claude-opus-5-fast")).toBe(true);
  });

  it("names both spellings of the xAI namespace", () => {
    // OpenRouter writes `x-ai`; our own provider id is `xai`. Ids arrive from both sides.
    expect(DIRECT_SUBSCRIPTION_VENDORS.has("x-ai")).toBe(true);
    expect(DIRECT_SUBSCRIPTION_VENDORS.has("xai")).toBe(true);
    expect(DIRECT_SUBSCRIPTION_VENDORS.has("deepseek")).toBe(false);
  });
});
