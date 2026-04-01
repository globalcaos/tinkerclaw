import { describe, it, expect } from "vitest";
import { resolveFeatureFlags, isEnabled, DEFAULT_FEATURE_FLAGS } from "../feature-flags.js";

describe("resolveFeatureFlags", () => {
  it("returns all defaults when no overrides", () => {
    const flags = resolveFeatureFlags();
    expect(flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it("overrides specific flags", () => {
    const flags = resolveFeatureFlags({ explorationGate: false });
    expect(flags.explorationGate).toBe(false);
    expect(flags.antiGoldplating).toBe(true);
  });

  it("handles empty object", () => {
    expect(resolveFeatureFlags({})).toEqual(DEFAULT_FEATURE_FLAGS);
  });
});

describe("isEnabled", () => {
  it("returns true for enabled features", () => {
    expect(isEnabled(DEFAULT_FEATURE_FLAGS, "explorationGate")).toBe(true);
  });

  it("returns false for disabled features", () => {
    const flags = resolveFeatureFlags({ corfTrigger: false });
    expect(isEnabled(flags, "corfTrigger")).toBe(false);
  });
});
