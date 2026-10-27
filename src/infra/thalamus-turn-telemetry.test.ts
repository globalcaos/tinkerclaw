import { afterEach, describe, expect, it, vi } from "vitest";

const emitted: unknown[] = [];
vi.mock("./agent-events.js", () => ({
  emitAgentEvent: (e: unknown) => emitted.push(e),
}));

const {
  buildThalamusTurnDecision,
  emitThalamusTurnDecision,
  emitThalamusTurnFallback,
  thalamusTurnTier,
} = await import("./thalamus-turn-telemetry.js");

afterEach(() => {
  emitted.length = 0;
});

const base = {
  routedKey: "claude-code/claude-sonnet-5-5",
  effort: "high",
  biasIdx: 3,
  domain: "general",
};

describe("buildThalamusTurnDecision", () => {
  it("a plain frontier pick says bias and nothing else", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      routeRung: { key: base.routedKey, effort: "high" },
      biasRung: { key: base.routedKey, effort: "high" },
    });
    expect(d.why).toEqual(["bias"]);
    expect(d.instead).toBeUndefined();
    expect(d.tier).toBe("default");
    expect(d.declined).toEqual([]);
  });

  it("a domain specialist replacing the dial's pick is best-of, and names the pick it replaced", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      domain: "code",
      routeRung: { key: "openai-codex/gpt-6.1-sol", effort: "high" },
      routedKey: "openai-codex/gpt-6.1-sol",
      biasRung: { key: "claude-code/claude-sonnet-5-5", effort: "medium" },
    });
    expect(d.why).toEqual(["best-of"]);
    expect(d.instead).toEqual({ model: "claude-code/claude-sonnet-5-5", effort: "medium" });
    expect(d.domain).toBe("code");
  });

  it("a kept suggestion says kept, names the model and effort, and replaces nothing", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      routedKey: "claude-code/claude-opus-5-5",
      suggestion: { state: "kept", key: "claude-code/claude-opus-5-5", effort: "max" },
      routeRung: { key: "claude-code/claude-opus-5-5", effort: "max" },
      biasRung: { key: "xai/grok-4.7", effort: "" },
    });
    expect(d.why).toEqual(["kept"]);
    expect(d.instead).toBeUndefined();
    expect(d.suggestion).toEqual({
      state: "kept",
      model: "claude-code/claude-opus-5-5",
      effort: "max",
    });
  });

  it("a suggestion moved for a better rung says moved, with the lead, and names what it replaced", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      domain: "science",
      routedKey: "claude-code/claude-fable-5",
      suggestion: {
        state: "moved",
        key: "claude-code/claude-opus-5-5",
        effort: "max",
        cause: "better",
        to: { key: "claude-code/claude-fable-5", effort: "max" },
        gainPct: 14,
      },
    });
    expect(d.why).toEqual(["moved"]);
    expect(d.instead).toEqual({ model: "claude-code/claude-opus-5-5", effort: "max" });
    expect(d.suggestion).toMatchObject({ state: "moved", cause: "better", gainPct: 14 });
    expect(d.cooling).toBeUndefined();
  });

  it("a suggestion whose supply is cooling says cooling and when it reopens", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      routedKey: "xai/grok-4.7",
      suggestion: {
        state: "moved",
        key: "claude-code/claude-opus-5-5",
        effort: "max",
        cause: "cooling",
        to: { key: "xai/grok-4.7", effort: "" },
        untilMs: 1_790_000_000_000,
      },
    });
    expect(d.why).toEqual(["cooling"]);
    expect(d.cooling).toEqual({
      from: { model: "claude-code/claude-opus-5-5", effort: "max" },
      supply: "anthropic",
      untilMs: 1_790_000_000_000,
    });
  });

  it("with no suggestion, a cooling supply that changed the pick is still cooling", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      routedKey: "xai/grok-4.7",
      coolingShift: {
        from: { key: "claude-code/claude-opus-5", effort: "max" },
        supply: "anthropic",
        untilMs: 5,
      },
    });
    expect(d.why).toEqual(["cooling"]);
    expect(d.instead).toEqual({ model: "claude-code/claude-opus-5", effort: "max" });
    expect(d.suggestion).toBeUndefined();
  });

  it("an ignored suggestion (model not on the board) leaves the card as if the stop were unset", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      suggestion: { state: "ignored", key: "nobody/model", reason: "not-on-board" },
    });
    expect(d.why).toEqual(["bias"]);
    expect(d.suggestion).toBeUndefined();
  });

  it("an engagement veto is censorship, one row per family however many rungs it had", () => {
    const d = buildThalamusTurnDecision({
      ...base,
      subject: "medical",
      routeRung: { key: "xai/grok-4.7" },
      biasRung: { key: "xai/grok-4.7" },
      routedKey: "xai/grok-4.7",
      vetoes: [
        {
          key: "claude-code/claude-opus-5@high",
          veto: "engagement",
          detail: "claude declined medical work 3× in the last 30 days",
        },
        {
          key: "claude-code/claude-opus-5@max",
          veto: "engagement",
          detail: "claude declined medical work 3× in the last 30 days",
        },
        {
          key: "openrouter/x",
          veto: "supply-unfunded",
          detail: "openrouter has no funded balance",
        },
      ],
    });
    expect(d.why).toEqual(["bias", "censorship"]);
    expect(d.declined).toEqual([
      {
        model: "claude-code/claude-opus-5@high",
        detail: "claude declined medical work 3× in the last 30 days",
      },
    ]);
    expect(d.subject).toBe("medical");
  });

  it("bands the dial exactly like the router's tier defaults", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(thalamusTurnTier)).toEqual([
      "budget",
      "budget",
      "budget",
      "default",
      "smart",
      "smart",
      "smart",
    ]);
  });
});

describe("emitters", () => {
  it("publishes the decision on the thalamus stream, keyed by the session", () => {
    emitThalamusTurnDecision("agent:main:tinker:abc", buildThalamusTurnDecision({ ...base }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      runId: "thalamus:agent:main:tinker:abc",
      sessionKey: "agent:main:tinker:abc",
      stream: "thalamus",
      data: { phase: "decision", model: base.routedKey },
    });
  });

  it("says nothing without a session or without both ends of a fallback", () => {
    emitThalamusTurnDecision(undefined, buildThalamusTurnDecision({ ...base }));
    emitThalamusTurnFallback("run-1", { from: "a/b", to: "", reason: "timeout" });
    emitThalamusTurnFallback(undefined, { from: "a/b", to: "c/d", reason: "timeout" });
    expect(emitted).toHaveLength(0);
  });

  it("publishes a fallback under the run's id", () => {
    emitThalamusTurnFallback("run-1", {
      from: "claude-code/claude-opus-5",
      to: "xai/grok-4.7",
      reason: "overloaded",
    });
    expect(emitted[0]).toMatchObject({
      runId: "run-1",
      stream: "thalamus",
      data: {
        phase: "fallback",
        from: "claude-code/claude-opus-5",
        to: "xai/grok-4.7",
        reason: "overloaded",
      },
    });
  });
});
