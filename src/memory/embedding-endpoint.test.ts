/**
 * FORK 2026-10-30 (TINKER_UI_DESIGN_BIBLE/embedder-fit.md): every consumer of one embedding server
 * hands the embedder governor that server's base URL, so the governor keeps one queue per server
 * and classifies a loopback server as local whatever the provider id.
 *
 * Covered: the memory index (createEmbeddingProvider), skill search (resolveSkillEmbedFn) and the
 * prefrontal lane (fork.prefrontal.embed) on one OpenAI-compatible server at 127.0.0.1; every HTTP
 * provider the memory index builds; two OpenAI-compatible servers; and
 * resolveEmbeddingEndpointBaseUrl against each adapter's own client. When a consumer passes no URL
 * for a provider other than Ollama, the first three cases fail: the loopback server is classified
 * remote, and every OpenAI-compatible server shares the key "openai".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { __resetEmbedderFitForTest, endpointKeyFor } from "../fork/embedder-fit.js";
import { __resetEmbedGovernorsForTest, governorFor } from "../fork/embedder-governor.js";
import {
  __resetPrefrontalRecipeVectorsForTest,
  forkPrefrontalStateHandlers,
} from "../fork/prefrontal-state-rpc.js";
import { createGeminiEmbeddingProvider } from "./embeddings-gemini.js";
import { createMistralEmbeddingProvider } from "./embeddings-mistral.js";
import { createOllamaEmbeddingProvider } from "./embeddings-ollama.js";
import { createOpenAiEmbeddingProvider } from "./embeddings-openai.js";
import { createVoyageEmbeddingProvider } from "./embeddings-voyage.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { resolveSkillEmbedFn } from "./engram/skill-embed.js";

const h = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  memorySearch: null as Record<string, unknown> | null,
  createConfiguredEmbeddingProvider: vi.fn(),
  governed: [] as Array<{ consumer: string; endpointKey: string }>,
}));

// getRuntimeConfig would read the real config file, resolveMemorySearchConfig would look the
// provider up among the plugin adapters, and createConfiguredEmbeddingProvider would build one, so
// all three are stubbed. vi.mock and vi.hoisted run before the imports.
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => h.cfg,
}));
vi.mock("../agents/memory-search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/memory-search.js")>()),
  resolveMemorySearchConfig: () => h.memorySearch,
}));
vi.mock("../gateway/embeddings-http.js", () => ({
  createConfiguredEmbeddingProvider: h.createConfiguredEmbeddingProvider,
}));
// The real governor. The wrapper only records which endpoint key each consumer's provider got.
vi.mock("../fork/embedder-governor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fork/embedder-governor.js")>();
  return {
    ...actual,
    governEmbeddingProvider: (...args: Parameters<typeof actual.governEmbeddingProvider>) => {
      const governed = actual.governEmbeddingProvider(...args);
      h.governed.push({ consumer: args[1].consumer, endpointKey: governed.endpointKey });
      return governed;
    },
  };
});

const MODEL = "text-embedding-3-small";
const LOOPBACK_SERVER = "http://127.0.0.1:8080/v1";
const LAN_SERVER = "http://10.0.0.7:8080/v1";
const TEST_API_KEY = "endpoint-test-key"; // pragma: allowlist secret

/** Each HTTP adapter, with the models.providers entry it reads its base URL from. */
const ADAPTERS = [
  { providerId: "openai", configKey: "openai", create: createOpenAiEmbeddingProvider },
  { providerId: "gemini", configKey: "google", create: createGeminiEmbeddingProvider },
  { providerId: "voyage", configKey: "voyage", create: createVoyageEmbeddingProvider },
  { providerId: "mistral", configKey: "mistral", create: createMistralEmbeddingProvider },
  { providerId: "ollama", configKey: "ollama", create: createOllamaEmbeddingProvider },
] as const;

type UrlCase = { name: string; config: OpenClawConfig; remote?: { baseUrl: string } };

function withProviderBaseUrl(configKey: string, baseUrl: string): OpenClawConfig {
  return { models: { providers: { [configKey]: { baseUrl, models: [] } } } } as never;
}

/** Pins memory search to the OpenAI-compatible server at `baseUrl`, as the fork paths read it. */
function pinOpenAiServer(baseUrl: string): void {
  const memorySearch = { provider: "openai", model: MODEL, remote: { baseUrl } };
  h.cfg = { agents: { defaults: { memorySearch } } };
  h.memorySearch = memorySearch;
  h.createConfiguredEmbeddingProvider.mockImplementation(async () => ({
    id: "openai",
    model: MODEL,
    embedQuery: async () => [1, 0],
    embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
  }));
}

/** fork.prefrontal.embed with the prompt alone: no recipe texts, so no background fill starts. */
async function prefrontalEmbed(prompt: string): Promise<void> {
  await forkPrefrontalStateHandlers["fork.prefrontal.embed"]!({
    params: { texts: [prompt] },
    respond: () => undefined,
    isWebchatConnect: () => false,
  } as never);
}

/** The governor the memory index's OpenAI provider lands on for `remote`. */
async function openAiIndexGovernor(remote: { baseUrl?: string }) {
  const result = await createEmbeddingProvider({
    config: {},
    provider: "openai",
    model: MODEL,
    fallback: "none",
    remote: { ...remote, apiKey: TEST_API_KEY },
  });
  return governorFor(result.provider);
}

describe("one embedding server, one governor queue", () => {
  const savedStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir = "";

  beforeEach(() => {
    // An empty state dir and no disk snapshots, so nothing on the host changes the outcome.
    stateDir = mkdtempSync(join(tmpdir(), "embedding-endpoint-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    __resetEmbedderFitForTest();
    __resetEmbedGovernorsForTest({ stateDir: null });
    __resetPrefrontalRecipeVectorsForTest();
    h.cfg = {};
    h.memorySearch = null;
    h.createConfiguredEmbeddingProvider.mockReset();
    h.governed.length = 0;
  });

  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = savedStateDir;
    }
    __resetEmbedderFitForTest();
    __resetEmbedGovernorsForTest();
    __resetPrefrontalRecipeVectorsForTest();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("gives the memory index, skill search and the prefrontal lane one local queue on a loopback OpenAI-compatible server", async () => {
    pinOpenAiServer(LOOPBACK_SERVER);
    const index = await createEmbeddingProvider({
      config: h.cfg,
      provider: "openai",
      model: MODEL,
      fallback: "none",
      remote: { baseUrl: LOOPBACK_SERVER, apiKey: TEST_API_KEY },
    });
    expect(await resolveSkillEmbedFn()).toBeDefined();
    await prefrontalEmbed("roll back the failed deploy");

    const key = endpointKeyFor({ providerId: "openai", baseUrl: LOOPBACK_SERVER });
    expect(h.governed).toEqual([
      { consumer: "memory-index", endpointKey: key },
      { consumer: "skill-search", endpointKey: key },
      { consumer: "prefrontal", endpointKey: key },
    ]);
    expect(governorFor(index.provider)?.endpointClass).toBe("local-http");
  });

  it("keys every HTTP provider the memory index builds by the URL its client calls", async () => {
    for (const adapter of ADAPTERS) {
      const result = await createEmbeddingProvider({
        config: {},
        provider: adapter.providerId,
        model: "",
        fallback: "none",
        remote: { baseUrl: LOOPBACK_SERVER, apiKey: TEST_API_KEY },
      });
      const client =
        result.openAi ?? result.gemini ?? result.voyage ?? result.mistral ?? result.ollama;
      const governor = governorFor(result.provider);
      expect(governor?.endpointKey, adapter.providerId).toBe(
        endpointKeyFor({ providerId: adapter.providerId, baseUrl: client?.baseUrl }),
      );
      expect(governor?.endpointClass, adapter.providerId).toBe("local-http");
    }
  });

  it("gives two OpenAI-compatible servers two queues and keeps the public API remote", async () => {
    const loopback = await openAiIndexGovernor({ baseUrl: LOOPBACK_SERVER });
    const lan = await openAiIndexGovernor({ baseUrl: LAN_SERVER });
    const publicApi = await openAiIndexGovernor({});

    expect(lan?.endpointKey).not.toBe(loopback?.endpointKey);
    expect(publicApi?.endpointKey).not.toBe(loopback?.endpointKey);
    expect(lan?.endpointClass).toBe("local-http");
    expect(publicApi?.endpointClass).toBe("remote");
  });

  it("answers the base URL each adapter's client calls, by default and when overridden", async () => {
    // Imported inside the test, not at the top, so on a tree without this module the cases above
    // still run and fail on their own assertions.
    const { resolveEmbeddingEndpointBaseUrl } = await import("./embedding-endpoint.js");
    for (const adapter of ADAPTERS) {
      const configured = withProviderBaseUrl(adapter.configKey, "http://10.1.2.3:9000/v1");
      const cases: UrlCase[] = [
        { name: "default", config: {} },
        { name: "models.providers", config: configured },
        {
          name: "memorySearch.remote",
          config: configured,
          remote: { baseUrl: `${LOOPBACK_SERVER}/` },
        },
      ];
      for (const { name, config, remote } of cases) {
        const { client } = await adapter.create({
          config,
          provider: adapter.providerId,
          model: "",
          fallback: "none",
          remote: { ...remote, apiKey: TEST_API_KEY },
        });
        const resolved = await resolveEmbeddingEndpointBaseUrl({
          providerId: adapter.providerId,
          config,
          remote,
        });
        expect(resolved, `${adapter.providerId}, ${name}`).toBe(client.baseUrl);
      }
    }
    // Gemini trims an OpenAI-compatible path back to its own API.
    const gemini = await resolveEmbeddingEndpointBaseUrl({
      providerId: "gemini",
      config: {},
      remote: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" },
    });
    expect(gemini).toBe("https://generativelanguage.googleapis.com/v1beta");
    // The in-process provider calls no URL.
    const local = await resolveEmbeddingEndpointBaseUrl({ providerId: "local", config: {} });
    expect(local).toBeUndefined();
  });
});
