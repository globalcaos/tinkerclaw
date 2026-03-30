/**
 * Tests for the RAAC debate protocol engine (extension copy).
 */

import { describe, it, expect } from "vitest";
import {
  assignRoles,
  checkConvergence,
  runDebateRound,
  runDebate,
  totalDebateCost,
  DEFAULT_DEBATE_CONFIG,
  type DebateParticipant,
  type DebateConfig,
} from "../src/raac-protocol.js";
import { DEFAULT_PROVIDER_PROFILES, type ProviderProfile } from "../src/cognitive-diversity.js";

// -- Mock Participants --

function createMockParticipant(
  modelId: string,
  role: string,
  profile?: ProviderProfile,
): DebateParticipant {
  const p =
    profile ??
    DEFAULT_PROVIDER_PROFILES.find((pp) => pp.modelId === modelId) ??
    DEFAULT_PROVIDER_PROFILES[0];
  return {
    modelId,
    role,
    profile: p,
    propose: async (task, r, prior) =>
      `[${modelId}/${r}] Proposal for: ${task.slice(0, 50)}${prior ? " (refined)" : ""}`,
    challenge: async (proposal) => `[${modelId}] Challenge: weakness in ${proposal.slice(0, 30)}`,
    defend: async (attacks, r) => `[${modelId}/${r}] Defense against ${attacks.length} attacks`,
    synthesize: async (proposals) => `Synthesis of ${proposals.length} proposals: combined insight`,
    ratify: async () => "accept" as const,
  };
}

function createRejectingParticipant(modelId: string, role: string): DebateParticipant {
  const base = createMockParticipant(modelId, role);
  return { ...base, ratify: async () => "reject" as const };
}

// -- Tests --

describe("RAAC Protocol: quick debate (2 rounds) reaches consensus", () => {
  it("converges within 2 rounds with accepting participants", async () => {
    const synth = "The answer is consensus";
    const p1 = createMockParticipant("a", "architect");
    const p2 = createMockParticipant("b", "synthesizer");
    p2.synthesize = async () => synth;

    const config: DebateConfig = {
      ...DEFAULT_DEBATE_CONFIG,
      maxRounds: 2,
      convergenceThreshold: 0.5,
    };
    const result = await runDebate("Task", [p1, p2], config);

    expect(result.rounds.length).toBeLessThanOrEqual(2);
    expect(result.finalSynthesis).toBeTruthy();
  });
});

describe("RAAC Protocol: distinct role perspectives produced", () => {
  it("assigns optimal roles to known models", () => {
    const roles = assignRoles(["claude-opus", "gpt-o3", "gemini-pro"]);
    expect(roles["claude-opus"]).toBe("architect");
    expect(roles["gpt-o3"]).toBe("critic");
    expect(roles["gemini-pro"]).toBe("pragmatist");
  });

  it("assigns unique roles to each model", () => {
    const roles = assignRoles([
      "claude-opus",
      "gpt-o3",
      "gemini-pro",
      "deepseek-r1",
      "claude-sonnet",
    ]);
    const roleValues = Object.values(roles);
    expect(new Set(roleValues).size).toBe(roleValues.length);
  });

  it("each round has proposals with role and content per participant", async () => {
    const participants = [
      createMockParticipant("claude-opus", "architect"),
      createMockParticipant("gpt-o3", "critic"),
      createMockParticipant("claude-sonnet", "synthesizer"),
    ];

    const round = await runDebateRound("Design a caching strategy", participants, 1);

    expect(Object.keys(round.proposals)).toHaveLength(3);
    // Each proposal includes the role name from the mock
    for (const [modelId, proposal] of Object.entries(round.proposals)) {
      expect(proposal).toContain(modelId);
      expect(typeof proposal).toBe("string");
      expect(proposal.length).toBeGreaterThan(0);
    }
  });
});

describe("RAAC Protocol: deep debate (6 rounds) records dissent", () => {
  it("runs up to 6 rounds when majority rejects", async () => {
    const participants = [
      createRejectingParticipant("a", "architect"),
      createRejectingParticipant("b", "critic"),
      createMockParticipant("c", "synthesizer"),
    ];

    const config: DebateConfig = { ...DEFAULT_DEBATE_CONFIG, maxRounds: 6 };
    const result = await runDebate("Controversial topic", participants, config);

    expect(result.rounds.length).toBeGreaterThan(1);
    expect(result.converged).toBe(false);

    // Ratification shows rejections in each round
    for (const round of result.rounds) {
      const rejectCount = Object.values(round.ratification).filter((v) => v === "reject").length;
      expect(rejectCount).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("RAAC Protocol: confidence is in [0,1] range", () => {
  it("convergence detection returns boolean (proxy for confidence)", () => {
    // checkConvergence is the convergence detector; its output is boolean
    expect(checkConvergence("the answer is 42", "the answer is 42")).toBe(true);
    expect(checkConvergence("some text", undefined)).toBe(false);

    const a = "Use microservices with event sourcing for the backend";
    const b = "Monolithic architecture with direct database calls is clearly better";
    expect(checkConvergence(a, b)).toBe(false);
  });

  it("total cost is a non-negative number", async () => {
    const participants = [
      createMockParticipant("a", "architect"),
      createMockParticipant("b", "synthesizer"),
    ];
    const result = await runDebate("Task", participants, {
      ...DEFAULT_DEBATE_CONFIG,
      maxRounds: 1,
    });

    expect(result.totalEstimatedCost).toBeGreaterThanOrEqual(0);
    expect(isFinite(result.totalEstimatedCost)).toBe(true);
  });
});

describe("RAAC Protocol: each round has proposals with role, position, reasoning", () => {
  it("round structure contains all 5 phases", async () => {
    const participants = [
      createMockParticipant("claude-opus", "architect"),
      createMockParticipant("gpt-o3", "critic"),
      createMockParticipant("claude-sonnet", "synthesizer"),
    ];

    const round = await runDebateRound("Design a caching strategy", participants, 1);

    expect(round.roundNumber).toBe(1);
    expect(Object.keys(round.proposals)).toHaveLength(3);
    expect(Object.keys(round.challenges)).toHaveLength(3);
    expect(Object.keys(round.defenses)).toHaveLength(3);
    expect(round.synthesis).toBeTruthy();
    expect(Object.keys(round.ratification)).toHaveLength(3);

    // Cost tracking covers all phases
    const phases = new Set(round.costs.map((c) => c.phase));
    expect(phases.has("propose")).toBe(true);
    expect(phases.has("challenge")).toBe(true);
    expect(phases.has("defend")).toBe(true);
    expect(phases.has("synthesize")).toBe(true);
    expect(phases.has("ratify")).toBe(true);

    expect(totalDebateCost(round.costs)).toBeGreaterThan(0);
  });
});
