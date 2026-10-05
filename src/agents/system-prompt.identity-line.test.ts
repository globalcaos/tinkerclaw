import { describe, expect, it } from "vitest";
import {
  applyAgentNameConfig,
  buildAgentIdentityLine,
  parseAgentNameFromIdentityLine,
} from "../commands/onboard-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { composeSystemPromptWithHookContext } from "./embedded-agent-runner/run/attempt.thread-helpers.js";
import { resolveSystemPromptIdentityLine } from "./system-prompt-override.js";
import { buildAgentSystemPrompt, DEFAULT_IDENTITY_LINE } from "./system-prompt.js";

const LINE =
  "You are JarvisOne (Jarvis for short), an agent running TinkerClaw, a Claude Code UI enhanced with ideas from other harnesses.";

describe("identityLine", () => {
  it("opens the prompt with the configured line and never mentions OpenClaw as the harness", () => {
    const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/ws", identityLine: LINE });
    expect(prompt.startsWith(`${LINE}\n`)).toBe(true);
    expect(prompt).not.toContain("running inside OpenClaw");
  });

  it("falls back to the TinkerClaw default when unset", () => {
    const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/ws" });
    expect(prompt.startsWith(`${DEFAULT_IDENTITY_LINE}\n`)).toBe(true);
    expect(DEFAULT_IDENTITY_LINE).toContain("TinkerClaw");
  });

  it("returns only the identity line in promptMode none", () => {
    expect(
      buildAgentSystemPrompt({ workspaceDir: "/tmp/ws", identityLine: LINE, promptMode: "none" }),
    ).toBe(LINE);
  });

  it("resolves per-agent before defaults", () => {
    const config = {
      agents: {
        defaults: { identityLine: "default line" },
        list: [{ id: "goku", identityLine: "You are Goku." }],
      },
    } as OpenClawConfig;
    expect(resolveSystemPromptIdentityLine({ config, agentId: "goku" })).toBe("You are Goku.");
    expect(resolveSystemPromptIdentityLine({ config, agentId: "main" })).toBe("default line");
    expect(resolveSystemPromptIdentityLine({ config: {} as OpenClawConfig })).toBeUndefined();
  });

  it("stays first above hook-prepended context", () => {
    const base = buildAgentSystemPrompt({ workspaceDir: "/tmp/ws", identityLine: LINE });
    const out = composeSystemPromptWithHookContext({
      baseSystemPrompt: base,
      prependSystemContext: "# Persona: Test (v1)\nbody",
      leadingLine: LINE,
    });
    expect(out?.startsWith(`${LINE}\n\n# Persona: Test (v1)\nbody`)).toBe(true);
    expect(out?.split(LINE).length).toBe(2);
  });
});

describe("onboarding agent name", () => {
  it("builds the sentence from the chosen name and reads it back", () => {
    const line = buildAgentIdentityLine("JarvisOne (Jarvis for short)");
    expect(line).toBe(LINE);
    expect(parseAgentNameFromIdentityLine(line)).toBe("JarvisOne (Jarvis for short)");
    expect(parseAgentNameFromIdentityLine("You are a personal assistant.")).toBeUndefined();
  });

  it("writes agents.defaults.identityLine without touching other defaults", () => {
    const next = applyAgentNameConfig(
      { agents: { defaults: { workspace: "/w" } } } as OpenClawConfig,
      "Goku",
    );
    expect(next.agents?.defaults?.workspace).toBe("/w");
    expect(next.agents?.defaults?.identityLine).toBe(buildAgentIdentityLine("Goku"));
  });
});
