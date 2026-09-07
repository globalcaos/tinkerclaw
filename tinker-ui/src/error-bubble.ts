// FORK 2026-08-24 — bug: `API Error: 529 Overloaded…` rendered as a plain, left-aligned
// assistant bubble instead of a centered orange error with a retry clock.
//
// WHY THIS MODULE EXISTS (it is the bug, not a tidy-up).
// app.ts renders an assistant turn through TWO sibling paths — one for legacy string
// `content`, one for the `content: [{type:"text"}]` block array the gateway actually sends —
// and each carried its OWN hand-maintained boolean deciding "is this bubble an error?".
// The two drifted: the string path grew `API Error:` + `socket connection was closed`
// clauses on 2026-07-17, the block-array path never did. Every real provider error arrives
// as a block array, so the clause that was written to catch exactly this case sat on the
// path that never sees it. A 529 therefore rendered as if Jarvis had *answered* "API Error:
// 529 Overloaded", with no error styling, no recoverability class, and no retry.
//
// One predicate, imported by both paths, so the next clause added cannot land on one side
// only. Pure and DOM-free on purpose (sibling of retry-policy.ts / retry-lifecycle.ts): it
// is also the rule the retry lifecycle consults to decide whether a FINAL turn was really a
// recoverable failure wearing an answer's clothes.

import { classifyRecoverable, type RetryKind } from "./retry-policy.js";

/**
 * Text longer than this cannot be an error bubble, however it starts.
 *
 * The guard keeps a real answer that merely QUOTES an error ("the log shows `API Error:
 * 529`, which means…") out of the error branch — and, more importantly now, stops such an
 * answer from arming an auto-retry that would re-send the user's turn.
 */
export const ERROR_BUBBLE_MAX_LEN = 400;

export type ErrorBubbleFlags = {
  /** app.ts's `_isError` — an error the client itself minted and already judged terminal. */
  isError?: boolean;
  /** Structured backend `reason`, when one rode along with the error. */
  reason?: string;
};

export type ErrorBubbleVerdict = {
  /** true → orange bubble + the auto-retry ladder owns it. false → terminal red bubble. */
  recoverable: boolean;
  retryKind: RetryKind | null;
};

// "⚠️ Agent failed" and the variation-selector-less "⚠ Agent failed". `\s*` where the old
// `startsWith` had a hard space: the server's own unwrapper is `/^\s*API Error:/i`, so a
// leading newline is a shape this text genuinely takes.
const AGENT_FAILED_RE = /^\s*⚠️?\s*Agent failed/;
const API_ERROR_RE = /^\s*API Error:/i;

/**
 * Is this assistant text an error REPORT rather than an answer?
 *
 * Union of the clauses the two render paths had between them, which is the point: neither
 * path had all of them.
 */
export function isErrorBubbleText(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  // Unbounded markers: these strings are never part of a legitimate answer.
  if (AGENT_FAILED_RE.test(text)) {
    return true;
  }
  if (text.includes("Previous run is still shutting down")) {
    return true;
  }
  if (text.includes("All models failed")) {
    return true;
  }
  // Length-guarded markers: phrases an answer could plausibly quote.
  if (text.length >= ERROR_BUBBLE_MAX_LEN) {
    return false;
  }
  if (API_ERROR_RE.test(text)) {
    return true;
  }
  if (text.includes("socket connection was closed unexpectedly")) {
    return true;
  }
  return false;
}

/**
 * The whole verdict for one assistant bubble: null when it is an ordinary answer, otherwise
 * whether the failure is one the system can ride out.
 *
 * `isError` (app.ts's `_isError`) short-circuits to RED by construction. Every site that sets
 * it has already decided the error is terminal — the surfaced-error branch sets it only in
 * its `!recoverable` arm, and the ladder sets it on the "gave up after 6 retries" bubble.
 * Re-classifying that text would repaint "🛑 Gave up … (Overloaded)" orange and imply a
 * retry that is, by definition, never coming.
 */
export function classifyErrorBubble(
  text: unknown,
  flags: ErrorBubbleFlags = {},
): ErrorBubbleVerdict | null {
  if (flags.isError === true) {
    return { recoverable: false, retryKind: null };
  }
  if (!isErrorBubbleText(text)) {
    return null;
  }
  const cls = classifyRecoverable(flags.reason, text as string);
  return { recoverable: cls.recoverable, retryKind: cls.kind };
}

/**
 * Pull the assistant text out of a `chat` payload's `message`, which arrives as either a bare
 * string or the `content: [{type:"text", text}]` block array — the same two shapes that grew
 * the divergent render paths this module unifies.
 */
export function assistantTextOfPayloadMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((b) => (b as { type?: unknown })?.type === "text")
    .map((b) => {
      const t = (b as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    })
    .join("\n");
}
