// FORK 2026-08-04 — bug "auto-retry dies on tab switch and leaves an immortal fake countdown".
//
// Pure (DOM-free, global-free) decision for the recoverable-error auto-retry LIFECYCLE, extracted
// from app.ts so the per-session keying can be unit-tested (app.ts itself is an un-testable browser
// entry). Sibling of retry-policy.ts, which owns the ladder MATH; this module owns the question
// "given this chat event, whose retry track moves, and which way?".
//
// THE BUG these helpers fix — structurally the SAME one queued-sends.ts fixed on 2026-06-08, one
// lifecycle over. The two retry-lifecycle calls (schedule on a surfaced recoverable error, clear on
// success) both lived BELOW onEvent's non-viewed-session early return and both keyed off the GLOBAL
// `sessionKey` (the tab on screen) instead of the EVENT's session. So rate-limiting a tab and then
// switching away — the normal thing to do while a 7m or 15m ladder step elapses:
//   • killed the ladder after ONE attempt, because the next surfaced error never re-scheduled;
//   • never retired the orange "retry N/6, retrying in 7m…" bubble, so loadChat() re-injected that
//     dead countdown into the transcript on EVERY later open, forever, even though the turn had long
//     since succeeded; and
//   • left a live retryState entry that pinned the 1 Hz tick (updatePrefrontalTree +
//     querySelectorAll) for the life of the page — it only stops when retryState is empty.
//
// THE FIX: resolve the EVENT's sessionKey to the local key of the tab that hosts it, and decide the
// action from the event alone, so the controller can run on BOTH sides of the viewed-session gate.

import { classifyErrorBubble } from "./error-bubble.js";
// FORK 2026-09-29 (U9): the TYPED successor to the text heuristics below. One guard, one kind map,
// shared with the renderer, so the countdown and the bubble can never disagree about one turn.
import { isTurnOutcome, retryKindForOutcome } from "./outcome-bubble.js";
import { classifyRecoverable, type RetryKind } from "./retry-policy.js";

/** The subset of a `chat` WS payload this decision reads. Everything is `unknown`: the payload is
 *  off the wire and app.ts hands it over untyped. */
export type RetryLifecycleEvent = {
  sessionKey?: unknown;
  state?: unknown;
  reason?: unknown;
  errorMessage?: unknown;
  retryAfter?: unknown;
  /**
   * FORK 2026-08-24 — the assistant text of a `final` turn, lifted out of `payload.message` by
   * app.ts. Not every failure arrives as `state:"error"`: a 529 came back as a perfectly ordinary
   * `state:"final"` whose entire body was "API Error: 529 Overloaded…". Judged only by `state`,
   * that turn read as a SUCCESS and cancelled the ladder, so the user got no orange bubble, no
   * countdown, and no retry — they had to notice and re-ask by hand.
   */
  finalText?: unknown;
  /**
   * FORK 2026-09-29 (U9) — `payload.message.outcome`, lifted out by app.ts alongside `finalText`.
   * The TYPED successor to the text match above: the gateway classifies the failure once and the
   * verdict rides on the final's message. A `final` that carries one is a FAILURE wearing the
   * success state word, so it must neither cancel the ladder nor count as the turn that ended it.
   */
  finalOutcome?: unknown;
  /**
   * FORK 2026-10-01 — bug-log.md `[chat-divergence]` cause 3, "retries nobody asked for". The run
   * this event reports on. It was not a field of this type at all, which is the whole defect: the
   * decision read sessionKey, state and error text, so ANY failure riding on a session this client
   * hosts armed the ladder — including a failure of a run this page never sent.
   *
   * It is also the failed run's PROMPT key. `chat.send` uses the prompt's `idempotencyKey` AS the
   * run id (src/gateway/server-methods/chat.ts: `const clientRunId = p.idempotencyKey`), which is
   * what makes ownership decidable by an exact id match rather than by a name-shape guess.
   */
  runId?: unknown;
};

export type RetryLifecycleDeps = {
  /** The session currently rendered on screen (app.ts's global `sessionKey`). */
  viewedKey: string;
  /** `sessionKey` of every tab this client hosts, including the viewed one. */
  tabKeys: readonly (string | null)[];
  /** app.ts's `sessionKeyMatches`: short (`tinker:A`) vs canonical (`agent:main:tinker:A`). */
  keyMatches: (evtKey: string, refKey: string) => boolean;
  /**
   * FORK 2026-10-01 — "did THIS page send the run `runId`?" (app.ts `isOwnRunId`, which matches the
   * id against the prompt keys the page holds: a user bubble's `_clientMsgId`, a transcript row's
   * served `idempotencyKey`, a deferred queued send, an outbox entry, or one of the ladder's own
   * fires; and, through gateway G3's `followup` link, a follow-up run that answers one of them).
   *
   * REQUIRED, not optional, and called UNGUARDED below. An optional predicate is indistinguishable
   * at runtime from a working one that always says yes — it would silently restore the behaviour
   * that re-sent the owner's prompt three times on 2026-09-26. app.ts and this module's own test
   * file are the only two consumers (verified by grep). Nothing type-checks tinker-ui in the build
   * (vite strips the types), so the type gates an editor or a tsc run only; at runtime a deps object
   * built without this throws a TypeError on the first event that names a run, loud where an
   * optional check would be quiet. The wiring itself is pinned by a structural test
   * (retry-lifecycle.test.ts, "app.ts own-run wiring").
   */
  isOwnRun: (runId: string) => boolean;
};

export type RetryLifecycleAction =
  | { kind: "none" }
  | {
      kind: "schedule";
      sessionKey: string;
      retryKind: RetryKind | null;
      retryAfterSec?: number;
      /**
       * FORK 2026-09-29 (U9) — "arm the ladder only if this session has no track yet".
       *
       * `scheduleRetry` is NOT idempotent: every call pushes a NEW orange countdown bubble (app.ts:
       * "One NEW orange warning per attempt") and resets `nextRetryAt`. A recoverable failure now
       * reaches the client TWICE — as `state:"error"`, which already schedules, and again as the
       * backstop `final` carrying the typed outcome. Scheduling on both would show two countdowns
       * for one failure and restart the clock. Set ONLY on the outcome-derived final path; the
       * 2026-08-24 `finalText` path stays unflagged, so a failure that arrives ONLY as a final
       * still arms a fresh ladder exactly as before.
       */
      onlyIfIdle?: boolean;
      /**
       * FORK 2026-10-01 (bug-log `[chat-divergence]` cause 3) — the id of the run that FAILED, when
       * the event named one. It is that run's PROMPT key too (see `RetryLifecycleEvent.runId`), so
       * app.ts can re-send the prompt THIS run was carrying instead of the newest bubble in the
       * transcript — the choice that put a 75-minute-old prompt back on the wire three times.
       * Absent when the event carried no runId, which is exactly when app.ts must keep its old
       * `lastUserTurnFor` choice.
       */
      runId?: string;
    }
  | { kind: "cancel"; sessionKey: string };

const NONE: RetryLifecycleAction = { kind: "none" };

/**
 * Can a client-side retry track be OWNED for this session key?
 *
 * Subagent / ACP child sessions are driven by their parent turn and never own a tab, so re-sending
 * "the last user turn" into one is meaningless. They were excluded implicitly before this extraction
 * (their chat events return from an earlier branch of onEvent); keep it explicit rather than start
 * client-side retrying them by accident.
 */
export function isRetryOwnableSessionKey(evtKey: string): boolean {
  return !!evtKey && !evtKey.includes(":subagent:") && !evtKey.includes(":acp:");
}

/**
 * Resolve a WS event's sessionKey to the LOCAL key form the rest of the app uses for that session
 * (the viewed key, or the owning tab's `sessionKey`).
 *
 * Session keys travel in BOTH a short (`tinker:abc`) and a canonical (`agent:main:tinker:abc`) form
 * — that is precisely why `sessionKeyMatches` exists — while app.ts's `retryState` is a plain Map
 * compared by ===. Without this normalization an entry scheduled from an event carrying the
 * canonical form would never be found by the `abort()` / `send()` / `/clear` cancels, which all use
 * the tab's local key: the retry would quietly survive its own cancel and burn tokens.
 *
 * Returns null when NO tab hosts the session — a cron / WhatsApp / other-client turn is not this
 * client's to retry, and inventing a client-side ladder for it would be new behavior.
 *
 * FORK 2026-10-01 — takes only the three lookups it reads. `isOwnRun` became a REQUIRED dep of the
 * lifecycle decision, and a key resolver has no run to ask about.
 */
export function resolveRetryKey(
  evtKey: string,
  deps: Pick<RetryLifecycleDeps, "viewedKey" | "tabKeys" | "keyMatches">,
): string | null {
  if (!evtKey) {
    return null;
  }
  const { viewedKey, tabKeys, keyMatches } = deps;
  if (viewedKey && (evtKey === viewedKey || keyMatches(evtKey, viewedKey))) {
    return viewedKey;
  }
  for (const tabKey of tabKeys) {
    if (tabKey && keyMatches(evtKey, tabKey)) {
      return tabKey;
    }
  }
  return null;
}

/**
 * THE decision: what this `chat` event does to its own session's retry track.
 *
 * - `state:"error"` with a recoverable classification → schedule/advance that session's ladder.
 * - `state:"final"` → the turn SUCCEEDED: cancel the ladder and retire its countdown bubbles.
 * - anything else (`delta`, `aborted`, an unrecoverable error) → nothing.
 *
 * `aborted` is deliberately not handled: a server-side abort is neither a success nor a recoverable
 * error, and the manual stop paths (`abort()`, the hover "stop retrying" link) already cancel.
 */
export function retryLifecycleAction(
  p: RetryLifecycleEvent | undefined | null,
  deps: RetryLifecycleDeps,
): RetryLifecycleAction {
  if (!p) {
    return NONE;
  }
  const evtKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
  if (!isRetryOwnableSessionKey(evtKey)) {
    return NONE;
  }
  const sessionKey = resolveRetryKey(evtKey, deps);
  if (!sessionKey) {
    return NONE;
  }

  // FORK 2026-10-01 — bug-log.md `[chat-divergence]` cause 3: "repeated prompts, and repeated
  // answers when the model is up".
  //
  // MEASURED: session agent:main:tinker:mugmkh6p, 2026-09-26 10:43–10:58 UTC. Three SUBAGENT
  // announce runs (`announce:v1:agent:main:subagent:…`) hit an openai-codex `(rate_limit)`
  // cooldown. Their chat events carried the OWNER's sessionKey, so `isRetryOwnableSessionKey`
  // above — which only reads the SESSION key — waved them through, and each failure armed the
  // owner's ladder and re-sent a prompt answered 75 minutes earlier under a fresh key
  // (bug-reports/2026-09-26/140450-*, 140451-*, 140454-*: three fires, all carrying
  // `retryOf a6aec32b-cd48-44df-8bd3-37a7e5dd2e83`). The cooldown is the ONLY reason it stopped at
  // three repeated prompts: with the model up, each fire would have re-run the whole task.
  //
  // THE RULE: the ladder only starts or advances for a run THIS page sent. A foreign run is
  // NEITHER a schedule NOR a cancel — its failure is not this page's to retry, and its SUCCESS
  // says nothing about the owner's prompt, so cancelling would retire the countdown of a failure
  // that is still standing (the mirror-image of the same defect).
  //
  // Decidable, not guessed: `chat.send` uses the prompt's `idempotencyKey` as the run id, so
  // ownership is an exact id match against the keys the page holds (`isOwnRun`). A runId-SHAPE
  // rule — "reject ids containing :subagent:" — would have looked green here and covered only the
  // announce prefix that happened to be in front of us.
  //
  // RESIDUAL, named rather than bent: a turn ANOTHER client started (the CLI, WhatsApp, a cron) in
  // a session this page has a tab for no longer arms a client-side ladder here. That is the point.
  // Re-sending "the last user turn on screen" for a run this page did not send is the defect, not
  // a feature being lost.
  //
  // An event with NO runId keeps today's behaviour: pre-fix transcripts and any event the gateway
  // sends without one must not go dark.
  const runId = typeof p.runId === "string" ? p.runId : "";
  if (runId && !deps.isOwnRun(runId)) {
    return NONE;
  }

  if (p.state === "final") {
    // FORK 2026-09-29 (U9): a TYPED outcome on the final's message outranks every text heuristic
    // below — it is the gateway's own verdict on this turn, reached from structured signals. A
    // final that carries one did NOT succeed, so it may never take the `cancel` branch: doing so
    // killed the ladder the surfaced error had just armed (measured live 2026-09-29) and retired
    // the countdown bubbles of a failure that is still standing.
    //   • recoverable → keep the ladder climbing, but `onlyIfIdle` (see the action type): the
    //     `state:"error"` event for this same failure has usually scheduled already, and a second
    //     scheduleRetry would draw a second countdown and restart the clock.
    //   • not recoverable → `none`. Not a success, so nothing is cancelled; not retryable, so
    //     nothing is scheduled. RESIDUAL, named rather than bent: an auth/billing failure on a
    //     FIRE therefore does not stop an already-running ladder, which burns its remaining
    //     attempts. Cancelling on those kinds needs the contract changed, not this line.
    const outcome = p.finalOutcome;
    if (isTurnOutcome(outcome)) {
      if (!outcome.recoverable) {
        return NONE;
      }
      const retryAfterSec =
        typeof outcome.retryAfter === "number" && Number.isFinite(outcome.retryAfter)
          ? outcome.retryAfter
          : typeof p.retryAfter === "number"
            ? p.retryAfter
            : undefined;
      return {
        kind: "schedule",
        sessionKey,
        retryKind: retryKindForOutcome(outcome.kind),
        ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
        onlyIfIdle: true,
        ...(runId ? { runId } : {}),
      };
    }
    // FORK 2026-08-24: a `final` is only a SUCCESS if its body is an answer. When the whole
    // turn is a recoverable provider failure rendered as text, treat it exactly as a surfaced
    // `state:"error"` — advance the ladder — rather than cancelling on the strength of the
    // state word alone. `classifyErrorBubble` is the same predicate the renderer uses to paint
    // the bubble orange, so the countdown and the colour can never disagree about one turn.
    const bubble = classifyErrorBubble(p.finalText);
    if (bubble?.recoverable) {
      return {
        kind: "schedule",
        sessionKey,
        retryKind: bubble.retryKind,
        retryAfterSec: typeof p.retryAfter === "number" ? p.retryAfter : undefined,
        ...(runId ? { runId } : {}),
      };
    }
    return { kind: "cancel", sessionKey };
  }
  if (p.state !== "error") {
    return NONE;
  }

  const errorMessage = typeof p.errorMessage === "string" ? p.errorMessage : "";
  if (!errorMessage) {
    return NONE;
  }
  const cls = classifyRecoverable(
    typeof p.reason === "string" ? p.reason : undefined,
    errorMessage,
  );
  if (!cls.recoverable) {
    return NONE;
  }
  return {
    kind: "schedule",
    sessionKey,
    retryKind: cls.kind,
    retryAfterSec: typeof p.retryAfter === "number" ? p.retryAfter : undefined,
    ...(runId ? { runId } : {}),
  };
}

// ─── WHICH prompt a fire re-sends (FORK 2026-10-01) ──────────────────────────────────────────
//
// The second half of the 2026-09-26 incident, and the half that survives the gate above. Even
// once the ladder only arms for a run this page sent, `lastUserTurnFor` picks the last user bubble
// ON SCREEN — so a fire re-sends whatever is at the bottom of the transcript, which in that
// session was a prompt answered 75 minutes earlier. A run's id IS its prompt's key, so the prompt
// the failed run was carrying is addressable; these helpers are that lookup, pure so it can be
// tested without a DOM.
//
// MECHANISM: code, not a prompt rule. There is a structural producer (every prompt key already
// flows through `_clientMsgId` / the outbox) and the want is "this happens the same way every
// time", so a matcher belongs here rather than in a doc nobody re-reads mid-incident.

/**
 * A prompt row as the page holds it: a user bubble in `messages` (or a background tab's saved
 * copy), a transcript row the gateway served, a deferred queued send, or an outbox entry mapped
 * onto this shape. Every field is `unknown` for the same reason the event type's are — app.ts
 * hands these pages over untyped, and the narrowing belongs here where it can be tested.
 */
export type RetryPromptRow = {
  role?: unknown;
  content?: unknown;
  _temporary?: unknown;
  _clientMsgId?: unknown;
  idempotencyKey?: unknown;
  _retryOf?: unknown;
  retryOf?: unknown;
};

/** The prompt a ladder fire re-sends: its text, and the key of the prompt the OWNER typed. */
export type RetryPromptTarget = { text: string; key?: string };

/** First non-empty string among the candidates, or undefined. */
function firstKey(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/** A prompt row's text, in both shapes app.ts stores (content blocks, or a bare string). */
function promptTextOf(row: RetryPromptRow): string {
  const content = row.content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => (block as { type?: unknown } | null)?.type === "text")
      .map((block) => String((block as { text?: unknown }).text ?? ""))
      .join("\n")
      .trim();
  }
  return typeof content === "string" ? content.trim() : "";
}

/**
 * The PROMPT row whose key is `key`, across every page handed in.
 *
 * Assistant rows and in-flight temporaries are skipped the way `lastUserTurnFor` skips them: only
 * a real user turn names a prompt this page sent, and a temporary bubble's id is a stream cursor.
 */
function promptRowFor(key: string, pages: readonly (readonly unknown[])[]): RetryPromptRow | null {
  for (const page of pages) {
    for (const raw of page) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const row = raw as RetryPromptRow;
      if (row._temporary === true) {
        continue;
      }
      const role = row.role;
      if (typeof role === "string" && role.toLowerCase() !== "user") {
        continue;
      }
      if (firstKey(row._clientMsgId, row.idempotencyKey) === key) {
        return row;
      }
    }
  }
  return null;
}

/**
 * THE own-run predicate, as a pure rule: did one of these pages send the run `runId`?
 *
 * `chat.send` uses the prompt's `idempotencyKey` as the run id, so a run this page sent is one
 * whose id equals a prompt key this page holds. app.ts wires this to every page it has
 * (`isOwnRunId` → `retryPromptPagesAll`), which is why the ladder's OWN fires count as own: each
 * fire draws a bubble under its new key AND writes an outbox entry under the same id.
 *
 * `linkedKeys` (FORK 2026-10-01) — the prompt keys gateway G3 linked to the run, when it is a
 * FOLLOW-UP run: the one that answers a prompt the gateway put BEHIND a running turn. That run is
 * minted under a fresh UUID (src/auto-reply/reply/followup-runner.ts) and names the keys it answers
 * on its `followup` stream (app.ts `followupPromptLinks`). Its id is no prompt key, so without the
 * link every backlogged prompt's run would read as foreign: its rate limit would arm no ladder,
 * and its `final` could not end a ladder whose fire it carried. Identity again, not inference: a
 * link counts only through a key one of these pages holds.
 */
export function pageSentPromptKey(
  runId: unknown,
  pages: readonly (readonly unknown[])[],
  linkedKeys: readonly unknown[] = [],
): boolean {
  if (typeof runId !== "string" || !runId) {
    return false;
  }
  if (promptRowFor(runId, pages) !== null) {
    return true;
  }
  return linkedKeys.some(
    (key) => typeof key === "string" && key.length > 0 && promptRowFor(key, pages) !== null,
  );
}

/**
 * The prompt a fire for the FAILED run `runId` must re-send — its text, and the key of the prompt
 * the owner typed so the fire links there and not to itself.
 *
 * The `_retryOf` / `retryOf` chain is walked to its root: a ladder fire re-sends the original's
 * text under a FRESH key (the original's would be absorbed by the gateway dedupe), so a failed
 * FIRE must resolve back to the prompt behind it. Linking a fire to a fire would chain the ladder
 * onto its own output and lose the owner's prompt as the thing being retried. A cycle (two rows
 * naming each other, which a corrupted store could hold) stops at the first repeat rather than
 * spinning.
 *
 * Returns null when the run names no prompt this page holds — the caller's signal to fall back to
 * today's `lastUserTurnFor` choice rather than send nothing. A G3 follow-up run is one such run:
 * its id is not a prompt key (see `pageSentPromptKey`), so it keeps today's choice.
 */
export function retryPromptForRun(
  runId: unknown,
  pages: readonly (readonly unknown[])[],
): RetryPromptTarget | null {
  if (typeof runId !== "string" || !runId) {
    return null;
  }
  const failed = promptRowFor(runId, pages);
  if (!failed) {
    return null;
  }
  let row = failed;
  let key = firstKey(failed._clientMsgId, failed.idempotencyKey) ?? runId;
  const seen = new Set<string>([key]);
  for (let hop = 0; hop < 32; hop++) {
    const parent = firstKey(row._retryOf, row.retryOf);
    if (!parent || seen.has(parent)) {
      break;
    }
    seen.add(parent);
    // Name the original even when its row is gone from this page: `retryOf` is the link the
    // outbox and the journal record, so the fire stays attached to the owner's prompt either way.
    key = parent;
    const next = promptRowFor(parent, pages);
    if (!next) {
      break;
    }
    row = next;
  }
  const text = promptTextOf(row) || promptTextOf(failed);
  return text ? { text, key } : null;
}
