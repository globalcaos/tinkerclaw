import { describe, expect, it } from "vitest";
import {
  buildCronDefaultModelPatch,
  cronModelRef,
  effectiveCronDefaultModel,
  normalizeCronModelChoices,
  readCronModelConfigState,
  resolveCronJobModel,
} from "./cron-models.js";

describe("cron model controls", () => {
  it("builds live provider/model choices without duplicates", () => {
    const models = normalizeCronModelChoices([
      { id: "gpt-5.4", name: "GPT 5.4", provider: "openai" },
      { id: "gpt-5.4", name: "duplicate", provider: "openai" },
      { id: "claude-sonnet-4-6", name: "Sonnet", provider: "anthropic" },
      { id: "missing-provider" },
    ]);

    expect(models).toHaveLength(2);
    expect(models.map(cronModelRef)).toEqual(["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]);
  });

  it("reads fleet and agent defaults from config.get", () => {
    const state = readCronModelConfigState({
      hash: "base-hash",
      config: {
        cron: { defaultModel: "anthropic/claude-sonnet-4-6" },
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      },
    });

    expect(state).toEqual({
      hash: "base-hash",
      cronDefaultModel: "anthropic/claude-sonnet-4-6",
      agentDefaultModel: "openai/gpt-5.4",
    });
    expect(effectiveCronDefaultModel(state)).toBe("anthropic/claude-sonnet-4-6");
  });

  it("distinguishes inherited and overridden effective models", () => {
    expect(resolveCronJobModel(undefined, "openai/gpt-5.4")).toEqual({
      model: "openai/gpt-5.4",
      status: "inherited",
    });
    expect(resolveCronJobModel("anthropic/claude-sonnet-4-6", "openai/gpt-5.4")).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      status: "overridden",
    });
  });

  it("uses JSON merge-patch null to clear only cron.defaultModel", () => {
    expect(JSON.parse(buildCronDefaultModelPatch(undefined))).toEqual({
      cron: { defaultModel: null },
    });
    expect(JSON.parse(buildCronDefaultModelPatch("openai/gpt-5.4"))).toEqual({
      cron: { defaultModel: "openai/gpt-5.4" },
    });
  });
});
