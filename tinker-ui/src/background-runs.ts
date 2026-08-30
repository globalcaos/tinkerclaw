// FORK 2026-08-16 (the architect: "the progress indicator in the neurocoin tab does not work, again" ->
// "when a tab is out of focus, the progress indicator should still show").
//
// THE BLIND SPOT BOTH LANES SHARED. A tab you are not looking at had NO source of truth that a run
// had started, so it stayed dark for the whole turn:
//
//   CLIENT LANE — the lifecycle admission gate in app.ts (`p?.stream === "lifecycle" &&
//     p.data?.model`) hard-returns for any session that is neither the viewed one nor a subagent of
//     it, and that return sits ABOVE `activeRuns.set`. So `activeRuns` is empty for a background tab
//     BY CONSTRUCTION. sessionHasActiveRuns' own header already said so in as many words
//     ("STRUCTURALLY BLIND ... a genuinely running cron, WhatsApp or other-tab session could NEVER
//     glow") and resolved it by making the SERVER row the owner — which is right, and which is why
//     this module does not touch that gate.
//   SERVER LANE — `sessions[]` carries the gateway's authoritative run set (`row.run`), and the
//     gateway populates it on 100% of rows (verified on the wire 2026-08-16: the NeuroCoin row read
//     `run:{live:true,count:1}` while the chat showed nothing). But `sessions[]` has exactly ONE
//     writer, `loadSessions()`, which runs on connect, at turn END, on the first message in a tab,
//     and on abort — never while a turn is in flight. So the 5s liveness clock faithfully repaints a
//     snapshot taken BEFORE the turn began.
//
// That is the same trap as docs/2026-08-15-chat-thinking-indicator-missing-while-tab-glows.md, one
// level down: that fix gave the chat a repaint TRIGGER and left the DATA it repaints stale. A
// poll-only value that nothing polls cannot be corrected by repainting it more often.
//
// THE EVENTS WERE NEVER MISSING. `broadcast("agent", ...)` (src/gateway/server-chat.ts) fans out to
// every authorized connection, NOT per session — which is exactly how the EEG "all" scope already
// charts other sessions' effort. This browser receives the background run's lifecycle:start and
// throws it away. This module catches it on the way past, WITHOUT admitting the event into any of
// the viewed-tab state it would corrupt (`sending`, `streamProvider`, the pre-model window, chat
// bubbles). The admission gate keeps its meaning; it just stops being the only reader.
//
// Deliberately NOT a second opinion about liveness. These entries are fed into the SAME resolver as
// `activeRuns`, as ordinary client-lane evidence, so run-state.ts remains the ONE PREDICATE and the
// four surfaces keep agreeing. They inherit its 90s freshness bound, and an entry is removed the
// moment its own lifecycle end/error arrives or its session reports a terminal chat event.

/** A run observed for a session this tab is not viewing. Shaped to satisfy run-state's `ClientRun`. */
export type BackgroundRun = {
  sessionKey: string;
  model: string;
  provider: string;
  startedAt: number;
  lastEventAt: number;
};

/** The lifecycle payload fields this module reads. Everything is `unknown` because it arrives
 *  straight off the wire and app.ts does no validation before the admission gate. */
export type LifecycleEventLike = {
  runId?: unknown;
  sessionKey?: unknown;
  phase?: unknown;
  model?: unknown;
  modelProvider?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Fold one lifecycle event for a NON-VIEWED session into the map.
 *
 * `end` and `error` remove the run. Everything else (start, and any mid-turn phase that names a
 * model) upserts it and refreshes its freshness stamp — a long turn keeps emitting, so a live run
 * never ages out while a genuinely dead one goes silent and is dropped by the 90s bound.
 *
 * Returns true when the map changed in a way a surface would render differently, so the caller can
 * repaint on the same tick instead of waiting for the next liveness clock.
 */
export function noteBackgroundRunEvent(
  runs: Map<string, BackgroundRun>,
  evt: LifecycleEventLike,
  now: number,
  providerOf: (model: string) => string,
): boolean {
  const runId = str(evt.runId);
  const sessionKey = str(evt.sessionKey);
  if (!runId || !sessionKey) {
    // A run we cannot key or attribute is not evidence about any particular tab. Dropping it is
    // strictly better than lighting the wrong one.
    return false;
  }
  const phase = str(evt.phase);
  if (phase === "end" || phase === "error") {
    return runs.delete(runId);
  }
  const existing = runs.get(runId);
  if (existing) {
    existing.lastEventAt = now;
    return false;
  }
  const model = str(evt.model);
  runs.set(runId, {
    sessionKey,
    model,
    provider: str(evt.modelProvider) || providerOf(model),
    startedAt: now,
    lastEventAt: now,
  });
  return true;
}

/**
 * Refresh every background run belonging to `sessionKey`.
 *
 * Called from the same unconditional activity bump that already keeps `activeRuns` fresh. Without
 * it, a background turn that emits only text deltas (no further model-bearing lifecycle event)
 * would age past the 90s freshness bound and its tab would go dark MID-TURN — the precise failure
 * this module exists to remove, arriving 90 seconds late instead of immediately.
 */
export function touchBackgroundRuns(
  runs: Map<string, BackgroundRun>,
  sessionKey: string,
  now: number,
  matches: (runKey: string, refKey: string) => boolean,
): void {
  if (!sessionKey) {
    return;
  }
  for (const run of runs.values()) {
    if (matches(run.sessionKey, sessionKey)) {
      run.lastEventAt = now;
    }
  }
}

/**
 * Drop every background run for a session that has just reported a terminal chat event.
 *
 * A second, independent removal path on purpose. `lifecycle:end` is the precise signal, but it is
 * exactly the kind of event this codebase has repeatedly been observed to drop (see the "STUCK-ON
 * IN TWO CLICKS" note on sessionHasActiveRuns). `chat` final/error/aborted is recorded for EVERY
 * session, above every viewed gate, so it is the one end-of-turn fact this browser can always see.
 * Belt and braces beats a tab that shimmers until reload.
 */
export function dropBackgroundRunsForSession(
  runs: Map<string, BackgroundRun>,
  sessionKey: string,
  matches: (runKey: string, refKey: string) => boolean,
): boolean {
  if (!sessionKey) {
    return false;
  }
  let changed = false;
  for (const [runId, run] of runs) {
    if (matches(run.sessionKey, sessionKey)) {
      runs.delete(runId);
      changed = true;
    }
  }
  return changed;
}
