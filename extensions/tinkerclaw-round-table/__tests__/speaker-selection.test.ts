/**
 * Tests for SYNAPSE 7A: pluggable speaker-selection hook.
 */

import { describe, it, expect, vi } from "vitest";
import { DEFAULT_PROVIDER_PROFILES } from "../src/cognitive-diversity.js";
import { assignRoles } from "../src/raac-protocol.js";
import {
  assignRolesViaHook,
  builtinSpeakerSelectionHook,
  resolveSpeakerSelection,
  validateAssignment,
  type SpeakerSelectionContext,
  type SpeakerSelectionHook,
} from "../src/speaker-selection-api.js";

const ALL_ROLES = ["architect", "critic", "pragmatist", "researcher", "synthesizer"];

function ctx(
  profiles = DEFAULT_PROVIDER_PROFILES,
  task = "Should we add a result cache?",
): SpeakerSelectionContext {
  return { profiles, roles: ALL_ROLES, task };
}

describe("7A: builtin hook reproduces assignRoles exactly", () => {
  it("the builtin hook output equals assignRoles for the 5 default profiles", async () => {
    const expected = assignRoles(DEFAULT_PROVIDER_PROFILES.map((p) => p.modelId));
    const actual = await builtinSpeakerSelectionHook.assign(ctx());
    expect(actual).toEqual(expected);
  });
  it("assignRolesViaHook with the builtin hook equals the bare assignRoles", async () => {
    const expected = assignRoles(DEFAULT_PROVIDER_PROFILES.map((p) => p.modelId));
    const actual = await assignRolesViaHook(ctx(), builtinSpeakerSelectionHook);
    expect(actual).toEqual(expected);
  });
});

describe("7A: resolveSpeakerSelection mode dispatch", () => {
  it("'builtin' always returns the builtin hook", () => {
    expect(resolveSpeakerSelection("builtin")?.id).toBe("builtin");
    expect(resolveSpeakerSelection("builtin", { id: "x", assign: () => ({}) })?.id).toBe("builtin");
  });
  it("'ag2-hook' returns the external hook, or null when absent", () => {
    const ext: SpeakerSelectionHook = { id: "ag2", assign: () => ({}) };
    expect(resolveSpeakerSelection("ag2-hook", ext)?.id).toBe("ag2");
    expect(resolveSpeakerSelection("ag2-hook", null)).toBeNull();
  });
  it("'auto' prefers the external hook, else builtin", () => {
    const ext: SpeakerSelectionHook = { id: "ag2", assign: () => ({}) };
    expect(resolveSpeakerSelection("auto", ext)?.id).toBe("ag2");
    expect(resolveSpeakerSelection("auto", null)?.id).toBe("builtin");
  });
});

describe("7A: ag2 hook overrides role assignment", () => {
  it("a valid custom assignment from the hook is used verbatim", async () => {
    const custom: Record<string, string> = {
      "claude-opus": "synthesizer",
      "gpt-o3": "architect",
      "gemini-pro": "critic",
      "deepseek-r1": "pragmatist",
      "claude-sonnet": "researcher",
    };
    const hook: SpeakerSelectionHook = { id: "ag2", assign: vi.fn().mockReturnValue(custom) };
    const out = await assignRolesViaHook(ctx(), hook);
    expect(out).toEqual(custom);
    expect(hook.assign).toHaveBeenCalledTimes(1);
  });
});

describe("7A: fallback to builtin on bad hook output", () => {
  const expected = () => assignRoles(DEFAULT_PROVIDER_PROFILES.map((p) => p.modelId));

  it("empty hook result falls back to builtin", async () => {
    const hook: SpeakerSelectionHook = { id: "empty", assign: () => ({}) };
    const onWarn = vi.fn();
    const out = await assignRolesViaHook(ctx(), hook, onWarn);
    expect(out).toEqual(expected());
    expect(onWarn).toHaveBeenCalled();
  });

  it("hook throw falls back to builtin (no exception escapes)", async () => {
    const hook: SpeakerSelectionHook = {
      id: "boom",
      assign: vi.fn().mockRejectedValue(new Error("upstream down")),
    };
    const onWarn = vi.fn();
    let out: Record<string, string> | undefined;
    await expect(
      (async () => {
        out = await assignRolesViaHook(ctx(), hook, onWarn);
      })(),
    ).resolves.toBeUndefined();
    expect(out).toEqual(expected());
    expect(onWarn).toHaveBeenCalled();
  });

  it("duplicate-role result is rejected -> fallback to builtin", async () => {
    const dup: Record<string, string> = {
      "claude-opus": "critic",
      "gpt-o3": "critic", // two critics
    };
    const hook: SpeakerSelectionHook = { id: "dup", assign: () => dup };
    const out = await assignRolesViaHook(ctx(DEFAULT_PROVIDER_PROFILES.slice(0, 2)), hook);
    // builtin fallback over the 2-profile context
    expect(out).toEqual(assignRoles(["claude-opus", "gpt-o3"]));
  });

  it("null hook falls back to builtin", async () => {
    const out = await assignRolesViaHook(ctx(), null);
    expect(out).toEqual(expected());
  });
});

describe("7A: validateAssignment", () => {
  it("rejects an unknown participant modelId", () => {
    expect(
      validateAssignment(ctx(DEFAULT_PROVIDER_PROFILES.slice(0, 2)), {
        "claude-opus": "architect",
        nonexistent: "synthesizer",
      }),
    ).toBeNull();
  });
  it("rejects an unknown role", () => {
    expect(
      validateAssignment(ctx(DEFAULT_PROVIDER_PROFILES.slice(0, 1)), {
        "claude-opus": "overlord",
      }),
    ).toBeNull();
  });
  it("rejects when synthesizer is assignable but unassigned", () => {
    // Two profiles, neither given synthesizer though it is in roles.
    expect(
      validateAssignment(ctx(DEFAULT_PROVIDER_PROFILES.slice(0, 2)), {
        "claude-opus": "architect",
        "gpt-o3": "critic",
      }),
    ).toBeNull();
  });
  it("accepts a unique, synthesizer-bearing assignment", () => {
    const a = {
      "claude-opus": "architect",
      "gpt-o3": "synthesizer",
    };
    expect(validateAssignment(ctx(DEFAULT_PROVIDER_PROFILES.slice(0, 2)), a)).toEqual(a);
  });
});
