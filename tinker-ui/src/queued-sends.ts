// FORK 2026-06-08 — bug "queued prompts stick forever + show in every tab".
//
// Pure (DOM-free, global-free) helpers for the "queued send" lifecycle, extracted from app.ts so
// the tab-scoping + settle rules can be unit-tested (app.ts itself is an un-testable browser entry).
//
// A "queued send" is a user message the UI deliberately held OUT of messages[] because the session
// had a turn in flight when the user pressed enter (see send() / pendingQueuedSends in app.ts). It
// renders as a TRAILING bubble until a terminal releases it. Trailing is a placement, not a claim:
// since prompt-queue.md step U2 its badge comes from prompt-state.ts and nothing draws the word
// "queued" (deferral is a placement and nothing else, PQ-8). WHICH terminal releases WHICH entry is step U3's rule (PQ-7, "terminals are keyed"):
// see `chatTerminalScope` and `settleQueuedSession` at the bottom of this file.
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

import type { PromptStateInputs } from "./prompt-state.js";

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
 *
 * FORK 2026-09-24 — ITS CALLER (prompt-queue.md §7 step U4; gap C4, which pinned this function as
 * dead code). app.ts `strandedPromptIds` hands it the viewed session's OUTBOX entries, each as the
 * queue entry it would have been (`_queuedSession` = its session, `ts` = its typed time), and the
 * verdict feeds prompt-state.ts `gatewayHolderFacts`: one of the facts that together derive LOST
 * for a session row with no `pendingPrompts` report (the fallback; since 2026-09-25 a row that
 * carries one backs LOST without this age bound).
 * So "the UI must act" means SURFACE, never settle: a stranded prompt reads LOST with Resend and
 * Dismiss, and nothing is re-sent or dropped until the owner clicks one (PQ-9, PQ-12).
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

// ─── U3 — terminals keyed by prompt ────────────────────────────────────────────────────────────
//
// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 and §7 step U3 (PQ-7 "terminals are
// keyed"; contradiction C2).
//
// THE DEFECT. A prompt typed during a running turn is steered into that turn or backlogged behind
// it by the gateway, and its own chat.send then finishes WITHOUT starting a run and broadcasts a
// `final` for the prompt's key at once (chat.ts, the `!agentRunStarted` branch). This module read
// every terminal as "this SESSION's turn is over", so that early final released every deferred
// prompt of the session while the host turn was still running. They landed above the host's
// remaining answer, which is the 2026-06-19 bug C coming back by another door. app.ts also stamped
// `sessionEndedAt` and closed the host's timing block on it.
//
// THE RULE. A terminal ends only what it names:
//   - a `final` carrying a `steered` / `backlogged` disposition (gateway G2) names ONE prompt by its
//     key, which is its runId, the bubble's `_clientMsgId` and the gateway idempotencyKey (PQ-1). It
//     ends no run. STEERED commits that one prompt in place, because it IS part of the running turn
//     now. BEHIND leaves it trailing. Nothing else moves;
//   - the terminal of a follow-up run that gateway G3 linked to its prompt keys (its `followup`
//     start event) releases exactly those keys, and so does that start event itself;
//   - every other terminal is TODAY'S session-wide one. That is the old-gateway rule (§6.3: an
//     absent field keeps today's behaviour). It is also the fallback that keeps a BEHIND prompt from
//     being stranded when its link never arrived (a dropped socket frame): the next unlinked
//     terminal of its session releases it.
//
// KNOWN LIMIT. Two prompts backlogged behind the SAME turn are both released by that turn's
// terminal, so the second one is drawn above the first one's answer. That is still better than
// before U3, where both were released mid-turn by their own early finals.

/** §6.3 — the dispositions that make a `final` NOT a terminal: the prompt was PLACED, not answered.
 *  `dropped` is deliberately absent. agent-runner.ts reports it only for a heartbeat, and chat.send
 *  never sets `isHeartbeat`, so no Tinker prompt can carry it; a final that did would take today's
 *  session path rather than a rule nothing exercises. */
export type PlacementDisposition = "steered" | "backlogged";

/** The agent-event stream gateway step G3 links a follow-up run on (followup-runner.ts). It is not
 *  `lifecycle`, on purpose: the gateway stamps a model onto every lifecycle event, and this UI reads
 *  a model-bearing lifecycle event as "the model has started", the opposite of a pre-model link. */
export const FOLLOWUP_STREAM = "followup";

/** What ONE chat terminal names (see the rule above). */
export type TerminalScope =
  /** Today's rule: the session's turn is over, so every entry of the session is released. */
  | { kind: "session" }
  /** A disposition `final`. It names one prompt and ends no run. */
  | { kind: "prompt"; key: string; disposition: PlacementDisposition }
  /** A linked follow-up run's start or terminal: exactly these prompt keys. */
  | { kind: "linked"; keys: readonly string[] };

const SESSION_SCOPE: TerminalScope = Object.freeze({ kind: "session" as const });

/** The entry's prompt key: the bubble id send() mints, which is also the gateway idempotencyKey
 *  and so the runId of that prompt's early `final` (PQ-1). */
const promptKeyOf = (entry: QueuedEntry): string | undefined =>
  typeof entry._clientMsgId === "string" && entry._clientMsgId !== ""
    ? (entry._clientMsgId as string)
    : undefined;

/**
 * Classify one `chat` event: null when it is not a terminal (a delta), otherwise the scope it names.
 * `followupLinks` maps a follow-up runId to the prompt keys it answers (`rememberFollowupLink`).
 * Only a `final` can carry a placement: an `error` or an `aborted` always ends something.
 */
export function chatTerminalScope(
  event: { state?: unknown; runId?: unknown; disposition?: unknown } | null | undefined,
  followupLinks: ReadonlyMap<string, readonly string[]>,
): TerminalScope | null {
  const state = event?.state;
  if (state !== "final" && state !== "error" && state !== "aborted") {
    return null;
  }
  const rawRunId = event?.runId;
  const runId = typeof rawRunId === "string" ? rawRunId : "";
  const disposition = event?.disposition;
  if (state === "final" && (disposition === "steered" || disposition === "backlogged")) {
    // A missing runId names nothing: `key: ""` matches no entry, so it releases nothing. It is
    // still not a session terminal, because the disposition says the prompt was placed.
    return { kind: "prompt", key: runId, disposition };
  }
  const keys = runId ? followupLinks.get(runId) : undefined;
  if (keys && keys.length > 0) {
    return { kind: "linked", keys };
  }
  return SESSION_SCOPE;
}

/**
 * Gateway G3's link, read off an agent event: `{ stream: "followup", runId, data: { phase: "start",
 * promptKeys } }` becomes the follow-up run and the prompt keys it answers. null for any other
 * event. Keys are trimmed the way the gateway trims them, and de-duplicated. An event with no usable
 * key links nothing: G3 emits none without a key, so it comes from an older or foreign producer.
 */
export function followupRunLink(
  event: { stream?: unknown; runId?: unknown; data?: unknown } | null | undefined,
): { runId: string; keys: string[] } | null {
  const runId = event?.runId;
  if (event?.stream !== FOLLOWUP_STREAM || typeof runId !== "string" || runId === "") {
    return null;
  }
  const data = event.data as { phase?: unknown; promptKeys?: unknown } | null | undefined;
  if (!data || data.phase !== "start" || !Array.isArray(data.promptKeys)) {
    return null;
  }
  const keys: string[] = [];
  for (const raw of data.promptKeys as unknown[]) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key !== "" && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys.length > 0 ? { runId, keys } : null;
}

/** How many follow-up links are kept. A link is NOT deleted at its run's terminal, because one run
 *  can emit more than one (an `error` a fallback model survives, then its `final`), and each must
 *  stay keyed. So this cap is what bounds the map. */
export const FOLLOWUP_LINKS_MAX = 256;

/** Record a follow-up run's link. A re-announced run moves to the newest slot, and the oldest link
 *  is evicted past `max` (a Map iterates in insertion order). */
export function rememberFollowupLink(
  links: Map<string, readonly string[]>,
  runId: string,
  keys: readonly string[],
  max: number = FOLLOWUP_LINKS_MAX,
): void {
  links.delete(runId);
  links.set(runId, [...keys]);
  while (links.size > max) {
    const oldest = links.keys().next();
    if (oldest.done) {
      break;
    }
    links.delete(oldest.value);
  }
}

/** Record a prompt the gateway folded into `session`'s running turn (`steered`). §2: STEERED →
 *  ANSWERED when "host turn R ends", so that session's next RUN terminal ends it. */
export function addSessionPromptKey(
  map: Map<string, string[]>,
  session: string | undefined,
  key: string,
): void {
  if (!session || !key) {
    return;
  }
  const keys = map.get(session) ?? [];
  if (!keys.includes(key)) {
    keys.push(key);
  }
  map.set(session, keys);
}

/** Drain and return every key recorded for `session`. Short and canonical session keys match, like
 *  every other predicate in this module. */
export function takeSessionPromptKeys(
  map: Map<string, string[]>,
  session: string | undefined,
  matches: SessionKeyMatcher,
): string[] {
  if (!session) {
    return [];
  }
  const taken: string[] = [];
  for (const [owner, keys] of map) {
    if (owner === session || matches(owner, session)) {
      for (const key of keys) {
        if (!taken.includes(key)) {
          taken.push(key);
        }
      }
      map.delete(owner);
    }
  }
  return taken;
}

/**
 * The ONE fact a run's terminal records on each prompt keyed to that run (one steered into it, or
 * one of a linked follow-up's keys): final → answered, error → failed, aborted → cancelled. These
 * are facts, never a state name (msg-order.ts); prompt-state.ts derives the state from them. null
 * for a non-terminal.
 */
export function terminalPromptFacts(state: unknown): Partial<PromptStateInputs> | null {
  switch (state) {
    case "final":
      return { answered: true };
    case "error":
      return { failed: true };
    case "aborted":
      return { cancelled: true };
    default:
      return null;
  }
}

/**
 * FORK 2026-09-25 — prompt-queue.md §2 and §6.1 (PQ-6 "exactly one terminal per prompt", PQ-7
 * "terminals are keyed"). What a chat terminal proves about the ONE prompt whose OWN run it ends.
 *
 * chat.send runs a prompt under its own idempotencyKey (chat.ts: `clientRunId = p.idempotencyKey`),
 * so a terminal whose runId is a prompt's key ends THAT prompt:
 *   - `final` with no disposition → answered (§2 RUNNING → ANSWERED);
 *   - `aborted` → cancelled (§2 → CANCELLED: a stop, and on sessions.delete / sessions.reset the
 *     `aborted` gateway G1 sends for each backlogged key);
 *   - `error` → nothing: it is not terminal while a fallback model can still carry the run;
 *   - a `final` carrying a disposition → nothing: it PLACED the prompt (`chatTerminalScope`, U3).
 *
 * THE DEFECT the `aborted` half ends (U3's known limit). `terminalPromptFacts` was recorded only on
 * the prompts KEYED to a run (steered into it, or a linked follow-up's keys: app.ts
 * `endPromptsKeyedToRun`), and a stop is a SESSION-scoped terminal that names no keys. So the HOST
 * prompt, whose own run the stop ended, recorded nothing. One that left no transcript row (stopped
 * before its user row landed) was then acked, unproven and held by nobody, and U4 derived LOST,
 * with a Resend that would re-send the prompt the owner had just stopped.
 *
 * `key` is the runId. A runId that names no prompt (a follow-up run's own id) matches no bubble, so
 * the caller's record is a no-op there.
 */
export function ownRunTerminal(
  event: { state?: unknown; runId?: unknown; disposition?: unknown } | null | undefined,
): { key: string; facts: Partial<PromptStateInputs> } | null {
  const runId = event?.runId;
  if (typeof runId !== "string" || runId === "") {
    return null;
  }
  if (event?.state === "aborted") {
    return { key: runId, facts: { cancelled: true } };
  }
  if (event?.state !== "final") {
    return null;
  }
  const disposition = event.disposition;
  return disposition === undefined || disposition === null
    ? { key: runId, facts: { answered: true } }
    : null;
}

/**
 * PQ-6 — has this prompt already recorded its own run's terminal? The FIRST one stands. The chat
 * abort controller lives until chat.send's dispatch returns (prompt-queue.md §4, holder C), which
 * is after the run's first `final`, so a stop in that window broadcasts `aborted` for a run that
 * has answered. Recorded, it would turn ANSWERED into "stopped · not answered" (CANCELLED outranks
 * ANSWERED in prompt-state.ts). `failed` is not counted: an own run never records it.
 */
export function ownRunTerminalRecorded(
  facts: Readonly<Partial<PromptStateInputs>> | null | undefined,
): boolean {
  return facts?.answered === true || facts?.cancelled === true;
}

/** What a linked follow-up run's START proves about each of its prompts: the run that answers it
 *  has begun (§2 BEHIND → PREPARING, the fact prompt-state.ts reads for "the linked follow-up run
 *  starts"), and a gateway holder of it demonstrably exists, so it is not LOST. */
export const FOLLOWUP_STARTED_FACTS: Readonly<Partial<PromptStateInputs>> = Object.freeze({
  pending: "preparing" as const,
  noGatewayHolder: false,
});

export interface SettleResult {
  /** entries that remain queued: other sessions' entries, and this session's entries the terminal
   *  does not name. */
  remaining: QueuedEntry[];
  /** entries the caller should splice into the live transcript NOW, in order — non-empty ONLY when
   *  the ended session is the one currently viewed. */
  commit: QueuedEntry[];
}

/**
 * Settle the queue because a terminal for `endedSession` arrived. `scope` is WHICH of that
 * session's entries it releases (`chatTerminalScope`). Omitted, it is today's session-wide rule.
 *
 * - Entries that do NOT belong to `endedSession` are left untouched in `remaining`.
 * - Of the session's entries, the scope picks the ones it releases:
 *     session → all of them (today's rule, and the whole old-gateway path);
 *     prompt  → `steered`: only the entry whose key the final names. `backlogged`: none. A BEHIND
 *               prompt stays trailing until the follow-up run linked to it starts;
 *     linked  → exactly the entries whose key is in `keys`.
 *   The rest stay in `remaining`, still deferred.
 * - A released entry is un-queued (the `_queuedSession` marker is stripped) and then:
 *     - if `isViewed` (the ended session is the tab on screen) → returned in `commit` so the caller
 *       appends them to messages[] in chronological order (they become committed user messages,
 *       exactly as a server refresh would show them); otherwise
 *     - (background tab) → dropped entirely. The server transcript — re-fetched by loadChat when
 *       that tab is next opened — is authoritative and already contains the processed prompt, so
 *       re-inserting it here would duplicate it.
 *
 * Idempotent: a released entry is gone, so a second terminal of the same scope (the gateway sends
 * two finals per agent-started run) is a no-op.
 */
export function settleQueuedSession(
  queue: QueuedEntry[],
  endedSession: string | undefined,
  isViewed: boolean,
  matches: SessionKeyMatcher,
  scope: TerminalScope = SESSION_SCOPE,
): SettleResult {
  if (!endedSession) {
    return { remaining: queue, commit: [] };
  }
  const releases = (entry: QueuedEntry): boolean => {
    if (scope.kind === "prompt") {
      return scope.disposition === "steered" && promptKeyOf(entry) === scope.key;
    }
    if (scope.kind === "linked") {
      const key = promptKeyOf(entry);
      return key !== undefined && scope.keys.includes(key);
    }
    return true;
  };
  const remaining: QueuedEntry[] = [];
  const commit: QueuedEntry[] = [];
  for (const entry of queue) {
    const qs = sessionOf(entry);
    const belongs = !!qs && (qs === endedSession || matches(qs, endedSession));
    if (!belongs || !releases(entry)) {
      remaining.push(entry);
      continue;
    }
    delete entry._queuedSession;
    if (isViewed) {
      commit.push(entry);
    }
  }
  return { remaining, commit };
}
