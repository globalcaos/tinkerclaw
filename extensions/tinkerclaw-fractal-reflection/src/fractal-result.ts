/**
 * FORK 2026-06-11 — Parallel Fractal Reflection Drop 1 (bible §5.67a, amended by §5.67b — §5.67b wins).
 *
 * U5-result: the TWO-EVENT liveness contract + dead-stub watchdog.
 *
 * Two-event contract (§5.67b "Two-event contract (liveness)"):
 *   1. `makePendingRow` + `emitFractalEvent` — a `pending` stub emits at spawn so the
 *      UI docks a collapsed placeholder under the parent answer instantly; the final
 *      row emits when triage settles and replaces the stub IN PLACE (consumers match
 *      by `parentRunId`, carried in the row — the later event wins).
 *   2. `StubWatchdog` — converts a dead-run stub to `error` ONLY on VERIFIED deadness:
 *      the run-context registry reports the lane runId terminal-or-gone, or zero run
 *      events for that runId within the liveness ceiling (total EVENT SILENCE since
 *      the last observed event — never wall-clock since spawn; design-principle #19:
 *      the 120s idle kill is the canonical bug; liveness checks never assert doneness).
 *
 * Emit path taken: the REAL core surface — `emitAgentEvent` — reached through the
 * DECLARED plugin-sdk subpath `openclaw/plugin-sdk/agent-harness-runtime`, which
 * re-exports the very same binding out of `src/infra/agent-events.ts`: the exact
 * surface tinkerclaw-learned-intuition uses for its `stream:"lifecycle"`
 * amygdala-decision broadcasts and tinkerclaw-tinker-bridge uses in `src/stream.ts`.
 *
 * CORRECTION 2026-08-04 — this paragraph used to assert "there is no plugin-sdk emit
 * wrapper; bundled fork extensions import core infra directly". That was FALSE when it
 * was written: `emitAgentEvent` had been published on `agent-harness-runtime` since
 * upstream 4d09d753047 (2026-04-25), roughly seven weeks before this file (2026-06-11);
 * `getAgentRunContext` joined it on 2026-08-04. The note is CORRECTED rather than
 * deleted, because the relative reach it licensed is a real hazard worth remembering:
 * this extension is `publishToNpm: true`, its tarball ships only its own directory, so
 * a relative reach into the repo `src/` tree cannot resolve on an installed user's disk
 * — FOUNDATION #9 (bounded, replicable), enforced by
 * `scripts/check-no-extension-src-imports.ts` (`pnpm lint:plugins:no-extension-src-imports`),
 * whose fork allowlist deliberately does NOT cover this extension. The SDK subpath is
 * the sanctioned crossing, and it is still a HARD dependency by design: these are
 * declared exports, so a host that lacks them fails at plugin LOAD, loudly, instead of
 * silently degrading — hence, as before, NO no-op fallback. Crossing costs nothing at
 * runtime: agent-events keeps its listener set and run-context map on a
 * `Symbol.for("openclaw.agentEvents.state")` global singleton, so the SDK re-export and
 * the core module address ONE registry — the watchdog below observes exactly what the
 * harness writes.
 *
 * `emitFractalEvent` is the SINGLE chokepoint — nothing else in this
 * plugin may emit `stream:"fractal"` — and the ENVELOPE carries the MAIN session's
 * sessionKey (all tinker-ui stream consumers are sessionKey-gated return-early;
 * lane runIds ride inside `data`, i.e. the row).
 *
 * Run-state surface for the watchdog: `getAgentRunContext` from the same SDK subpath —
 * contexts are registered at run start (`agent-command.ts:471/596`), `lastActiveAt`
 * is refreshed on EVERY `emitAgentEvent` for that runId, and the context is cleared
 * on the run's terminal lifecycle event (`agent-command.ts:1201`, `server-chat.ts`).
 * So "context gone after having been seen" = terminal-or-gone, and
 * `now - lastActiveAt` = total event silence.
 */

import { emitAgentEvent, getAgentRunContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { FractalRow } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stream tag for every fractal agent event (tinker-ui adds it to KNOWN_STREAMS). */
export const FRACTAL_STREAM = "fractal";

/** Version stamp for rows minted by this module (ledger rows are version-stamped). */
export const FRACTAL_ROW_VERSION = 1;

/**
 * Liveness ceiling: total event silence (ms) before a tracked lane run counts as
 * verifiably dead. SAFETY CEILING per design-principle #19 — boot value only;
 * §5.67b re-derives it from the ledger's own p50/p95 timeToDock once rows exist.
 * It is NEVER "time since spawn": a run that keeps emitting events resets the
 * silence clock indefinitely.
 *
 * 2026-08-04: raised 120_000 -> 300_000, kept equal to TRIAGE_WAIT_CEILING_MS
 * (fractal-run.ts) — the two are a pair and drift between them is a bug. The
 * measurement that set it is written out in full there; the short version is
 * p90 = 128.5s against a 120s ceiling, max 260.4s, and not one of the 2,466
 * recorded rows carries a success status (`clean`/`flagged`/`gap`) — only
 * `error` (2,407) and `skipped` (59).
 *
 * A triage run is one long model call that emits nothing while it thinks, so
 * "total event silence" and "time since spawn" are the SAME quantity here. That
 * is why this ceiling mattered at all, and it is why the distinction the comment
 * above draws — correct in general — bought nothing on this lane: the watchdog
 * read a normal 128s of thinking as verified deadness and converted a live run's
 * pending stub to `error`. The two silence-ceiling deaths recorded at 120007ms
 * and 125651ms are that, not dead lanes.
 *
 * STILL NOT IMPLEMENTED: the §5.67b re-derivation this comment has promised
 * since the module was written. The ledger now holds 291 rows carrying
 * timeToDockMs, so the input exists and the excuse ("once rows exist") has
 * expired — this is a hand-set boot value calibrated from those rows ONCE, by
 * hand, and it will go stale again the same way. Deriving it at boot is the
 * actual fix and is tracked separately.
 */
export const FRACTAL_LIVENESS_CEILING_MS = 300_000;

/** Default watchdog poll cadence (ms). */
export const FRACTAL_WATCHDOG_POLL_MS = 15_000;

// ---------------------------------------------------------------------------
// Two-event contract: pending stub + single emit chokepoint
// ---------------------------------------------------------------------------

export type FractalEventEnvelope = {
  /** Envelope runId = the MAIN run (parentRunId): the docking anchor. */
  runId: string;
  stream: string;
  /** MAIN session's sessionKey — UI stream consumers are sessionKey-gated. */
  sessionKey?: string;
  /** The FractalRow (carries parentRunId + lane runIds across runs). */
  data: Record<string, unknown>;
};

export type FractalEventEmitter = (event: FractalEventEnvelope) => void;

type FractalLoggerLike = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

/** Structural subset of OpenClawPluginApi this module needs (logging only). */
export type FractalEmitApi = {
  logger?: FractalLoggerLike;
};

/**
 * Mint the `pending` stub row emitted at spawn (event #1 of the two-event
 * contract). The UI docks a collapsed placeholder for it immediately; the final
 * row replaces it in place.
 *
 * Deliberately loose construction: `types.ts` (U1) owns the full FractalRow
 * shape; the stub commits only to the fields the two-event contract itself
 * reads (parentRunId for docking, status for liveness, ts/sessionKey for the
 * reconnect re-query path). The cast below is the ONE place this module steps
 * outside the static row shape.
 */
export function makePendingRow(
  parentRunId: string,
  sessionKey: string,
  now: () => number = Date.now,
): FractalRow {
  const row = {
    v: FRACTAL_ROW_VERSION,
    parentRunId,
    sessionKey,
    status: "pending",
    ts: now(),
  };
  return row as unknown as FractalRow;
}

/**
 * SINGLE chokepoint for every `stream:"fractal"` event. Envelope rules (§5.67b):
 *   - `sessionKey` = the MAIN session's key (consumers gate on it, return-early);
 *   - `runId` = parentRunId (the docking anchor — answer bubbles carry no runId
 *     in the DOM; the UI matches by parentRunId, which also rides in `data`);
 *   - `data` = the FractalRow itself.
 *
 * The default emitter is the real core surface (`emitAgentEvent`); tests inject
 * a mock. The ledger (U2) persists rows independently of this emit, so the RPC
 * read-path (`fractal.byRunId`) keeps vanilla correctness even if no UI client
 * is listening.
 */
export function emitFractalEvent(
  api: FractalEmitApi | undefined,
  mainSessionKey: string,
  row: FractalRow,
  emit: FractalEventEmitter = emitAgentEvent,
): void {
  const r = row as unknown as { parentRunId?: unknown; status?: unknown };
  const parentRunId = typeof r.parentRunId === "string" ? r.parentRunId : "";
  if (!parentRunId) {
    // A row without a docking anchor can never replace its stub — drop loudly.
    api?.logger?.warn?.("[fractal] emitFractalEvent: row has no parentRunId; event dropped");
    return;
  }
  if (!mainSessionKey) {
    // Still emit (the ledger read-path keeps vanilla correctness) but say so:
    // sessionKey-gated UI consumers will never render an unkeyed envelope.
    api?.logger?.warn?.(
      `[fractal] emitFractalEvent: missing main sessionKey for parentRunId=${parentRunId}; UI consumers will not render this event`,
    );
  }
  emit({
    runId: parentRunId,
    stream: FRACTAL_STREAM,
    ...(mainSessionKey ? { sessionKey: mainSessionKey } : {}),
    data: { ...(row as unknown as Record<string, unknown>) },
  });
  api?.logger?.debug?.(
    `[fractal] event emitted: parentRunId=${parentRunId} status=${String(r.status)}`,
  );
}

// ---------------------------------------------------------------------------
// StubWatchdog — verified-deadness conversion of orphaned pending stubs
// ---------------------------------------------------------------------------

export type WatchdogDeathReason = "terminal-or-gone" | "silence-ceiling";

export type WatchdogDeath = {
  parentRunId: string;
  runId: string;
  reason: WatchdogDeathReason;
  /** ms of total event silence observed when deadness was verified. */
  silenceMs: number;
};

export type RunStateSnapshot = {
  registeredAt?: number;
  lastActiveAt?: number;
};

export type StubWatchdogOptions = {
  /** Liveness ceiling override (ms). Default: FRACTAL_LIVENESS_CEILING_MS. */
  ceilingMs?: number;
  /** Poll cadence override (ms). Default: FRACTAL_WATCHDOG_POLL_MS. */
  pollMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable run-state reader (tests); default = core getAgentRunContext. */
  getRunState?: (runId: string) => RunStateSnapshot | undefined;
  /** Injectable scheduler (tests drive poll() manually with a no-op scheduler). */
  schedule?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
};

type TrackedStub = {
  parentRunId: string;
  runId: string;
  onDead: (death: WatchdogDeath) => void;
  trackedAt: number;
  /** Run context observed at least once. */
  seen: boolean;
  /** Timestamp of the freshest run-context activity we observed. */
  lastObservedAt?: number;
  /** Consecutive polls where a previously-seen context was gone. */
  gonePolls: number;
};

const defaultSchedule = {
  set: (fn: () => void, ms: number): unknown => {
    const handle = setInterval(fn, ms);
    // Don't hold the gateway process open for the watchdog.
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle: unknown): void => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Tracks one pending stub per parentRunId and converts it to `error` (via the
 * provided callback) ONLY on verified deadness:
 *
 *   - "silence-ceiling": zero run events for the lane runId within the liveness
 *     ceiling — measured as total event silence since the last observed activity
 *     (`lastActiveAt`, refreshed on every emitAgentEvent), never wall-clock
 *     since spawn. A never-registered run falls under the same arm (zero events
 *     since spawn — there is no live run whose wall-clock could be miscounted).
 *   - "terminal-or-gone": a previously-seen run context disappeared from the
 *     registry (cleared on the terminal lifecycle event). One full poll of
 *     grace is given, because normal completion clears the registry an instant
 *     before the final event + cancel() land — firing immediately would race
 *     the happy path.
 *
 * `cancel(parentRunId)` on normal completion suppresses the conversion.
 * `onDead` is exception-contained: the watchdog never throws out of its poll
 * loop (the whole fractal cycle is ONE rooted promise chain — §5.67b
 * supervised-detach rule).
 */
export class StubWatchdog {
  private readonly ceilingMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly getRunState: (runId: string) => RunStateSnapshot | undefined;
  private readonly schedule: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
  private readonly tracked = new Map<string, TrackedStub>();
  private timer: unknown = undefined;

  constructor(opts: StubWatchdogOptions = {}) {
    this.ceilingMs = opts.ceilingMs ?? FRACTAL_LIVENESS_CEILING_MS;
    this.pollMs = opts.pollMs ?? FRACTAL_WATCHDOG_POLL_MS;
    this.now = opts.now ?? Date.now;
    this.getRunState = opts.getRunState ?? ((runId) => getAgentRunContext(runId));
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** Start watching a lane run. Re-tracking the same parentRunId replaces the entry (latest-wins). */
  track(parentRunId: string, runId: string, onDead: (death: WatchdogDeath) => void): void {
    this.tracked.set(parentRunId, {
      parentRunId,
      runId,
      onDead,
      trackedAt: this.now(),
      seen: false,
      gonePolls: 0,
    });
    if (this.timer === undefined) {
      this.timer = this.schedule.set(() => this.poll(), this.pollMs);
    }
  }

  /** Normal completion: the final event replaced the stub — stop watching. */
  cancel(parentRunId: string): void {
    this.tracked.delete(parentRunId);
    this.maybeStopTimer();
  }

  /** Drop everything (plugin teardown). */
  stop(): void {
    this.tracked.clear();
    this.maybeStopTimer();
  }

  get size(): number {
    return this.tracked.size;
  }

  /** One verification pass over all tracked stubs. Public so tests (and manual drives) can call it with an injected clock. */
  poll(): void {
    const now = this.now();
    for (const entry of [...this.tracked.values()]) {
      const snap = this.getRunState(entry.runId);
      if (snap) {
        entry.seen = true;
        entry.gonePolls = 0;
        const lastObserved = snap.lastActiveAt ?? snap.registeredAt ?? entry.trackedAt;
        entry.lastObservedAt = lastObserved;
        const silenceMs = now - lastObserved;
        if (silenceMs > this.ceilingMs) {
          this.fire(entry, "silence-ceiling", silenceMs);
        }
        continue;
      }
      if (entry.seen) {
        // Previously-seen context is gone = the run reached terminal and the
        // registry cleared it. Require a second consecutive gone-poll (grace)
        // before converting, so normal completion's final-event/cancel() wins
        // the race instead of producing a spurious error row.
        entry.gonePolls += 1;
        if (entry.gonePolls >= 2) {
          this.fire(entry, "terminal-or-gone", now - (entry.lastObservedAt ?? entry.trackedAt));
        }
        continue;
      }
      // Never seen at all: zero run events for this runId since spawn — the
      // §5.67b "zero run events within the liveness ceiling" arm.
      const silenceMs = now - entry.trackedAt;
      if (silenceMs > this.ceilingMs) {
        this.fire(entry, "silence-ceiling", silenceMs);
      }
    }
  }

  private fire(entry: TrackedStub, reason: WatchdogDeathReason, silenceMs: number): void {
    this.tracked.delete(entry.parentRunId);
    this.maybeStopTimer();
    try {
      entry.onDead({ parentRunId: entry.parentRunId, runId: entry.runId, reason, silenceMs });
    } catch {
      // Exception-contained by design — see class doc.
    }
  }

  private maybeStopTimer(): void {
    if (this.tracked.size === 0 && this.timer !== undefined) {
      this.schedule.clear(this.timer);
      this.timer = undefined;
    }
  }
}
