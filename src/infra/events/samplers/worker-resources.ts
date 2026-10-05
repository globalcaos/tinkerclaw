/**
 * FORK 2026-09-25 — the per-worker resource trend series: TINKER_UI_DESIGN_BIBLE/logging.md §4.9
 * (§9 step 5, the owner's priority). The memory every worker uses, sampled so a trend shows over
 * days: a leak is a slope, a death is the last point before a `worker.exit` row.
 *
 * WHO IS SAMPLED, AND FROM WHERE (`worker.sample`, label = worker_type):
 *
 *   gateway        gateway-<pid>        source=process  RSS, the cpuUsage delta, maxRSS, the main
 *                                                       isolate's heap
 *   tinker_bridge  the systemd unit     source=cgroup   memory.current / memory.peak / cpu.stat /
 *                                                       pids.current of the UNIT (cgroup-reader.ts)
 *   fts_thread     fts-<pid>-<ms>-<n>   source=isolate  the worker's own v8 heap, over the `stats`
 *                                                       message (src/memory/engram/fts-worker.ts)
 *   events_writer  events-writer-       source=isolate  the writer thread's own v8 heap, over ITS
 *                  <pid>-<spawn>                        `stats` message (writer-worker.ts)
 *   whatsmeow      whatsmeow-<pid>      source=process  /proc/<pid> of the Go binary
 *
 * - A worker whose numbers cannot be read says `source=unavailable` and carries none: an honest
 *   gap, never a zero.
 * - The FTS thread shares the gateway's RSS; only its heap is its own, so its row carries the
 *   isolate's committed heap plus its external memory. Charting RSS under its name would count the
 *   gateway twice.
 * - whatsmeow's Go binary is spawned INSIDE the third-party @whatsmeow-node/whatsmeow-node package
 *   (its GoProcess: `spawn(binaryPath, [])`), reached from extensions/tinkerclaw-whatsapp/src/
 *   session-wm.ts createWmClient. It is a direct child of the gateway, but the package keeps the
 *   handle private, so the sampler finds it among this process's children by its binary name
 *   (`whatsmeow-node`, or the basename of OPENCLAW_WHATSMEOW_BINARY). No spawn or exit rows for it:
 *   the package owns that lifecycle.
 * - The events writer thread shares the gateway's RSS exactly as the FTS thread does, so its row
 *   carries its committed heap plus its external memory and NOT RSS. Its id changes on every
 *   respawn, because a respawned thread IS a new worker: fresh baseline, fresh peak, age from zero
 *   (emit.ts owns that id — only it sees the spawn). The probe rides the writer's existing `stats`
 *   request (readIsolateStats in writer-worker.ts): v8 reports the CALLING isolate, so this thread's
 *   memory can be read nowhere but inside it.
 *
 * CADENCE (L10: samples are unconditional). A tick every 30 s reads every worker — a few small file
 * reads and one probe message. A worker's row is WRITTEN when it moved since its last row (memory by
 * more than 1 %, or CPU above WORKER_IDLE_CPU_SHARE of one core) and otherwise every 300 s: the idle
 * cadence is a floor, never silence. Reads stay at 30 s so a worker that wakes shows on the next
 * tick, not up to five minutes later. The sampler has its own timer rather than riding the
 * diagnostic heartbeat, because the heartbeat runs only when diagnostics are enabled
 * (server.impl.ts), and a trend series that stops with a config flag breaks L10.
 *
 * LIFECYCLE. The tinker-bridge reports each child's spawn and exit through
 * `openclaw/plugin-sdk/fork-telemetry` (noteWorkerSpawn / noteWorkerExit below). The spawn
 * registers the unit and, WORKER_FIRST_SAMPLE_DELAY_MS later, resolves its cgroup and takes the
 * first reading — just after spawn, not at the next free-running tick, so a worker that lives less
 * than one tick still has a size. The exit row carries the last sampled memory and the peak, which
 * only this sampler holds: the unit's cgroup is gone by the time the bridge hears the exit. The
 * registry, and the emit it writes through, live on globalThis (the instrument-liveness precedent),
 * so a second copy of this module (an extension bundle, a dev loader) still reaches the one registry
 * the gateway's sampler reads.
 *
 * KNOWN GAP: a bridge worker still alive when the gateway stops gets NO exit row. The gateway stops
 * observing it, but it has not exited — it may yet be killed by the closed pipe or run on as an
 * orphan — and an exit row stamped at shutdown would be a fabricated fact. A survivor is written as
 * `worker.orphan` by the next gateway's first scan.
 *
 * ORPHANS. At start and hourly, live `tinkerclaw-worker-*` units whose owning gateway is gone are
 * written as `worker.orphan` (once each per gateway life), logged with the command that stops them,
 * and sampled until they disappear: a gateway restart orphans a mid-turn worker, which then runs
 * invisibly beside its re-dispatched twin.
 */

import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { classifyAbortCause } from "../../../fork/error-envelope.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  type FtsWorkerThreadStats,
  readFtsWorkerThreadStats,
} from "../../../memory/engram/fts-worker-client.js";
import {
  type EmitEventRecord,
  emitEvent,
  type EventWriterThreadStats,
  getEventWriterStats,
  readEventWriterThreadStats,
} from "../emit.js";
import {
  CGROUP_FS_ROOT,
  cgroupDirFor,
  listChildPids,
  listLiveWorkerUnits,
  type ParsedWorkerUnit,
  parseWorkerUnitName,
  PROC_FS_ROOT,
  PROC_USER_HZ,
  readCgroup,
  readProcessStartMs,
  readProcProcess,
  readProcStat,
  readProcUptimeMs,
  resolveUnitControlGroup,
  type RunCommand,
  runCommand,
} from "./cgroup-reader.js";

// ─── constants ──────────────────────────────────────────────────────────────

/** Read every worker this often; an active worker gets a row every tick (logging.md §4.9). */
export const WORKER_SAMPLE_ACTIVE_INTERVAL_MS = 30_000;
/** An idle worker still gets a row this often — the floor L10 requires. */
export const WORKER_SAMPLE_IDLE_INTERVAL_MS = 300_000;
export const WORKER_ORPHAN_SCAN_INTERVAL_MS = 3_600_000;
/** "Memory within 1 % of the last row" is idle. */
export const WORKER_IDLE_MEM_FRACTION = 0.01;
/**
 * "No CPU since the last row", as a share of one core over the interval. A strict zero never
 * happens for a live process (timers, GC, and for the FTS thread this very probe), so the switch
 * would never fire; 0.1 % is 30 ms per 30 s tick.
 */
export const WORKER_IDLE_CPU_SHARE = 0.001;
/** A probe the FTS worker has not answered in this long reads as unavailable for that tick. */
export const FTS_STATS_PROBE_TIMEOUT_MS = 5_000;
/** systemd is asked for a unit's cgroup at most this many times (a just-spawned unit may not exist yet). */
export const CGROUP_RESOLVE_ATTEMPTS = 3;
/**
 * A spawned worker's first reading comes this long after its spawn: long enough for systemd-run
 * to have created the unit, short enough that a worker living less than one tick is still read.
 */
export const WORKER_FIRST_SAMPLE_DELAY_MS = 2_000;
/**
 * Orphans charted at once. Reported workers are not capped: each leaves the registry at its exit,
 * which the bridge reports on every path, so a spawn row always has an exit row it can pair with.
 */
export const MAX_TRACKED_ORPHANS = 32;
/** The kernel truncates a process name (comm) to 15 bytes (TASK_COMM_LEN 16). */
const COMM_MAX_CHARS = 15;
const DEFAULT_WHATSMEOW_COMM = "whatsmeow-node";
const MIB = 1_048_576;

const log = createSubsystemLogger("worker-resources");

export const WORKER_TYPES = [
  "gateway",
  "tinker_bridge",
  "fts_thread",
  "whatsmeow",
  "events_writer",
] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];
export type WorkerSampleSource = "cgroup" | "process" | "isolate";

type EmitFn = (name: string, record: EmitEventRecord) => void;

// ─── the trend query ────────────────────────────────────────────────────────

/**
 * ONE OWNER, and it is the saved-query registry: `WORKER_MEMORY_TREND_7D_SQL` is DEFINED in
 * ../saved-queries.ts (saved query `worker-memory-trend`) and only re-exported here. Two copies of
 * a query text drift silently — the registry runs one and the test proves the other.
 *
 * Re-exported rather than simply imported by the test, because worker-resources.test.ts runs this
 * SQL against a real events database: a renamed `v_worker_sample` column then fails in the suite
 * that owns the view's producer, which is where the cause is. saved-queries.ts imports nothing at
 * all (a leaf module), so this cannot cycle. worker-resources.test.ts asserts the re-export from
 * the source TEXT, because a `toBe` between two byte-equal copies passes and would not catch a
 * re-declaration.
 */
export { WORKER_MEMORY_TREND_7D_SQL } from "../saved-queries.js";

// ─── the cadence ────────────────────────────────────────────────────────────

export interface SampleBaseline {
  readonly atMs: number;
  /** null on an unavailable row. */
  readonly memBytes: number | null;
  /** The worker's cumulative CPU at the last row that had one (kept across unavailable rows). */
  readonly cpuMs: number | null;
}

export interface CadenceOptions {
  readonly activeIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly idleCpuShare?: number;
  readonly idleMemFraction?: number;
}

/**
 * The idle-cadence switch. A worker's first reading is always written; after that a row is due
 * when the worker moved since its last row, or when the idle interval has passed (a floor, L10).
 * Half an active interval of slack keeps tick jitter from pushing a due row a whole tick late.
 */
export function shouldEmitWorkerSample(
  prev: SampleBaseline | null,
  cur: SampleBaseline,
  opts: CadenceOptions,
): boolean {
  if (prev === null) {
    return true;
  }
  const elapsedMs = cur.atMs - prev.atMs;
  if (elapsedMs + opts.activeIntervalMs / 2 >= opts.idleIntervalMs) {
    return true;
  }
  if (cur.memBytes === null) {
    return false; // an unavailable worker rides the idle cadence only
  }
  if (prev.memBytes === null) {
    return true; // numbers are back after a gap
  }
  const memFraction = opts.idleMemFraction ?? WORKER_IDLE_MEM_FRACTION;
  if (Math.abs(cur.memBytes - prev.memBytes) > prev.memBytes * memFraction) {
    return true;
  }
  if (cur.cpuMs === null || prev.cpuMs === null) {
    return false;
  }
  const cpuShare = opts.idleCpuShare ?? WORKER_IDLE_CPU_SHARE;
  return cur.cpuMs - prev.cpuMs > Math.max(0, elapsedMs) * cpuShare;
}

export interface WorkerReading {
  readonly source: WorkerSampleSource;
  readonly memBytes: number;
  /** CUMULATIVE since the worker started; the row carries the delta since its last row. */
  readonly cpuMs: number | null;
  readonly ageMs: number | null;
  readonly peakBytes: number | null;
  readonly pids?: number | null;
  readonly heapUsedBytes?: number | null;
  readonly heapLimitBytes?: number | null;
}

/**
 * One `worker.sample` row. n2 is the CPU since the worker's previous row; on its first row, the CPU
 * since it started — so the n2 of a worker's rows sum to its total CPU. `reading === null` is
 * `source=unavailable`, with no numbers at all.
 */
export function workerSampleRecord(
  workerType: WorkerType,
  workerId: string,
  reading: WorkerReading | null,
  prev: SampleBaseline | null,
  nowMs: number,
): EmitEventRecord {
  if (reading === null) {
    return { tsMs: nowMs, workerId, label: workerType, fields: { source: "unavailable" } };
  }
  let cpuSinceMs: number | null = null;
  if (reading.cpuMs !== null) {
    cpuSinceMs =
      prev === null || prev.cpuMs === null
        ? reading.cpuMs
        : Math.max(0, reading.cpuMs - prev.cpuMs);
  }
  const fields: Record<string, unknown> = { source: reading.source };
  if (reading.pids !== undefined && reading.pids !== null) {
    fields.pids = reading.pids;
  }
  if (reading.heapUsedBytes !== undefined && reading.heapUsedBytes !== null) {
    fields.heap_used_bytes = reading.heapUsedBytes;
  }
  if (reading.heapLimitBytes !== undefined && reading.heapLimitBytes !== null) {
    fields.heap_limit_bytes = reading.heapLimitBytes;
  }
  return {
    tsMs: nowMs,
    workerId,
    label: workerType,
    n1: reading.memBytes,
    n2: cpuSinceMs === null ? null : Math.round(cpuSinceMs),
    n3: reading.ageMs === null ? null : Math.round(reading.ageMs),
    n4: reading.peakBytes,
    fields,
  };
}

// ─── the readings ───────────────────────────────────────────────────────────

/** The gateway as a process: the same series shape as every other worker. */
export function readGatewayProcess(): WorkerReading {
  const cpu = process.cpuUsage();
  const heap = getHeapStatistics();
  return {
    source: "process",
    memBytes: process.memoryUsage.rss(),
    cpuMs: (cpu.user + cpu.system) / 1000,
    ageMs: process.uptime() * 1000,
    // maxRSS is in kilobytes.
    peakBytes: process.resourceUsage().maxRSS * 1024,
    heapUsedBytes: heap.used_heap_size,
    heapLimitBytes: heap.heap_size_limit,
  };
}

/** The FTS thread's row out of its probe answer; null (unavailable) when the probe was late. */
export function ftsThreadReading(stats: FtsWorkerThreadStats): WorkerReading | null {
  const isolate = stats.isolate;
  if (isolate === null || stats.memBytes === null) {
    return null;
  }
  return {
    source: "isolate",
    memBytes: stats.memBytes,
    cpuMs: isolate.cpuUsec === null ? null : isolate.cpuUsec / 1000,
    ageMs: isolate.uptimeMs,
    peakBytes: stats.peakBytes,
    heapUsedBytes: isolate.usedHeapBytes,
    heapLimitBytes: isolate.heapLimitBytes,
  };
}

/**
 * The events writer thread's row out of its stats answer; null (unavailable) when the probe was
 * late. Committed heap plus external memory, never RSS: the thread shares the gateway's process,
 * so charting RSS under its name would count the gateway twice (the fts_thread precedent).
 */
export function eventsWriterReading(thread: EventWriterThreadStats): WorkerReading | null {
  const isolate = thread.isolate;
  if (isolate === null || thread.memBytes === null) {
    return null;
  }
  return {
    source: "isolate",
    memBytes: thread.memBytes,
    cpuMs: isolate.cpuUsec === null ? null : isolate.cpuUsec / 1000,
    ageMs: isolate.uptimeMs,
    peakBytes: thread.peakBytes,
    heapUsedBytes: isolate.usedHeapBytes,
    heapLimitBytes: isolate.heapLimitBytes,
  };
}

/** The process names whatsmeow's binary runs under: the packaged name, plus an override's basename. */
export function resolveWhatsmeowComms(env: NodeJS.ProcessEnv = process.env): string[] {
  const comms = new Set([DEFAULT_WHATSMEOW_COMM]);
  const override = env.OPENCLAW_WHATSMEOW_BINARY?.trim();
  if (override) {
    comms.add(path.basename(override).slice(0, COMM_MAX_CHARS));
  }
  return [...comms];
}

// ─── orphans ────────────────────────────────────────────────────────────────

export interface OrphanContext {
  readonly selfPid: number;
  /** When this process started (ms epoch). */
  readonly processStartMs: number;
  /** Is the unit's owner pid a live process right now? */
  readonly ownerAlive: boolean;
  /** When that live process started (ms epoch), or null when it cannot be read. */
  readonly ownerStartMs: number | null;
}

/**
 * A clock allowance for "started after the unit was spawned": /proc/stat's btime has one-second
 * granularity, and the unit's timestamp is the spawning gateway's Date.now().
 */
const ORPHAN_CLOCK_SLACK_MS = 2_000;

/**
 * A unit is an orphan when the gateway that spawned it is gone:
 * - its owner pid is dead;
 * - its owner pid is alive but that process started AFTER the unit was spawned — the pid was
 *   reused by an unrelated process, which cannot be the unit's owner;
 * - it is OUR pid but the unit predates this process (a previous gateway with the same pid).
 * A live foreign pid that predates the unit is another gateway's worker — never ours to report. A
 * start time that cannot be read is not evidence either way, and reads as "not an orphan".
 */
export function isOrphanWorkerUnit(unit: ParsedWorkerUnit, ctx: OrphanContext): boolean {
  if (unit.ownerPid === ctx.selfPid) {
    return unit.spawnedAtMs < ctx.processStartMs - ORPHAN_CLOCK_SLACK_MS;
  }
  if (!ctx.ownerAlive) {
    return true;
  }
  return ctx.ownerStartMs !== null && ctx.ownerStartMs > unit.spawnedAtMs + ORPHAN_CLOCK_SLACK_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ─── the registry (globalThis) and the lifecycle reports ───────────────────

interface TrackedWorker {
  readonly workerType: "tinker_bridge";
  readonly workerId: string;
  readonly spawnedAtMs: number;
  /** Found by the orphan scan rather than reported by this process's bridge. */
  readonly orphan: boolean;
  /** undefined until systemd has been asked; null once it had no cgroup to give. */
  cgroupDir: string | null | undefined;
  cgroupAttempts: number;
  baseline: SampleBaseline | null;
  lastMemBytes: number | null;
  peakBytes: number | null;
  /** A reading is in flight (the first-sample timer and a tick can meet): the second one skips. */
  busy: boolean;
}

interface WorkerResourceState {
  readonly tracked: Map<string, TrackedWorker>;
  /** The running sampler's emit; null → the process-wide emitEvent. */
  emit: EmitFn | null;
  /** The running sampler's hook for a new worker's first reading; null while none runs. */
  onSpawn: ((workerId: string) => void) | null;
}

const STATE_KEY = Symbol.for("openclaw.events.workerResources");

/**
 * A direct globalThis lookup, resolved per call (src/shared/global-singleton.ts asks live mutable
 * state to use one): a duplicated copy of this module converges on the same slot.
 */
function workerState(): WorkerResourceState {
  const store = globalThis as Record<symbol, WorkerResourceState | undefined>;
  let state = store[STATE_KEY];
  if (state === undefined) {
    state = { tracked: new Map(), emit: null, onSpawn: null };
    store[STATE_KEY] = state;
  }
  return state;
}

function emitThrough(state: WorkerResourceState, name: string, record: EmitEventRecord): void {
  (state.emit ?? emitEvent)(name, record);
}

export interface WorkerSpawnReport {
  readonly workerType: "tinker_bridge";
  /** The systemd unit the child runs as, without ".service" — also its worker_id. */
  readonly workerId: string;
  /** Did the child start with `--resume` (an existing conversation) rather than fresh? */
  readonly resumed: boolean;
}

/**
 * The bridge started a child: write `worker.spawn`, register its unit, and ask the running sampler
 * for its first reading shortly after. Synchronous, O(1) and never throws — it sits on a spawn path
 * (the reading itself runs later, off it).
 */
export function noteWorkerSpawn(report: WorkerSpawnReport): void {
  try {
    const state = workerState();
    const nowMs = Date.now();
    if (!state.tracked.has(report.workerId)) {
      state.tracked.set(report.workerId, {
        workerType: report.workerType,
        workerId: report.workerId,
        spawnedAtMs: nowMs,
        orphan: false,
        cgroupDir: undefined,
        cgroupAttempts: 0,
        baseline: null,
        lastMemBytes: null,
        peakBytes: null,
        busy: false,
      });
    }
    emitThrough(state, "worker.spawn", {
      tsMs: nowMs,
      workerId: report.workerId,
      label: report.workerType,
      fields: { resumed: report.resumed },
    });
    if (state.onSpawn !== null) {
      state.onSpawn(report.workerId);
    }
  } catch {
    // A telemetry report must never fail a spawn.
  }
}

export interface WorkerExitReport {
  readonly workerId: string;
  readonly code: number | null;
  readonly signal: string | null;
  /**
   * The cause its owner gave when it killed the child (an AbortSignal reason, or a literal such as
   * "fast-fail-init-stall"), or null when nothing killed it. Classified here into a closed set;
   * the text itself is never stored (logging.md L4).
   */
  readonly killCause: string | null;
  readonly turnsServed: number;
}

/**
 * worker.exit's exit_class (logging.md §4.9): clean, signal, crash, init_stall, or
 * `killed.<cause>` with the cause classified by its single owner, src/fork/error-envelope.ts.
 *
 * A cause that is present takes precedence over the exit code: a child that handles SIGTERM and
 * exits 0 was still killed, and "why do workers die" must say so. An EMPTY cause (the pool's
 * reason-less kill, an abort with no reason) is `killed.unknown` — a kill that names no cause, the
 * same "unknown" the error envelope derives from the same latch — never "clean".
 */
export function classifyWorkerExit(
  report: Pick<WorkerExitReport, "code" | "signal" | "killCause">,
): string {
  if (report.killCause !== null) {
    const cause = classifyAbortCause(report.killCause);
    return cause === "fast-fail-init-stall" ? "init_stall" : `killed.${cause}`;
  }
  if (report.signal !== null) {
    return "signal";
  }
  return report.code === 0 ? "clean" : "crash";
}

/**
 * The bridge's child ended: write `worker.exit` — once per registered unit, so a second report of
 * the same end adds nothing — carrying the last sampled memory and the lifetime peak. Never throws.
 */
export function noteWorkerExit(report: WorkerExitReport): void {
  try {
    const state = workerState();
    const tracked = state.tracked.get(report.workerId);
    if (tracked === undefined) {
      return;
    }
    state.tracked.delete(report.workerId);
    const nowMs = Date.now();
    emitThrough(state, "worker.exit", {
      tsMs: nowMs,
      workerId: report.workerId,
      label: classifyWorkerExit(report),
      n1: report.code,
      n2: Math.max(0, nowMs - tracked.spawnedAtMs),
      n3: tracked.lastMemBytes,
      n4: tracked.peakBytes,
      fields: { signal: report.signal, turns_served: report.turnsServed },
    });
  } catch {
    // A telemetry report must never fail an exit handler.
  }
}

// ─── the sampler ────────────────────────────────────────────────────────────

export interface WorkerResourceSamplerOptions {
  readonly emit?: EmitFn;
  readonly now?: () => number;
  readonly activeIntervalMs?: number;
  readonly idleIntervalMs?: number;
  readonly orphanScanIntervalMs?: number;
  /** Test seams: fixture trees instead of the host's /sys/fs/cgroup and /proc. */
  readonly cgroupRoot?: string;
  readonly procRoot?: string;
  readonly selfPid?: number;
  readonly processStartMs?: number;
  /** A reported worker's first reading comes this long after its spawn. */
  readonly firstSampleDelayMs?: number;
  /** Test seam: how systemctl is run. */
  readonly run?: RunCommand;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly readGateway?: () => WorkerReading | null;
  readonly readFtsThread?: (timeoutMs: number) => Promise<FtsWorkerThreadStats | null>;
  readonly readWriterThread?: () => Promise<EventWriterThreadStats | null>;
  readonly whatsmeowComms?: readonly string[];
}

export interface WorkerResourceSampler {
  /** One tick: read every worker, write the rows that are due. Never rejects; ticks never overlap. */
  sampleOnce(): Promise<void>;
  /** One orphan scan. Never rejects. */
  scanOrphans(): Promise<void>;
  start(): void;
  stop(): void;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  timer.unref?.();
}

export function createWorkerResourceSampler(
  options: WorkerResourceSamplerOptions = {},
): WorkerResourceSampler {
  const emit = options.emit ?? emitEvent;
  const now = options.now ?? Date.now;
  const cadence: CadenceOptions = {
    activeIntervalMs: options.activeIntervalMs ?? WORKER_SAMPLE_ACTIVE_INTERVAL_MS,
    idleIntervalMs: options.idleIntervalMs ?? WORKER_SAMPLE_IDLE_INTERVAL_MS,
  };
  const orphanScanIntervalMs = options.orphanScanIntervalMs ?? WORKER_ORPHAN_SCAN_INTERVAL_MS;
  const cgroupRoot = options.cgroupRoot ?? CGROUP_FS_ROOT;
  const procRoot = options.procRoot ?? PROC_FS_ROOT;
  const selfPid = options.selfPid ?? process.pid;
  const processStartMs = options.processStartMs ?? Date.now() - process.uptime() * 1000;
  const firstSampleDelayMs = options.firstSampleDelayMs ?? WORKER_FIRST_SAMPLE_DELAY_MS;
  const run = options.run ?? runCommand;
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const readGateway = options.readGateway ?? readGatewayProcess;
  const readFtsThread = options.readFtsThread ?? readFtsWorkerThreadStats;
  const readWriterThread = options.readWriterThread ?? readEventWriterThreadStats;
  const whatsmeowComms = new Set(options.whatsmeowComms ?? resolveWhatsmeowComms());
  const gatewayId = `gateway-${selfPid}`;

  /** Baselines of the workers this sampler finds for itself: the gateway, the FTS thread, whatsmeow. */
  const baselines = new Map<string, SampleBaseline>();
  /** Orphans already written: one row per unit per gateway life. */
  const reportedOrphans = new Set<string>();
  let sampling: Promise<void> | null = null;
  let timers: Array<ReturnType<typeof setInterval>> = [];
  /** First-sample timers not yet fired, so stop() can cancel them. */
  const firstSampleTimers = new Set<ReturnType<typeof setTimeout>>();
  let failureLogged = false;

  function noteFailure(err: unknown): void {
    if (!failureLogged) {
      failureLogged = true;
      log.warn(
        `worker-resources: a sample source failed (logged once per sampler): ${String(err)}`,
      );
    }
  }

  /** Writes the row when it is due; returns the baseline the next tick compares against. */
  function offer(
    workerType: WorkerType,
    workerId: string,
    reading: WorkerReading | null,
    prev: SampleBaseline | null,
    nowMs: number,
  ): SampleBaseline | null {
    const cur: SampleBaseline = {
      atMs: nowMs,
      memBytes: reading === null ? null : reading.memBytes,
      cpuMs: reading?.cpuMs ?? prev?.cpuMs ?? null,
    };
    if (!shouldEmitWorkerSample(prev, cur, cadence)) {
      return prev;
    }
    emit("worker.sample", workerSampleRecord(workerType, workerId, reading, prev, nowMs));
    return cur;
  }

  function offerFound(
    workerType: WorkerType,
    workerId: string,
    reading: WorkerReading | null,
    nowMs: number,
    seen: Set<string>,
  ): void {
    seen.add(workerId);
    const next = offer(workerType, workerId, reading, baselines.get(workerId) ?? null, nowMs);
    if (next !== null) {
      baselines.set(workerId, next);
    }
  }

  async function cgroupDirOf(worker: TrackedWorker): Promise<string | null> {
    if (worker.cgroupDir !== undefined) {
      return worker.cgroupDir;
    }
    worker.cgroupAttempts += 1;
    const controlGroup = await resolveUnitControlGroup(worker.workerId, run);
    const dir = controlGroup === null ? null : cgroupDirFor(controlGroup, cgroupRoot);
    // Resolved ONCE per worker: a path, once found, is kept for the worker's life. A unit systemd
    // has not started yet is asked again on the next ticks, a bounded number of times.
    if (dir !== null || worker.cgroupAttempts >= CGROUP_RESOLVE_ATTEMPTS) {
      worker.cgroupDir = dir;
    }
    return dir;
  }

  async function sampleBridgeWorker(worker: TrackedWorker, nowMs: number): Promise<void> {
    if (worker.busy) {
      return; // the first-sample timer and a tick met: one reading is enough
    }
    worker.busy = true;
    try {
      await readBridgeWorker(worker, nowMs);
    } finally {
      worker.busy = false;
    }
  }

  async function readBridgeWorker(worker: TrackedWorker, nowMs: number): Promise<void> {
    const state = workerState();
    const dir = await cgroupDirOf(worker);
    const cgroup = dir === null ? null : await readCgroup(dir);
    if (state.tracked.get(worker.workerId) !== worker) {
      return; // it exited while we read: its exit row is written, and a sample after it would lie
    }
    if (cgroup === null && worker.orphan) {
      // An orphan's unit is gone (stopped by hand, or it finished); nobody owns its exit.
      state.tracked.delete(worker.workerId);
      return;
    }
    let reading: WorkerReading | null = null;
    if (cgroup !== null) {
      worker.lastMemBytes = cgroup.memoryCurrentBytes;
      worker.peakBytes = Math.max(
        worker.peakBytes ?? 0,
        cgroup.memoryPeakBytes ?? cgroup.memoryCurrentBytes,
      );
      reading = {
        source: "cgroup",
        memBytes: cgroup.memoryCurrentBytes,
        cpuMs: cgroup.cpuUsageUsec === null ? null : cgroup.cpuUsageUsec / 1000,
        ageMs: Math.max(0, nowMs - worker.spawnedAtMs),
        peakBytes: worker.peakBytes,
        pids: cgroup.pidsCurrent,
      };
    }
    worker.baseline = offer("tinker_bridge", worker.workerId, reading, worker.baseline, nowMs);
  }

  async function sampleFtsThread(nowMs: number, seen: Set<string>): Promise<void> {
    const stats = await readFtsThread(FTS_STATS_PROBE_TIMEOUT_MS);
    if (stats === null) {
      return; // no FTS worker is running: nothing to chart, and a probe never starts one
    }
    offerFound("fts_thread", stats.workerId, ftsThreadReading(stats), nowMs, seen);
  }

  async function sampleWriterThread(nowMs: number, seen: Set<string>): Promise<void> {
    const thread = await readWriterThread();
    if (thread === null) {
      return; // no writer thread runs: nothing to chart, and this probe never starts one
    }
    // A running thread whose probe was late still gets a row — source=unavailable, no numbers.
    offerFound("events_writer", thread.workerId, eventsWriterReading(thread), nowMs, seen);
  }

  async function sampleWhatsmeow(nowMs: number, seen: Set<string>): Promise<void> {
    const children = await listChildPids(selfPid, procRoot);
    if (children.length === 0) {
      return;
    }
    const stats = await Promise.all(children.map((pid) => readProcStat(pid, procRoot)));
    const matches: number[] = [];
    for (let i = 0; i < children.length; i++) {
      const stat = stats[i];
      if (stat !== null && whatsmeowComms.has(stat.comm)) {
        matches.push(children[i]);
      }
    }
    if (matches.length === 0) {
      return;
    }
    const [uptimeMs, readings] = await Promise.all([
      readProcUptimeMs(procRoot),
      Promise.all(matches.map((pid) => readProcProcess(pid, procRoot))),
    ]);
    for (const proc of readings) {
      if (proc === null) {
        continue; // it exited between the two reads: gone, not unavailable
      }
      offerFound(
        "whatsmeow",
        `whatsmeow-${proc.pid}`,
        {
          source: "process",
          memBytes: proc.rssBytes,
          cpuMs: proc.cpuMs,
          ageMs:
            uptimeMs === null
              ? null
              : Math.max(0, uptimeMs - (proc.startTicks * 1000) / PROC_USER_HZ),
          peakBytes: proc.peakRssBytes,
        },
        nowMs,
        seen,
      );
    }
  }

  async function sampleNow(): Promise<void> {
    const nowMs = now();
    const seen = new Set<string>([gatewayId]);
    let gateway: WorkerReading | null = null;
    try {
      gateway = readGateway();
    } catch (err) {
      noteFailure(err);
    }
    offerFound("gateway", gatewayId, gateway, nowMs, seen);
    const bridgeWorkers = [...workerState().tracked.values()];
    await Promise.all([
      ...bridgeWorkers.map((worker) => sampleBridgeWorker(worker, nowMs).catch(noteFailure)),
      sampleFtsThread(nowMs, seen).catch(noteFailure),
      sampleWriterThread(nowMs, seen).catch(noteFailure),
      sampleWhatsmeow(nowMs, seen).catch(noteFailure),
    ]);
    for (const workerId of baselines.keys()) {
      if (!seen.has(workerId)) {
        baselines.delete(workerId);
      }
    }
  }

  function sampleOnce(): Promise<void> {
    sampling ??= sampleNow()
      .catch(noteFailure)
      .finally(() => {
        sampling = null;
      });
    return sampling;
  }

  async function scanNow(): Promise<void> {
    const units = await listLiveWorkerUnits(run);
    if (units === null) {
      return; // systemd cannot be asked here (not Linux, no user manager): nothing to scan
    }
    const state = workerState();
    const nowMs = now();
    for (const unit of units) {
      if (reportedOrphans.has(unit) || state.tracked.has(unit)) {
        continue;
      }
      const parsed = parseWorkerUnitName(unit);
      if (parsed === null) {
        continue;
      }
      const foreign = parsed.ownerPid !== selfPid;
      const ownerAlive = !foreign || isPidAlive(parsed.ownerPid);
      const ownerStartMs =
        foreign && ownerAlive ? await readProcessStartMs(parsed.ownerPid, procRoot) : null;
      if (!isOrphanWorkerUnit(parsed, { selfPid, processStartMs, ownerAlive, ownerStartMs })) {
        continue;
      }
      reportedOrphans.add(unit);
      const controlGroup = await resolveUnitControlGroup(unit, run);
      const dir = controlGroup === null ? null : cgroupDirFor(controlGroup, cgroupRoot);
      const cgroup = dir === null ? null : await readCgroup(dir);
      const ageMs = Math.max(0, nowMs - parsed.spawnedAtMs);
      emit("worker.orphan", {
        tsMs: nowMs,
        workerId: unit,
        n1: ageMs,
        n2: cgroup === null ? null : cgroup.memoryCurrentBytes,
      });
      const memory =
        cgroup === null ? "unreadable" : `${Math.round(cgroup.memoryCurrentBytes / MIB)} MiB`;
      log.warn(
        `orphaned tinker-bridge worker ${unit}.service: the gateway that spawned it (pid ` +
          `${parsed.ownerPid}) is gone; age ${Math.round(ageMs / 60_000)} min, memory ${memory}. ` +
          `Stop it with: systemctl --user stop ${unit}.service (logging.md §4.9)`,
      );
      const orphansTracked = [...state.tracked.values()].filter((w) => w.orphan).length;
      if (dir !== null && cgroup !== null && orphansTracked < MAX_TRACKED_ORPHANS) {
        state.tracked.set(unit, {
          workerType: "tinker_bridge",
          workerId: unit,
          spawnedAtMs: parsed.spawnedAtMs,
          orphan: true,
          cgroupDir: dir,
          cgroupAttempts: 1,
          baseline: null,
          lastMemBytes: cgroup.memoryCurrentBytes,
          peakBytes: cgroup.memoryPeakBytes ?? cgroup.memoryCurrentBytes,
          busy: false,
        });
      }
    }
  }

  function scanOrphans(): Promise<void> {
    return scanNow().catch(noteFailure);
  }

  function onSpawn(workerId: string): void {
    const timer = setTimeout(() => {
      firstSampleTimers.delete(timer);
      const worker = workerState().tracked.get(workerId);
      if (worker !== undefined) {
        void sampleBridgeWorker(worker, now()).catch(noteFailure);
      }
    }, firstSampleDelayMs);
    timer.unref?.();
    firstSampleTimers.add(timer);
  }

  function start(): void {
    if (timers.length > 0) {
      return;
    }
    const state = workerState();
    state.emit = emit;
    state.onSpawn = onSpawn;
    const tick = setInterval(() => {
      void sampleOnce();
    }, cadence.activeIntervalMs);
    unrefTimer(tick);
    const scan = setInterval(() => {
      void scanOrphans();
    }, orphanScanIntervalMs);
    unrefTimer(scan);
    timers = [tick, scan];
    void sampleOnce();
    void scanOrphans();
  }

  function stop(): void {
    for (const timer of timers) {
      clearInterval(timer);
    }
    timers = [];
    for (const timer of firstSampleTimers) {
      clearTimeout(timer);
    }
    firstSampleTimers.clear();
    const state = workerState();
    if (state.emit === emit) {
      state.emit = null;
    }
    if (state.onSpawn === onSpawn) {
      state.onSpawn = null;
    }
  }

  return { sampleOnce, scanOrphans, start, stop };
}

// ─── the process-wide sampler (gateway startup wires these) ─────────────────

let processSampler: WorkerResourceSampler | null = null;

/**
 * Gateway startup (server.impl.ts), after startEventWriter. Idempotent. Starts nothing and returns
 * false while the events writer is disabled (OPENCLAW_EVENTS_DB=0, or paths.ts refusing the
 * production path under a test runner): with nowhere to write, the systemctl and /proc reads would
 * be pure cost.
 */
export function startWorkerResourceSampler(options: WorkerResourceSamplerOptions = {}): boolean {
  if (processSampler !== null) {
    return true;
  }
  if (!getEventWriterStats().enabled) {
    return false;
  }
  processSampler = createWorkerResourceSampler(options);
  processSampler.start();
  log.info(
    `worker-resources sampler started: every ${WORKER_SAMPLE_ACTIVE_INTERVAL_MS / 1000} s, ` +
      `idle workers every ${WORKER_SAMPLE_IDLE_INTERVAL_MS / 1000} s (logging.md §4.9)`,
  );
  return true;
}

/** Gateway shutdown, before the writer stops. Idempotent. */
export function stopWorkerResourceSampler(): void {
  processSampler?.stop();
  processSampler = null;
}

/** Test seam: stops the process-wide sampler, empties the registry and sets the emit it writes through. */
export function resetWorkerResourcesForTest(emit: EmitFn | null = null): void {
  stopWorkerResourceSampler();
  const state = workerState();
  state.tracked.clear();
  state.emit = emit;
  state.onSpawn = null;
}
