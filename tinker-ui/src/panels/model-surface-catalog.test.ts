import { describe, expect, test } from "vitest";
import {
  modelCatalogIdsForPickerAndPanel,
  panelIdsDownToCopilot,
  withoutRouteTwins,
} from "./model-surface-catalog.js";

describe("picker and Smart/More model catalog", () => {
  test("keeps every direct configured model, including Opus 4.8, Grok 4.7, and More-tier models", () => {
    const configured = [
      "claude-code/claude-opus-4-8",
      "xai/grok-4.7",
      "claude-code/claude-haiku-4-5",
      "openrouter/qwen/qwen3.7-max",
    ];

    expect(modelCatalogIdsForPickerAndPanel(configured)).toEqual(configured);
  });

  test("applies the two route-level exclusions once for both surfaces", () => {
    expect(
      modelCatalogIdsForPickerAndPanel([
        "github-copilot/gpt-5.5",
        "openrouter/anthropic/claude-opus-4-8",
        "xai/grok-4.7",
      ]),
    ).toEqual(["xai/grok-4.7"]);
  });

  test("de-duplicates ids before either surface renders them", () => {
    expect(modelCatalogIdsForPickerAndPanel(["xai/grok-4.7", "xai/grok-4.7"])).toEqual([
      "xai/grok-4.7",
    ]);
  });
});

describe("MORE MODELS never draws a model twice", () => {
  test("drops the metered openai/ twin of a configured openai-codex/ seat model", () => {
    const configured = ["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol", "xai/grok-4.7"];
    const baked = [
      "openai-codex/gpt-6-astra",
      "openai/gpt-6-astra",
      "openai/gpt-6-sol",
      "openai/gpt-5.4",
      "google/gemini-2.5-pro",
    ];
    expect(withoutRouteTwins(baked, configured)).toEqual([
      "openai-codex/gpt-6-astra",
      "openai/gpt-5.4",
      "google/gemini-2.5-pro",
    ]);
  });

  test("keeps two routes when BOTH are configured", () => {
    const configured = ["openai-codex/gpt-5.5", "openai/gpt-5.5"];
    expect(withoutRouteTwins(configured, configured)).toEqual(configured);
  });
});

describe("picker + SMART MODELS cut at Copilot (display only)", () => {
  test("keeps everything down to and including Copilot, nothing below (Sonnet and Haiku too)", () => {
    const smartestFirst = [
      "claude-code/claude-opus-5-5",
      "openrouter/moonshotai/kimi-k3",
      "copilot/copilot-think-deeper",
      "openai-codex/gpt-5.6-terra",
      "claude-code/claude-sonnet-4-6",
      "openrouter/tencent/hy3",
      "claude-code/claude-haiku-4-5",
    ];
    expect(panelIdsDownToCopilot(smartestFirst)).toEqual([
      "claude-code/claude-opus-5-5",
      "openrouter/moonshotai/kimi-k3",
      "copilot/copilot-think-deeper",
    ]);
  });

  test("a catalog without Copilot is not cut", () => {
    const ids = ["claude-code/claude-opus-5-5", "claude-code/claude-haiku-4-5"];
    expect(panelIdsDownToCopilot(ids)).toEqual(ids);
  });
});
