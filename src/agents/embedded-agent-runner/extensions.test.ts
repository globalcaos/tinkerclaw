import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  __resetEmbedderFitForTest,
  cheapFingerprint,
  endpointKeyFor,
  writeEmbedderFit,
  type FitDecision,
} from "../../fork/embedder-fit.js";
import { __resetEmbedGovernorsForTest, governorFor } from "../../fork/embedder-governor.js";
import {
  createOllamaEmbeddingProvider,
  resolveOllamaEmbeddingBaseUrl,
} from "../../memory/embeddings-ollama.js";
import { createEmbeddingProvider } from "../../memory/embeddings.js";
import { createEmbeddingWorker } from "../../memory/engram/embedding-worker.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { createLimbicRuntime, getLimbicRuntime } from "../pi-extensions/limbic-runtime.js";
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

// FORK 2026-10-29: pass-through spies, so the engram tests can see which embedding wiring session
// setup builds (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
vi.mock("../../memory/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../memory/embeddings.js")>();
  return { ...actual, createEmbeddingProvider: vi.fn(actual.createEmbeddingProvider) };
});

vi.mock("../../memory/embeddings-ollama.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../memory/embeddings-ollama.js")>();
  return { ...actual, createOllamaEmbeddingProvider: vi.fn(actual.createOllamaEmbeddingProvider) };
});

vi.mock("../../memory/engram/embedding-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../memory/engram/embedding-worker.js")>();
  return { ...actual, createEmbeddingWorker: vi.fn(actual.createEmbeddingWorker) };
});

vi.mock("../pi-extensions/limbic-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi-extensions/limbic-runtime.js")>();
  return { ...actual, createLimbicRuntime: vi.fn(actual.createLimbicRuntime) };
});

function restoreEnv(name: "HOME" | "OPENCLAW_STATE_DIR", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// An embedder-fit record measured on this machine (its fingerprint is this process's own), written
// into the test's temp state dir.
function writeFitRecord(decision: Pick<FitDecision, "mode" | "provider" | "model">): void {
  const fixture = (value: number, unit: string) => ({
    value,
    unit,
    provenance: "estimated" as const,
    source: "test fixture",
  });
  writeEmbedderFit({
    schemaVersion: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    fingerprint: cheapFingerprint(),
    inventory: {
      ollama: { baseUrl: "http://127.0.0.1:11434", reachable: true, models: [] },
      nodeLlamaCpp: false,
      remoteKeys: [],
    },
    candidates: [],
    missCostSec: fixture(21.57, "s"),
    nonEnglishShare: fixture(0, "share"),
    fitWallSeconds: fixture(150, "s"),
    decision: {
      dormantUntilDemand: false,
      reasons: ["test fixture"],
      verdicts: [],
      ...decision,
    },
    consent: { remote: null },
    tool: { command: "openclaw embedder fit", version: "test" },
    history: [],
  });
}

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
    let stateDirBackup: string | undefined;
    let tmpHome: string;

    beforeEach(() => {
      homeBackup = process.env.HOME;
      stateDirBackup = process.env.OPENCLAW_STATE_DIR;
      tmpHome = mkdtempSync(join(tmpdir(), "engram-extensions-test-"));
      process.env.HOME = tmpHome;
      // FORK 2026-10-29: inline LIMBIC reads this machine's embedder-fit record from the state
      // dir; an empty temp one keeps a record on the host out of this test.
      process.env.OPENCLAW_STATE_DIR = join(tmpHome, "state");
      __resetEmbedderFitForTest();
    });

    afterEach(() => {
      restoreEnv("HOME", homeBackup);
      restoreEnv("OPENCLAW_STATE_DIR", stateDirBackup);
      __resetEmbedderFitForTest();
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

  // FORK 2026-10-29: the ENGRAM vector worker is gone (its vectors had no reader) and the LIMBIC
  // semantic upgrade follows this machine's embedder fit (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
  describe("engram embedding consumers follow the embedder fit", () => {
    let homeBackup: string | undefined;
    let stateDirBackup: string | undefined;
    let tmpHome: string;

    beforeEach(() => {
      homeBackup = process.env.HOME;
      stateDirBackup = process.env.OPENCLAW_STATE_DIR;
      tmpHome = mkdtempSync(join(tmpdir(), "engram-embedder-fit-test-"));
      process.env.HOME = tmpHome;
      process.env.OPENCLAW_STATE_DIR = join(tmpHome, "state");
      __resetEmbedderFitForTest();
      __resetEmbedGovernorsForTest({ stateDir: null });
      vi.mocked(createEmbeddingProvider).mockClear();
      vi.mocked(createOllamaEmbeddingProvider).mockClear();
      vi.mocked(createEmbeddingWorker).mockClear();
      vi.mocked(createLimbicRuntime).mockClear();
    });

    afterEach(() => {
      restoreEnv("HOME", homeBackup);
      restoreEnv("OPENCLAW_STATE_DIR", stateDirBackup);
      __resetEmbedderFitForTest();
      __resetEmbedGovernorsForTest();
      rmSync(tmpHome, { recursive: true, force: true });
    });

    function buildEngramSession(sessionKey: string): SessionManager {
      const sessionManager = {} as SessionManager;
      buildEmbeddedExtensionFactories({
        cfg: { agents: { defaults: { compaction: { mode: "engram" } } } } as OpenClawConfig,
        sessionManager,
        sessionKey,
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        model: { id: "claude-sonnet-4-20250514", contextWindow: 200_000 } as Model<Api>,
      });
      return sessionManager;
    }

    it("no fit record: inline LIMBIC builds no embedding provider and no worker", async () => {
      const sessionManager = buildEngramSession("embedder-fit-none");
      await new Promise((resolve) => setImmediate(resolve));

      // Words only on this machine: the hashed LIMBIC runtime is the only one.
      expect(getLimbicRuntime(sessionManager)).not.toBeNull();
      expect(createLimbicRuntime).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createLimbicRuntime).mock.calls[0]?.[1]?.embeddingProvider).toBeUndefined();
      expect(createEmbeddingProvider).not.toHaveBeenCalled();
      expect(createOllamaEmbeddingProvider).not.toHaveBeenCalled();
      expect(createEmbeddingWorker).not.toHaveBeenCalled();
    });

    it("a fit record naming a model: the LIMBIC upgrade gets a governed provider", async () => {
      // A model name no code carries as a literal: it can only come from the record.
      writeFitRecord({ mode: "memory", provider: "ollama", model: "fixture-embedder:test" });
      const sessionManager = buildEngramSession("embedder-fit-armed");

      await vi.waitFor(() => expect(createLimbicRuntime).toHaveBeenCalledTimes(2));
      expect(createEmbeddingProvider).toHaveBeenCalledTimes(1);
      expect(createEmbeddingProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "ollama",
          model: "fixture-embedder:test",
          consumer: "limbic",
          fitDecided: true,
        }),
      );
      expect(createOllamaEmbeddingProvider).toHaveBeenCalledWith(
        expect.objectContaining({ model: "fixture-embedder:test" }),
      );
      const upgraded = vi.mocked(createLimbicRuntime).mock.calls[1]?.[1]?.embeddingProvider;
      expect(upgraded?.model).toBe("fixture-embedder:test");
      const governor = governorFor(upgraded);
      expect(governor?.mode).toBe("fit");
      expect(governor?.endpointKey).toBe(
        endpointKeyFor({
          providerId: "ollama",
          baseUrl: resolveOllamaEmbeddingBaseUrl({ config: {} as OpenClawConfig }),
        }),
      );
      expect(getLimbicRuntime(sessionManager)).not.toBeNull();
      expect(createEmbeddingWorker).not.toHaveBeenCalled();
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
