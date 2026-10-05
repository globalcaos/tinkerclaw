/**
 * FORK: tinkerclaw-tinker-bridge — session → worker registry.
 *
 * One claude subprocess per OpenClaw session. A worker stays alive between
 * turns (so the next turn resumes a warm claude-cli conversation), but the
 * pool is BOUNDED: idle non-busy workers past `idleTtlMs` are SIGTERMed and
 * the pool is hard-capped at `maxWorkers` (LRU). If a worker is killed/dies,
 * we respawn it with `--resume <sessionId>` on the next turn (see
 * Worker.start).
 *
 * FORK (2026-04-22): sessionKey → sessionId mapping is persisted to
 * `~/.openclaw/tinker-bridge/session-map.json` so a gateway restart (or a pool
 * eviction) doesn't lose claude CLI's conversation state. Previously the
 * in-memory map reset on every restart and Jarvis woke up amnesic even
 * though the transcript .jsonl files were sitting right there on disk.
 *
 * FORK (2026-05-16): bounded pool. The original pool kept one claude
 * subprocess per tinker-bridge sessionKey ALIVE FOR THE GATEWAY'S LIFETIME with
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
  /**
   * FORK 2026-10-01: when the child last printed a line (ms, the pool's clock). A child can keep
   * working after its turn ends (a background Workflow, a turn the gateway is not tracking); the
   * sweep must not take that for idle. Optional so a test fake without it behaves as before.
   */
  lastActivityAt?(): number;
  /** FORK 2026-10-01: a turn the CLI started on its own, waiting for its run (unprompted-turn.ts). */
  unpromptedTurn?(): { id: string } | null;
  kill(signal?: NodeJS.Signals): void;
  on(event: "exit", listener: (...args: unknown[]) => void): unknown;
  // FORK 2026-09-30 (lifecycles.md L4b): the file transport (worker-transport.ts). Optional so a
  // test fake without them behaves like a pipe worker.
  readonly openclawSessionKey?: string;
  isFileTransport?(): boolean;
  detach?(): void;
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
  // FORK 2026-06-19 (the lag fix, model arm): the MODEL each live worker was
  // SPAWNED with, keyed by sessionKey. Mirrors `spawnedThinkLevel`: the model is
  // baked into the child's `--model` flag at spawn, and the real ClaudeCodeWorker
  // keeps its spawn params private, so this map is the authoritative record we
  // compare a later turn's requested model against.
  private spawnedModel = new Map<string, string | undefined>();
  // FORK 2026-06-11 (the lag fix): when a think-level change arrives mid-turn
  // we must NOT kill the busy worker; we record the pending change here so the
  // caller can apply it (e.g. surface a notice / force a respawn next turn)
  // via `takeThinkLevelPending`. running = level the busy worker is using.
  private lastThinkLevelPending = new Map<string, { requested?: string; running?: string }>();
  /** FORK 2026-09-30 (L4b): keys of workers adopted from the last gateway (rekeyAdopted). */
  private adoptedKeys = new Set<string>();
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
    this.rekeyAdopted(params);
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
      // FORK 2026-06-19 (the lag fix, model arm): a warm worker also bakes its
      // model into `--model` at spawn, so a per-session model-pin change is equally
      // invisible until respawn. Compare against our recorded spawned model (the
      // real worker doesn't expose `model`). Coalesce undefined so an unchanged/
      // absent pin compares EQUAL and never forces a cold respawn.
      const existingModel = this.spawnedModel.get(params.sessionKey);
      const modelChanged = (existingModel ?? "") !== (params.model ?? "");
      const respawnNeeded = levelChanged || modelChanged;
      if (respawnNeeded && !existing.isBusy()) {
        // Safe to respawn: idle worker. Evict the warm cache and FALL THROUGH
        // to the create path below, which re-derives resumeSessionId from the
        // (still-live or persisted) sessionId so `--resume` re-attaches the
        // SAME claude conversation — history is preserved, only the warm
        // subprocess is lost, and the next turn spawns with the new
        // MAX_THINKING_TOKENS. Do NOT return here.
        this.lastThinkLevelPending.delete(params.sessionKey);
        this.evict(params.sessionKey, existing);
      } else if (respawnNeeded && existing.isBusy()) {
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
    // claude-cli session for this agent regardless of whether the tinker-bridge
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
    // FORK 2026-06-19 (the lag fix, model arm): record the model this worker was
    // spawned with so a later turn can detect a model-pin change.
    this.spawnedModel.set(params.sessionKey, params.model);
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
      const idleMs = now - this.lastSeen(key, worker, now);
      if (idleMs > this.idleTtlMs && !worker.isBusy()) {
        this.evict(key, worker);
      }
    }
    if (this.workers.size <= this.maxWorkers) {
      return;
    }
    const oldestFirst = [...this.workers.entries()].sort(
      (a, b) => this.lastSeen(a[0], a[1], 0) - this.lastSeen(b[0], b[1], 0),
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

  /**
   * FORK 2026-10-01 (bug-log [pool-sweep-kills-working-child]): the later of the last turn handed
   * to this worker and the last line its child printed. Before, only the turn counted, so at
   * 14:29:33 the sweep stopped a child still running a Workflow and another still working a turn
   * the gateway was not tracking.
   */
  private lastSeen(key: string, worker: PoolWorker, fallback: number): number {
    return Math.max(this.lastUsedAt.get(key) ?? fallback, worker.lastActivityAt?.() ?? 0);
  }

  private evict(key: string, worker: PoolWorker): void {
    worker.kill("SIGTERM");
    this.workers.delete(key);
    this.lastUsedAt.delete(key);
    // FORK 2026-06-11 (the lag fix): drop the recorded spawned level + any
    // pending change for an evicted key so it can't go stale.
    this.spawnedThinkLevel.delete(key);
    this.spawnedModel.delete(key);
    this.lastThinkLevelPending.delete(key);
    this.adoptedKeys.delete(key);
  }

  get(sessionKey: string): ClaudeCodeWorker | undefined {
    return this.workers.get(sessionKey) as ClaudeCodeWorker | undefined;
  }

  /**
   * FORK 2026-09-30 (lifecycles.md L4b): take in a worker the last gateway left running (file
   * transport), under the pool key it had. `now()` starts its idle clock.
   */
  adopt(worker: PoolWorker, spawned: { model?: string; thinkLevel?: string }): void {
    const key = worker.sessionKey;
    const previous = this.workers.get(key);
    if (previous && previous !== worker) {
      this.evict(key, previous);
    }
    this.workers.set(key, worker);
    this.lastUsedAt.set(key, this.now());
    this.spawnedThinkLevel.set(key, spawned.thinkLevel);
    this.spawnedModel.set(key, spawned.model);
    this.adoptedKeys.add(key);
  }

  /**
   * An adopted worker is filed under the pool key the LAST gateway derived (stream.ts hashes the
   * system prompt's stable prefix with the session id), and an upgrade can change that prefix. The
   * first turn of its session finds it by the canonical session key instead and files it under the
   * new key, so a second claude never starts on the same CLI session.
   */
  private rekeyAdopted(params: WorkerSpawnParams): void {
    if (this.adoptedKeys.size === 0 || !params.openclawSessionKey) {
      return;
    }
    if (this.workers.get(params.sessionKey)?.isAlive()) {
      return;
    }
    for (const key of this.adoptedKeys) {
      const worker = this.workers.get(key);
      if (!worker || !worker.isAlive()) {
        this.adoptedKeys.delete(key);
        continue;
      }
      if (key === params.sessionKey || worker.openclawSessionKey !== params.openclawSessionKey) {
        continue;
      }
      this.workers.delete(key);
      this.workers.set(params.sessionKey, worker);
      this.lastUsedAt.set(params.sessionKey, this.lastUsedAt.get(key) ?? this.now());
      this.lastUsedAt.delete(key);
      this.spawnedThinkLevel.set(params.sessionKey, this.spawnedThinkLevel.get(key));
      this.spawnedThinkLevel.delete(key);
      this.spawnedModel.set(params.sessionKey, this.spawnedModel.get(key));
      this.spawnedModel.delete(key);
      this.adoptedKeys.delete(key);
      return;
    }
  }

  /** A live worker serving this canonical session, under whatever pool key. */
  liveWorkerFor(openclawSessionKey: string | undefined): PoolWorker | undefined {
    if (!openclawSessionKey) {
      return undefined;
    }
    for (const worker of this.workers.values()) {
      if (worker.openclawSessionKey === openclawSessionKey && worker.isAlive()) {
        return worker;
      }
    }
    return undefined;
  }

  /**
   * FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): the worker keeping the CLI's own
   * turn with this id, whatever pool key it sits under, for the run its wake started.
   */
  findUnpromptedHolder(id: string): ClaudeCodeWorker | undefined {
    for (const worker of this.workers.values()) {
      if (worker.unpromptedTurn?.()?.id === id) {
        return worker as ClaudeCodeWorker;
      }
    }
    return undefined;
  }

  /** Every pooled worker (the restart drain asks each one to hold). */
  all(): ClaudeCodeWorker[] {
    return [...this.workers.values()] as ClaudeCodeWorker[];
  }

  /** Workers on the file transport: the ones a restart can hold and the next gateway adopt. */
  fileWorkers(): ClaudeCodeWorker[] {
    return [...this.workers.values()].filter(
      (w) => w.isFileTransport?.() === true,
    ) as ClaudeCodeWorker[];
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

  /**
   * The gateway is going. A pipe worker cannot outlive it and is killed. A file-transport worker
   * is let go (detach) and left running, or frozen by the restart drain, for the next gateway to
   * adopt. `keepFileWorkers` skips them entirely: at SIGTERM the drain has not run yet, and it needs
   * them attached to find their API-call boundaries; the process `exit` lets go of them.
   */
  killAll(opts: { keepFileWorkers?: boolean } = {}): void {
    for (const [key, worker] of this.workers) {
      if (worker.isFileTransport?.()) {
        if (opts.keepFileWorkers) {
          continue;
        }
        worker.detach?.();
      } else {
        worker.kill("SIGTERM");
      }
      this.workers.delete(key);
      this.lastUsedAt.delete(key);
      this.spawnedThinkLevel.delete(key);
      this.spawnedModel.delete(key);
      this.lastThinkLevelPending.delete(key);
      this.adoptedKeys.delete(key);
    }
  }
}

// Single gateway-wide pool instance.
let singleton: SessionWorkerPool | null = null;
export function getPool(): SessionWorkerPool {
  if (!singleton) {
    singleton = new SessionWorkerPool();
    process.on("exit", () => singleton?.killAll());
    process.on("SIGTERM", () => singleton?.killAll({ keepFileWorkers: true }));
    process.on("SIGINT", () => singleton?.killAll({ keepFileWorkers: true }));
  }
  return singleton;
}
