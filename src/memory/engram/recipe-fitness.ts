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
  const base = prior ?? createInitialRecipeFitness(recipeId, prior?.version ?? 1);

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
