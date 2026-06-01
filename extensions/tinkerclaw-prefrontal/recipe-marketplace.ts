/**
 * FORK 2026-06-01 (J13 Upgrade 12) — Recipe marketplace: versioning, version-
 * constrained resolution, and a freshness-bounded cache for rating-weighted
 * discovery.
 *
 * WHY THIS EXISTS
 * ---------------
 * `prefrontal.recipe.publish` already POSTs to `/api/kits/publish` (kit-rpcs.ts).
 * The capstone of the recipe-as-artifact thesis is the *semantics* layered on
 * that plumbing — NOT a new backend client:
 *
 *   1. VERSIONING — a publish bumps the frontmatter `version` per a semver policy
 *      and is REFUSED if it would overwrite an already-published version
 *      (versions are immutable; a "bad recipe" is yanked, never re-published).
 *   2. RESOLUTION — get/install accept a version constraint (`latest` | exact
 *      `1.2.3` | a caret/tilde/`>=` range) resolved against the marketplace's
 *      published set.
 *   3. DISCOVERY — a small, CLAMPED rating/download bonus folded into the matcher
 *      score so a battle-tested recipe outranks an equally-text-matched unknown,
 *      without letting popularity override a genuine text mismatch.
 *
 * DESIGN: PURE LOGIC + INJECTED FETCH + GRACEFUL DEGRADATION
 * ---------------------------------------------------------
 * Mirrors `semantic-matcher.ts`: the testable logic (semver math, constraint
 * satisfaction, the rating clamp, the TTL cache) is pure; the ONE network seam
 * is an injectable `MarketplaceFetch`. A ~1h TTL bounds staleness so published
 * updates propagate without hammering the API. Crucially — and this is the
 * Risk-7 contract — when the fetch FAILS, resolution degrades to the last cached
 * copy (within or even past the TTL) and NEVER throws; a marketplace outage must
 * degrade a match to local cache, never hard-fail a turn.
 *
 * Wiring (Wire phase, NOT done here):
 *   - publish (kit-rpcs.ts): bump version → `hasVersion` immutability check → POST.
 *   - get/install (kit-rpcs.ts): `resolveVersion(kitRef, constraint)` → fetch that ref.
 *   - kit-matcher.ts scoreKit (Upgrade 1's weight-adjust seam): `+= ratingBonus(meta)`.
 *
 * See bible subagents-and-recipes.md.
 */

// ─── Semver ───────────────────────────────────────────────────────────────────

export type SemverBump = "major" | "minor" | "patch";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a `MAJOR.MINOR.PATCH` string (an optional leading `v` is tolerated and
 * normalized away). Returns null on anything that is not a clean triple — no
 * pre-release/build metadata is accepted (recipes use plain semver). Pure.
 */
export function parseSemver(version: string): Semver | null {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Render a Semver back to its canonical `MAJOR.MINOR.PATCH` string. */
export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Numeric semver ordering: returns >0 if a>b, <0 if a<b, 0 if equal. Unparseable
 * inputs sort as `0.0.0` so ranking stays total + safe (never NaN).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? { major: 0, minor: 0, patch: 0 };
  const pb = parseSemver(b) ?? { major: 0, minor: 0, patch: 0 };
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * Bump a semver by the given level. Throws on non-semver input (a publish must
 * not silently mint a garbage version). `minor` zeroes patch; `major` zeroes
 * minor+patch — standard semver carry semantics.
 */
export function bumpVersion(current: string, level: SemverBump): string {
  const v = parseSemver(current);
  if (!v) {
    throw new Error(`bumpVersion: not a valid semver: "${current}" (want MAJOR.MINOR.PATCH)`);
  }
  switch (level) {
    case "major":
      return formatSemver({ major: v.major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatSemver({ major: v.major, minor: v.minor + 1, patch: 0 });
    case "patch":
      return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1 });
  }
}

/**
 * Does `version` satisfy `constraint`? Constraint grammar (kept deliberately
 * small — the recipe marketplace does not need full node-semver):
 *   - exact:   `1.2.3`         → equal only
 *   - caret:   `^1.2.0`        → same major AND >= the floor
 *   - tilde:   `~1.2.0`        → same major.minor AND >= the floor
 *   - gte:     `>=1.2.0`       → >= the floor
 *   - `latest`/`*`             → any parseable version
 * Unparseable on either side → false. Pure.
 */
export function satisfies(version: string, constraint: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  const c = constraint.trim();
  if (c === "latest" || c === "*") return true;

  if (c.startsWith("^")) {
    const floor = parseSemver(c.slice(1));
    if (!floor) return false;
    return v.major === floor.major && compareSemver(version, formatSemver(floor)) >= 0;
  }
  if (c.startsWith("~")) {
    const floor = parseSemver(c.slice(1));
    if (!floor) return false;
    return (
      v.major === floor.major &&
      v.minor === floor.minor &&
      compareSemver(version, formatSemver(floor)) >= 0
    );
  }
  if (c.startsWith(">=")) {
    const floor = parseSemver(c.slice(2));
    if (!floor) return false;
    return compareSemver(version, formatSemver(floor)) >= 0;
  }
  // Bare version → exact match.
  const exact = parseSemver(c);
  if (!exact) return false;
  return compareSemver(version, c) === 0;
}

// ─── Marketplace metadata + rating bonus ─────────────────────────────────────

/**
 * Per-recipe metadata the marketplace returns for a `kitRef`. `versions` is the
 * published version list (immutable, append-only); `yanked` flags versions that
 * remain reproducible for pinned consumers but are skipped by `latest`/range
 * resolution. `rating`/`downloads` feed the discovery bonus.
 */
export interface MarketplaceMeta {
  kitRef: string;
  versions: string[];
  rating?: number;
  downloads?: number;
  /** Versions that are deprecated: still installable by exact pin, skipped by latest/range. */
  yanked?: string[];
}

/** Max discovery bonus a recipe's popularity can contribute to its match score.
 * Deliberately small + clamped so it cannot leapfrog a strong text mismatch
 * (Risk b: rating-weighted discovery must not become rich-get-richer). */
export const MAX_RATING_BONUS = 2;

/**
 * Map marketplace popularity to a small, clamped additive score bonus. Rating
 * (assumed 0–5) dominates; downloads add a gentle log-scaled nudge. Result is in
 * [0, MAX_RATING_BONUS]. Pure — the matcher folds this in at its weight-adjust
 * seam (Upgrade 1), the single place base scores are perturbed.
 */
export function ratingBonus(
  meta: Pick<MarketplaceMeta, "rating" | "downloads"> | undefined | null,
): number {
  if (!meta) return 0;
  const rating = typeof meta.rating === "number" && meta.rating > 0 ? meta.rating : 0;
  const downloads = typeof meta.downloads === "number" && meta.downloads > 0 ? meta.downloads : 0;
  // rating 0–5 → 0–1.5; downloads via log10 → 0–~0.5. Sum clamped to MAX_RATING_BONUS.
  const ratingPart = (Math.min(rating, 5) / 5) * 1.5;
  const downloadPart = Math.min(Math.log10(downloads + 1) / 10, 0.5);
  const raw = ratingPart + downloadPart;
  return Math.max(0, Math.min(MAX_RATING_BONUS, raw));
}

// ─── Marketplace cache + resolution ──────────────────────────────────────────

/**
 * The ONE network seam. Resolves a `kitRef` to its marketplace metadata. MUST
 * throw (or reject) on any failure — the marketplace treats a throw as
 * "unavailable" and falls back to the cache. Returning null means "fetched OK,
 * but no such recipe is published".
 */
export type MarketplaceFetch = (kitRef: string) => Promise<MarketplaceMeta | null>;

interface CacheEntry {
  meta: MarketplaceMeta;
  fetchedAt: number;
}

export interface MarketplaceDeps {
  /** Injected network seam. In tests, a stub; in `index.ts`, the undici-backed adapter. */
  fetchImpl: MarketplaceFetch;
  /** Cache freshness window. Default ~1 hour. */
  ttlMs?: number;
  /** Clock seam for deterministic TTL tests. Default `Date.now`. */
  now?: () => number;
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export const DEFAULT_MARKETPLACE_TTL_MS = 60 * 60 * 1000; // ~1 hour

export interface Marketplace {
  /** Effective TTL (exposed for assertions / wiring introspection). */
  readonly ttlMs: number;
  /**
   * Get metadata for a kitRef, cache-first. Fresh cache hit → no fetch. Stale or
   * cold → fetch; on fetch FAILURE, return the stale cached copy if any (Risk 7),
   * else null. Never throws.
   */
  getMeta(kitRef: string): Promise<MarketplaceMeta | null>;
  /**
   * Resolve a version constraint to a concrete published version, or null when
   * nothing satisfies (or the marketplace is unreachable + uncached). Skips
   * yanked versions for `latest`/range; an exact pin can still hit a yanked
   * version (pinned consumers stay reproducible). Never throws.
   */
  resolveVersion(kitRef: string, constraint: string): Promise<string | null>;
  /** True iff `version` is already published for `kitRef` (immutability gate for
   * publish). False — never throws — when the marketplace is unreachable. */
  hasVersion(kitRef: string, version: string): Promise<boolean>;
  /** Pre-seed / refresh the cache from a known-good meta (e.g. a search response
   * already carrying versions) so a later resolve avoids a round-trip. */
  recordMarketplaceCache(meta: MarketplaceMeta): void;
  /** Drop the in-memory cache (parity with kit-matcher's invalidateKitIndexCache). */
  invalidateMarketplaceCache(): void;
  /**
   * FORK 2026-06-01 (U12 producer-side seam): SYNC rating-bonus reader for the
   * matcher. Reads the WARMED in-memory cache ONLY (no fetch — scoreKit is sync and
   * a turn-start match must never block on the network) and returns the recipe's
   * `ratingBonus(meta)` in [0, MAX_RATING_BONUS], or `undefined` when nothing is
   * cached for that ref yet. `slug` may be the canonical `owner/slug` (a cache key)
   * or a bare slug that suffix-matches one (the matcher keys by bare slug). Never
   * throws. This is the read the makeRatingLookup factory wraps into a RatingLookup.
   */
  getRatingBonusSync(slug: string): number | undefined;
}

/**
 * Build a marketplace facade over an injected fetch. Holds a per-kitRef TTL
 * cache. Pure aside from the injected `fetchImpl`/`now`; safe to unit-test
 * end-to-end with stubs.
 */
export function createMarketplace(deps: MarketplaceDeps): Marketplace {
  const ttlMs = deps.ttlMs ?? DEFAULT_MARKETPLACE_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  const recordMarketplaceCache = (meta: MarketplaceMeta): void => {
    cache.set(meta.kitRef, { meta, fetchedAt: now() });
  };

  const getMeta = async (kitRef: string): Promise<MarketplaceMeta | null> => {
    const cached = cache.get(kitRef);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return cached.meta; // fresh hit — no fetch
    }
    try {
      const fresh = await deps.fetchImpl(kitRef);
      if (fresh) {
        cache.set(kitRef, { meta: fresh, fetchedAt: now() });
        return fresh;
      }
      // Fetched OK but not published. Drop any (now-contradicted) stale entry.
      cache.delete(kitRef);
      return null;
    } catch (err) {
      // Risk 7: marketplace down → degrade to the stale cache, freshness-bounded
      // only by availability. Never hard-fail.
      if (cached) {
        deps.log?.warn?.(
          `[recipe-marketplace] fetch failed for ${kitRef}; using stale cache: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return cached.meta;
      }
      deps.log?.warn?.(
        `[recipe-marketplace] fetch failed for ${kitRef} (no cache): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  };

  const resolveVersion = async (kitRef: string, constraint: string): Promise<string | null> => {
    const meta = await getMeta(kitRef);
    if (!meta || !Array.isArray(meta.versions) || meta.versions.length === 0) return null;

    const yanked = new Set(meta.yanked ?? []);
    const c = constraint.trim();

    // An EXACT pin may resolve to a yanked version (pinned consumers reproducible).
    if (c !== "latest" && c !== "*" && parseSemver(c)) {
      return meta.versions.includes(c) ? c : null;
    }

    // latest / range → highest satisfying, non-yanked, parseable version.
    const candidates = meta.versions.filter(
      (v) => parseSemver(v) !== null && !yanked.has(v) && satisfies(v, c),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => compareSemver(b, a));
    return candidates[0];
  };

  const hasVersion = async (kitRef: string, version: string): Promise<boolean> => {
    const meta = await getMeta(kitRef);
    return !!meta && Array.isArray(meta.versions) && meta.versions.includes(version);
  };

  const getRatingBonusSync = (slug: string): number | undefined => {
    // Exact kitRef hit first; else a bare-slug suffix match against cache keys.
    let entry = cache.get(slug);
    if (!entry && !slug.includes("/")) {
      for (const [kitRef, e] of cache) {
        if (kitRef.endsWith(`/${slug}`)) {
          entry = e;
          break;
        }
      }
    }
    if (!entry) return undefined; // cold cache — no opinion (matcher applies no nudge)
    return ratingBonus(entry.meta);
  };

  return {
    ttlMs,
    getMeta,
    resolveVersion,
    hasVersion,
    recordMarketplaceCache,
    invalidateMarketplaceCache: () => cache.clear(),
    getRatingBonusSync,
  };
}

/**
 * FORK 2026-06-01 (U12 producer-side seam): build the matcher's RatingLookup over a
 * marketplace's warmed cache. The returned function is SYNC (scoreKit is sync) and
 * delegates to getRatingBonusSync, so the matcher folds in a clamped popularity
 * tie-breaker (ratingScoreDelta in kit-matcher.ts) only for recipes whose meta is
 * already cached. Build it ONCE per turn and pass it as `rating` into
 * matchKitsDetailed/seedPlanFromPrompt. Returns `undefined` for an uncached recipe
 * so the matcher applies no nudge (ratingScoreDelta(undefined) === 0).
 */
export function makeRatingLookup(marketplace: Marketplace): (slug: string) => number | undefined {
  return (slug: string): number | undefined => marketplace.getRatingBonusSync(slug);
}
