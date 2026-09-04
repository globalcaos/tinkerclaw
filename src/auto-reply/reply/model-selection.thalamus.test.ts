import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearOrcaBiasCache } from "../../infra/orca-bias-store.js";
import { relCostLookup } from "../../shared/rel-cost-table.js";
import {
  classifyTaskDomain,
  frontierRungsFor,
  thalamusRoute,
} from "../../shared/thalamus-frontier.js";
import { createModelSelectionState, formatThalamusRouteNotice } from "./model-selection.js";

const quotaMocks = vi.hoisted(() => ({
  resolveQuotaAwareAutoModel: vi.fn(),
}));

// A PARTIAL mock, unlike model-selection.quota-aware.test.ts, and the difference is
// load-bearing: `thalamus-candidates.ts` imports `providerQuotaExhaustion` from this
// module and RE-EXPORTS `COST_CEILING_MULTIPLIER` from it, so a factory returning only
// `resolveQuotaAwareAutoModel` makes the router unloadable. Keep the real module and
// stub the single function under test's control.
vi.mock("../../agents/quota-aware-auto-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/quota-aware-auto-model.js")>()),
  resolveQuotaAwareAutoModel: quotaMocks.resolveQuotaAwareAutoModel,
}));

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: vi.fn(async () => []),
}));

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
}));

const AUTO_PROVIDER = "claude-code";
const AUTO_MODEL = "claude-opus-5";
const OPUS = `${AUTO_PROVIDER}/${AUTO_MODEL}`;
const GROK = "xai/grok-4.6";
const LUNA = "openai-codex/gpt-5.6-luna";

// Three routes that all carry a REAL REL_COST_TABLE row, spanning ~11 AA points and
// ~21x in price — wide enough that the two ends of the dial cannot land on the same
// rung by accident.
const CATALOG: Record<string, { intelligenceIndex: number }> = {
  [OPUS]: { intelligenceIndex: 63 },
  [GROK]: { intelligenceIndex: 60.9 },
  [LUNA]: { intelligenceIndex: 52.3 },
};

/**
 * What the gateway is SUPPOSED to compute, from the same shared modules.
 *
 * This pins the WIRING — catalog -> price -> rung -> route -> provider/model/effort —
 * and deliberately NOT the price or AA tables: re-pricing a model moves both sides at
 * once, while a mis-wired gateway (a raw catalog key, a defaulted price, a dropped
 * bias read) moves only one. A test that hardcoded "bias 6 => claude-opus-5@max"
 * would go red on an honest table edit and teach the next agent to delete it.
 */
function expectedRoute(biasIdx: number, prompt = "") {
  const rungs = Object.entries(CATALOG).flatMap(([key, entry]) => {
    const relCost = relCostLookup(key);
    return relCost === undefined ? [] : frontierRungsFor(key, entry.intelligenceIndex, relCost);
  });
  return thalamusRoute({ rungs, biasIdx, domain: classifyTaskDomain(prompt) });
}

function makeCfg(models: Record<string, { intelligenceIndex: number }> = CATALOG): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: OPUS, fallbacks: [] },
        models: { ...models },
      },
    },
  } as unknown as OpenClawConfig;
}

function writeBias(biasIdx: number): void {
  const file = join(mkdtempSync(join(tmpdir(), "thalamus-bias-")), "orca-bias.json");
  writeFileSync(file, `${JSON.stringify({ biasIdx, ts: Date.now() })}\n`);
  process.env.OPENCLAW_ORCA_BIAS_FILE = file;
  clearOrcaBiasCache();
}

function createState(params: {
  cfg?: OpenClawConfig;
  hasModelDirective?: boolean;
  promptText?: string;
}) {
  const cfg = params.cfg ?? makeCfg();
  return createModelSelectionState({
    cfg,
    agentCfg: cfg.agents?.defaults,
    defaultProvider: AUTO_PROVIDER,
    defaultModel: AUTO_MODEL,
    provider: AUTO_PROVIDER,
    model: AUTO_MODEL,
    hasModelDirective: params.hasModelDirective ?? false,
    promptText: params.promptText,
  });
}

beforeEach(() => {
  quotaMocks.resolveQuotaAwareAutoModel.mockReset();
  quotaMocks.resolveQuotaAwareAutoModel.mockReturnValue(null);
  delete process.env.OPENCLAW_THALAMUS_ROUTING;
  delete process.env.OPENCLAW_ORCA_BIAS_FILE;
  clearOrcaBiasCache();
});

afterEach(() => {
  delete process.env.OPENCLAW_THALAMUS_ROUTING;
  delete process.env.OPENCLAW_ORCA_BIAS_FILE;
  clearOrcaBiasCache();
});

describe("createModelSelectionState THALAMUS routing", () => {
  it("routes to the frontier's best rung at the SMART end of the dial", async () => {
    writeBias(6);
    const want = expectedRoute(6);
    expect(want).toBeDefined();

    const state = await createState({});

    expect(state.thalamusRoute).toBeDefined();
    expect(`${state.thalamusRoute?.provider}/${state.thalamusRoute?.model}`).toBe(want?.rung.key);
    expect(state.thalamusRoute?.effort).toBe(want?.rung.effort);
    expect(state.thalamusRoute?.biasIdx).toBe(6);
    expect(state.thalamusRoute?.domain).toBe("general");
    // The routed rung IS the selection everywhere downstream, exactly as the quota
    // substitution is — not a fallback list handed over.
    expect(`${state.provider}/${state.model}`).toBe(want?.rung.key);
    expect(state.thalamusRoute?.notice).toBe(
      formatThalamusRouteNotice({
        biasIdx: 6,
        domain: "general",
        provider: state.thalamusRoute?.provider ?? "",
        model: state.thalamusRoute?.model ?? "",
        effort: state.thalamusRoute?.effort ?? "",
        reason: want?.reason ?? "",
      }),
    );
  });

  it("routes to a cheaper, no-smarter rung at the FAST end — the dial actually moves it", async () => {
    writeBias(6);
    const smart = (await createState({})).thalamusRoute;
    writeBias(0);
    const fast = (await createState({})).thalamusRoute;

    expect(smart).toBeDefined();
    expect(fast).toBeDefined();
    const wantFast = expectedRoute(0);
    expect(`${fast?.provider}/${fast?.model}`).toBe(wantFast?.rung.key);
    expect(fast?.effort).toBe(wantFast?.rung.effort);
    expect(fast?.biasIdx).toBe(0);
    // The invariant the dial encodes, stated as an inequality so it survives a
    // re-priced table: turning it left never costs more and never buys more.
    expect(fast?.cost).toBeLessThanOrEqual(smart?.cost ?? Number.POSITIVE_INFINITY);
    expect(fast?.smart).toBeLessThanOrEqual(smart?.smart ?? Number.POSITIVE_INFINITY);
    // "fast" trades at most THALAMUS_BIAS_GAP[0] = 15 AA points for price.
    expect((smart?.smart ?? 0) - (fast?.smart ?? 0)).toBeLessThanOrEqual(15);
  });

  it("defaults to the balanced stop when the dial file does not exist", async () => {
    process.env.OPENCLAW_ORCA_BIAS_FILE = join(
      mkdtempSync(join(tmpdir(), "thalamus-bias-")),
      "missing.json",
    );
    clearOrcaBiasCache();

    const state = await createState({});

    expect(state.thalamusRoute?.biasIdx).toBe(3);
  });

  it("classifies the task domain from the prompt and says so in the disclosure", async () => {
    writeBias(3);
    const prompt =
      "fix the typescript compile bug in this refactor, then run the vitest unit test suite and lint";
    // Self-check: if the classifier stops seeing this as code the assertion below
    // would pass vacuously on a "general" route.
    expect(classifyTaskDomain(prompt)).toBe("code");

    const state = await createState({ promptText: prompt });

    expect(state.thalamusRoute?.domain).toBe("code");
    expect(state.thalamusRoute?.notice).toContain("domain code");
    expect(state.thalamusRoute?.notice).toContain("🧭 THALAMUS");
    expect(`${state.thalamusRoute?.provider}/${state.thalamusRoute?.model}`).toBe(
      expectedRoute(3, prompt)?.rung.key,
    );
  });

  it("never runs for an explicit inline model directive", async () => {
    writeBias(6);

    const state = await createState({ hasModelDirective: true });

    expect(state.thalamusRoute).toBeUndefined();
    expect(state.provider).toBe(AUTO_PROVIDER);
    expect(state.model).toBe(AUTO_MODEL);
  });

  it("never runs for a session/parent model pin", async () => {
    writeBias(6);
    const cfg = makeCfg();
    const sessionEntry = {
      sessionId: "session-id",
      updatedAt: 0,
      providerOverride: AUTO_PROVIDER,
      modelOverride: AUTO_MODEL,
    } as never;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      defaultProvider: AUTO_PROVIDER,
      defaultModel: AUTO_MODEL,
      provider: AUTO_PROVIDER,
      model: AUTO_MODEL,
      hasModelDirective: false,
    });

    expect(state.thalamusRoute).toBeUndefined();
    expect(state.provider).toBe(AUTO_PROVIDER);
    expect(state.model).toBe(AUTO_MODEL);
  });

  it("is inert when OPENCLAW_THALAMUS_ROUTING=off", async () => {
    writeBias(6);
    process.env.OPENCLAW_THALAMUS_ROUTING = "off";

    const state = await createState({});

    expect(state.thalamusRoute).toBeUndefined();
    expect(state.provider).toBe(AUTO_PROVIDER);
    expect(state.model).toBe(AUTO_MODEL);
  });

  it("is inert when no configured model publishes an intelligenceIndex", async () => {
    // The shape every pre-existing reply fixture has. Proves this change cannot move
    // a turn whose catalog thalamus can place nothing from.
    writeBias(6);
    const cfg = {
      agents: { defaults: { model: { primary: OPUS, fallbacks: [] } } },
    } as OpenClawConfig;

    const state = await createState({ cfg });

    expect(state.thalamusRoute).toBeUndefined();
    expect(state.provider).toBe(AUTO_PROVIDER);
    expect(state.model).toBe(AUTO_MODEL);
  });
});
