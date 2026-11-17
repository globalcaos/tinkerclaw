// FORK 2026-10-29: the gateway-start check and the doctor note of the per-machine embedder fit
// (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
//
// scheduleEmbedderFitCheck runs at gateway start. It compares this machine (the cheap fingerprint)
// and the embedder-ladder models Ollama has installed with the record. A missing or outdated
// record starts `openclaw embedder fit --background` in a detached, nice'd child once the CPU is
// idle. setup.sh and doctor --fix run the same command, so the fit has one implementation and
// never measures on the gateway's thread. While no ladder model is reachable the check only
// re-probes, on a doubling backoff, and starts the fit the day one appears (#26). The governor's
// re-measure requests (a step-down, a throughput drift) start the same child under the same
// limits: one fit at a time, at most one a day while the machine and its models stay the same,
// and none once the last two fits made the same decision.
//
// noteEmbedderFit is doctor's view of that state: the decision with every verdict and its
// provenance, the fingerprint match and the governor's snapshot. With --fix it re-measures in the
// foreground, and it asks before a download or a remote provider only in a terminal.
//
// One owner per derivation (#18): the record, the fingerprint and inventory comparisons, the idle
// gate and the decision come from src/fork/embedder-fit.ts, the snapshot from
// src/fork/embedder-governor.ts, and the probe and the measuring from
// src/fork/embedder-fit-measure.ts, imported only when they run. This file schedules. Its own
// constants are clocks, each with its objective, source, break-even and what would move it.
//
// Test sandbox by construction (the governor's rule): under a test runner the default
// environment does no file IO unless OPENCLAW_STATE_DIR is set, makes no request, starts no
// process and reads an idle host, and doctor --fix runs no fit: the fit probes and measures the
// host's own embedder. Tests inject their own through the deps argument and runFit.

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveConfiguredLogFilePath } from "../logging/log-file-path.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import type { RunEmbedderFitOptions } from "./embedder-fit-measure.js";
import {
  cheapFingerprint,
  embedderFitPaths,
  fingerprintDiff,
  idleGateOpen,
  inventoryDiff,
  ladderEntryFor,
  readEmbedderFit,
  readRawMemorySearchProvider,
  type CheapFingerprint,
  type EmbedderFitRecord,
  type EmbedderInventory,
  type FitDecision,
} from "./embedder-fit.js";
import {
  readEmbedGovernorSnapshots,
  setGovernorRemeasureHook,
  type GovernorRemeasureRequest,
} from "./embedder-governor.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The re-probe backoff while no embedder-ladder model is reachable: the first after 10 min, then
 * doubling, at most one a day (#26). Objective: notice an embedder that appears after the gateway
 * started (Ollama started later, a model pulled by hand) at no steady polling cost. Source: the
 * design's re-measure trigger. Cost: 7 re-probes in the first 21 h, then about one a day, each two
 * local GETs of at most 1.5 s. Break-even: a shorter first delay only helps an embedder that
 * starts within minutes of the gateway, and the next gateway start finds that one anyway.
 * Changes if installs routinely start their embedder long after the gateway.
 */
const REPROBE_FIRST_MS = 10 * MINUTE_MS;
const REPROBE_MAX_MS = DAY_MS;

/**
 * At most one automatic background fit per 24 h while the fingerprint and the ladder models are
 * what they were at the last one: the design's stopping rule, a declared twin of the governor's
 * REMEASURE_MIN_INTERVAL_MS. Objective: a fit costs 2 to 3 min of the embedder's CPU share on the
 * reference host (estimate), so neither a gateway that restarts every hour nor a fit that keeps
 * failing may start one each time. Break-even: one fit per restart. Changes with the cost of one
 * fit.
 */
const FIT_MIN_INTERVAL_MS = DAY_MS;

/**
 * While a wanted fit waits for idle CPU, the idle gate is read once a minute. Objective: start
 * within a minute of the host going idle, for one loadavg read a minute. Source: load1 is a
 * one-minute average, so a faster poll reads nearly the same value; the fit polls every 15 s once
 * it runs. Changes if a fit ever has to start sooner after a busy spell; at one a day none has to.
 */
const IDLE_POLL_MS = MINUTE_MS;

/**
 * A fit lock younger than 10 min is a fit measuring now (doctor, the CLI, setup.sh, or the child
 * of an earlier gateway): a declared twin of the governor's FIT_LOCK_FRESH_MS, twice the fit's
 * 5-minute ceiling. The check looks again once such a lock would be stale.
 */
const FIT_LOCK_FRESH_MS = 10 * MINUTE_MS;

/**
 * The CLI's "try later" exit code (sysexits EX_TEMPFAIL: another fit held the lock, or the host
 * stayed busy): a declared twin of EXIT_TRY_LATER in src/cli/embedder-cli.ts.
 */
const EXIT_TRY_LATER = 75;

/** The background fit's output, appended in the gateway's own log dir. */
const FIT_LOG_FILE = "embedder-fit.log";

const NOTE_TITLE = "Embedder fit";
const STORE_SLOT = Symbol.for("openclaw.embedderFitRuntime.v1");

// -------------------------------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------------------------------

/**
 * The gateway's logger. A logger typed warn-only (startGatewaySidecars types its log that way)
 * sends the info lines to the memory/embedder subsystem instead.
 */
export type EmbedderFitRuntimeLog = {
  info?: (message: string) => void;
  warn: (message: string) => void;
};

/** What a probe of Ollama saw, in the shape the record's inventory keeps. */
export type OllamaProbe = EmbedderInventory["ollama"];

/** A started background fit: its pid, and its exit code (null: a signal, or it never started). */
export type SpawnedFit = {
  pid?: number;
  onExit: (listener: (code: number | null) => void) => void;
};

/** What the check reads from the machine and what it starts. Every field is injectable. */
export type EmbedderFitRuntimeDeps = {
  now: () => number;
  /** The record's state dir; null: no file IO at all; unset: the default (none in a test runner). */
  stateDir?: string | null;
  /** Ollama's installed models now, at the base URL memory search embeds against. */
  probe: (cfg: OpenClawConfig) => Promise<OllamaProbe>;
  /** Start `command args` detached at the lowest CPU priority, its output appended to logFile. */
  spawn: (p: { command: string; args: string[]; logFile: string; reason: string }) => SpawnedFit;
  /** os.loadavg(); load1 is the first entry. */
  loadavg: () => number[];
  logicalCores: () => number;
  /** Age of the fit's lock in ms, or undefined when there is none. */
  fitLockAgeMs: (stateDir: string) => number | undefined;
  /** The gateway's log dir. */
  logDir: (cfg: OpenClawConfig) => string;
  /** The gateway's own entry script, or undefined when it cannot be found. */
  entryScript: () => string | undefined;
};

export type EmbedderFitCheckHandle = {
  /** Cancel this check's timers and its re-measure hook. A newer check cancels them itself. */
  stop: () => void;
};

export type NoteEmbedderFitParams = {
  cfg: OpenClawConfig;
  /** doctor --fix: re-measure this machine in the foreground first. */
  repair: boolean;
  /** doctor --deep: each verdict's objective, rule and inputs with their values and sources. */
  deep: boolean;
  note: (message: string, title?: string) => void;
  /** May the fit ask before a download or for remote consent? Default: a terminal on both ends. */
  interactive?: boolean;
  /** Progress lines of a re-measure. Without it they go into the note. */
  log?: (line: string) => void;
  stateDir?: string;
  /**
   * The foreground fit of a repair. Default: runEmbedderFit (src/fork/embedder-fit-measure.ts),
   * and under a test runner none at all, so no doctor test measures the host's embedder.
   */
  runFit?: (opts: RunEmbedderFitOptions) => Promise<unknown>;
};

// -------------------------------------------------------------------------------------------------
// Internal shapes and the store
// -------------------------------------------------------------------------------------------------

type Trigger = "start" | "reprobe" | "retry";

type FitRequest = {
  /** Why the fit is wanted; kept in the spawn record for doctor. */
  reason: string;
  /** Ollama's models when it was wanted: half of what the one-a-day limit compares. */
  inventory: EmbedderInventory | undefined;
  /** A governor request: dropped, not retried, when the day's fit already ran. */
  remeasure: boolean;
};

/** The last background fit a gateway started, next to the record: the one-a-day limit's memory. */
type SpawnRecord = {
  schemaVersion: 1;
  at: number;
  startedAt: string;
  reason: string;
  logFile: string;
  fingerprint: CheapFingerprint;
  inventory?: EmbedderInventory;
};

type CheckContext = {
  generation: number;
  cfg: OpenClawConfig;
  stateDir: string;
  rawProvider: string;
  env: EmbedderFitRuntimeDeps;
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** Live state on one globalThis slot, so an in-process gateway restart finds the last check. */
type RuntimeStore = {
  generation: number;
  ctx?: CheckContext;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** A fit this process started that has not exited. A restart in the same process keeps it. */
  child?: { pid?: number; startedAt: number };
  /** A wanted fit waiting for the idle gate. */
  pending?: FitRequest;
  reprobeTimer?: ReturnType<typeof setTimeout>;
  reprobeAttempt: number;
  /** The newest probe, for a re-measure request that arrives between checks. */
  lastInventory?: EmbedderInventory;
};

function runtimeStore(): RuntimeStore {
  const slot = globalThis as Record<PropertyKey, unknown>;
  let store = slot[STORE_SLOT] as RuntimeStore | undefined;
  if (!store) {
    store = { generation: 0, timers: new Set(), reprobeAttempt: 0 };
    slot[STORE_SLOT] = store;
  }
  return store;
}

/** Forget the last check's timers and waits. A child it started keeps running and still counts. */
function resetStore(store: RuntimeStore): void {
  store.generation += 1;
  for (const timer of store.timers) {
    clearTimeout(timer);
  }
  store.timers.clear();
  store.ctx = undefined;
  store.pending = undefined;
  store.reprobeTimer = undefined;
  store.reprobeAttempt = 0;
}

function isCurrent(ctx: CheckContext): boolean {
  return runtimeStore().generation === ctx.generation;
}

/** One unref'd timer that runs only while its check is still the current one. */
function schedule(
  ctx: CheckContext,
  delayMs: number,
  run: () => void | Promise<void>,
): ReturnType<typeof setTimeout> {
  const store = runtimeStore();
  const timer = setTimeout(
    () => {
      store.timers.delete(timer);
      if (!isCurrent(ctx)) {
        return;
      }
      void Promise.resolve()
        .then(run)
        .catch((err: unknown) => {
          ctx.warn(`embedder fit check failed: ${errorText(err)}`);
        });
    },
    Math.max(0, delayMs),
  );
  unrefTimer(timer);
  store.timers.add(timer);
  return timer;
}

// -------------------------------------------------------------------------------------------------
// The gateway-start check
// -------------------------------------------------------------------------------------------------

/**
 * The gateway-start check (#26). One look at the record, this machine and Ollama's models, then
 * at most one background fit, the backoff re-probe while nothing here can embed, and the
 * governor's re-measure hook. Resolves after the first look; the rest runs on unref'd timers. A
 * second call (an in-process restart) cancels the first one's timers. Does nothing when memory
 * search is disabled or its provider is pinned to none.
 */
export async function scheduleEmbedderFitCheck(
  params: { cfg: OpenClawConfig; log: EmbedderFitRuntimeLog },
  deps: Partial<EmbedderFitRuntimeDeps> = {},
): Promise<EmbedderFitCheckHandle> {
  const store = runtimeStore();
  resetStore(store);
  const none: EmbedderFitCheckHandle = { stop: () => undefined };
  const env: EmbedderFitRuntimeDeps = { ...defaultDeps(), ...deps };
  const stateDir = ioStateDir(env);
  if (stateDir === null) {
    setGovernorRemeasureHook(undefined);
    return none;
  }
  const agentId = resolveDefaultAgentId(params.cfg);
  const rawProvider = readRawMemorySearchProvider(params.cfg, agentId);
  if (rawProvider === "none" || !memorySearchEnabled(params.cfg, agentId)) {
    // Word search by the owner's own config: there is nothing to fit.
    setGovernorRemeasureHook(undefined);
    return none;
  }
  const info = params.log.info;
  let subsystem: SubsystemLogger | undefined;
  const ctx: CheckContext = {
    generation: store.generation,
    cfg: params.cfg,
    stateDir,
    rawProvider,
    env,
    info: info
      ? (message) => info.call(params.log, message)
      : (message) => (subsystem ??= createSubsystemLogger("memory/embedder")).info(message),
    warn: (message) => params.log.warn(message),
  };
  store.ctx = ctx;
  setGovernorRemeasureHook((request) => {
    onRemeasureRequest(ctx, request);
  });
  await check(ctx, "start");
  return {
    stop: () => {
      if (isCurrent(ctx)) {
        resetStore(runtimeStore());
        setGovernorRemeasureHook(undefined);
      }
    },
  };
}

/** The backoff delay before re-probe number attempt + 1: 10 min, doubling, at most 24 h. */
export function reprobeDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(REPROBE_MAX_MS, REPROBE_FIRST_MS * 2 ** Math.min(n, 32));
}

/** Tests only: forget every timer, waiting fit and running child, and the re-measure hook. */
export function __resetEmbedderFitRuntimeForTest(): void {
  const store = runtimeStore();
  resetStore(store);
  store.child = undefined;
  store.lastInventory = undefined;
  setGovernorRemeasureHook(undefined);
}

async function check(ctx: CheckContext, trigger: Trigger): Promise<void> {
  if (!isCurrent(ctx)) {
    return;
  }
  let ollama: OllamaProbe;
  try {
    ollama = await ctx.env.probe(ctx.cfg);
  } catch (err) {
    ctx.warn(`memory search: the embedder probe failed (${errorText(err)})`);
    ollama = { baseUrl: "", reachable: false, models: [] };
  }
  if (!isCurrent(ctx)) {
    return;
  }
  const inventory: EmbedderInventory = { ollama, nodeLlamaCpp: false, remoteKeys: [] };
  runtimeStore().lastInventory = inventory;
  const record = readEmbedderFit(ctx.stateDir);
  const measurable = ladderModelsOf(ollama).length > 0 || Boolean(record?.consent?.remote);
  const auto = ctx.rawProvider === "auto";
  if (!record) {
    const lead = "not measured on this machine yet";
    if (!measurable) {
      nothingToMeasure(ctx, trigger, ollama, lead);
      return;
    }
    const what = auto ? `${lead}, so word index only` : lead;
    wantFit(ctx, trigger, { reason: lead, inventory, remeasure: false }, what);
    return;
  }
  const machine = fingerprintDiff(record.fingerprint, cheapFingerprint());
  const models = inventoryDiff(record.inventory, inventory);
  if (machine.length === 0 && models.length === 0) {
    const line = trigger === "start" ? unchangedLine(ctx, record) : undefined;
    if (line) {
      ctx.info(line);
    }
    if (record.decision.mode === "off" && !measurable) {
      scheduleReprobe(ctx);
    }
    return;
  }
  if (!measurable && record.decision.mode === "off") {
    // The fit would decide off again, and the record already says off: only watch for an embedder.
    const lead =
      machine.length > 0
        ? "the record was measured on another machine"
        : "the embedder-ladder models are gone";
    nothingToMeasure(ctx, trigger, ollama, lead);
    return;
  }
  const what: string[] = [];
  const why: string[] = [];
  if (machine.length > 0) {
    const words = auto ? ", so word index only until it is measured again" : "";
    what.push(`this machine changed since the last fit (${machine.join(", ")})${words}`);
    why.push(`machine changed: ${machine.join(", ")}`);
  }
  if (models.length > 0) {
    what.push(`the embedding models changed since the last fit (${models.join(", ")})`);
    why.push(`models changed: ${models.join(", ")}`);
  }
  wantFit(ctx, trigger, { reason: why.join("; "), inventory, remeasure: false }, what.join("; "));
}

/** The models Ollama has that the embedder ladder knows: the only ones a fit can measure. */
function ladderModelsOf(ollama: OllamaProbe): string[] {
  if (!ollama.reachable || !Array.isArray(ollama.models)) {
    return [];
  }
  return ollama.models
    .map((m) => (typeof m?.name === "string" ? m.name : ""))
    .filter((name) => ladderEntryFor(name) !== undefined);
}

/** Nothing here can embed: say so once at start (under 'auto'), then re-probe on the backoff. */
function nothingToMeasure(
  ctx: CheckContext,
  trigger: Trigger,
  ollama: OllamaProbe,
  lead: string,
): void {
  if (trigger === "start" && ctx.rawProvider === "auto") {
    const where = ollama.baseUrl || "its default address";
    ctx.info(
      ollama.reachable
        ? `memory search: word index only (${lead}; Ollama at ${where} has no model from the embedder ladder); turn on: openclaw embedder fit --pull`
        : `memory search: word index only (${lead}; Ollama at ${where} is not reachable); turn on: install Ollama, then openclaw embedder fit --pull`,
    );
  }
  scheduleReprobe(ctx);
}

/**
 * The #26b line for a record that still describes this machine: off and dormant say what runs and
 * how to turn vectors on; armed says nothing. A pin runs as configured, so it gets no line here.
 */
function unchangedLine(ctx: CheckContext, record: EmbedderFitRecord): string | undefined {
  if (ctx.rawProvider !== "auto") {
    return undefined;
  }
  const d = record.decision;
  if (d.mode === "off" || !d.model) {
    const reason = d.reasons[0] ?? "no embedding model fits this machine";
    return `memory search: word index only (${reason}); turn on: ${d.proposal?.command ?? "openclaw embedder fit --pull"}`;
  }
  if (!d.dormantUntilDemand) {
    return undefined;
  }
  if (d.demandBreakEvenPerDay === undefined) {
    return `memory search: word index only (${modelLabel(d)} is dormant: background embedding does not repay itself on this machine); turn on: not worth it here (openclaw embedder status)`;
  }
  return `memory search: word index only (${modelLabel(d)} is dormant until real searches reach ${fmt(d.demandBreakEvenPerDay)}/day); turn on: it arms itself at that demand (openclaw embedder status)`;
}

function wantFit(ctx: CheckContext, trigger: Trigger, request: FitRequest, what: string): void {
  stopReprobe();
  if (trigger !== "retry") {
    ctx.info(
      `memory search: ${what}; a background fit measures this machine once the CPU is idle (output: ${fitLogFile(ctx)})`,
    );
  }
  requestFit(ctx, request);
}

/** One fit at a time, at most one a day per fingerprint and model set, then wait for idle CPU. */
function requestFit(ctx: CheckContext, request: FitRequest): void {
  const store = runtimeStore();
  if (store.child) {
    return;
  }
  if (store.pending) {
    store.pending = request;
    return;
  }
  const until = nextFitAllowedAt(ctx, request);
  if (until !== undefined) {
    ctx.info(
      `memory search: a background fit already ran in the last 24 h on this machine with these models; the next one may start after ${new Date(until).toISOString()}`,
    );
    if (!request.remeasure) {
      schedule(ctx, until - ctx.env.now(), () => check(ctx, "retry"));
    }
    return;
  }
  store.pending = request;
  waitForIdleThenSpawn(ctx);
}

/** When the last fit started under this fingerprint and these ladder models, the next may start. */
function nextFitAllowedAt(ctx: CheckContext, request: FitRequest): number | undefined {
  const last = readSpawnRecord(ctx.stateDir);
  if (!last) {
    return undefined;
  }
  const until = last.at + FIT_MIN_INTERVAL_MS;
  if (ctx.env.now() >= until) {
    return undefined;
  }
  const sameMachine = fingerprintDiff(last.fingerprint, cheapFingerprint()).length === 0;
  const sameModels = inventoryDiff(last.inventory, request.inventory).length === 0;
  return sameMachine && sameModels ? until : undefined;
}

function waitForIdleThenSpawn(ctx: CheckContext): void {
  const store = runtimeStore();
  if (!isCurrent(ctx) || !store.pending) {
    return;
  }
  const lockAge = ctx.env.fitLockAgeMs(ctx.stateDir);
  if (lockAge !== undefined && lockAge < FIT_LOCK_FRESH_MS) {
    // Another fit is measuring now and its record answers this request: look again afterwards.
    store.pending = undefined;
    schedule(ctx, FIT_LOCK_FRESH_MS - lockAge, () => check(ctx, "retry"));
    return;
  }
  const open = idleGateOpen({
    load1: ctx.env.loadavg()[0] ?? 0,
    logicalCores: ctx.env.logicalCores(),
    // The fit keeps at least one core busy while it measures: an unmeasured s counts as one core.
    embedCores: Number.NaN,
    ownDuty: 0,
  });
  if (!open) {
    schedule(ctx, IDLE_POLL_MS, () => {
      waitForIdleThenSpawn(ctx);
    });
    return;
  }
  const request = store.pending;
  store.pending = undefined;
  spawnFit(ctx, request);
}

function spawnFit(ctx: CheckContext, request: FitRequest): void {
  const store = runtimeStore();
  const entry = ctx.env.entryScript();
  if (!entry) {
    ctx.warn(
      "memory search: the background fit cannot start because the gateway's entry script is unknown; measure by hand: openclaw embedder fit",
    );
    return;
  }
  const logFile = fitLogFile(ctx);
  const now = ctx.env.now();
  try {
    // Written before the child starts, so a fit that cannot start still counts toward the day's one.
    writeSpawnRecord(ctx.stateDir, {
      schemaVersion: 1,
      at: now,
      startedAt: new Date(now).toISOString(),
      reason: request.reason,
      logFile,
      fingerprint: cheapFingerprint(),
      ...(request.inventory ? { inventory: request.inventory } : {}),
    });
  } catch (err) {
    ctx.warn(
      `memory search: the background fit did not start: ${spawnRecordPath(ctx.stateDir)} cannot be written (${errorText(err)})`,
    );
    return;
  }
  let child: SpawnedFit;
  try {
    child = ctx.env.spawn({
      command: process.execPath,
      args: [...childNodeFlags(process.execArgv), entry, "embedder", "fit", "--background"],
      logFile,
      reason: request.reason,
    });
  } catch (err) {
    ctx.warn(
      `memory search: the background fit did not start (${errorText(err)}); measure by hand: openclaw embedder fit`,
    );
    return;
  }
  store.child = { ...(child.pid !== undefined ? { pid: child.pid } : {}), startedAt: now };
  child.onExit((code) => {
    onFitExit(code, logFile, now);
  });
}

/** One line per finished fit; a fit that changed nothing is tried again after its day. */
function onFitExit(code: number | null, logFile: string, startedAt: number): void {
  const store = runtimeStore();
  store.child = undefined;
  const ctx = store.ctx;
  if (!ctx) {
    return;
  }
  if (code === 0) {
    const record = readEmbedderFit(ctx.stateDir);
    ctx.info(
      `memory search: the background fit finished: ${record ? describeDecision(record.decision) : "it wrote no record"}`,
    );
    // The new record may be off for lack of an endpoint: the next look starts the re-probe.
    schedule(ctx, 0, () => check(ctx, "retry"));
    return;
  }
  const retryAt = startedAt + FIT_MIN_INTERVAL_MS;
  const next = new Date(retryAt).toISOString();
  if (code === EXIT_TRY_LATER) {
    ctx.info(
      `memory search: the background fit found the host busy or another fit measuring, so nothing changed; it tries again after ${next} (output: ${logFile})`,
    );
  } else {
    const how = code === null ? "was stopped or did not start" : `exited with code ${code}`;
    ctx.warn(
      `memory search: the background fit ${how}; word search answers meanwhile, and it tries again after ${next} (output: ${logFile})`,
    );
  }
  schedule(ctx, retryAt - ctx.env.now(), () => check(ctx, "retry"));
}

/** The governor's re-measure request: the same background fit under the same limits. */
function onRemeasureRequest(ctx: CheckContext, request: GovernorRemeasureRequest): void {
  if (!isCurrent(ctx)) {
    return;
  }
  const record = readEmbedderFit(ctx.stateDir);
  const repeated = record ? repeatedDecision(record) : undefined;
  if (record && repeated && fingerprintDiff(record.fingerprint, cheapFingerprint()).length === 0) {
    ctx.info(
      `memory search: no automatic re-measure for ${request.endpointKey} (${request.reason}): the last two fits both decided ${repeated}, so re-measures wait until this machine or its models change; re-measure by hand: openclaw doctor --fix`,
    );
    return;
  }
  requestFit(ctx, {
    reason: `re-measure requested by the governor (${request.reason}): ${request.detail}`,
    inventory: runtimeStore().lastInventory ?? record?.inventory,
    remeasure: true,
  });
}

/**
 * The decision both newest fits made, when they agree: the design's stopping rule (two fits in a
 * row with the same decision stop automatic re-measures until the fingerprint changes; a changed
 * fingerprint or model set starts a fit through the gateway-start check instead).
 */
function repeatedDecision(record: EmbedderFitRecord): string | undefined {
  const [before, last] = record.history.slice(-2);
  if (!before || !last) {
    return undefined;
  }
  if (before.mode !== last.mode || (before.model ?? "") !== (last.model ?? "")) {
    return undefined;
  }
  return last.model ? `${last.mode} with ${last.model}` : last.mode;
}

function scheduleReprobe(ctx: CheckContext): void {
  const store = runtimeStore();
  if (store.reprobeTimer) {
    return;
  }
  const delayMs = reprobeDelayMs(store.reprobeAttempt);
  store.reprobeAttempt += 1;
  store.reprobeTimer = schedule(ctx, delayMs, () => {
    store.reprobeTimer = undefined;
    return check(ctx, "reprobe");
  });
}

function stopReprobe(): void {
  const store = runtimeStore();
  if (store.reprobeTimer) {
    clearTimeout(store.reprobeTimer);
    store.timers.delete(store.reprobeTimer);
    store.reprobeTimer = undefined;
  }
  store.reprobeAttempt = 0;
}

function fitLogFile(ctx: CheckContext): string {
  let dir: string;
  try {
    dir = ctx.env.logDir(ctx.cfg);
  } catch {
    dir = path.join(ctx.stateDir, "logs");
  }
  return path.join(dir, FIT_LOG_FILE);
}

/**
 * The gateway's node flags without the inspector's, whose port the child would collide on. A bare
 * --inspect-port keeps its value as the next entry of execArgv, which is dropped with it.
 */
function childNodeFlags(execArgv: readonly string[]): string[] {
  const flags: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const flag = execArgv[i] ?? "";
    if (!/^--(?:inspect|debug)(?:-brk|-port|-wait)?(?:=|$)/.test(flag)) {
      flags.push(flag);
      continue;
    }
    const value = execArgv[i + 1];
    if (/^--(?:inspect|debug)-port$/.test(flag) && value !== undefined && !value.startsWith("-")) {
      i += 1;
    }
  }
  return flags;
}

// -------------------------------------------------------------------------------------------------
// The doctor note
// -------------------------------------------------------------------------------------------------

/**
 * Doctor's embedder note: the decision with every verdict (value against break-even, each input
 * with its provenance), the fingerprint match, the governor's snapshot (breaker, dormant or armed,
 * demand by caller, K, backlog, trials) and the proposal when there is one. It never changes
 * config. With repair it first re-measures in the foreground through runEmbedderFit, except while
 * an update runs or under a test runner that injected no runFit. Silent when memory search is
 * disabled: the memory-search note says so.
 */
export async function noteEmbedderFit(params: NoteEmbedderFitParams): Promise<void> {
  const stateDir = params.stateDir ?? defaultStateDir();
  if (stateDir === null) {
    return;
  }
  const agentId = resolveDefaultAgentId(params.cfg);
  if (!memorySearchEnabled(params.cfg, agentId)) {
    return;
  }
  if (readRawMemorySearchProvider(params.cfg, agentId) === "none") {
    params.note(
      "memorySearch.provider is none in config: memory search runs on the word index only, so this machine is not measured.",
      NOTE_TITLE,
    );
    return;
  }
  const lines: string[] = [];
  if (params.repair) {
    lines.push(...(await remeasureInForeground(params, stateDir)), "");
  }
  try {
    lines.push(...(await statusLines(stateDir, params.deep)));
  } catch (err) {
    lines.push(`memory search: the embedder record could not be read (${errorText(err)})`);
  }
  if (!params.repair) {
    lines.push("", "Re-measure this machine: openclaw doctor --fix (or openclaw embedder fit)");
  }
  params.note(lines.join("\n"), NOTE_TITLE);
}

async function remeasureInForeground(
  params: NoteEmbedderFitParams,
  stateDir: string,
): Promise<string[]> {
  if (isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS)) {
    return [
      "Not re-measured while an update runs: the gateway compares this machine with the record at its next start and measures it in the background when it changed.",
    ];
  }
  if (!params.runFit && isTestRunner()) {
    return [
      "Not re-measured: under a test runner the fit runs only when the test injects one, because it probes and measures this host's embedder.",
    ];
  }
  const kept: string[] = [];
  const log =
    params.log ??
    ((line: string) => {
      kept.push(`  ${line}`);
    });
  const interactive = params.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  try {
    const { EmbedderFitBusyError, FIT_CEILING_MS, runEmbedderFit } =
      await import("./embedder-fit-measure.js");
    const runFit = params.runFit ?? runEmbedderFit;
    log(
      `Measuring this machine for memory search: at most ${FIT_CEILING_MS / MINUTE_MS} minutes, downloads excluded, with built-in sample text only.`,
    );
    try {
      await runFit({
        cfg: params.cfg,
        interactive,
        allowPull: false,
        consentVia: "doctor",
        background: false,
        log: { info: log, warn: log },
        stateDir,
        command: "openclaw doctor --fix",
        ...(interactive ? {} : { deps: { confirm: async () => false } }),
      });
      return ["Re-measured this machine.", ...kept];
    } catch (err) {
      if (err instanceof EmbedderFitBusyError) {
        return [`Not re-measured: ${err.message}.`, ...kept];
      }
      throw err;
    }
  } catch (err) {
    return [
      `Not re-measured: the fit did not finish (${errorText(err)}); memory search keeps its previous decision. Retry: openclaw embedder fit`,
      ...kept,
    ];
  }
}

/** The status block of `openclaw embedder status`, plus the backlog, the verdicts and the spawn. */
async function statusLines(stateDir: string, deep: boolean): Promise<string[]> {
  const { formatEmbedderStatus, readEmbedderStatus } = await import("../cli/embedder-cli.js");
  const status = readEmbedderStatus({ stateDir });
  const lines = formatEmbedderStatus(status);
  const record = readEmbedderFit(stateDir);
  if (record) {
    const backlog = backlogLine(stateDir, status.endpointKey);
    if (backlog) {
      lines.push(backlog);
    }
    lines.push(...verdictLines(record.decision, deep));
  }
  const spawned = readSpawnRecord(stateDir);
  if (spawned) {
    lines.push(
      `  background fit: last started by the gateway at ${spawned.startedAt} (${spawned.reason}); output in ${spawned.logFile}`,
    );
  }
  return lines;
}

function backlogLine(stateDir: string, endpointKey: string | undefined): string | undefined {
  if (!endpointKey) {
    return undefined;
  }
  const snapshot = readEmbedGovernorSnapshots(stateDir)[endpointKey];
  if (!snapshot) {
    return undefined;
  }
  const memory = count(snapshot.sources?.memory?.pendingTokens);
  const sessions = count(snapshot.sources?.sessions?.pendingTokens);
  const level = snapshot.stepDown?.level ?? 0;
  const stepDown =
    level === 0
      ? "no step-down"
      : level === 1
        ? "step-down 1 (session embedding stopped)"
        : "step-down 2 (memory embedding stopped)";
  return `  backlog: ${fmt(memory + sessions)} tokens waiting for vectors (memory ${fmt(memory)}, sessions ${fmt(sessions)}); ${stepDown}`;
}

function verdictLines(decision: FitDecision, deep: boolean): string[] {
  const verdicts = Array.isArray(decision.verdicts) ? decision.verdicts : [];
  if (verdicts.length === 0) {
    return ["  verdicts: none (no model was measured)"];
  }
  const lines = ["  verdicts (value vs break-even; each input with its provenance):"];
  for (const v of verdicts) {
    const inputs = Object.entries(v.inputs ?? {});
    const provenance = inputs.map(([name, m]) => `${name} ${m.provenance}`).join(", ");
    const model = v.model ? ` ${v.model}` : "";
    const outcome = v.pass ? "pass" : "FAIL";
    const sources = provenance ? ` (${provenance})` : "";
    lines.push(
      `  - ${v.name}${model}: ${fmt(v.value)} vs break-even ${fmt(v.breakEven)}, ${outcome}${sources}`,
    );
    if (deep) {
      lines.push(`      objective: ${v.objective}`, `      rule: ${v.formula}`);
      for (const [name, m] of inputs) {
        const n = typeof m.n === "number" ? `, n ${m.n}` : "";
        lines.push(`      ${name} = ${fmt(m.value)} ${m.unit} (${m.provenance}${n}): ${m.source}`);
      }
    }
  }
  return lines;
}

// -------------------------------------------------------------------------------------------------
// State, defaults and helpers
// -------------------------------------------------------------------------------------------------

/** Next to the record ("single-flight lock next to the record" is the fit's own lock, beside it). */
function spawnRecordPath(stateDir: string): string {
  return path.join(path.dirname(embedderFitPaths(stateDir).record), "embedder-fit-spawn.json");
}

function readSpawnRecord(stateDir: string): SpawnRecord | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(spawnRecordPath(stateDir), "utf8"),
    ) as Partial<SpawnRecord> | null;
    if (
      parsed?.schemaVersion !== 1 ||
      typeof parsed.at !== "number" ||
      !Number.isFinite(parsed.at) ||
      !parsed.fingerprint ||
      typeof parsed.fingerprint !== "object"
    ) {
      return undefined;
    }
    return parsed as SpawnRecord;
  } catch {
    return undefined;
  }
}

/** tmp file + rename, mode 0600: a reader never sees half a record. */
function writeSpawnRecord(stateDir: string, record: SpawnRecord): void {
  const file = spawnRecordPath(stateDir);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.embedder-fit-spawn.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Declared twin of the fit core's and the governor's test-runner check. */
function isTestRunner(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/** The state dir, or null under a test runner that set none: then no file is read or written. */
function defaultStateDir(): string | null {
  if (isTestRunner() && !process.env.OPENCLAW_STATE_DIR?.trim()) {
    return null;
  }
  return resolveStateDir();
}

function ioStateDir(env: EmbedderFitRuntimeDeps): string | null {
  if (env.stateDir === null) {
    return null;
  }
  if (typeof env.stateDir === "string") {
    return env.stateDir;
  }
  return defaultStateDir();
}

function defaultDeps(): EmbedderFitRuntimeDeps {
  const testing = isTestRunner();
  return {
    now: () => Date.now(),
    probe: testing
      ? async (): Promise<OllamaProbe> => ({ baseUrl: "", reachable: false, models: [] })
      : probeOllama,
    spawn: testing
      ? (): SpawnedFit => {
          throw new Error("no background fit is started under a test runner");
        }
      : spawnDetachedFit,
    loadavg: () => (testing ? [0, 0, 0] : os.loadavg()),
    logicalCores: () => cheapFingerprint().logicalCores,
    fitLockAgeMs: (stateDir) => {
      try {
        return Math.max(0, Date.now() - fs.statSync(embedderFitPaths(stateDir).lock).mtimeMs);
      } catch {
        return undefined;
      }
    },
    logDir: (cfg) => path.dirname(resolveConfiguredLogFilePath(cfg)),
    entryScript: () => {
      const entry = process.argv[1];
      return entry && fs.existsSync(entry) ? path.resolve(entry) : undefined;
    },
  };
}

/**
 * The fit's own probe (src/fork/embedder-fit-measure.ts), so this check sees what the fit would
 * see. Keys and node-llama-cpp are skipped: the comparison reads only Ollama's models.
 */
async function probeOllama(cfg: OpenClawConfig): Promise<OllamaProbe> {
  const { probeMachine } = await import("./embedder-fit-measure.js");
  const probe = await probeMachine(cfg, {
    deps: { hasNodeLlamaCpp: async () => false, hasRemoteKey: async () => false },
  });
  return probe.inventory.ollama;
}

/** A detached child at nice 19 from its first instruction, its output appended to logFile. */
function spawnDetachedFit(p: {
  command: string;
  args: string[];
  logFile: string;
  reason: string;
}): SpawnedFit {
  const launch = lowPriorityCommand(p.command, p.args);
  fs.mkdirSync(path.dirname(p.logFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(p.logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    fs.writeSync(fd, `${new Date().toISOString()} embedder fit --background: ${p.reason}\n`);
    child = spawnProcess(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  let exit: { code: number | null } | undefined;
  const listeners: Array<(code: number | null) => void> = [];
  const settle = (code: number | null): void => {
    if (exit) {
      return;
    }
    exit = { code };
    for (const listener of listeners.splice(0)) {
      listener(code);
    }
  };
  // A child that cannot start emits 'error' instead of 'exit'; unheard, it would throw.
  child.once("error", () => settle(null));
  child.once("exit", (code) => settle(code));
  child.unref();
  if (!launch.niced && child.pid !== undefined) {
    try {
      os.setPriority(child.pid, 19);
    } catch {
      // not permitted here: the fit lowers its own priority as it starts
    }
  }
  return {
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    onExit: (listener) => {
      if (exit) {
        listener(exit.code);
      } else {
        listeners.push(listener);
      }
    },
  };
}

/**
 * The command under `nice -n 19`: nice sets the priority before exec, so every thread of the child
 * starts with it, while os.setPriority after the start reaches only the thread it names. Without
 * nice on PATH the command runs as is and spawnDetachedFit renices its pid. IO priority stays with
 * the fit, which asks ionice for itself in background mode.
 */
function lowPriorityCommand(
  command: string,
  args: string[],
): { command: string; args: string[]; niced: boolean } {
  const nice = process.platform === "win32" ? undefined : findOnPath("nice");
  return nice
    ? { command: nice, args: ["-n", "19", command, ...args], niced: true }
    : { command, args, niced: false };
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}

function memorySearchEnabled(cfg: OpenClawConfig, agentId: string): boolean {
  try {
    return resolveMemorySearchConfig(cfg, agentId) !== null;
  } catch {
    // An invalid memorySearch config: doctor's memory-search note reports it.
    return false;
  }
}

function modelLabel(d: FitDecision): string {
  const model = d.model ?? "";
  return d.provider && d.provider !== "ollama" ? `${d.provider}/${model}` : model;
}

function describeDecision(d: FitDecision): string {
  if (d.mode === "off" || !d.model) {
    return `word index only (${d.reasons[0] ?? "no embedding model fits this machine"})`;
  }
  const what =
    d.mode === "memory+sessions" ? "memory files and session transcripts" : "memory files";
  const state = d.dormantUntilDemand ? "dormant until real searches repay it" : "armed";
  return `${modelLabel(d)} for ${what}, ${state}`;
}

/** Declared twin of the governor's unrefTimer: a timer that never keeps the process alive. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  const t = timer as { unref?: unknown };
  if (typeof t.unref === "function") {
    (t.unref as () => void).call(timer);
  }
  return timer;
}

function count(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0;
}

/** Declared twin of fit-core's number format (as in src/cli/embedder-cli.ts). */
function fmt(n: number): string {
  if (typeof n !== "number" || Number.isNaN(n)) {
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
