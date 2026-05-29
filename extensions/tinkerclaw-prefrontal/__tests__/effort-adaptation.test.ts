import { describe, it, expect } from "vitest";
import { classifyComplexity, buildEffortGuidance } from "../effort-router.js";

describe("classifyComplexity — dynamic effort tiers", () => {
  it("trivial: short conversational turns", () => {
    expect(classifyComplexity("hi").level).toBe("trivial");
    expect(classifyComplexity("thanks").level).toBe("trivial");
    expect(classifyComplexity("ok got it").level).toBe("trivial");
  });

  it("standard: a focused single-file change", () => {
    const rec = classifyComplexity(
      "fix the login bug in src/auth/login.ts and add a regression test",
    );
    expect(rec.level).toBe("standard");
  });

  it("deep: multiple hard verbs + clauses", () => {
    const rec = classifyComplexity(
      "investigate and debug the failing auth flow, then refactor and optimize the session store module",
    );
    expect(rec.level).toBe("deep");
    expect(rec.orchestration).toBe("parallel");
    expect(rec.modelTier).toBe("maximum");
  });

  it("ultra: comprehensive / exhaustive breadth signals", () => {
    const rec = classifyComplexity(
      "build everything comprehensively and be thorough and exhaustive, end-to-end across the entire codebase",
    );
    expect(rec.level).toBe("ultra");
    expect(rec.orchestration).toBe("workflow");
  });

  it("ultracode keyword forces ultra", () => {
    expect(classifyComplexity("ultracode: audit the whole thing comprehensively").level).toBe(
      "ultra",
    );
  });
});

describe("buildEffortGuidance", () => {
  it("returns null for trivial turns (no injection, stays cheap)", () => {
    expect(buildEffortGuidance("hi")).toBeNull();
    expect(buildEffortGuidance("thanks")).toBeNull();
  });

  it("emits a level-tagged block for non-trivial turns", () => {
    const g = buildEffortGuidance(
      "investigate and debug the failing auth flow, then refactor and optimize the session store module",
    );
    expect(g).not.toBeNull();
    expect(g).toContain("effort_adaptation");
    expect(g).toContain('level="deep"');
  });

  it("ultra guidance tells Jarvis to orchestrate + verify", () => {
    const g = buildEffortGuidance(
      "build everything comprehensively and be thorough and exhaustive, end-to-end across the entire codebase",
    );
    expect(g).toContain('level="ultra"');
    expect(g!.toLowerCase()).toContain("workflow");
  });
});
