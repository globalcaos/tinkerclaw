import { describe, expect, test } from "vitest";
import {
  isResellerRoute,
  modelCatalogIdsForPickerAndPanel,
  modelNameAndVersion,
  latestOfFamily,
  panelIdsDownToCopilot,
  pickerChipLabels,
  softHyphenate,
  withoutRouteTwins,
} from "./model-surface-catalog.js";

// 2026-11-18: "Hydrog / en" and "Copilo / t" on the live picker; a soft hyphen near the middle
// moves the break to a syllable and draws a hyphen there.
describe("softHyphenate", () => {
  const SHY = "­";
  test("a long one-word nickname gets one soft hyphen after a vowel", () => {
    expect(softHyphenate("Hydrogen")).toBe(`Hydro${SHY}gen`);
    expect(softHyphenate("Copilot")).toBe(`Copi${SHY}lot`);
  });
  test("short words, two-word labels of short words and words with digits stay as they are", () => {
    for (const l of ["Sonnet", "Wonder Full", "Kimi Pro", "Qwen 2.4T", "Auto", "GPT-4o"]) {
      expect(softHyphenate(l)).toBe(l);
    }
  });
  test("removing the soft hyphen gives the label back", () => {
    for (const l of ["Hydrogen", "Copilot", "Wonder Full", "Lithium", "Mistral"]) {
      expect(softHyphenate(l).replaceAll(SHY, "")).toBe(l);
    }
  });
});

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

  test("the two best DeepInfra models are kept, also under Copilot; the third is not", () => {
    const smartestFirst = [
      "claude-code/claude-opus-5-5",
      "deepinfra/moonshotai/Kimi-K3",
      "copilot/copilot-think-deeper",
      "openai-codex/gpt-5.6-terra",
      "deepinfra/Qwen/Qwen3.8-2.4T-A95B",
      "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash",
    ];
    expect(panelIdsDownToCopilot(smartestFirst)).toEqual([
      "claude-code/claude-opus-5-5",
      "deepinfra/moonshotai/Kimi-K3",
      "copilot/copilot-think-deeper",
      "deepinfra/Qwen/Qwen3.8-2.4T-A95B",
    ]);
  });

  test("a catalog without Copilot is not cut", () => {
    const ids = ["claude-code/claude-opus-5-5", "claude-code/claude-haiku-4-5"];
    expect(panelIdsDownToCopilot(ids)).toEqual(ids);
  });
});

describe("latestOfFamily: one version per model name (the architect 2026-11-13, 2026-11-18)", () => {
  test("keeps the newest version of EVERY name, not a hand-picked few", () => {
    const ids = [
      "claude-code/claude-fable-5",
      "claude-code/claude-fable-5-1",
      "claude-code/claude-fable-5-2",
      "claude-code/claude-opus-4-8",
      "claude-code/claude-opus-5",
      "claude-code/claude-opus-5-5",
      "claude-code/claude-sonnet-4-6",
      "claude-code/claude-sonnet-5",
      "claude-code/claude-sonnet-5-5",
      "claude-code/claude-haiku-4-5",
      "claude-code/claude-haiku-5-5",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-6-sol",
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-6.1-terra",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-6-luna",
      "google/gemini-3.5-flash",
      "google/gemini-3.8-flash",
      "google/gemini-4-carbon",
      "google/gemini-4-hydrogen",
      "xai/grok-4.5",
      "xai/grok-4.6",
      "xai/grok-4.7",
      "deepinfra/moonshotai/Kimi-K2.6",
      "deepinfra/moonshotai/Kimi-K3",
      "openrouter/moonshotai/kimi-k3.1-pro",
      "deepinfra/zai-org/GLM-5.1",
      "deepinfra/zai-org/GLM-5.3",
      "deepinfra/zai-org/GLM-5.3-Flash",
      "copilot/copilot-think-deeper",
    ];
    expect(latestOfFamily(ids)).toEqual([
      "claude-code/claude-fable-5-2",
      "claude-code/claude-opus-5-5",
      "claude-code/claude-sonnet-5-5",
      "claude-code/claude-haiku-5-5",
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-6.1-terra",
      "openai-codex/gpt-6-luna",
      "google/gemini-3.8-flash",
      "google/gemini-4-carbon",
      "google/gemini-4-hydrogen",
      "xai/grok-4.7",
      "deepinfra/moonshotai/Kimi-K3",
      "openrouter/moonshotai/kimi-k3.1-pro",
      "deepinfra/zai-org/GLM-5.3",
      "deepinfra/zai-org/GLM-5.3-Flash",
      "copilot/copilot-think-deeper",
    ]);
  });

  test("a newer greyed chip hides an older configured version, and an older greyed chip goes", () => {
    const ids = [
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-6.1-terra",
      "aa:gpt-6-2-sol",
      "aa:gpt-6-2-astra",
      "aa:claude-opus-4-5-thinking",
      "claude-code/claude-opus-5-5",
      "aa:gpt-5-2",
      "openai-codex/gpt-5.5",
    ];
    expect(latestOfFamily(ids)).toEqual([
      "openai-codex/gpt-6.1-terra",
      "aa:gpt-6-2-sol",
      "aa:gpt-6-2-astra",
      "claude-code/claude-opus-5-5",
      "openai-codex/gpt-5.5",
    ]);
  });

  test("one route per version: native, then DeepInfra, then OpenRouter; newest snapshot on one route", () => {
    const ids = [
      "openrouter/z-ai/glm-5.3",
      "deepinfra/zai-org/GLM-5.3",
      "openrouter/tencent/hy4",
      "deepinfra/tencent/Hy4-preview",
      "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash",
      "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "deepinfra/deepseek-ai/DeepSeek-V4-Flash-0731",
      "openai-codex/gpt-5.5",
      "openai/gpt-5.5",
    ];
    expect(latestOfFamily(ids)).toEqual([
      "deepinfra/zai-org/GLM-5.3",
      "deepinfra/tencent/Hy4-preview",
      "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "openai-codex/gpt-5.5",
    ]);
  });

  test("a size is part of the name, a version is not", () => {
    const ids = [
      "deepinfra/Qwen/Qwen3.8-2.4T-A95B",
      "openrouter/qwen/qwen3.8-2.4t-a95b",
      "deepinfra/Qwen/Qwen3.8-27B",
      "aa:qwen4-max",
      "deepinfra/Qwen/Qwen3.8-Max",
      "deepinfra/meta-models/Muse-Glimmer-30B",
      "openrouter/meta/muse-spark-open",
      "aa:mimo-v2-pro",
      "deepinfra/XiaomiMiMo/MiMo-V2.6-Pro",
    ];
    expect(latestOfFamily(ids)).toEqual([
      "deepinfra/Qwen/Qwen3.8-2.4T-A95B",
      "deepinfra/Qwen/Qwen3.8-27B",
      "aa:qwen4-max",
      "deepinfra/meta-models/Muse-Glimmer-30B",
      "openrouter/meta/muse-spark-open",
      "deepinfra/XiaomiMiMo/MiMo-V2.6-Pro",
    ]);
  });

  test("names and versions parse the same from config ids and AA slugs", () => {
    expect(modelNameAndVersion("openai-codex/gpt-6.1-sol")).toEqual({
      name: "gpt-sol",
      version: [6, 1],
      date: 0,
    });
    expect(modelNameAndVersion("aa:gpt-6-2-sol")).toEqual({
      name: "gpt-sol",
      version: [6, 2],
      date: 0,
    });
    expect(modelNameAndVersion("aa:grok-build-0-1-06-16")).toEqual({
      name: "grok-build",
      version: [0, 1],
      date: 616,
    });
    expect(modelNameAndVersion("aa:claude-35-sonnet")).toEqual({
      name: "claude-sonnet",
      version: [3, 5],
      date: 0,
    });
    expect(modelNameAndVersion("aa:gemini-2-5-flash-preview-09-2025-reasoning")).toEqual({
      name: "gemini-flash",
      version: [2, 5],
      date: 2025,
    });
  });

  test("an old AA slug never out-ranks the current model (the census caught both on 2026-11-18)", () => {
    // claude-35-sonnet is Claude 3.5 and hid Sonnet 5.5; Grok 4.20 (March 2026) came before 4.7.
    const ids = [
      "claude-code/claude-sonnet-5-5",
      "aa:claude-35-sonnet",
      "xai/grok-4.7",
      "aa:grok-4-20",
      "google/gemini-3.8-flash",
      "aa:gemini-2-5-flash-preview-09-2025-reasoning",
    ];
    expect(latestOfFamily(ids)).toEqual([
      "claude-code/claude-sonnet-5-5",
      "xai/grok-4.7",
      "google/gemini-3.8-flash",
    ]);
  });

  test("month-name dates, stage words and chat/instruct do not make a new name (MORE MODELS census)", () => {
    expect(modelNameAndVersion("aa:claude-35-sonnet-june-24").name).toBe("claude-sonnet");
    expect(modelNameAndVersion("aa:gemini-1-5-pro-may-2024")).toEqual({
      name: "gemini-pro",
      version: [1, 5],
      date: 0,
    });
    const ids = [
      "claude-code/claude-sonnet-5-5",
      "aa:claude-35-sonnet-june-24",
      "google/gemini-3.1-pro-preview",
      "aa:gemini-1-5-pro-may-2024",
      "google/gemini-3.8-flash",
      "aa:gemini-2-0-flash-exp",
      "aa:llama-2-chat-70b",
      "aa:llama-3-3-instruct-70b",
    ];
    expect(latestOfFamily(ids)).toEqual([
      "claude-code/claude-sonnet-5-5",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.8-flash",
      "aa:llama-3-3-instruct-70b",
    ]);
  });

  test("a one-letter version suffix and 'turbo' keep the model's name (4.6v, 4o, GLM-5-Turbo)", () => {
    expect(modelNameAndVersion("aa:glm-4-6v")).toEqual({ name: "glm-v", version: [4, 6], date: 0 });
    expect(modelNameAndVersion("openai/gpt-4o").name).toBe("gpt-o");
    expect(modelNameAndVersion("openai/o3").name).toBe("o");
    const ids = [
      "aa:glm-4-6v",
      "aa:glm-4-5v",
      "deepinfra/zai-org/GLM-5.3",
      "aa:glm-5-turbo",
      "openai-codex/gpt-5.5",
      "aa:gpt-4-turbo",
      "openai/gpt-4o",
      "openai/o3",
    ];
    expect(latestOfFamily(ids)).toEqual([
      "aa:glm-4-6v",
      "deepinfra/zai-org/GLM-5.3",
      "openai-codex/gpt-5.5",
      "openai/gpt-4o",
      "openai/o3",
    ]);
  });

  test("OpenRouter and DeepInfra are the reseller routes", () => {
    expect(
      ["openrouter/x/y", "deepinfra/x/y", "openai-codex/gpt-5.5", "aa:qwen4-max"].map(
        isResellerRoute,
      ),
    ).toEqual([true, true, false, false]);
  });
});

describe("pickerChipLabels: the nickname, no version, unique on screen (the owner 2026-11-18)", () => {
  test("the picker of 2026-11-18 reads Fable, Opus, Sonnet, Terra, Sol, Astra …", () => {
    const ids = [
      "claude-code/claude-fable-5-2",
      "claude-code/claude-opus-5-5",
      "claude-code/claude-sonnet-5-5",
      "openai-codex/gpt-6.1-terra",
      "aa:gpt-6-2-sol",
      "aa:gpt-6-2-astra",
      "google/gemini-4-carbon",
      "google/gemini-4-hydrogen",
      "google/gemini-4-argon",
      "deepinfra/moonshotai/Kimi-K3",
      "openrouter/moonshotai/kimi-k3.1-pro",
      "deepinfra/Qwen/Qwen3.8-2.4T-A95B",
      "aa:qwen4-max",
      "aa:muse-wonder-full",
      "aa:muse-spark-1-3",
      "aa:muse-wonder",
      "copilot/copilot-think-deeper",
      "openai-codex/gpt-5.5",
    ];
    expect([...pickerChipLabels(ids).values()]).toEqual([
      "Fable",
      "Opus",
      "Sonnet",
      "Terra",
      "Sol",
      "Astra",
      "Carbon",
      "Hydrogen",
      "Argon",
      "Kimi",
      "Kimi Pro",
      "Qwen 2.4T",
      "Qwen Max",
      "Wonder Full",
      "Spark",
      "Wonder",
      "Copilot",
      "GPT",
    ]);
  });
  test("two models that still read the same fall back to the given label", () => {
    const labels = pickerChipLabels(
      ["openai-codex/gpt-5.5", "openai/gpt-4o"],
      (id) => `fallback:${id}`,
    );
    expect(labels.get("openai-codex/gpt-5.5")).toBe("fallback:openai-codex/gpt-5.5");
    expect(labels.get("openai/gpt-4o")).toBe("fallback:openai/gpt-4o");
  });
});
