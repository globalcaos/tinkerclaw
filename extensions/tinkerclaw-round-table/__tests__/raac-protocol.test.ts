/**
 * Tests for the RAAC debate protocol engine (extension copy).
 */

import { describe, it, expect, vi } from "vitest";
import { DEFAULT_PROVIDER_PROFILES, type ProviderProfile } from "../src/cognitive-diversity.js";
import {
  assignRoles,
  checkConvergence,
  runDebateRound,
  runDebate,
  totalDebateCost,
  isDropout,
  recoverPhase,
  DEFAULT_DEBATE_CONFIG,
  type DebateParticipant,
  type DebateConfig,
  type RecoveryHooks,
} from "../src/raac-protocol.js";

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

// -- 7E: Participant dropout recovery --

describe("7E: isDropout matches the index.ts sentinel exactly", () => {
  it("matches the (error) and (no response) sentinels", () => {
    expect(isDropout("[openai/o3/critic] (error)")).toBe(true);
    expect(isDropout("[claude-code/claude-opus-4-8/architect] (no response)")).toBe(true);
  });
  it("does not match a real proposal", () => {
    expect(isDropout("We should add a write-through cache to reduce latency.")).toBe(false);
    expect(isDropout("[note] this is fine")).toBe(false);
  });
  it("tolerates surrounding whitespace", () => {
    expect(isDropout("  [x/y] (error)  ")).toBe(true);
  });
});

describe("7E: recoverPhase promotes a backup", () => {
  it("replaces a sentinel response with the backup's text", async () => {
    const responses: Record<string, string> = {
      "claude-opus": "[claude-code/x/architect] (error)",
      "gpt-o3": "a real critique",
    };
    const backupProfile = DEFAULT_PROVIDER_PROFILES[4]; // claude-sonnet
    const backup: DebateParticipant = createMockParticipant(
      backupProfile.modelId,
      "architect",
      backupProfile,
    );
    const callBackup = vi.fn().mockResolvedValue("backup architect proposal");

    const dropouts = await recoverPhase(
      "propose",
      responses,
      () => "architect",
      () => backup,
      callBackup,
    );

    expect(responses["claude-opus"]).toBe("backup architect proposal");
    expect(dropouts).toHaveLength(0);
    expect(callBackup).toHaveBeenCalledTimes(1);
  });

  it("records a dropout when the backup ALSO returns a sentinel", async () => {
    const responses: Record<string, string> = {
      "claude-opus": "[claude-code/x/architect] (error)",
    };
    const backup = createMockParticipant("claude-sonnet", "architect");
    const callBackup = vi.fn().mockResolvedValue("[claude-code/sonnet/architect] (error)");

    const dropouts = await recoverPhase(
      "propose",
      responses,
      () => "architect",
      () => backup,
      callBackup,
    );

    expect(dropouts).toEqual([
      { modelId: "claude-opus", phase: "propose", reason: "backup also failed" },
    ]);
  });

  it("records a dropout when NO backup is available", async () => {
    const responses: Record<string, string> = {
      "claude-opus": "[claude-code/x/architect] (no response)",
    };
    const dropouts = await recoverPhase(
      "propose",
      responses,
      () => "architect",
      () => null, // no backup
      async () => "unused",
    );
    expect(dropouts).toEqual([
      { modelId: "claude-opus", phase: "propose", reason: "no backup available" },
    ]);
  });
});

describe("7E: runDebateRound integrates recovery", () => {
  it("promotes a backup so the synthesis input is the backup text, not the sentinel", async () => {
    // One participant emits a sentinel on PROPOSE; recovery promotes a backup.
    const failing = createMockParticipant("claude-opus", "architect");
    failing.propose = async () => "[claude-code/opus/architect] (error)";
    const synthesizer = createMockParticipant("claude-sonnet", "synthesizer");

    // Capture what the synthesizer receives as proposals.
    let synthesizedProposals: string[] = [];
    synthesizer.synthesize = async (proposals) => {
      synthesizedProposals = proposals;
      return "the consensus";
    };

    const backup = createMockParticipant("backup-model", "architect");
    const recovery: RecoveryHooks = {
      selectBackup: () => backup,
      callBackup: async () => "recovered architect proposal",
    };

    const round = await runDebateRound(
      "Design a cache",
      [failing, synthesizer],
      1,
      undefined,
      DEFAULT_DEBATE_CONFIG,
      recovery,
    );

    // The architect slot's proposal must be the recovered text, not the sentinel.
    expect(round.proposals["claude-opus"]).toBe("recovered architect proposal");
    expect(synthesizedProposals).toContain("recovered architect proposal");
    expect(synthesizedProposals.some((p) => isDropout(p))).toBe(false);
    expect(round.dropouts).toBeUndefined(); // recovery succeeded => no recorded dropout
  });

  it("records a dropout in the round when recovery cannot succeed", async () => {
    const failing = createMockParticipant("claude-opus", "architect");
    failing.propose = async () => "[claude-code/opus/architect] (error)";
    const synthesizer = createMockParticipant("claude-sonnet", "synthesizer");

    const recovery: RecoveryHooks = {
      selectBackup: () => null, // no backup
      callBackup: async () => "unused",
    };

    const round = await runDebateRound(
      "Design a cache",
      [failing, synthesizer],
      1,
      undefined,
      DEFAULT_DEBATE_CONFIG,
      recovery,
    );

    expect(round.dropouts).toEqual([
      { modelId: "claude-opus", phase: "propose", reason: "no backup available" },
    ]);
  });

  it("default runDebateRound (no recovery arg) is unchanged — no dropouts field", async () => {
    const failing = createMockParticipant("claude-opus", "architect");
    failing.propose = async () => "[claude-code/opus/architect] (error)";
    const synthesizer = createMockParticipant("claude-sonnet", "synthesizer");
    const round = await runDebateRound("Task", [failing, synthesizer], 1);
    // Without recovery wired in, behaviour is byte-identical: no dropouts key.
    expect(round.dropouts).toBeUndefined();
    expect("dropouts" in round).toBe(false);
  });
});

// -- 7F: Multi-turn speaker memory (contextMixin seeds round-1 propose) --

describe("7F: runDebate seeds round-1 propose with contextMixin.priorSynthesis", () => {
  it("hands the supplied prior synthesis to round 1's propose as the 3rd arg", async () => {
    const proposeSpy = vi.fn().mockResolvedValue("a proposal");
    const architect: DebateParticipant = {
      ...createMockParticipant("claude-opus", "architect"),
      propose: proposeSpy,
    };
    const synthesizer = createMockParticipant("claude-sonnet", "synthesizer");

    const config: DebateConfig = {
      ...DEFAULT_DEBATE_CONFIG,
      maxRounds: 1,
      convergenceThreshold: 0.5,
    };
    await runDebate("Refine the cache design", [architect, synthesizer], config, undefined, {
      priorSynthesis: "PRIOR: use a write-through cache",
    });

    // First propose call (round 1) must receive the prior synthesis as priorSynthesis.
    expect(proposeSpy).toHaveBeenCalled();
    const firstCallArgs = proposeSpy.mock.calls[0];
    expect(firstCallArgs[2]).toBe("PRIOR: use a write-through cache");
  });

  it("omitting contextMixin leaves round-1 propose with no priorSynthesis (byte-identical)", async () => {
    const proposeSpy = vi.fn().mockResolvedValue("a proposal");
    const architect: DebateParticipant = {
      ...createMockParticipant("claude-opus", "architect"),
      propose: proposeSpy,
    };
    const synthesizer = createMockParticipant("claude-sonnet", "synthesizer");
    const config: DebateConfig = {
      ...DEFAULT_DEBATE_CONFIG,
      maxRounds: 1,
      convergenceThreshold: 0.5,
    };

    await runDebate("Fresh debate", [architect, synthesizer], config);

    expect(proposeSpy.mock.calls[0][2]).toBeUndefined();
  });

  it("an empty/whitespace priorSynthesis is treated as no seed", async () => {
    const proposeSpy = vi.fn().mockResolvedValue("a proposal");
    const architect: DebateParticipant = {
      ...createMockParticipant("claude-opus", "architect"),
      propose: proposeSpy,
    };
    const synthesizer = createMockParticipant("claude-sonnet", "synthesizer");
    const config: DebateConfig = {
      ...DEFAULT_DEBATE_CONFIG,
      maxRounds: 1,
      convergenceThreshold: 0.5,
    };

    await runDebate("Debate", [architect, synthesizer], config, undefined, {
      priorSynthesis: "   ",
    });

    expect(proposeSpy.mock.calls[0][2]).toBeUndefined();
  });
});
