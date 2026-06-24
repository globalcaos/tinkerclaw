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
 *   - `hasActiveRunForSession` — a live run object exists for this session;
 *   - `streamRunId` — a stream is currently delta-ing;
 *   - `sending` — the optimistic "a turn is starting" flag, set by send() the INSTANT the user hits
 *     enter, BEFORE the first phase:start/delta registers a run or a streamRunId. Including it closes
 *     the turn-START gap where a fast second prompt — typed in that pre-registration window — would
 *     otherwise be pushed straight into messages[] and then have the turn's own bubbles land after it.
 *
 * Pure so the gate can be unit-tested (the send() handler in app.ts is an un-testable browser entry).
 */
export function shouldQueue(state: {
  hasActiveRunForSession: boolean;
  streamRunId: string | null | undefined;
  sending: boolean;
}): boolean {
  return state.hasActiveRunForSession || state.streamRunId != null || state.sending;
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
