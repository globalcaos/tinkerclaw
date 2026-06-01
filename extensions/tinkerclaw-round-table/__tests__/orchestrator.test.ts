/**
 * 7G: Swappable orchestrator tests.
 *
 * The DebateOrchestrator contract lets any choreography drive the same callModel
 * fabric. RAAC stays the default and raacOrchestrator.runDebate must equal the bare
 * runDebate (don't-regress guard). getOrchestrator resolves RAAC + builtin
 * architectures + an external loader, returning null on a miss so the caller falls
 * back to raac.
 */

import { describe, it, expect, vi } from "vitest";
import { DEFAULT_PROVIDER_PROFILES, type ProviderProfile } from "../src/cognitive-diversity.js";
import {
  raacOrchestrator,
  getOrchestrator,
  setExternalOrchestratorLoader,
  BUILTIN_ARCHITECTURE_ORCHESTRATORS,
  type DebateOrchestrator,
} from "../src/orchestrator-api.js";
import {
  runDebate,
  DEFAULT_DEBATE_CONFIG,
  type DebateConfig,
  type DebateParticipant,
} from "../src/raac-protocol.js";

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
    propose: async (task, r) => `[${modelId}/${r}] proposal: ${task.slice(0, 30)}`,
    challenge: async () => `[${modelId}] challenge`,
    defend: async () => `[${modelId}] defense`,
    synthesize: async () => "the synthesis",
    ratify: async () => "accept" as const,
  };
}

const CONFIG: DebateConfig = { ...DEFAULT_DEBATE_CONFIG, maxRounds: 1, convergenceThreshold: 0.5 };

describe("7G: raacOrchestrator.runDebate equals the bare runDebate", () => {
  it("produces the same result shape as calling runDebate directly", async () => {
    const participants = [
      createMockParticipant("claude-opus", "architect"),
      createMockParticipant("claude-sonnet", "synthesizer"),
    ];

    const direct = await runDebate("Task X", participants, CONFIG);
    const viaOrch = await raacOrchestrator.runDebate("Task X", participants, CONFIG);

    expect(viaOrch.task).toBe(direct.task);
    expect(viaOrch.finalSynthesis).toBe(direct.finalSynthesis);
    expect(viaOrch.rounds.length).toBe(direct.rounds.length);
    expect(viaOrch.converged).toBe(direct.converged);
  });

  it("raacOrchestrator.runDebate IS the runDebate reference (no wrapper indirection)", () => {
    expect(raacOrchestrator.runDebate).toBe(runDebate);
    expect(raacOrchestrator.id).toBe("raac");
  });
});

describe("7G: getOrchestrator resolution", () => {
  it("getOrchestrator('raac') returns the RAAC default", async () => {
    const orch = await getOrchestrator("raac");
    expect(orch).toBe(raacOrchestrator);
    expect(orch?.id).toBe("raac");
  });

  it("getOrchestrator resolves the builtin architecture orchestrators", async () => {
    const fanOut = await getOrchestrator("fan-out");
    expect(fanOut).toBe(BUILTIN_ARCHITECTURE_ORCHESTRATORS["fan-out"]);
    expect(fanOut?.id).toBe("fan-out");
  });

  it("getOrchestrator(unknown) returns null when no external loader is set", async () => {
    setExternalOrchestratorLoader(null);
    expect(await getOrchestrator("does-not-exist")).toBeNull();
  });

  it("getOrchestrator consults the external loader for an unknown id", async () => {
    const external: DebateOrchestrator = {
      id: "ag2",
      name: "AG2 external",
      runDebate: vi.fn().mockResolvedValue({
        task: "t",
        rounds: [],
        finalSynthesis: "ext",
        totalCosts: [],
        totalEstimatedCost: 0,
        converged: true,
        convergenceRound: 1,
      }),
    };
    const loader = vi.fn().mockResolvedValue(external);
    setExternalOrchestratorLoader(loader);

    const resolved = await getOrchestrator("ag2");
    expect(resolved).toBe(external);
    expect(loader).toHaveBeenCalledWith("ag2");

    setExternalOrchestratorLoader(null); // reset shared module state
  });

  it("getOrchestrator returns null (does not throw) when the external loader throws", async () => {
    setExternalOrchestratorLoader(async () => {
      throw new Error("rpc down");
    });
    expect(await getOrchestrator("ag2")).toBeNull();
    setExternalOrchestratorLoader(null);
  });
});

describe("7G: a builtin architecture orchestrator drives the callModel fabric", () => {
  it("fan-out orchestrator produces a DebateResult-shaped output via the participants", async () => {
    const proposeSpy = vi.fn().mockResolvedValue("fan proposal");
    const participants: DebateParticipant[] = [
      { ...createMockParticipant("a", "architect"), propose: proposeSpy },
      createMockParticipant("b", "synthesizer"),
    ];
    const orch = await getOrchestrator("fan-out");
    const result = await orch!.runDebate("Decide X", participants, CONFIG);

    expect(proposeSpy).toHaveBeenCalled(); // it actually drove the participants
    expect(result.finalSynthesis).toBe("the synthesis");
    expect(result.rounds).toHaveLength(1);
    expect(result.task).toBe("Decide X");
  });
});
