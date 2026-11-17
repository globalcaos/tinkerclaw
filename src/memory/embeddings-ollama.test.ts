// FORK 2026-10-29: the Ollama embedding provider against a local node:http mock of Ollama. One
// /api/embed request per batch, no client-side cut, Ollama's timings to onMeasure, an abort that
// closes the socket, and the legacy /api/embeddings fallback strictly one request at a time.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createOllamaEmbeddingProvider,
  resolveOllamaEmbeddingBaseUrl,
} from "./embeddings-ollama.js";
import type { EmbeddingProviderOptions, EmbedMeasurement } from "./embeddings.js";

type Seen = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
};

type Reply = { status: number; body: unknown } | "hold";

type MockOllama = {
  baseUrl: string;
  state: { seen: Seen[]; inFlight: number; maxInFlight: number; closedSockets: number };
  /** Resolves when the client closes the socket of a held request. */
  socketClosed: Promise<void>;
  close: () => Promise<void>;
};

const servers: MockOllama[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function mockOllama(reply: (seen: Seen) => Reply | Promise<Reply>): Promise<MockOllama> {
  const state = { seen: [] as Seen[], inFlight: 0, maxInFlight: 0, closedSockets: 0 };
  let markClosed!: () => void;
  const socketClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const seen: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      state.seen.push(seen);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      void Promise.resolve(reply(seen)).then((answer) => {
        if (answer === "hold") {
          req.socket.once("close", () => {
            state.inFlight -= 1;
            state.closedSockets += 1;
            markClosed();
          });
          return;
        }
        const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
        res.writeHead(answer.status, {
          "content-type": typeof answer.body === "string" ? "text/plain" : "application/json",
        });
        state.inFlight -= 1;
        res.end(text);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const mock: MockOllama = {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    socketClosed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(mock);
  return mock;
}

function options(baseUrl: string, extra: Partial<EmbeddingProviderOptions> = {}) {
  return {
    config: {} as OpenClawConfig,
    provider: "ollama" as const,
    model: "nomic-embed-text",
    fallback: "none" as const,
    remote: { baseUrl },
    ...extra,
  };
}

describe("embeddings-ollama", () => {
  it("sends one /api/embed request per batch with an input array and truncate true, uncut", async () => {
    // 2,000 characters: the old /api/embeddings path cut every text to its first 500.
    const long = "word ".repeat(400);
    const ollama = await mockOllama(() => ({
      status: 200,
      body: {
        embeddings: [
          [3, 4],
          [0, 2],
          [1, 0],
        ],
      },
    }));
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));

    const vectors = await provider.embedBatch(["alpha", long, "gamma"]);

    expect(ollama.state.seen).toHaveLength(1);
    const [request] = ollama.state.seen;
    expect(request).toMatchObject({ method: "POST", url: "/api/embed" });
    expect(request.body).toEqual({
      model: "nomic-embed-text",
      input: ["alpha", long, "gamma"],
      truncate: true,
    });
    expect((request.body.input as string[])[1]).toHaveLength(2000);
    // normalized [3,4] => [0.6,0.8]
    expect(vectors[0][0]).toBeCloseTo(0.6, 5);
    expect(vectors[0][1]).toBeCloseTo(0.8, 5);
    expect(vectors[1]).toEqual([0, 1]);
  });

  it("embeds a query through the same call with a one-text input", async () => {
    const ollama = await mockOllama(() => ({ status: 200, body: { embeddings: [[3, 4]] } }));
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));

    const vector = await provider.embedQuery("hi");

    expect(ollama.state.seen.map((s) => [s.url, s.body.input])).toEqual([["/api/embed", ["hi"]]]);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("sends keep_alive and options.num_thread only when the call carries them", async () => {
    const ollama = await mockOllama(() => ({ status: 200, body: { embeddings: [[1, 0]] } }));
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));

    await provider.embedBatch(["a"], { keepAlive: "600s", numThread: 2 });
    await provider.embedBatch(["a"]);

    expect(ollama.state.seen[0]?.body).toMatchObject({
      keep_alive: "600s",
      options: { num_thread: 2 },
    });
    expect(ollama.state.seen[1]?.body).not.toHaveProperty("keep_alive");
    expect(ollama.state.seen[1]?.body).not.toHaveProperty("options");
  });

  it("closes the socket the server holds when the caller's signal aborts", async () => {
    const ollama = await mockOllama(() => "hold");
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));
    const controller = new AbortController();

    const outcome = provider.embedBatch(["slow"], { signal: controller.signal }).then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(ollama.state.seen).toHaveLength(1));
    controller.abort();

    await ollama.socketClosed;
    expect(await outcome).toBeInstanceOf(Error);
    expect(ollama.state.closedSockets).toBe(1);
  });

  it("reports Ollama's timings to onMeasure and omits the ones it did not send", async () => {
    let withTimings = true;
    const ollama = await mockOllama(() => ({
      status: 200,
      body: withTimings
        ? {
            embeddings: [
              [1, 0],
              [0, 1],
            ],
            prompt_eval_count: 12,
            total_duration: 3_000_000,
            load_duration: 1_000_000,
          }
        : { embeddings: [[1, 0]] },
    }));
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));
    const measurements: EmbedMeasurement[] = [];

    await provider.embedBatch(["ab", "cde"], { onMeasure: (m) => measurements.push(m) });
    withTimings = false;
    await provider.embedQuery("x", { onMeasure: (m) => measurements.push(m) });

    expect(measurements[0]).toMatchObject({
      inputs: 2,
      chars: 5,
      promptEvalCount: 12,
      totalDurationNs: 3_000_000,
      loadDurationNs: 1_000_000,
    });
    expect(measurements[0]?.wallMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(measurements[1] ?? {}).toSorted()).toEqual(["chars", "inputs", "wallMs"]);
  });

  it("throws unless /api/embed returns one vector per input", async () => {
    const ollama = await mockOllama(() => ({ status: 200, body: { embeddings: [[1, 0]] } }));
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));

    await expect(provider.embedBatch(["a", "b"])).rejects.toThrow(/expected 2, received 1/);
  });

  it("falls back to /api/embeddings one text at a time, never two in flight, cut to 500 characters", async () => {
    const ollama = await mockOllama(async (seen) => {
      if (seen.url === "/api/embed") {
        return { status: 404, body: "404 page not found" };
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { status: 200, body: { embedding: [1, 0] } };
    });
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));

    const vectors = await provider.embedBatch(["a", "b", "x".repeat(600)]);

    expect(vectors).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    const legacy = ollama.state.seen.filter((s) => s.url === "/api/embeddings");
    expect(legacy.map((s) => s.body.prompt)).toEqual(["a", "b", "x".repeat(500)]);
    expect(ollama.state.maxInFlight).toBe(1);
  });

  it("does not fall back when /api/embed answers a JSON error (a model that is not pulled)", async () => {
    const ollama = await mockOllama(() => ({
      status: 404,
      body: { error: 'model "nomic-embed-text" not found, try pulling it first' },
    }));
    const { provider } = await createOllamaEmbeddingProvider(options(ollama.baseUrl));

    await expect(provider.embedBatch(["a"])).rejects.toThrow(/HTTP 404/);
    expect(ollama.state.seen.map((s) => s.url)).toEqual(["/api/embed"]);
  });

  it("resolves baseUrl/apiKey/headers from models.providers.ollama and strips /v1", async () => {
    const ollama = await mockOllama(() => ({ status: 200, body: { embeddings: [[1, 0]] } }));
    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: `${ollama.baseUrl}/v1`,
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

    const [request] = ollama.state.seen;
    expect(request?.url).toBe("/api/embed");
    expect(request?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer ollama-local",
      "x-provider-header": "provider",
    });
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

  it("falls back to env key when models.providers.ollama.apiKey is an unresolved SecretRef", async () => {
    const ollama = await mockOllama(() => ({ status: 200, body: { embeddings: [[1, 0]] } }));
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: `${ollama.baseUrl}/v1`,
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

    expect(ollama.state.seen[0]?.headers.authorization).toBe("Bearer ollama-env");
  });

  it("resolves the embedding base URL from remote, then models.providers.ollama, then the default", () => {
    expect(
      resolveOllamaEmbeddingBaseUrl({
        config: {} as OpenClawConfig,
        remote: { baseUrl: " http://embedder:11434/v1/ " },
      }),
    ).toBe("http://embedder:11434");
    expect(
      resolveOllamaEmbeddingBaseUrl({
        config: {
          models: { providers: { ollama: { baseUrl: "http://ollama:11434" } } },
        } as unknown as OpenClawConfig,
      }),
    ).toBe("http://ollama:11434");
    expect(resolveOllamaEmbeddingBaseUrl({ config: {} as OpenClawConfig })).toBe(
      "http://127.0.0.1:11434",
    );
  });
});
