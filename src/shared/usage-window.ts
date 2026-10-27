/**
 * FORK 2026-10-05 — which usage window a rate-limit or usage-limit message names.
 *
 * A provider's own limit that resets in hours or days (Claude's rolling 5-hour "session" window,
 * the weekly window) cannot be ridden out by a retry: the client ladder tops out at 15 minutes
 * (tinker-ui retry-policy.ts RETRY_LADDER_MS), so every retry re-sends the prompt into the same
 * wall. Measured 2026-10-03 22:08 to 10-04 00:30: the weekly limit, marked recoverable, re-sent one
 * prompt 169 times. A short burst limit ("too many requests", per-minute) clears within about a
 * minute and stays retryable.
 *
 * Pure, no imports: read by the error envelope (src/fork/error-envelope.ts), the typed turn outcome
 * (src/fork/turn-outcome.ts), the claude-cli import (src/gateway/cli-session-history.claude.ts) and
 * the Tinker UI retry ladder (tinker-ui/src/retry-lifecycle.ts), so all four agree on one wording.
 */

export type UsageWindow = "session" | "weekly" | "five-hour" | "burst";

/** The window the provider's own text names, or null when it names none. First match wins. */
export function usageWindowOf(raw: unknown): UsageWindow | null {
  if (typeof raw !== "string" || !raw) {
    return null;
  }
  const s = raw.toLowerCase();
  // Claude Code calls the rolling 5-hour window a "session limit".
  if (/session limit|hit your session/.test(s)) {
    return "session";
  }
  if (/weekly|per week|7[\s-]?day/.test(s)) {
    return "weekly";
  }
  if (/5[\s-]?hour|\b5h\b|five[\s-]?hour/.test(s)) {
    return "five-hour";
  }
  if (/per minute|requests per|tokens per|too many requests|\b429\b/.test(s)) {
    return "burst";
  }
  return null;
}

/** True when the text names a window no automatic retry can outlast (hours or days). */
export function isLongUsageWindow(raw: unknown): boolean {
  const w = usageWindowOf(raw);
  return w === "session" || w === "weekly" || w === "five-hour";
}
