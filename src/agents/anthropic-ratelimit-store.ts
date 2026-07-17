/**
 * FORK: Module-level store for the latest Anthropic rate limit utilization
 * captured from HTTP response headers. Updated on every Anthropic API
 * response via the custom fetch wrapper in anthropic-vertex-stream.ts.
 *
 * Consumers: embedded-agent-subscribe.handlers.lifecycle.ts (emits snapshot on
 * lifecycle "end" events), and any HTTP route that wants to expose live
 * utilization to the Tinker UI.
 */

export type RateLimitSnapshot = {
  /** 5-hour utilization (0–100) */
  h5: number;
  /** 7-day utilization (0–100) */
  d7: number;
  /** 7-day sonnet-specific utilization (0–100), if present */
  d7Sonnet?: number;
  /** Representative claim window, e.g. "five_hour" or "seven_day" */
  claim: string;
  /** Timestamp when this snapshot was captured */
  ts: number;
};

let latest: RateLimitSnapshot | null = null;

export function updateRateLimitSnapshot(snapshot: RateLimitSnapshot): void {
  latest = snapshot;
}

export function getRateLimitSnapshot(): RateLimitSnapshot | null {
  return latest;
}

/**
 * FORK 2026-07-09: capture unified rate-limit utilization from an Anthropic HTTP
 * response's headers into the module store. Safe to call on ANY response — a
 * no-op when the headers are absent, and never throws (usage-tracking must not
 * break a live request). Called by every Anthropic transport (direct-API AND
 * claude-code) so budget.usage has a token-free live source even when the
 * OAuth-usage poll fails (e.g. a dead tracking-profile refresh token).
 */
export function captureRateLimitHeaders(headers: Headers): void {
  try {
    const h5Raw = headers.get("anthropic-ratelimit-unified-5h-utilization");
    const d7Raw = headers.get("anthropic-ratelimit-unified-7d-utilization");
    if (h5Raw == null && d7Raw == null) {
      return;
    }
    const h5 = h5Raw != null ? parseFloat(h5Raw) : 0;
    const d7 = d7Raw != null ? parseFloat(d7Raw) : 0;
    const d7SonnetRaw = headers.get("anthropic-ratelimit-unified-7d-sonnet-utilization");
    const claim = headers.get("anthropic-ratelimit-unified-representative-claim") || "five_hour";
    latest = {
      h5: Number.isFinite(h5) ? h5 : 0,
      d7: Number.isFinite(d7) ? d7 : 0,
      d7Sonnet: d7SonnetRaw != null ? parseFloat(d7SonnetRaw) || 0 : undefined,
      claim,
      ts: Date.now(),
    };
  } catch {
    /* usage-tracking is best-effort — never let it surface into the request path */
  }
}
