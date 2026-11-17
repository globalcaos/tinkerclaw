// FORK 2026-10-29: the embedder governor (TINKER_UI_DESIGN_BIBLE/embedder-fit.md), the one runtime
// rate- and latency-control mechanism for every fork-path embedding call.
//
// What went wrong without it, on the reference host: about 20 requests were queued at once into an
// Ollama server with one slot (4 files x about 5 requests per batch); deadlines only raced and never
// cancelled, so served latencies reached 1,560 s; timed-out batches were retried; nothing stopped the
// cycle (90 timed-out batches in two hours); and a second producer queued 128-text batches on the
// same slot on every weak-lexical turn.
//
// What it does. Every provider createEmbeddingProvider returns, and every fork call site that builds
// its own adapter, is wrapped by governEmbeddingProvider. Each embedding call then passes through one
// queue per endpoint (provider + base URL), shared by every consumer:
//   - a limiter at the measured concurrency (1 per local server) with two FIFO lanes, foreground
//     first; a foreground call whose budget cannot be met is refused at once, and one still queued
//     when its budget runs out is refused then;
//   - background calls to a local endpoint wait for idle CPU (the idle gate) and for no running fit;
//   - an abortable deadline per request, derived from its tokens and the measured throughput; a
//     request given up (its deadline, or its caller's abort) keeps its slot until the provider
//     settles, at most one more deadline, and a caller's abort never counts against the breaker;
//   - a circuit breaker for machine-local endpoints, with a derived threshold and a doubling cool-down;
//   - admission for the core index: demand (dormancy) and keep-up (step-down), from the fit record;
//   - trials that retire a per-turn lane which rescues nothing (#25);
//   - a snapshot on disk, so a gateway restart keeps demand, trials and the breaker.
// No retries happen here: the caller decides, and never retries an EmbedderUnavailableError.
//
// One owner per derivation (#18): every formula is called from src/fork/embedder-fit.ts; this file
// measures, queues and decides with them, and re-derives none. Its own constants are windows and
// clocks, each with its objective, its source and what would move it.
//
// Endpoint and model (FORK 2026-10-30, review findings #3 and #6). The queue, the slot pool, the
// breaker, demand and contention belong to the endpoint. Live measurements, the backlog, dormancy
// and trials belong to each model on it, and the mode (fit or pin) to each consumer, so building a
// wrapper for another model or mode changes nothing for the wrappers already there. A fit record's
// measurements count only at the endpoint they were taken at (fitBudgetFor's endpointKey).
//
// Cross-bundle live state: the governors sit on globalThis[Symbol.for('openclaw.embedGovernor.v1')],
// looked up per call and never held in a module-level const (architecture.md).
//
// Test sandbox by construction (the algorithm-metrics rule): under a test runner the default
// environment reads and writes no state file unless OPENCLAW_STATE_DIR is set, samples no CPU
// pressure, sees no fit lock and reports an idle host, so no test writes the real state dir or depends
// on the live load of the machine it runs on. readEmbedGovernorSnapshots follows the same rule
// when its caller names no state dir. Tests inject their own clock, load, pressure and IO through
// __resetEmbedGovernorsForTest(env).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordAlgorithmOutcome, type MetricProvenance } from "../infra/algorithm-metrics.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import type { EmbeddingInput } from "../memory/embedding-inputs.js";
import type {
  EmbedCallOptions,
  EmbeddingProvider,
  EmbedMeasurement,
} from "../memory/embeddings.js";
import type { MemorySource } from "../memory/types.js";
import { estimateTokensFromChars } from "../utils/cjk-chars.js";
import {
  breakerCooldownMs,
  breakerThreshold,
  classifyEmbeddingEndpoint,
  EMBED_CEILINGS,
  embedderFitPaths,
  endpointKeyFor,
  fitBudgetFor,
  idleGateOpen,
  normalizeEmbeddingModelName,
  ramFits,
  readEmbedderFit,
  requestDeadlineMs,
  trialInvocations,
  type CandidateMeasurement,
  type EmbedderFitRecord,
  type EmbeddingEndpointClass,
  type FitBudget,
  type FitDecision,
} from "./embedder-fit.js";

// -------------------------------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------------------------------

/** Who is embedding. The memory index's batches default to the background lane. */
export type EmbedConsumer =
  | "memory-index"
  | "memory-query"
  | "prefrontal"
  | "skill-search"
  | "limbic";

/** Why the governor refused or abandoned a call. The caller serves words instead. */
export type EmbedderUnavailableReason =
  | "breaker-open"
  | "deadline"
  | "over-budget"
  | "busy"
  | "aborted";

/** The core index asks before it embeds. A refusal means: write words now, vectors later. */
export type AdmitResult =
  | { ok: true }
  | {
      ok: false;
      reason: "off" | "breaker-open" | "dormant" | "busy" | "stepped-down" | "sessions-not-decided";
    };

/** 'fit': the provider came from the fit's decision. 'pin': configured by hand, protection only. */
export type EmbedGovernMode = "fit" | "pin";

/** Who asked for a memory search. 'probe' and 'internal' never count as demand. */
export type EmbedQueryCaller = "agent" | "rpc" | "probe" | "internal";

export type EmbedBreakerState = "closed" | "open" | "half-open";

/** The working bounds for one endpoint now, and where they came from. */
export type EmbedBudget = {
  concurrency: number;
  batchTokens: number;
  batchDeadlineMs: number;
  queryDeadlineMs: number;
  /** Retries the caller may spend on an HTTP 5xx: 0 for a local server, today's 3 for a remote API. */
  retries5xx: number;
  keepAlive?: string;
  numThread?: number;
  source: "fit-record" | "live" | "ceiling";
};

/** What the re-measure hook receives: one background fit is wanted, and why. */
export type GovernorRemeasureRequest = {
  endpointKey: string;
  providerId: string;
  model: string;
  reason: "step-down" | "theta-drift";
  detail: string;
};

export type EmbedTrialState = {
  retired: boolean;
  n: number;
  invocations: number;
  recoveries: number;
};

/** Live latency of the foreground query window (the newest 200 embedQuery calls). */
export type EmbedQueryWindow = { n: number; meanMs?: number; p50Ms?: number; p95Ms?: number };

/**
 * One consumer's view of its endpoint's governor. The queue, slot pool and breaker are the
 * endpoint's; `model` and `mode` are the consumer's own (FORK 2026-10-30, review finding #6).
 */
export type EmbedGovernor = {
  readonly endpointKey: string;
  readonly providerId: string;
  readonly endpointClass: EmbeddingEndpointClass;
  readonly model: string;
  readonly mode: EmbedGovernMode;
  budget(kind: "index" | "query"): EmbedBudget;
  admit(kind: "index" | "query", source?: MemorySource): AdmitResult;
  noteQuery(caller: EmbedQueryCaller, scanMs?: number): void;
  notePending(source: MemorySource, tokens: number): void;
  noteDrained(source: MemorySource, tokens: number): void;
  noteTrial(consumer: EmbedConsumer, outcome: { invoked: boolean; recovered: number }): void;
  trialState(
    consumer: EmbedConsumer,
    p: { missCostMs: number; meanQueryMs: number; catalogKey: string },
  ): EmbedTrialState;
  liveQueryWindow(): EmbedQueryWindow;
  snapshot(): EmbedGovernorSnapshot;
  /** Write the snapshot file now (and wait for it). */
  flush(): Promise<void>;
};

const UNAVAILABLE_NAME = "EmbedderUnavailableError";

/**
 * The governor refused or abandoned a call. Callers serve words (the keyword half, a word-only index
 * row) and never retry it. `instanceof` also matches a copy of this class from another bundle.
 */
export class EmbedderUnavailableError extends Error {
  readonly reason: EmbedderUnavailableReason;

  constructor(reason: EmbedderUnavailableReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = UNAVAILABLE_NAME;
    this.reason = reason;
  }

  static [Symbol.hasInstance](value: unknown): value is EmbedderUnavailableError {
    return (
      value instanceof Error &&
      value.name === UNAVAILABLE_NAME &&
      typeof (value as { reason?: unknown }).reason === "string"
    );
  }
}

/** What the governor reads from the machine and writes to disk. Every field is injectable for tests. */
export type EmbedGovernorEnv = {
  now: () => number;
  /** os.loadavg(); load1 is the first entry. */
  loadavg: () => number[];
  logicalCores: () => number;
  memAvailableBytes: () => number;
  totalMemBytes: () => number;
  /** CPU pressure 'some avg10' in percent, or undefined; null where it is not measured. */
  readPsi: (() => Promise<number | undefined>) | null;
  /** Age of the fit's lock file in ms, or undefined when there is none. */
  fitLockAgeMs: () => number | undefined;
  /** State dir for the fit record and the snapshot; null: no file IO at all; unset: the default. */
  stateDir?: string | null;
  readSnapshotFile: (file: string) => string | undefined;
  /** Synchronous and atomic: the snapshot is a few KB, written at most once a minute plus transitions. */
  writeSnapshotFile: (file: string, data: string) => void;
  log: { info: (message: string) => void; warn: (message: string) => void };
};

// -------------------------------------------------------------------------------------------------
// The governor's own windows and clocks (#19: objective, source, what would move each)
// -------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Live windows keep the newest 200 calls per kind. Objective: throughput and latency estimates that
 * follow the machine within a few hundred calls. Source: the design's live window. Changes if the
 * estimates prove too noisy (longer) or too slow to follow load (shorter).
 */
const LIVE_WINDOW_CALLS = 200;

/**
 * Calls before a live estimate replaces a prior. Objective: no deadline, dispersion or contention
 * estimate from a handful of calls. Source: fit-core keeps dispersion at its prior 2 until 20 calls,
 * and the remote 120 s batch prior holds until 20 calls. Changes with that rule.
 */
const LIVE_MIN_CALLS = 20;

/** Real demand is averaged over the trailing 7 days (the demand threshold's window). */
const DEMAND_DAYS = 7;

/**
 * Snapshot writes: on every transition, otherwise at most once a minute. Objective: a restart loses
 * at most a minute of counts while the disk sees at most 1,440 small writes a day. Changes if
 * restarts become frequent enough that a minute of demand matters.
 */
const PERSIST_INTERVAL_MS = 60_000;

/**
 * Own duty u is measured over the last 60 s because load1 is a one-minute average: u is the share of
 * that minute with a request of this endpoint in flight (the idle gate subtracts its own load).
 */
const DUTY_WINDOW_MS = 60_000;

/**
 * A fit lock younger than 10 min means a fit is measuring: background calls stay off the endpoint so
 * they neither disturb its measurements nor queue behind them. 10 min is twice the fit's 5-minute
 * hard ceiling, so an older lock is a fit that died. Changes with that ceiling.
 */
const FIT_LOCK_FRESH_MS = 600_000;

/**
 * CPU pressure sampling: every 30 s while background work waits or runs, every 5 min otherwise.
 * Objective: enough samples during and outside background calls to measure contention c, for one
 * small file read per sample. Changes if c needs a faster estimate.
 */
const PSI_BUSY_INTERVAL_MS = 30_000;
const PSI_IDLE_INTERVAL_MS = 300_000;

/**
 * How long Ollama keeps a model resident when no keep_alive is sent: its documented default, 5 min.
 * Used only to decide whether the next request pays the cold-load term. Changes with OLLAMA_KEEP_ALIVE.
 */
const OLLAMA_DEFAULT_KEEP_ALIVE_MS = 300_000;

/**
 * keep_alive bounds. Objective: the model stays resident across this endpoint's usual gaps, so calls
 * skip the cold load, while RAM fits. 2 x the median gap covers most gaps; 5 min is Ollama's own
 * default, so the governor never asks for less than the server would do anyway; 24 h caps how long
 * an idle model holds RAM. Changes with the call pattern or the RAM gate.
 */
const KEEP_ALIVE_MIN_MS = 300_000;
const KEEP_ALIVE_MAX_MS = DAY_MS;

/** At most one automatic re-measure per 24 h (the design's stopping rule). */
const REMEASURE_MIN_INTERVAL_MS = DAY_MS;

/**
 * Two consecutive 24 h windows that fell behind trigger a step-down (#25): one bad day can be a
 * burst, two in a row is a machine that cannot keep up. Changes if bursts last longer than a day.
 */
const STEP_DOWN_WINDOWS = 2;

/** Remote providers keep today's 5xx retry policy: 3 retries. */
const REMOTE_RETRIES_5XX = 3;

/**
 * The rule of three bounds a failure rate at 3/n after n clean calls. With 3 or fewer clean calls
 * there is no bound: the limit p -> 1, kept just below 1 where breakerThreshold is defined, sends F
 * to its upper clamp, the most tolerant threshold, until there is evidence.
 */
const RULE_OF_THREE_CEILING = 1 - Number.EPSILON;

const SOURCES: readonly MemorySource[] = ["memory", "sessions"];
const CALLERS: ReadonlySet<string> = new Set<EmbedQueryCaller>([
  "agent",
  "rpc",
  "probe",
  "internal",
]);
const STORE_SLOT = Symbol.for("openclaw.embedGovernor.v1");
const GOVERNED_SLOT = Symbol.for("openclaw.embedGovernor.governed.v1");
const SNAPSHOT_SCHEMA = 1;
const OK: AdmitResult = Object.freeze({ ok: true });

// -------------------------------------------------------------------------------------------------
// Internal shapes
// -------------------------------------------------------------------------------------------------

type Lane = "foreground" | "background";
type WindowKind = "query" | "index";

/** One completed call: tokens (Ollama's count when reported), wall time, and theta when timed. */
type Sample = { tokens: number; wallMs: number; theta?: number; loadMs?: number };

type Slot = {
  lane: Lane;
  startedAt: number;
  expectedMs: number;
  /**
   * FORK 2026-10-30: set when the call was given up (its deadline, or its caller's abort) while
   * the provider still ran. It resolves when the provider settles or the hold bound passes
   * (holdSlot), and only then is the slot free.
   */
  hold?: Promise<void>;
};

type Waiter = {
  lane: Lane;
  expectedMs: number;
  grant: (slot: Slot) => void;
  fail: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** FORK 2026-10-30: a budgeted foreground waiter leaves the queue when its budget runs out. */
  expiry?: ReturnType<typeof setTimeout>;
};

type PartialCall<T> = {
  inputs: number;
  tokens: number;
  run: (opts: EmbedCallOptions) => Promise<T>;
};

type GovernedCall<T> = PartialCall<T> & {
  kind: WindowKind;
  /** The calling consumer's model: its samples land in that model's state (FORK 2026-10-30). */
  model: string;
  lane: Lane;
  opts: EmbedCallOptions | undefined;
  /** A multi-input call split into its first input (the half-open probe) and the rest. */
  split?: { first: PartialCall<T>; rest: PartialCall<T>; join: (a: T, b: T) => T };
};

type GovernedSpec = {
  endpointKey: string;
  providerId: string;
  model: string;
  baseUrl?: string;
  mode: EmbedGovernMode;
  consumer: EmbedConsumer;
};

type RecordView = {
  budget: FitBudget | null;
  record: EmbedderFitRecord | null;
  candidate: CandidateMeasurement | undefined;
  /** The record's decision when it names this provider and model and is not 'off'. */
  decision: FitDecision | undefined;
};

/**
 * FORK 2026-10-30 (review finding #6): one model's own state on its endpoint. Its live samples,
 * backlog and keep-up windows, dormancy and arming, and trials. A second model on the endpoint
 * gets its own, so building that model's wrapper erases nothing of the first. `live`: a consumer
 * in this process uses the model. A state restored from the snapshot is not live until one does,
 * so neither its keep-up windows nor its bounds count before then.
 */
type ModelState = {
  model: string;
  live: boolean;
  samples: Record<WindowKind, Sample[]>;
  sources: Record<MemorySource, EmbedSourceState>;
  armedModel: string | undefined;
  dormant: boolean;
  trials: Record<string, EmbedTrialRecord>;
};

export type EmbedDayBucket = {
  /** UTC day number: floor(ms / 86,400,000). */
  day: number;
  agent: number;
  rpc: number;
  probe: number;
  internal: number;
  scanMsSum: number;
  scanN: number;
  calls: number;
  failures: number;
  deadlines: number;
  /** FORK 2026-10-30: sent calls their caller aborted. Not failures: the endpoint is not blamed. */
  aborted: number;
  /** FORK 2026-10-30: slots freed at the hold bound while a given-up call still ran. */
  abandoned: number;
  refusedBusy: number;
  refusedOverBudget: number;
  refusedBreaker: number;
  breakerTrips: number;
  tokensForeground: number;
  tokensBackground: number;
  wallMsForeground: number;
  wallMsBackground: number;
};

export type EmbedKeepUpWindow = {
  start: number;
  arrived: number;
  drained: number;
  /** The idle gate closed, the breaker opened or dormancy held: the window is no keep-up evidence. */
  hindered: boolean;
};

export type EmbedSourceState = {
  pendingTokens: number;
  window: EmbedKeepUpWindow;
  /** The newest closed windows, oldest first (at most 2). */
  closed: EmbedKeepUpWindow[];
  shortStreak: number;
  /** This source was ever noted or admitted under the current model. */
  seen: boolean;
};

export type EmbedTrialRecord = {
  invocations: number;
  recoveries: number;
  catalogKey?: string;
  model?: string;
};

export type EmbedContentionParts = {
  duringSum: number;
  duringN: number;
  outsideSum: number;
  outsideN: number;
};

export type EmbedBreakerRecord = {
  state: EmbedBreakerState;
  consecutiveFailures: number;
  consecutiveTrips: number;
  cleanCalls: number;
  openedAt?: number;
  cooldownMs?: number;
};

/** One model's own persisted state on an endpoint: its backlog, its admission and its trials. */
export type EmbedModelSnapshot = {
  model: string;
  sources: Record<MemorySource, EmbedSourceState>;
  armedModel?: string;
  dormant: boolean;
  trials: Record<string, EmbedTrialRecord>;
};

/** One endpoint's persisted state: what `openclaw embedder status` and doctor print. */
export type EmbedGovernorSnapshot = {
  schemaVersion: 1;
  endpointKey: string;
  providerId: string;
  model: string;
  endpointClass: EmbeddingEndpointClass;
  mode: EmbedGovernMode;
  savedAt: string;
  firstDay: number;
  accountedDay: number;
  breaker: EmbedBreakerRecord;
  /** Day buckets of the trailing 7 days, oldest first. */
  days: EmbedDayBucket[];
  sources: Record<MemorySource, EmbedSourceState>;
  stepDown: { level: 0 | 1 | 2; recordAt?: string };
  /** The model the index was admitted under at least once (the initial backlog is no longer whole). */
  armedModel?: string;
  dormant: boolean;
  trials: Record<string, EmbedTrialRecord>;
  /**
   * FORK 2026-10-30: every model's own state on this endpoint, by normalized model name. The top
   * level's model, sources, armedModel, dormant and trials repeat the primary model's entry for
   * readers of the older shape; a snapshot without this field restores into the model it names.
   */
  models?: Record<string, EmbedModelSnapshot>;
  contention: EmbedContentionParts;
  lastRemeasureAt?: number;
  /** Values derived for readers; ignored when the snapshot is loaded. */
  derived: {
    failureThreshold: number;
    demandPerDay: number;
    contention?: number;
    pendingTokens: number;
  };
};

type SnapshotFile = { schemaVersion: 1; savedAt: string; governors: Record<string, unknown> };

type GovernorStore = {
  governors: Map<string, Governor>;
  env: EmbedGovernorEnv;
  remeasureHook?: (request: GovernorRemeasureRequest) => void;
  /** Snapshots read from disk at first use, by endpoint key; a write keeps the ones not live here. */
  disk?: Map<string, unknown>;
  generation: number;
  psiTimer?: ReturnType<typeof setTimeout>;
  writeTimer?: ReturnType<typeof setTimeout>;
  /** A write is building its snapshots: a nested request is already covered by it. */
  inWrite: boolean;
  lastWriteAt: number;
  warnedWrite: boolean;
};

// -------------------------------------------------------------------------------------------------
// The store: one globalThis slot, resolved per call
// -------------------------------------------------------------------------------------------------

function governorStore(): GovernorStore {
  const slot = globalThis as Record<PropertyKey, unknown>;
  let store = slot[STORE_SLOT] as GovernorStore | undefined;
  if (!store) {
    store = {
      governors: new Map(),
      env: defaultGovernorEnv(),
      generation: 0,
      inWrite: false,
      lastWriteAt: Number.NEGATIVE_INFINITY,
      warnedWrite: false,
    };
    slot[STORE_SLOT] = store;
  }
  return store;
}

function governorEnv(): EmbedGovernorEnv {
  return governorStore().env;
}

function isTestRunner(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/** undefined: the default state dir; null: no file IO (a sandboxed test, or env.stateDir null). */
function ioStateDir(env: Pick<EmbedGovernorEnv, "stateDir">): string | null | undefined {
  if (env.stateDir !== undefined) {
    return env.stateDir;
  }
  return isTestRunner() && !process.env.OPENCLAW_STATE_DIR?.trim() ? null : undefined;
}

function defaultGovernorEnv(): EmbedGovernorEnv {
  const testing = isTestRunner();
  let logger: SubsystemLogger | undefined;
  const log = (): SubsystemLogger => (logger ??= createSubsystemLogger("memory/embedder"));
  return {
    now: () => Date.now(),
    loadavg: () => (testing ? [0, 0, 0] : os.loadavg()),
    logicalCores: () =>
      os.cpus().length ||
      (typeof os.availableParallelism === "function" ? os.availableParallelism() : 1),
    memAvailableBytes: () => os.freemem(),
    totalMemBytes: () => os.totalmem(),
    readPsi: !testing && process.platform === "linux" ? readCpuPressureSomeAvg10 : null,
    fitLockAgeMs: () => {
      const dir = ioStateDir(governorEnv());
      if (dir === null) {
        return undefined;
      }
      try {
        return Math.max(0, governorEnv().now() - fs.statSync(embedderFitPaths(dir).lock).mtimeMs);
      } catch {
        return undefined;
      }
    },
    readSnapshotFile: (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    writeSnapshotFile: writeFileAtomic,
    log: {
      info: (message) => log().info(message),
      warn: (message) => log().warn(message),
    },
  };
}

/** 'some avg10' of /proc/pressure/cpu: the share of the last 10 s some task waited for a CPU. */
async function readCpuPressureSomeAvg10(): Promise<number | undefined> {
  const text = await fs.promises.readFile("/proc/pressure/cpu", "utf8");
  const match = /^some\b.*?\bavg10=([\d.]+)/m.exec(text);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** tmp file + rename, mode 0600: a reader never sees half a snapshot. */
function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function snapshotFilePath(env: EmbedGovernorEnv): string | null {
  const dir = ioStateDir(env);
  if (dir === null) {
    return null;
  }
  try {
    return embedderFitPaths(dir).governor;
  } catch {
    return null;
  }
}

function loadDiskSnapshots(store: GovernorStore): Map<string, unknown> {
  if (store.disk) {
    return store.disk;
  }
  const disk = new Map<string, unknown>();
  store.disk = disk;
  const file = snapshotFilePath(store.env);
  const text = file ? store.env.readSnapshotFile(file) : undefined;
  if (!text) {
    return disk;
  }
  try {
    const parsed = JSON.parse(text, decodeNonFinite) as Partial<SnapshotFile>;
    if (parsed?.schemaVersion === SNAPSHOT_SCHEMA && parsed.governors) {
      for (const [key, value] of Object.entries(parsed.governors)) {
        disk.set(key, value);
      }
    }
  } catch {
    store.env.log.warn("embedder governor: the snapshot file is unreadable; starting from zero");
  }
  return disk;
}

/** Ask for a snapshot write: now on a transition, otherwise at most once a minute. */
function persistSoon(transition: boolean): void {
  const store = governorStore();
  if (store.inWrite || !snapshotFilePath(store.env)) {
    return;
  }
  if (transition) {
    writeSnapshots(store);
    return;
  }
  if (store.writeTimer) {
    return;
  }
  const waitMs = Math.max(0, store.lastWriteAt + PERSIST_INTERVAL_MS - store.env.now());
  if (waitMs === 0) {
    writeSnapshots(store);
    return;
  }
  const generation = store.generation;
  store.writeTimer = unrefTimer(
    setTimeout(() => {
      const current = governorStore();
      if (current.generation !== generation) {
        return;
      }
      current.writeTimer = undefined;
      writeSnapshots(current);
    }, waitMs),
  );
}

/** Write every live governor's snapshot, keeping the ones on disk that are not live here. */
function writeSnapshots(store: GovernorStore): void {
  const file = snapshotFilePath(store.env);
  if (!file || store.inWrite) {
    return;
  }
  if (store.writeTimer) {
    clearTimeout(store.writeTimer);
    store.writeTimer = undefined;
  }
  store.inWrite = true;
  try {
    const governors: Record<string, unknown> = Object.fromEntries(loadDiskSnapshots(store));
    for (const [key, governor] of store.governors) {
      governors[key] = governor.snapshot();
    }
    const body: SnapshotFile = {
      schemaVersion: SNAPSHOT_SCHEMA,
      savedAt: new Date(store.env.now()).toISOString(),
      governors,
    };
    store.lastWriteAt = store.env.now();
    store.env.writeSnapshotFile(file, `${JSON.stringify(body, encodeNonFinite, 2)}\n`);
  } catch (err) {
    if (!store.warnedWrite) {
      store.warnedWrite = true;
      store.env.log.warn(`embedder governor: cannot write ${file} (${errorText(err)})`);
    }
  } finally {
    store.inWrite = false;
  }
}

/**
 * The persisted snapshots by endpoint key, for `openclaw embedder status` and doctor. Under a test
 * runner with no state dir and no OPENCLAW_STATE_DIR: none, and no file read (ioStateDir's rule).
 */
export function readEmbedGovernorSnapshots(
  stateDir?: string,
): Record<string, EmbedGovernorSnapshot> {
  const dir = ioStateDir({ stateDir });
  if (dir === null) {
    return {};
  }
  try {
    const text = fs.readFileSync(embedderFitPaths(dir).governor, "utf8");
    const parsed = JSON.parse(text, decodeNonFinite) as Partial<SnapshotFile>;
    if (parsed?.schemaVersion !== SNAPSHOT_SCHEMA || !parsed.governors) {
      return {};
    }
    return parsed.governors as Record<string, EmbedGovernorSnapshot>;
  } catch {
    return {};
  }
}

/** The CPU pressure sampler: one per process, on an unref'd timer, only where PSI exists. */
function ensurePressureSampler(): void {
  const store = governorStore();
  if (store.psiTimer || !store.env.readPsi) {
    return;
  }
  const hasLocal = [...store.governors.values()].some((g) => g.endpointClass !== "remote");
  if (!hasLocal) {
    return;
  }
  schedulePressureSample(PSI_BUSY_INTERVAL_MS);
}

function schedulePressureSample(delayMs: number): void {
  const store = governorStore();
  const generation = store.generation;
  store.psiTimer = unrefTimer(
    setTimeout(() => {
      void samplePressure(generation);
    }, delayMs),
  );
}

async function samplePressure(generation: number): Promise<void> {
  const store = governorStore();
  if (store.generation !== generation) {
    return;
  }
  store.psiTimer = undefined;
  const read = store.env.readPsi;
  if (!read) {
    return;
  }
  let value: number | undefined;
  try {
    value = await read();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      // A kernel without PSI: contention stays unmeasured (c = 1) and the sampler stops.
      return;
    }
    value = undefined;
  }
  if (governorStore().generation !== generation) {
    return;
  }
  let backgroundWaiting = false;
  for (const governor of store.governors.values()) {
    if (value !== undefined) {
      governor.notePressure(value);
    }
    backgroundWaiting ||= governor.hasBackgroundWork();
  }
  schedulePressureSample(backgroundWaiting ? PSI_BUSY_INTERVAL_MS : PSI_IDLE_INTERVAL_MS);
}

// -------------------------------------------------------------------------------------------------
// The governor
// -------------------------------------------------------------------------------------------------

class Governor {
  readonly endpointKey: string;
  readonly providerId: string;
  readonly endpointClass: EmbeddingEndpointClass;
  /**
   * FORK 2026-10-30: the model registered most recently. The snapshot's top level shows its
   * state, and the endpoint's own derivations (the breaker's threshold and cool-down) read its
   * record.
   */
  private primary: string;
  /**
   * FORK 2026-10-30: 'fit' once any consumer of this endpoint was built in mode fit, else 'pin'.
   * The snapshot, the ledger labels, the step-down advice and getEmbedGovernor's callers read it:
   * those callers hold no provider, so they have no mode of their own. A wrapper's admission
   * never reads it (review finding #6).
   */
  reportedMode: EmbedGovernMode;
  /** Each model's own state, by normalized model name (FORK 2026-10-30). */
  private readonly models = new Map<string, ModelState>();

  private readonly queues: Record<Lane, Waiter[]> = { foreground: [], background: [] };
  private readonly slots = new Set<Slot>();
  private probeInFlight = false;
  private breaker: EmbedBreakerRecord = {
    state: "closed",
    consecutiveFailures: 0,
    consecutiveTrips: 0,
    cleanCalls: 0,
  };
  private dispatchTimes: number[] = [];
  private lastSettledAt: number | undefined;
  private residentMs = OLLAMA_DEFAULT_KEEP_ALIVE_MS;
  private busySince: number | undefined;
  private busyIntervals: Array<[number, number]> = [];
  private backgroundInFlight = 0;
  private days: EmbedDayBucket[] = [];
  private firstDay: number;
  private accountedDay: number;
  private stepDownLevel: 0 | 1 | 2 = 0;
  private stepDownRecordAt: string | undefined;
  private contention: EmbedContentionParts = {
    duringSum: 0,
    duringN: 0,
    outsideSum: 0,
    outsideN: 0,
  };
  private lastRemeasureAt: number | undefined;

  constructor(spec: GovernedSpec, now: number, saved: unknown) {
    this.endpointKey = spec.endpointKey;
    this.providerId = spec.providerId;
    this.endpointClass = classifyEmbeddingEndpoint({
      providerId: spec.providerId,
      baseUrl: spec.baseUrl,
    });
    this.primary = spec.model;
    this.reportedMode = spec.mode;
    const day = dayOf(now);
    this.firstDay = day;
    this.accountedDay = day - 1;
    if (saved && typeof saved === "object") {
      this.restore(saved as Partial<EmbedGovernorSnapshot>, now);
    }
    // The constructing consumer's model is in use (FORK 2026-10-30).
    this.stateOf(spec.model);
  }

  // ----- the record ------------------------------------------------------------------------------

  /**
   * The fit record's view of this provider and one model, or empty when there is none for this
   * machine. FORK 2026-10-30 (review finding #3): a record taken at another endpoint is no record
   * here (fitBudgetFor's endpointKey), so neither its bounds nor its decision reach this one.
   */
  private view(model: string): RecordView {
    const dir = ioStateDir(governorEnv());
    if (dir === null) {
      return { budget: null, record: null, candidate: undefined, decision: undefined };
    }
    const budget = fitBudgetFor(
      { providerId: this.providerId, model, endpointKey: this.endpointKey },
      dir,
    );
    if (!budget) {
      return { budget: null, record: null, candidate: undefined, decision: undefined };
    }
    const record = readEmbedderFit(dir);
    if (!record) {
      return { budget, record: null, candidate: undefined, decision: undefined };
    }
    this.noteRecord(record);
    const key = normalizeEmbeddingModelName(model);
    const candidate = record.candidates.find(
      (c) => c.provider === this.providerId && normalizeEmbeddingModelName(c.model) === key,
    );
    const d = record.decision;
    const decision =
      d.mode !== "off" &&
      d.provider === this.providerId &&
      normalizeEmbeddingModelName(d.model ?? "") === key
        ? d
        : undefined;
    return { budget, record, candidate, decision };
  }

  /** A new fit answers a step-down: embedding resumes, and the next windows are judged afresh. */
  private noteRecord(record: EmbedderFitRecord): void {
    if (record.createdAt === this.stepDownRecordAt) {
      return;
    }
    const first = this.stepDownRecordAt === undefined;
    this.stepDownRecordAt = record.createdAt;
    if (!first && this.stepDownLevel > 0) {
      this.stepDownLevel = 0;
      governorEnv().log.info(
        `embedder step-down lifted (${this.endpointKey}): a new fit was recorded, so embedding resumes`,
      );
      this.recordOutcome("step-down-lifted", {}, {});
    }
    for (const state of this.models.values()) {
      for (const source of SOURCES) {
        state.sources[source].shortStreak = 0;
      }
    }
    persistSoon(!first);
  }

  // ----- budget ----------------------------------------------------------------------------------

  budget(kind: "index" | "query", model: string): EmbedBudget {
    const view = this.view(model);
    const fit = view.budget;
    const remote = this.endpointClass === "remote";
    const index = this.liveStats(model, "index");
    const query = this.liveStats(model, "query") ?? index;
    let concurrency: number;
    let batchTokens: number;
    let batchDeadlineMs: number;
    let queryDeadlineMs: number;
    let source: EmbedBudget["source"];
    if (fit) {
      source = "fit-record";
      ({ concurrency, batchTokens, batchDeadlineMs, queryDeadlineMs } = fit);
    } else {
      source = (kind === "index" ? index : query) ? "live" : "ceiling";
      concurrency = remote ? EMBED_CEILINGS.indexConcurrency : 1;
      batchTokens = EMBED_CEILINGS.batchTokens;
      batchDeadlineMs = index
        ? requestDeadlineMs({
            tokens: batchTokens,
            tokensPerSecLow: index.thetaLow,
            dispersion: index.dispersion,
            ceilingMs: EMBED_CEILINGS.batchDeadlineMs,
          })
        : remote
          ? EMBED_CEILINGS.remotePriorBatchDeadlineMs
          : EMBED_CEILINGS.batchDeadlineMs;
      queryDeadlineMs = query
        ? requestDeadlineMs({
            tokens: query.tokensP95,
            tokensPerSecLow: query.thetaLow,
            dispersion: query.dispersion,
            ceilingMs: EMBED_CEILINGS.queryDeadlineMs,
          })
        : EMBED_CEILINGS.queryDeadlineMs;
    }
    const keepAlive = this.keepAliveFor(view);
    const numThread = fit?.numThread;
    return {
      // FORK 2026-10-30: one slot pool serves every model here, so the endpoint's bound caps it.
      concurrency: Math.max(1, Math.min(this.endpointConcurrency(), Math.floor(concurrency))),
      batchTokens: Math.max(1, Math.min(EMBED_CEILINGS.batchTokens, Math.floor(batchTokens))),
      batchDeadlineMs: Math.min(EMBED_CEILINGS.batchDeadlineMs, batchDeadlineMs),
      queryDeadlineMs: Math.min(EMBED_CEILINGS.queryDeadlineMs, queryDeadlineMs),
      retries5xx: remote ? REMOTE_RETRIES_5XX : 0,
      ...(keepAlive ? { keepAlive: keepAlive.text } : {}),
      ...(numThread !== undefined ? { numThread } : {}),
      source,
    };
  }

  private concurrencyNow(): number {
    if (this.breaker.state !== "closed" && this.hasBreaker()) {
      return 1;
    }
    return this.endpointConcurrency();
  }

  /**
   * FORK 2026-10-30: the endpoint's slot count. One pool serves every model a consumer here uses,
   * so it holds the smallest of their bounds: a local server gets 2 only when every such model
   * measured the parallel gain at this endpoint (review findings #3 and #6).
   */
  private endpointConcurrency(): number {
    let limit: number | undefined;
    for (const state of this.liveStates()) {
      const own = this.modelConcurrency(state.model);
      limit = limit === undefined ? own : Math.min(limit, own);
    }
    return limit ?? this.modelConcurrency(this.primary);
  }

  /** One model's bound: its matching record's, else 1 locally and the ceiling for a remote API. */
  private modelConcurrency(model: string): number {
    const fit = this.view(model).budget;
    const raw = fit
      ? fit.concurrency
      : this.endpointClass === "remote"
        ? EMBED_CEILINGS.indexConcurrency
        : 1;
    return Math.max(1, Math.min(EMBED_CEILINGS.indexConcurrency, Math.floor(raw)));
  }

  /**
   * keep_alive = 2 x the median gap between this endpoint's calls, within [5 min, 24 h], and only
   * when the model's measured resident size fits the RAM gate. Without a measured size, Ollama keeps
   * its own default.
   */
  private keepAliveFor(view: RecordView): { ms: number; text: string } | undefined {
    const rss = view.candidate?.rssBytes;
    if (!(typeof rss === "number" && Number.isFinite(rss) && rss >= 0)) {
      return undefined;
    }
    const gap = median(gapsOf(this.dispatchTimes));
    if (gap === undefined) {
      return undefined;
    }
    const env = governorEnv();
    if (
      !ramFits({
        rssBytes: rss,
        memAvailableBytes: env.memAvailableBytes(),
        totalRamBytes: env.totalMemBytes(),
      })
    ) {
      return undefined;
    }
    const ms = Math.min(KEEP_ALIVE_MAX_MS, Math.max(KEEP_ALIVE_MIN_MS, 2 * gap));
    return { ms, text: `${Math.round(ms / 1000)}s` };
  }

  /** One model's p05 theta, p95/p50 dispersion of per-token time, and token and wall quantiles. */
  private liveStats(
    model: string,
    kind: WindowKind,
  ):
    | {
        n: number;
        thetaLow: number;
        thetaP50: number;
        dispersion: number;
        tokensP95: number;
        loadP95Ms?: number;
      }
    | undefined {
    const timed = this.stateOf(model).samples[kind].filter(
      (s) => s.theta !== undefined && s.theta > 0,
    );
    if (timed.length < LIVE_MIN_CALLS) {
      return undefined;
    }
    const thetas = timed.map((s) => s.theta as number);
    const perToken = thetas.map((t) => 1 / t);
    const p50PerToken = quantile(perToken, 0.5);
    const loads = timed.map((s) => s.loadMs).filter((x): x is number => x !== undefined && x > 0);
    const stats = {
      n: timed.length,
      thetaLow: quantile(thetas, 0.05),
      thetaP50: quantile(thetas, 0.5),
      dispersion: p50PerToken > 0 ? quantile(perToken, 0.95) / p50PerToken : 2,
      tokensP95: quantile(
        timed.map((s) => s.tokens),
        0.95,
      ),
    };
    return loads.length > 0 ? { ...stats, loadP95Ms: quantile(loads, 0.95) } : stats;
  }

  liveQueryWindow(model: string): EmbedQueryWindow {
    const walls = this.stateOf(model).samples.query.map((s) => s.wallMs);
    if (walls.length === 0) {
      return { n: 0 };
    }
    const mean = walls.reduce((a, b) => a + b, 0) / walls.length;
    return {
      n: walls.length,
      meanMs: mean,
      p50Ms: quantile(walls, 0.5),
      p95Ms: quantile(walls, 0.95),
    };
  }

  // ----- admission -------------------------------------------------------------------------------

  /**
   * The asking consumer's admission, with its own model and mode (FORK 2026-10-30, review finding
   * #6): no other consumer's wrapper changes the answer.
   */
  admit(
    kind: "index" | "query",
    source: MemorySource,
    model: string,
    mode: EmbedGovernMode,
  ): AdmitResult {
    if (this.endpointClass === "remote") {
      return OK;
    }
    const env = governorEnv();
    const now = env.now();
    const state = this.stateOf(model);
    this.rollWindows(now);
    if (this.breakerBlocks(now)) {
      this.hinder(source, state);
      return { ok: false, reason: "breaker-open" };
    }
    if (kind === "index" && !this.backgroundAllowed(env, now, model)) {
      this.hinder(source, state);
      return { ok: false, reason: "busy" };
    }
    if (mode === "fit") {
      const view = this.view(model);
      if (!view.decision) {
        return { ok: false, reason: "off" };
      }
      if (source === "sessions" && view.decision.mode !== "memory+sessions") {
        return { ok: false, reason: "sessions-not-decided" };
      }
      if (kind === "index") {
        const dormant = this.isDormant(state, view, now);
        this.setDormant(state, dormant, view, now);
        if (dormant) {
          this.hinder(source, state);
          return { ok: false, reason: "dormant" };
        }
      }
    }
    if (kind === "index" && this.isSteppedDown(source)) {
      return { ok: false, reason: "stepped-down" };
    }
    if (kind === "index") {
      state.sources[source].seen = true;
      if (mode === "fit") {
        const armed = normalizeEmbeddingModelName(state.model);
        if (state.armedModel !== armed) {
          state.armedModel = armed;
          persistSoon(true);
        }
      }
    }
    return OK;
  }

  /**
   * Dormant while real demand is below the record's Q* at the live contention, and the backlog takes
   * longer than one fit. Q* is linear in c (demandBreakEvenPerDay), so re-evaluating the record's Q*
   * at the live c is Q*_fit x c_live / c_fit. The backlog is the pending word-only tokens / theta;
   * until the index has been admitted once under this model, the whole corpus is still pending, and
   * the fit's own backlog verdict (decision.dormantUntilDemand) stands in for it.
   */
  private isDormant(state: ModelState, view: RecordView, now: number): boolean {
    const decision = view.decision;
    const budget = view.budget;
    if (!decision || !budget) {
      return false;
    }
    if (this.demandPerDay(now) >= this.liveDemandBreakEven(view)) {
      return false;
    }
    const pendingSec =
      budget.tokensPerSec > 0
        ? this.pendingTokens(state) / budget.tokensPerSec
        : Number.POSITIVE_INFINITY;
    if (pendingSec > budget.fitWallSeconds) {
      return true;
    }
    return (
      decision.dormantUntilDemand === true &&
      state.armedModel !== normalizeEmbeddingModelName(state.model)
    );
  }

  private liveDemandBreakEven(view: RecordView): number {
    const q = view.decision?.demandBreakEvenPerDay;
    if (!(typeof q === "number" && Number.isFinite(q) && q >= 0)) {
      return Number.POSITIVE_INFINITY;
    }
    const recorded = view.record?.contention?.value;
    const cFit =
      typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0 ? recorded : 1;
    const cLive = this.contentionMeasured();
    if (cLive === undefined || cFit === 0) {
      return q;
    }
    return (q * cLive) / cFit;
  }

  private setDormant(state: ModelState, dormant: boolean, view: RecordView, now: number): void {
    if (dormant === state.dormant) {
      return;
    }
    state.dormant = dormant;
    const demand = this.demandPerDay(now);
    const qStar = this.liveDemandBreakEven(view);
    const pending = this.pendingTokens(state);
    governorEnv().log.info(
      dormant
        ? `embedder dormant (${this.endpointKey}): the index writes words only until real searches reach ${fmt(qStar)}/day (now ${fmt(demand)}/day)`
        : `embedder armed (${this.endpointKey}): background embedding runs (demand ${fmt(demand)}/day, break-even ${fmt(qStar)}/day, ${fmt(pending)} tokens pending)`,
    );
    this.recordOutcome(
      dormant ? "dormant" : "armed",
      { demandPerDay: demand, demandBreakEvenPerDay: qStar, pendingTokens: pending },
      {
        demandPerDay: "local-measured",
        demandBreakEvenPerDay: "estimated",
        pendingTokens: "estimated",
      },
      {},
      state.model,
    );
    persistSoon(true);
  }

  private isSteppedDown(source: MemorySource): boolean {
    return this.stepDownLevel >= 2 || (this.stepDownLevel >= 1 && source === "sessions");
  }

  private backgroundAllowed(env: EmbedGovernorEnv, now: number, model: string): boolean {
    if (this.endpointClass === "remote") {
      return true;
    }
    const lockAge = env.fitLockAgeMs();
    if (lockAge !== undefined && lockAge < FIT_LOCK_FRESH_MS) {
      return false;
    }
    const load1 = env.loadavg()[0] ?? 0;
    return idleGateOpen({
      load1,
      logicalCores: env.logicalCores(),
      embedCores: this.view(model).budget?.embedCores ?? Number.NaN,
      ownDuty: this.ownDuty(now),
    });
  }

  /** Share of the last minute with at least one request of this endpoint in flight. */
  private ownDuty(now: number): number {
    const from = now - DUTY_WINDOW_MS;
    this.pruneBusyIntervals(now);
    let busy = 0;
    for (const [start, end] of this.busyIntervals) {
      busy += end - Math.max(start, from);
    }
    if (this.busySince !== undefined) {
      busy += now - Math.max(this.busySince, from);
    }
    return Math.min(1, Math.max(0, busy / DUTY_WINDOW_MS));
  }

  /**
   * FORK 2026-10-30: drop the busy intervals that ended before the duty window; ownDuty never reads
   * them again. release() prunes too, so a local endpoint that only serves foreground calls, and so
   * never asks for its duty, cannot grow the history without bound.
   */
  private pruneBusyIntervals(now: number): void {
    const from = now - DUTY_WINDOW_MS;
    this.busyIntervals = this.busyIntervals.filter(([, end]) => end > from);
  }

  // ----- demand, keep-up, trials -----------------------------------------------------------------

  noteQuery(caller: EmbedQueryCaller, scanMs?: number): void {
    const day = this.today(governorEnv().now());
    const key: EmbedQueryCaller = CALLERS.has(caller) ? caller : "internal";
    day[key] += 1;
    if (typeof scanMs === "number" && Number.isFinite(scanMs) && scanMs >= 0) {
      day.scanMsSum += scanMs;
      day.scanN += 1;
    }
    persistSoon(false);
  }

  /** Real searches per day over the trailing 7 days (agent and rpc only), over the days observed. */
  private demandPerDay(now: number): number {
    const today = dayOf(now);
    let total = 0;
    for (const d of this.days) {
      if (d.day > today - DEMAND_DAYS) {
        total += d.agent + d.rpc;
      }
    }
    return total / Math.min(DEMAND_DAYS, Math.max(1, today - this.firstDay + 1));
  }

  /** Embedding calls per day over the same window: N in the breaker threshold. */
  private callsPerDay(now: number): number {
    const today = dayOf(now);
    let total = 0;
    for (const d of this.days) {
      if (d.day > today - DEMAND_DAYS) {
        total += d.calls;
      }
    }
    return total / Math.min(DEMAND_DAYS, Math.max(1, today - this.firstDay + 1));
  }

  notePending(model: string, source: MemorySource, tokens: number): void {
    if (!(typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)) {
      return;
    }
    const state = this.stateOf(model);
    this.rollWindows(governorEnv().now());
    const s = state.sources[source];
    s.pendingTokens += tokens;
    s.window.arrived += tokens;
    s.seen = true;
    persistSoon(false);
  }

  noteDrained(model: string, source: MemorySource, tokens: number): void {
    if (!(typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)) {
      return;
    }
    const state = this.stateOf(model);
    this.rollWindows(governorEnv().now());
    const s = state.sources[source];
    s.pendingTokens = Math.max(0, s.pendingTokens - tokens);
    s.window.drained += tokens;
    s.seen = true;
    persistSoon(false);
  }

  private pendingTokens(state: ModelState): number {
    return state.sources.memory.pendingTokens + state.sources.sessions.pendingTokens;
  }

  /**
   * Mark keep-up windows as no evidence: one model's, or, for an endpoint event (the breaker, the
   * idle gate), every live model's.
   */
  private hinder(source?: MemorySource, state?: ModelState): void {
    for (const each of state ? [state] : this.liveStates()) {
      for (const s of source ? [source] : SOURCES) {
        each.sources[s].window.hindered = true;
      }
    }
  }

  /**
   * Close every live model's 24 h keep-up windows that have ended. A window fell behind when it
   * was not hindered, memory arrived, and less drained than arrived. Two in a row step the index
   * down (#25): the step-down is the endpoint's, since every model on it shares its CPU.
   */
  private rollWindows(now: number): void {
    let behind: ModelState | undefined;
    for (const state of this.liveStates()) {
      for (const source of SOURCES) {
        const s = state.sources[source];
        if (now < s.window.start + DAY_MS) {
          continue;
        }
        const w = s.window;
        const idleGap = now - w.start >= 2 * DAY_MS;
        const fellBehind = !w.hindered && w.arrived > 0 && w.drained < w.arrived;
        s.shortStreak = fellBehind && !idleGap ? s.shortStreak + 1 : 0;
        s.closed = [...s.closed, w].slice(-STEP_DOWN_WINDOWS);
        s.window = {
          start: idleGap ? now : w.start + DAY_MS,
          arrived: 0,
          drained: 0,
          hindered: this.breaker.state !== "closed",
        };
        if (s.shortStreak >= STEP_DOWN_WINDOWS) {
          behind ??= state;
        }
      }
    }
    if (behind) {
      this.stepDown(behind, now);
    }
  }

  /**
   * Stop session embedding first, then memory embedding; each step re-measures (#25). The level
   * is the endpoint's; `state` is the model whose windows fell behind.
   */
  private stepDown(state: ModelState, now: number): void {
    const from = this.stepDownLevel;
    const to: 1 | 2 = from === 0 && state.sources.sessions.seen ? 1 : 2;
    for (const each of this.models.values()) {
      for (const source of SOURCES) {
        each.sources[source].shortStreak = 0;
      }
    }
    if (to <= from) {
      return;
    }
    this.stepDownLevel = to;
    let arrived = 0;
    let drained = 0;
    for (const source of SOURCES) {
      for (const w of state.sources[source].closed) {
        arrived += w.arrived;
        drained += w.drained;
      }
    }
    const what = to === 1 ? "session embedding" : "memory embedding";
    const advice =
      this.reportedMode === "fit"
        ? "the next fit decides again"
        : "the pinned provider is paused, not changed; openclaw embedder fit measures it and proposes what fits";
    const detail = `${what} stopped: in two consecutive days with the idle gate open and the breaker closed, the index drained ${fmt(drained)} of ${fmt(arrived)} arrived tokens`;
    governorEnv().log.warn(`embedder step-down (${this.endpointKey}): ${detail}; ${advice}`);
    this.recordOutcome(
      "stepped-down",
      { level: to, arrivedTokens: arrived, drainedTokens: drained },
      { level: "local-measured", arrivedTokens: "estimated", drainedTokens: "estimated" },
      {},
      state.model,
    );
    this.requestRemeasure(now, "step-down", detail, state.model);
    persistSoon(true);
  }

  noteTrial(
    model: string,
    consumer: EmbedConsumer,
    outcome: { invoked: boolean; recovered: number },
  ): void {
    const state = this.stateOf(model);
    const trial = (state.trials[consumer] ??= {
      invocations: 0,
      recoveries: 0,
      model: state.model,
    });
    if (outcome.invoked) {
      trial.invocations += 1;
    }
    if (typeof outcome.recovered === "number" && Number.isFinite(outcome.recovered)) {
      trial.recoveries += Math.max(0, Math.floor(outcome.recovered));
    }
    persistSoon(false);
  }

  /**
   * A per-turn lane's trial (#25): it retires after n = trialInvocations(t_miss, mean_q) invocations
   * with no recovery, and starts over when the catalog or the model changes.
   */
  trialState(
    model: string,
    consumer: EmbedConsumer,
    p: { missCostMs: number; meanQueryMs: number; catalogKey: string },
  ): EmbedTrialState {
    const state = this.stateOf(model);
    let trial = state.trials[consumer];
    if (trial && trial.catalogKey === undefined && trial.model === state.model) {
      // noteTrial ran first and recorded no catalog: this is the catalog it counted for.
      trial.catalogKey = p.catalogKey;
    }
    if (!trial || trial.catalogKey !== p.catalogKey || trial.model !== state.model) {
      const reset = trial !== undefined && (trial.invocations > 0 || trial.recoveries > 0);
      trial = { invocations: 0, recoveries: 0, catalogKey: p.catalogKey, model: state.model };
      state.trials[consumer] = trial;
      persistSoon(reset);
    }
    const n = trialInvocations({ missCostMs: p.missCostMs, meanQueryMs: p.meanQueryMs });
    return {
      retired: trial.invocations >= n && trial.recoveries === 0,
      n,
      invocations: trial.invocations,
      recoveries: trial.recoveries,
    };
  }

  // ----- contention ------------------------------------------------------------------------------

  notePressure(value: number): void {
    if (this.endpointClass === "remote" || !Number.isFinite(value)) {
      return;
    }
    if (this.backgroundInFlight > 0) {
      this.contention.duringSum += value;
      this.contention.duringN += 1;
    } else {
      this.contention.outsideSum += value;
      this.contention.outsideN += 1;
    }
  }

  hasBackgroundWork(): boolean {
    return this.backgroundInFlight > 0 || this.queues.background.length > 0;
  }

  /** c = max(0, mean pressure during background calls - mean outside) / 100, once both are sampled. */
  private contentionMeasured(): number | undefined {
    const c = this.contention;
    if (c.duringN < LIVE_MIN_CALLS || c.outsideN < LIVE_MIN_CALLS) {
      return undefined;
    }
    return Math.max(0, c.duringSum / c.duringN - c.outsideSum / c.outsideN) / 100;
  }

  // ----- the call path ---------------------------------------------------------------------------

  async run<T>(call: GovernedCall<T>): Promise<T> {
    const env = governorEnv();
    const now = env.now();
    const opts = call.opts ?? {};
    if (opts.signal?.aborted) {
      throw unavailable("aborted", "the caller's signal was already aborted");
    }
    this.today(now);
    const probe = this.enterBreaker(now);
    try {
      if (call.lane === "background" && !this.backgroundAllowed(env, now, call.model)) {
        this.today(now).refusedBusy += 1;
        this.hinder();
        throw unavailable(
          "busy",
          "background embedding waits for idle CPU (the idle gate is closed or a fit is measuring)",
        );
      }
      const expectedMs = this.expectedServiceMs(call);
      const budgetMs = opts.budgetMs;
      // FORK 2026-10-30: a budgeted foreground call also leaves the queue when its budget runs out.
      let queueBudget: { budgetMs: number; enqueuedAt: number } | undefined;
      if (call.lane === "foreground" && typeof budgetMs === "number" && Number.isFinite(budgetMs)) {
        const waitMs = this.expectedWaitMs(now);
        if (waitMs + expectedMs > budgetMs) {
          this.today(now).refusedOverBudget += 1;
          throw unavailable(
            "over-budget",
            `expected ${fmt(waitMs)} ms in queue plus ${fmt(expectedMs)} ms of service exceeds the ${fmt(budgetMs)} ms budget`,
          );
        }
        queueBudget = { budgetMs, enqueuedAt: now };
      }
      const slot = await this.acquire(call.lane, expectedMs, opts.signal, queueBudget);
      try {
        if (probe && call.split) {
          const first = await this.dispatch(call, call.split.first, now, true, slot);
          const rest = await this.dispatch(call, call.split.rest, now, false, slot);
          return call.split.join(first, rest);
        }
        return await this.dispatch(call, call, now, probe, slot);
      } finally {
        // FORK 2026-10-30: a given-up call that still runs keeps its slot (holdSlot).
        this.releaseWhenSettled(slot);
      }
    } finally {
      if (probe) {
        this.probeInFlight = false;
      }
    }
  }

  /** Expected service time from the measured theta and overhead; 0 when nothing is measured yet. */
  private expectedServiceMs(call: { kind: WindowKind; tokens: number; model: string }): number {
    const fit = this.view(call.model).budget;
    if (fit && fit.tokensPerSec > 0) {
      return fit.overheadMs + (call.tokens / fit.tokensPerSec) * 1000;
    }
    if (call.kind === "query") {
      const window = this.liveQueryWindow(call.model);
      if (window.n >= LIVE_MIN_CALLS && window.p50Ms !== undefined) {
        return window.p50Ms;
      }
    }
    const live = this.liveStats(call.model, call.kind);
    return live && live.thetaP50 > 0 ? (call.tokens / live.thetaP50) * 1000 : 0;
  }

  /** Time until a new foreground call would start: in-flight remainders plus queued foreground work. */
  private expectedWaitMs(now: number): number {
    const limit = this.concurrencyNow();
    if (this.slots.size < limit && this.queues.foreground.length === 0) {
      return 0;
    }
    let total = 0;
    for (const slot of this.slots) {
      total += Math.max(0, slot.startedAt + slot.expectedMs - now);
    }
    for (const waiter of this.queues.foreground) {
      total += waiter.expectedMs;
    }
    return total / limit;
  }

  private acquire(
    lane: Lane,
    expectedMs: number,
    signal: AbortSignal | undefined,
    budget?: { budgetMs: number; enqueuedAt: number },
  ): Promise<Slot> {
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = { lane, expectedMs, grant: resolve, fail: reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const queue = this.queues[lane];
          const at = queue.indexOf(waiter);
          if (at >= 0) {
            queue.splice(at, 1);
            detachWaiter(waiter);
            reject(unavailable("aborted", "the caller aborted while the call was queued"));
          }
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queues[lane].push(waiter);
      this.pump();
      if (budget && this.queues[lane].includes(waiter)) {
        // FORK 2026-10-30: a queued foreground call is refused when its budget runs out, not when
        // a slot frees, which can take a whole batch deadline. Expiry: the caller's budget minus
        // the time spent since the call arrived. Objective: the caller hears back within its
        // budget even while it waits. Break-even: past the budget, dispatch would refuse the call
        // anyway (no time is left to serve it), so waiting longer only delays the words-only
        // answer.
        const { budgetMs, enqueuedAt } = budget;
        const leftMs = Math.max(0, budgetMs - (governorEnv().now() - enqueuedAt));
        waiter.expiry = unrefTimer(
          setTimeout(() => {
            const queue = this.queues[lane];
            const at = queue.indexOf(waiter);
            if (at < 0) {
              return;
            }
            queue.splice(at, 1);
            detachWaiter(waiter);
            this.today(governorEnv().now()).refusedOverBudget += 1;
            reject(
              unavailable("over-budget", `the ${fmt(budgetMs)} ms budget ran out in the queue`),
            );
          }, leftMs),
        );
      }
    });
  }

  private pump(): void {
    const limit = this.concurrencyNow();
    while (this.slots.size < limit) {
      const waiter = this.queues.foreground.shift() ?? this.queues.background.shift();
      if (!waiter) {
        return;
      }
      detachWaiter(waiter);
      const now = governorEnv().now();
      const slot: Slot = { lane: waiter.lane, startedAt: now, expectedMs: waiter.expectedMs };
      if (this.slots.size === 0) {
        this.busySince = now;
      }
      this.slots.add(slot);
      if (slot.lane === "background") {
        this.backgroundInFlight += 1;
      }
      waiter.grant(slot);
    }
  }

  private release(slot: Slot): void {
    if (!this.slots.delete(slot)) {
      return;
    }
    const now = governorEnv().now();
    if (slot.lane === "background") {
      this.backgroundInFlight = Math.max(0, this.backgroundInFlight - 1);
    }
    if (this.slots.size === 0 && this.busySince !== undefined) {
      // FORK 2026-10-30: only a machine-local endpoint's idle gate reads this history (ownDuty),
      // and only its last minute: a remote endpoint keeps none, a local one only that window.
      if (this.endpointClass !== "remote") {
        this.pruneBusyIntervals(now);
        this.busyIntervals.push([this.busySince, now]);
      }
      this.busySince = undefined;
    }
    this.lastSettledAt = now;
    this.pump();
  }

  /** Fail every queued call fast: the breaker just opened. */
  private failQueued(): void {
    for (const lane of ["foreground", "background"] as const) {
      const waiting = this.queues[lane].splice(0);
      for (const waiter of waiting) {
        detachWaiter(waiter);
        waiter.fail(
          unavailable("breaker-open", "the endpoint's breaker opened while the call waited"),
        );
      }
    }
  }

  /** FORK 2026-10-30: free the slot now, or once its given-up call lets go of it (holdSlot). */
  private releaseWhenSettled(slot: Slot): void {
    if (slot.hold) {
      void slot.hold.then(() => this.release(slot));
      return;
    }
    this.release(slot);
  }

  /**
   * FORK 2026-10-30: a call was given up (its deadline, or its caller's abort) while the provider
   * still runs, so its slot stays taken until the provider settles. Bound: at most `boundMs` more,
   * the request's own derived deadline (requestDeadlineMs, before a caller's budget shortens it).
   * Objective: never more requests in flight than the endpoint's concurrency, even from a provider
   * that ignores its abort signal. Derivation: that deadline is the longest a healthy request
   * takes, so a request still running a whole deadline after it was given up is not coming back.
   * Break-even: holding longer buys nothing a healthy endpoint needs, and a provider that never
   * settles would wedge the endpoint for every consumer.
   */
  private holdSlot(slot: Slot, running: Promise<unknown>, boundMs: number): void {
    slot.hold = new Promise<void>((resolve) => {
      const timer = unrefTimer(
        setTimeout(() => {
          this.noteAbandoned(boundMs);
          resolve();
        }, boundMs),
      );
      const settled = (): void => {
        clearTimeout(timer);
        resolve();
      };
      void running.then(settled, settled);
    });
  }

  /** FORK 2026-10-30: the hold bound passed. Counted every time, logged once per endpoint a day. */
  private noteAbandoned(boundMs: number): void {
    const day = this.today(governorEnv().now());
    day.abandoned += 1;
    if (day.abandoned === 1) {
      governorEnv().log.warn(
        `embedder slot abandoned (${this.endpointKey}): a call given up ${fmt(boundMs / 1000)} s ago never settled, so its slot was freed while the provider may still run; later ones today are only counted (abandoned)`,
      );
    }
    persistSoon(false);
  }

  /**
   * One request to the provider: an AbortController linked to the caller's signal, a deadline from
   * requestDeadlineMs (with the cold-load term when the model has likely been unloaded), and a race,
   * so a provider that ignores the signal is still abandoned at the deadline. The caller hears back
   * then; the slot stays taken until the provider settles, at most one more deadline (holdSlot).
   */
  private async dispatch<T>(
    call: GovernedCall<T>,
    part: PartialCall<T>,
    enqueuedAt: number,
    probe: boolean,
    slot: Slot,
  ): Promise<T> {
    const env = governorEnv();
    const now = env.now();
    const opts = call.opts ?? {};
    if (opts.signal?.aborted) {
      throw unavailable("aborted", "the caller aborted before the call was sent");
    }
    if (!probe && this.hasBreaker() && this.breaker.state !== "closed") {
      this.today(now).refusedBreaker += 1;
      throw unavailable("breaker-open", "the endpoint's breaker is open");
    }
    if (call.lane === "background" && !this.backgroundAllowed(env, now, call.model)) {
      this.today(now).refusedBusy += 1;
      this.hinder();
      throw unavailable("busy", "the idle gate closed while the call waited");
    }
    const view = this.view(call.model);
    let deadlineMs = this.deadlineFor(call, part, view, now);
    // FORK 2026-10-30: the hold bound of a given-up request (holdSlot) is this derived deadline,
    // taken before the caller's budget shortens it: how long a healthy endpoint may need, not how
    // long this caller can wait.
    const holdMs = deadlineMs;
    const budgetMs = opts.budgetMs;
    if (call.lane === "foreground" && typeof budgetMs === "number" && Number.isFinite(budgetMs)) {
      const remaining = budgetMs - (now - enqueuedAt);
      if (remaining <= 0) {
        this.today(now).refusedOverBudget += 1;
        throw unavailable("over-budget", `the ${fmt(budgetMs)} ms budget ran out in the queue`);
      }
      deadlineMs = Math.min(deadlineMs, remaining);
    }
    const keepAlive = this.keepAliveFor(view);
    this.residentMs = keepAlive ? keepAlive.ms : OLLAMA_DEFAULT_KEEP_ALIVE_MS;
    this.dispatchTimes = [...this.dispatchTimes, now].slice(-LIVE_WINDOW_CALLS);
    const numThread = view.budget?.numThread;
    const controller = new AbortController();
    let measurement: EmbedMeasurement | undefined;
    const providerOpts: EmbedCallOptions = {
      signal: controller.signal,
      ...(call.opts?.priority ? { priority: call.opts.priority } : {}),
      ...(keepAlive ? { keepAlive: keepAlive.text } : {}),
      ...(numThread !== undefined ? { numThread } : {}),
      onMeasure: (m) => {
        measurement = m;
        opts.onMeasure?.(m);
      },
    };
    // FORK 2026-10-30: one text per reason, whichever promise wins the race below.
    const deadlineText = `no answer within the ${fmt(deadlineMs)} ms deadline (${fmt(part.tokens)} tokens)`;
    const abortedText = "the caller aborted the call";
    let expired = false;
    let callerAborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCallerAbort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      timer = unrefTimer(
        setTimeout(() => {
          expired = true;
          controller.abort();
          reject(unavailable("deadline", deadlineText));
        }, deadlineMs),
      );
      if (opts.signal) {
        onCallerAbort = () => {
          callerAborted = true;
          controller.abort();
          reject(unavailable("aborted", abortedText));
        };
        opts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    });
    const day = this.today(now);
    day.calls += 1;
    let running: Promise<T> | undefined;
    try {
      running = part.run(providerOpts);
      const result = await Promise.race([running, stop]);
      this.noteSuccess(call, part, measurement, env.now() - now);
      return result;
    } catch (caught) {
      // FORK 2026-10-30: the deadline or the caller's abort names the reason, whichever promise won
      // the race: an abort-aware provider can reject inside its abort listener, before the
      // governor's own rejection. The provider's raw error is kept as the cause.
      const err =
        (expired || callerAborted) && !(caught instanceof EmbedderUnavailableError)
          ? unavailable(
              expired ? "deadline" : "aborted",
              expired ? deadlineText : abortedText,
              caught,
            )
          : caught;
      if (expired) {
        this.today(env.now()).deadlines += 1;
      } else if (callerAborted) {
        // FORK 2026-10-30: the caller gave up, not the endpoint. No failure and no answer: the
        // failure streak, the breaker and its cool-down stay as they were, and a cancelled probe
        // leaves the breaker half-open, so the next call probes (run() gives up the probe).
        this.today(env.now()).aborted += 1;
        throw err;
      }
      if (expired || isEndpointFailure(err)) {
        this.today(env.now()).failures += 1;
        this.noteFailure(env.now(), expired ? "deadline" : errorText(err));
        if (probe) {
          throw unavailable(
            "breaker-open",
            "the half-open probe failed, so the breaker opened again",
            err,
          );
        }
      } else {
        this.noteAnswered();
      }
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (opts.signal && onCallerAbort) {
        opts.signal.removeEventListener("abort", onCallerAbort);
      }
      if ((expired || callerAborted) && running) {
        // FORK 2026-10-30: given up, but the provider may still be running: the slot stays taken
        // until it settles, at most one more deadline (holdSlot).
        this.holdSlot(slot, running, holdMs);
      }
    }
  }

  private deadlineFor<T>(
    call: GovernedCall<T>,
    part: PartialCall<T>,
    view: RecordView,
    now: number,
  ): number {
    const fit = view.budget;
    const live =
      this.liveStats(call.model, call.kind) ??
      (call.kind === "query" ? this.liveStats(call.model, "index") : undefined);
    const cold = this.lastSettledAt === undefined || now - this.lastSettledAt > this.residentMs;
    const coldLoadMs = cold ? (fit?.coldLoadMs ?? live?.loadP95Ms) : undefined;
    const ceilingMs =
      call.lane === "foreground"
        ? EMBED_CEILINGS.queryDeadlineMs
        : this.endpointClass === "remote" && !fit && !live
          ? EMBED_CEILINGS.remotePriorBatchDeadlineMs
          : EMBED_CEILINGS.batchDeadlineMs;
    return requestDeadlineMs({
      tokens: part.tokens,
      tokensPerSecLow: fit?.tokensPerSecLow ?? live?.thetaLow ?? Number.NaN,
      dispersion: fit?.dispersion ?? live?.dispersion,
      overheadMs: fit?.overheadMs,
      coldLoadMs,
      ceilingMs,
    });
  }

  private noteSuccess<T>(
    call: GovernedCall<T>,
    part: PartialCall<T>,
    m: EmbedMeasurement | undefined,
    wallMs: number,
  ): void {
    const now = governorEnv().now();
    const day = this.today(now);
    const tokens =
      m && typeof m.promptEvalCount === "number" && m.promptEvalCount >= 0
        ? m.promptEvalCount
        : part.tokens;
    if (call.lane === "foreground") {
      day.tokensForeground += tokens;
      day.wallMsForeground += wallMs;
    } else {
      day.tokensBackground += tokens;
      day.wallMsBackground += wallMs;
    }
    const total = m?.totalDurationNs;
    const load = m?.loadDurationNs;
    const serviceMs =
      typeof total === "number" && total >= 0
        ? (total - (typeof load === "number" && load >= 0 ? load : 0)) / 1e6
        : wallMs;
    const sample: Sample = { tokens, wallMs };
    if (serviceMs > 0 && tokens > 0) {
      sample.theta = tokens / (serviceMs / 1000);
    }
    if (typeof load === "number" && load > 0) {
      sample.loadMs = load / 1e6;
    }
    // FORK 2026-10-30: the sample lands in the calling model's own window (review finding #6).
    const state = this.stateOf(call.model);
    state.samples[call.kind] = [...state.samples[call.kind], sample].slice(-LIVE_WINDOW_CALLS);
    this.noteAnswered();
    if (this.breaker.state === "closed") {
      this.breaker.cleanCalls += 1;
    }
    if (call.kind === "index") {
      this.checkThetaDrift(now, call.model);
    }
    persistSoon(false);
  }

  // ----- the breaker -----------------------------------------------------------------------------

  private hasBreaker(): boolean {
    return this.endpointClass !== "remote";
  }

  private breakerBlocks(now: number): boolean {
    if (!this.hasBreaker()) {
      return false;
    }
    const b = this.breaker;
    if (b.state === "open") {
      return now < (b.openedAt ?? 0) + (b.cooldownMs ?? 0);
    }
    return b.state === "half-open" && this.probeInFlight;
  }

  /** Returns true when this call is the half-open probe; throws 'breaker-open' while open. */
  private enterBreaker(now: number): boolean {
    if (!this.hasBreaker() || this.breaker.state === "closed") {
      return false;
    }
    const b = this.breaker;
    if (b.state === "open") {
      if (now < (b.openedAt ?? 0) + (b.cooldownMs ?? 0)) {
        this.today(now).refusedBreaker += 1;
        throw unavailable("breaker-open", "the endpoint's breaker is open");
      }
      b.state = "half-open";
      governorEnv().log.info(
        `embedder breaker half-open (${this.endpointKey}): after a ${fmt((b.cooldownMs ?? 0) / 1000)} s cool-down, one single-input call probes the endpoint`,
      );
      this.recordOutcome(
        "breaker-half-open",
        { cooldownMs: b.cooldownMs ?? 0 },
        { cooldownMs: "local-measured" },
      );
      persistSoon(true);
    }
    if (this.probeInFlight) {
      this.today(now).refusedBreaker += 1;
      throw unavailable(
        "breaker-open",
        "the endpoint's breaker is half-open and its probe is running",
      );
    }
    this.probeInFlight = true;
    return true;
  }

  /** The endpoint answered (a vector, or an error it chose to send): the failure streak ends. */
  private noteAnswered(): void {
    const b = this.breaker;
    if (!this.hasBreaker()) {
      return;
    }
    if (b.state === "half-open") {
      b.state = "closed";
      b.consecutiveFailures = 0;
      b.consecutiveTrips = 0;
      b.openedAt = undefined;
      b.cooldownMs = undefined;
      governorEnv().log.info(`embedder breaker closed (${this.endpointKey}): the probe succeeded`);
      this.recordOutcome("breaker-closed", {}, {});
      persistSoon(true);
      return;
    }
    b.consecutiveFailures = 0;
  }

  /** F = breakerThreshold(p, N): p by the rule of three over clean calls (the fit's, else live). */
  private failureThreshold(now: number, view: RecordView): number {
    const fitClean = view.candidate?.tokensPerSec?.n;
    const clean =
      typeof fitClean === "number" && Number.isFinite(fitClean) && fitClean > 0
        ? fitClean
        : this.breaker.cleanCalls;
    return breakerThreshold({
      baselineFailureRate: Math.min(3 / clean, RULE_OF_THREE_CEILING),
      batchesPerDay: Math.max(1, this.callsPerDay(now)),
    });
  }

  private noteFailure(now: number, what: string): void {
    if (!this.hasBreaker()) {
      return;
    }
    const b = this.breaker;
    if (b.state === "open") {
      return;
    }
    if (b.state === "closed") {
      b.consecutiveFailures += 1;
      const threshold = this.failureThreshold(now, this.view(this.primary));
      if (b.consecutiveFailures < threshold) {
        return;
      }
    }
    const reopening = b.state === "half-open";
    b.state = "open";
    b.consecutiveTrips += 1;
    b.openedAt = now;
    b.cooldownMs = breakerCooldownMs({
      deadlineMs: this.budget("index", this.primary).batchDeadlineMs,
      consecutiveTrips: b.consecutiveTrips,
    });
    this.today(now).breakerTrips += 1;
    this.hinder();
    this.failQueued();
    governorEnv().log.warn(
      reopening
        ? `embedder breaker open (${this.endpointKey}): the probe failed (${what}); next probe in ${fmt(b.cooldownMs / 1000)} s`
        : `embedder breaker open (${this.endpointKey}): ${b.consecutiveFailures} consecutive failures (last: ${what}); calls fail fast for ${fmt(b.cooldownMs / 1000)} s, then one probe`,
    );
    this.recordOutcome(
      "breaker-open",
      {
        consecutiveFailures: b.consecutiveFailures,
        consecutiveTrips: b.consecutiveTrips,
        cooldownMs: b.cooldownMs,
      },
      {
        consecutiveFailures: "local-measured",
        consecutiveTrips: "local-measured",
        cooldownMs: "estimated",
      },
    );
    persistSoon(true);
  }

  // ----- re-measure ------------------------------------------------------------------------------

  /** Theta drift: the live p50 over at least 20 calls outside the record's 95% band asks for a fit. */
  private checkThetaDrift(now: number, model: string): void {
    const candidate = this.view(model).candidate;
    if (!candidate) {
      return;
    }
    const samples = this.stateOf(model).samples.index;
    const thetas = samples.map((s) => s.theta).filter((t): t is number => t !== undefined && t > 0);
    if (thetas.length < LIVE_MIN_CALLS) {
      return;
    }
    const p50 = quantile(thetas, 0.5);
    const low = candidate.tokensPerSecLow95;
    const high = candidate.tokensPerSecHigh95;
    if (p50 >= low && p50 <= high) {
      return;
    }
    this.requestRemeasure(
      now,
      "theta-drift",
      `live throughput ${fmt(p50)} tokens/s over ${thetas.length} calls is outside the fit's 95% band ${fmt(low)}-${fmt(high)}`,
      model,
    );
  }

  private requestRemeasure(
    now: number,
    reason: GovernorRemeasureRequest["reason"],
    detail: string,
    model: string,
  ): void {
    if (
      this.lastRemeasureAt !== undefined &&
      now - this.lastRemeasureAt < REMEASURE_MIN_INTERVAL_MS
    ) {
      return;
    }
    this.lastRemeasureAt = now;
    const store = governorStore();
    governorEnv().log.info(
      `embedder re-measure requested (${this.endpointKey}, ${reason}): ${detail}`,
    );
    this.recordOutcome("remeasure-requested", {}, {}, { reason }, model);
    persistSoon(true);
    const hook = store.remeasureHook;
    if (!hook) {
      return;
    }
    try {
      hook({
        endpointKey: this.endpointKey,
        providerId: this.providerId,
        model,
        reason,
        detail,
      });
    } catch (err) {
      governorEnv().log.warn(
        `embedder re-measure hook failed (${this.endpointKey}): ${errorText(err)}`,
      );
    }
  }

  // ----- days and the daily account --------------------------------------------------------------

  /** Today's bucket; closing a day writes its account to the algorithm ledger once. */
  private today(now: number): EmbedDayBucket {
    const day = dayOf(now);
    const last = this.days[this.days.length - 1];
    if (last && last.day >= day) {
      return last;
    }
    this.accountClosedDays(day);
    const bucket = emptyDay(day);
    this.days = [...this.days.filter((d) => d.day > day - DEMAND_DAYS), bucket];
    return bucket;
  }

  private accountClosedDays(today: number): void {
    for (const d of this.days) {
      if (d.day > this.accountedDay && d.day < today) {
        const { day, ...metrics } = d;
        const provenance: Record<string, MetricProvenance> = {};
        for (const key of Object.keys(metrics)) {
          provenance[key] = key.startsWith("tokens") ? "estimated" : "local-measured";
        }
        this.recordOutcome("daily", metrics, provenance, { day });
        this.accountedDay = d.day;
      }
    }
    this.accountedDay = Math.max(this.accountedDay, today - 1);
  }

  /** One ledger row, about `model`: the primary model for an endpoint event. */
  private recordOutcome(
    outcome: string,
    metrics: Record<string, number>,
    provenance: Record<string, MetricProvenance>,
    config: Record<string, string | number | boolean> = {},
    model = this.primary,
  ): void {
    recordAlgorithmOutcome({
      algorithm: "embedder",
      variant: `${this.providerId}/${model}`,
      outcome,
      metrics,
      provenance,
      provider: this.providerId,
      model,
      config: { endpointClass: this.endpointClass, mode: this.reportedMode, ...config },
    });
  }

  // ----- the model -------------------------------------------------------------------------------

  /** This model's own state, created on first use; `live` marks a model a consumer here uses. */
  private stateOf(model: string, live = true): ModelState {
    const key = normalizeEmbeddingModelName(model);
    let state = this.models.get(key);
    if (!state) {
      state = freshModel(model, governorEnv().now());
      this.models.set(key, state);
    }
    if (live) {
      state.live = true;
    }
    return state;
  }

  /** The models a consumer here uses: the ones whose windows roll and whose bounds count. */
  private liveStates(): ModelState[] {
    return [...this.models.values()].filter((s) => s.live);
  }

  /**
   * A consumer was built for this model (FORK 2026-10-30, review finding #6). It becomes the
   * primary model, and a consumer in mode fit makes the reported mode 'fit'. No other model's
   * state changes: the wrappers already built keep calling their own model, so their
   * measurements, backlog and trials stay theirs.
   */
  register(model: string, mode?: EmbedGovernMode): void {
    const key = normalizeEmbeddingModelName(model);
    const joining = this.models.get(key)?.live !== true;
    const others = this.liveStates()
      .map((s) => s.model)
      .filter((m) => normalizeEmbeddingModelName(m) !== key);
    this.stateOf(model);
    if (mode === "fit") {
      this.reportedMode = "fit";
    }
    if (model === this.primary) {
      return;
    }
    this.primary = model;
    if (joining && others.length > 0) {
      governorEnv().log.info(
        `embedder model added (${this.endpointKey}): ${model} shares the queue with ${others.join(", ")}; each model keeps its own measurements, backlog and trials`,
      );
    }
    persistSoon(false);
  }

  // ----- persistence -----------------------------------------------------------------------------

  snapshot(): EmbedGovernorSnapshot {
    const now = governorEnv().now();
    const primary = this.stateOf(this.primary);
    const own = modelSnapshotOf(primary);
    const view = this.view(this.primary);
    const contention = this.contentionMeasured();
    return {
      schemaVersion: SNAPSHOT_SCHEMA,
      endpointKey: this.endpointKey,
      providerId: this.providerId,
      model: this.primary,
      endpointClass: this.endpointClass,
      mode: this.reportedMode,
      savedAt: new Date(now).toISOString(),
      firstDay: this.firstDay,
      accountedDay: this.accountedDay,
      breaker: { ...this.breaker },
      days: this.days.map((d) => ({ ...d })),
      sources: own.sources,
      stepDown: {
        level: this.stepDownLevel,
        ...(this.stepDownRecordAt ? { recordAt: this.stepDownRecordAt } : {}),
      },
      ...(own.armedModel ? { armedModel: own.armedModel } : {}),
      dormant: own.dormant,
      trials: own.trials,
      models: Object.fromEntries(
        [...this.models].map(([key, state]) => [key, modelSnapshotOf(state)]),
      ),
      contention: { ...this.contention },
      ...(this.lastRemeasureAt !== undefined ? { lastRemeasureAt: this.lastRemeasureAt } : {}),
      derived: {
        failureThreshold: this.failureThreshold(now, view),
        demandPerDay: this.demandPerDay(now),
        ...(contention !== undefined ? { contention } : {}),
        pendingTokens: this.pendingTokens(primary),
      },
    };
  }

  flush(): Promise<void> {
    writeSnapshots(governorStore());
    return Promise.resolve();
  }

  private restore(saved: Partial<EmbedGovernorSnapshot>, now: number): void {
    const b = saved.breaker;
    if (b && (b.state === "closed" || b.state === "open" || b.state === "half-open")) {
      // A probe that was running when the process stopped never finished: probe again.
      this.breaker = {
        state: b.state === "half-open" ? "open" : b.state,
        consecutiveFailures: count(b.consecutiveFailures),
        consecutiveTrips: count(b.consecutiveTrips),
        cleanCalls: count(b.cleanCalls),
        ...(b.state !== "closed"
          ? { openedAt: num(b.openedAt) ?? now, cooldownMs: count(b.cooldownMs) }
          : {}),
      };
      if (b.state === "half-open") {
        this.breaker.cooldownMs = 0;
      }
    }
    if (Number.isInteger(saved.firstDay)) {
      this.firstDay = Math.min(this.firstDay, saved.firstDay as number);
    }
    if (Number.isInteger(saved.accountedDay)) {
      this.accountedDay = saved.accountedDay as number;
    }
    if (Array.isArray(saved.days)) {
      const today = dayOf(now);
      this.days = saved.days
        .filter((d): d is EmbedDayBucket => Boolean(d) && Number.isInteger(d.day))
        .map((d) => sanitizeDay(d))
        .filter((d) => d.day > today - DEMAND_DAYS && d.day <= today)
        .toSorted((x, y) => x.day - y.day);
    }
    const c = saved.contention;
    if (c) {
      this.contention = {
        duringSum: count(c.duringSum),
        duringN: count(c.duringN),
        outsideSum: count(c.outsideSum),
        outsideN: count(c.outsideN),
      };
    }
    this.lastRemeasureAt = num(saved.lastRemeasureAt);
    const level = saved.stepDown?.level;
    this.stepDownLevel = level === 1 || level === 2 ? level : 0;
    this.stepDownRecordAt =
      typeof saved.stepDown?.recordAt === "string" ? saved.stepDown.recordAt : undefined;
    // FORK 2026-10-30: each model's own state. A snapshot that lists its models restores every
    // one; an older one keeps one model's state at its top level, which restores into the model
    // it names, whichever model's consumer starts first.
    const entries: unknown[] =
      saved.models && typeof saved.models === "object" ? Object.values(saved.models) : [saved];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const m = entry as Partial<EmbedModelSnapshot>;
      if (typeof m.model === "string" && m.model.trim()) {
        this.restoreModel(m.model, m, now);
      }
    }
  }

  private restoreModel(model: string, saved: Partial<EmbedModelSnapshot>, now: number): void {
    const state = this.stateOf(model, false);
    for (const source of SOURCES) {
      const s = saved.sources?.[source];
      if (s) {
        state.sources[source] = sanitizeSource(s, now);
      }
    }
    state.armedModel = typeof saved.armedModel === "string" ? saved.armedModel : undefined;
    state.dormant = saved.dormant === true;
    if (saved.trials && typeof saved.trials === "object") {
      for (const [consumer, t] of Object.entries(saved.trials)) {
        if (t && typeof t === "object") {
          state.trials[consumer] = {
            invocations: count(t.invocations),
            recoveries: count(t.recoveries),
            ...(typeof t.catalogKey === "string" ? { catalogKey: t.catalogKey } : {}),
            ...(typeof t.model === "string" ? { model: t.model } : {}),
          };
        }
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Wrapping providers
// -------------------------------------------------------------------------------------------------

function obtainGovernor(spec: GovernedSpec): Governor {
  const store = governorStore();
  let governor = store.governors.get(spec.endpointKey);
  if (!governor) {
    const saved = loadDiskSnapshots(store).get(spec.endpointKey);
    governor = new Governor(spec, store.env.now(), saved);
    store.governors.set(spec.endpointKey, governor);
    ensurePressureSampler();
  }
  return governor;
}

function governedSpecOf(provider: unknown): GovernedSpec | undefined {
  if (!provider || typeof provider !== "object") {
    return undefined;
  }
  const spec = (provider as Record<PropertyKey, unknown>)[GOVERNED_SLOT];
  return spec && typeof spec === "object" ? (spec as GovernedSpec) : undefined;
}

function tokensOfTexts(texts: readonly string[]): number {
  let tokens = 0;
  for (const text of texts) {
    tokens += estimateTokensFromChars(text.length);
  }
  return tokens;
}

function tokensOfInputs(inputs: readonly EmbeddingInput[]): number {
  return tokensOfTexts(inputs.map((input) => input.text));
}

/**
 * Wrap a provider so every call goes through its endpoint's governor. Idempotent. The wrapper keeps
 * id, model and maxInputTokens, adds endpointKey, and wraps embedQuery, embedBatch and (when the
 * provider has it) embedBatchInputs. embedQuery is foreground; embedBatch is background for the
 * memory index and foreground for every other consumer, unless the call names its priority.
 */
export function governEmbeddingProvider(
  provider: EmbeddingProvider,
  options: { consumer: EmbedConsumer; baseUrl?: string; mode?: EmbedGovernMode },
): EmbeddingProvider & { readonly endpointKey: string } {
  if (governedSpecOf(provider)) {
    return provider as EmbeddingProvider & { readonly endpointKey: string };
  }
  const baseUrl = options.baseUrl?.trim() || undefined;
  const spec: GovernedSpec = {
    endpointKey: endpointKeyFor({ providerId: provider.id, baseUrl }),
    providerId: provider.id,
    model: provider.model,
    ...(baseUrl ? { baseUrl } : {}),
    mode: options.mode ?? "pin",
    consumer: options.consumer,
  };
  obtainGovernor(spec).register(spec.model, spec.mode);
  const batchLane: Lane = options.consumer === "memory-index" ? "background" : "foreground";
  const batchInputs = provider.embedBatchInputs;
  const governed: EmbeddingProvider & { readonly endpointKey: string } = {
    id: provider.id,
    model: provider.model,
    ...(provider.maxInputTokens !== undefined ? { maxInputTokens: provider.maxInputTokens } : {}),
    endpointKey: spec.endpointKey,
    embedQuery: (text, opts) =>
      obtainGovernor(spec).run({
        kind: "query",
        model: spec.model,
        lane: opts?.priority ?? "foreground",
        inputs: 1,
        tokens: tokensOfTexts([text]),
        opts,
        run: (o) => provider.embedQuery(text, o),
      }),
    embedBatch: (texts, opts) => {
      if (texts.length === 0) {
        return Promise.resolve([]);
      }
      return obtainGovernor(spec).run({
        kind: "index",
        model: spec.model,
        lane: opts?.priority ?? batchLane,
        inputs: texts.length,
        tokens: tokensOfTexts(texts),
        opts,
        run: (o) => provider.embedBatch(texts, o),
        ...(texts.length > 1
          ? {
              split: {
                first: {
                  inputs: 1,
                  tokens: tokensOfTexts(texts.slice(0, 1)),
                  run: (o: EmbedCallOptions) => provider.embedBatch(texts.slice(0, 1), o),
                },
                rest: {
                  inputs: texts.length - 1,
                  tokens: tokensOfTexts(texts.slice(1)),
                  run: (o: EmbedCallOptions) => provider.embedBatch(texts.slice(1), o),
                },
                join: (a: number[][], b: number[][]) => [...a, ...b],
              },
            }
          : {}),
      });
    },
    ...(batchInputs
      ? {
          embedBatchInputs: (inputs: EmbeddingInput[], opts?: EmbedCallOptions) => {
            if (inputs.length === 0) {
              return Promise.resolve([]);
            }
            return obtainGovernor(spec).run({
              kind: "index",
              model: spec.model,
              lane: opts?.priority ?? batchLane,
              inputs: inputs.length,
              tokens: tokensOfInputs(inputs),
              opts,
              run: (o) => batchInputs.call(provider, inputs, o),
              ...(inputs.length > 1
                ? {
                    split: {
                      first: {
                        inputs: 1,
                        tokens: tokensOfInputs(inputs.slice(0, 1)),
                        run: (o: EmbedCallOptions) =>
                          batchInputs.call(provider, inputs.slice(0, 1), o),
                      },
                      rest: {
                        inputs: inputs.length - 1,
                        tokens: tokensOfInputs(inputs.slice(1)),
                        run: (o: EmbedCallOptions) =>
                          batchInputs.call(provider, inputs.slice(1), o),
                      },
                      join: (a: number[][], b: number[][]) => [...a, ...b],
                    },
                  }
                : {}),
            });
          },
        }
      : {}),
  };
  Object.defineProperty(governed, GOVERNED_SLOT, { value: spec, enumerable: false });
  return governed;
}

/**
 * FORK 2026-10-30 (review finding #6): one consumer's governor. Its endpoint's queue, slot pool
 * and breaker are shared with every other consumer; the model, and the mode when the consumer has
 * one, are this consumer's own. It finds the endpoint's governor on every call (architecture.md),
 * so it holds no live state of its own.
 */
class GovernorView implements EmbedGovernor {
  private readonly spec: GovernedSpec;
  /** The consumer's own mode; undefined for a caller that holds no provider (getEmbedGovernor). */
  private readonly ownMode: EmbedGovernMode | undefined;

  constructor(spec: GovernedSpec, ownMode: EmbedGovernMode | undefined) {
    this.spec = spec;
    this.ownMode = ownMode;
  }

  private governor(): Governor {
    return obtainGovernor(this.spec);
  }

  get endpointKey(): string {
    return this.spec.endpointKey;
  }

  get providerId(): string {
    return this.spec.providerId;
  }

  get endpointClass(): EmbeddingEndpointClass {
    return this.governor().endpointClass;
  }

  get model(): string {
    return this.spec.model;
  }

  get mode(): EmbedGovernMode {
    return this.ownMode ?? this.governor().reportedMode;
  }

  budget(kind: "index" | "query"): EmbedBudget {
    return this.governor().budget(kind, this.spec.model);
  }

  admit(kind: "index" | "query", source: MemorySource = "memory"): AdmitResult {
    return this.governor().admit(kind, source, this.spec.model, this.mode);
  }

  noteQuery(caller: EmbedQueryCaller, scanMs?: number): void {
    this.governor().noteQuery(caller, scanMs);
  }

  notePending(source: MemorySource, tokens: number): void {
    this.governor().notePending(this.spec.model, source, tokens);
  }

  noteDrained(source: MemorySource, tokens: number): void {
    this.governor().noteDrained(this.spec.model, source, tokens);
  }

  noteTrial(consumer: EmbedConsumer, outcome: { invoked: boolean; recovered: number }): void {
    this.governor().noteTrial(this.spec.model, consumer, outcome);
  }

  trialState(
    consumer: EmbedConsumer,
    p: { missCostMs: number; meanQueryMs: number; catalogKey: string },
  ): EmbedTrialState {
    return this.governor().trialState(this.spec.model, consumer, p);
  }

  liveQueryWindow(): EmbedQueryWindow {
    return this.governor().liveQueryWindow(this.spec.model);
  }

  snapshot(): EmbedGovernorSnapshot {
    return this.governor().snapshot();
  }

  flush(): Promise<void> {
    return this.governor().flush();
  }
}

/**
 * The governor of a governed provider, or undefined for one that was built outside the governor:
 * its endpoint's governor, answering with that provider's own model and mode (FORK 2026-10-30).
 */
export function governorFor(
  provider: EmbeddingProvider | null | undefined,
): EmbedGovernor | undefined {
  const spec = governedSpecOf(provider);
  return spec ? new GovernorView(spec, spec.mode) : undefined;
}

/**
 * The governor of an endpoint, created when missing, for callers that hold no provider, seen with
 * the model they name. FORK 2026-10-30: holding no provider, they have no mode of their own, so
 * they report and admit with the endpoint's reported mode, as before; a wrapper's consumer answers
 * with its own mode through governorFor.
 */
export function getEmbedGovernor(p: {
  providerId: string;
  model: string;
  baseUrl?: string;
}): EmbedGovernor {
  const baseUrl = p.baseUrl?.trim() || undefined;
  const spec: GovernedSpec = {
    endpointKey: endpointKeyFor({ providerId: p.providerId, baseUrl }),
    providerId: p.providerId,
    model: p.model,
    ...(baseUrl ? { baseUrl } : {}),
    mode: "pin",
    consumer: "memory-index",
  };
  obtainGovernor(spec).register(p.model);
  return new GovernorView(spec, undefined);
}

/** Who spawns the background re-measure (the gateway's fit runtime). At most once per 24 h. */
export function setGovernorRemeasureHook(
  fn: ((request: GovernorRemeasureRequest) => void) | undefined,
): void {
  governorStore().remeasureHook = fn;
}

/**
 * Tests only: forget every governor, timer, hook and cached snapshot, and install `env` over the
 * default environment. A governor created afterwards reloads the snapshot file, like a restart.
 */
export function __resetEmbedGovernorsForTest(env: Partial<EmbedGovernorEnv> = {}): void {
  const store = governorStore();
  if (store.psiTimer) {
    clearTimeout(store.psiTimer);
  }
  if (store.writeTimer) {
    clearTimeout(store.writeTimer);
  }
  store.generation += 1;
  store.psiTimer = undefined;
  store.writeTimer = undefined;
  store.inWrite = false;
  store.lastWriteAt = Number.NEGATIVE_INFINITY;
  store.warnedWrite = false;
  store.governors = new Map();
  store.disk = undefined;
  store.remeasureHook = undefined;
  store.env = { ...defaultGovernorEnv(), ...env };
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

function unavailable(
  reason: EmbedderUnavailableReason,
  detail: string,
  cause?: unknown,
): EmbedderUnavailableError {
  return new EmbedderUnavailableError(
    reason,
    `embedding ${reason}: ${detail}`,
    cause === undefined ? undefined : { cause },
  );
}

/** FORK 2026-10-30: a waiter leaving the queue takes its abort listener and its expiry with it. */
function detachWaiter(waiter: Waiter): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
  if (waiter.expiry !== undefined) {
    clearTimeout(waiter.expiry);
    waiter.expiry = undefined;
  }
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);

/**
 * HTTP 5xx and network errors are the endpoint failing; any other error is the endpoint answering.
 * One predicate (#18): the memory index's word-only rule calls it too (manager-embedding-ops.ts).
 */
export function isEndpointFailure(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status !== undefined) {
    return status >= 500;
  }
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /\b(fetch failed|socket hang up)\b/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The HTTP status an error carries: a `status` field, else "HTTP 503" or "<prefix>: 503 " text. */
export function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 100 && status <= 599) {
    return status;
  }
  const message = errorText(err);
  const match = /\bHTTP (\d{3})\b/.exec(message) ?? /^[^:\n]*:\s(\d{3})\s/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  const t = timer as { unref?: unknown };
  if (typeof t.unref === "function") {
    (t.unref as () => void).call(timer);
  }
  return timer;
}

function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function emptyDay(day: number): EmbedDayBucket {
  return {
    day,
    agent: 0,
    rpc: 0,
    probe: 0,
    internal: 0,
    scanMsSum: 0,
    scanN: 0,
    calls: 0,
    failures: 0,
    deadlines: 0,
    aborted: 0,
    abandoned: 0,
    refusedBusy: 0,
    refusedOverBudget: 0,
    refusedBreaker: 0,
    breakerTrips: 0,
    tokensForeground: 0,
    tokensBackground: 0,
    wallMsForeground: 0,
    wallMsBackground: 0,
  };
}

function sanitizeDay(d: Partial<EmbedDayBucket> & { day: number }): EmbedDayBucket {
  const out = emptyDay(d.day);
  for (const key of Object.keys(out) as Array<keyof EmbedDayBucket>) {
    if (key !== "day") {
      out[key] = count(d[key]);
    }
  }
  return out;
}

function freshSource(now: number): EmbedSourceState {
  return {
    pendingTokens: 0,
    window: { start: now, arrived: 0, drained: 0, hindered: false },
    closed: [],
    shortStreak: 0,
    seen: false,
  };
}

function sanitizeWindow(w: unknown, now: number): EmbedKeepUpWindow {
  const x = (w ?? {}) as Partial<EmbedKeepUpWindow>;
  const start = num(x.start);
  return {
    start: start !== undefined && start <= now ? start : now,
    arrived: count(x.arrived),
    drained: count(x.drained),
    hindered: x.hindered === true,
  };
}

function sanitizeSource(s: Partial<EmbedSourceState>, now: number): EmbedSourceState {
  return {
    pendingTokens: count(s.pendingTokens),
    window: sanitizeWindow(s.window, now),
    closed: Array.isArray(s.closed)
      ? s.closed.slice(-STEP_DOWN_WINDOWS).map((w) => sanitizeWindow(w, now))
      : [],
    shortStreak: count(s.shortStreak),
    seen: s.seen === true,
  };
}

function cloneSource(s: EmbedSourceState): EmbedSourceState {
  return { ...s, window: { ...s.window }, closed: s.closed.map((w) => ({ ...w })) };
}

/** A model's state on first use: no samples, an empty backlog, not armed, no trials. */
function freshModel(model: string, now: number): ModelState {
  return {
    model,
    live: false,
    samples: { query: [], index: [] },
    sources: { memory: freshSource(now), sessions: freshSource(now) },
    armedModel: undefined,
    dormant: false,
    trials: {},
  };
}

/** A model's state as the snapshot keeps it, copied so later changes never reach a written one. */
function modelSnapshotOf(state: ModelState): EmbedModelSnapshot {
  return {
    model: state.model,
    sources: {
      memory: cloneSource(state.sources.memory),
      sessions: cloneSource(state.sources.sessions),
    },
    ...(state.armedModel ? { armedModel: state.armedModel } : {}),
    dormant: state.dormant,
    trials: Object.fromEntries(Object.entries(state.trials).map(([k, v]) => [k, { ...v }])),
  };
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function count(x: unknown): number {
  const n = num(x);
  return n !== undefined && n > 0 ? n : 0;
}

function gapsOf(times: readonly number[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push(Math.max(0, times[i] - times[i - 1]));
  }
  return gaps;
}

function median(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : quantile(values, 0.5);
}

/** Linear-interpolated quantile of a non-empty list. */
function quantile(values: readonly number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const at = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** JSON has no Infinity: a break-even that never pays is stored as the string "Infinity". */
function encodeNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return Number.isNaN(value) ? null : value > 0 ? "Infinity" : "-Infinity";
  }
  return value;
}

function decodeNonFinite(_key: string, value: unknown): unknown {
  if (value === "Infinity") {
    return Number.POSITIVE_INFINITY;
  }
  if (value === "-Infinity") {
    return Number.NEGATIVE_INFINITY;
  }
  return value;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmt(n: number): string {
  if (Number.isNaN(n)) {
    return "n/a";
  }
  if (!Number.isFinite(n)) {
    return n > 0 ? "inf" : "-inf";
  }
  const abs = Math.abs(n);
  if (abs >= 100) {
    return String(Math.round(n));
  }
  if (abs >= 1) {
    return String(Math.round(n * 10) / 10);
  }
  return String(Number(n.toPrecision(2)));
}
