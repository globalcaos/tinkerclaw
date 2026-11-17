// FORK 2026-10-29: `openclaw embedder status` on a fixture record and governor snapshot, `openclaw
// embedder fit` without a terminal (it never asks and downloads only with --pull), and the sub-CLI
// wiring. Temp HOME and OPENCLAW_STATE_DIR; Ollama is a node:http mock; the machine is injected.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbedderFitDeps } from "../fork/embedder-fit-measure.js";
import {
  __resetEmbedderFitForTest,
  cheapFingerprint,
  embedderFitPaths,
  endpointKeyFor,
  writeEmbedderFit,
  type CandidateMeasurement,
  type EmbedderFitRecord,
} from "../fork/embedder-fit.js";
import { resolveEmbeddingEndpointBaseUrl } from "../memory/embedding-endpoint.js";
import {
  formatEmbedderStatus,
  readEmbedderStatus,
  registerEmbedderCli,
  runEmbedderFitCommand,
  runEmbedderStatusCommand,
} from "./embedder-cli.js";

const GIB = 2 ** 30;
const ENDPOINT = "http://127.0.0.1:11434";
const ENDPOINT_KEY = "ollama|http://127.0.0.1:11434";
const OPENAI_MODEL = "text-embedding-3-small";

/** The endpoint a governor snapshot describes. */
type SnapshotAt = { key: string; providerId: string; model: string; endpointClass: string };

const OLLAMA_AT: SnapshotAt = {
  key: ENDPOINT_KEY,
  providerId: "ollama",
  model: "granite-embedding:30m",
  endpointClass: "local-http",
};

type MockOllama = { baseUrl: string; pulls: () => number; close: () => Promise<void> };

const servers: MockOllama[] = [];
let home = "";
let stateDir = "";
let workspace = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "embedder-cli-"));
  stateDir = path.join(home, "state");
  workspace = path.join(home, "workspace");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# Notes\n\nThe van leaves at seven.\n");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  __resetEmbedderFitForTest();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  fs.rmSync(home, { recursive: true, force: true });
});

function capture() {
  const out = { logs: [] as string[], errors: [] as string[], json: [] as unknown[] };
  const runtime = {
    log: (...args: unknown[]) => {
      out.logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      out.errors.push(args.map(String).join(" "));
    },
    writeJson: (value: unknown) => {
      out.json.push(value);
    },
  };
  return { out, runtime };
}

/** An Ollama with nothing pulled: it lists no models and counts any pull it is asked for. */
async function mockOllama(): Promise<MockOllama> {
  let pulls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/api/pull") {
        pulls += 1;
      }
      const known = req.url === "/api/version" || req.url === "/api/tags" || req.url === "/api/ps";
      const body =
        req.url === "/api/version"
          ? { version: "0.0.0-test" }
          : known
            ? { models: [] }
            : { error: "not found" };
      res.writeHead(known ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const mock: MockOllama = {
    baseUrl: `http://127.0.0.1:${port}`,
    pulls: () => pulls,
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
    ...overrides,
  };
}

function fixtureRecord(): EmbedderFitRecord {
  const measured = (value: number, unit: string) => ({
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
      ollama: {
        baseUrl: ENDPOINT,
        reachable: true,
        models: [{ name: "granite-embedding:30m", digest: "sha256:0" }],
      },
      nodeLlamaCpp: false,
      remoteKeys: [],
    },
    candidates: [],
    missCostSec: measured(21.57, "s"),
    nonEnglishShare: measured(0.022, "share"),
    fitWallSeconds: measured(150, "s"),
    decision: {
      mode: "memory",
      provider: "ollama",
      model: "granite-embedding:30m",
      demandBreakEvenPerDay: 468,
      dormantUntilDemand: true,
      reasons: ["granite-embedding:30m: the cheapest preferred model that passed every gate"],
      verdicts: [
        {
          name: "keep-up",
          model: "granite-embedding:30m",
          objective: "fixture",
          value: 87.8,
          breakEven: 6.12,
          pass: true,
          formula: "fixture",
          inputs: { minIdleShare: measured(0.07, "share of wall time") },
        },
      ],
    },
    consent: { remote: null },
    tool: { command: "openclaw embedder fit", version: "test" },
    history: [],
  };
}

/** A fit that chose openai with recorded consent; `baseUrl` is where it measured, when it kept one. */
function remoteRecord(baseUrl?: string): EmbedderFitRecord {
  const base = fixtureRecord();
  const candidate: CandidateMeasurement = {
    provider: "openai",
    model: OPENAI_MODEL,
    ...(baseUrl ? { baseUrl } : {}),
    queryP50Ms: 250,
    queryP95Ms: 700,
    tokensPerSec: {
      value: 4000,
      unit: "tokens/s",
      provenance: "local-measured",
      source: "test fixture",
    },
    tokensPerSecLow95: 3000,
    tokensPerSecHigh95: 5000,
    batchDispersion: 2,
    overheadMs: 200,
    sanityOk: true,
  };
  return {
    ...base,
    candidates: [candidate],
    decision: {
      ...base.decision,
      provider: "openai",
      model: OPENAI_MODEL,
      dormantUntilDemand: false,
      verdicts: [],
    },
    consent: { remote: { provider: "openai", grantedAt: base.createdAt, via: "flag" } },
  };
}

function writeSnapshot(at: SnapshotAt = OLLAMA_AT): void {
  const file = embedderFitPaths(stateDir).governor;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const day = Math.floor(Date.now() / 86_400_000);
  const bucket = {
    day,
    agent: 2,
    rpc: 1,
    probe: 5,
    internal: 0,
    scanMsSum: 0,
    scanN: 0,
    calls: 0,
    failures: 0,
    deadlines: 0,
    refusedBusy: 0,
    refusedOverBudget: 0,
    refusedBreaker: 0,
    breakerTrips: 0,
    tokensForeground: 0,
    tokensBackground: 0,
    wallMsForeground: 0,
    wallMsBackground: 0,
  };
  const snapshot = {
    schemaVersion: 1,
    endpointKey: at.key,
    providerId: at.providerId,
    model: at.model,
    endpointClass: at.endpointClass,
    mode: "fit",
    savedAt: new Date().toISOString(),
    firstDay: day,
    accountedDay: day - 1,
    breaker: { state: "closed", consecutiveFailures: 0, consecutiveTrips: 0, cleanCalls: 16 },
    days: [bucket],
    sources: {},
    stepDown: { level: 0 },
    dormant: true,
    trials: { prefrontal: { invocations: 3, recoveries: 0 } },
    contention: { duringSum: 0, duringN: 0, outsideSum: 0, outsideN: 0 },
    derived: { failureThreshold: 4, demandPerDay: 3, pendingTokens: 0 },
  };
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      governors: { [at.key]: snapshot },
    }),
  );
}

describe("openclaw embedder status", () => {
  it("--json reads the record and the governor snapshot, with no gateway call", () => {
    writeEmbedderFit(fixtureRecord(), stateDir);
    writeSnapshot();
    const { out, runtime } = capture();

    runEmbedderStatusCommand({ json: true }, { runtime, stateDir });

    expect(out.errors).toEqual([]);
    expect(out.json).toHaveLength(1);
    expect(out.json[0]).toMatchObject({
      mode: "memory",
      provider: "ollama",
      model: "granite-embedding:30m",
      state: "dormant",
      stateFrom: "governor",
      demandBreakEvenPerDay: 468,
      keepUp: { k: 87.8, burst: 6.12, minIdleShare: 0.07 },
      endpointKey: ENDPOINT_KEY,
      breaker: { state: "closed", consecutiveFailures: 0 },
      demand: { perDay: 3, agent: 2, rpc: 1, probe: 5, internal: 0, days: 1 },
      trials: { prefrontal: { invocations: 3, recoveries: 0 } },
      fingerprintChanged: [],
    });
  });

  it("names the state, Q*, keep-up, the breaker, demand by caller and the trials in text", () => {
    writeEmbedderFit(fixtureRecord(), stateDir);
    writeSnapshot();

    const text = formatEmbedderStatus(readEmbedderStatus({ stateDir })).join("\n");

    expect(text).toMatch(/granite-embedding:30m/);
    expect(text).toMatch(/state: dormant/);
    expect(text).toMatch(/Q\* 468\/day/);
    expect(text).toMatch(/K 87\.8/);
    expect(text).toMatch(/breaker: closed/);
    expect(text).toMatch(/agent 2, rpc 1/);
    expect(text).toMatch(/prefrontal 3 invocations, 0 recoveries/);
  });

  // FORK 2026-10-30: every HTTP provider's governor is keyed by the URL its client calls, so the
  // status of a remote decision reads the snapshot under the URL the fit measured the provider at.
  it("finds a remote decision's governor snapshot under the URL its provider calls", async () => {
    const calls = await resolveEmbeddingEndpointBaseUrl({ providerId: "openai", config: {} });
    const key = endpointKeyFor({ providerId: "openai", baseUrl: calls });
    expect(key).toBe("openai|https://api.openai.com");
    writeEmbedderFit(remoteRecord(calls), stateDir);
    writeSnapshot({ key, providerId: "openai", model: OPENAI_MODEL, endpointClass: "remote" });

    expect(readEmbedderStatus({ stateDir })).toMatchObject({
      provider: "openai",
      model: OPENAI_MODEL,
      endpointKey: key,
      state: "dormant",
      stateFrom: "governor",
      demand: { perDay: 3, agent: 2, rpc: 1 },
      trials: { prefrontal: { invocations: 3, recoveries: 0 } },
    });
  });

  it("looks up a remote record that kept no URL by the provider id alone, as before", () => {
    writeEmbedderFit(remoteRecord(), stateDir);
    writeSnapshot({
      key: "openai|https://api.openai.com",
      providerId: "openai",
      model: OPENAI_MODEL,
      endpointClass: "remote",
    });

    const status = readEmbedderStatus({ stateDir });
    expect(status).toMatchObject({
      endpointKey: "openai",
      state: "armed",
      stateFrom: "fit-record",
    });
    expect(status.demand).toBeUndefined();
  });

  it("says when this machine was never measured, and still returns normally", () => {
    const { out, runtime } = capture();

    runEmbedderStatusCommand({}, { runtime, stateDir });

    expect(out.logs.join("\n")).toMatch(/not measured on this machine yet/);
    expect(out.errors).toEqual([]);
  });
});

describe("openclaw embedder fit", () => {
  it("without a terminal and without --pull makes zero pulls and asks nothing", async () => {
    const ollama = await mockOllama();
    const confirm = vi.fn(async () => true);
    const { out, runtime } = capture();

    const code = await runEmbedderFitCommand(
      { json: true },
      {
        runtime,
        stateDir,
        isTTY: false,
        signal: new AbortController().signal,
        config: () => cfgFor(ollama.baseUrl),
        fit: machine({ confirm }),
      },
    );

    expect(code).toBe(0);
    expect(ollama.pulls()).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    const record = out.json[0] as EmbedderFitRecord;
    expect(record.decision.mode).toBe("off");
    expect(record.decision.proposal?.command).toBe("openclaw embedder fit --pull");
    expect(record.tool.command).toBe("openclaw embedder fit --json");
  });

  it("--installer prints one compact line for setup.sh", async () => {
    const ollama = await mockOllama();
    const { out, runtime } = capture();

    const code = await runEmbedderFitCommand(
      { installer: true },
      {
        runtime,
        stateDir,
        isTTY: false,
        signal: new AbortController().signal,
        config: () => cfgFor(ollama.baseUrl),
        fit: machine(),
      },
    );

    expect(code).toBe(0);
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0]).toMatch(/^memory search: word index only \(/);
    expect(ollama.pulls()).toBe(0);
  });
});

describe("the embedder sub-CLI", () => {
  it("registers fit and status with their options", () => {
    const program = new Command();
    registerEmbedderCli(program);

    const embedder = program.commands.find((c) => c.name() === "embedder");
    expect(embedder?.commands.map((c) => c.name())).toEqual(["fit", "status"]);
    const fit = embedder?.commands.find((c) => c.name() === "fit");
    expect(fit?.options.map((o) => o.long)).toEqual([
      "--pull",
      "--allow-remote",
      "--background",
      "--installer",
      "--yes",
      "--json",
    ]);
    const status = embedder?.commands.find((c) => c.name() === "status");
    expect(status?.options.map((o) => o.long)).toEqual(["--json"]);
  });

  // The gate for a silent gap: resolveSubCliCommandGroups (register.subclis-core.ts) drops an entry
  // whose name has no descriptor in subcli-descriptors.ts, so the entry alone leaves `openclaw
  // embedder` unknown and setup.sh's step 4d failing.
  it("is reachable from the root program: its entry and its descriptor both exist", async () => {
    const { registerSubCliCommands } = await import("./program/register.subclis-core.js");
    const program = new Command();

    registerSubCliCommands(program, ["node", "openclaw"]);

    expect(program.commands.map((c) => c.name())).toContain("embedder");
  });
});
