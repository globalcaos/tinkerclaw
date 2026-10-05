import { describe, expect, it } from "vitest";
import {
  HARNESS_ID_SENTENCE,
  buildHarnessIdReplacement,
  resolveHarnessIdGate,
} from "./harness-id.js";

describe("resolveHarnessIdGate", () => {
  it("allows API-key-only Anthropic auth with no cc-bridge", () => {
    expect(
      resolveHarnessIdGate({
        auth: { profiles: { "anthropic:api": { provider: "anthropic", mode: "api_key" } } },
      }),
    ).toEqual({ ok: true });
  });

  it("refuses when cc-bridge is enabled", () => {
    const gate = resolveHarnessIdGate({
      plugins: { entries: { "tinkerclaw-tinker-bridge": { enabled: true } } },
    });
    expect(gate.ok).toBe(false);
  });

  it("allows when cc-bridge is present but disabled or denied", () => {
    expect(
      resolveHarnessIdGate({
        plugins: { entries: { "tinkerclaw-tinker-bridge": { enabled: false } } },
      }).ok,
    ).toBe(true);
    expect(
      resolveHarnessIdGate({
        plugins: {
          deny: ["tinkerclaw-tinker-bridge"],
          entries: { "tinkerclaw-tinker-bridge": {} },
        },
      }).ok,
    ).toBe(true);
  });

  it("refuses on an Anthropic oauth or token login", () => {
    for (const mode of ["oauth", "token"]) {
      const gate = resolveHarnessIdGate({
        auth: { profiles: { a: { provider: "anthropic", mode } } },
      });
      expect(gate.ok).toBe(false);
    }
  });

  it("ignores non-Anthropic oauth logins", () => {
    expect(
      resolveHarnessIdGate({
        auth: { profiles: { g: { provider: "google-gemini-cli", mode: "oauth" } } },
      }).ok,
    ).toBe(true);
  });
});

describe("buildHarnessIdReplacement", () => {
  it("renames to TinkerClaw by default", () => {
    expect(buildHarnessIdReplacement(undefined)).toEqual({
      from: HARNESS_ID_SENTENCE,
      to: "You are a personal assistant running inside TinkerClaw.",
    });
  });

  it("uses a custom name", () => {
    expect(buildHarnessIdReplacement({ name: "MyFork" })).toMatchObject({
      to: "You are a personal assistant running inside MyFork.",
    });
  });

  it("strips the harness name", () => {
    expect(buildHarnessIdReplacement({ mode: "strip" })).toMatchObject({
      to: "You are a personal assistant.",
    });
  });

  it("refuses names that present as Anthropic's client", () => {
    expect(buildHarnessIdReplacement({ name: "Claude Code" })).toHaveProperty("error");
  });
});
