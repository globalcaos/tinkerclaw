/**
 * `gw.health.sample` and `gw.boot` — TINKER_UI_DESIGN_BIBLE/logging.md §4.1, §9 step 4.
 *
 * gw.health.sample is the main thread's health every 30 s, UNCONDITIONALLY (L10). The heartbeat's
 * liveness sampler (src/logging/diagnostic.ts) discards every healthy sample and warns only past a
 * bar, so there "no data" and "fine" read the same; this row is the baseline it lacks.
 *
 *  - n1..n4 (loop_p99_ms, loop_max_ms, elu, cpu_core_ratio) come from this sampler's OWN
 *    stall-clock reader: the gateway hands it a createGatewayEventLoopHealthMonitor() nobody else
 *    reads (src/gateway/server/event-loop-health.ts), a per-reader cursor on the shared 20 ms
 *    stall clock, so reading it resets nothing another consumer depends on. Its delays are the
 *    lateness PAST each 20 ms tick; gw.liveness.warning carries monitorEventLoopDelay's, which
 *    include that ~20 ms baseline — compare the two series by threshold, not to the millisecond.
 *  - gc_count, gc_ms, gc_max_pause_ms: a PerformanceObserver on `gc` entries, summed per window.
 *  - active, waiting, queued: the heartbeat's work counts (getDiagnosticWorkCounts), absent while
 *    diagnostics are off for the process.
 *
 * CADENCE. A timer of its own at the heartbeat's period, not the heartbeat tick §4.1 names: the
 * gateway starts the heartbeat only when diagnostics are enabled (server.impl.ts) and
 * startDiagnosticHeartbeat returns early otherwise, so a row riding that tick could not be
 * unconditional. gateway-health.test.ts pins the two periods equal. The first row lands one
 * period after start: a window has to span time before its loop reading means anything.
 *
 * A missing or throwing reading leaves its slots NULL in a row that is still written: a skipped
 * row would read the same as a stopped sampler.
 */
import { PerformanceObserver } from "node:perf_hooks";
import { emitEvent, getEventWriterStats } from "../emit.js";

type EmitEventFn = typeof emitEvent;

/** logging.md §4.1 cadence for gw.health.sample; equal to DIAGNOSTIC_HEARTBEAT_INTERVAL_MS. */
export const GATEWAY_HEALTH_SAMPLE_INTERVAL_MS = 30_000;
/** gw.boot keeps this many hex chars of the config's sha256: enough to tell two configs apart. */
export const CONFIG_HASH_ID_CHARS = 16;

/** One window of the loop, as createGatewayEventLoopHealthMonitor().snapshot() reports it. */
export interface GatewayLoopHealthReading {
  readonly delayP99Ms: number;
  readonly delayMaxMs: number;
  readonly utilization: number;
  readonly cpuCoreRatio: number;
}

export interface GatewayWorkCounts {
  readonly active: number;
  readonly waiting: number;
  readonly queued: number;
}

export interface GcWindow {
  readonly count: number;
  readonly totalMs: number;
  readonly maxPauseMs: number;
}

export interface GcWindowSource {
  /**
   * The GC pauses since the previous take(), then a fresh window. A window in which no GC ran is
   * zeros; undefined means only that GC is not observable at all.
   */
  take(): GcWindow | undefined;
  stop(): void;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function readOrUndefined<T>(read: (() => T | undefined) | undefined): T | undefined {
  if (read === undefined) {
    return undefined;
  }
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** GC pauses from a PerformanceObserver on `gc` entries, summed per window. */
export function createGcWindowSource(): GcWindowSource {
  let count = 0;
  let totalMs = 0;
  let maxPauseMs = 0;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        count += 1;
        totalMs += entry.duration;
        maxPauseMs = Math.max(maxPauseMs, entry.duration);
      }
    });
    observer.observe({ entryTypes: ["gc"] });
  } catch {
    observer = null;
  }
  return {
    take() {
      if (observer === null) {
        return undefined;
      }
      const window: GcWindow = {
        count,
        totalMs: roundTenth(totalMs),
        maxPauseMs: roundTenth(maxPauseMs),
      };
      count = 0;
      totalMs = 0;
      maxPauseMs = 0;
      return window;
    },
    stop() {
      observer?.disconnect();
      observer = null;
    },
  };
}

export interface GatewayHealthSamplerOptions {
  /** This sampler's OWN loop reader: never one another consumer also reads. */
  readonly readLoopHealth: () => GatewayLoopHealthReading | undefined;
  readonly readWork?: () => GatewayWorkCounts | undefined;
  /** Test seam; an injected source stays its owner's to stop. Defaults to createGcWindowSource(). */
  readonly gc?: GcWindowSource;
  /** Test seam; omitted, rows go to the process-wide emitEvent. */
  readonly emit?: EmitEventFn;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface GatewayHealthSampler {
  /** Writes one row now; the timer calls this every interval. */
  sample(): void;
  /** Stops the timer, and the GC observer when the sampler created it. Idempotent. */
  stop(): void;
}

/**
 * Starts the sampler. Without an injected `emit` it starts only while the process-wide writer is
 * enabled — start it AFTER startEventWriter — and otherwise returns an inert sampler.
 */
export function startGatewayHealthSampler(
  options: GatewayHealthSamplerOptions,
): GatewayHealthSampler {
  if (options.emit === undefined && !getEventWriterStats().enabled) {
    return { sample: () => {}, stop: () => {} };
  }
  const emit = options.emit ?? emitEvent;
  const now = options.now ?? Date.now;
  const ownsGc = options.gc === undefined;
  const gc = options.gc ?? createGcWindowSource();
  let stopped = false;

  function sample(): void {
    if (stopped) {
      return;
    }
    const loop = readOrUndefined(options.readLoopHealth);
    const work = readOrUndefined(options.readWork);
    const gcWindow = readOrUndefined(() => gc.take());
    const fields: Record<string, number> = {};
    if (gcWindow !== undefined) {
      fields.gc_count = gcWindow.count;
      fields.gc_ms = gcWindow.totalMs;
      fields.gc_max_pause_ms = gcWindow.maxPauseMs;
    }
    if (work !== undefined) {
      fields.active = work.active;
      fields.waiting = work.waiting;
      fields.queued = work.queued;
    }
    emit("gw.health.sample", {
      tsMs: now(),
      n1: loop?.delayP99Ms,
      n2: loop?.delayMaxMs,
      n3: loop?.utilization,
      n4: loop?.cpuCoreRatio,
      fields,
    });
  }

  const timer: NodeJS.Timeout = setInterval(
    sample,
    options.intervalMs ?? GATEWAY_HEALTH_SAMPLE_INTERVAL_MS,
  );
  timer.unref();
  return {
    sample,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      if (ownsGc) {
        gc.stop();
      }
    },
  };
}

export interface GatewayBootSources {
  /** The build commit (resolveCommitHash: 7 hex chars), or null when nothing knows it. */
  readonly commit: () => string | null;
  /** Plugins whose status is `loaded`. */
  readonly pluginCount: () => number;
  /** The startup config snapshot's sha256 in hex, or null; only a prefix is stored. */
  readonly configHash: () => string | null;
  /** Defaults to process.version. */
  readonly nodeVersion?: string;
}

/**
 * The `gw.boot` mark (§4.1), once per boot: which build, runtime, plugin set and config were
 * running, so a trend that changes can be lined up with the boot that changed it. Each source is
 * read inside a guard: an unknown or failing one is a NULL — never a guessed value, never a failed
 * boot.
 */
export function emitGatewayBoot(sources: GatewayBootSources, emit: EmitEventFn = emitEvent): void {
  const commit = readOrUndefined(sources.commit) ?? null;
  const configHash = readOrUndefined(sources.configHash) ?? null;
  emit("gw.boot", {
    label: commit,
    fields: {
      node_version: sources.nodeVersion ?? process.version,
      plugin_count: readOrUndefined(sources.pluginCount),
      config_hash: configHash === null ? undefined : configHash.slice(0, CONFIG_HASH_ID_CHARS),
    },
  });
}
