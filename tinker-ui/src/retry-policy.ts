// Pure, DOM-free policy module for client-side recoverable-error auto-retry.
// Spec: docs/superpowers/specs/2026-06-24-recoverable-error-retry-design.md (Component 2).
// No DOM, no globals, no timers — just classification + backoff math so it is
// trivially unit-testable. The app.ts controller composes these primitives.

/** Backoff ladder in ms: 3s -> 10s -> 30s -> 2m -> 7m -> 15m, then stop (6 attempts). */
export const RETRY_LADDER_MS = [3000, 10000, 30000, 120000, 420000, 900000];

export type RetryKind = "rate_limit" | "quota" | "overloaded" | "unavailable";

/**
 * Decide whether a surfaced error is recoverable and, if so, which class.
 * Prefers a structured backend `reason`; falls back to matching the human
 * error text. recoverable === true iff a kind was determined.
 */
export function classifyRecoverable(
  reason?: string,
  errorText?: string,
): { recoverable: boolean; kind: RetryKind | null } {
  // 1) Trust a structured reason when it names a known kind.
  if (
    reason === "rate_limit" ||
    reason === "quota" ||
    reason === "overloaded" ||
    reason === "unavailable"
  ) {
    return { recoverable: true, kind: reason };
  }

  // 2) Fall back to text matching. Order matters: quota is a more specific
  //    signal than a bare rate-limit, so check it first.
  const text = errorText ?? "";
  if (/quota/i.test(text)) {
    return { recoverable: true, kind: "quota" };
  }
  if (/rate.?limit|tpm|rpm|\b429\b/i.test(text)) {
    return { recoverable: true, kind: "rate_limit" };
  }
  if (/overloaded|temporarily unavailable|draining for restart|HTTP 5(02|03|29)/i.test(text)) {
    return { recoverable: true, kind: "overloaded" };
  }

  return { recoverable: false, kind: null };
}

/**
 * Next backoff delay in ms for a 0-based `attempt` index, honoring a provider
 * `Retry-After` (seconds) when it is larger than the ladder step. Returns
 * `null` once the ladder is exhausted (attempt >= ladder length).
 */
export function nextRetryDelayMs(attempt: number, retryAfterSec?: number): number | null {
  if (attempt >= RETRY_LADDER_MS.length) return null;
  const step = RETRY_LADDER_MS[attempt];
  return Math.max(step, (retryAfterSec ?? 0) * 1000);
}

/** Human-friendly wait string: "3s", "30s", "2m", "7m", "15m", "1m 30s". */
export function formatWait(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

/** Short label for the warning bubble, by retry kind. */
export function labelFor(kind: RetryKind | null): string {
  switch (kind) {
    case "quota":
      return "Quota exceeded";
    case "rate_limit":
      return "Rate limited";
    case "overloaded":
      return "Overloaded";
    case "unavailable":
      return "Temporarily unavailable";
    default:
      return "Error";
  }
}
