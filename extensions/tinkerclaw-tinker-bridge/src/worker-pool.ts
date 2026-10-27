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
 *
 * FORK 2026-10-19 (JarvisPi OOM): the kernel OOM-killed the gateway on the 16 GB
 * Pi at 21:12 while 22 idle `temp:jev-explain:<runId>` workers and 4 idle
 * `agent:main:fractal:<id>` workers held 11.3 GB RSS plus all 2 GB of swap. Each
 * of those sessions runs once, yet the pool parked every idle worker for 15 min
 * and swept only inside getOrCreate, so a quiet house never reaped anything. Now
 * a one-shot session retires after 60 s idle, the pool also sweeps on a 30 s
 * timer, a sweep sheds idle workers when free memory is under a floor, and the
 * default cap scales with RAM.
 */
import os from "node:os";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getLatestResumeSessionIdByOpenclawSessionId, getResumeSessionId } from "./session-map.js";
import { isAdaptiveEffortModel } from "./thinking-budget.js";
import { ClaudeCodeWorker, type WorkerSpawnParams } from "./worker.js";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

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
  /** FORK 2026-10-15: the conversation the worker's CLI session belongs to (claimChatWorker). */
  readonly openclawSessionId?: string;
  isFileTransport?(): boolean;
  detach?(): void;
}

export interface SessionWorkerPoolOptions {
  /** Worker factory — defaults to spawning a real ClaudeCodeWorker. */
  createWorker?: (params: WorkerSpawnParams) => PoolWorker;
  /**
   * Hard ceiling on concurrently-pooled workers (LRU-evicted past this).
   * FORK 2026-10-19: defaults to defaultMaxWorkers(), one per GiB of RAM, 4 to 32.
   */
  maxWorkers?: number;
  /** A non-busy worker idle longer than this is reaped on the next sweep. */
  idleTtlMs?: number;
  /**
   * FORK 2026-10-19: the idle TTL of a one-shot session (isOneShotSessionKey, on the pool key or
   * the worker's canonical session key). Default ONE_SHOT_IDLE_TTL_MS.
   */
  oneShotIdleTtlMs?: number;
  /** FORK 2026-10-19: period of the timed sweep. Default SWEEP_INTERVAL_MS; 0 disables it. */
  sweepIntervalMs?: number;
  /** FORK 2026-10-19: available memory in bytes. Default os.freemem() (MemAvailable on Linux). */
  freeMemBytes?: () => number;
  /**
   * FORK 2026-10-19: below this much free memory a sweep sheds idle workers.
   * Default: the larger of 1.5 GiB and 10% of RAM.
   */
  memoryFloorBytes?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

// idleTtlMs must comfortably exceed the longest legitimate turn (observed
// people-profiles turns up to ~620s); `isBusy()` is the real guard, this is
// the backstop for a worker that finished but will never be reused.
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;

// FORK 2026-10-19 (JarvisPi OOM, 21:12): a Jev explanation runs under a fresh
// `temp:jev-explain:<runId>` session and a Fractal reflection under a fresh
// `agent:<id>:fractal:<P>` one, so nobody asks for their worker again. Parked for
// the full 15 min, 22 of the first and 4 of the second sat idle on the 16 GB Pi,
// holding 11.3 GB RSS plus all 2 GB of swap, when the kernel killed the gateway.
// A one-shot worker now goes after 60 s idle; isBusy() still guards a live turn.
export const ONE_SHOT_IDLE_TTL_MS = 60_000;
// FORK 2026-10-19: the pool swept only inside getOrCreate, so with no new turns
// nothing was reaped. A timer runs the same sweep every 30 s.
export const SWEEP_INTERVAL_MS = 30_000;
// FORK 2026-10-19: under memory pressure one sweep stops at most 2 idle workers.
// os.freemem() does not rise until the stopped children have exited, so stopping
// more on one reading would overshoot; the next sweep measures again. A worker
// seen in the last minute is left alone: it may be between two turns of a live
// chat, or just handed a turn it has not started yet.
export const MAX_PRESSURE_EVICTIONS_PER_SWEEP = 2;
export const PRESSURE_MIN_IDLE_MS = 60_000;

/**
 * FORK 2026-10-19: a session that runs once and is never asked for again: the
 * internal `temp:*` one-shots (the Jev explainer, the tab namer, the slug
 * generator) and a Fractal reflection (`agent:<id>:fractal:<P>`).
 */
export function isOneShotSessionKey(key: string): boolean {
  return key.startsWith("temp:") || key.includes(":fractal:");
}

/**
 * FORK 2026-10-19: the default cap scales with RAM, one worker per GiB, between 4
 * and 32. The old fixed 32 was sized for the 64 GB laptop (~450-600 MB a worker);
 * on the 16 GB Pi it let idle workers fill RAM and swap. Pi (15.84 GiB): 15.
 */
export function defaultMaxWorkers(totalBytes: number = os.totalmem()): number {
  const gib = Math.floor(totalBytes / 2 ** 30);
  return Number.isFinite(gib) ? Math.min(32, Math.max(4, gib)) : 32;
}

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
  /**
   * FORK 2026-10-15 (claimChatWorker): keys whose worker still runs the system prompt of an older
   * key. It took a turn while busy; the first turn that finds it idle respawns it.
   */
  private promptChanged = new Set<string>();
  private readonly createWorker: (params: WorkerSpawnParams) => PoolWorker;
  private readonly maxWorkers: number;
  private readonly idleTtlMs: number;
  private readonly oneShotIdleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly freeMemBytes: () => number;
  private readonly memoryFloorBytes: number;
  private readonly now: () => number;
  /** FORK 2026-10-19: the timed sweep (armSweepTimer); null until a worker enters the pool. */
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: SessionWorkerPoolOptions = {}) {
    this.createWorker = options.createWorker ?? ((params) => new ClaudeCodeWorker(params));
    this.maxWorkers = options.maxWorkers ?? defaultMaxWorkers();
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.oneShotIdleTtlMs = options.oneShotIdleTtlMs ?? ONE_SHOT_IDLE_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    // FORK 2026-10-19: os.freemem() is MemAvailable on Linux with libuv >= 1.45 (on the Pi it read
    // 9.08 GiB = MemAvailable while MemFree was 3.73 GiB), so reclaimable page cache counts as free.
    this.freeMemBytes = options.freeMemBytes ?? (() => os.freemem());
    // FORK 2026-10-19: 1.5 GiB, or 10% of RAM on a bigger machine (Pi: 1.58 GiB).
    this.memoryFloorBytes =
      options.memoryFloorBytes ?? Math.max(1.5 * 2 ** 30, 0.1 * os.totalmem());
    this.now = options.now ?? (() => Date.now());
  }

  getOrCreate(params: WorkerSpawnParams): ClaudeCodeWorker {
    const now = this.now();
    this.rekeyAdopted(params);
    params = this.claimChatWorker(params);
    const existing = this.workers.get(params.sessionKey);
    if (existing && existing.isAlive()) {
      // FORK 2026-06-11 (the lag fix): a warm worker bakes its think level into
      // MAX_THINKING_TOKENS at spawn time, so a per-session thinkLevel change
      // is INVISIBLE until the subprocess is respawned. Detect the change and
      // act on it here instead of silently handing back the stale worker.
      // The worker's own spawn params are private (existing.thinkLevel is
      // undefined for the real worker), so prefer our recorded spawned level.
      const existingLevel = existing.thinkLevel ?? this.spawnedThinkLevel.get(params.sessionKey);
      // FORK 2026-10-09 (effort per turn): an adaptive-effort model (Claude 5.x, Fable, Opus 4.7+)
      // never bakes its level in at spawn: the worker applies each turn's level as an effort on the
      // live process (worker.ts applyTurnEffort). A level change is then no reason to respawn it,
      // nor to park a pending change. A model change still is (below); older models still respawn.
      const levelChanged =
        !isAdaptiveEffortModel(params.model) &&
        normLevel(existingLevel) !== normLevel(params.thinkLevel);
      // FORK 2026-06-19 (the lag fix, model arm): a warm worker also bakes its
      // model into `--model` at spawn, so a per-session model-pin change is equally
      // invisible until respawn. Compare against our recorded spawned model (the
      // real worker doesn't expose `model`). Coalesce undefined so an unchanged/
      // absent pin compares EQUAL and never forces a cold respawn.
      const existingModel = this.spawnedModel.get(params.sessionKey);
      const modelChanged = (existingModel ?? "") !== (params.model ?? "");
      // FORK 2026-10-15: a worker claimChatWorker handed a turn while busy still runs the old
      // system prompt; respawn it once it is idle.
      const respawnNeeded =
        levelChanged || modelChanged || this.promptChanged.has(params.sessionKey);
      if (respawnNeeded && !existing.isBusy()) {
        // Safe to respawn: idle worker. Evict the warm cache and FALL THROUGH
        // to the create path below, which re-derives resumeSessionId from the
        // (still-live or persisted) sessionId so `--resume` re-attaches the
        // SAME claude conversation — history is preserved, only the warm
        // subprocess is lost, and the next turn spawns with the new
        // MAX_THINKING_TOKENS. Do NOT return here.
        this.lastThinkLevelPending.delete(params.sessionKey);
        this.evict(params.sessionKey, existing);
      } else if ((levelChanged || modelChanged) && existing.isBusy()) {
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
        // No change (or only the prompt, on a busy worker) — hand back the warm worker as before.
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
    this.armSweepTimer();
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
   * Reap idle non-busy workers, enforce the LRU cap, then shed idle workers if
   * free memory is under the floor. Runs on every getOrCreate and, since
   * 2026-10-19, on a timer (armSweepTimer), which passes no `exemptKey`. The
   * worker for `exemptKey` (the one we are about to hand back) and any worker
   * mid-turn (`isBusy()`) are never evicted; their sessionId remains in
   * session-map.json for a future `--resume`.
   *
   * FORK 2026-10-19 (JarvisPi OOM): a one-shot session (isOneShotSessionKey) is
   * reaped after `oneShotIdleTtlMs` instead of `idleTtlMs`. The old note here
   * said no timer was needed because pressure only grows when workers are
   * created; but an idle worker nobody asks for again waits for the next
   * getOrCreate, and a quiet house never makes one.
   */
  private sweep(now: number, exemptKey?: string): void {
    for (const [key, worker] of this.workers) {
      if (key === exemptKey) {
        continue;
      }
      const idleMs = now - this.lastSeen(key, worker, now);
      const ttlMs = this.isOneShot(key, worker) ? this.oneShotIdleTtlMs : this.idleTtlMs;
      if (idleMs > ttlMs && !worker.isBusy()) {
        this.evict(key, worker);
      }
    }
    if (this.workers.size > this.maxWorkers) {
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
    this.relieveMemoryPressure(now, exemptKey);
  }

  /**
   * FORK 2026-10-19 (JarvisPi OOM): when free memory is under the floor, stop
   * up to MAX_PRESSURE_EVICTIONS_PER_SWEEP live workers that are not busy, not
   * `exemptKey` and idle at least PRESSURE_MIN_IDLE_MS: one-shot sessions first,
   * then the least recently seen. A dead entry holds no memory, so it never takes
   * one of the places. A sweep that stops something logs one warn line with the
   * reading, the floor and the workers it stopped.
   */
  private relieveMemoryPressure(now: number, exemptKey?: string): void {
    if (this.workers.size === 0) {
      return;
    }
    let free: number;
    try {
      free = this.freeMemBytes();
    } catch (err) {
      log.warn(`[worker-pool] could not read free memory: ${String(err)}`);
      return;
    }
    if (!Number.isFinite(free) || free >= this.memoryFloorBytes) {
      return;
    }
    const oneShotRank = (key: string, worker: PoolWorker) => (this.isOneShot(key, worker) ? 0 : 1);
    const victims = [...this.workers.entries()]
      .filter(
        ([key, worker]) =>
          key !== exemptKey &&
          worker.isAlive() &&
          !worker.isBusy() &&
          now - this.lastSeen(key, worker, now) >= PRESSURE_MIN_IDLE_MS,
      )
      .sort(
        (a, b) =>
          oneShotRank(a[0], a[1]) - oneShotRank(b[0], b[1]) ||
          this.lastSeen(a[0], a[1], now) - this.lastSeen(b[0], b[1], now),
      )
      .slice(0, MAX_PRESSURE_EVICTIONS_PER_SWEEP);
    if (victims.length === 0) {
      return;
    }
    // The pool key is the stream's `tinker-sp-<hash>`; the canonical key says what the worker was.
    const names = victims.map(([key, worker]) =>
      worker.openclawSessionKey && worker.openclawSessionKey !== key
        ? `${key} (${worker.openclawSessionKey})`
        : key,
    );
    for (const [key, worker] of victims) {
      this.evict(key, worker);
    }
    const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1);
    log.warn(
      `[worker-pool] memory pressure: ${gib(free)} GiB free < ${gib(this.memoryFloorBytes)} GiB floor; evicted ${victims.length} idle worker(s): ${names.join(", ")}`,
    );
  }

  /**
   * FORK 2026-10-19: a one-shot session, named by its pool key or by the
   * canonical session key its worker carries. In production the pool key is the
   * stream's `tinker-sp-<hash>` (stream.ts deriveSessionKey), so it is the
   * canonical key (`temp:jev-explain:<runId>`, `agent:main:fractal:<P>`) that
   * names it; adopted workers carry theirs from the unit's meta.
   */
  private isOneShot(key: string, worker: PoolWorker): boolean {
    return isOneShotSessionKey(key) || isOneShotSessionKey(worker.openclawSessionKey ?? "");
  }

  /**
   * FORK 2026-10-19 (JarvisPi OOM): the timed sweep, so a pool with no new turns
   * still reaps. Armed by the first worker that enters the pool (getOrCreate or
   * adopt), so a pool nobody uses holds no timer; unref'd, so it never keeps the
   * process alive; stopped by dispose(). A timer must never throw: a failed
   * sweep is logged and the next tick tries again.
   */
  private armSweepTimer(): void {
    if (this.sweepTimer || !(Number.isFinite(this.sweepIntervalMs) && this.sweepIntervalMs > 0)) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep(this.now());
      } catch (err) {
        log.warn(`[worker-pool] timed sweep failed: ${String(err)}`);
      }
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * FORK 2026-10-19: stop the timed sweep. killAll() calls it (the gateway is
   * going). The pool stays usable: the next worker that enters it arms the timer
   * again.
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
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
    this.promptChanged.delete(key);
  }

  get(sessionKey: string): ClaudeCodeWorker | undefined {
    return this.workers.get(sessionKey) as ClaudeCodeWorker | undefined;
  }

  /** FORK 2026-10-22 (Rewind): is a worker on this claude-cli session mid-turn? */
  isBusyOnSession(sessionId: string): boolean {
    for (const worker of this.workers.values()) {
      if (worker.sessionId === sessionId && worker.isBusy()) {
        return true;
      }
    }
    return false;
  }

  /**
   * FORK 2026-10-22 (Rewind): retire the idle workers on this claude-cli session. A warm worker holds the whole
   * conversation in its process, so after a Rewind re-pointed the session map only a respawn (`--resume` of the fork)
   * makes the model forget the rewound exchange. A busy worker is never touched. Returns how many were retired.
   */
  retireIdleOnSession(sessionId: string): number {
    let retired = 0;
    for (const [key, worker] of [...this.workers]) {
      if (worker.sessionId === sessionId && !worker.isBusy()) {
        this.evict(key, worker);
        retired++;
      }
    }
    return retired;
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
    // FORK 2026-10-19: an adopted worker follows the same rules by key, the timed sweep included.
    this.armSweepTimer();
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
      this.moveKey(key, params.sessionKey, worker);
      this.adoptedKeys.delete(key);
      return;
    }
  }

  /**
   * FORK 2026-10-15 (bug-log [twin-worker-on-prompt-change]): one claude per conversation, whatever
   * pool key it sits under. The key hashes the system prompt's stable prefix, so an edit to a
   * workspace file that prompt carries (TOOLS.md, a SKILL.md), made by ANY chat, gives every chat a
   * new key on its next turn. The old worker was never told: idle, it waited for the sweep; busy
   * with a background Workflow, it was never reaped, and a second claude resumed the same CLI
   * session beside it (Jira tab, 2026-10-15 12:38: one ORCA build ran twice). Now a busy worker
   * takes the turn under the new key and respawns with the new prompt once idle; an idle one is
   * stopped and the new worker resumes its CLI session. A different conversation id (the tab was
   * reset) and a fork (Fractal) keep their own worker: neither may resume this CLI session.
   */
  private claimChatWorker(params: WorkerSpawnParams): WorkerSpawnParams {
    if (
      !params.openclawSessionKey ||
      !params.openclawSessionId ||
      params.forkSession ||
      this.workers.get(params.sessionKey)?.isAlive()
    ) {
      return params;
    }
    for (const [key, worker] of this.workers) {
      if (
        key === params.sessionKey ||
        worker.openclawSessionKey !== params.openclawSessionKey ||
        worker.openclawSessionId !== params.openclawSessionId ||
        !worker.isAlive()
      ) {
        continue;
      }
      if (worker.isBusy()) {
        this.moveKey(key, params.sessionKey, worker);
        this.promptChanged.add(params.sessionKey);
        return params;
      }
      const resumeSessionId = worker.sessionId;
      this.evict(key, worker);
      return resumeSessionId && !params.resumeSessionId ? { ...params, resumeSessionId } : params;
    }
    return params;
  }

  /** File a live worker, and what the pool records about it, under another pool key. */
  private moveKey(from: string, to: string, worker: PoolWorker): void {
    this.workers.delete(from);
    this.workers.set(to, worker);
    this.lastUsedAt.set(to, this.lastUsedAt.get(from) ?? this.now());
    this.lastUsedAt.delete(from);
    this.spawnedThinkLevel.set(to, this.spawnedThinkLevel.get(from));
    this.spawnedThinkLevel.delete(from);
    this.spawnedModel.set(to, this.spawnedModel.get(from));
    this.spawnedModel.delete(from);
    if (this.promptChanged.delete(from)) {
      this.promptChanged.add(to);
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
    // FORK 2026-10-19: the gateway is going, so the timed sweep stops first. At SIGTERM the restart
    // drain still needs the kept file workers attached; a tick must not stop one under it.
    this.dispose();
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
      this.promptChanged.delete(key);
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
