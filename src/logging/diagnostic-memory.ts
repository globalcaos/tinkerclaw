// FORK 2026-10-29: areDiagnosticsEnabledForProcess, emitEvent and the diagnostic logger serve the
// heap sample at the end of this file.
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  type DiagnosticMemoryPressureEvent,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import { emitEvent, MAX_FIELDS_JSON_CHARS } from "../infra/events/emit.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";

const MB = 1024 * 1024;
const DEFAULT_RSS_WARNING_BYTES = 1536 * MB;
const DEFAULT_RSS_CRITICAL_BYTES = 3072 * MB;
const DEFAULT_HEAP_WARNING_BYTES = 1024 * MB;
const DEFAULT_HEAP_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_RSS_GROWTH_WARNING_BYTES = 512 * MB;
const DEFAULT_RSS_GROWTH_CRITICAL_BYTES = 1024 * MB;
const DEFAULT_GROWTH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PRESSURE_REPEAT_MS = 5 * 60 * 1000;

export type DiagnosticMemoryThresholds = {
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  heapUsedWarningBytes?: number;
  heapUsedCriticalBytes?: number;
  rssGrowthWarningBytes?: number;
  rssGrowthCriticalBytes?: number;
  growthWindowMs?: number;
  pressureRepeatMs?: number;
};

type DiagnosticMemorySample = {
  ts: number;
  memory: DiagnosticMemoryUsage;
};

type DiagnosticMemoryState = {
  lastSample: DiagnosticMemorySample | null;
  lastPressureAtByKey: Map<string, number>;
};

const state: DiagnosticMemoryState = {
  lastSample: null,
  lastPressureAtByKey: new Map(),
};

function normalizeMemoryUsage(memory: NodeJS.MemoryUsage): DiagnosticMemoryUsage {
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function resolveThresholds(
  thresholds?: DiagnosticMemoryThresholds,
): Required<DiagnosticMemoryThresholds> {
  return {
    rssWarningBytes: thresholds?.rssWarningBytes ?? DEFAULT_RSS_WARNING_BYTES,
    rssCriticalBytes: thresholds?.rssCriticalBytes ?? DEFAULT_RSS_CRITICAL_BYTES,
    heapUsedWarningBytes: thresholds?.heapUsedWarningBytes ?? DEFAULT_HEAP_WARNING_BYTES,
    heapUsedCriticalBytes: thresholds?.heapUsedCriticalBytes ?? DEFAULT_HEAP_CRITICAL_BYTES,
    rssGrowthWarningBytes: thresholds?.rssGrowthWarningBytes ?? DEFAULT_RSS_GROWTH_WARNING_BYTES,
    rssGrowthCriticalBytes: thresholds?.rssGrowthCriticalBytes ?? DEFAULT_RSS_GROWTH_CRITICAL_BYTES,
    growthWindowMs: thresholds?.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS,
    pressureRepeatMs: thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS,
  };
}

function pickThresholdPressure(params: {
  memory: DiagnosticMemoryUsage;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { memory, thresholds } = params;
  if (memory.rssBytes >= thresholds.rssCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssCriticalBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedCriticalBytes) {
    return {
      level: "critical",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedCriticalBytes,
    };
  }
  if (memory.rssBytes >= thresholds.rssWarningBytes) {
    return {
      level: "warning",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssWarningBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedWarningBytes) {
    return {
      level: "warning",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedWarningBytes,
    };
  }
  return null;
}

function pickGrowthPressure(params: {
  previous: DiagnosticMemorySample | null;
  current: DiagnosticMemorySample;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { previous, current, thresholds } = params;
  if (!previous) {
    return null;
  }
  const windowMs = current.ts - previous.ts;
  if (windowMs <= 0 || windowMs > thresholds.growthWindowMs) {
    return null;
  }
  const rssGrowthBytes = current.memory.rssBytes - previous.memory.rssBytes;
  if (rssGrowthBytes >= thresholds.rssGrowthCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthCriticalBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  if (rssGrowthBytes >= thresholds.rssGrowthWarningBytes) {
    return {
      level: "warning",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthWarningBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  return null;
}

function shouldEmitPressure(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
  now: number,
  repeatMs: number,
): boolean {
  const key = `${pressure.level}:${pressure.reason}`;
  const lastAt = state.lastPressureAtByKey.get(key);
  if (lastAt !== undefined && now - lastAt < repeatMs) {
    return false;
  }
  state.lastPressureAtByKey.set(key, now);
  return true;
}

export function emitDiagnosticMemorySample(options?: {
  now?: number;
  memoryUsage?: NodeJS.MemoryUsage;
  uptimeMs?: number;
  thresholds?: DiagnosticMemoryThresholds;
  emitSample?: boolean;
  /** FORK 2026-10-29: test seam for the heap sample a critical event starts (end of file). */
  heapSample?: DiagnosticHeapSampleOptions;
}): DiagnosticMemoryUsage {
  const now = options?.now ?? Date.now();
  const memory = normalizeMemoryUsage(options?.memoryUsage ?? process.memoryUsage());
  const current = { ts: now, memory };
  const thresholds = resolveThresholds(options?.thresholds);
  const shouldEmitSample = options?.emitSample !== false;

  if (shouldEmitSample) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory,
      uptimeMs: options?.uptimeMs ?? Math.round(process.uptime() * 1000),
    });
  }

  const pressure =
    pickThresholdPressure({ memory, thresholds }) ??
    pickGrowthPressure({ previous: state.lastSample, current, thresholds });
  state.lastSample = current;
  if (pressure && shouldEmitPressure(pressure, now, thresholds.pressureRepeatMs)) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      ...pressure,
    });
    // FORK 2026-10-29: a critical event also samples the heap's allocation sites (end of file).
    if (pressure.level === "critical") {
      maybeStartHeapSample(pressure, now, options?.heapSample);
    }
  }
  return memory;
}

export function resetDiagnosticMemoryForTest(): void {
  state.lastSample = null;
  state.lastPressureAtByKey.clear();
  resetHeapSampleState(); // FORK 2026-10-29: the heap sample's throttle (below).
}

// ─── FORK 2026-10-29: allocation sites behind a critical memory pressure event ────────────────
//
// WHY. The gateway heap jumps from 0.4-0.8 GB to as much as 4.5 GB in turn bursts, and no record
// says what allocates it: the pressure event above names a level and a reason, never a site, so a
// cut would be a guess. A critical event now runs V8's sampling heap profiler for one bounded
// window and writes the top allocation sites as one log line and one `gw.memory.heap_sample`
// events row (logging.md §4.1), stamped with the time and level:reason of the pressure event.
//
// HOW. A same-thread node:inspector session: HeapProfiler.startSampling at V8's default interval
// (one sample per ~32 KiB allocated), then HeapProfiler.stopSampling when the window ends. Both
// includeObjectsCollected* flags are set. Without them the profile keeps only what is still alive
// at the stop: a probe on node 22.23 lost a 100 MB transient allocation entirely and showed only
// the 10 MB still held. With them a site's self size is what it allocated in the window, freed or
// not, which is the question here. Never a heap snapshot: it serializes the whole heap and stops
// the main thread for seconds.
//
// COST. Each sampled allocation records a stack (its CPU share is not measured here). The stop
// forces one full GC (V8's inspector always asks for it) and parses the profile on the main
// thread: 8 ms with an empty heap, 146 ms with 271 MB live and 333 ms with 603 MB live in a probe
// on the reference host, about 0.55 ms per live MB. Each row records its own stop time (n4), so
// the gateway's figure is measured, not extrapolated.
//
// SAFETY. Fire-and-forget from the heartbeat, every step inside try/catch: a failure is one warn
// line and never reaches the caller. With no inspector (a node built without it, a runtime with no
// Session) the sampler logs one line and stays off for the life of the process.

/**
 * One sample's window. Objective: profile the burst while it still allocates. Derived from the
 * pressure check's own cadence (the 30 s diagnostic heartbeat) and the measured burst width: the
 * jumps above 600 MB happen within one 30 s worker.sample interval (96 h of rows to 2026-10-29).
 * Break-even: a longer window grows V8's sample list and the profile parsed at the stop (about
 * 0.55 KB per MB allocated) and dilutes the burst with background allocation; a shorter one misses
 * the rest of a burst that has just crossed the line. What moves it: the burst widths these rows
 * show (n1 against the heap change).
 */
export const HEAP_SAMPLE_WINDOW_MS = 30_000;

/**
 * At most one sample starts per interval, and never while one runs. Objective: cap the sampler's
 * own cost (one forced full GC each) and still cover every hour that has a burst. Derived from 73
 * critical pressure rows in 30 h (72 critical:rss, 1 critical:heap; events.sqlite, 2026-10-29),
 * about 2.4 an hour, so hourly caps the sampler at 24 runs a day. Break-even: each run costs its
 * stop time on the main thread, and once successive rows name the same top sites the next one
 * adds nothing. What moves it: stop times (n4) well past a second, or rows that stop naming new
 * sites.
 */
export const HEAP_SAMPLE_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sites kept per sample, largest self size first. Objective: name the burst's allocators, not only
 * the largest one. Bounded by the writer's fields cap (MAX_FIELDS_JSON_CHARS, 8,192): 20 sites at
 * HEAP_SAMPLE_TEXT_MAX_CHARS stay under about 6,800 characters. What moves it: a top 20 that sums
 * to too small a share of a row's n1 to name the burst.
 */
export const HEAP_SAMPLE_TOP_SITES = 20;

/** Bound on a function name and on each file:line, sized so the top sites fit the fields cap. */
const HEAP_SAMPLE_TEXT_MAX_CHARS = 96;

/** The events row. The writer drops, and counts, any name src/infra/events/catalog.ts lacks. */
const HEAP_SAMPLE_EVENT = "gw.memory.heap_sample";

/** The part of a node:inspector/promises Session the sampler uses; tests pass a fake. */
export type DiagnosticHeapSampleSession = {
  post(method: string, params?: Record<string, unknown>): Promise<unknown>;
  disconnect(): void;
};

export type DiagnosticHeapSampleOptions = {
  /** Returns a connected session, or null when this runtime has no inspector. */
  openSession?: () => DiagnosticHeapSampleSession | null;
};

/** The fields of a CDP HeapProfiler.SamplingHeapProfileNode that the summary reads. */
export type HeapSamplingProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: HeapSamplingProfileNode[];
};

/** One allocation site: the function, its file:line (no host path) and the sampled bytes. */
export type DiagnosticHeapSampleSite = { fn: string; site: string; bytes: number };

type InspectorSession = DiagnosticHeapSampleSession & { connect(): void };

type HeapSampleTrigger = { atMs: number; label: string; heapUsedBytes: number };

type HeapSampleState = { lastStartAtMs: number | null; inFlight: boolean; unavailable: boolean };

const heapSampleState: HeapSampleState = {
  lastStartAtMs: null,
  inFlight: false,
  unavailable: false,
};

function resetHeapSampleState(): void {
  heapSampleState.lastStartAtMs = null;
  heapSampleState.inFlight = false;
  heapSampleState.unavailable = false;
}

function maybeStartHeapSample(
  pressure: Pick<DiagnosticMemoryPressureEvent, "level" | "reason" | "memory">,
  now: number,
  options: DiagnosticHeapSampleOptions | undefined,
): void {
  try {
    const last = heapSampleState.lastStartAtMs;
    if (
      heapSampleState.unavailable ||
      heapSampleState.inFlight ||
      !areDiagnosticsEnabledForProcess() ||
      (last !== null && now - last < HEAP_SAMPLE_MIN_INTERVAL_MS)
    ) {
      return;
    }
    const trigger: HeapSampleTrigger = {
      atMs: now,
      label: `${pressure.level}:${pressure.reason}`,
      heapUsedBytes: pressure.memory.heapUsedBytes,
    };
    heapSampleState.lastStartAtMs = now;
    heapSampleState.inFlight = true;
    void runHeapSample(trigger, options?.openSession ?? openInspectorSession).catch(() => {
      // runHeapSample logs its own failures; nothing may reach the heartbeat.
    });
  } catch {
    // The sampler must never disturb the pressure check that called it.
  }
}

async function runHeapSample(
  trigger: HeapSampleTrigger,
  openSession: () => DiagnosticHeapSampleSession | null,
): Promise<void> {
  let session: DiagnosticHeapSampleSession | null = null;
  try {
    session = openHeapSampleSession(openSession, trigger.label);
    if (session === null) {
      return;
    }
    const startedAtMs = Date.now();
    // No samplingInterval, so V8's default; the two flags keep freed objects (HOW, above).
    await session.post("HeapProfiler.startSampling", {
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEAP_SAMPLE_WINDOW_MS).unref?.();
    });
    const stopAtMs = Date.now();
    const stopped = await session.post("HeapProfiler.stopSampling");
    const stopMs = Date.now() - stopAtMs;
    const windowMs = stopAtMs - startedAtMs;
    const heapAfterStopBytes = process.memoryUsage().heapUsed;
    const { totalBytes, sites } = summarizeHeapSamplingProfile(readSamplingProfile(stopped));
    const topText = sites
      .map((entry, index) => `${index + 1}) ${formatMb(entry.bytes)} ${entry.fn} ${entry.site}`)
      .join("; ");
    diag.info(
      `heap sample ${trigger.label}: window=${windowMs}ms stop=${stopMs}ms ` +
        `sampled=${formatMb(totalBytes)} heapUsed=${formatMb(trigger.heapUsedBytes)}` +
        `->${formatMb(heapAfterStopBytes)} top: ${topText || "(none)"}`,
    );
    // Unguarded, like gw.profile.captured: a name the catalog does not declare is counted under
    // logs.writer.stats unknown_names, so a missing declaration shows up instead of passing.
    emitEvent(HEAP_SAMPLE_EVENT, {
      tsMs: trigger.atMs,
      label: trigger.label,
      durMs: windowMs,
      n1: totalBytes,
      n2: trigger.heapUsedBytes,
      n3: heapAfterStopBytes,
      n4: stopMs,
      fields: { top: fitToFieldsCap(sites) },
    });
  } catch (err) {
    diag.warn(`heap sample failed (${trigger.label}): ${String(err)}`);
  } finally {
    try {
      // Disconnecting also stops V8's sampler if the stop never ran (a failed run).
      session?.disconnect();
    } catch {
      // Already closed: nothing left to release.
    }
    heapSampleState.inFlight = false;
  }
}

/** The session, or null (logged once, then off for good) when the runtime has no inspector. */
function openHeapSampleSession(
  openSession: () => DiagnosticHeapSampleSession | null,
  label: string,
): DiagnosticHeapSampleSession | null {
  let reason = "this runtime has no node:inspector Session";
  try {
    const session = openSession();
    if (session !== null) {
      return session;
    }
  } catch (err) {
    reason = String(err);
  }
  heapSampleState.unavailable = true;
  diag.info(`heap sample off (${label}): ${reason}; this process records no allocation sites`);
  return null;
}

/**
 * A connected same-thread session, or null when this runtime has no node:inspector Session.
 * Loaded through process.getBuiltinModule (the logger.ts and subsystem.ts precedent), never a
 * static import: a node built without the inspector throws ERR_INSPECTOR_NOT_AVAILABLE as the
 * module loads, which would take this module and everything importing it down.
 */
function openInspectorSession(): DiagnosticHeapSampleSession | null {
  const getBuiltinModule = (
    process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return null;
  }
  const inspector: unknown = getBuiltinModule("node:inspector/promises");
  const SessionCtor = (inspector as { Session?: unknown } | undefined)?.Session;
  if (typeof SessionCtor !== "function") {
    return null;
  }
  const session = new (SessionCtor as new () => InspectorSession)();
  session.connect();
  return session;
}

/** The CDP boundary: HeapProfiler.stopSampling answers { profile: { head, samples } }. */
function readSamplingProfile(result: unknown): { head: HeapSamplingProfileNode } {
  const head = (result as { profile?: { head?: unknown } } | null | undefined)?.profile?.head;
  if (typeof head !== "object" || head === null) {
    throw new Error("HeapProfiler.stopSampling answered without a profile");
  }
  return { head: head as HeapSamplingProfileNode };
}

/**
 * A sampling profile's allocation sites by self size, largest first, and the sampled total. A
 * frame with no app url of its own (a builtin, a `node:` internal) is tagged with the nearest app
 * frame above it, so JSON.parse in a store loader reads `parse (native) via store-<hash>.js:41`
 * and not a bare `(native)`. The same function at the same site sums across call paths.
 */
export function summarizeHeapSamplingProfile(
  profile: { head: HeapSamplingProfileNode },
  top = HEAP_SAMPLE_TOP_SITES,
): { totalBytes: number; sites: DiagnosticHeapSampleSite[] } {
  const bySite = new Map<string, DiagnosticHeapSampleSite>();
  let totalBytes = 0;
  const pending: Array<{ node: HeapSamplingProfileNode; via: string | undefined }> = [
    { node: profile.head, via: undefined },
  ];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const { node, via } = item;
    const frame = node.callFrame;
    const own = heapSampleSite(frame);
    const isApp = frame.url !== "" && !frame.url.startsWith("node:");
    if (node.selfSize > 0) {
      totalBytes += node.selfSize;
      const fn = (frame.functionName || "(anonymous)").slice(0, HEAP_SAMPLE_TEXT_MAX_CHARS);
      const site = isApp || via === undefined ? own : `${own} via ${via}`;
      const key = `${fn}\n${site}`;
      const entry = bySite.get(key);
      if (entry) {
        entry.bytes += node.selfSize;
      } else {
        bySite.set(key, { fn, site, bytes: node.selfSize });
      }
    }
    for (const child of node.children ?? []) {
      pending.push({ node: child, via: isApp ? own : via });
    }
  }
  const sites = [...bySite.values()].toSorted((a, b) => b.bytes - a.bytes).slice(0, top);
  return { totalBytes, sites };
}

/**
 * A frame's file:line with no host path in it (logging.md L4): the package path after the last
 * node_modules/, the build path after the last dist/, else the file name; `node:` urls stay as
 * they are. The line is 1-based. A frame with no url (a builtin, V8's own pseudo frames) is
 * `(native)`.
 */
function heapSampleSite(frame: HeapSamplingProfileNode["callFrame"]): string {
  if (frame.url === "") {
    return "(native)";
  }
  const url = frame.url.replaceAll("\\", "/");
  const modules = url.lastIndexOf("/node_modules/");
  const dist = url.lastIndexOf("/dist/");
  const file = url.startsWith("node:")
    ? url
    : modules >= 0
      ? url.slice(modules + "/node_modules/".length)
      : dist >= 0
        ? url.slice(dist + "/dist/".length)
        : url.slice(url.lastIndexOf("/") + 1);
  const site = frame.lineNumber >= 0 ? `${file}:${frame.lineNumber + 1}` : file;
  return site.length > HEAP_SAMPLE_TEXT_MAX_CHARS ? site.slice(-HEAP_SAMPLE_TEXT_MAX_CHARS) : site;
}

/** The leading sites that fit the writer's fields cap, so `top` is never dropped whole. */
function fitToFieldsCap(sites: readonly DiagnosticHeapSampleSite[]): DiagnosticHeapSampleSite[] {
  const top = [...sites];
  while (top.length > 0 && JSON.stringify({ top }).length > MAX_FIELDS_JSON_CHARS) {
    top.pop();
  }
  return top;
}

function formatMb(bytes: number): string {
  return `${(bytes / MB).toFixed(1)}MB`;
}
