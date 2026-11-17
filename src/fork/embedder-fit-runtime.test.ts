// FORK 2026-10-29: tests for src/fork/embedder-fit-runtime.ts (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
// The Ollama probe, the child process and the foreground fit are injected, timers are fake and
// every test has its own temp state dir, so no test makes a request, starts a process, measures
// the host's embedder or touches a real state dir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RunEmbedderFitOptions } from "./embedder-fit-measure.js";
import {
  __resetEmbedderFitRuntimeForTest,
  noteEmbedderFit,
  reprobeDelayMs,
  scheduleEmbedderFitCheck,
  type EmbedderFitRuntimeDeps,
  type OllamaProbe,
  type SpawnedFit,
} from "./embedder-fit-runtime.js";
import {
  __resetEmbedderFitForTest,
  cheapFingerprint,
  readEmbedderFit,
  writeEmbedderFit,
  type CheapFingerprint,
  type EmbedderFitRecord,
  type FitDecision,
  type Measured,
  type ThresholdVerdict,
} from "./embedder-fit.js";
import type { GovernorRemeasureRequest } from "./embedder-governor.js";

const captured = vi.hoisted(() => ({
  hook: undefined as ((request: GovernorRemeasureRequest) => void) | undefined,
}));

const measure = vi.hoisted(() => ({
  runEmbedderFit: vi.fn(async (_opts: unknown): Promise<never> => {
    throw new Error("the real fit ran in a test");
  }),
}));

// The real measuring module, except its fit: a doctor --fix in a test must never reach it, because
// it probes and measures whatever embedder the test host runs.
vi.mock("./embedder-fit-measure.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedder-fit-measure.js")>();
  return { ...actual, runEmbedderFit: measure.runEmbedderFit };
});

// The real governor, except that the re-measure hook the check registers is kept for the tests.
vi.mock("./embedder-governor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedder-governor.js")>();
  return {
    ...actual,
    setGovernorRemeasureHook: (fn: ((request: GovernorRemeasureRequest) => void) | undefined) => {
      captured.hook = fn;
      actual.setGovernorRemeasureHook(fn);
    },
  };
});

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BASE = "http://127.0.0.1:11434";
const MODEL = "granite-embedding:30m";
const ENTRY = "/srv/openclaw/openclaw.mjs";
const cfg = {} as OpenClawConfig;
const UNREACHABLE: OllamaProbe = { baseUrl: BASE, reachable: false, models: [] };
const REQUEST: GovernorRemeasureRequest = {
  endpointKey: `ollama|${BASE}`,
  providerId: "ollama",
  model: MODEL,
  reason: "theta-drift",
  detail: "live throughput outside the fit's 95% band",
};
const QUERY_VERDICT: ThresholdVerdict = {
  name: "query",
  model: MODEL,
  objective: "A query embed the caller waits for must cost less than the time it saves.",
  value: 1672,
  breakEven: 4850,
  pass: true,
  formula: "t_q95 <= B_q",
  inputs: {
    queryP95Ms: { value: 1672, unit: "ms", provenance: "local-measured", source: "test fixture" },
    recallGain: {
      value: 0.225,
      unit: "R@5 over word search",
      provenance: "third-party-reported",
      source: "the reference eval",
    },
  },
};

type LineMock = Mock<(message: string) => void>;

let stateDir = "";
let log: { info: LineMock; warn: LineMock };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedder-fit-runtime-"));
  __resetEmbedderFitForTest();
  __resetEmbedderFitRuntimeForTest();
  captured.hook = undefined;
  measure.runEmbedderFit.mockClear();
  log = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
});

afterEach(() => {
  __resetEmbedderFitRuntimeForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Let promise continuations run without moving any timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

function measured(value: number, unit: string): Measured {
  return { value, unit, provenance: "local-measured", source: "test fixture" };
}

function ollamaWith(models: string[]): OllamaProbe {
  return {
    baseUrl: BASE,
    reachable: true,
    models: models.map((name, i) => ({ name, digest: `sha256:${i}` })),
  };
}

function offDecision(reason: string): Partial<FitDecision> {
  return {
    mode: "off",
    provider: undefined,
    model: undefined,
    reasons: [reason],
    proposal: {
      text: "Pull the preferred model, then measure again:",
      command: "openclaw embedder fit --pull",
    },
  };
}

function fitRecord(
  p: {
    decision?: Partial<FitDecision>;
    ollama?: OllamaProbe;
    fingerprint?: CheapFingerprint;
    history?: EmbedderFitRecord["history"];
  } = {},
): EmbedderFitRecord {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    fingerprint: p.fingerprint ?? cheapFingerprint(),
    inventory: { ollama: p.ollama ?? ollamaWith([MODEL]), nodeLlamaCpp: false, remoteKeys: [] },
    candidates: [],
    missCostSec: measured(21.57, "s"),
    nonEnglishShare: measured(0.25, "share"),
    fitWallSeconds: measured(150, "s"),
    decision: {
      mode: "memory",
      provider: "ollama",
      model: MODEL,
      dormantUntilDemand: false,
      reasons: ["the test's decision"],
      verdicts: [],
      ...p.decision,
    },
    consent: { remote: null },
    tool: { command: "openclaw embedder fit", version: "test" },
    history: p.history ?? [],
  };
}

type Harness = {
  deps: Partial<EmbedderFitRuntimeDeps>;
  probe: Mock<EmbedderFitRuntimeDeps["probe"]>;
  spawn: Mock<EmbedderFitRuntimeDeps["spawn"]>;
  /** End the index-th started fit with this exit code. */
  exit: (index: number, code: number | null) => void;
};

/** An idle 4-core host whose Ollama answers with whatever `ollama` returns at each probe. */
function harness(ollama: () => OllamaProbe): Harness {
  const exits: Array<(code: number | null) => void> = [];
  const probe = vi.fn<EmbedderFitRuntimeDeps["probe"]>(async () => ollama());
  const spawn = vi.fn<EmbedderFitRuntimeDeps["spawn"]>(
    (): SpawnedFit => ({
      pid: 4242,
      onExit: (listener) => {
        exits.push(listener);
      },
    }),
  );
  return {
    probe,
    spawn,
    exit: (index, code) => {
      const listener = exits[index];
      if (!listener) {
        throw new Error(`fit ${index} was never started`);
      }
      listener(code);
    },
    deps: {
      stateDir,
      probe,
      spawn,
      loadavg: () => [0, 0, 0],
      logicalCores: () => 4,
      fitLockAgeMs: () => undefined,
      logDir: () => path.join(stateDir, "logs"),
      entryScript: () => ENTRY,
    },
  };
}

function registeredHook(): (request: GovernorRemeasureRequest) => void {
  const hook = captured.hook;
  if (!hook) {
    throw new Error("the check registered no re-measure hook");
  }
  return hook;
}

describe("scheduleEmbedderFitCheck", () => {
  it("starts exactly one background fit when the fingerprint changed", async () => {
    const here = cheapFingerprint();
    writeEmbedderFit(
      fitRecord({
        fingerprint: { ...here, gpu: { ...here.gpu }, logicalCores: here.logicalCores + 64 },
      }),
      stateDir,
    );
    const h = harness(() => ollamaWith([MODEL]));
    let handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0]?.[0]).toMatchObject({
      args: expect.arrayContaining([ENTRY, "embedder", "fit", "--background"]),
      logFile: path.join(stateDir, "logs", "embedder-fit.log"),
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("this machine changed since the last fit (logicalCores)"),
    );
    expect(fs.existsSync(path.join(stateDir, "memory", "embedder-fit-spawn.json"))).toBe(true);

    // A gateway restart while that fit still runs starts nothing.
    handle.stop();
    handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    // The fit ends with nothing measured (exit 75); after one more restart the next waits a day.
    h.exit(0, 75);
    handle.stop();
    handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    await advance(DAY_MS - MINUTE_MS);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await advance(2 * MINUTE_MS);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("starts the fit without the gateway's inspector flags and their separate values", async () => {
    const saved = Object.getOwnPropertyDescriptor(process, "execArgv");
    Object.defineProperty(process, "execArgv", {
      value: ["--inspect-port", "9230", "--max-old-space-size=512", "--inspect=127.0.0.1:9229"],
      configurable: true,
      writable: true,
    });
    try {
      const h = harness(() => ollamaWith([MODEL]));
      const handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
      expect(h.spawn.mock.calls[0]?.[0]?.args).toEqual([
        "--max-old-space-size=512",
        ENTRY,
        "embedder",
        "fit",
        "--background",
      ]);
      handle.stop();
    } finally {
      if (saved) {
        Object.defineProperty(process, "execArgv", saved);
      }
    }
  });

  it("starts nothing, and logs nothing at info level, while an armed record still fits", async () => {
    writeEmbedderFit(fitRecord(), stateDir);
    const h = harness(() => ollamaWith([MODEL]));
    const handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    await advance(2 * DAY_MS);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    handle.stop();
  });

  it("logs one word-index line when the unchanged record is off", async () => {
    writeEmbedderFit(fitRecord({ decision: offDecision("every gate failed here") }), stateDir);
    const h = harness(() => ollamaWith([MODEL]));
    const handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "memory search: word index only (every gate failed here); turn on: openclaw embedder fit --pull",
    );
    handle.stop();
  });

  it("re-probes at 10, 20 and 40 min while no embedder is reachable, then fits when a ladder model appears", async () => {
    writeEmbedderFit(
      fitRecord({
        ollama: UNREACHABLE,
        decision: offDecision("no embedding endpoint: Ollama is not reachable"),
      }),
      stateDir,
    );
    let ollama = UNREACHABLE;
    const h = harness(() => ollama);
    const handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    expect(h.probe).toHaveBeenCalledTimes(1);
    await advance(10 * MINUTE_MS - 1);
    expect(h.probe).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.probe).toHaveBeenCalledTimes(2);
    await advance(20 * MINUTE_MS);
    expect(h.probe).toHaveBeenCalledTimes(3);
    await advance(40 * MINUTE_MS);
    expect(h.probe).toHaveBeenCalledTimes(4);
    expect(h.spawn).not.toHaveBeenCalled();
    // One line at start and none per re-probe (#26: no error lines while nothing changes).
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();

    ollama = ollamaWith([MODEL]);
    await advance(80 * MINUTE_MS);
    expect(h.probe).toHaveBeenCalledTimes(5);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("caps the re-probe backoff at 24 h", () => {
    expect([0, 1, 2, 7, 8, 9, 40].map((attempt) => reprobeDelayMs(attempt))).toEqual([
      10 * MINUTE_MS,
      20 * MINUTE_MS,
      40 * MINUTE_MS,
      1280 * MINUTE_MS,
      DAY_MS,
      DAY_MS,
      DAY_MS,
    ]);
  });

  it("starts at most one fit a day for the governor's re-measure requests", async () => {
    writeEmbedderFit(fitRecord(), stateDir);
    const h = harness(() => ollamaWith([MODEL]));
    const handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    const hook = registeredHook();
    expect(h.spawn).not.toHaveBeenCalled();
    hook(REQUEST);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.exit(0, 0);
    await advance(6 * HOUR_MS);
    hook(REQUEST);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await advance(DAY_MS);
    hook(REQUEST);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("starts no automatic re-measure once the last two fits made the same decision", async () => {
    writeEmbedderFit(
      fitRecord({
        history: [
          {
            at: "2026-10-28T12:00:00.000Z",
            mode: "memory",
            model: MODEL,
            reason: "an earlier fit",
          },
        ],
      }),
      stateDir,
    );
    const h = harness(() => ollamaWith([MODEL]));
    const handle = await scheduleEmbedderFitCheck({ cfg, log }, h.deps);
    registeredHook()(REQUEST);
    await flush();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("the last two fits both decided memory with granite-embedding:30m"),
    );
    handle.stop();
  });

  it("does nothing under a test runner when no state dir is given", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    const h = harness(() => ollamaWith([MODEL]));
    const handle = await scheduleEmbedderFitCheck({ cfg, log }, { probe: h.probe, spawn: h.spawn });
    await advance(DAY_MS);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(captured.hook).toBeUndefined();
    handle.stop();
  });
});

describe("noteEmbedderFit", () => {
  it("notes every verdict with its provenance and how to re-measure, and measures nothing without --fix", async () => {
    writeEmbedderFit(fitRecord({ decision: { verdicts: [QUERY_VERDICT] } }), stateDir);
    const note = vi.fn();
    await noteEmbedderFit({ cfg, repair: false, deep: false, note, stateDir });
    expect(note).toHaveBeenCalledTimes(1);
    const [text, title] = note.mock.calls[0] ?? [];
    expect(title).toBe("Embedder fit");
    expect(text).toContain("memory search: granite-embedding:30m for memory files, armed");
    expect(text).toContain(
      "- query granite-embedding:30m: 1672 vs break-even 4850, pass (queryP95Ms local-measured, recallGain third-party-reported)",
    );
    expect(text).toContain("Re-measure this machine: openclaw doctor --fix");
    expect(readEmbedderFit(stateDir)?.history).toHaveLength(1);
  });

  it("never runs the real fit under a test runner, even with --fix and a state dir", async () => {
    writeEmbedderFit(fitRecord(), stateDir);
    const note = vi.fn();
    await noteEmbedderFit({ cfg, repair: true, deep: false, note, stateDir, interactive: false });
    expect(measure.runEmbedderFit).not.toHaveBeenCalled();
    const [text] = note.mock.calls[0] ?? [];
    expect(text).toContain("Not re-measured: under a test runner");
    expect(text).toContain("memory search: granite-embedding:30m for memory files, armed");
  });

  it("re-measures with --fix through the injected fit and asks nothing outside a terminal", async () => {
    writeEmbedderFit(fitRecord(), stateDir);
    const runFit = vi.fn(async (_opts: RunEmbedderFitOptions) => undefined);
    const note = vi.fn();
    const progress = vi.fn();
    await noteEmbedderFit({
      cfg,
      repair: true,
      deep: false,
      note,
      stateDir,
      interactive: false,
      log: progress,
      runFit,
    });
    expect(runFit).toHaveBeenCalledTimes(1);
    const opts = runFit.mock.calls[0]?.[0];
    expect(opts).toMatchObject({
      allowPull: false,
      background: false,
      consentVia: "doctor",
      interactive: false,
      stateDir,
      command: "openclaw doctor --fix",
    });
    await expect(opts?.deps?.confirm?.("Download a model?")).resolves.toBe(false);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("at most 5 minutes"));
    expect(note.mock.calls[0]?.[0]).toContain("Re-measured this machine.");
    expect(measure.runEmbedderFit).not.toHaveBeenCalled();
  });
});
