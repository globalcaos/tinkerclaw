import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(async ({ init, url }: { init?: RequestInit; url: string }) => ({
    response: await fetch(url, init),
    release: async () => {},
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => {
    const parsed = new URL(baseUrl);
    return { allowedHostnames: [parsed.hostname] };
  },
}));

let createOllamaEmbeddingProvider: typeof import("./embedding-provider.js").createOllamaEmbeddingProvider;
let ollamaMemoryEmbeddingProviderAdapter: typeof import("./memory-embedding-adapter.js").ollamaMemoryEmbeddingProviderAdapter;

beforeAll(async () => {
  ({ createOllamaEmbeddingProvider } = await import("./embedding-provider.js"));
  ({ ollamaMemoryEmbeddingProviderAdapter } = await import("./memory-embedding-adapter.js"));
});

beforeEach(() => {
  fetchWithSsrFGuardMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockEmbeddingFetch(embedding: number[]) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ embeddings: [embedding] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function readEmbeddingRequestBody(init: RequestInit | undefined): { input?: unknown } {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON string request body");
  }
  return JSON.parse(init.body) as { input?: unknown };
}

function readFirstEmbeddingInput(fetchMock: ReturnType<typeof mockEmbeddingFetch>): unknown {
  const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [string, RequestInit | undefined];
  const body = readEmbeddingRequestBody(init);
  return body.input;
}

describe("ollama embedding provider", () => {
  it("calls /api/embed and returns normalized vectors", async () => {
    const fetchMock = mockEmbeddingFetch([3, 4]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "unknown-embedder",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    const vector = await provider.embedQuery("hi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "unknown-embedder", input: "hi" }),
      }),
    );
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("resolves configured base URL and headers without sending local marker auth", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "ollama-\nlocal\r\n", // pragma: allowlist secret
              headers: {
                "X-Provider-Header": "provider",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Provider-Header": "provider",
        }),
      }),
    );
    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("resolves configured baseURL alias", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseURL: "http://remote-ollama:11434/v1",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote-ollama:11434/api/embed",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails fast when memory-search remote apiKey is an unresolved SecretRef", async () => {
    await expect(
      createOllamaEmbeddingProvider({
        config: {} as OpenClawConfig,
        provider: "ollama",
        model: "nomic-embed-text",
        fallback: "none",
        remote: {
          baseUrl: "http://127.0.0.1:11434",
          apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
        },
      }),
    ).rejects.toThrow(/agents\.\*\.memorySearch\.remote\.apiKey: unresolved SecretRef/i);
  });

  it("falls back to env key when provider apiKey is an unresolved SecretRef", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });

  it("sends batch embeddings in one Ollama request", async () => {
    const inputs: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as { input?: unknown };
      inputs.push(body.input);
      return new Response(
        JSON.stringify({
          embeddings: [
            [1, 0],
            [1, 0],
            [1, 0],
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await expect(provider.embedBatch(["a", "bb", "ccc"])).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inputs).toEqual([["a", "bb", "ccc"]]);
  });

  it("uses a retrieval query prefix for qwen3 embedding queries", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("怀孕");

    expect(readFirstEmbeddingInput(fetchMock)).toBe(
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:怀孕",
    );
  });

  it("uses the nomic search_query prefix for query embeddings", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("What does $& mean?");

    expect(readFirstEmbeddingInput(fetchMock)).toBe("search_query: What does $& mean?");
  });

  it("uses the mixedbread retrieval prompt for query embeddings", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "mxbai-embed-large:latest",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("capital of Australia");

    expect(readFirstEmbeddingInput(fetchMock)).toBe(
      "Represent this sentence for searching relevant passages: capital of Australia",
    );
  });

  it("keeps document batch embeddings raw", async () => {
    const inputs: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = readEmbeddingRequestBody(init);
      inputs.push(body.input);
      return new Response(
        JSON.stringify({
          embeddings: [
            [1, 0],
            [1, 0],
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await expect(provider.embedBatch(["doc one", "doc two"])).resolves.toHaveLength(2);
    expect(inputs).toEqual([["doc one", "doc two"]]);
  });

  it("uses custom Ollama provider config and strips that provider prefix", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            "ollama-spark": {
              baseUrl: "http://spark.local:11434/v1",
              apiKey: "spark-key",
              headers: {
                "X-Custom-Ollama": "spark",
              },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama-spark",
      model: "ollama-spark/qwen3-embedding:4b",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(provider.model).toBe("qwen3-embedding:4b");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://spark.local:11434/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer spark-key",
          "X-Custom-Ollama": "spark",
        }),
      }),
    );
  });

  it("does not attach pure env OLLAMA_API_KEY to a local host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("attaches pure env OLLAMA_API_KEY to Ollama Cloud", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://ollama.com" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-cloud-key",
        }),
      }),
    );
  });

  it("does not attach provider apiKey to a different remote embedding host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-key",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://memory.example.com" },
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("attaches remote apiKey to a remote embedding host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://memory.example.com", apiKey: "remote-host-key" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://memory.example.com/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer remote-host-key",
        }),
      }),
    );
  });

  it("honors remote local marker as an explicit no-auth opt-out", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-key",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { apiKey: "ollama-local" }, // pragma: allowlist secret
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("marks inline memory batches as local-server timeout work", async () => {
    const result = await ollamaMemoryEmbeddingProviderAdapter.create({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    expect(result.runtime?.inlineBatchTimeoutMs).toBe(600_000);
  });
});

// FORK 2026-10-30: the call's AbortSignal reaches the request. These tests send it through the real
// fetchWithSsrFGuard to a 127.0.0.1 server: one that takes the request and never answers (an abort
// must reject the call at once and close the connection) and one that answers.
describe("ollama embedding provider abort", () => {
  /** How soon an aborted call must reject; before the fix it stayed pending. */
  const ABORT_PROMPT_MS = 200;

  type Loopback = {
    baseUrl: string;
    state: { paths: string[]; closed: number };
    close: () => Promise<void>;
  };
  type Created = Awaited<ReturnType<typeof createOllamaEmbeddingProvider>>;
  type Entry = "embedQuery" | "embedBatch" | "client.embedBatch";

  const entries: Record<Entry, (created: Created, signal: AbortSignal) => Promise<unknown>> = {
    embedQuery: ({ provider }, signal) => provider.embedQuery("hi", { signal }),
    embedBatch: ({ provider }, signal) => provider.embedBatch(["a", "b"], { signal }),
    "client.embedBatch": ({ client }, signal) => client.embedBatch(["a", "b"], { signal }),
  };
  const loopbacks: Loopback[] = [];
  let realFetchWithSsrFGuard: typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard;

  beforeAll(async () => {
    ({ fetchWithSsrFGuard: realFetchWithSsrFGuard } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/ssrf-runtime")
    >("openclaw/plugin-sdk/ssrf-runtime"));
  });

  afterEach(async () => {
    await Promise.all(loopbacks.splice(0).map((server) => server.close()));
  });

  /**
   * A server on 127.0.0.1 and an ephemeral port. It answers every request with `reply` as JSON,
   * or for "hold" reads the request and never answers. `state.closed` counts closed connections.
   */
  async function startLoopback(reply: "hold" | Record<string, unknown>): Promise<Loopback> {
    const state = { paths: [] as string[], closed: 0 };
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        state.paths.push(req.url ?? "");
        if (reply !== "hold") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(reply));
        }
      });
    });
    server.on("connection", (socket) => {
      socket.once("close", () => {
        state.closed += 1;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const loopback: Loopback = {
      baseUrl: `http://127.0.0.1:${port}`,
      state,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
    loopbacks.push(loopback);
    return loopback;
  }

  /** The provider's one request goes through the real guard; the tests above keep the mock. */
  async function loopbackOllama(baseUrl: string): Promise<Created> {
    fetchWithSsrFGuardMock.mockImplementationOnce(realFetchWithSsrFGuard);
    return await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl },
    });
  }

  it.each(["embedQuery", "embedBatch", "client.embedBatch"] as const)(
    "%s: an abort rejects at once and closes the held request",
    async (entry) => {
      const server = await startLoopback("hold");
      const created = await loopbackOllama(server.baseUrl);
      const controller = new AbortController();
      const outcome = entries[entry](created, controller.signal).then(
        () => "resolved",
        (err: unknown) => err,
      );

      await vi.waitFor(() => expect(server.state.paths).toEqual(["/api/embed"]), {
        timeout: 5_000,
      });
      controller.abort();
      // Control: before the fix the request ran on, so this race came back "still pending".
      const settled = await Promise.race([outcome, sleep(ABORT_PROMPT_MS, "still pending")]);
      expect(settled).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(server.state.closed).toBe(1), { timeout: 2_000 });
    },
  );

  it("embeds as before through the real guard when the call carries no signal", async () => {
    const server = await startLoopback({ embeddings: [[3, 4]] });
    const { provider } = await loopbackOllama(server.baseUrl);

    const vector = await provider.embedQuery("hi");

    expect(server.state.paths).toEqual(["/api/embed"]);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });
});
