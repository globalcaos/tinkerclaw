/**
 * Quota-window exhaustion predicate — the SINGLE place that decides
 * "is this provider's token window exhausted right now".
 *
 * Browser-safe and dependency-free ON PURPOSE: `src/shared` is the proven
 * client+server home (tinker-ui/src/app.ts already imports
 * ../../src/shared/fortune-cookies.js, and tinker-ui/vite.config.ts opens
 * server.fs.allow for exactly that). No node:* imports, no gateway types —
 * both sides must be able to import this module unchanged.
 *
 * CLOCK DISCIPLINE — `nowMs` is ALWAYS an argument; this module never calls
 * Date.now(). The browser re-evaluates on a 60s tick against data up to
 * 5 minutes stale, while the gateway reads a 10-minute snapshot behind a
 * 30-minute HTTP cache. A hidden clock inside this module would let the two
 * sides disagree about the same window; an explicit `nowMs` keeps every
 * decision a pure function of its inputs.
 */

/** One provider token window (e.g. the 5-hour or the 7-day window). */
export type QuotaWindow = { usedPercent: number; resetAtMs?: number };

/** A window is exhausted when its utilization reaches this percent. */
export const EXHAUSTED_PERCENT = 100;

/**
 * Normalize a producer-supplied reset timestamp to epoch-ms.
 *
 * Accepts every shape the producers actually emit:
 * - ISO string with a numeric offset AND microseconds
 *   (real sample: "2026-09-03T16:00:00.019217+00:00")
 * - ISO string with Z
 * - already-epoch-ms number (passed through)
 * - null / undefined / garbage => undefined — NEVER NaN.
 */
export function toResetMs(v: string | number | null | undefined): number | undefined {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v !== "string") {
    return undefined;
  }
  const trimmed = v.trim();
  if (trimmed === "") {
    return undefined;
  }
  // Producers emit microsecond fractions. V8 happens to parse them, but
  // stricter Date implementations (this module also runs in browsers) may
  // not — clamp the fraction to milliseconds so every engine agrees.
  const normalized = trimmed.replace(/(\.\d{3})\d+/, "$1");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * exhausted  <=>  usedPercent >= 100  AND  (resetAtMs === undefined OR resetAtMs > nowMs)
 *
 * The `resetAtMs === undefined => STILL exhausted` half is DELIBERATE and
 * load-bearing — do NOT "fix" it to the opposite. Copilot, Gemini and
 * OpenAI-spend publish a utilization number with NO rollover timestamp; the
 * honest reading of "100% used, no known reset" is "exhausted until the
 * number drops", not "assume it already reset".
 *
 * A resetAtMs in the PAST means the window has rolled over even if the
 * (stale) usedPercent still reads 100 — so it is NOT exhausted.
 */
export function windowExhausted(w: QuotaWindow, nowMs: number): boolean {
  return w.usedPercent >= EXHAUSTED_PERCENT && (w.resetAtMs === undefined || w.resetAtMs > nowMs);
}

/**
 * First exhausted window in the GIVEN order, or null when none is.
 * Callers pass the shortest window first (e.g. 5-hour before 7-day) so the
 * returned window is the BINDING one — the one whose reset actually
 * unblocks the provider soonest.
 */
export function providerExhausted(ws: readonly QuotaWindow[], nowMs: number): QuotaWindow | null {
  for (const w of ws) {
    if (windowExhausted(w, nowMs)) {
      return w;
    }
  }
  return null;
}
