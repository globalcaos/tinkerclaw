/**
 * `packIsStillFresh` decides whether the previous retrieval pack is served VERBATIM.
 *
 * It had no tests at all, which is how its third clause went four months without anyone
 * noticing that it invalidated every session in the gateway at once. The clause is
 * documented in index.ts; these tests pin the contract it now implements so the next
 * change to it has to argue with something.
 *
 * Why this matters more than a normal cache: the pack text goes into the system prompt,
 * so "not fresh" does not mean "rebuild a string". It means the derived session key
 * changes, the claude-cli worker is respawned (measured 2.3s p50 cold-vs-warm), and the
 * provider's prompt-cache prefix is rewritten instead of re-read.
 */
import { describe, it, expect } from "vitest";
import { packIsStillFresh, type CachedPack } from "../index.js";

const T0 = 1_700_000_000_000;
const THIRTY_MIN = 30 * 60 * 1000;
const DELTA = 20;

const cached = (over: Partial<CachedPack> = {}): CachedPack => ({
  pack: "## Retrieved Context\n[…]",
  eventCount: 100,
  ccEventCount: 3000,
  builtAtMs: T0,
  ...over,
});

describe("packIsStillFresh", () => {
  it("is never fresh with no cached pack", () => {
    expect(packIsStillFresh(undefined, 100, 3000, T0)).toBe(false);
  });

  it("is fresh when nothing has moved and the pack is young", () => {
    expect(packIsStillFresh(cached(), 100, 3000, T0 + 1000)).toBe(true);
  });

  // ─── session-event drift ──────────────────────────────────────────────────
  describe("session events", () => {
    it("tolerates drift below the delta", () => {
      expect(packIsStillFresh(cached(), 100 + DELTA - 1, 3000, T0 + 1000)).toBe(true);
    });

    it("rebuilds at the delta", () => {
      expect(packIsStillFresh(cached(), 100 + DELTA, 3000, T0 + 1000)).toBe(false);
    });
  });

  // ─── cc-experience drift — the clause that changed ────────────────────────
  describe("cc-experience events", () => {
    it("does NOT rebuild on a single external write", () => {
      // The regression this file exists for. `cc-experience` is ONE store shared by
      // every session and written out-of-process ~28x/day; exact-equality here meant
      // each write invalidated every cached pack in the gateway simultaneously.
      expect(packIsStillFresh(cached(), 100, 3001, T0 + 1000)).toBe(true);
    });

    it("tolerates drift below the delta", () => {
      expect(packIsStillFresh(cached(), 100, 3000 + DELTA - 1, T0 + 1000)).toBe(true);
    });

    it("rebuilds at the delta, so a synced correction still lands", () => {
      expect(packIsStillFresh(cached(), 100, 3000 + DELTA, T0 + 1000)).toBe(false);
    });

    it("treats the two sources independently — neither masks the other", () => {
      // Session at the limit, cc quiet.
      expect(packIsStillFresh(cached(), 100 + DELTA, 3000, T0 + 1000)).toBe(false);
      // cc at the limit, session quiet.
      expect(packIsStillFresh(cached(), 100, 3000 + DELTA, T0 + 1000)).toBe(false);
    });

    it("does not go stale forever when the cc store SHRINKS", () => {
      // A truncated or rotated cc store makes the count go DOWN. Under exact-equality
      // that rebuilt; under a >= delta it must not wedge the cache open either — the
      // 30-minute cap is what bounds this case.
      expect(packIsStillFresh(cached(), 100, 2000, T0 + 1000)).toBe(true);
      expect(packIsStillFresh(cached(), 100, 2000, T0 + THIRTY_MIN)).toBe(false);
    });
  });

  // ─── the age cap: what actually bounds correction latency now ─────────────
  describe("max age", () => {
    it("is fresh just under 30 minutes", () => {
      expect(packIsStillFresh(cached(), 100, 3000, T0 + THIRTY_MIN - 1)).toBe(true);
    });

    it("rebuilds at 30 minutes even when nothing moved", () => {
      // This is the clause that makes the cc change safe: worst-case staleness for an
      // externally synced correction is 30 minutes, not unbounded.
      expect(packIsStillFresh(cached(), 100, 3000, T0 + THIRTY_MIN)).toBe(false);
    });
  });
});
