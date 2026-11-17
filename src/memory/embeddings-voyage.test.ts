import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchMock, withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createModelAuthMockModule } = await import("../test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

const createFetchMock = () => {
  const fetchMock = vi.fn<FetchMock>(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  return withFetchPreconnect(fetchMock);
};

let authModule: typeof import("../agents/model-auth.js");
let createVoyageEmbeddingProvider: typeof import("./embeddings-voyage.js").createVoyageEmbeddingProvider;
let normalizeVoyageModel: typeof import("./embeddings-voyage.js").normalizeVoyageModel;

beforeEach(async () => {
  authModule = await import("../agents/model-auth.js");
  ({ createVoyageEmbeddingProvider, normalizeVoyageModel } =
    await import("./embeddings-voyage.js"));
});

function mockVoyageApiKey() {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey: "voyage-key-123",
    mode: "api-key",
    source: "test",
  });
}

async function createDefaultVoyageProvider(
  model: string,
  fetchMock: ReturnType<typeof createFetchMock>,
) {
  vi.stubGlobal("fetch", fetchMock);
  mockPublicPinnedHostname();
  mockVoyageApiKey();
  return createVoyageEmbeddingProvider({
    config: {} as never,
    provider: "voyage",
    model,
    fallback: "none",
  });
}

describe("voyage embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    const fetchMock = createFetchMock();
    const result = await createDefaultVoyageProvider("voyage-4-large", fetchMock);

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "voyage" }),
    );

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer voyage-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "voyage-4-large",
      input: ["test query"],
      input_type: "query",
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    mockPublicPinnedHostname();

    const result = await createVoyageEmbeddingProvider({
      config: {} as never,
      provider: "voyage",
      model: "voyage-4-lite",
      fallback: "none",
      remote: {
        baseUrl: "https://example.com",
        apiKey: "remote-override-key",
        headers: { "X-Custom": "123" },
      },
    });

    await result.provider.embedQuery("test");

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://example.com/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-override-key");
    expect(headers["X-Custom"]).toBe("123");
  });

  it("passes input_type=document for embedBatch", async () => {
    const fetchMock = withFetchPreconnect(
      vi.fn<FetchMock>(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const result = await createDefaultVoyageProvider("voyage-4-large", fetchMock);

    await result.provider.embedBatch(["doc1", "doc2"]);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit | undefined];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "voyage-4-large",
      input: ["doc1", "doc2"],
      input_type: "document",
    });
  });

  it("normalizes model names", async () => {
    expect(normalizeVoyageModel("voyage/voyage-large-2")).toBe("voyage-large-2");
    expect(normalizeVoyageModel("voyage-4-large")).toBe("voyage-4-large");
    expect(normalizeVoyageModel("  voyage-lite  ")).toBe("voyage-lite");
    expect(normalizeVoyageModel("")).toBe("voyage-4-large"); // Default
  });
});

// FORK 2026-10-30: the call's AbortSignal reaches Voyage's request
// (TINKER_UI_DESIGN_BIBLE/embedder-fit.md). Against a 127.0.0.1 server that takes the request and
// never answers, an abort rejects the call at once and the server sees the connection close; a
// call without a signal still embeds.

/** How soon an aborted call must reject; before the fix it stayed pending until an answer came. */
const ABORT_PROMPT_MS = 200;

type Loopback = {
  baseUrl: string;
  state: { paths: string[]; closed: number };
  close: () => Promise<void>;
};

const loopbacks: Loopback[] = [];

/**
 * A server on 127.0.0.1 and an ephemeral port. It answers every request with `reply` as JSON, or
 * for "hold" reads the request and never answers. `state.closed` counts the connections that close.
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

/**
 * Starts a call against a server that holds it and aborts it once the server has the request. The
 * call must reject within ABORT_PROMPT_MS and the server must see the connection close. The race
 * keeps the control from hanging: on the code before the fix it came back "still pending".
 */
async function expectAbortStopsTheRequest(
  server: Loopback,
  start: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const controller = new AbortController();
  const outcome = start(controller.signal).then(
    () => "resolved",
    (err: unknown) => err,
  );
  await vi.waitFor(() => expect(server.state.paths).toHaveLength(1), { timeout: 5_000 });
  controller.abort();
  const settled = await Promise.race([outcome, sleep(ABORT_PROMPT_MS, "still pending")]);
  expect(settled).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(server.state.closed).toBe(1), { timeout: 2_000 });
}

describe("voyage embedding provider abort", () => {
  beforeEach(() => {
    // Tests above stub the hostname resolver with a public address; the real one keeps these
    // requests on 127.0.0.1.
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await Promise.all(loopbacks.splice(0).map((server) => server.close()));
  });

  async function loopbackVoyage(baseUrl: string) {
    const { provider } = await createVoyageEmbeddingProvider({
      config: {} as never,
      provider: "voyage",
      model: "voyage-4-large",
      fallback: "none",
      remote: { baseUrl, apiKey: "loopback-test-key" }, // pragma: allowlist secret
    });
    return provider;
  }

  it.each(["embedQuery", "embedBatch"] as const)(
    "%s: an abort rejects at once and closes the held request",
    async (entry) => {
      const server = await startLoopback("hold");
      const provider = await loopbackVoyage(server.baseUrl);

      await expectAbortStopsTheRequest(server, (signal) =>
        entry === "embedQuery"
          ? provider.embedQuery("q", { signal })
          : provider.embedBatch(["a", "b"], { signal }),
      );
    },
  );

  it("embeds as before when the call carries no signal", async () => {
    const server = await startLoopback({ data: [{ embedding: [0.1, 0.2] }] });
    const provider = await loopbackVoyage(server.baseUrl);

    await expect(provider.embedQuery("q")).resolves.toEqual([0.1, 0.2]);
    expect(server.state.paths).toEqual(["/embeddings"]);
  });
});
