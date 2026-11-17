// FORK 2026-10-29: tests for src/fork/embedder-fit.ts, the per-machine embedder decision.
// Every test runs against a fresh temp OPENCLAW_STATE_DIR; the sandbox tests unset it and point
// HOME at a temp dir instead. The machine numbers are the reference host's bench
// (TINKER_UI_DESIGN_BIBLE/embedder-fit.md), so a formula that drifts from the judged design turns
// a test red.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEmbedderFitForTest,
  applyEmbedderFit,
  batchPlan,
  breakerCooldownMs,
  breakerThreshold,
  cgroupV2PathFrom,
  cheapFingerprint,
  classifyEmbeddingEndpoint,
  decideEmbedderFit,
  demandBreakEvenPerDay,
  EMBED_CEILINGS,
  EMBEDDER_LADDER,
  embedderFitPaths,
  endpointKeyFor,
  fingerprintDiff,
  fitBudgetFor,
  fitEndpointKeyFor,
  idleGateOpen,
  inventoryDiff,
  isEmbeddingOff,
  keepUpRatio,
  ladderEntryFor,
  memoryFloorBytes,
  parseCgroupCpuMax,
  queryBreakEvenMs,
  ramFits,
  readEmbedderFit,
  readRawMemorySearchProvider,
  recallGainFor,
  requestDeadlineMs,
  signTestP,
  stepUpBreakEvenPerDay,
  trialInvocations,
  writeEmbedderFit,
  type CandidateMeasurement,
  type CorpusStats,
  type EmbedderFitInput,
  type EmbedderFitRecord,
  type EmbedderInventory,
  type FitDecision,
  type Measured,
} from "./embedder-fit.js";

const MIB = 2 ** 20;
const GIB = 2 ** 30;

let stateDir = "";
const savedStateDir = process.env.OPENCLAW_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedder-fit-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  __resetEmbedderFitForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = savedStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function measured(
  value: number,
  unit: string,
  provenance: Measured["provenance"] = "local-measured",
): Measured {
  return { value, unit, provenance, source: "test fixture" };
}

type CandidateSpec = {
  provider?: string;
  tps: number;
  low: number;
  high: number;
  p50: number;
  p95: number;
  cold?: number;
  overhead?: number;
  rssMiB?: number;
};

function candidate(model: string, spec: CandidateSpec): CandidateMeasurement {
  const c: CandidateMeasurement = {
    provider: spec.provider ?? "ollama",
    model,
    queryP50Ms: spec.p50,
    queryP95Ms: spec.p95,
    tokensPerSec: measured(spec.tps, "tokens/s"),
    tokensPerSecLow95: spec.low,
    tokensPerSecHigh95: spec.high,
    batchDispersion: 2,
    overheadMs: spec.overhead ?? 60,
    sanityOk: true,
  };
  if (spec.cold !== undefined) {
    c.coldLoadMs = spec.cold;
  }
  if (spec.rssMiB !== undefined) {
    c.rssBytes = spec.rssMiB * MIB;
  }
  return c;
}

// The reference host's bench: Raspberry Pi 5, Ollama in a 2-CPU container.
const PI_30M = candidate("granite-embedding:30m", {
  tps: 338.2,
  low: 300,
  high: 375,
  p50: 77,
  p95: 1672,
  cold: 7200,
  overhead: 60,
  rssMiB: 92,
});
const PI_278M = candidate("granite-embedding:278m", {
  tps: 167.1,
  low: 150,
  high: 185,
  p50: 179,
  p95: 539,
  cold: 3440,
  overhead: 90,
  rssMiB: 693,
});
const PI_NOMIC = candidate("nomic-embed-text", {
  tps: 138.9,
  low: 125,
  high: 150,
  p50: 978,
  p95: 2834,
  cold: 1630,
  overhead: 300,
  rssMiB: 338,
});
const PI_MXBAI = candidate("mxbai-embed-large", {
  tps: 95.6,
  low: 85,
  high: 105,
  p50: 423,
  p95: 8609,
  overhead: 170,
  rssMiB: 690,
});
const REMOTE_SMALL = candidate("remote-embed-small", {
  provider: "openai",
  tps: 4000,
  low: 3000,
  high: 5000,
  p50: 250,
  p95: 700,
  overhead: 200,
});

// 266,194 file tokens/day x 1.25 (400-token chunks with 80 overlap) is the design's I = 332,743.
const PI_CORPUS: CorpusStats = {
  files: 7719,
  tokens: measured(10_144_896, "tokens", "estimated"),
  ingestTokensPerDay: measured(266_194, "tokens/day", "estimated"),
  burstFactor: measured(6.12, "peak day / mean day", "estimated"),
  chunkTokens: 400,
  overlapTokens: 80,
};

function inventory(
  models: string[],
  reachable = true,
  remoteKeys: string[] = [],
): EmbedderInventory {
  return {
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      reachable,
      models: models.map((name, i) => ({ name, digest: `sha256:${i}` })),
    },
    nodeLlamaCpp: false,
    remoteKeys,
  };
}

function piInput(overrides: Partial<EmbedderFitInput> = {}): EmbedderFitInput {
  return {
    fingerprint: cheapFingerprint(),
    inventory: inventory(["granite-embedding:30m", "granite-embedding:278m"]),
    candidates: [PI_30M, PI_278M],
    corpus: PI_CORPUS,
    missCostSec: measured(21.57, "s"),
    nonEnglishShare: measured(0.022, "share"),
    memAvailableBytes: 5.86e9,
    totalRamBytes: 15.84 * GIB,
    endpointCapBytes: 3 * GIB,
    demandPerDay: measured(0, "searches/day"),
    explicitSources: ["memory"],
    consent: { remote: null },
    fitWallSeconds: measured(150, "s"),
    rawProvider: "auto",
    ...overrides,
  };
}

function verdictFor(d: FitDecision, name: string, model: string) {
  return d.verdicts.find((v) => v.name === name && v.model === model);
}

function ladder(model: string) {
  const entry = ladderEntryFor(model);
  if (!entry) {
    throw new Error(`not on the ladder: ${model}`);
  }
  return entry;
}

function fitRecord(
  decision: Partial<FitDecision> = {},
  fingerprint = cheapFingerprint(),
): EmbedderFitRecord {
  return {
    schemaVersion: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    fingerprint,
    inventory: inventory(["granite-embedding:30m"]),
    candidates: [PI_30M],
    corpus: PI_CORPUS,
    missCostSec: measured(21.57, "s"),
    nonEnglishShare: measured(0.022, "share"),
    fitWallSeconds: measured(150, "s"),
    decision: {
      mode: "memory",
      provider: "ollama",
      model: "granite-embedding:30m",
      dormantUntilDemand: true,
      reasons: ["fixture decision"],
      verdicts: [],
      ...decision,
    },
    consent: { remote: null },
    tool: { command: "openclaw embedder fit", version: "test" },
    history: [],
  };
}

/** The fixture inventory's Ollama endpoint, keyed as a governor there keys it. */
const OLLAMA_KEY = endpointKeyFor({ providerId: "ollama", baseUrl: "http://127.0.0.1:11434" });

describe("threshold formulas", () => {
  it("reproduce the reference host's numbers", () => {
    expect(
      keepUpRatio({ tokensPerSec: 338.2, idleShare: 1, ingestTokensPerDay: 332_743 }),
    ).toBeCloseTo(87.8, 1);
    expect(queryBreakEvenMs({ recallGain: 0.225, missCostMs: 21_570 })).toBeCloseTo(4853, 0);
    expect(breakerThreshold({ baselineFailureRate: 3 / 16, batchesPerDay: 309 })).toBe(4);
    expect(recallGainFor(ladder("granite-embedding:30m"), 0.022)).toBeCloseTo(0.232, 3);
    expect(trialInvocations({ missCostMs: 21_570, meanQueryMs: 200 })).toBe(324);
  });

  it("sizes a background batch from the query slack, between one chunk and the ceiling", () => {
    expect(
      batchPlan({ tokensPerSec: 338.2, queryBudgetMs: 4853, queryP95Ms: 1672, chunkTokens: 400 })
        .batchTokens,
    ).toBe(1075);
    // mxbai has no slack (p95 above its budget): one chunk per batch.
    expect(
      batchPlan({ tokensPerSec: 95.6, queryBudgetMs: 5775, queryP95Ms: 8609, chunkTokens: 400 })
        .batchTokens,
    ).toBe(400);
    expect(
      batchPlan({ tokensPerSec: 20_000, queryBudgetMs: 6566, queryP95Ms: 30, chunkTokens: 400 })
        .batchTokens,
    ).toBe(EMBED_CEILINGS.batchTokens);
  });

  it("derives a request deadline from tokens and measured throughput, capped by the ceiling", () => {
    expect(
      requestDeadlineMs({ tokens: 1076, tokensPerSecLow: 338.2, ceilingMs: 600_000 }),
    ).toBeCloseTo(6363, 0);
    expect(
      requestDeadlineMs({
        tokens: 1076,
        tokensPerSecLow: 338.2,
        coldLoadMs: 7200,
        ceilingMs: 600_000,
      }),
    ).toBeCloseTo(13_563, 0);
    expect(requestDeadlineMs({ tokens: 8000, tokensPerSecLow: 1, ceilingMs: 600_000 })).toBe(
      600_000,
    );
    expect(requestDeadlineMs({ tokens: 100, tokensPerSecLow: 0, ceilingMs: 60_000 })).toBe(60_000);
  });

  it("prices demand and the step-up on the reference host", () => {
    const thirtyM = {
      contention: 1,
      dailyEmbedSec: 332_743 / 338.2,
      pendingEmbedSec: (10_144_896 * 1.25) / 338.2,
      horizonDays: 30,
      recallGain: 0.225,
      missCostSec: 21.57,
      queryP50Sec: 0.077,
    };
    expect(demandBreakEvenPerDay(thirtyM)).toBeCloseTo(468, -1);
    expect(demandBreakEvenPerDay({ ...thirtyM, contention: 0.1 })).toBeCloseTo(47, 0);
    expect(demandBreakEvenPerDay({ ...thirtyM, recallGain: 0.001 })).toBe(Number.POSITIVE_INFINITY);

    const cheap = { ...thirtyM, recallGain: recallGainFor(ladder("granite-embedding:30m"), 0.022) };
    const dear = {
      contention: 1,
      dailyEmbedSec: 332_743 / 167.1,
      pendingEmbedSec: (10_144_896 * 1.25) / 167.1,
      horizonDays: 30,
      recallGain: recallGainFor(ladder("granite-embedding:278m"), 0.022),
      missCostSec: 21.57,
      queryP50Sec: 0.179,
    };
    expect(stepUpBreakEvenPerDay(cheap, dear)).toBeCloseTo(1574, -1);
    // A "step-up" to a model that saves less per search never pays.
    expect(stepUpBreakEvenPerDay(dear, cheap)).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the RAM floor, the breaker cool-down and the idle gate", () => {
    expect(memoryFloorBytes(16 * GIB)).toBeCloseTo(1.6 * GIB, -3);
    expect(memoryFloorBytes(8 * GIB)).toBe(1.5 * GIB);
    const host = {
      memAvailableBytes: 5.86e9,
      totalRamBytes: 15.84 * GIB,
      endpointCapBytes: 3 * GIB,
    };
    expect(ramFits({ ...host, rssBytes: 92 * MIB, otherResidentBytes: 0 })).toBe(true);
    expect(ramFits({ ...host, rssBytes: 2 * GIB, otherResidentBytes: 1.5 * GIB })).toBe(false);
    expect(breakerCooldownMs({ deadlineMs: 6400, consecutiveTrips: 1 })).toBe(12_800);
    expect(breakerCooldownMs({ deadlineMs: 6400, consecutiveTrips: 2 })).toBe(25_600);
    expect(breakerCooldownMs({ deadlineMs: 6400, consecutiveTrips: 30 })).toBe(
      EMBED_CEILINGS.breakerCooldownMaxMs,
    );
    expect(idleGateOpen({ load1: 4.04, logicalCores: 4, embedCores: 2, ownDuty: 0 })).toBe(false);
    expect(idleGateOpen({ load1: 0.93, logicalCores: 4, embedCores: 2, ownDuty: 0 })).toBe(true);
    // Load the governor's own embedding caused does not close the gate on itself.
    expect(idleGateOpen({ load1: 3.5, logicalCores: 4, embedCores: 2, ownDuty: 1 })).toBe(true);
  });

  it("derives every ladder sign test from its discordant pairs", () => {
    expect(signTestP([10, 1])).toBeCloseTo(0.0117, 4);
    expect(signTestP([5, 0])).toBe(0.0625);
    expect(ladder("granite-embedding:278m").priors.signP).toBeCloseTo(0.00012, 5);
    for (const entry of EMBEDDER_LADDER) {
      expect(entry.priors.signP).toBeLessThan(0.05);
      expect(entry.contextTokens).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("decideEmbedderFit", () => {
  it("Pi-like: memory with granite-embedding:30m, dormant until demand", () => {
    const d = decideEmbedderFit(piInput());
    expect(d.mode).toBe("memory");
    expect(d.provider).toBe("ollama");
    expect(d.model).toBe("granite-embedding:30m");
    expect(d.dormantUntilDemand).toBe(true);
    const keepUp = verdictFor(d, "keep-up", "granite-embedding:30m");
    expect(keepUp?.value).toBeCloseTo(87.8, 1);
    expect(keepUp?.inputs.minIdleShare?.value).toBeCloseTo(0.07, 2);
    const stepUp = verdictFor(d, "step-up", "granite-embedding:278m");
    expect(stepUp?.pass).toBe(false);
    expect(stepUp?.value).toBeCloseTo(1574, -1);
    expect(d.demandBreakEvenPerDay).toBeGreaterThan(400);
    expect(verdictFor(d, "demand", "granite-embedding:30m")?.pass).toBe(false);
  });

  it("GPU-like: the dearer model costs seconds a day, so the more precise granite-embedding:278m wins", () => {
    const d = decideEmbedderFit(
      piInput({
        candidates: [
          candidate("granite-embedding:30m", {
            tps: 20_000,
            low: 18_000,
            high: 22_000,
            p50: 6,
            p95: 20,
            cold: 800,
            overhead: 5,
            rssMiB: 120,
          }),
          candidate("granite-embedding:278m", {
            tps: 12_000,
            low: 11_000,
            high: 13_000,
            p50: 9,
            p95: 30,
            cold: 1500,
            overhead: 6,
            rssMiB: 760,
          }),
        ],
        demandPerDay: undefined,
        memAvailableBytes: 24e9,
        totalRamBytes: 32 * GIB,
        endpointCapBytes: undefined,
      }),
    );
    expect(d.mode).toBe("memory");
    expect(d.model).toBe("granite-embedding:278m");
    expect(verdictFor(d, "step-up", "granite-embedding:278m")?.pass).toBe(true);
  });

  it("only nomic installed: nomic-embed-text plus a proposal to pull the preferred model", () => {
    const d = decideEmbedderFit(
      piInput({
        inventory: inventory(["nomic-embed-text:latest", "llama3.2:3b"]),
        candidates: [PI_NOMIC],
      }),
    );
    expect(d.mode).toBe("memory");
    expect(d.model).toBe("nomic-embed-text");
    expect(d.proposal?.command).toBe("openclaw embedder fit --pull");
    expect(d.proposal?.text).toContain("granite-embedding:30m");
  });

  it("only mxbai with the reference numbers: off, rejected by the query verdict alone", () => {
    const d = decideEmbedderFit(
      piInput({ inventory: inventory(["mxbai-embed-large:latest"]), candidates: [PI_MXBAI] }),
    );
    expect(d.mode).toBe("off");
    expect(d.model).toBeUndefined();
    const query = verdictFor(d, "query", "mxbai-embed-large");
    expect(query?.pass).toBe(false);
    expect(query?.breakEven).toBeCloseTo(5775, -1);
    expect(
      d.verdicts.filter((v) => v.model === "mxbai-embed-large" && !v.pass).map((v) => v.name),
    ).toEqual(["query"]);
    expect(d.reasons.some((r) => r.includes("mxbai-embed-large") && r.includes("query"))).toBe(
      true,
    );
  });

  it("a remote key without consent: off; with consent: the remote provider", () => {
    const base = { inventory: inventory([], false, ["openai"]), candidates: [REMOTE_SMALL] };
    const without = decideEmbedderFit(piInput(base));
    expect(without.mode).toBe("off");
    expect(without.reasons.some((r) => r.includes("consent"))).toBe(true);

    const consented = decideEmbedderFit(
      piInput({
        ...base,
        consent: {
          remote: { provider: "openai", grantedAt: "2026-10-29T08:00:00.000Z", via: "flag" },
        },
      }),
    );
    expect(consented.mode).toBe("memory");
    expect(consented.provider).toBe("openai");
    expect(consented.model).toBe("remote-embed-small");
    // No paired eval exists for it: the weakest ladder prior stands in, labelled as an estimate.
    expect(
      verdictFor(consented, "gain", "openai/remote-embed-small")?.inputs.signP?.provenance,
    ).toBe("estimated");
  });

  it("no endpoint: off with a reason and the install hint", () => {
    const d = decideEmbedderFit(piInput({ inventory: inventory([], false), candidates: [] }));
    expect(d.mode).toBe("off");
    expect(d.reasons.some((r) => r.includes("no embedding endpoint"))).toBe(true);
    expect(d.proposal?.command).toBe("openclaw embedder fit --pull");
    expect(d.proposal?.text).toContain("Install Ollama");
  });

  it("explicit sessions that fail keep-up: memory plus a reason; sessions that keep up are decided", () => {
    const failing = decideEmbedderFit(
      piInput({
        explicitSources: ["memory", "sessions"],
        corpus: {
          ...PI_CORPUS,
          sessionIngestTokensPerDay: measured(10_000_000, "tokens/day", "estimated"),
        },
      }),
    );
    expect(failing.mode).toBe("memory");
    expect(failing.model).toBe("granite-embedding:30m");
    expect(failing.reasons.some((r) => r.includes("sessions") && r.includes("keep-up"))).toBe(true);
    const sessionsKeepUp = failing.verdicts.find(
      (v) => v.name === "keep-up" && v.inputs.sessionIngestTokensPerDay !== undefined,
    );
    expect(sessionsKeepUp?.pass).toBe(false);

    // CONTROL: the reference host's measured session growth keeps up at full idle.
    const passing = decideEmbedderFit(
      piInput({
        explicitSources: ["memory", "sessions"],
        corpus: {
          ...PI_CORPUS,
          sessionIngestTokensPerDay: measured(356_218, "tokens/day", "estimated"),
        },
      }),
    );
    expect(passing.mode).toBe("memory+sessions");
  });

  it("never adds sessions the config does not list", () => {
    const d = decideEmbedderFit(
      piInput({
        corpus: {
          ...PI_CORPUS,
          sessionIngestTokensPerDay: measured(1000, "tokens/day", "estimated"),
        },
      }),
    );
    expect(d.mode).toBe("memory");
  });

  it("a tiny corpus is armed at once: not dormant", () => {
    const d = decideEmbedderFit(
      piInput({
        corpus: { ...PI_CORPUS, files: 3, tokens: measured(20_000, "tokens", "estimated") },
      }),
    );
    expect(d.mode).toBe("memory");
    expect(d.dormantUntilDemand).toBe(false);
  });

  it("a pinned provider keeps the usual decision and gets a proposal naming the failed gate", () => {
    const d = decideEmbedderFit(
      piInput({
        inventory: inventory(["granite-embedding:30m", "mxbai-embed-large:latest"]),
        candidates: [PI_30M, PI_MXBAI],
        rawProvider: "ollama",
        rawModel: "mxbai-embed-large",
      }),
    );
    expect(d.model).toBe("granite-embedding:30m");
    expect(d.proposal?.text).toContain("mxbai-embed-large");
    expect(d.proposal?.text).toContain("query");
    expect(d.reasons.some((r) => r.includes("pinned"))).toBe(true);
  });

  it("is deterministic and labels every verdict input with provenance", () => {
    const d = decideEmbedderFit(piInput());
    expect(decideEmbedderFit(piInput())).toEqual(d);
    const inputs = d.verdicts.flatMap((v) => Object.values(v.inputs));
    expect(inputs.length).toBeGreaterThan(0);
    for (const x of inputs) {
      expect([
        "per-call-measured",
        "local-measured",
        "estimated",
        "third-party-reported",
        "turn-aggregate",
      ]).toContain(x.provenance);
      expect(x.source.length).toBeGreaterThan(0);
    }
  });
});

describe("record IO", () => {
  it("keeps the record, the governor snapshot and the lock under <stateDir>/memory", () => {
    const p = embedderFitPaths();
    expect(p.record).toBe(path.join(stateDir, "memory", "embedder-fit.json"));
    expect(p.governor).toBe(path.join(stateDir, "memory", "embedder-governor.json"));
    expect(p.lock).toBe(path.join(stateDir, "memory", "embedder-fit.lock"));
  });

  it("returns null when the record is missing", () => {
    expect(readEmbedderFit()).toBeNull();
  });

  it("returns null for an unparseable record and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = embedderFitPaths().record;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readEmbedderFit()).toBeNull();
    fs.writeFileSync(file, "{ still not json at all");
    expect(readEmbedderFit()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects a record with another schema version", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = embedderFitPaths().record;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...fitRecord(), schemaVersion: 2 }));
    expect(readEmbedderFit()).toBeNull();
  });

  it("stats once per call and returns the cached record until the file changes", () => {
    writeEmbedderFit(fitRecord());
    const stat = vi.spyOn(fs, "statSync");
    const first = readEmbedderFit();
    const second = readEmbedderFit();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(stat).toHaveBeenCalledTimes(2);
    stat.mockRestore();
    writeEmbedderFit(fitRecord({ model: "granite-embedding:278m" }));
    expect(readEmbedderFit()?.decision.model).toBe("granite-embedding:278m");
  });

  it("writes atomically with mode 0600 and keeps the newest 20 history entries", () => {
    for (let i = 0; i < 25; i++) {
      writeEmbedderFit({
        ...fitRecord(),
        createdAt: `2026-10-29T08:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }
    const rec = readEmbedderFit();
    expect(rec?.history).toHaveLength(20);
    expect(rec?.history[0]?.at).toBe("2026-10-29T08:05:00.000Z");
    expect(rec?.history[19]?.at).toBe("2026-10-29T08:24:00.000Z");
    expect(rec?.history[19]?.model).toBe("granite-embedding:30m");
    const file = embedderFitPaths().record;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("round-trips a break-even that never pays", () => {
    writeEmbedderFit(
      fitRecord({
        verdicts: [
          {
            name: "demand",
            objective: "fixture",
            value: 0,
            breakEven: Number.POSITIVE_INFINITY,
            pass: false,
            formula: "fixture",
            inputs: {},
          },
        ],
      }),
    );
    expect(readEmbedderFit()?.decision.verdicts[0]?.breakEven).toBe(Number.POSITIVE_INFINITY);
  });
});

// Design principle #20: tests are sandboxed by construction. Under a test runner, a call with no
// stateDir while OPENCLAW_STATE_DIR is unset never reaches the host's record. HOME points at a
// temp dir holding a valid record, so nothing here reads the real home, and the CONTROL shows the
// record sits exactly where the unguarded code would look.
describe("record IO in a sandboxed test", () => {
  const savedHome = process.env.HOME;
  const savedOpenclawHome = process.env.OPENCLAW_HOME;
  let home = "";
  let defaultStateDir = "";

  function restoreEnv(key: "HOME" | "OPENCLAW_HOME", value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "embedder-fit-home-"));
    defaultStateDir = path.join(home, ".openclaw");
    process.env.HOME = home;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_STATE_DIR;
    // An explicit stateDir keeps today's behaviour in a sandboxed test: this plants the record.
    writeEmbedderFit(fitRecord(), defaultStateDir);
  });

  afterEach(() => {
    restoreEnv("HOME", savedHome);
    restoreEnv("OPENCLAW_HOME", savedOpenclawHome);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads no record and touches no file when no state dir is given", () => {
    expect(process.env.VITEST).toBeTruthy();
    // CONTROL: the default path an unguarded read would use holds a record that parses.
    const wouldBe = embedderFitPaths().record;
    expect(wouldBe).toBe(path.join(defaultStateDir, "memory", "embedder-fit.json"));
    expect(fs.existsSync(wouldBe)).toBe(true);
    expect(readEmbedderFit(defaultStateDir)?.decision.model).toBe("granite-embedding:30m");

    const touched = [
      vi.spyOn(fs, "existsSync"),
      vi.spyOn(fs, "statSync"),
      vi.spyOn(fs, "readFileSync"),
    ];
    expect(readEmbedderFit()).toBeNull();
    expect(applyEmbedderFit({ provider: "auto", model: "" })).toEqual({
      provider: "none",
      model: "",
    });
    expect(
      fitBudgetFor({
        providerId: "ollama",
        model: "granite-embedding:30m",
        endpointKey: OLLAMA_KEY,
      }),
    ).toBeNull();
    for (const spy of touched) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("reads the record once OPENCLAW_STATE_DIR names that state dir", () => {
    process.env.OPENCLAW_STATE_DIR = defaultStateDir;
    expect(readEmbedderFit()?.decision.model).toBe("granite-embedding:30m");
    expect(applyEmbedderFit({ provider: "auto", model: "" })).toEqual({
      provider: "ollama",
      model: "granite-embedding:30m",
    });
  });

  it("writes nothing when no state dir is given", () => {
    const file = path.join(defaultStateDir, "memory", "embedder-fit.json");
    const before = fs.readFileSync(file, "utf8");
    const touched = [
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "openSync"),
      vi.spyOn(fs, "renameSync"),
    ];
    const out = writeEmbedderFit(fitRecord({ model: "granite-embedding:278m" }));
    expect(out.decision.model).toBe("granite-embedding:278m");
    for (const spy of touched) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("applyEmbedderFit", () => {
  it("substitutes 'auto' from a matching record and changes no other key", () => {
    writeEmbedderFit(fitRecord());
    const resolved = {
      provider: "auto",
      model: "",
      sources: ["memory"],
      chunking: { tokens: 400, overlap: 80 },
    };
    const out = applyEmbedderFit(resolved);
    expect(out).toEqual({ ...resolved, provider: "ollama", model: "granite-embedding:30m" });
    expect(out.chunking).toBe(resolved.chunking);
    expect(resolved.provider).toBe("auto");
  });

  it("gives 'none' when the record is missing", () => {
    expect(applyEmbedderFit({ provider: "auto", model: "", extra: 1 })).toEqual({
      provider: "none",
      model: "",
      extra: 1,
    });
  });

  it("gives 'none' for a record measured on another machine", () => {
    const fp = cheapFingerprint();
    writeEmbedderFit(fitRecord({}, { ...fp, logicalCores: fp.logicalCores + 1 }));
    expect(applyEmbedderFit({ provider: "auto", model: "x" })).toEqual({
      provider: "none",
      model: "",
    });
  });

  it("gives 'none' for an off decision", () => {
    writeEmbedderFit(fitRecord({ mode: "off", provider: undefined, model: undefined }));
    expect(applyEmbedderFit({ provider: "auto", model: "" })).toEqual({
      provider: "none",
      model: "",
    });
  });

  it("returns an explicit provider untouched", () => {
    writeEmbedderFit(fitRecord());
    const pinned = { provider: "ollama", model: "mxbai-embed-large", extra: 1 };
    expect(applyEmbedderFit(pinned)).toBe(pinned);
  });

  it("never throws", () => {
    expect(applyEmbedderFit(null as never)).toBeNull();
  });
});

describe("fitBudgetFor", () => {
  const HERE = { providerId: "ollama", model: "granite-embedding:30m", endpointKey: OLLAMA_KEY };

  it("derives the working bounds from a matching record", () => {
    writeEmbedderFit(fitRecord());
    const budget = fitBudgetFor(HERE);
    expect(budget?.concurrency).toBe(1);
    // (B_q - t_q95) x theta = (5,010 - 1,672) ms x 338.2 tokens/s: two to three chunks.
    expect(budget?.batchTokens).toBe(1128);
    expect(budget?.queryDeadlineMs).toBeCloseTo(5010, -1);
    expect(budget?.batchDeadlineMs).toBeCloseTo(7580, -1);
    expect(budget?.coldLoadMs).toBe(7200);
    expect(budget?.fitWallSeconds).toBe(150);
    expect(fitBudgetFor({ ...HERE, model: "nomic-embed-text" })).toBeNull();
  });

  it("allows two requests in flight only on a parallel gain beyond 2 sigma", () => {
    writeEmbedderFit({
      ...fitRecord(),
      candidates: [{ ...PI_30M, parallelGain: { delta: 40, sigma: 10 } }],
    });
    expect(fitBudgetFor(HERE)?.concurrency).toBe(2);
    writeEmbedderFit({
      ...fitRecord(),
      candidates: [{ ...PI_30M, parallelGain: { delta: 15, sigma: 10 } }],
    });
    expect(fitBudgetFor(HERE)?.concurrency).toBe(1);
  });

  it("returns null for a record measured on another machine", () => {
    const fp = cheapFingerprint();
    writeEmbedderFit(fitRecord({}, { ...fp, totalRamGiB: fp.totalRamGiB + 64 }));
    expect(fitBudgetFor(HERE)).toBeNull();
  });

  // FORK 2026-10-30, Astra review R2 finding #3: the concurrency came from the URL the record
  // measured, so a fit taken at a remote Ollama gave a machine-local one the remote ceiling of 4.
  it("uses a record only at the endpoint it measured", () => {
    const remote = "https://embed.example.com";
    const measuredThere = inventory(["granite-embedding:30m"]);
    measuredThere.ollama.baseUrl = remote;
    writeEmbedderFit({ ...fitRecord(), inventory: measuredThere });
    // A machine-local Ollama is not where it measured: no bounds at all, so not the remote's 4.
    expect(fitBudgetFor(HERE)).toBeNull();
    // CONTROL: where it measured, the record still gives its bounds: a remote endpoint's ceiling.
    const there = endpointKeyFor({ providerId: "ollama", baseUrl: remote });
    expect(fitBudgetFor({ ...HERE, endpointKey: there })?.concurrency).toBe(
      EMBED_CEILINGS.indexConcurrency,
    );
    const record = readEmbedderFit();
    expect(record && fitEndpointKeyFor(record, "ollama")).toBe(there);
    // No openai candidate was measured, so no URL is kept for it: its key is the provider id alone.
    expect(record && fitEndpointKeyFor(record, "openai")).toBe("openai");
  });

  // FORK 2026-10-30: every HTTP provider's governor is keyed by the URL its client calls
  // ('openai|https://api.openai.com'), so a remote provider's measurements carry the URL they were
  // taken at. Keyed by the provider id alone, they matched no governor.
  it("applies a remote provider's record at the URL it was measured at, and nowhere else", () => {
    const measuredAt = "https://api.openai.com/v1";
    writeEmbedderFit({
      ...fitRecord({ provider: "openai", model: "remote-embed-small" }),
      candidates: [{ ...REMOTE_SMALL, baseUrl: measuredAt }],
    });
    const there = endpointKeyFor({ providerId: "openai", baseUrl: measuredAt });
    const REMOTE = { providerId: "openai", model: "remote-embed-small", endpointKey: there };
    expect(fitBudgetFor(REMOTE)).toMatchObject({
      tokensPerSec: 4000,
      concurrency: EMBED_CEILINGS.indexConcurrency,
    });
    const record = readEmbedderFit();
    expect(record && fitEndpointKeyFor(record, "openai")).toBe(there);
    // Another server of the same provider is not where the record was measured.
    const lan = endpointKeyFor({ providerId: "openai", baseUrl: "http://10.0.0.7:8080/v1" });
    expect(fitBudgetFor({ ...REMOTE, endpointKey: lan })).toBeNull();
    // Ollama still keys by the inventory's URL.
    expect(record && fitEndpointKeyFor(record, "ollama")).toBe(OLLAMA_KEY);
  });

  it("keys a remote provider by the decided model's URL when several of its models were measured", () => {
    writeEmbedderFit({
      ...fitRecord({ provider: "openai", model: "remote-embed-large" }),
      candidates: [
        { ...REMOTE_SMALL, baseUrl: "http://10.0.0.7:8080/v1" },
        { ...REMOTE_SMALL, model: "remote-embed-large", baseUrl: "https://api.openai.com/v1" },
      ],
    });
    const record = readEmbedderFit();
    expect(record && fitEndpointKeyFor(record, "openai")).toBe("openai|https://api.openai.com");
  });

  it("keys a record whose remote candidate kept no URL as before: by the provider id alone", () => {
    writeEmbedderFit({
      ...fitRecord({ provider: "openai", model: "remote-embed-small" }),
      candidates: [REMOTE_SMALL],
    });
    const record = readEmbedderFit();
    expect(record && fitEndpointKeyFor(record, "openai")).toBe("openai");
    const OLD = { providerId: "openai", model: "remote-embed-small", endpointKey: "openai" };
    expect(fitBudgetFor(OLD)?.concurrency).toBe(EMBED_CEILINGS.indexConcurrency);
    expect(fitBudgetFor({ ...OLD, endpointKey: "openai|https://api.openai.com" })).toBeNull();
  });
});

describe("fingerprints", () => {
  it("cheapFingerprint is memoized and machine-shaped", () => {
    const a = cheapFingerprint();
    expect(cheapFingerprint()).toEqual(a);
    expect(a.logicalCores).toBeGreaterThan(0);
    expect(Number.isInteger(a.totalRamGiB)).toBe(true);
    expect([true, false]).toContain(a.gpu.nvidia);
    expect(a.cpuQuotaCores === null || a.cpuQuotaCores > 0).toBe(true);
  });

  it("fingerprintDiff names the changed fields", () => {
    const a = cheapFingerprint();
    expect(fingerprintDiff(a, { ...a, gpu: { ...a.gpu } })).toEqual([]);
    expect(
      fingerprintDiff(a, {
        ...a,
        logicalCores: a.logicalCores + 2,
        gpu: { ...a.gpu, nvidia: !a.gpu.nvidia },
      }),
    ).toEqual(["logicalCores", "gpu.nvidia"]);
    expect(fingerprintDiff(a, null)).toEqual(["fingerprint"]);
  });

  it("inventoryDiff counts ladder-known models only", () => {
    const a = inventory(["granite-embedding:30m", "llama3.2:3b"]);
    expect(
      inventoryDiff(a, {
        ...a,
        ollama: {
          ...a.ollama,
          version: "0.41.0",
          models: [...a.ollama.models, { name: "qwen3:8b", digest: "sha256:x" }],
        },
      }),
    ).toEqual([]);
    expect(
      inventoryDiff(a, inventory(["granite-embedding:30m", "granite-embedding:278m"])),
    ).toEqual(["+granite-embedding:278m"]);
    expect(inventoryDiff(a, inventory(["llama3.2:3b"]))).toEqual(["-granite-embedding:30m"]);
    expect(
      inventoryDiff(a, {
        ...a,
        ollama: { ...a.ollama, models: [{ name: "granite-embedding:30m", digest: "sha256:new" }] },
      }),
    ).toEqual(["~granite-embedding:30m"]);
    // An endpoint that is down now says nothing about which models exist.
    expect(inventoryDiff(a, inventory([], false))).toEqual([]);
    // A fit that found no endpoint is re-armed the day a ladder model appears.
    expect(inventoryDiff(inventory([], false), inventory(["granite-embedding:30m"]))).toEqual([
      "+granite-embedding:30m",
    ]);
  });

  it("parses cgroup v2 quotas", () => {
    expect(parseCgroupCpuMax("200000 100000\n")).toBe(2);
    expect(parseCgroupCpuMax("150000 100000")).toBe(1.5);
    expect(parseCgroupCpuMax("max 100000")).toBeNull();
    expect(parseCgroupCpuMax("garbage")).toBeNull();
    expect(cgroupV2PathFrom("0::/system.slice/example.service\n")).toBe(
      "/system.slice/example.service",
    );
    expect(cgroupV2PathFrom("0::/\n")).toBe("/");
    expect(cgroupV2PathFrom("12:cpu,cpuacct:/docker/abc\n")).toBeNull();
  });
});

describe("helpers", () => {
  it("isEmbeddingOff", () => {
    expect(isEmbeddingOff(undefined)).toBe(true);
    expect(isEmbeddingOff(null)).toBe(true);
    expect(isEmbeddingOff({ provider: "" })).toBe(true);
    expect(isEmbeddingOff({ provider: "none" })).toBe(true);
    expect(isEmbeddingOff({ provider: "ollama" })).toBe(false);
  });

  it.each<[string, string]>([
    ["http://127.0.0.1:11434", "local-http"],
    ["http://localhost:11434", "local-http"],
    ["http://[::1]:11434", "local-http"],
    ["http://10.0.0.5:11434", "local-http"],
    ["http://172.17.0.2:11434", "local-http"],
    ["http://192.168.1.20:11434", "local-http"],
    ["http://169.254.10.1:11434", "local-http"],
    ["http://[fd12:3456::1]:11434", "local-http"],
    ["http://[fe80::1]:11434", "local-http"],
    ["http://[::ffff:127.0.0.1]:11434", "local-http"],
    ["http://ollama:11434", "local-http"],
    ["http://host.docker.internal:11434", "local-http"],
    ["unix:/run/ollama.sock", "local-http"],
    ["https://api.example.com/v1", "remote"],
    ["http://8.8.8.8:11434", "remote"],
    ["http://172.32.0.1:11434", "remote"],
    ["http://[2001:db8::1]:11434", "remote"],
  ])("classifies %s as %s", (baseUrl, expected) => {
    expect(classifyEmbeddingEndpoint({ providerId: "ollama", baseUrl })).toBe(expected);
  });

  it("classifies by provider when there is no base URL", () => {
    expect(classifyEmbeddingEndpoint({ providerId: "local" })).toBe("inproc");
    expect(classifyEmbeddingEndpoint({ providerId: "ollama" })).toBe("local-http");
    expect(classifyEmbeddingEndpoint({ providerId: "openai" })).toBe("remote");
  });

  it("endpointKeyFor keys one queue per provider and origin", () => {
    expect(endpointKeyFor({ providerId: "ollama", baseUrl: "http://LOCALHOST:11434/api/" })).toBe(
      "ollama|http://localhost:11434",
    );
    expect(endpointKeyFor({ providerId: "ollama", baseUrl: "http://127.0.0.1:11434/v1" })).toBe(
      endpointKeyFor({ providerId: "ollama", baseUrl: "http://127.0.0.1:11434" }),
    );
    expect(endpointKeyFor({ providerId: "openai" })).toBe("openai");
  });

  it("readRawMemorySearchProvider: agent override, then defaults, then 'auto'", () => {
    const cfg = {
      agents: {
        defaults: { memorySearch: { provider: "ollama" } },
        list: [{ id: "Main", memorySearch: { provider: "openai" } }, { id: "helper" }],
      },
    };
    expect(readRawMemorySearchProvider(cfg, "main")).toBe("openai");
    expect(readRawMemorySearchProvider(cfg, "helper")).toBe("ollama");
    expect(readRawMemorySearchProvider({}, "main")).toBe("auto");
    expect(readRawMemorySearchProvider(undefined, "main")).toBe("auto");
  });

  it("ladderEntryFor matches Ollama's names", () => {
    expect(ladderEntryFor("nomic-embed-text:latest")?.model).toBe("nomic-embed-text");
    expect(ladderEntryFor("ollama/granite-embedding:30m")?.status).toBe("preferred");
    expect(ladderEntryFor("all-minilm")).toBeUndefined();
    expect(ladderEntryFor("")).toBeUndefined();
  });
});
