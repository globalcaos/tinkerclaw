/**
 * ENGRAM — Recipe empirical fitness (Upgrade 1, Darwin-Gödel style).
 *
 * Pure fitness computation over episodes. A "recipe" is a Prefrontal kit
 * ("owner/slug"). The Cerebellum does NOT own recipe execution — it owns the
 * OFFLINE measurement of how well each recipe performs, distilled from episode
 * outcomes so the Prefrontal selector can prefer empirically-better variants.
 *
 *   success  = episode.outcome === "completed"
 *   latency  = endTime − startTime
 *   tokens   = sum of MemoryEvent.tokens over the episode's source events
 *
 * Recipe attribution is via an explicit `recipe:<owner/slug>` tag set on events
 * (by Prefrontal's kit-runner at dispatch — a cross-subsystem contract). When no
 * such tag is present, attribution returns null and the episode is NOT counted
 * against any recipe (no false attribution — risk #3).
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 1).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Episode } from "./episode-detection.js";
import type { MemoryEvent } from "./event-types.js";

export interface RecipeFitness {
  recipeId: string;
  version: number;
  runs: number;
  successes: number;
  /** Laplace-smoothed success rate: (successes + 1) / (runs + 2). */
  successRate: number;
  avgLatencyMs: number;
  avgTokenCost: number;
  /** Gödel: encoded task complexity this variant has handled (mean turnCount). */
  difficulty: number;
  lastUpdated: string;
}

export function createInitialRecipeFitness(recipeId: string, version = 1): RecipeFitness {
  return {
    recipeId,
    version,
    runs: 0,
    successes: 0,
    successRate: laplace(0, 0),
    avgLatencyMs: 0,
    avgTokenCost: 0,
    difficulty: 0,
    lastUpdated: new Date(0).toISOString(),
  };
}

/** Laplace-smoothed success rate so 1/1 is not reported as a perfect 1.0. */
export function laplace(successes: number, runs: number): number {
  return (successes + 1) / (runs + 2);
}

/**
 * Attribute an episode to a recipe via an explicit `recipe:<owner/slug>` tag.
 * Returns null when no recipe tag is present (no false attribution).
 */
export function attributeRecipe(_episode: Episode, events: MemoryEvent[]): string | null {
  for (const e of events) {
    const tag = e.metadata?.tags?.find((t) => t.startsWith("recipe:"));
    if (tag) {
      return tag.slice("recipe:".length);
    }
  }
  return null;
}

function episodeLatencyMs(episode: Episode): number {
  const start = new Date(episode.startTime).getTime();
  const end = new Date(episode.endTime).getTime();
  const ms = end - start;
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

function episodeTokenCost(events: MemoryEvent[]): number {
  return events.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
}

/**
 * Fold one episode into a recipe's fitness. Pure — returns a new RecipeFitness.
 * Running averages are maintained incrementally over `runs`.
 */
export function updateRecipeFitness(
  prior: RecipeFitness | null,
  episode: Episode,
  episodeEvents: MemoryEvent[],
  atISO: string = new Date().toISOString(),
): RecipeFitness {
  const recipeId = attributeRecipe(episode, episodeEvents) ?? prior?.recipeId ?? "unknown";
  // In this branch `prior` is null (it's the `?? fallback`), so version is the
  // initial 1; reading prior?.version here narrowed to `never` and never applied.
  const base = prior ?? createInitialRecipeFitness(recipeId, 1);

  const isSuccess = episode.outcome === "completed";
  const runs = base.runs + 1;
  const successes = base.successes + (isSuccess ? 1 : 0);

  const latency = episodeLatencyMs(episode);
  const tokens = episodeTokenCost(episodeEvents);
  const difficulty = episode.turnCount;

  // Incremental running mean: new_avg = old_avg + (x - old_avg) / n
  const avgLatencyMs = base.avgLatencyMs + (latency - base.avgLatencyMs) / runs;
  const avgTokenCost = base.avgTokenCost + (tokens - base.avgTokenCost) / runs;
  const avgDifficulty = base.difficulty + (difficulty - base.difficulty) / runs;

  return {
    recipeId,
    version: base.version,
    runs,
    successes,
    successRate: laplace(successes, runs),
    avgLatencyMs,
    avgTokenCost,
    difficulty: avgDifficulty,
    lastUpdated: atISO,
  };
}

// ─── On-disk fitness reader (U1 producer-side seam) ──────────────────────────
//
// The Prefrontal matcher (extensions/tinkerclaw-prefrontal/kit-matcher.ts) scores
// recipes with an injected FitnessLookup `(slug) => successRate | undefined`. Its
// callers (index.ts turn-start seed, kit-rpcs match/search) need a SYNC reader of
// the on-disk fitness store so the matcher — which is itself sync — can fold the
// empirical-fitness boost in. This is that reader. It mirrors recipe-archive.ts's
// layout WITHOUT importing it (recipe-archive pulls in node:fs write helpers the
// matcher path never needs) and stays the single owner of the read shape.
//
// Layout (recipe-archive.ts): <baseDir>/recipe-archive/index.json maps
//   recipeId -> { recipeId, versions: number[] }; the latest version's fitness
//   lives at <baseDir>/recipe-archive/<slugify(recipeId)>/v<n>.json under `.fitness`.
// The recipeId is the canonical `owner/slug` (the `recipe:<owner/slug>` tag), but
// the matcher keys by BARE slug (KitIndexEntry.slug). So the reader resolves a key
// that is either the full `owner/slug` OR a bare slug that suffix-matches one.

const RECIPE_ARCHIVE_DIRNAME = "recipe-archive";

/** Mirror recipe-archive.ts slugify (its dir-name escaping) so paths line up. */
function slugifyRecipeId(recipeId: string): string {
  return recipeId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Per-recipe fitness summary the matcher needs. Default successRate is the
 * Laplace neutral 0.5 (== laplace(0,0)) when a recipe has no record yet, so an
 * unmeasured recipe is treated as neutral, never penalised. */
export interface RecipeFitnessSummary {
  successRate: number;
}

interface ArchiveIndexEntry {
  recipeId: string;
  versions: number[];
}

/**
 * Read a recipe's latest empirical fitness from the on-disk recipe-archive under
 * `baseDir`. `slug` may be the full canonical `owner/slug` or a bare slug; the
 * latter resolves to the first index entry whose recipeId is exactly it or ends
 * with `/<slug>`. Returns the Laplace-smoothed neutral default (0.5) when there is
 * no record (no archive, no matching entry, or an unreadable variant). Never
 * throws — a read failure degrades to neutral so the matcher never breaks.
 */
export function loadRecipeFitness(baseDir: string, slug: string): RecipeFitnessSummary {
  const neutral: RecipeFitnessSummary = { successRate: laplace(0, 0) };
  try {
    const root = join(baseDir, RECIPE_ARCHIVE_DIRNAME);
    const indexPath = join(root, "index.json");
    if (!existsSync(indexPath)) return neutral;
    const index = JSON.parse(readFileSync(indexPath, "utf-8")) as Record<string, ArchiveIndexEntry>;
    // Resolve the recipeId: exact key first, else a bare-slug suffix match.
    let entry: ArchiveIndexEntry | undefined = index[slug];
    if (!entry && !slug.includes("/")) {
      for (const [recipeId, e] of Object.entries(index)) {
        if (recipeId.endsWith(`/${slug}`)) {
          entry = e;
          break;
        }
      }
    }
    if (!entry || !Array.isArray(entry.versions) || entry.versions.length === 0) {
      return neutral;
    }
    const latest = entry.versions[entry.versions.length - 1];
    const variantPath = join(root, slugifyRecipeId(entry.recipeId), `v${latest}.json`);
    if (!existsSync(variantPath)) return neutral;
    const variant = JSON.parse(readFileSync(variantPath, "utf-8")) as {
      fitness?: { successRate?: unknown };
    };
    const rate = variant.fitness?.successRate;
    if (typeof rate === "number" && Number.isFinite(rate)) return { successRate: rate };
    return neutral;
  } catch {
    return neutral; // unreadable / malformed store → neutral, never throw
  }
}

/**
 * Build the matcher's FitnessLookup over the on-disk store under `baseDir`. The
 * returned function is SYNC (scoreKit is sync) and memoizes per-slug reads for the
 * life of the lookup so a single turn's scoring pass touches disk at most once per
 * candidate recipe. Returns `undefined` for the Laplace-neutral default so the
 * matcher's `fitnessFeedbackDelta` treats an unmeasured recipe as "no opinion"
 * (delta 0) rather than a measured-neutral, and `successRate` otherwise. Build it
 * ONCE per turn and pass it as `feedback` into matchKitsDetailed/seedPlanFromPrompt.
 */
export function makeFitnessLookup(baseDir: string): (slug: string) => number | undefined {
  const cache = new Map<string, number | undefined>();
  return (slug: string): number | undefined => {
    if (cache.has(slug)) return cache.get(slug);
    const { successRate } = loadRecipeFitness(baseDir, slug);
    // A record exactly at the Laplace neutral is indistinguishable from "no record"
    // here; both read as 0.5 → return undefined so the matcher applies no boost
    // (fitnessFeedbackDelta(undefined) === fitnessFeedbackDelta(0.5) === 0 anyway).
    const value = successRate === laplace(0, 0) ? undefined : successRate;
    cache.set(slug, value);
    return value;
  };
}
