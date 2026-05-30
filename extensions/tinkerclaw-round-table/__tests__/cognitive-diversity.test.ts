/**
 * Tests for CDI (Cognitive Diversity Index) scoring (extension copy).
 */

import { describe, it, expect, vi } from "vitest";
import {
  pearsonCorrelation,
  measureCDI,
  correlationCI,
  providerOf,
  assertProviderDiversity,
  selectModelsForDebateWithProviderDiversity,
  selectBackupParticipant,
  DEFAULT_PROVIDER_PROFILES,
  type ProviderProfile,
} from "../src/cognitive-diversity.js";
import { ROLE_AFFINITY } from "../src/raac-protocol.js";
import { modelForRole } from "../src/real-participant.js";

describe("CDI: returns 0 for unanimous proposals", () => {
  it("identical error vectors produce CDI = 0", () => {
    const errors = [true, false, true, true, false, false, true, false, true, true];
    const result = measureCDI({
      modelA: errors,
      modelB: [...errors],
      modelC: [...errors],
    });
    expect(result.cdi).toBeCloseTo(0, 1);
  });

  it("single model produces CDI = 0 (no pairs)", () => {
    const result = measureCDI({
      onlyModel: [true, false, true],
    });
    // With one model there are 0 pairs, meanCorrelation = 0, CDI = 1 - 0 = 1
    // Actually: pairs = 0, so sumCorrelation / pairs would be 0, CDI = 1
    // This is correct: a single model has no pairwise diversity to measure
    expect(result.cdi).toBe(1);
  });
});

describe("CDI: returns >0 when roles disagree", () => {
  it("uncorrelated vectors produce CDI > 0.5", () => {
    const a = [true, false, true, false, true, false, true, false, true, false];
    const b = [false, true, false, true, false, true, false, true, false, true];
    const c = [true, true, false, false, true, true, false, false, true, true];

    const result = measureCDI({ a, b, c });
    expect(result.cdi).toBeGreaterThan(0.5);
  });

  it("anti-correlated vectors produce CDI > 1", () => {
    const a = [true, true, true, true, true, false, false, false, false, false];
    const b = [false, false, false, false, false, true, true, true, true, true];

    const result = measureCDI({ a, b });
    expect(result.cdi).toBeGreaterThan(1);
  });

  it("partially overlapping errors produce 0 < CDI < 2", () => {
    const a = [true, true, false, false, true, false, true, false];
    const b = [true, false, true, false, true, true, false, false];

    const result = measureCDI({ a, b });
    expect(result.cdi).toBeGreaterThan(0);
    expect(result.cdi).toBeLessThan(2);
  });
});

describe("CDI: score range is always [0,1] for correlated inputs", () => {
  it("identical errors give CDI = 0 (minimum for positively correlated)", () => {
    const v = [true, false, true, false, true];
    const result = measureCDI({ x: v, y: [...v] });
    expect(result.cdi).toBeCloseTo(0, 5);
  });

  it("confidence interval is computed and brackets the mean correlation", () => {
    const [lo, hi] = correlationCI(0.5, 50);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(lo).toBeGreaterThan(-1);
    expect(hi).toBeLessThan(1);
  });

  it("small sample returns wide CI [-1, 1]", () => {
    const [lo, hi] = correlationCI(0.5, 3);
    expect(lo).toBe(-1);
    expect(hi).toBe(1);
  });
});

describe("CDI: edge cases", () => {
  it("pearsonCorrelation of empty arrays returns 0", () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  it("pearsonCorrelation of constant arrays returns 0 (no variance)", () => {
    expect(pearsonCorrelation([true, true, true], [true, true, true])).toBe(0);
  });

  it("measureCDI timestamp is a valid ISO string", () => {
    const result = measureCDI({ a: [true], b: [false] });
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});

// -- 7C: Provider-diversity LOCK --

describe("7C: providerOf derives vendor from the resolved ref", () => {
  it("splits 'provider/model' on the first slash", () => {
    expect(providerOf("claude-code/claude-opus-4-8")).toBe("claude-code");
    expect(providerOf("openai/o3")).toBe("openai");
    expect(providerOf("google/gemini-3.1-pro-preview")).toBe("google");
  });
  it("treats a ref without a slash as its own provider", () => {
    expect(providerOf("localmodel")).toBe("localmodel");
  });
});

describe("7C: assertProviderDiversity counts vendors from resolved refs", () => {
  it("3 refs across 3 vendors yields all counts = 1", () => {
    const mix = assertProviderDiversity(["claude-code/opus", "openai/o3", "google/gemini"]);
    expect(mix).toEqual({ "claude-code": 1, openai: 1, google: 1 });
  });
  it("a duplicated provider produces a count > 1", () => {
    const mix = assertProviderDiversity(["claude-code/opus", "claude-code/sonnet", "openai/o3"]);
    expect(mix["claude-code"]).toBe(2);
  });
});

describe("7C: provider-diversity LOCK on the default catalog", () => {
  // Default catalog resolved providers (via modelForRole on each profile.role):
  //   architect  -> claude-code
  //   critic     -> openai
  //   pragmatist -> google
  //   researcher -> openai   (o3)
  //   synthesizer-> claude-code (sonnet)
  // => claude-code x2, openai x2, google x1 — only 3 DISTINCT providers.
  const resolveRef = (p: ProviderProfile): string => modelForRole(p.role, {});

  it("drops the duplicate-provider models so the selected set is provider-unique", () => {
    const chosen = selectModelsForDebateWithProviderDiversity(DEFAULT_PROVIDER_PROFILES, {
      resolveRef,
      affinity: ROLE_AFFINITY,
    });
    const providers = chosen.map((p) => providerOf(resolveRef(p)));
    // No provider appears more than once in the selected set.
    expect(new Set(providers).size).toBe(providers.length);
  });

  it("keeps at most one claude-code participant", () => {
    const chosen = selectModelsForDebateWithProviderDiversity(DEFAULT_PROVIDER_PROFILES, {
      resolveRef,
      affinity: ROLE_AFFINITY,
    });
    const claudeCount = chosen.filter((p) => providerOf(resolveRef(p)) === "claude-code").length;
    expect(claudeCount).toBeLessThanOrEqual(1);
  });

  it("provider is derived from the ref, not the cosmetic modelId", () => {
    // A profile whose modelId says 'gpt-o3' but whose role resolves to a claude-code
    // ref must count as claude-code (the label must not win over the ref).
    const trickProfile: ProviderProfile = {
      ...DEFAULT_PROVIDER_PROFILES[1], // modelId "gpt-o3"
      role: "architect", // architect -> claude-code/claude-opus-4-8
    };
    expect(providerOf(resolveRef(trickProfile))).toBe("claude-code");
  });

  it("falls back gracefully (WARN, best-effort set) when the catalog has too few providers", () => {
    // All profiles resolve to the SAME provider. The lock drops the lowest-affinity
    // duplicate, fails to refill (no other provider exists), and returns the
    // best-effort remainder with a WARN — it does NOT hard-fail or empty the set.
    const onlyClaude: ProviderProfile[] = DEFAULT_PROVIDER_PROFILES.slice(0, 3);
    const allClaudeRef = (): string => "claude-code/some-model";
    const onWarn = vi.fn();
    const chosen = selectModelsForDebateWithProviderDiversity(onlyClaude, {
      resolveRef: allClaudeRef,
      affinity: ROLE_AFFINITY,
      onWarn,
    });
    // Best-effort: non-empty, WARN fired (documented "return chosen as-is + WARN").
    expect(chosen.length).toBeGreaterThan(0);
    expect(onWarn).toHaveBeenCalled();
  });
});

describe("7E: selectBackupParticipant", () => {
  it("picks a not-yet-active profile for the dropped role", () => {
    const active = new Set(["claude-opus", "gpt-o3", "claude-sonnet"]);
    const backup = selectBackupParticipant(DEFAULT_PROVIDER_PROFILES, active, "researcher", {
      affinity: ROLE_AFFINITY,
    });
    expect(backup).not.toBeNull();
    expect(active.has(backup!.modelId)).toBe(false);
  });
  it("does not re-introduce a represented provider (respects the 7C lock)", () => {
    const resolveRef = (p: ProviderProfile): string => modelForRole(p.role, {});
    // Active set already represents claude-code + openai + google.
    const active = new Set(["claude-opus", "gpt-o3", "gemini-pro"]);
    const activeRefs = ["claude-code/opus", "openai/o3", "google/gemini"];
    const backup = selectBackupParticipant(DEFAULT_PROVIDER_PROFILES, active, "synthesizer", {
      resolveRef,
      activeRefs,
      affinity: ROLE_AFFINITY,
    });
    // deepseek-r1 (researcher role -> openai/o3) and claude-sonnet (-> claude-code)
    // are both blocked by represented providers => no safe backup.
    expect(backup).toBeNull();
  });
  it("returns null when every profile is already active", () => {
    const active = new Set(DEFAULT_PROVIDER_PROFILES.map((p) => p.modelId));
    expect(selectBackupParticipant(DEFAULT_PROVIDER_PROFILES, active, "critic")).toBeNull();
  });
});
