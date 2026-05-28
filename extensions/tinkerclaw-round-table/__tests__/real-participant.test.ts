import { describe, it, expect, vi } from "vitest";
import { DEFAULT_PROVIDER_PROFILES } from "../src/cognitive-diversity.js";
import {
  buildPhasePrompt,
  createRealParticipant,
  modelForRole,
  normalizeVote,
} from "../src/real-participant.js";

describe("modelForRole — cross-provider mapping (F2)", () => {
  it("maps each profile role to its concrete configured cross-provider ref", () => {
    expect(modelForRole("architect")).toBe("claude-code/claude-opus-4-8");
    expect(modelForRole("critic")).toBe("openai/gpt-5.3-codex");
    expect(modelForRole("pragmatist")).toBe("google/gemini-3.1-pro-preview");
    expect(modelForRole("researcher")).toBe("openai/o3");
    expect(modelForRole("synthesizer")).toBe("claude-code/claude-sonnet-4-6");
  });
  it("spans three distinct vendors (genuine cognitive diversity, not Claude-only)", () => {
    const vendors = new Set(
      ["architect", "critic", "pragmatist", "researcher", "synthesizer"].map(
        (r) => modelForRole(r).split("/")[0],
      ),
    );
    expect(vendors.has("claude-code")).toBe(true);
    expect(vendors.has("openai")).toBe(true);
    expect(vendors.has("google")).toBe(true);
    expect(vendors.size).toBe(3);
  });
  it("falls back to the synthesizer ref for an unknown role", () => {
    expect(modelForRole("nonsense")).toBe("claude-code/claude-sonnet-4-6");
  });
});

describe("buildPhasePrompt", () => {
  it("frames a propose prompt with the role, task, and strengths", () => {
    const p = DEFAULT_PROVIDER_PROFILES[0]; // architect, strengths ["reasoning","nuance","safety"]
    const prompt = buildPhasePrompt("propose", p, {
      task: "Should we add a result cache?",
      role: "architect",
    });
    expect(prompt).toContain("architect");
    expect(prompt).toContain("Should we add a result cache?");
    expect(prompt).toContain("reasoning"); // a strength of the architect profile (:139)
    expect(prompt).toContain("PROPOSE");
  });
  it("includes prior synthesis when supplied to propose", () => {
    const p = DEFAULT_PROVIDER_PROFILES[0];
    const prompt = buildPhasePrompt("propose", p, {
      task: "X",
      role: "architect",
      priorSynthesis: "prior consensus text",
    });
    expect(prompt).toContain("prior consensus text");
  });
  it("frames a ratify prompt asking for a single-word verdict", () => {
    const p = DEFAULT_PROVIDER_PROFILES[1];
    const prompt = buildPhasePrompt("ratify", p, { synthesis: "the synthesis", role: "critic" });
    expect(prompt).toMatch(/accept.*reject.*amend/is);
  });
});

describe("normalizeVote", () => {
  it("returns the first explicit keyword", () => {
    expect(normalizeVote("I would REJECT this because ...")).toBe("reject");
    expect(normalizeVote("AMEND: tweak step 2")).toBe("amend");
  });
  it("defaults to accept when ambiguous (consensus-biased, matches prior simulated behavior)", () => {
    expect(normalizeVote("hmm, interesting")).toBe("accept");
  });
});

describe("createRealParticipant", () => {
  it("propose calls the injected model with the cross-provider ref and built prompt", async () => {
    const callModel = vi.fn().mockResolvedValue("opus says: cache it");
    const part = createRealParticipant(DEFAULT_PROVIDER_PROFILES[0], { callModel }); // architect
    const out = await part.propose("task X", "architect");
    expect(callModel).toHaveBeenCalledTimes(1);
    const [{ model, prompt }] = callModel.mock.calls[0];
    expect(model).toBe("claude-code/claude-opus-4-8"); // architect → opus-4-8 (F2)
    expect(prompt).toContain("task X");
    expect(out).toBe("opus says: cache it");
  });
  it("critic participant routes to the OpenAI ref (cross-provider, not Claude)", async () => {
    const callModel = vi.fn().mockResolvedValue("gpt critique");
    const part = createRealParticipant(DEFAULT_PROVIDER_PROFILES[1], { callModel }); // critic
    await part.challenge("a proposal", "critic");
    expect(callModel.mock.calls[0][0].model).toBe("openai/gpt-5.3-codex");
  });
  it("ratify normalizes free-form model output to a vote enum", async () => {
    const callModel = vi.fn().mockResolvedValue("I would REJECT this because ...");
    const part = createRealParticipant(DEFAULT_PROVIDER_PROFILES[1], { callModel });
    expect(await part.ratify("syn")).toBe("reject");
  });
  it("ratify defaults to accept when output is ambiguous", async () => {
    const callModel = vi.fn().mockResolvedValue("hmm, interesting");
    const part = createRealParticipant(DEFAULT_PROVIDER_PROFILES[1], { callModel });
    expect(await part.ratify("syn")).toBe("accept");
  });
});
