import { describe, expect, test } from "vitest";
import { MAX_RETRY_AFTER_SECONDS, resolveRetryAfterSeconds } from "./rate-limit-reset.js";

// FORK 2026-09-07 (the user: "If a model like now Sol is overflowing, the most natural thing is to
// retry, right?") — the numbers below are verbatim from the 2026-09-07 15:00 incident.
//
// The client retry ladder (tinker-ui/src/retry-policy.ts) is 3s/10s/30s/2m/7m/15m and already
// honours a provider wait via `Math.max(step, retryAfterSec * 1000)`. It has never been given
// one: both gateway emitters omit `retryAfter` on purpose ("the frontend backoff ladder owns the
// timing"). Against a 262-MINUTE window that ladder burns all six attempts in ~25 minutes and
// gives up four hours early. The provider told us the answer in the error text both times.
const MADRID_1500 = Date.parse("2026-09-07T13:00:41.564Z"); // 15:00:41 Europe/Madrid

describe("resolveRetryAfterSeconds", () => {
  test("reads the ChatGPT usage-limit wording (the Sol case)", () => {
    const s = resolveRetryAfterSeconds(
      "⚠️ You have hit your ChatGPT usage limit (plus plan). Try again in ~262 min.",
      MADRID_1500,
    );
    expect(s).toBe(262 * 60);
  });

  test("reads the Claude session-limit wall clock in its own timezone (the opus case)", () => {
    // "resets 3:10pm (Europe/Madrid)" at 15:00:41 Madrid is 559 seconds away, not tomorrow.
    const s = resolveRetryAfterSeconds(
      "You've hit your session limit · resets 3:10pm (Europe/Madrid)",
      MADRID_1500,
    );
    expect(s).toBeGreaterThan(500);
    expect(s).toBeLessThan(620);
  });

  test("a wall clock already passed today rolls to tomorrow, never to a negative wait", () => {
    // 15:00:41 Madrid, resets 9:05am → tomorrow morning, ~18h. Beyond the cap, so refused
    // rather than silently parking a turn for most of a day.
    const s = resolveRetryAfterSeconds(
      "You've hit your session limit · resets 9:05am (Europe/Madrid)",
      MADRID_1500,
    );
    expect(s === undefined || s > 0).toBe(true);
  });

  test("reads an absolute ISO reset", () => {
    const now = Date.parse("2026-09-07T12:00:00Z");
    expect(resolveRetryAfterSeconds("quota resets 2026-09-07T12:57:53.032291+00:00", now)).toBe(
      3473,
    );
  });

  test("reads plain durations in seconds, minutes and hours", () => {
    expect(resolveRetryAfterSeconds("Rate limited. Try again in 30 seconds.", MADRID_1500)).toBe(
      30,
    );
    expect(resolveRetryAfterSeconds("retry after 45s", MADRID_1500)).toBe(45);
    expect(resolveRetryAfterSeconds("try again in 2 hours", MADRID_1500)).toBe(7200);
    expect(resolveRetryAfterSeconds("Try again in ~5 minutes", MADRID_1500)).toBe(300);
  });

  test("a reset already in the past yields nothing — the window has rolled", () => {
    const now = Date.parse("2026-09-07T13:00:00Z");
    expect(resolveRetryAfterSeconds("resets 2026-09-07T12:00:00Z", now)).toBeUndefined();
  });

  test("refuses absurd waits rather than parking a turn forever", () => {
    expect(resolveRetryAfterSeconds("try again in 400 hours", MADRID_1500)).toBeUndefined();
    expect(MAX_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });

  test("returns undefined when the text carries no timing at all", () => {
    expect(
      resolveRetryAfterSeconds("Provider is in cooldown (all profiles unavailable)", MADRID_1500),
    ).toBeUndefined();
    expect(resolveRetryAfterSeconds("", MADRID_1500)).toBeUndefined();
    expect(resolveRetryAfterSeconds(undefined, MADRID_1500)).toBeUndefined();
  });

  test("does not mistake an unrelated number for a wait", () => {
    expect(resolveRetryAfterSeconds("HTTP 529 Overloaded", MADRID_1500)).toBeUndefined();
  });
});
