// FORK 2026-10-30: the remote provider behind OpenAI and Mistral hands the call's AbortSignal to
// its request (TINKER_UI_DESIGN_BIBLE/embedder-fit.md). Against a 127.0.0.1 server that takes the
// request and never answers, an abort rejects the call at once and the server sees the connection
// close; a call without a signal still embeds.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createMistralEmbeddingProvider } from "./embeddings-mistral.js";
import { createOpenAiEmbeddingProvider } from "./embeddings-openai.js";
import type { EmbeddingProvider } from "./embeddings.js";

/** How soon an aborted call must reject; before the fix it stayed pending until an answer came. */
const ABORT_PROMPT_MS = 200;

type Loopback = {
  baseUrl: string;
  state: { paths: string[]; closed: number };
  close: () => Promise<void>;
};

const loopbacks: Loopback[] = [];

afterEach(async () => {
  await Promise.all(loopbacks.splice(0).map((server) => server.close()));
});

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

const factories = {
  openai: createOpenAiEmbeddingProvider,
  mistral: createMistralEmbeddingProvider,
};

async function remoteProvider(
  id: keyof typeof factories,
  baseUrl: string,
): Promise<EmbeddingProvider> {
  const { provider } = await factories[id]({
    config: {} as OpenClawConfig,
    provider: id,
    model: "",
    fallback: "none",
    remote: { baseUrl: `${baseUrl}/v1`, apiKey: "loopback-test-key" }, // pragma: allowlist secret
  });
  return provider;
}

describe("createRemoteEmbeddingProvider (OpenAI, Mistral) abort", () => {
  it.each([
    { id: "openai", entry: "embedQuery" },
    { id: "openai", entry: "embedBatch" },
    { id: "mistral", entry: "embedQuery" },
    { id: "mistral", entry: "embedBatch" },
  ] as const)(
    "$id $entry: an abort rejects at once and closes the held request",
    async ({ id, entry }) => {
      const server = await startLoopback("hold");
      const provider = await remoteProvider(id, server.baseUrl);

      await expectAbortStopsTheRequest(server, (signal) =>
        entry === "embedQuery"
          ? provider.embedQuery("q", { signal })
          : provider.embedBatch(["a", "b"], { signal }),
      );
    },
  );

  it.each(["openai", "mistral"] as const)(
    "%s embeds as before when the call carries no signal",
    async (id) => {
      const server = await startLoopback({ data: [{ embedding: [0.1, 0.2] }] });
      const provider = await remoteProvider(id, server.baseUrl);

      await expect(provider.embedQuery("q")).resolves.toEqual([0.1, 0.2]);
      expect(server.state.paths).toEqual(["/v1/embeddings"]);
    },
  );
});
