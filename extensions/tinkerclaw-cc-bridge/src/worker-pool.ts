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

// FORK 2026-06-11 (the lag fix): normalize a think level for comparison so
// `off` / empty / undefined all collapse to `undefined` and compare EQUAL —
// that way merely toggling between equivalent "no extra thinking" states
// never triggers a spurious cold respawn. Any other value is trimmed +
// lowercased so `Think` and `think ` are the same level.
const normLevel = (l?: string): string | undefined =>
  !l || l.trim().toLowerCase() === "off" ? undefined : l.trim().toLowerCase();

/** Minimal worker surface the pool depends on (lets tests inject a fake). */
export interface PoolWorker {
  readonly sessionKey: string;
  sessionId: string | null;
  // FORK 2026-06-11: the think level the worker was SPAWNED with, if the
  // concrete worker exposes it (the test FakeWorker does). The real
  // ClaudeCodeWorker keeps its spawn params private, so the pool also tracks
  // the spawned level itself (see `spawnedThinkLevel`) and falls back to that.
  readonly thinkLevel?: string;
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
  // FORK 2026-06-11 (the lag fix): the think level each live worker was
  // SPAWNED with, keyed by sessionKey. The real ClaudeCodeWorker keeps its
  // spawn params private, so `existing.thinkLevel` is `undefined` in
  // production; this map is the authoritative record we compare against.
  private spawnedThinkLevel = new Map<string, string | undefined>();
  // FORK 2026-06-11 (the lag fix): when a think-level change arrives mid-turn
  // we must NOT kill the busy worker; we record the pending change here so the
  // caller can apply it (e.g. surface a notice / force a respawn next turn)
  // via `takeThinkLevelPending`. running = level the busy worker is using.
  private lastThinkLevelPending = new Map<string, { requested?: string; running?: string }>();
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
      // FORK 2026-06-11 (the lag fix): a warm worker bakes its think level into
      // MAX_THINKING_TOKENS at spawn time, so a per-session thinkLevel change
      // is INVISIBLE until the subprocess is respawned. Detect the change and
      // act on it here instead of silently handing back the stale worker.
      // The worker's own spawn params are private (existing.thinkLevel is
      // undefined for the real worker), so prefer our recorded spawned level.
      const existingLevel = existing.thinkLevel ?? this.spawnedThinkLevel.get(params.sessionKey);
      const levelChanged = normLevel(existingLevel) !== normLevel(params.thinkLevel);
      if (levelChanged && !existing.isBusy()) {
        // Safe to respawn: idle worker. Evict the warm cache and FALL THROUGH
        // to the create path below, which re-derives resumeSessionId from the
        // (still-live or persisted) sessionId so `--resume` re-attaches the
        // SAME claude conversation — history is preserved, only the warm
        // subprocess is lost, and the next turn spawns with the new
        // MAX_THINKING_TOKENS. Do NOT return here.
        this.lastThinkLevelPending.delete(params.sessionKey);
        this.evict(params.sessionKey, existing);
      } else if (levelChanged && existing.isBusy()) {
        // NEVER kill a worker mid-turn. Record the pending change so the
        // caller can apply it (the next idle getOrCreate will respawn).
        this.lastThinkLevelPending.set(params.sessionKey, {
          requested: params.thinkLevel,
          running: existingLevel,
        });
        this.lastUsedAt.set(params.sessionKey, now);
        this.sweep(now, params.sessionKey);
        return existing as ClaudeCodeWorker;
      } else {
        // No change — hand back the warm worker as before.
        this.lastThinkLevelPending.delete(params.sessionKey);
        this.lastUsedAt.set(params.sessionKey, now);
        this.sweep(now, params.sessionKey);
        return existing as ClaudeCodeWorker;
      }
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
    // FORK 2026-06-11 (the lag fix): record the think level this worker was
    // spawned with so a later turn can detect a change (the real worker keeps
    // its spawn params private).
    this.spawnedThinkLevel.set(params.sessionKey, params.thinkLevel);
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
    // FORK 2026-06-11 (the lag fix): drop the recorded spawned level + any
    // pending change for an evicted key so it can't go stale.
    this.spawnedThinkLevel.delete(key);
    this.lastThinkLevelPending.delete(key);
  }

  get(sessionKey: string): ClaudeCodeWorker | undefined {
    return this.workers.get(sessionKey) as ClaudeCodeWorker | undefined;
  }

  /**
   * FORK 2026-06-11 (the lag fix): read-once the think-level change that
   * arrived while this session's worker was mid-turn (so it couldn't be
   * respawned immediately). Returns `{ requested, running }` once, then
   * clears it — the caller applies the change (e.g. forces a respawn next
   * idle turn / surfaces a notice). Returns undefined if no change is pending.
   */
  takeThinkLevelPending(sessionKey: string): { requested?: string; running?: string } | undefined {
    const v = this.lastThinkLevelPending.get(sessionKey);
    if (v) {
      this.lastThinkLevelPending.delete(sessionKey);
    }
    return v;
  }

  killAll(): void {
    for (const worker of this.workers.values()) {
      worker.kill("SIGTERM");
    }
    this.workers.clear();
    this.lastUsedAt.clear();
    this.spawnedThinkLevel.clear();
    this.lastThinkLevelPending.clear();
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
