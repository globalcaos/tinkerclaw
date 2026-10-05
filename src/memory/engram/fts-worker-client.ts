/**
 * FORK 2026-09-23 (plan task 16) — the main-thread half of the off-thread FTS.
 *
 * One long-lived worker (fts-worker.ts), spawned on first use and shared by every store. A
 * request carries the query and a description of the caller's snapshot — its length and a
 * fingerprint, never the events — and the answer is ranked (position, id, score) triples, mapped
 * back onto the caller's OWN event objects. The main thread's share of a search is one
 * `readAll()` copy, one fingerprint pass over ids, and at most `topN` lookups.
 *
 * FAILURE CONTRACT. `search` either resolves with exactly what `ftsSearch` would have returned
 * for that snapshot, or rejects with an `FtsWorkerError` whose `kind` says why; the caller then
 * searches in-thread. A spawn failure, a crash, an `error` event or a request older than
 * FTS_WORKER_TIMEOUT_MS tears the worker down (rejecting everything in flight) and holds off the
 * next spawn for FTS_WORKER_RESPAWN_BACKOFF_MS, so a crash-looping worker is spawned at most once
 * a minute.
 *
 * PROCESS LIFETIME. The worker is unref'd while idle, so it never holds the process open; it is
 * ref'd only while a request is in flight, because a promise whose only pending work is an
 * unref'd worker is simply abandoned when the loop drains (a CLI or script would exit without
 * its answer). The request timers stay unref'd.
 *
 * OBSERVABILITY (FORK 2026-09-25, TINKER_UI_DESIGN_BIBLE/logging.md §4.8, §4.9). Every spawn and
 * teardown writes `worker.spawn` / `worker.exit` (worker_type fts_thread). `threadStats` asks the
 * running worker for its OWN isolate's heap over a `stats` message: soft-timed, so a probe queued
 * behind a long scan fails only itself and never tears the worker down, and it never spawns a
 * worker that is not running (sampling must not create the thing it samples). The process-wide
 * path writes one `fts.request.minute` rollup per window and one `fts.fallback` row per fallback,
 * unthrottled — only the journal line is rate-limited.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { emitEvent } from "../../infra/events/emit.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import {
  fingerprintEvents,
  type FtsWorkerHit,
  type FtsWorkerRequest,
  type FtsWorkerResponse,
} from "./fts-worker-core.js";
import { ftsQueryHasTerms, type SearchFilters, type SearchResult } from "./search-index.js";

/**
 * A request not answered within this long rejects, and the worker is torn down. FORK 2026-09-24
 * (ruling R34): was 30 s — little headroom for a cold first load of a ~70M-char store on a
 * CPU-starved host, and a timeout both tears the worker down and runs that refresh's scan on the
 * main thread, the cost the worker exists to remove.
 */
export const FTS_WORKER_TIMEOUT_MS = 120_000;
/** After a teardown, no new worker is spawned for this long. */
export const FTS_WORKER_RESPAWN_BACKOFF_MS = 60_000;
/**
 * FORK 2026-09-24 (ruling R35) — the worker's own V8 old-generation cap. Without one it is a
 * second heap as large as the process allows (measured +170 MB steady, +420 MB on a cold 76 MB
 * load) on a gateway whose main heap was already exhausted once. Past the cap V8 ends the WORKER
 * (`ERR_WORKER_OUT_OF_MEMORY`), which the client handles like any crash: the request falls back
 * in-thread and the respawn is held off.
 */
export const FTS_WORKER_MAX_OLD_GENERATION_MB = 2048;

// ─── the `stats` probe (FORK 2026-09-25, logging.md §4.9) ───────────────────

/** A stats probe the worker has not answered within this long reads as "unavailable". */
export const FTS_WORKER_STATS_TIMEOUT_MS = 5_000;

/** Answered by fts-worker.ts from its own isolate; it queues behind a running search. */
export interface FtsWorkerStatsRequest {
  readonly id: number;
  readonly type: "stats";
}

export interface FtsWorkerIsolateStats {
  readonly usedHeapBytes: number;
  readonly totalHeapBytes: number;
  readonly heapLimitBytes: number;
  readonly externalBytes: number;
  /** This thread's own CPU (process.threadCpuUsage), user + system; null on a Node without it. */
  readonly cpuUsec: number | null;
  /** performance.now() inside the worker: milliseconds since the thread started. */
  readonly uptimeMs: number;
}

export interface FtsWorkerStatsResponse {
  readonly id: number;
  readonly ok: true;
  readonly type: "stats";
  readonly isolate: FtsWorkerIsolateStats;
}

/** The running worker as the worker-resources sampler charts it (worker_type fts_thread). */
export interface FtsWorkerThreadStats {
  readonly workerId: string;
  readonly spawnedAtMs: number;
  readonly requestsServed: number;
  /** null when the probe got no answer in time (a search ahead of it in the queue). */
  readonly isolate: FtsWorkerIsolateStats | null;
  /**
   * The isolate's committed heap plus its external memory, at this probe; null with `isolate`.
   * The thread shares the process RSS, so this is the only memory that is its own.
   */
  readonly memBytes: number | null;
  /** The largest `memBytes` any probe of this worker has seen. */
  readonly peakBytes: number | null;
}

export type FtsWorkerFailureKind =
  /** Could not start a worker at all (e.g. its entry file is missing). */
  | "spawn"
  /** The worker exited on its own. */
  | "crash"
  /** The worker emitted `error` (an uncaught exception in it). */
  | "error"
  /** No answer within the timeout. */
  | "timeout"
  /** The file's events are not the caller's snapshot, so the worker cannot answer for it. */
  | "view"
  /** The worker ran the request and it threw (e.g. a line that does not parse). */
  | "request"
  /** Inside the respawn backoff after an earlier teardown: nothing was attempted. */
  | "backoff"
  /** `shutdown()` was called while the request was in flight. */
  | "shutdown";

export class FtsWorkerError extends Error {
  readonly kind: FtsWorkerFailureKind;

  constructor(kind: FtsWorkerFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FtsWorkerError";
    this.kind = kind;
  }
}

export interface FtsWorkerClient {
  /** `ftsSearch(store, query, topN, filters)`, computed in the worker. See the failure contract. */
  search(
    store: EventStore,
    query: string,
    topN: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]>;
  /** Terminate the worker (no backoff: the next `search` may spawn a new one). */
  shutdown(): Promise<void>;
}

/**
 * What createFtsWorkerClient returns. A separate interface, so a test double that only searches
 * still satisfies FtsWorkerClient; readFtsWorkerThreadStats reads such a double as "no worker".
 */
export interface InspectableFtsWorkerClient extends FtsWorkerClient {
  /**
   * The running worker's isolate statistics, or null when no worker runs — a probe never starts
   * one. Never rejects. A probe that times out resolves with `isolate: null` and leaves the
   * worker running.
   */
  threadStats(timeoutMs?: number): Promise<FtsWorkerThreadStats | null>;
}

export interface FtsWorkerClientOptions {
  /** Test seam: how a worker is started. Defaults to the fts-worker entry beside this module. */
  spawn?: () => Worker;
  timeoutMs?: number;
  respawnBackoffMs?: number;
  /** Test seam: the clock the respawn backoff is measured on. */
  now?: () => number;
}

/** How many directories above a bundled module are searched for the worker entry. */
const DIST_SEARCH_ANCESTORS = 3;

/**
 * The worker entry for a module at `moduleUrl`.
 *
 * - TypeScript source (vitest, or a `--import tsx` dev run): the sibling `fts-worker.ts`.
 * - The bundled dist/: tsdown.config.ts emits the worker as the stable entry
 *   `memory/engram/fts-worker.js`. This module's code does NOT land beside it: the build puts it in
 *   a shared chunk at the dist root (`fts-worker-client-<hash>.js`, re-exported by a facade at
 *   memory/engram/fts-worker-client.js). So `<dir>/memory/engram/fts-worker.js` is looked for in
 *   this module's own directory and up to DIST_SEARCH_ANCESTORS above it, after the sibling
 *   `fts-worker.js` that a module emitted beside the worker would find.
 *
 * Throws when there is none — the client reports that as a spawn failure.
 */
export function resolveFtsWorkerEntry(moduleUrl: string): { url: URL; typescript: boolean } {
  const self = new URL(moduleUrl);
  if (self.pathname.endsWith(".ts")) {
    return { url: new URL("./fts-worker.ts", self), typescript: true };
  }
  const candidates = [new URL("./fts-worker.js", self)];
  let dir = new URL("./", self);
  for (let i = 0; i <= DIST_SEARCH_ANCESTORS; i++) {
    candidates.push(new URL("memory/engram/fts-worker.js", dir));
    dir = new URL("../", dir);
  }
  const found = candidates.find((url) => existsSync(url));
  if (!found) {
    throw new Error(`fts worker entry not found beside ${moduleUrl}`);
  }
  return { url: found, typescript: false };
}

type ConstructWorker = (entry: URL | string, options: WorkerOptions) => Worker;
const constructWorker: ConstructWorker = (entry, options) => new Worker(entry, options);

/** Start the fts-worker entry with its resource limits. `construct` is the test seam. */
export function spawnFtsWorker(construct: ConstructWorker = constructWorker): Worker {
  const entry = resolveFtsWorkerEntry(import.meta.url);
  const resourceLimits = { maxOldGenerationSizeMb: FTS_WORKER_MAX_OLD_GENERATION_MB };
  if (!entry.typescript) {
    return construct(entry.url, { resourceLimits });
  }
  // Node's own type stripping neither maps `./x.js` specifiers onto `./x.ts` nor handles
  // parameter properties, so a source worker registers tsx before importing its entry.
  const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
  const boot =
    `import(${JSON.stringify(tsxApi)})` +
    `.then((tsx) => { tsx.register(); return import(${JSON.stringify(entry.url.href)}); });`;
  return construct(boot, { eval: true, resourceLimits });
}

type OkResponse = Extract<FtsWorkerResponse, { ok: true }>;

interface Pending {
  resolve: (response: OkResponse) => void;
  reject: (err: FtsWorkerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StatsPending {
  resolve: (isolate: FtsWorkerIsolateStats | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The running worker's identity and life, for its worker.* rows (logging.md §4.9). */
interface WorkerLife {
  readonly workerId: string;
  readonly spawnedAtMs: number;
  /** Search requests the worker answered (ok or not): the exit row's turns_served. */
  served: number;
  lastMemBytes: number | null;
  peakBytes: number | null;
}

const ignore = (): void => {};

/** Distinguishes worker ids spawned in the same millisecond (several clients, in tests). */
let ftsSpawnSeq = 0;

function isStatsResponse(
  response: FtsWorkerResponse | FtsWorkerStatsResponse,
): response is FtsWorkerStatsResponse {
  return (response as { type?: unknown }).type === "stats";
}

/** worker.exit's exit_class for a teardown (logging.md §4.9's closed set). */
function ftsExitClass(kind: FtsWorkerFailureKind): string {
  switch (kind) {
    case "shutdown":
      return "clean";
    case "timeout":
      return "killed.timeout";
    default:
      // crash, error, spawn, view, request, backoff: the worker died or never answered.
      return "crash";
  }
}

export function createFtsWorkerClient(
  options: FtsWorkerClientOptions = {},
): InspectableFtsWorkerClient {
  const spawn = options.spawn ?? (() => spawnFtsWorker());
  const timeoutMs = options.timeoutMs ?? FTS_WORKER_TIMEOUT_MS;
  const respawnBackoffMs = options.respawnBackoffMs ?? FTS_WORKER_RESPAWN_BACKOFF_MS;
  const now = options.now ?? Date.now;

  let worker: Worker | undefined;
  /** Removes the listeners `ensureWorker` put on `worker`. */
  let detach: () => void = ignore;
  let respawnNotBefore = 0;
  let nextRequestId = 1;
  const pending = new Map<number, Pending>();
  /** Stats probes in flight. Soft-timed (see threadStats): they never tear the worker down. */
  const statsPending = new Map<number, StatsPending>();
  /** The running worker's life, for its worker.* rows; null while none runs. */
  let life: WorkerLife | null = null;

  /** Writes the running worker's `worker.exit` row (logging.md §4.9), once. */
  function noteExit(kind: FtsWorkerFailureKind, exitCode: number | null): void {
    const ended = life;
    life = null;
    if (ended === null) {
      return;
    }
    const nowMs = Date.now();
    emitEvent("worker.exit", {
      tsMs: nowMs,
      workerId: ended.workerId,
      label: ftsExitClass(kind),
      n1: exitCode,
      n2: Math.max(0, nowMs - ended.spawnedAtMs),
      n3: ended.lastMemBytes,
      n4: ended.peakBytes,
      fields: { turns_served: ended.served },
    });
  }

  /** Detach `w` for good and reject everything in flight. No-op if `w` is already gone. */
  function discard(
    w: Worker,
    err: FtsWorkerError,
    backoff: boolean,
    exitCode: number | null = null,
  ): Promise<void> {
    if (worker !== w) {
      return Promise.resolve();
    }
    worker = undefined;
    if (backoff) {
      respawnNotBefore = now() + respawnBackoffMs;
    }
    detach();
    detach = ignore;
    // A late `error` with no listener would be thrown as an uncaught exception.
    w.on("error", ignore);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    for (const probe of statsPending.values()) {
      clearTimeout(probe.timer);
      probe.resolve(null);
    }
    statsPending.clear();
    noteExit(err.kind, exitCode);
    return w.terminate().then(ignore, ignore);
  }

  function onResponse(response: FtsWorkerResponse | FtsWorkerStatsResponse): void {
    if (isStatsResponse(response)) {
      const probe = statsPending.get(response.id);
      if (probe === undefined) {
        return; // it already timed out: a late answer is ignored
      }
      statsPending.delete(response.id);
      clearTimeout(probe.timer);
      probe.resolve(response.isolate);
      return;
    }
    const p = pending.get(response.id);
    if (!p) {
      return; // its request already failed
    }
    pending.delete(response.id);
    clearTimeout(p.timer);
    if (pending.size === 0) {
      worker?.unref();
    }
    if (life !== null) {
      life.served += 1;
    }
    if (response.ok) {
      p.resolve(response);
    } else {
      p.reject(new FtsWorkerError(response.kind, response.message));
    }
  }

  function ensureWorker(): Worker {
    if (worker) {
      return worker;
    }
    if (now() < respawnNotBefore) {
      throw new FtsWorkerError(
        "backoff",
        `fts worker respawn held off for another ${respawnNotBefore - now()} ms`,
      );
    }
    let w: Worker;
    try {
      w = spawn();
    } catch (err) {
      respawnNotBefore = now() + respawnBackoffMs;
      throw new FtsWorkerError("spawn", `fts worker failed to start: ${String(err)}`, {
        cause: err,
      });
    }
    const onError = (err: unknown): void => {
      void discard(
        w,
        new FtsWorkerError("error", `fts worker error: ${String(err)}`, { cause: err }),
        true,
      );
    };
    const onExit = (code: number): void => {
      void discard(
        w,
        new FtsWorkerError("crash", `fts worker exited with code ${code}`),
        true,
        code,
      );
    };
    w.on("message", onResponse);
    w.on("error", onError);
    w.on("exit", onExit);
    w.unref();
    worker = w;
    detach = () => {
      w.off("message", onResponse);
      w.off("error", onError);
      w.off("exit", onExit);
    };
    const spawnedAtMs = Date.now();
    ftsSpawnSeq += 1;
    life = {
      workerId: `fts-${process.pid}-${spawnedAtMs.toString(36)}-${ftsSpawnSeq}`,
      spawnedAtMs,
      served: 0,
      lastMemBytes: null,
      peakBytes: null,
    };
    emitEvent("worker.spawn", {
      tsMs: spawnedAtMs,
      workerId: life.workerId,
      label: "fts_thread",
      fields: { resumed: false },
    });
    return w;
  }

  function post(request: FtsWorkerRequest): Promise<OkResponse> {
    const w = ensureWorker();
    return new Promise<OkResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        void discard(
          w,
          new FtsWorkerError("timeout", `fts worker gave no answer within ${timeoutMs} ms`),
          true,
        );
      }, timeoutMs);
      timer.unref?.();
      pending.set(request.id, { resolve, reject, timer });
      if (pending.size === 1) {
        w.ref();
      }
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads Worker, not a Window: its postMessage takes no targetOrigin.
        w.postMessage(request);
      } catch (err) {
        pending.delete(request.id);
        clearTimeout(timer);
        if (pending.size === 0) {
          w.unref();
        }
        reject(new FtsWorkerError("request", `fts request not sendable: ${String(err)}`));
      }
    });
  }

  function toResults(snapshot: readonly MemoryEvent[], hits: FtsWorkerHit[]): SearchResult[] {
    return hits.map((hit) => {
      const event = snapshot[hit.pos];
      if (event === undefined || event.id !== hit.id) {
        throw new FtsWorkerError("view", `worker hit #${hit.pos} is not the snapshot's event`);
      }
      return { event, score: hit.score, matchType: "fts" as const };
    });
  }

  function threadStats(
    probeTimeoutMs: number = FTS_WORKER_STATS_TIMEOUT_MS,
  ): Promise<FtsWorkerThreadStats | null> {
    const w = worker;
    const current = life;
    if (w === undefined || current === null) {
      return Promise.resolve(null); // no worker runs, and a probe never starts one
    }
    const id = nextRequestId++;
    const answered = new Promise<FtsWorkerIsolateStats | null>((resolve) => {
      // SOFT: the worker answers serially, so a probe queued behind a cold corpus load is late,
      // not evidence of a dead worker. Only the probe gives up; the search requests keep their
      // own teardown timeout, and a late answer is ignored by onResponse.
      const timer = setTimeout(() => {
        statsPending.delete(id);
        resolve(null);
      }, probeTimeoutMs);
      timer.unref?.();
      statsPending.set(id, { resolve, timer });
      const request: FtsWorkerStatsRequest = { id, type: "stats" };
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads Worker, not a Window: its postMessage takes no targetOrigin.
        w.postMessage(request);
      } catch {
        statsPending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
    return answered.then((isolate) => {
      if (life !== current) {
        return null; // torn down while the probe was out: that worker is gone
      }
      const memBytes = isolate === null ? null : isolate.totalHeapBytes + isolate.externalBytes;
      if (memBytes !== null) {
        current.lastMemBytes = memBytes;
        current.peakBytes = Math.max(current.peakBytes ?? 0, memBytes);
      }
      return {
        workerId: current.workerId,
        spawnedAtMs: current.spawnedAtMs,
        requestsServed: current.served,
        isolate,
        memBytes,
        peakBytes: current.peakBytes,
      };
    });
  }

  return {
    async search(store, query, topN, filters) {
      if (!ftsQueryHasTerms(query)) {
        return []; // what ftsSearch returns, without reading the store
      }
      const snapshot = store.readAll();
      const response = await post({
        id: nextRequestId++,
        filePath: store.filePath,
        query,
        topN,
        filters,
        count: snapshot.length,
        fingerprint: fingerprintEvents(snapshot),
      });
      return toResults(snapshot, response.hits);
    },

    shutdown() {
      return worker
        ? discard(worker, new FtsWorkerError("shutdown", "fts worker shut down"), false)
        : Promise.resolve();
    },

    threadStats,
  };
}

// ─── the process-wide worker and its in-thread fallback ─────────────────────

/** Set to `0` to keep every pack FTS on the main thread (the in-thread chunked scan). */
export const FTS_WORKER_ENV = "OPENCLAW_TOTAL_RECALL_FTS_WORKER";

export function ftsWorkerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[FTS_WORKER_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

const log = createSubsystemLogger("engram-fts-worker");
const defaultLog = (message: string): void => log.info(message);

/**
 * FORK 2026-09-24 (final whole-branch review item 5, ruling R34) — EVERY fallback to the in-thread
 * scan is logged, at most one line per failure kind per this long, with running counters. It used
 * to be one warning per kind per process life, so a worker that kept failing moved the whole FTS
 * back onto the main thread with nothing in the log after the first line.
 */
export const FTS_FALLBACK_LOG_INTERVAL_MS = 60_000;

let sharedClient: FtsWorkerClient | undefined;
let fallbackLog = defaultLog;
let fallbacks = 0;
const fallbacksByKind = new Map<FtsWorkerFailureKind, number>();
const lastLoggedAt = new Map<FtsWorkerFailureKind, number>();

/**
 * FORK 2026-09-25 (logging.md §4.8) — `fts.request.minute`: the process-wide path's calls,
 * aggregated in memory (L3: a high-rate fact is one rollup per window, never a row per call).
 */
export const FTS_REQUEST_ROLLUP_WINDOW_MS = 60_000;

/**
 * One window's counts. A call is counted in the window it COMPLETES in — its request, its worker
 * time and its fallback together — so a search that spans a flush can never be split across two
 * rows, nor leave a window holding time with no request.
 */
interface FtsRequestWindow {
  readonly startMs: number;
  /** Calls that went to the worker (not the kill-switched ones). */
  requests: number;
  /** Wall time of the calls the worker answered. */
  workerMs: number;
  /** Calls that fell back to the in-thread scan. */
  fallbacks: number;
  /** Calls the kill switch kept in-thread. */
  disabled: number;
}

let requestWindow: FtsRequestWindow | null = null;
let requestWindowTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Where the current window began: when the timer started, then every flush. Windows are the
 * timer's 60 s slices, so a row stamped at its start always covers a whole window (the last one
 * before shutdown excepted) — never "from the first call to the next tick".
 */
let requestWindowStartMs = 0;

function currentRequestWindow(): FtsRequestWindow {
  if (requestWindowTimer === null) {
    requestWindowStartMs = Date.now();
    requestWindowTimer = setInterval(flushFtsRequestRollup, FTS_REQUEST_ROLLUP_WINDOW_MS);
    requestWindowTimer.unref?.();
  }
  requestWindow ??= {
    startMs: requestWindowStartMs,
    requests: 0,
    workerMs: 0,
    fallbacks: 0,
    disabled: 0,
  };
  return requestWindow;
}

function stopRequestWindowTimer(): void {
  if (requestWindowTimer !== null) {
    clearInterval(requestWindowTimer);
    requestWindowTimer = null;
  }
}

/**
 * Writes the current window as one `fts.request.minute` row, stamped at the START of its window
 * (logging.md §4, Kinds), and starts the next. A window with no call writes nothing. The 60 s timer
 * and shutdown call it.
 */
export function flushFtsRequestRollup(): void {
  const ended = requestWindow;
  requestWindow = null;
  requestWindowStartMs = Date.now();
  if (ended === null || ended.requests + ended.disabled === 0) {
    return;
  }
  emitEvent("fts.request.minute", {
    tsMs: ended.startMs,
    n1: ended.requests,
    n2: Math.round(ended.workerMs),
    n3: ended.fallbacks,
    n4: ended.disabled,
  });
}

function noteFallback(kind: FtsWorkerFailureKind, err: unknown): void {
  // logging.md §4.8: every fallback is a row, unthrottled — the rate limit below is the journal's.
  emitEvent("fts.fallback", { label: kind });
  fallbacks++;
  const ofKind = (fallbacksByKind.get(kind) ?? 0) + 1;
  fallbacksByKind.set(kind, ofKind);
  const now = Date.now();
  const last = lastLoggedAt.get(kind);
  if (last !== undefined && now - last < FTS_FALLBACK_LOG_INTERVAL_MS) {
    return;
  }
  lastLoggedAt.set(kind, now);
  fallbackLog(
    `FTS worker ${kind} failure, searching on the main thread instead ` +
      `(fallbacks=${fallbacks} ${kind}=${ofKind}; at most one line per kind per minute): ` +
      String(err).slice(0, 300),
  );
}

/**
 * `ftsSearch(store, query, topN, filters)` from the process-wide worker, or `undefined` when the
 * caller must search in-thread instead: the kill switch is set, or the worker could not answer.
 * Never rejects.
 */
export async function ftsSearchOffThread(
  store: EventStore,
  query: string,
  topN: number,
  filters?: SearchFilters,
): Promise<SearchResult[] | undefined> {
  if (ftsWorkerDisabled()) {
    currentRequestWindow().disabled += 1;
    return undefined;
  }
  const client = (sharedClient ??= createFtsWorkerClient());
  const startedAt = performance.now();
  try {
    const results = await client.search(store, query, topN, filters);
    const counts = currentRequestWindow();
    counts.requests += 1;
    counts.workerMs += performance.now() - startedAt;
    return results;
  } catch (err) {
    const counts = currentRequestWindow();
    counts.requests += 1;
    counts.fallbacks += 1;
    // Anything that is not an FtsWorkerError came from this thread's half of the request.
    noteFallback(err instanceof FtsWorkerError ? err.kind : "request", err);
    return undefined;
  }
}

/** Terminate the process-wide worker, if one is running (gateway shutdown). */
export function shutdownFtsWorker(): Promise<void> {
  flushFtsRequestRollup();
  stopRequestWindowTimer();
  return sharedClient ? sharedClient.shutdown() : Promise.resolve();
}

function isInspectable(client: FtsWorkerClient): client is InspectableFtsWorkerClient {
  return typeof (client as Partial<InspectableFtsWorkerClient>).threadStats === "function";
}

/**
 * FORK 2026-09-25 (logging.md §4.9) — the process-wide worker's isolate statistics for the
 * worker-resources sampler (src/infra/events/samplers/worker-resources.ts), or null when no worker
 * runs. Never spawns one: sampling must not create the thing it samples. A test double installed
 * through setFtsWorkerForTest has no thread, so it reads as "no worker".
 */
export function readFtsWorkerThreadStats(
  timeoutMs: number = FTS_WORKER_STATS_TIMEOUT_MS,
): Promise<FtsWorkerThreadStats | null> {
  const client = sharedClient;
  if (client === undefined || !isInspectable(client)) {
    return Promise.resolve(null);
  }
  return client.threadStats(timeoutMs);
}

/**
 * Test seam: replace the process-wide client (undefined = start a real one on next use) and the
 * fallback log sink, and reset the fallback counters and rate limit.
 */
export function setFtsWorkerForTest(
  overrides: { client?: FtsWorkerClient; log?: (message: string) => void } = {},
): void {
  sharedClient = overrides.client;
  fallbackLog = overrides.log ?? defaultLog;
  fallbacks = 0;
  fallbacksByKind.clear();
  lastLoggedAt.clear();
  requestWindow = null;
  stopRequestWindowTimer();
}
