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
};

export type RetryLifecycleDeps = {
  /** The session currently rendered on screen (app.ts's global `sessionKey`). */
  viewedKey: string;
  /** `sessionKey` of every tab this client hosts, including the viewed one. */
  tabKeys: readonly (string | null)[];
  /** app.ts's `sessionKeyMatches`: short (`tinker:A`) vs canonical (`agent:main:tinker:A`). */
  keyMatches: (evtKey: string, refKey: string) => boolean;
};

export type RetryLifecycleAction =
  | { kind: "none" }
  | { kind: "schedule"; sessionKey: string; retryKind: RetryKind | null; retryAfterSec?: number }
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
 */
export function resolveRetryKey(evtKey: string, deps: RetryLifecycleDeps): string | null {
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

  if (p.state === "final") {
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
  };
}
