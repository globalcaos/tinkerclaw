import { describe, it, expect } from "vitest";
import {
  RETRY_LADDER_MS,
  classifyRecoverable,
  nextRetryDelayMs,
  formatWait,
  labelFor,
} from "./retry-policy";

describe("RETRY_LADDER_MS", () => {
  it("is the locked 6-step ladder", () => {
    expect(RETRY_LADDER_MS).toEqual([3000, 10000, 30000, 120000, 420000, 900000]);
  });
});

describe("nextRetryDelayMs", () => {
  it("walks the ladder by 0-based attempt", () => {
    expect(nextRetryDelayMs(0)).toBe(3000);
    expect(nextRetryDelayMs(1)).toBe(10000);
    expect(nextRetryDelayMs(2)).toBe(30000);
    expect(nextRetryDelayMs(3)).toBe(120000);
    expect(nextRetryDelayMs(4)).toBe(420000);
    expect(nextRetryDelayMs(5)).toBe(900000);
  });

  it("returns null once the ladder is exhausted (attempt 6 -> stop)", () => {
    expect(nextRetryDelayMs(6)).toBeNull();
    expect(nextRetryDelayMs(99)).toBeNull();
  });

  it("honors a larger provider Retry-After", () => {
    // step 0 = 3000ms; retryAfter 60s = 60000ms wins
    expect(nextRetryDelayMs(0, 60)).toBe(60000);
  });

  it("keeps the ladder step when Retry-After is smaller", () => {
    // step 3 = 120000ms; retryAfter 5s = 5000ms loses
    expect(nextRetryDelayMs(3, 5)).toBe(120000);
  });
});

describe("classifyRecoverable", () => {
  it("trusts a structured reason", () => {
    expect(classifyRecoverable("rate_limit")).toEqual({ recoverable: true, kind: "rate_limit" });
    expect(classifyRecoverable("quota")).toEqual({ recoverable: true, kind: "quota" });
    expect(classifyRecoverable("overloaded")).toEqual({ recoverable: true, kind: "overloaded" });
    expect(classifyRecoverable("unavailable")).toEqual({ recoverable: true, kind: "unavailable" });
  });

  it("falls back to text matching the quota body", () => {
    expect(classifyRecoverable(undefined, "You exceeded your current quota")).toEqual({
      recoverable: true,
      kind: "quota",
    });
  });

  it("matches rate-limit text", () => {
    expect(classifyRecoverable(undefined, "All models temporarily rate-limited (429)")).toEqual({
      recoverable: true,
      kind: "rate_limit",
    });
  });

  it("matches overload-class text", () => {
    expect(classifyRecoverable(undefined, "Overloaded, draining for restart").kind).toBe(
      "overloaded",
    );
    expect(classifyRecoverable(undefined, "HTTP 503 from upstream").kind).toBe("overloaded");
  });

  it("reports a non-recoverable error", () => {
    expect(classifyRecoverable(undefined, "Thinking level invalid")).toEqual({
      recoverable: false,
      kind: null,
    });
    expect(classifyRecoverable()).toEqual({ recoverable: false, kind: null });
  });
});

describe("formatWait", () => {
  it("renders sub-minute as seconds", () => {
    expect(formatWait(3000)).toBe("3s");
    expect(formatWait(30000)).toBe("30s");
  });

  it("renders whole minutes without seconds", () => {
    expect(formatWait(120000)).toBe("2m");
    expect(formatWait(420000)).toBe("7m");
    expect(formatWait(900000)).toBe("15m");
  });

  it("renders minutes + seconds", () => {
    expect(formatWait(90000)).toBe("1m 30s");
  });
});

describe("labelFor", () => {
  it("maps each kind to a label", () => {
    expect(labelFor("quota")).toBe("Quota exceeded");
    expect(labelFor("rate_limit")).toBe("Rate limited");
    expect(labelFor("overloaded")).toBe("Overloaded");
    expect(labelFor("unavailable")).toBe("Temporarily unavailable");
    expect(labelFor(null)).toBe("Error");
  });
});
