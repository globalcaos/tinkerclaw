import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { getLinkBuilderRuntime } from "../pi-extensions/link-builder-runtime.js";
import { getCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

function buildSafeguardFactories(cfg: OpenClawConfig) {
  const sessionManager = {} as SessionManager;
  const model = {
    id: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  } as Model<Api>;

  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model,
  });

  return { factories, sessionManager };
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg);

  expect(factories).toContain(compactionSafeguardExtension);
  expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject(expectedRuntime);
}

describe("buildEmbeddedExtensionFactories", () => {
  it("enables quality-guard retries by default in safeguard mode", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
    });
  });

  it("honors explicit safeguard quality-guard disablement", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: false,
    });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });

  // U9: the producer for the Zettelkasten link builder. attempt-hooks reads it
  // via getLinkBuilderRuntime; before this wiring nothing ever called
  // setLinkBuilderRuntime in production so getLinkBuilderRuntime always returned
  // null and no link records were ever written.
  describe("U9 link builder registration (engram mode)", () => {
    let homeBackup: string | undefined;
    let tmpHome: string;

    beforeEach(() => {
      homeBackup = process.env.HOME;
      tmpHome = mkdtempSync(join(tmpdir(), "engram-extensions-test-"));
      process.env.HOME = tmpHome;
    });

    afterEach(() => {
      if (homeBackup === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = homeBackup;
      }
      rmSync(tmpHome, { recursive: true, force: true });
    });

    it("registers a link builder at the session-setup site and extractAndIndex writes a record", () => {
      const cfg = {
        agents: { defaults: { compaction: { mode: "engram" } } },
      } as OpenClawConfig;
      const sessionManager = {} as SessionManager;

      buildEmbeddedExtensionFactories({
        cfg,
        sessionManager,
        sessionKey: "u9-link-builder-test",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        model: { id: "claude-sonnet-4-20250514", contextWindow: 200_000 } as Model<Api>,
      });

      // Producer now fires: getLinkBuilderRuntime resolves a real builder.
      const builder = getLinkBuilderRuntime(sessionManager);
      expect(builder).not.toBeNull();

      // And the builder actually indexes a mention into the per-session JSONL.
      const records = builder!.extractAndIndex("evt-1", "see [[roadmap]] for details");
      expect(records.map((r) => r.targetKey)).toContain("roadmap");
      expect(builder!.getBacklinks("roadmap").map((r) => r.sourceId)).toEqual(["evt-1"]);

      const linkFile = join(tmpHome, ".openclaw", "engram", "links", "u9-link-builder-test.jsonl");
      expect(existsSync(linkFile)).toBe(true);
      expect(readFileSync(linkFile, "utf-8")).toContain('"targetKey":"roadmap"');
    });
  });

  it("enables cache-ttl pruning for custom anthropic-messages providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager: {} as SessionManager,
      provider: "litellm",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages", contextWindow: 200_000 } as Model<Api>,
    });

    expect(factories).toContain(contextPruningExtension);
  });
});
