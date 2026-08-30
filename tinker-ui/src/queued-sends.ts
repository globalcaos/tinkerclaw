// FORK 2026-06-08 — bug "queued prompts stick forever + show in every tab".
//
// Pure (DOM-free, global-free) helpers for the "queued send" lifecycle, extracted from app.ts so
// the tab-scoping + settle rules can be unit-tested (app.ts itself is an un-testable browser entry).
//
// A "queued send" is a user message the UI deliberately held OUT of messages[] because the session
// had a turn in flight when the user pressed enter (see send() / pendingQueuedSends in app.ts). It
// renders as a trailing grey "queued" bubble until the in-flight turn ends.
//
// THE BUG these helpers fix:
//   pendingQueuedSends was a single GLOBAL array with no per-entry session identity, and its ONLY
//   drain sat behind the chat handler's viewed-session guard. So:
//     • symptom #2 — the render loop drew the whole global array into whatever tab was on screen,
//       so a queued bubble appeared in EVERY tab; and
//     • symptom #1 — a prompt queued in tab A was only un-queued by A's chat-final; if the user had
//       switched to another tab, that event was dropped by the viewed-session guard and the bubble
//       stuck as "queued" forever even though the gateway had already processed it.
//
// THE FIX: tag every queued entry with the session it was queued under (_queuedSession), then
//   (a) render only the entries belonging to the tab on screen, and
//   (b) settle a session's entries when THAT session's turn ends, independently of which tab is
//       currently viewed.

export type QueuedEntry = Record<string, unknown>;

/**
 * FORK 2026-06-19 (bug C — "a prompt typed mid-turn jumps above the answer"): decide whether a
 * freshly-typed user send must be QUEUED (held OUT of messages[] and rendered as a trailing bubble)
 * rather than pushed into the transcript immediately.
 *
 * A send is queued whenever the viewed session has a turn IN FLIGHT, detected by ANY of:
 *   - `hasFreshActiveRunForSession` — a run object exists for this session AND it has been heard
 *     from recently enough to still be believed. THE CALLER MUST PASS A FRESHNESS-CHECKED VALUE:
 *     `sessionHasFreshClientRun` (run-state.ts, added alongside this change), or
 *     `clientRunIsFresh(run, now)` directly — both apply that module's single 90 s bound,
 *     `RUN_STALE_MS`. A run object alone is NOT evidence of life;
 *   - `streamRunId` — a stream is currently delta-ing;
 *   - `sending` — the optimistic "a turn is starting" flag, set by send() the INSTANT the user hits
 *     enter, BEFORE the first phase:start/delta registers a run or a streamRunId. Including it closes
 *     the turn-START gap where a fast second prompt — typed in that pre-registration window — would
 *     otherwise be pushed straight into messages[] and then have the turn's own bubbles land after it.
 *
 * FORK 2026-08-26 — WHY THE FIELD WAS RENAMED (bug "my last two prompts were never sent, and I had
 * no way to tell"). This predicate is a ONE-WAY DOOR: return true and the prompt leaves the composer
 * for a queue whose only drain is a chat terminal for that session — an event a run that already
 * died unobserved will never emit. The field used to be `hasActiveRunForSession`, and app.ts fed it
 * a bare `activeRuns.values().some((r) => sessionKeyMatches(r.sessionKey))` — the mere EXISTENCE of
 * a run object. run-state.ts (lane C) documents why that is not liveness: an entry is orphaned
 * whenever a lifecycle:end is dropped by the viewed-session gate, and nothing sweeps a MAIN-run
 * ghost. One ghost therefore swallowed every later prompt in silence — no `chat.send`, no error, no
 * change to the bubble. The rename is deliberately source-INCOMPATIBLE so that every call site has
 * to be re-examined rather than quietly keep feeding the value that costs the user their message.
 *
 * ⚠ THAT INCOMPATIBILITY IS A REVIEW GATE, NOT A COMPILER ONE. As of 2026-08-26 `tinker-ui/` is in
 * NO typecheck project — no tsconfig at the repo root includes it, it has none of its own, and
 * `vite build` is esbuild transpile-only with no checker plugin. So a call site left passing the old
 * key does NOT fail any build: the renamed field simply arrives `undefined`, the gate degenerates to
 * `streamRunId != null || sending`, and a mid-turn prompt silently stops being queued — bug C again,
 * from the very change meant to fix its sibling. Grep `shouldQueue` by hand when you touch this
 * signature; nothing else will.
 *
 * The boolean logic is UNCHANGED, on purpose. This is the GATE, not the oracle: re-deriving
 * freshness in here would give the queue a second opinion about liveness, which is exactly the
 * mistake run-state.ts exists to end ("ONE PREDICATE — no surface re-derives liveness").
 *
 * And freshness narrows the window without closing it — a run can go stale AFTER a prompt has been
 * queued, and the drain is still an event that will never arrive. `strandedQueuedEntries` below is
 * the escape hatch for that residue.
 *
 * Pure so the gate can be unit-tested (the send() handler in app.ts is an un-testable browser entry).
 */
export function shouldQueue(state: {
  hasFreshActiveRunForSession: boolean;
  streamRunId: string | null | undefined;
  sending: boolean;
}): boolean {
  // FORK 2026-08-28 — THE REVIEW GATE GREW TEETH. The paragraph above predicted this failure in
  // words and it happened anyway: app.ts kept passing the pre-rename key `hasActiveRunForSession`,
  // the renamed field arrived `undefined`, and the gate silently degenerated to
  // `streamRunId != null || sending` for two days. A prose warning cannot fail a build; this can.
  //
  // Absent is not the same as false. A caller that omits the field has DRIFTED — it is not telling
  // us the session is idle, it is not telling us anything — and the whole point of the 2026-08-26
  // rename was that such a caller must be re-examined rather than quietly served. Throwing makes the
  // unit test below, and any dev-console session, say so in one line.
  //
  // Deliberately NOT fail-safe here, because the safe direction is genuinely ambiguous: `false`
  // re-opens 2026-06-19 bug C (the prompt jumping above the answer), `true` parks a prompt behind a
  // drain that may never arrive — the 2026-08-26 lost-prompt bug. There is no safe default for "I
  // don't know", so the gate refuses to guess. The SEND PATH is where the user's text must survive
  // an unexpected throw, and app.ts owns that guard (see the try/catch around this call): a
  // prompt-losing exception is app.ts's problem to contain, not a reason for this predicate to
  // invent an answer.
  if (typeof state.hasFreshActiveRunForSession !== "boolean") {
    throw new TypeError(
      "shouldQueue: `hasFreshActiveRunForSession` is missing — a call site still passes the " +
        "pre-2026-08-26 key `hasActiveRunForSession`, so the queue gate has lost its run-liveness " +
        "term and is running on `streamRunId || sending` alone.",
    );
  }
  return state.hasFreshActiveRunForSession || state.streamRunId != null || state.sending;
}

/** Matches two session keys, tolerant of short ("tinker:A") vs canonical ("agent:main:tinker:A")
 *  forms — pass app.ts `sessionKeyMatches` here. */
export type SessionKeyMatcher = (a: string | undefined, b: string | undefined) => boolean;

const sessionOf = (entry: QueuedEntry): string | undefined =>
  typeof entry._queuedSession === "string" ? (entry._queuedSession as string) : undefined;

/** Does this queued entry belong to `viewedKey` (i.e. should it render in that tab)? */
export function queuedBelongsToSession(
  entry: QueuedEntry,
  viewedKey: string | undefined,
  matches: SessionKeyMatcher,
): boolean {
  const qs = sessionOf(entry);
  if (!qs || !viewedKey) {
    return false;
  }
  return qs === viewedKey || matches(qs, viewedKey);
}

/** The subset of `queue` that belongs to `viewedKey` — what the active tab should render. */
export function queuedForSession(
  queue: QueuedEntry[],
  viewedKey: string | undefined,
  matches: SessionKeyMatcher,
): QueuedEntry[] {
  return queue.filter((e) => queuedBelongsToSession(e, viewedKey, matches));
}

/**
 * FORK 2026-08-26 — how long a queued entry may sit before it counts as STRANDED rather than merely
 * waiting.
 *
 * Deliberately LOOSER than run-state's 90 s `RUN_STALE_MS`, and the gap is the point: a run that
 * merely goes quiet gets its full staleness window to come back and settle its own queue the normal
 * way, and only 30 s after that window has closed do we call the prompts behind it abandoned rather
 * than delayed. The two bounds therefore never race to opposite verdicts about the same session.
 */
export const QUEUED_STRANDED_MS = 120_000;

/** When was this entry queued? `_promptStartedAt` is what send() stamps on the outgoing user
 *  message (app.ts); `ts` is the outbox/journal spelling of the same instant. ONLY A FINITE NUMBER
 *  COUNTS — absent, NaN and an ISO string all yield `undefined`, and an entry we cannot date is
 *  never reported stranded. There is no honest age for it, and a guessed one would raise "this was
 *  never sent" on evidence we do not have — or re-send a prompt the gateway is already running. */
const queuedAtMs = (entry: QueuedEntry): number | undefined => {
  for (const key of ["_promptStartedAt", "ts"] as const) {
    const v = entry[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
  }
  return undefined;
};

/**
 * The entries for `viewedKey` that are STRANDED: queued more than `maxAgeMs` ago with no fresh run
 * left for them to be waiting on. A non-empty result means the UI must act — surface them, or
 * re-send — because nothing else in this module ever will.
 *
 * `hasFreshActiveRunForSession` is the same caller-supplied, freshness-checked boolean `shouldQueue`
 * takes (see its contract above), and it is a HARD short-circuit rather than a per-entry filter:
 * while a turn really is running, a queued prompt is correct at ANY age, and releasing it early
 * would re-create the 2026-06-19 bug C this queue exists to prevent (the prompt jumping above the
 * answer it was queued behind). A slow turn must never read as a lost prompt.
 *
 * Read-only and non-mutating: it IDENTIFIES, it does not settle, drain or re-send — that decision
 * belongs to app.ts. The entries come back BY REFERENCE, so a caller can settle them by identity.
 * `now` is injected rather than read from the clock so the bound is testable without a fake timer.
 */
export function strandedQueuedEntries(
  queue: readonly QueuedEntry[],
  viewedKey: string | undefined,
  matches: SessionKeyMatcher,
  now: number,
  hasFreshActiveRunForSession: boolean,
  maxAgeMs: number = QUEUED_STRANDED_MS,
): QueuedEntry[] {
  if (hasFreshActiveRunForSession) {
    return [];
  }
  return queue.filter((entry) => {
    if (!queuedBelongsToSession(entry, viewedKey, matches)) {
      return false;
    }
    const at = queuedAtMs(entry);
    // Strictly older than the bound ("more than maxAgeMs ago"); an undateable entry never qualifies.
    return at !== undefined && now - at > maxAgeMs;
  });
}

export interface SettleResult {
  /** entries that remain queued (they belong to OTHER sessions). */
  remaining: QueuedEntry[];
  /** entries the caller should splice into the live transcript NOW, in order — non-empty ONLY when
   *  the ended session is the one currently viewed. */
  commit: QueuedEntry[];
}

/**
 * Settle the queue because `endedSession`'s turn has ended.
 *
 * - Entries that do NOT belong to `endedSession` are left untouched in `remaining`.
 * - Entries that DO belong to `endedSession` are un-queued (the `_queued` / `_queuedSession`
 *   markers are stripped) and then:
 *     - if `isViewed` (the ended session is the tab on screen) → returned in `commit` so the caller
 *       appends them to messages[] in chronological order (they become committed user messages,
 *       exactly as a server refresh would show them); otherwise
 *     - (background tab) → dropped entirely. The server transcript — re-fetched by loadChat when
 *       that tab is next opened — is authoritative and already contains the processed prompt, so
 *       re-inserting it here would duplicate it.
 *
 * Idempotent w.r.t. a session: once its entries are settled they are gone, so a second call (e.g.
 * a later lifecycle event for the same run) is a no-op.
 */
export function settleQueuedSession(
  queue: QueuedEntry[],
  endedSession: string | undefined,
  isViewed: boolean,
  matches: SessionKeyMatcher,
): SettleResult {
  if (!endedSession) {
    return { remaining: queue, commit: [] };
  }
  const remaining: QueuedEntry[] = [];
  const commit: QueuedEntry[] = [];
  for (const entry of queue) {
    const qs = sessionOf(entry);
    const belongs = !!qs && (qs === endedSession || matches(qs, endedSession));
    if (!belongs) {
      remaining.push(entry);
      continue;
    }
    delete entry._queued;
    delete entry._queuedSession;
    if (isViewed) {
      commit.push(entry);
    }
  }
  return { remaining, commit };
}
