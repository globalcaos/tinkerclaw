// FORK 2026-10-29: tests for src/fork/embedder-fit-measure.ts against a node:http mock of Ollama that
// answers one request at a time and records what it saw. Every test runs in a temp HOME and a temp
// OPENCLAW_STATE_DIR, and the machine (clock, load, CPU, pressure, keys) is injected, so no test
// reads the host's load or writes outside its own temp dirs.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEmbeddingEndpointBaseUrl } from "../memory/embedding-endpoint.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "../memory/embeddings.js";
import {
  EmbedderFitBusyError,
  FIT_CEILING_MS,
  measureCorpus,
  measurePromptProfile,
  runEmbedderFit,
  type EmbedderFitDeps,
  type RunEmbedderFitOptions,
} from "./embedder-fit-measure.js";
import {
  __resetEmbedderFitForTest,
  cheapFingerprint,
  embedderFitPaths,
  endpointKeyFor,
  MISS_COST_PRIOR,
  NON_ENGLISH_SHARE_PRIOR,
  readEmbedderFit,
  writeEmbedderFit,
  type EmbedderFitRecord,
} from "./embedder-fit.js";

// FORK 2026-10-30: the OpenAI adapter resolves its real client, so a remote fit takes its URL from
// the adapter's own order (memorySearch.remote, then models.providers, then the default). The
// provider answers in this process, so no request leaves the test, and a stand-in key keeps the
// auth store out of it.
vi.mock("../memory/embeddings-openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/embeddings-openai.js")>();
  return {
    ...actual,
    createOpenAiEmbeddingProvider: async (options: EmbeddingProviderOptions) => {
      const client = await actual.resolveOpenAiEmbeddingClient({
        ...options,
        remote: { ...options.remote, apiKey: "fit-test-key" }, // pragma: allowlist secret
      });
      const provider: EmbeddingProvider = {
        id: "openai",
        model: client.model,
        embedQuery: async (text) => vectorOf(text),
        embedBatch: async (texts, opts) => {
          // Server-side numbers, as the Ollama mock below reports them: 5 ms per input.
          opts?.onMeasure?.({
            inputs: texts.length,
            chars: texts.reduce((n, text) => n + text.length, 0),
            promptEvalCount: texts.reduce((n, text) => n + Math.ceil(text.length / 4), 0),
            totalDurationNs: 5e6 * texts.length,
            wallMs: 5 * texts.length,
          });
          return texts.map(vectorOf);
        },
      };
      return { client, provider };
    },
  };
});

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const DAY_MS = 86_400_000;
const OPENAI_MODEL = "text-embedding-3-small";
const LAN_SERVER = "http://10.1.2.3:9000/v1";

type Seen = { method: string; url: string; body: Record<string, unknown>; overlapped: boolean };

type MockOllama = {
  baseUrl: string;
  seen: Seen[];
  maxInFlight: () => number;
  close: () => Promise<void>;
};

const servers: MockOllama[] = [];
let home = "";
let stateDir = "";
let workspace = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "embedder-fit-measure-"));
  stateDir = path.join(home, "state");
  workspace = path.join(home, "workspace");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "MEMORY.md"),
    "# Notes\n\nThe delivery van leaves at seven.\n",
  );
  fs.writeFileSync(path.join(workspace, "memory", "garden.md"), "Water the tomatoes early.\n");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  __resetEmbedderFitForTest();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  fs.rmSync(home, { recursive: true, force: true });
});

/** Bag of longer words: texts that share content words point the same way, unrelated ones do not. */
function vectorOf(text: string): number[] {
  const vector = Array.from({ length: 256 }, () => 0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (word.length <= 3) {
      continue;
    }
    let h = 0;
    for (const ch of word) {
      h = (h * 31 + ch.charCodeAt(0)) % 256;
    }
    vector[h] += 1;
  }
  return vector;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** One slot, like an Ollama runner with OLLAMA_NUM_PARALLEL=1: requests queue and run one by one. */
async function mockOllama(opts: {
  installed: string[];
  onEmbed?: () => void;
}): Promise<MockOllama> {
  const installed = new Set(opts.installed);
  const loaded = new Set<string>();
  const seen: Seen[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let queue: Promise<void> = Promise.resolve();

  const answer = async (s: Seen, res: http.ServerResponse): Promise<void> => {
    const model = typeof s.body.model === "string" ? s.body.model : "";
    if (s.method === "GET" && s.url === "/api/version") {
      sendJson(res, 200, { version: "0.0.0-test" });
    } else if (s.method === "GET" && s.url === "/api/tags") {
      sendJson(res, 200, {
        models: [...installed].map((name, i) => ({ name, model: name, digest: `sha256:${i}` })),
      });
    } else if (s.method === "GET" && s.url === "/api/ps") {
      sendJson(res, 200, {
        models: [...loaded].map((name) => ({ name, model: name, size: 100 * MIB, size_vram: 0 })),
      });
    } else if (s.method === "POST" && s.url === "/api/pull") {
      installed.add(model);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({ status: "pulling manifest" })}\n${JSON.stringify({ status: "success" })}\n`,
      );
    } else if (s.method === "POST" && s.url === "/api/embed") {
      if (!installed.has(model)) {
        sendJson(res, 404, { error: `model "${model}" not found, try pulling it first` });
        return;
      }
      opts.onEmbed?.();
      const input = Array.isArray(s.body.input) ? s.body.input.map(String) : [];
      const loadMs = loaded.has(model) ? 0 : 2;
      const serviceMs = 5 * input.length;
      loaded.add(model);
      await new Promise((resolve) => setTimeout(resolve, serviceMs + loadMs));
      if (s.body.keep_alive === "0") {
        loaded.delete(model);
      }
      sendJson(res, 200, {
        model,
        embeddings: input.map(vectorOf),
        prompt_eval_count: input.reduce((n, text) => n + Math.ceil(text.length / 4), 0),
        total_duration: (serviceMs + loadMs) * 1e6,
        load_duration: loadMs * 1e6,
      });
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const s: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        overlapped: inFlight > 1,
      };
      seen.push(s);
      queue = queue
        .then(() => answer(s, res))
        .catch(() => undefined)
        .finally(() => {
          inFlight -= 1;
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const mock: MockOllama = {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    maxInFlight: () => maxInFlight,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(mock);
  return mock;
}

function cfgFor(baseUrl: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace } },
    models: { providers: { ollama: { baseUrl, models: [] } } },
  } as unknown as OpenClawConfig;
}

function machine(overrides: Partial<EmbedderFitDeps> = {}): Partial<EmbedderFitDeps> {
  return {
    sleep: async () => undefined,
    loadavg: () => [0, 0, 0],
    memAvailableBytes: () => 8 * GIB,
    totalMemBytes: () => 16 * GIB,
    cpuTimes: () => undefined,
    readPsi: () => undefined,
    hasNodeLlamaCpp: async () => false,
    hasRemoteKey: async () => false,
    lowerPriority: () => undefined,
    confirm: async () => false,
    ...overrides,
  };
}

function fit(baseUrl: string, over: Partial<RunEmbedderFitOptions> = {}) {
  return runEmbedderFit({
    cfg: cfgFor(baseUrl),
    interactive: false,
    allowPull: false,
    background: false,
    deps: machine(),
    ...over,
  });
}

const embedsOf = (mock: MockOllama): Seen[] =>
  mock.seen.filter((s) => s.url.startsWith("/api/embed"));
const pullsOf = (mock: MockOllama): unknown[] =>
  mock.seen.filter((s) => s.url === "/api/pull").map((s) => s.body.model);

/** A key resolves for openai and for no other remote provider. */
const openAiKeyOnly = async (providerId: string): Promise<boolean> => providerId === "openai";

/** cfgFor, plus where openai is configured: models.providers.openai and memorySearch.remote. */
function remoteCfg(ollamaUrl: string, at: { openai?: string; remote?: string }): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace,
        ...(at.remote ? { memorySearch: { remote: { baseUrl: at.remote } } } : {}),
      },
    },
    models: {
      providers: {
        ollama: { baseUrl: ollamaUrl, models: [] },
        ...(at.openai ? { openai: { baseUrl: at.openai, models: [] } } : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

/** The URL the memory index, skill search and the prefrontal lane hand openai's governor. */
async function runtimeOpenAiUrl(cfg: OpenClawConfig): Promise<string> {
  const url = await resolveEmbeddingEndpointBaseUrl({
    providerId: "openai",
    config: cfg,
    remote: resolveMemorySearchConfig(cfg, "main")?.remote,
  });
  if (!url) {
    throw new Error("the runtime resolver gave openai no URL");
  }
  return url;
}

/** An earlier fit that chose openai, measured at `baseUrl`, with the owner's recorded consent. */
function remoteDecisionRecord(baseUrl: string): EmbedderFitRecord {
  const local = (value: number, unit: string) => ({
    value,
    unit,
    provenance: "local-measured" as const,
    source: "test fixture",
  });
  return {
    schemaVersion: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    fingerprint: cheapFingerprint(),
    inventory: {
      ollama: { baseUrl: "http://127.0.0.1:9", reachable: false, models: [] },
      nodeLlamaCpp: false,
      remoteKeys: ["openai"],
    },
    candidates: [
      {
        provider: "openai",
        model: OPENAI_MODEL,
        baseUrl,
        queryP50Ms: 250,
        queryP95Ms: 700,
        tokensPerSec: local(4000, "tokens/s"),
        tokensPerSecLow95: 3000,
        tokensPerSecHigh95: 5000,
        batchDispersion: 2,
        overheadMs: 200,
        sanityOk: true,
      },
    ],
    missCostSec: { ...MISS_COST_PRIOR },
    nonEnglishShare: { ...NON_ENGLISH_SHARE_PRIOR },
    fitWallSeconds: local(30, "s"),
    decision: {
      mode: "memory",
      provider: "openai",
      model: OPENAI_MODEL,
      dormantUntilDemand: true,
      reasons: ["fixture: an earlier fit chose openai"],
      verdicts: [],
    },
    consent: { remote: { provider: "openai", grantedAt: "2026-10-29T08:00:00.000Z", via: "flag" } },
    tool: { command: "openclaw embedder fit --allow-remote openai", version: "test" },
    history: [],
  };
}

/** The governor's snapshot file: one openai endpoint that counted `demandPerDay` real searches. */
function writeGovernorSnapshot(endpointKey: string, demandPerDay: number): void {
  const file = embedderFitPaths(stateDir).governor;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const day = Math.floor(Date.now() / DAY_MS);
  const snapshot = {
    schemaVersion: 1,
    endpointKey,
    providerId: "openai",
    model: OPENAI_MODEL,
    endpointClass: "remote",
    days: [{ day, agent: 30, rpc: 10, probe: 0, internal: 0 }],
    derived: { demandPerDay },
  };
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      governors: { [endpointKey]: snapshot },
    }),
  );
}

describe("runEmbedderFit against a one-slot Ollama", () => {
  it("measures the cheapest installed preferred model through /api/embed, one request in flight except the two-in-flight probe", async () => {
    const ollama = await mockOllama({ installed: ["granite-embedding:30m"] });
    const record = await fit(ollama.baseUrl);

    expect(record.candidates.map((c) => c.model)).toEqual(["granite-embedding:30m"]);
    const embeds = embedsOf(ollama);
    expect(embeds.length).toBeGreaterThan(20);
    for (const e of embeds) {
      expect(e.url).toBe("/api/embed");
      expect(Array.isArray(e.body.input)).toBe(true);
      expect(e.body.truncate).toBe(true);
      expect(typeof e.body.keep_alive).toBe("string");
    }
    // The only overlap is the deliberate probe: throughput batches of 4 passages, 2 at a time.
    expect(ollama.maxInFlight()).toBe(2);
    const overlapped = ollama.seen.filter((s) => s.overlapped);
    expect(overlapped.length).toBeGreaterThan(0);
    for (const s of overlapped) {
      expect(s.url).toBe("/api/embed");
      expect(s.body.input).toHaveLength(4);
    }
    const [candidate] = record.candidates;
    expect(candidate.sanityOk).toBe(true);
    expect(candidate.rssBytes).toBe(100 * MIB);
    expect(candidate.coldLoadMs).toBeGreaterThan(0);
    expect(candidate.tokensPerSec.n).toBeGreaterThanOrEqual(3);
    expect(candidate.tokensPerSecLow95).toBeLessThanOrEqual(candidate.tokensPerSec.value);
    expect(candidate.tokensPerSecHigh95).toBeGreaterThanOrEqual(candidate.tokensPerSec.value);
    expect(record.decision).toMatchObject({ mode: "memory", model: "granite-embedding:30m" });
  });

  it("pulls only with allowPull, and never in background mode", async () => {
    // The mock is fast, so the next preferred model's predicted extra cost is negligible and the
    // prediction says it would be chosen: whether it is pulled depends on the download rule alone.
    const quiet = await mockOllama({ installed: ["granite-embedding:30m"] });
    const noPull = await fit(quiet.baseUrl);
    expect(pullsOf(quiet)).toEqual([]);
    expect(noPull.decision.reasons.join("\n")).toMatch(
      /granite-embedding:278m would pass every gate.*no download was allowed/,
    );

    const lowerPriority = vi.fn();
    const busy = await mockOllama({ installed: ["granite-embedding:30m"] });
    await fit(busy.baseUrl, {
      interactive: true,
      allowPull: true,
      background: true,
      deps: machine({ lowerPriority, confirm: async () => true }),
    });
    expect(pullsOf(busy)).toEqual([]);
    expect(lowerPriority).toHaveBeenCalledTimes(1);

    const allowed = await mockOllama({ installed: ["granite-embedding:30m"] });
    const pulled = await fit(allowed.baseUrl, { allowPull: true });
    expect(pullsOf(allowed)).toEqual(["granite-embedding:278m"]);
    expect(pulled.candidates.map((c) => c.model)).toEqual([
      "granite-embedding:30m",
      "granite-embedding:278m",
    ]);
    expect(pulled.inventory.ollama.models.map((m) => m.name)).toContain("granite-embedding:278m");
  });

  it("gives every number in the record a provenance and a source", async () => {
    const ollama = await mockOllama({ installed: ["granite-embedding:30m"] });
    const record = await fit(ollama.baseUrl);
    const allowed = new Set([
      "per-call-measured",
      "turn-aggregate",
      "local-measured",
      "estimated",
      "third-party-reported",
    ]);
    const found: Array<{ at: string; value: Record<string, unknown> }> = [];
    const walk = (value: unknown, at: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${at}[${i}]`));
        return;
      }
      if (!value || typeof value !== "object") {
        return;
      }
      const obj = value as Record<string, unknown>;
      if (typeof obj.value === "number" && typeof obj.unit === "string") {
        found.push({ at, value: obj });
      }
      for (const [key, child] of Object.entries(obj)) {
        walk(child, `${at}.${key}`);
      }
    };
    walk(record, "record");
    expect(found.length).toBeGreaterThan(10);
    for (const m of found) {
      expect(allowed.has(String(m.value.provenance)), m.at).toBe(true);
      expect(typeof m.value.source === "string" && m.value.source.length > 0, m.at).toBe(true);
    }
    expect(record.corpus?.tokens.provenance).toBe("estimated");
    expect(record.corpus?.ingestTokensPerDay.provenance).toBe("estimated");
    expect(record.fitWallSeconds.provenance).toBe("local-measured");
    expect(record.candidates[0]?.tokensPerSec.provenance).toBe("local-measured");
    // No transcripts in the temp state dir: both priors stand in, labelled as priors.
    expect(record.missCostSec).toMatchObject({
      value: MISS_COST_PRIOR.value,
      provenance: "third-party-reported",
    });
    expect(record.nonEnglishShare).toMatchObject({
      value: NON_ENGLISH_SHARE_PRIOR.value,
      provenance: "estimated",
    });
  });

  it("stops at the 5-minute ceiling, writes what was measured and says so (fake clock)", async () => {
    let now = 1_700_000_000_000;
    const ollama = await mockOllama({
      installed: ["granite-embedding:30m"],
      onEmbed: () => {
        now += 20_000;
      },
    });
    const record = await fit(ollama.baseUrl, { deps: machine({ now: () => now }) });

    expect(record.candidates).toEqual([]);
    expect(record.decision.mode).toBe("off");
    expect(record.decision.reasons.join("\n")).toMatch(/5-minute ceiling/);
    expect(embedsOf(ollama).length).toBeLessThanOrEqual(FIT_CEILING_MS / 20_000 + 1);
    expect(record.fitWallSeconds.value).toBeGreaterThanOrEqual(FIT_CEILING_MS / 1000);
    expect(readEmbedderFit(stateDir)?.createdAt).toBe(record.createdAt);
  });

  it("works only inside the temp HOME and OPENCLAW_STATE_DIR, and releases its lock", async () => {
    const ollama = await mockOllama({ installed: [] });
    const record = await fit(ollama.baseUrl);

    expect(os.homedir()).toBe(home);
    const paths = embedderFitPaths(stateDir);
    expect(paths.record.startsWith(home)).toBe(true);
    expect(fs.existsSync(paths.record)).toBe(true);
    expect(fs.statSync(paths.record).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(record.decision.mode).toBe("off");
    expect(record.decision.proposal?.command).toBe("openclaw embedder fit --pull");
    expect(pullsOf(ollama)).toEqual([]);
  });

  it("refuses while a live fit holds the lock, and takes over a stale one", async () => {
    const ollama = await mockOllama({ installed: [] });
    const lock = embedderFitPaths(stateDir).lock;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));

    await expect(fit(ollama.baseUrl)).rejects.toBeInstanceOf(EmbedderFitBusyError);
    expect(fs.existsSync(lock)).toBe(true);

    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(lock, old, old);
    const record = await fit(ollama.baseUrl);
    expect(record.decision.mode).toBe("off");
    expect(fs.existsSync(lock)).toBe(false);
  });
});

// FORK 2026-10-30: every HTTP provider's governor is keyed by the URL its client calls, so a
// consented remote provider is measured at the URL the runtime will call and recorded with it, and
// a re-fit reads that endpoint's demand from the governor's snapshot.
describe("runEmbedderFit with a consented remote provider", () => {
  it.each<{ name: string; openai?: string; viaRemote?: boolean }>([
    { name: "the adapter's default" },
    { name: "models.providers.openai.baseUrl", openai: LAN_SERVER },
    {
      name: "memorySearch.remote.baseUrl over models.providers",
      openai: LAN_SERVER,
      viaRemote: true,
    },
  ])(
    "measures it where the runtime calls it and records that URL: $name",
    async ({ openai, viaRemote }) => {
      const ollama = await mockOllama({ installed: [] });
      // memorySearch.remote serves whichever provider memory search uses, so under 'auto' the
      // fit's Ollama probe goes there too: a local server that lists no model.
      const remote = viaRemote ? `${(await mockOllama({ installed: [] })).baseUrl}/v1` : undefined;
      const cfg = remoteCfg(ollama.baseUrl, { openai, remote });

      const record = await fit(ollama.baseUrl, {
        cfg,
        allowRemote: "openai",
        deps: machine({ hasRemoteKey: openAiKeyOnly }),
      });

      expect(record.decision).toMatchObject({
        mode: "memory",
        provider: "openai",
        model: OPENAI_MODEL,
      });
      const measuredAt = record.candidates.find((c) => c.provider === "openai")?.baseUrl;
      expect(measuredAt).toBe(remote ?? openai ?? "https://api.openai.com/v1");
      expect(endpointKeyFor({ providerId: "openai", baseUrl: measuredAt })).toBe(
        endpointKeyFor({ providerId: "openai", baseUrl: await runtimeOpenAiUrl(cfg) }),
      );
    },
  );

  it("reads a remote decision's demand from the governor snapshot under the URL it calls", async () => {
    const ollama = await mockOllama({ installed: [] });
    const cfg = cfgFor(ollama.baseUrl);
    const calls = await runtimeOpenAiUrl(cfg);
    const governorKey = endpointKeyFor({ providerId: "openai", baseUrl: calls });
    // The earlier fit chose openai at that URL, and the governor has since counted 40 real
    // searches a day there.
    writeEmbedderFit(remoteDecisionRecord(calls), stateDir);
    writeGovernorSnapshot(governorKey, 40);

    const record = await fit(ollama.baseUrl, { deps: machine({ hasRemoteKey: openAiKeyOnly }) });

    const demand = record.decision.verdicts.find((v) => v.name === "demand");
    expect(demand?.inputs.demandPerDay).toMatchObject({ value: 40, provenance: "local-measured" });
    expect(demand?.inputs.demandPerDay?.source).toContain(governorKey);
  });
});

describe("measurePromptProfile", () => {
  const line = (at: number, role: string, content: unknown): string =>
    JSON.stringify({
      type: "message",
      timestamp: new Date(at).toISOString(),
      message: { role, content },
    });
  const tag = (i: number): string =>
    String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));

  it("measures the miss cost and the non-English share from transcripts, and keeps no prompt text", async () => {
    const dir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    let t = Date.UTC(2026, 9, 1, 8, 0, 0);
    for (let i = 0; i < 60; i += 1) {
      const prompt =
        i % 4 === 0
          ? `Por favor revisa la lista del jardín y dime qué falta en ${tag(i)}`
          : `Please check the garden list and tell me what is missing in ${tag(i)}`;
      lines.push(line(t, "user", [{ type: "text", text: prompt }]));
      t += 1000;
      lines.push(line(t, "assistant", [{ type: "toolCall", name: "read" }]));
      t += 2000;
      lines.push(line(t, "toolResult", [{ type: "text", text: "ok" }]));
      t += i < 35 ? 10_000 : 40_000;
      lines.push(line(t, "assistant", [{ type: "text", text: "Done." }]));
      t += 60_000;
    }
    fs.writeFileSync(path.join(dir, "session-a.jsonl"), `${lines.join("\n")}\n`);

    const profile = await measurePromptProfile(cfgFor("http://127.0.0.1:9"));

    expect(profile.transcriptsRead).toBe(1);
    expect(profile.missCostSec).toMatchObject({
      value: 10,
      unit: "s",
      n: 60,
      provenance: "local-measured",
    });
    expect(profile.nonEnglishShare).toMatchObject({
      value: 0.25,
      n: 60,
      denominator: "typed prompts",
      provenance: "local-measured",
    });
    expect(JSON.stringify(profile)).not.toMatch(/jard|garden/i);
  });

  it("falls back to the labelled priors with too few steps and prompts", async () => {
    const profile = await measurePromptProfile(cfgFor("http://127.0.0.1:9"));
    expect(profile.missCostSec).toEqual({ ...MISS_COST_PRIOR });
    expect(profile.nonEnglishShare).toEqual({ ...NON_ENGLISH_SHARE_PRIOR });
    expect(profile.transcriptsRead).toBe(0);
  });
});

describe("measureCorpus", () => {
  it("reads tokens, the 14-day ingest upper bound and the burst from memory-file times", async () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    fs.rmSync(path.join(workspace, "MEMORY.md"));
    fs.rmSync(path.join(workspace, "memory", "garden.md"));
    const write = (name: string, bytes: number, ageDays: number): void => {
      const file = path.join(workspace, "memory", name);
      fs.writeFileSync(file, "a".repeat(bytes));
      const at = new Date(now - ageDays * DAY_MS - 1000);
      fs.utimesSync(file, at, at);
    };
    write("today.md", 1000, 0);
    write("three-days.md", 3000, 3);
    write("old.md", 500, 20);

    const corpus = await measureCorpus(cfgFor("http://127.0.0.1:9"), { now: () => now });

    expect(corpus?.files).toBe(3);
    expect(corpus?.tokens).toMatchObject({ value: 1125, provenance: "estimated" });
    // 4,000 bytes changed in 14 days / 14 / 4 characters per token, and a 3,000-byte peak day.
    expect(corpus?.ingestTokensPerDay).toMatchObject({ value: 71.4, provenance: "estimated" });
    expect(corpus?.burstFactor.value).toBeCloseTo(3000 / (4000 / 14), 2);
    expect(corpus?.chunkTokens).toBe(400);
    expect(corpus?.overlapTokens).toBe(80);
  });
});
