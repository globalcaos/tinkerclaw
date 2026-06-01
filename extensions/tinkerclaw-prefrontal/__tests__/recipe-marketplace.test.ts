import { describe, it, expect, vi } from "vitest";
import {
  bumpVersion,
  parseSemver,
  compareSemver,
  satisfies,
  ratingBonus,
  createMarketplace,
  makeRatingLookup,
  type MarketplaceMeta,
  type MarketplaceFetch,
} from "../recipe-marketplace.js";

// ─── bumpVersion ──────────────────────────────────────────────────────────────

describe("bumpVersion", () => {
  it("patch bumps the third component", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });
  it("minor bumps the second component and zeroes patch", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });
  it("major bumps the first component and zeroes minor+patch", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });
  it("works from a zeroed base", () => {
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(bumpVersion("0.0.0", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.0.0", "major")).toBe("1.0.0");
  });
  it("tolerates a leading v prefix and normalizes it away", () => {
    expect(bumpVersion("v1.2.3", "patch")).toBe("1.2.4");
  });
  it("rejects non-semver input", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow(/semver/i);
    expect(() => bumpVersion("not-a-version", "minor")).toThrow(/semver/i);
    expect(() => bumpVersion("1.2.3.4", "major")).toThrow(/semver/i);
    expect(() => bumpVersion("", "patch")).toThrow(/semver/i);
  });
});

// ─── parseSemver / compareSemver ──────────────────────────────────────────────

describe("parseSemver", () => {
  it("parses a clean triple", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  it("strips a leading v", () => {
    expect(parseSemver("v10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
  });
  it("returns null on garbage", () => {
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("x.y.z")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
  });
});

// ─── satisfies (constraint matching) ──────────────────────────────────────────

describe("satisfies", () => {
  it("matches an exact version", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
  });
  it("matches a caret range (same major, >= the floor)", () => {
    expect(satisfies("1.2.3", "^1.2.0")).toBe(true);
    expect(satisfies("1.9.9", "^1.2.0")).toBe(true);
    expect(satisfies("1.2.0", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("1.1.9", "^1.2.0")).toBe(false);
  });
  it("matches a tilde range (same major.minor, >= the floor)", () => {
    expect(satisfies("1.2.3", "~1.2.0")).toBe(true);
    expect(satisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfies("1.2.0", "~1.2.5")).toBe(false);
  });
  it("matches a >= range", () => {
    expect(satisfies("1.5.0", ">=1.2.0")).toBe(true);
    expect(satisfies("1.2.0", ">=1.2.0")).toBe(true);
    expect(satisfies("1.1.0", ">=1.2.0")).toBe(false);
  });
});

// ─── ratingBonus (clamped discovery weight) ───────────────────────────────────

describe("ratingBonus", () => {
  it("is 0 for undefined / no metadata", () => {
    expect(ratingBonus(undefined)).toBe(0);
    expect(ratingBonus({})).toBe(0);
  });
  it("grows with rating + downloads but never exceeds the clamp", () => {
    const small = ratingBonus({ rating: 3, downloads: 5 });
    const big = ratingBonus({ rating: 5, downloads: 100000 });
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(2); // clamp: cannot override a strong text mismatch
    expect(small).toBeGreaterThanOrEqual(0);
  });
  it("never returns a negative bonus", () => {
    expect(ratingBonus({ rating: 0, downloads: 0 })).toBe(0);
  });
});

// ─── marketplace cache + resolveVersion ───────────────────────────────────────

function meta(
  kitRef: string,
  versions: string[],
  over?: Partial<MarketplaceMeta>,
): MarketplaceMeta {
  return {
    kitRef,
    versions,
    rating: over?.rating,
    downloads: over?.downloads,
    yanked: over?.yanked,
  };
}

describe("createMarketplace — cache + resolveVersion", () => {
  it("resolveVersion('latest') picks the highest semver", async () => {
    const fetchImpl: MarketplaceFetch = vi
      .fn()
      .mockResolvedValue(meta("globalcaos/debug", ["1.0.0", "1.2.0", "1.1.5"]));
    const mkt = createMarketplace({ fetchImpl });
    const v = await mkt.resolveVersion("globalcaos/debug", "latest");
    expect(v).toBe("1.2.0");
  });

  it("resolveVersion(exact) returns that version when published", async () => {
    const fetchImpl: MarketplaceFetch = vi
      .fn()
      .mockResolvedValue(meta("globalcaos/debug", ["1.0.0", "1.2.0"]));
    const mkt = createMarketplace({ fetchImpl });
    expect(await mkt.resolveVersion("globalcaos/debug", "1.0.0")).toBe("1.0.0");
  });

  it("resolveVersion(exact) returns null when that version is not published", async () => {
    const fetchImpl: MarketplaceFetch = vi
      .fn()
      .mockResolvedValue(meta("globalcaos/debug", ["1.0.0", "1.2.0"]));
    const mkt = createMarketplace({ fetchImpl });
    expect(await mkt.resolveVersion("globalcaos/debug", "9.9.9")).toBeNull();
  });

  it("resolveVersion(range) picks the highest satisfying version", async () => {
    const fetchImpl: MarketplaceFetch = vi
      .fn()
      .mockResolvedValue(meta("globalcaos/debug", ["1.0.0", "1.2.0", "1.5.3", "2.0.0"]));
    const mkt = createMarketplace({ fetchImpl });
    expect(await mkt.resolveVersion("globalcaos/debug", "^1.0.0")).toBe("1.5.3");
    expect(await mkt.resolveVersion("globalcaos/debug", "~1.2.0")).toBe("1.2.0");
  });

  it("skips yanked versions when resolving latest", async () => {
    const fetchImpl: MarketplaceFetch = vi
      .fn()
      .mockResolvedValue(meta("globalcaos/debug", ["1.0.0", "1.2.0"], { yanked: ["1.2.0"] }));
    const mkt = createMarketplace({ fetchImpl });
    expect(await mkt.resolveVersion("globalcaos/debug", "latest")).toBe("1.0.0");
  });

  it("caches: a second call inside the TTL does NOT re-fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(meta("globalcaos/debug", ["1.0.0"]));
    const mkt = createMarketplace({ fetchImpl, now: () => 1000 });
    await mkt.getMeta("globalcaos/debug");
    await mkt.getMeta("globalcaos/debug");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cache hit on the second call
  });

  it("re-fetches once the TTL has expired", async () => {
    let t = 0;
    const fetchImpl = vi.fn().mockResolvedValue(meta("globalcaos/debug", ["1.0.0"]));
    const mkt = createMarketplace({ fetchImpl, ttlMs: 1000, now: () => t });
    await mkt.getMeta("globalcaos/debug"); // fetch @ t=0
    t = 500;
    await mkt.getMeta("globalcaos/debug"); // still fresh → cache hit
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 1500; // past the 1s TTL
    await mkt.getMeta("globalcaos/debug"); // stale → re-fetch
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("default TTL is ~1 hour", () => {
    const mkt = createMarketplace({ fetchImpl: vi.fn() });
    expect(mkt.ttlMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1);
    expect(mkt.ttlMs).toBeLessThanOrEqual(60 * 60 * 1000 + 1);
  });

  it("recordMarketplaceCache pre-seeds the cache so getMeta does not fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(meta("globalcaos/debug", ["9.9.9"]));
    const mkt = createMarketplace({ fetchImpl, now: () => 0 });
    mkt.recordMarketplaceCache(meta("globalcaos/debug", ["1.0.0", "1.1.0"]));
    const m = await mkt.getMeta("globalcaos/debug");
    expect(m?.versions).toEqual(["1.0.0", "1.1.0"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("degrades to the cached copy when the fetch throws (Risk 7 freshness-bounded fallback)", async () => {
    let t = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(meta("globalcaos/debug", ["1.0.0", "1.2.0"]))
      .mockRejectedValue(new Error("marketplace down"));
    const mkt = createMarketplace({ fetchImpl, ttlMs: 1000, now: () => t });
    expect(await mkt.resolveVersion("globalcaos/debug", "latest")).toBe("1.2.0"); // fresh fetch
    t = 5000; // TTL expired → will try to re-fetch and FAIL
    // Must NOT throw — returns the stale cached resolution.
    expect(await mkt.resolveVersion("globalcaos/debug", "latest")).toBe("1.2.0");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null (does not throw) when fetch fails and there is no cache", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("marketplace down"));
    const mkt = createMarketplace({ fetchImpl });
    expect(await mkt.getMeta("globalcaos/never-seen")).toBeNull();
    expect(await mkt.resolveVersion("globalcaos/never-seen", "latest")).toBeNull();
  });

  it("hasVersion reflects published versions for the immutability check", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(meta("globalcaos/debug", ["1.0.0", "1.1.0"]));
    const mkt = createMarketplace({ fetchImpl });
    expect(await mkt.hasVersion("globalcaos/debug", "1.1.0")).toBe(true);
    expect(await mkt.hasVersion("globalcaos/debug", "1.2.0")).toBe(false);
  });

  it("hasVersion is false (never throws) when the marketplace is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    const mkt = createMarketplace({ fetchImpl });
    expect(await mkt.hasVersion("globalcaos/debug", "1.0.0")).toBe(false);
  });
});

// ─── U12 producer-side seam: getRatingBonusSync + makeRatingLookup ────────────
// The matcher's RatingLookup reads the WARMED cache synchronously (no fetch). The
// turn-start seed + recipe.match build it via makeRatingLookup and pass it as the
// `rating` signal so a popular recipe edges ahead in a tie.

describe("getRatingBonusSync — sync read of the warmed cache", () => {
  it("returns the ratingBonus for a cached ref and undefined for a cold one (no fetch)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("must not be called"));
    const mkt = createMarketplace({ fetchImpl });
    mkt.recordMarketplaceCache(meta("globalcaos/debug", ["1.0.0"], { rating: 5, downloads: 1000 }));
    const cached = mkt.getRatingBonusSync("globalcaos/debug");
    expect(cached).toBeGreaterThan(0);
    expect(cached).toBe(ratingBonus({ rating: 5, downloads: 1000 }));
    // Cold ref → undefined, and the sync read NEVER triggers a fetch.
    expect(mkt.getRatingBonusSync("globalcaos/never-seen")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves a BARE slug to its cached owner/slug ref (matcher keys by bare slug)", () => {
    const mkt = createMarketplace({ fetchImpl: vi.fn() });
    mkt.recordMarketplaceCache(meta("globalcaos/debug", ["1.0.0"], { rating: 4 }));
    // The matcher calls rating(kit.slug) with the BARE slug "debug".
    expect(mkt.getRatingBonusSync("debug")).toBe(ratingBonus({ rating: 4 }));
  });
});

describe("makeRatingLookup — RatingLookup over the warmed marketplace cache", () => {
  it("is sync and delegates to getRatingBonusSync", () => {
    const mkt = createMarketplace({ fetchImpl: vi.fn() });
    mkt.recordMarketplaceCache(meta("globalcaos/debug", ["1.0.0"], { rating: 5 }));
    const lookup = makeRatingLookup(mkt);
    const r = lookup("debug");
    expect(r instanceof Promise).toBe(false);
    expect(r).toBe(mkt.getRatingBonusSync("debug"));
    expect(lookup("uncached")).toBeUndefined();
  });
});
