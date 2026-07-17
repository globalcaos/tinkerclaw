import { describe, it, expect } from "vitest";
import { classifyComplexity, buildEffortGuidance, resolveEffortBias } from "../effort-router.js";

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

describe("quota-headroom effort bias", () => {
  const PROMPT = "fix the login bug in src/auth/login.ts and add a regression test"; // baseline: standard

  it("neutral leaves the classification unchanged", () => {
    expect(classifyComplexity(PROMPT, "neutral").level).toBe("standard");
    expect(classifyComplexity(PROMPT).level).toBe("standard");
  });

  it("aggressive bumps a non-trivial turn up one gear", () => {
    expect(classifyComplexity(PROMPT, "aggressive").level).toBe("deep");
    const deep = classifyComplexity(
      "investigate and debug the failing auth flow, then refactor and optimize the session store module",
      "aggressive",
    );
    expect(deep.level).toBe("ultra");
  });

  it("conservative pulls a turn down a gear but never below standard", () => {
    const deep = classifyComplexity(
      "investigate and debug the failing auth flow, then refactor and optimize the session store module",
    );
    expect(deep.level).toBe("deep");
    expect(
      classifyComplexity(
        "investigate and debug the failing auth flow, then refactor and optimize the session store module",
        "conservative",
      ).level,
    ).toBe("standard");
    // standard floored at standard, not pushed to trivial
    expect(classifyComplexity(PROMPT, "conservative").level).toBe("standard");
  });

  it("never escalates a trivial ack, even when aggressive", () => {
    expect(classifyComplexity("thanks", "aggressive").level).toBe("trivial");
    expect(buildEffortGuidance("thanks", "aggressive")).toBeNull();
  });

  it("buildEffortGuidance surfaces the active bias in the block", () => {
    const g = buildEffortGuidance(PROMPT, "aggressive");
    expect(g).toContain('bias="aggressive"');
    expect(g).toContain('level="deep"');
    expect(g!.toUpperCase()).toContain("AGGRESSIVE");
  });

  it("resolveEffortBias reads the env, defaulting neutral", () => {
    const prev = process.env.PREFRONTAL_EFFORT_BIAS;
    delete process.env.PREFRONTAL_EFFORT_BIAS;
    expect(resolveEffortBias()).toBe("neutral");
    process.env.PREFRONTAL_EFFORT_BIAS = "aggressive";
    expect(resolveEffortBias()).toBe("aggressive");
    process.env.PREFRONTAL_EFFORT_BIAS = "garbage";
    expect(resolveEffortBias()).toBe("neutral");
    if (prev === undefined) delete process.env.PREFRONTAL_EFFORT_BIAS;
    else process.env.PREFRONTAL_EFFORT_BIAS = prev;
  });
});

describe('"Branch" layer — compound-prompt fan-out', () => {
  it("counts two independent asks in the owner's compound prompt", () => {
    const rec = classifyComplexity(
      "Update your model allocation code and dynamic workflows to spin multiple subagents when I ask for multiple things in the same prompt. Inform me of the name we should call it and its online presence.",
    );
    expect(rec.signals.independentAsks).toBeGreaterThanOrEqual(2);
  });

  it("does not count noun conjunctions or infinitives as extra asks", () => {
    // One ask, even though it says "code and workflows ... to spin subagents".
    const rec = classifyComplexity(
      "Update the allocation code and the dynamic workflows to spin subagents.",
    );
    expect(rec.signals.independentAsks).toBe(1);
  });

  it("counts two real imperatives joined by 'and'", () => {
    const rec = classifyComplexity("fix the login bug and write a regression test");
    expect(rec.signals.independentAsks).toBe(2);
  });

  it("a single-ask prompt does not get a branch_decompose block", () => {
    const g = buildEffortGuidance("refactor the session store module for clarity", "neutral");
    expect(g).not.toBeNull();
    expect(g).not.toContain("branch_decompose");
  });

  it("a multi-ask prompt injects branch_decompose fan-out guidance", () => {
    const g = buildEffortGuidance(
      "Update the allocation code to fan out subagents. Also publish a post explaining it.",
      "neutral",
    );
    expect(g).toContain("branch_decompose");
    expect(g).toContain("one subagent per ask");
  });
});
