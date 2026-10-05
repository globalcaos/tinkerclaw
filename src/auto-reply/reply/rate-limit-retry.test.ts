import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRateLimitRetryStateForTest,
  parseRateLimitReset,
  RATE_LIMIT_RETRY_JITTER_MAX_MS,
  RATE_LIMIT_RETRY_JITTER_MIN_MS,
  rearmPersistedRateLimitRetries,
  scheduleRateLimitRetry,
} from "./rate-limit-retry.js";

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

// 2026-09-03T08:00:00Z — 10:00 in Europe/Madrid (CEST, UTC+2).
const SUMMER_NOW = Date.UTC(2026, 8, 3, 8, 0, 0);
// 2026-01-15T08:00:00Z — 09:00 in Europe/Madrid (CET, UTC+1).
const WINTER_NOW = Date.UTC(2026, 0, 15, 8, 0, 0);

let storeDir: string;
let storePath: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SUMMER_NOW);
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-limit-retry-"));
  storePath = path.join(storeDir, "rate-limit-retries.json");
});

afterEach(() => {
  __resetRateLimitRetryStateForTest();
  vi.useRealTimers();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe("parseRateLimitReset", () => {
  it("parses the live session-limit envelope with an explicit timezone", () => {
    expect(
      parseRateLimitReset(
        "You have hit your session limit — resets 11:20am (Europe/Madrid)",
        SUMMER_NOW,
      ),
    ).toBe(Date.UTC(2026, 8, 3, 9, 20, 0));
  });

  it("parses a bare clock time against the default timezone", () => {
    expect(parseRateLimitReset("resets 11:20am", SUMMER_NOW)).toBe(Date.UTC(2026, 8, 3, 9, 20, 0));
  });

  it("parses the 'resets at HH:MMpm' shape", () => {
    expect(parseRateLimitReset("Rate limited · resets at 4:30pm", SUMMER_NOW)).toBe(
      Date.UTC(2026, 8, 3, 14, 30, 0),
    );
  });

  it("parses an explicit calendar date", () => {
    expect(parseRateLimitReset("resets Sep 3, 6pm", SUMMER_NOW)).toBe(
      Date.UTC(2026, 8, 3, 16, 0, 0),
    );
  });

  it("rolls a clock time that has already passed to the next day", () => {
    // 14:00 in Madrid; 11:20am today is behind us.
    const afternoon = Date.UTC(2026, 8, 3, 12, 0, 0);
    expect(parseRateLimitReset("resets 11:20am", afternoon)).toBe(Date.UTC(2026, 8, 4, 9, 20, 0));
  });

  it("honours a timezone named in the message instead of the default", () => {
    expect(parseRateLimitReset("resets 11:20am (UTC)", SUMMER_NOW)).toBe(
      Date.UTC(2026, 8, 3, 11, 20, 0),
    );
  });

  it("uses the zone offset in force on the day, not a fixed one", () => {
    // Winter in Madrid is UTC+1, so 11:20 local is 10:20Z (not 09:20Z).
    expect(parseRateLimitReset("resets 11:20am", WINTER_NOW)).toBe(
      Date.UTC(2026, 0, 15, 10, 20, 0),
    );
  });

  it("refuses a duration, which is not a clock time", () => {
    expect(parseRateLimitReset("resets 5 hours from now", SUMMER_NOW)).toBeUndefined();
    expect(parseRateLimitReset("resets in 2h", SUMMER_NOW)).toBeUndefined();
    expect(parseRateLimitReset("resets 45 minutes from now", SUMMER_NOW)).toBeUndefined();
  });

  it("returns undefined when there is no reset time to parse", () => {
    expect(parseRateLimitReset("You have hit your session limit.", SUMMER_NOW)).toBeUndefined();
    expect(parseRateLimitReset("", SUMMER_NOW)).toBeUndefined();
    expect(parseRateLimitReset(undefined, SUMMER_NOW)).toBeUndefined();
  });
});

describe("scheduleRateLimitRetry", () => {
  it("dispatches the original prompt exactly once, after reset + jitter", async () => {
    const dispatch = vi.fn();
    const armedAt = scheduleRateLimitRetry({
      sessionKey: "agent:main:main",
      runId: "run-1",
      prompt: "keep going",
      resetAt: SUMMER_NOW + 60_000,
      dispatch,
      jitterMs: 20_000,
      storePath,
    });

    expect(armedAt).toBe(SUMMER_NOW + 80_000);
    expect(dispatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(79_000);
    expect(dispatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:main",
      prompt: "keep going",
      runId: "run-1",
    });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("picks jitter inside the 15-45s window when none is supplied", () => {
    const armedAt = scheduleRateLimitRetry({
      sessionKey: "agent:main:jitter",
      prompt: "keep going",
      resetAt: SUMMER_NOW + 60_000,
      dispatch: vi.fn(),
      storePath,
    });
    expect(armedAt).toBeGreaterThanOrEqual(SUMMER_NOW + 60_000 + RATE_LIMIT_RETRY_JITTER_MIN_MS);
    expect(armedAt).toBeLessThanOrEqual(SUMMER_NOW + 60_000 + RATE_LIMIT_RETRY_JITTER_MAX_MS);
  });

  it("arms nothing when the reset is missing or beyond the 6h horizon", () => {
    const dispatch = vi.fn();
    expect(
      scheduleRateLimitRetry({
        sessionKey: "agent:main:main",
        prompt: "keep going",
        resetAt: undefined,
        dispatch,
        storePath,
      }),
    ).toBeUndefined();
    expect(
      scheduleRateLimitRetry({
        sessionKey: "agent:main:main",
        prompt: "keep going",
        resetAt: SUMMER_NOW + 7 * 60 * 60 * 1000,
        dispatch,
        storePath,
      }),
    ).toBeUndefined();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("keeps one timer per session — a newer schedule replaces the older", async () => {
    const dispatch = vi.fn();
    scheduleRateLimitRetry({
      sessionKey: "agent:main:main",
      prompt: "first prompt",
      resetAt: SUMMER_NOW + 60_000,
      dispatch,
      jitterMs: 20_000,
      storePath,
    });
    scheduleRateLimitRetry({
      sessionKey: "agent:main:main",
      prompt: "second prompt",
      resetAt: SUMMER_NOW + 60_000,
      dispatch,
      jitterMs: 20_000,
      storePath,
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.prompt).toBe("second prompt");
  });

  it("allows exactly one automatic retry per turn", async () => {
    const dispatch = vi.fn();
    scheduleRateLimitRetry({
      sessionKey: "agent:main:main",
      prompt: "keep going",
      resetAt: SUMMER_NOW + 60_000,
      dispatch,
      jitterMs: 20_000,
      storePath,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // The retry itself came back rate-limited: do not arm a second one.
    const second = scheduleRateLimitRetry({
      sessionKey: "agent:main:main",
      prompt: "keep going",
      resetAt: Date.now() + 60_000,
      dispatch,
      jitterMs: 20_000,
      storePath,
    });
    expect(second).toBeUndefined();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("rearmPersistedRateLimitRetries", () => {
  it("round-trips a pending retry through the store and fires it after a restart", async () => {
    const beforeRestart = vi.fn();
    const armedAt = scheduleRateLimitRetry({
      sessionKey: "agent:main:main",
      runId: "run-1",
      prompt: "keep going",
      resetAt: SUMMER_NOW + 60_000,
      dispatch: beforeRestart,
      jitterMs: 20_000,
      storePath,
    });
    expect(armedAt).toBe(SUMMER_NOW + 80_000);

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      version: number;
      retries: Array<Record<string, unknown>>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.retries).toHaveLength(1);
    expect(persisted.retries[0]).toMatchObject({
      sessionKey: "agent:main:main",
      prompt: "keep going",
      scheduledFor: SUMMER_NOW + 80_000,
    });

    // Simulate a gateway restart: in-memory timers are gone, the store is not.
    __resetRateLimitRetryStateForTest();

    const afterRestart = vi.fn();
    expect(rearmPersistedRateLimitRetries(afterRestart, { storePath, jitterMs: 20_000 })).toBe(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(beforeRestart).not.toHaveBeenCalled();
    expect(afterRestart).toHaveBeenCalledTimes(1);
    expect(afterRestart.mock.calls[0]?.[0]?.prompt).toBe("keep going");
  });

  it("does not re-arm a retry that already fired", async () => {
    const dispatch = vi.fn();
    scheduleRateLimitRetry({
      sessionKey: "agent:main:main",
      prompt: "keep going",
      resetAt: SUMMER_NOW + 60_000,
      dispatch,
      jitterMs: 20_000,
      storePath,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    __resetRateLimitRetryStateForTest();
    const afterRestart = vi.fn();
    expect(rearmPersistedRateLimitRetries(afterRestart, { storePath, jitterMs: 20_000 })).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(afterRestart).not.toHaveBeenCalled();
  });
});
