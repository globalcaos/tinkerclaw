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
