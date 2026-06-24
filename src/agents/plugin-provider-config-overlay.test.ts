/**
 * Test target: src/agents/plugin-provider-config-overlay.ts
 * Bible anchor: config-shape.md (plugin overlay merge path, FORK 2026-05-10) +
 *               tool-loop.md (why tinker-bridge needs the overlay) +
 *               failures.md M1 (tinker-bridge SIGTERM, root cause was that this
 *               overlay path didn't exist)
 * Bug history: bug-log.md predecessor — the 2026-05-05 catalog timeoutSeconds:600
 *              setting was dead code at runtime. Fixed 2026-05-10 by adding this
 *              module. See J15 v0.2 §2.2.
 * Catches:     regression of any of (a) the registry survives multi-call merges,
 *              (b) trimming of the providerId, (c) empty-providerId silent ignore,
 *              (d) returning undefined for unregistered providers. Together these
 *              are the four invariants the production overlay depends on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPluginProviderConfigOverlayForTests,
  getPluginProviderConfigOverlay,
  registerPluginProviderConfigOverlay,
} from "./plugin-provider-config-overlay.js";

describe("plugin-provider-config-overlay", () => {
  beforeEach(() => clearPluginProviderConfigOverlayForTests());
  afterEach(() => clearPluginProviderConfigOverlayForTests());

  it("returns undefined for an unregistered providerId", () => {
    expect(getPluginProviderConfigOverlay("never-registered")).toBeUndefined();
  });

  it("stores the canonical tinker-bridge case: timeoutSeconds for claude-code", () => {
    registerPluginProviderConfigOverlay("claude-code", { timeoutSeconds: 600 });
    expect(getPluginProviderConfigOverlay("claude-code")).toEqual({ timeoutSeconds: 600 });
  });

  it("merges multiple registrations for the same providerId (later wins per key)", () => {
    registerPluginProviderConfigOverlay("claude-code", { timeoutSeconds: 600 });
    registerPluginProviderConfigOverlay("claude-code", {
      baseUrl: "local://claude-cli",
      timeoutSeconds: 900,
    });
    const merged = getPluginProviderConfigOverlay("claude-code");
    expect(merged).toEqual({ timeoutSeconds: 900, baseUrl: "local://claude-cli" });
  });

  it("merges keys non-destructively when the second call adds a new field", () => {
    registerPluginProviderConfigOverlay("claude-code", { timeoutSeconds: 600 });
    registerPluginProviderConfigOverlay("claude-code", { api: "anthropic-messages" });
    const merged = getPluginProviderConfigOverlay("claude-code");
    expect(merged).toEqual({ timeoutSeconds: 600, api: "anthropic-messages" });
  });

  it("trims providerId whitespace on register and on get", () => {
    registerPluginProviderConfigOverlay("  claude-code\t", { timeoutSeconds: 600 });
    expect(getPluginProviderConfigOverlay("claude-code")).toEqual({ timeoutSeconds: 600 });
    expect(getPluginProviderConfigOverlay(" claude-code  ")).toEqual({ timeoutSeconds: 600 });
  });

  it("ignores empty or whitespace-only providerId on register (no global pollution)", () => {
    registerPluginProviderConfigOverlay("", { timeoutSeconds: 600 });
    registerPluginProviderConfigOverlay("   ", { timeoutSeconds: 600 });
    expect(getPluginProviderConfigOverlay("")).toBeUndefined();
    expect(getPluginProviderConfigOverlay("   ")).toBeUndefined();
  });

  it("isolates different providerIds", () => {
    registerPluginProviderConfigOverlay("claude-code", { timeoutSeconds: 600 });
    registerPluginProviderConfigOverlay("openai", { timeoutSeconds: 300 });
    expect(getPluginProviderConfigOverlay("claude-code")).toEqual({ timeoutSeconds: 600 });
    expect(getPluginProviderConfigOverlay("openai")).toEqual({ timeoutSeconds: 300 });
  });

  it("supports the full ProviderOverlayConfig surface (timeoutSeconds, baseUrl, api, headers, contextWindow, contextTokens, maxTokens)", () => {
    registerPluginProviderConfigOverlay("claude-code", {
      timeoutSeconds: 600,
      baseUrl: "local://claude-cli",
      api: "anthropic-messages",
      headers: { "x-fork-trace": "rsc" },
      contextWindow: 1_000_000,
      contextTokens: 999_999,
      maxTokens: 8192,
    });
    const merged = getPluginProviderConfigOverlay("claude-code");
    expect(merged).toEqual({
      timeoutSeconds: 600,
      baseUrl: "local://claude-cli",
      api: "anthropic-messages",
      headers: { "x-fork-trace": "rsc" },
      contextWindow: 1_000_000,
      contextTokens: 999_999,
      maxTokens: 8192,
    });
  });
});
