/**
 * FORK 2026-09-29 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — the restart drain: before the gateway
 * stops, every runner brings its live turns to a model-call boundary, so no paid output is cut.
 *
 * Participants register here (the embedded runner in core; the cc-bridge through the same global
 * key, since a bundled extension may not import core modules; since 2026-10-01 chat.send's
 * `preparing` tracker, see createPreparingPromptTracker below). `drainForRestart` runs them all in
 * parallel within one budget. While a drain is active, runs that START are held at their first model
 * call too (`isRestartDrainActive`), so nothing slips in between the drain and the stop.
 *
 * The contract the key carries, for a participant outside core:
 *   globalThis[Symbol.for("openclaw.restartDrain")] = { participants: Map<id, participant>, active }
 *   participant = { drain(budgetMs): Promise<RestartDrainReport>, release(): void | Promise<void> }
 */
export type RestartDrainReport = {
  /** Turns held at a model-call boundary. Nothing further is spent on them. */
  held: string[];
  /**
   * Turns that finished on their own inside the budget. From `preparing`: prompts that left
   * preparation inside the budget. Their run started (where the runner's own hold takes over), the
   * reply pipeline steered, backlogged or refused them, or they were aborted or settled.
   */
  ended: string[];
  /**
   * Turns still mid-call when the budget ran out; a stop cuts them (still resumed at boot). From
   * `preparing`: prompts acked and still preparing. Their run never started, so a stop loses them and
   * nothing re-runs them at boot; each one is logged with its session.
   */
  unfinished: string[];
};

export type RestartDrainParticipant = {
  drain(budgetMs: number): Promise<RestartDrainReport>;
  release(): void | Promise<void>;
};

type DrainState = { participants: Map<string, RestartDrainParticipant>; active: boolean };

const KEY = Symbol.for("openclaw.restartDrain");

function state(): DrainState {
  const g = globalThis as Record<symbol, DrainState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { participants: new Map(), active: false };
    g[KEY] = s;
  }
  return s;
}

export function registerRestartDrainParticipant(
  id: string,
  participant: RestartDrainParticipant,
): () => void {
  state().participants.set(id, participant);
  return () => {
    if (state().participants.get(id) === participant) {
      state().participants.delete(id);
    }
  };
}

export function isRestartDrainActive(): boolean {
  return state().active;
}

export type RestartDrainResult = {
  ms: number;
  byParticipant: Record<string, RestartDrainReport>;
  held: number;
  ended: number;
  unfinished: number;
};

const EMPTY: RestartDrainReport = { held: [], ended: [], unfinished: [] };

export async function drainForRestart(budgetMs: number): Promise<RestartDrainResult> {
  const s = state();
  s.active = true;
  const startedAt = Date.now();
  const entries = [...s.participants.entries()];
  const reports = await Promise.all(
    entries.map(async ([id, p]) => {
      try {
        return [id, await p.drain(Math.max(0, budgetMs))] as const;
      } catch {
        return [id, EMPTY] as const;
      }
    }),
  );
  const byParticipant = Object.fromEntries(reports);
  const sum = (k: keyof RestartDrainReport) =>
    reports.reduce((n, [, r]) => n + (r[k]?.length ?? 0), 0);
  return {
    ms: Date.now() - startedAt,
    byParticipant,
    held: sum("held"),
    ended: sum("ended"),
    unfinished: sum("unfinished"),
  };
}

/** The restart was called off: every held turn goes on as if nothing happened. */
export async function releaseRestartDrain(): Promise<void> {
  const s = state();
  s.active = false;
  await Promise.all(
    [...s.participants.values()].map(async (p) => {
      try {
        await p.release();
      } catch {
        // a participant that cannot release must not keep the others held
      }
    }),
  );
}

// ── `preparing`: prompts acked whose run has not started yet ─────────────────────────────────────

/**
 * FORK 2026-10-01 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b; bug-log.md [chat-divergence] cause 6).
 * The runner participants know a turn only once its run is live. Between chat.send's ack and that
 * moment a prompt can spend seconds to minutes in media and link understanding, the preflight
 * compaction or a memory flush. On 2026-09-30 a staged-build restart drained `held=1 ended=0
 * unfinished=0` (the held run was another session's bridge worker) and stopped while prompt a247f622
 * was still in a memory-flush compaction, and nothing re-ran it after boot.
 *
 * A tracker is that span's participant. Its owner tracks a prompt from the ack until the prompt's run
 * starts or until the prompt no longer needs a run of its own (steered, backlogged or refused,
 * aborted, settled). `drain(budget)` waits, within the budget, until nothing is preparing, counting
 * prompts acked while it waits. It reports the ones that left as `ended` and the ones still preparing
 * at the deadline as `unfinished`, and logs each of those once, through the logger tracked with it:
 *   restart drain (preparing): UNFINISHED key=<promptKey> sessionKey=<sessionKey> preparingMs=<ms>
 * It holds nothing, so `release` has nothing to let go of.
 *
 * KNOWN LIMIT, the 2026-09-30 case itself: a preparation that makes a model call of its own (the
 * memory flush is an embedded run) is held at that call like any run that starts during a drain.
 * The prompt behind it cannot leave preparation, so the drain waits out its whole budget and then
 * reports the prompt; the prompt is still lost, but no longer silently. Not waiting would need the
 * flush not to be held, which belongs to the reply pipeline, not to this participant.
 *
 * State lives on the tracker; only the registration goes through this file's global key. chat.ts
 * creates one tracker and registers it when it loads, so a drain run from any copy of this module
 * finds it, and no copy of this module can replace it (see the vitest note at the end of the file).
 */
export type PreparingPrompt = {
  /** The prompt's idempotency key (chat.send's runId). */
  promptKey: string;
  sessionKey: string;
  /** When the prompt was acked, in ms since the epoch. */
  since: number;
};

/** Where an unfinished prompt's line goes: the owner's own logger (chat.send: the gateway's). */
export type PreparingPromptLog = { warn(message: string): void };

export type PreparingPromptTracker = {
  /**
   * Track one prompt. The returned release drops only this entry and may be called any number of
   * times. A prompt with no key is not tracked.
   */
  track(params: {
    promptKey: string;
    sessionKey: string;
    since?: number;
    log: PreparingPromptLog;
  }): () => void;
  /** The prompts still preparing, oldest first (copies). */
  list(): PreparingPrompt[];
  /** The participant's drain (see above). */
  drain(budgetMs: number): Promise<RestartDrainReport>;
  participant: RestartDrainParticipant;
};

/** The id chat.send's tracker registers under: its report is `byParticipant.preparing`. */
export const PREPARING_PARTICIPANT_ID = "preparing";

/** Node fires a setTimeout delay above 2^31-1 ms after 1 ms; OPENCLAW_RESTART_DRAIN_MS is free. */
const MAX_TIMER_MS = 2_147_483_647;

type PreparingEntry = PreparingPrompt & { log: PreparingPromptLog };

export function createPreparingPromptTracker(): PreparingPromptTracker {
  const prompts = new Set<PreparingEntry>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    // A listener only ever deletes itself, which a Set allows mid-iteration.
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A drain's bookkeeping must never break the send whose change woke it.
      }
    }
  };

  const track: PreparingPromptTracker["track"] = (params) => {
    const promptKey = typeof params.promptKey === "string" ? params.promptKey.trim() : "";
    if (!promptKey) {
      return () => {};
    }
    const entry: PreparingEntry = {
      promptKey,
      sessionKey: typeof params.sessionKey === "string" ? params.sessionKey.trim() : "",
      since:
        typeof params.since === "number" && Number.isFinite(params.since)
          ? params.since
          : Date.now(),
      log: params.log,
    };
    prompts.add(entry);
    notify();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      prompts.delete(entry);
      notify();
    };
  };

  const drain = (budgetMs: number): Promise<RestartDrainReport> =>
    new Promise<RestartDrainReport>((resolve) => {
      const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 0;
      // Every prompt preparing at any moment of this drain, so one acked and placed while it waits
      // is reported too.
      const seen = new Set<PreparingEntry>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      function settle(): void {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        listeners.delete(onChange);
        const left = [...prompts];
        // Resolve first: a log sink that throws must not leave the drain hanging.
        resolve({
          held: [],
          ended: [...seen].filter((entry) => !prompts.has(entry)).map((entry) => entry.promptKey),
          unfinished: left.map((entry) => entry.promptKey),
        });
        const now = Date.now();
        for (const entry of left) {
          try {
            entry.log.warn(
              `restart drain (preparing): UNFINISHED key=${entry.promptKey} sessionKey=${entry.sessionKey || "-"} preparingMs=${Math.max(0, now - entry.since)} — acked, its run never started; a stop loses it`,
            );
          } catch {
            // logging is best-effort
          }
        }
      }
      function onChange(): void {
        for (const entry of prompts) {
          seen.add(entry);
        }
        if (prompts.size === 0) {
          settle();
        }
      }
      listeners.add(onChange);
      onChange();
      if (!settled) {
        timer = setTimeout(settle, Math.min(budget, MAX_TIMER_MS));
      }
    });

  return {
    track,
    list: () =>
      [...prompts].map(({ promptKey, sessionKey, since }) => ({ promptKey, sessionKey, since })),
    drain,
    participant: {
      drain,
      // It holds nothing: a prompt that left preparation is held, or not, by its runner's participant.
      release: () => {},
    },
  };
}

export const __testing = {
  reset() {
    const s = state();
    s.participants.clear();
    s.active = false;
  },
};

// Under vitest's non-isolated runner a worker re-evaluates every module for each test file, while
// the participants map lives on globalThis and survives. chat.ts registers `preparing` when it
// loads, so a test file that left a chat.send dispatch pending forever (chat.dedup.test.ts) would
// make every later drain in that worker wait out its whole budget (server-close.test.ts drains
// under fake timers and would hang). A file that loads chat.ts registers a fresh tracker after this
// runs. Never in production: there this module is evaluated before chat.ts registers, and a second
// copy loaded later must not drop the live registration.
if (process.env.VITEST) {
  state().participants.delete(PREPARING_PARTICIPANT_ID);
}
