import { describe, expect, it } from "vitest";
import {
  EXHAUSTED_PERCENT,
  providerExhausted,
  toResetMs,
  windowExhausted,
} from "./quota-window.js";

// nowMs is always injected — never Date.now() — so tests are deterministic.
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z

describe("shared/quota-window", () => {
  describe("toResetMs", () => {
    it("parses an ISO string with a numeric offset and microseconds", () => {
      // Real producer sample — microseconds must clamp to ms, never NaN.
      expect(toResetMs("2026-09-03T16:00:00.019217+00:00")).toBe(
        Date.UTC(2026, 8, 3, 16, 0, 0, 19),
      );
    });

    it("parses an ISO string with Z", () => {
      expect(toResetMs("2026-09-03T16:00:00Z")).toBe(Date.UTC(2026, 8, 3, 16, 0, 0));
    });

    it("passes an already-epoch-ms number through", () => {
      expect(toResetMs(1757000000000)).toBe(1757000000000);
    });

    it("returns undefined (never NaN) for garbage", () => {
      expect(toResetMs("not a date")).toBeUndefined();
      expect(toResetMs("")).toBeUndefined();
      expect(toResetMs(null)).toBeUndefined();
      expect(toResetMs(undefined)).toBeUndefined();
      expect(toResetMs(Number.NaN)).toBeUndefined();
    });
  });

  describe("windowExhausted", () => {
    it("is false at 100% when resetAtMs is in the past (window rolled over)", () => {
      expect(windowExhausted({ usedPercent: 100, resetAtMs: NOW - 1 }, NOW)).toBe(false);
    });

    it("is true at 100% with NO resetAtMs (exhausted until the number drops)", () => {
      expect(windowExhausted({ usedPercent: 100 }, NOW)).toBe(true);
    });

    it("is false below the threshold", () => {
      expect(windowExhausted({ usedPercent: 99.9, resetAtMs: NOW + 60_000 }, NOW)).toBe(false);
    });

    it("is true at 100% with resetAtMs in the future", () => {
      expect(windowExhausted({ usedPercent: 100, resetAtMs: NOW + 60_000 }, NOW)).toBe(true);
    });

    it("exposes the threshold as EXHAUSTED_PERCENT = 100", () => {
      expect(EXHAUSTED_PERCENT).toBe(100);
    });
  });

  describe("providerExhausted", () => {
    it("returns the FIRST exhausted window in the given order (the binding one)", () => {
      const fiveHour = { usedPercent: 100, resetAtMs: NOW + 3_600_000 };
      const sevenDay = { usedPercent: 100, resetAtMs: NOW + 86_400_000 };
      expect(providerExhausted([fiveHour, sevenDay], NOW)).toBe(fiveHour);
    });

    it("skips non-exhausted windows to reach a later binding one", () => {
      const fiveHour = { usedPercent: 42 };
      const sevenDay = { usedPercent: 100 };
      expect(providerExhausted([fiveHour, sevenDay], NOW)).toBe(sevenDay);
    });

    it("returns null when no window is exhausted", () => {
      expect(
        providerExhausted([{ usedPercent: 12 }, { usedPercent: 99.9, resetAtMs: NOW + 1 }], NOW),
      ).toBe(null);
    });

    it("returns null for an empty list", () => {
      expect(providerExhausted([], NOW)).toBe(null);
    });
  });
});
