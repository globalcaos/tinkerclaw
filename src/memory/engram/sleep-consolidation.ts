/**
 * ENGRAM Phase 3C — Sleep Consolidation Pipeline
 *
 * Runs during idle time (or via cron/CLI) to:
 * 1. Detect new episodes from unprocessed events
 * 2. Generate per-episode summaries
 * 3. Store summaries as artifacts
 *
 * Incremental & idempotent — tracks lastConsolidatedEventId.
 *
 * FORK-ISOLATED: unique to our fork (ENGRAM paper §5.3).
 */

import type { ArtifactStore } from "./artifact-store.js";
import {
  type ConsolidationState,
  type Episode,
  type EpisodeDetectionConfig,
  createInitialConsolidationState,
  detectEpisodes,
} from "./episode-detection.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import {
  appendManifestEntries,
  recipeMutationEntries,
  strategySwitchEntries,
  type ManifestEntry,
} from "./evolution-manifest.js";
import {
  createInitialStrategyState,
  isFailureEpisode,
  recordFailure,
  recordSuccess,
  strategyOf,
  type FailureStateMap,
} from "./failure-tracking.js";
import type { RecipeArchive } from "./recipe-archive.js";
import type { MutationProposal } from "./recipe-evolution.js";
import { proposeMutations } from "./recipe-evolution.js";
import { attributeRecipe, updateRecipeFitness, type RecipeFitness } from "./recipe-fitness.js";
import type { ReconciliationLedger } from "./reconciliation-ledger.js";
import type { MemoryReconciler, ReconciliationDecision } from "./reconciliation.js";
import {
  DEFAULT_FALLBACKS,
  decideSwitch,
  type StrategySwitchConfig,
  type SwitchDecision,
} from "./strategy-switch.js";

/**
 * Opt-in dependency bundle for the offline recipe-evolution fitness loop
 * (Upgrade 1). Injected only when the caller wants it; absent → no behavior change.
 */
export interface RecipeEvolutionDeps {
  archive: RecipeArchive;
  /** Returns the current recipe body to snapshot a fitness-tagged variant. */
  currentBody?: (recipeId: string) => string;
  config?: Partial<import("./recipe-evolution.js").RecipeEvolutionConfig>;
}

/**
 * Opt-in dependency bundle for the failure-count → strategy-switch loop
 * (Upgrade 4). Injected only when the caller wants it; absent → no behavior change.
 */
export interface StrategySwitchDeps {
  /** Persisted per-strategy failure state map (mutated in place + returned). */
  state: FailureStateMap;
  /** Strategy id → registered fallback. Defaults to DEFAULT_FALLBACKS. */
  fallbacks?: ReadonlyMap<string, string>;
  config?: Partial<StrategySwitchConfig>;
}

/**
 * Opt-in dependency bundle for Mem0 write-reconciliation (Upgrade 8).
 * Injected only when the caller wants it; absent → no behavior change.
 */
export interface ReconciliationDeps {
  reconciler: MemoryReconciler;
  ledger: ReconciliationLedger;
}

export interface SleepConsolidationConfig {
  episodeDetection?: Partial<EpisodeDetectionConfig>;
  /** Generate a summary for an episode. LLM-backed in production, simple in tests. */
  summarizeEpisode?: (episode: Episode, events: MemoryEvent[]) => string | Promise<string>;
  /** Directory for gated proposal manifests (default: <events baseDir>). Required when an evolution dep is present. */
  manifestBaseDir?: string;
  /** Opt-in offline recipe-fitness/evolution loop (Upgrade 1). */
  recipeEvolution?: RecipeEvolutionDeps;
  /** Opt-in failure-count → strategy-switch loop (Upgrade 4). */
  strategySwitch?: StrategySwitchDeps;
  /** Opt-in Mem0 write-reconciliation sweep (Upgrade 8). */
  reconciliation?: ReconciliationDeps;
}

export interface ConsolidationResult {
  newEpisodes: Episode[];
  summariesGenerated: number;
  eventsProcessed: number;
  durationMs: number;
  /** Count of gated recipe-mutation proposals written (Upgrade 1). 0 when dep absent. */
  recipeMutationsProposed?: number;
  /** Count of gated strategy-switch proposals written (Upgrade 4). 0 when dep absent. */
  strategySwitchesProposed?: number;
  /** Count of reconciliation UPDATE/DELETE ledger entries (Upgrade 8). 0 when dep absent. */
  reconciliationDecisions?: { updated: number; deleted: number };
}

/** Default episode summarizer — concatenates key content. */
function defaultEpisodeSummarizer(episode: Episode, events: MemoryEvent[]): string {
  const userMsgs = events
    .filter((e) => e.kind === "user_message")
    .map((e) => e.content.slice(0, 100));
  const agentMsgs = events
    .filter((e) => e.kind === "agent_message")
    .map((e) => e.content.slice(0, 100));

  return [
    `Episode: ${episode.topic}`,
    `Turns: ${episode.turnCount}, Outcome: ${episode.outcome}`,
    userMsgs.length > 0 ? `User: ${userMsgs.slice(0, 3).join(" | ")}` : "",
    agentMsgs.length > 0 ? `Agent: ${agentMsgs.slice(0, 3).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Run sleep consolidation pipeline.
 */
export async function runSleepConsolidation(
  store: EventStore,
  artifactStore: ArtifactStore,
  state: ConsolidationState,
  config: SleepConsolidationConfig = {},
): Promise<ConsolidationResult> {
  const start = Date.now();
  const summarize = config.summarizeEpisode ?? defaultEpisodeSummarizer;

  // 1. Get unprocessed events
  const allEvents = store.readAll();
  let unprocessed: MemoryEvent[];

  if (state.lastConsolidatedEventId) {
    const lastIdx = allEvents.findIndex((e) => e.id === state.lastConsolidatedEventId);
    unprocessed = lastIdx >= 0 ? allEvents.slice(lastIdx + 1) : allEvents;
  } else {
    unprocessed = allEvents;
  }

  if (unprocessed.length === 0) {
    return {
      newEpisodes: [],
      summariesGenerated: 0,
      eventsProcessed: 0,
      durationMs: Date.now() - start,
    };
  }

  // 2. Detect episodes
  const episodes = await detectEpisodes(unprocessed, config.episodeDetection);

  // Pre-index events by id once for the per-episode lookups below.
  const eventsOf = (episode: Episode): MemoryEvent[] =>
    unprocessed.filter((e) => episode.sourceEventIds.includes(e.id));

  // 3. Generate & store summaries
  let summariesGenerated = 0;
  for (const episode of episodes) {
    const episodeEvents = eventsOf(episode);
    const summary = await summarize(episode, episodeEvents);

    artifactStore.store(summary, "text");
    summariesGenerated++;
  }

  // 3b. Opt-in offline procedural-evolution steps (Upgrades 1, 4).
  //     ALL of this is skipped when no dep is injected → byte-identical output.
  const manifestEntries: ManifestEntry[] = [];
  const nowISO = new Date().toISOString();
  const manifestBaseDir = config.manifestBaseDir;

  let recipeMutationsProposed = 0;
  if (config.recipeEvolution) {
    const { archive, currentBody, config: evoCfg } = config.recipeEvolution;
    const proposals: MutationProposal[] = [];
    for (const episode of episodes) {
      const episodeEvents = eventsOf(episode);
      const rid = attributeRecipe(episode, episodeEvents);
      if (!rid) {
        continue; // no recipe tag → no false attribution
      }
      const prior: RecipeFitness | null = archive.latestFitness(rid);
      const fitness = updateRecipeFitness(prior, episode, episodeEvents, nowISO);
      const body = currentBody ? currentBody(rid) : "";
      archive.putVariant(rid, fitness.version, body, fitness);
      proposals.push(...proposeMutations(fitness, archive.history(rid), evoCfg));
    }
    recipeMutationsProposed = proposals.length;
    manifestEntries.push(...recipeMutationEntries(proposals, nowISO));
  }

  let strategySwitchesProposed = 0;
  if (config.strategySwitch) {
    const sw = config.strategySwitch;
    const fallbacks = sw.fallbacks ?? DEFAULT_FALLBACKS;
    for (const episode of episodes) {
      const episodeEvents = eventsOf(episode);
      const sid = strategyOf(episode, episodeEvents);
      if (!sid || episode.outcome === "ongoing") {
        continue; // unattributable or still in progress → not counted
      }
      const cur = sw.state[sid] ?? createInitialStrategyState(sid);
      const dedupeKey = episode.endEventId;
      sw.state[sid] = isFailureEpisode(episode, episodeEvents)
        ? recordFailure(cur, episode.endTime, dedupeKey)
        : recordSuccess(cur, episode.endTime, dedupeKey);
    }
    const decisions: SwitchDecision[] = [];
    for (const sid of Object.keys(sw.state)) {
      const d = decideSwitch(sw.state[sid], fallbacks, sw.config);
      if (d.shouldSwitch) {
        decisions.push(d);
      }
    }
    strategySwitchesProposed = decisions.length;
    manifestEntries.push(...strategySwitchEntries(decisions, nowISO));
  }

  if (manifestEntries.length > 0 && manifestBaseDir) {
    appendManifestEntries(manifestBaseDir, manifestEntries, nowISO);
  }

  // 3c. Opt-in Mem0 write-reconciliation sweep (Upgrade 8).
  //     Logical UPDATE/DELETE only — the JSONL audit plane is NEVER mutated.
  let reconciliationDecisions: { updated: number; deleted: number } | undefined;
  if (config.reconciliation) {
    const { reconciler, ledger } = config.reconciliation;
    const ctx = {
      totalMemoryBytes: allEvents.reduce((s, e) => s + e.content.length, 0),
      eventCount: allEvents.length,
      memoryMdLineCount: 0,
      phase: "consolidation" as const,
    };
    const decisions: ReconciliationDecision[] = await reconciler.reconcileWindow(unprocessed, ctx);
    let updated = 0;
    let deleted = 0;
    for (const d of decisions) {
      if (d.action === "UPDATE" && d.targetEventId) {
        ledger.supersede(d.targetEventId, d);
        updated++;
      } else if (d.action === "DELETE" && d.targetEventId) {
        ledger.tombstone(d.targetEventId, d);
        deleted++;
      }
    }
    ledger.flush();
    reconciliationDecisions = { updated, deleted };
  }

  // 4. Update state
  const lastEvent = unprocessed[unprocessed.length - 1];
  state.lastConsolidatedEventId = lastEvent.id;
  state.lastConsolidatedAt = new Date().toISOString();
  state.episodeCount += episodes.length;

  return {
    newEpisodes: episodes,
    summariesGenerated,
    eventsProcessed: unprocessed.length,
    durationMs: Date.now() - start,
    ...(config.recipeEvolution ? { recipeMutationsProposed } : {}),
    ...(config.strategySwitch ? { strategySwitchesProposed } : {}),
    ...(reconciliationDecisions ? { reconciliationDecisions } : {}),
  };
}

export { createInitialConsolidationState };
