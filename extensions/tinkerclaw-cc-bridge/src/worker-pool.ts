/**
 * FORK: tinkerclaw-cc-bridge — session → worker registry.
 *
 * One claude subprocess per OpenClaw session. A worker stays alive between
 * turns (so the next turn resumes a warm claude-cli conversation), but the
 * pool is BOUNDED: idle non-busy workers past `idleTtlMs` are SIGTERMed and
 * the pool is hard-capped at `maxWorkers` (LRU). If a worker is killed/dies,
 * we respawn it with `--resume <sessionId>` on the next turn (see
 * Worker.start).
 *
 * FORK (2026-04-22): sessionKey → sessionId mapping is persisted to
 * `~/.openclaw/cc-bridge/session-map.json` so a gateway restart (or a pool
 * eviction) doesn't lose claude CLI's conversation state. Previously the
 * in-memory map reset on every restart and Jarvis woke up amnesic even
 * though the transcript .jsonl files were sitting right there on disk.
 *
 * FORK (2026-05-16): bounded pool. The original pool kept one claude
 * subprocess per cc-bridge sessionKey ALIVE FOR THE GATEWAY'S LIFETIME with
 * no eviction. That is fine for a handful of long-lived conversational
 * sessions, but a caller that mints a *unique* sessionKey per work item
 * (the people-profiles cron: one key per profile, ~1014 of them) turned
 * "keep warm forever" into an unbounded process leak — 53 orphaned `claude`
 * procs blocked in ep_poll, oldest 7+ days, observed 2026-05-16. The pool
 * now sweeps on every getOrCreate. sessionId stays in session-map.json so a
 * later turn for an evicted key still resumes the same claude-cli thread.
 * See bible lifecycles.md L2.
 */
import { getLatestResumeSessionIdByOpenclawSessionId, getResumeSessionId } from "./session-map.js";
import { ClaudeCodeWorker, type WorkerSpawnParams } from "./worker.js";

/** Minimal worker surface the pool depends on (lets tests inject a fake). */
export interface PoolWorker {
  readonly sessionKey: string;
  sessionId: string | null;
  isAlive(): boolean;
  isBusy(): boolean;
  kill(signal?: NodeJS.Signals): void;
  on(event: "exit", listener: (...args: unknown[]) => void): unknown;
}

export interface SessionWorkerPoolOptions {
  /** Worker factory — defaults to spawning a real ClaudeCodeWorker. */
  createWorker?: (params: WorkerSpawnParams) => PoolWorker;
  /** Hard ceiling on concurrently-pooled workers (LRU-evicted past this). */
  maxWorkers?: number;
  /** A non-busy worker idle longer than this is reaped on the next sweep. */
  idleTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

// idleTtlMs must comfortably exceed the longest legitimate turn (observed
// people-profiles turns up to ~620s); `isBusy()` is the real guard, this is
// the backstop for a worker that finished but will never be reused.
const DEFAULT_MAX_WORKERS = 32;
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;

export class SessionWorkerPool {
  private workers = new Map<string, PoolWorker>();
  private lastUsedAt = new Map<string, number>();
  private readonly createWorker: (params: WorkerSpawnParams) => PoolWorker;
  private readonly maxWorkers: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(options: SessionWorkerPoolOptions = {}) {
    this.createWorker = options.createWorker ?? ((params) => new ClaudeCodeWorker(params));
    this.maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  getOrCreate(params: WorkerSpawnParams): ClaudeCodeWorker {
    const now = this.now();
    const existing = this.workers.get(params.sessionKey);
    if (existing && existing.isAlive()) {
      this.lastUsedAt.set(params.sessionKey, now);
      this.sweep(now, params.sessionKey);
      return existing as ClaudeCodeWorker;
    }
    if (existing && existing.sessionId && !params.resumeSessionId) {
      params = { ...params, resumeSessionId: existing.sessionId };
    }
    // FORK (2026-04-22): no live worker, no in-memory sessionId → check
    // persisted session-map. That's the gateway-restart / post-eviction path.
    //
    // FORK 2026-05-10: lookup priority is REORDERED. The openclaw agent
    // sessionId is canonical (one openclaw session = one conversation
    // thread, /new creates a new sessionId), so when it's available we
    // prefer the entry indexed by openclaw sessionId — that gives the LATEST
    // claude-cli session for this agent regardless of whether the cc-bridge
    // sessionKey hash drifted (e.g. across an interrupted-then-resumed turn
    // where the [System] continue dispatch shifts the systemPrompt prefix).
    //
    // The old sessionKey-only lookup is the fallback when openclawSessionId
    // isn't supplied (legacy callers, pre-2026-05-10 entries).
    if (!params.resumeSessionId) {
      let persisted: string | undefined;
      if (params.openclawSessionId) {
        persisted = getLatestResumeSessionIdByOpenclawSessionId(params.openclawSessionId);
      }
      if (!persisted) {
        persisted = getResumeSessionId(params.sessionKey);
      }
      if (persisted) {
        params = { ...params, resumeSessionId: persisted };
      }
    }
    const worker = this.createWorker(params);
    worker.on("exit", () => {
      // Keep entry around so its sessionId can be used for --resume next time.
      // Explicit delete only on gateway shutdown or pool eviction (sweep).
    });
    this.workers.set(params.sessionKey, worker);
    this.lastUsedAt.set(params.sessionKey, now);
    this.sweep(now, params.sessionKey);
    return worker as ClaudeCodeWorker;
  }

  /**
   * Reap idle non-busy workers, then enforce the LRU cap. Runs on every
   * getOrCreate — no timer needed, since pressure only grows when new
   * workers are created. The worker for `exemptKey` (the one we are about to
   * hand back) and any worker mid-turn (`isBusy()`) are never evicted; their
   * sessionId remains in session-map.json for a future `--resume`.
   */
  private sweep(now: number, exemptKey: string): void {
    for (const [key, worker] of this.workers) {
      if (key === exemptKey) {
        continue;
      }
      const idleMs = now - (this.lastUsedAt.get(key) ?? now);
      if (idleMs > this.idleTtlMs && !worker.isBusy()) {
        this.evict(key, worker);
      }
    }
    if (this.workers.size <= this.maxWorkers) {
      return;
    }
    const oldestFirst = [...this.workers.entries()].sort(
      (a, b) => (this.lastUsedAt.get(a[0]) ?? 0) - (this.lastUsedAt.get(b[0]) ?? 0),
    );
    for (const [key, worker] of oldestFirst) {
      if (this.workers.size <= this.maxWorkers) {
        break;
      }
      if (key === exemptKey || worker.isBusy()) {
        continue;
      }
      this.evict(key, worker);
    }
  }

  private evict(key: string, worker: PoolWorker): void {
    worker.kill("SIGTERM");
    this.workers.delete(key);
    this.lastUsedAt.delete(key);
  }

  get(sessionKey: string): ClaudeCodeWorker | undefined {
    return this.workers.get(sessionKey) as ClaudeCodeWorker | undefined;
  }

  killAll(): void {
    for (const worker of this.workers.values()) {
      worker.kill("SIGTERM");
    }
    this.workers.clear();
    this.lastUsedAt.clear();
  }
}

// Single gateway-wide pool instance.
let singleton: SessionWorkerPool | null = null;
export function getPool(): SessionWorkerPool {
  if (!singleton) {
    singleton = new SessionWorkerPool();
    process.on("exit", () => singleton?.killAll());
    process.on("SIGTERM", () => singleton?.killAll());
    process.on("SIGINT", () => singleton?.killAll());
  }
  return singleton;
}
