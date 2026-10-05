// THE THALAMUS CHAIN REACHES THE RUNTIME — or it does not, and a 429 ends the turn.
//
// `src/agents/model-fallback.ts` has held a complete failover machinery all along
// (`runWithModelFallback`, `resolveFallbackCandidates`, auth-profile rotation,
// `FallbackSummaryError`). What it lacked was an INPUT: `agents.defaults.model.fallbacks` is `[]`
// in the live config, so every turn handed that machinery an empty ladder. These tests pin the
// precedence rules that let THALAMUS's per-turn chain fill that vacuum WITHOUT ever overruling a
// human or the config, and — the half that actually catches regressions — that an absent or empty
// chain leaves every branch returning exactly what it returns today.

import { describe, expect, it } from "vitest";
import { resolveEffectiveModelFallbacks } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

/** The ordered ladder the router publishes: one rung per OTHER supply, already normalized. */
const CHAIN = ["xai/grok-4.6", "openai-codex/gpt-5.6", "google/gemini-3-pro"] as const;

/** No agent list and no default fallbacks — the live config's shape, and the bug's home. */
const EMPTY_LADDER_CFG: OpenClawConfig = {
  agents: { defaults: { model: { fallbacks: [] } } },
};

/**
 * The chain rides the run. Typed as an explicit intersection rather than relying on
 * `FollowupRun["run"]` alone so this file still states the contract it depends on, out loud,
 * instead of inheriting it silently from a type someone else may narrow.
 */
type RunOverrides = Partial<FollowupRun["run"]> & { thalamusChain?: readonly string[] };

function makeRun(overrides: RunOverrides = {}): FollowupRun["run"] {
  return {
    agentId: "agent-1",
    config: EMPTY_LADDER_CFG,
    provider: "claude-code",
    model: "claude-opus-5",
    agentDir: "/tmp/agent",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 60_000,
    ...overrides,
  } as unknown as FollowupRun["run"];
}

describe("THALAMUS chain -> fallbacksOverride", () => {
  it("a non-empty chain arrives as fallbacksOverride, in the router's order", () => {
    const resolved = resolveModelFallbackOptions(makeRun({ thalamusChain: [...CHAIN] }));

    // Order is the argument: the chain is a ladder, not a set.
    expect(resolved.fallbacksOverride).toEqual([...CHAIN]);
    // ...and it must not have disturbed anything else the seam publishes.
    expect(resolved.provider).toBe("claude-code");
    expect(resolved.model).toBe("claude-opus-5");
  });

  it("fills the empty ladder that today ends the turn on a 429", () => {
    // The precise before/after of this fix, on the live config's shape. The first assertion is
    // the CONTROL: without a chain this is exactly the empty-ladder turn that stalls.
    expect(
      resolveEffectiveModelFallbacks({
        cfg: EMPTY_LADDER_CFG,
        agentId: "agent-1",
        hasSessionModelOverride: false,
      }),
    ).toBeUndefined();

    expect(
      resolveEffectiveModelFallbacks({
        cfg: EMPTY_LADDER_CFG,
        agentId: "agent-1",
        hasSessionModelOverride: false,
        thalamusChain: CHAIN,
      }),
    ).toEqual([...CHAIN]);
  });

  it("still hands the ladder over on an AUTO session model override", () => {
    // An auto override is the router's own move, not a human's — it must not disarm recovery.
    expect(
      resolveModelFallbackOptions(
        makeRun({
          hasSessionModelOverride: true,
          modelOverrideSource: "auto",
          thalamusChain: [...CHAIN],
        }),
      ).fallbacksOverride,
    ).toEqual([...CHAIN]);
  });

  it("a USER PIN still wins — a pinned turn keeps its empty ladder", () => {
    expect(
      resolveEffectiveModelFallbacks({
        cfg: EMPTY_LADDER_CFG,
        agentId: "agent-1",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
        thalamusChain: CHAIN,
      }),
    ).toEqual([]);

    // And through the run seam, which is where a real pinned turn is resolved.
    expect(
      resolveModelFallbackOptions(
        makeRun({
          hasSessionModelOverride: true,
          modelOverrideSource: "user",
          thalamusChain: [...CHAIN],
        }),
      ).fallbacksOverride,
    ).toEqual([]);
  });

  it("a legacy override with no recorded source is treated as a pin too", () => {
    // Sessions persisted before `modelOverrideSource` existed carry an override and no source.
    // `!== "auto"` reads those as human, which is the safe direction.
    expect(
      resolveEffectiveModelFallbacks({
        cfg: EMPTY_LADDER_CFG,
        agentId: "agent-1",
        hasSessionModelOverride: true,
        thalamusChain: CHAIN,
      }),
    ).toEqual([]);
  });

  it("an explicitly configured agent override beats the computed chain", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { fallbacks: [] } },
        list: [{ id: "linus", model: { fallbacks: ["anthropic/claude-sonnet-4-6"] } }],
      },
    };

    for (const session of [
      { hasSessionModelOverride: false },
      { hasSessionModelOverride: true, modelOverrideSource: "auto" as const },
    ]) {
      expect(
        resolveEffectiveModelFallbacks({ cfg, agentId: "linus", ...session, thalamusChain: CHAIN }),
      ).toEqual(["anthropic/claude-sonnet-4-6"]);
    }
  });

  it("an agent that explicitly disables fallbacks stays disabled", () => {
    // `[]` from an agent is a DECISION ("this agent does not fall back"), not an absence. A
    // computed chain must not reopen a door the architect closed.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { fallbacks: ["anthropic/claude-sonnet-4-6"] } },
        list: [{ id: "linus", model: { primary: "opencode-go/minimax-m2.7" } }],
      },
    };

    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
        thalamusChain: CHAIN,
      }),
    ).toEqual([]);
  });

  it("a configured DEFAULT ladder outranks the chain — the vacuum is the only opening", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { fallbacks: ["anthropic/claude-sonnet-4-6"] } } },
    };

    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "agent-1",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
        thalamusChain: CHAIN,
      }),
    ).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("an EMPTY chain is a no-op — every branch returns exactly today's value", () => {
    const configs: Array<[string, OpenClawConfig]> = [
      ["live-shape empty ladder", EMPTY_LADDER_CFG],
      ["no model config at all", {}],
      [
        "configured defaults",
        { agents: { defaults: { model: { fallbacks: ["anthropic/claude-sonnet-4-6"] } } } },
      ],
      [
        "agent override",
        {
          agents: {
            list: [{ id: "agent-1", model: { fallbacks: ["anthropic/claude-sonnet-4-6"] } }],
          },
        },
      ],
      [
        "agent disables fallbacks",
        {
          agents: { list: [{ id: "agent-1", model: { primary: "xai/grok-4.6", fallbacks: [] } }] },
        },
      ],
    ];
    const sessions = [
      { hasSessionModelOverride: false },
      { hasSessionModelOverride: true, modelOverrideSource: "auto" as const },
      { hasSessionModelOverride: true, modelOverrideSource: "user" as const },
    ];

    for (const [label, cfg] of configs) {
      for (const session of sessions) {
        const today = resolveEffectiveModelFallbacks({ cfg, agentId: "agent-1", ...session });
        for (const chain of [undefined, [] as readonly string[]]) {
          expect(
            resolveEffectiveModelFallbacks({
              cfg,
              agentId: "agent-1",
              ...session,
              thalamusChain: chain,
            }),
            `${label} / override=${session.hasSessionModelOverride} / chain=${chain === undefined ? "absent" : "empty"}`,
          ).toEqual(today);
        }
      }
    }
  });

  it("an empty chain does not invent a ladder at the run seam either", () => {
    expect(resolveModelFallbackOptions(makeRun({ thalamusChain: [] })).fallbacksOverride).toEqual(
      resolveModelFallbackOptions(makeRun()).fallbacksOverride,
    );
    expect(
      resolveModelFallbackOptions(makeRun({ thalamusChain: [] })).fallbacksOverride,
    ).toBeUndefined();
  });

  it("passes the chain through verbatim — no re-parsing, no re-aliasing", () => {
    // The entries are already `provider/model` and already floor-filtered. A second normalizer
    // here is how the two sides drift apart; `resolveFallbackCandidates` does the alias
    // resolution and the de-duplication against the primary.
    const exotic = ["custom-opencode-go-extras/deepseek-v4-flash", "xai/grok-4.6"];
    expect(
      resolveEffectiveModelFallbacks({
        cfg: EMPTY_LADDER_CFG,
        agentId: "agent-1",
        hasSessionModelOverride: false,
        thalamusChain: exotic,
      }),
    ).toEqual(exotic);
  });
});
