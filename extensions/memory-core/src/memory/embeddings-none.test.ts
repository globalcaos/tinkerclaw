// FORK 2026-10-29: memorySearch.provider "none" is the word index only. In TinkerClaw,
// resolveMemorySearchConfig returns it for an unset or "auto" provider until the embedder fit
// chooses a model, so createEmbeddingProvider must answer it without consulting an adapter or
// trying the fallback.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider } from "./embeddings.js";

// The registry is faked so every lookup and every create() that reaches an adapter is counted.
const registry = vi.hoisted(() => {
  const create = vi.fn(async () => ({
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: async () => [1],
      embedBatch: async (texts: string[]) => texts.map(() => [1]),
    },
  }));
  const adapter = { id: "openai", transport: "remote" as const, autoSelectPriority: 20, create };
  return {
    create,
    getMemoryEmbeddingProvider: vi.fn((id: string) => (id === adapter.id ? adapter : undefined)),
    listMemoryEmbeddingProviders: vi.fn(() => [adapter]),
  };
});

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  DEFAULT_LOCAL_MODEL: "local-default-model",
  getMemoryEmbeddingProvider: registry.getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders: registry.listMemoryEmbeddingProviders,
}));
// embeddings.ts needs these two only for error text and local auto-selection. Faking them keeps
// this file independent of the other plugin-sdk subpaths they import.
vi.mock("./provider-adapters.js", () => ({ canAutoSelectLocal: () => false }));
vi.mock("../dreaming-shared.js", () => ({
  formatErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

function options(provider: string, fallback = "none") {
  return {
    config: {} as OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider,
    fallback,
    model: "",
  };
}

describe("createEmbeddingProvider with provider none", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no provider and a word-index reason without touching an adapter", async () => {
    const result = await createEmbeddingProvider(options("none", "openai"));

    expect(result).toEqual({
      provider: null,
      requestedProvider: "none",
      providerUnavailableReason: "memorySearch.provider is none: word index only",
    });
    expect(registry.getMemoryEmbeddingProvider).not.toHaveBeenCalled();
    expect(registry.listMemoryEmbeddingProviders).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
  });

  it("control: an explicit provider still goes through its adapter", async () => {
    const result = await createEmbeddingProvider(options("openai"));

    expect(result.provider?.id).toBe("openai");
    expect(result.requestedProvider).toBe("openai");
    expect(registry.create).toHaveBeenCalledTimes(1);
  });

  it("still rejects an unknown provider id", async () => {
    await expect(createEmbeddingProvider(options("nonesuch"))).rejects.toThrow(
      "Unknown memory embedding provider: nonesuch",
    );
  });
});
