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

import type { Skill } from "../storage/types.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  type ConsolidationState,
  type Episode,
  type EpisodeDetectionConfig,
  createInitialConsolidationState,
  detectEpisodes,
} from "./episode-detection.js";
import type { EventStore } from "./event-store.js";
import { generateULID } from "./event-store.js";
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
import { writeMemoryMd, type MemoryMdFact, type MemoryMdResult } from "./memory-md-writer.js";
import type { RecipeArchive } from "./recipe-archive.js";
import type { MutationProposal } from "./recipe-evolution.js";
import { proposeMutations } from "./recipe-evolution.js";
import { attributeRecipe, updateRecipeFitness, type RecipeFitness } from "./recipe-fitness.js";
import type { ReconciliationLedger } from "./reconciliation-ledger.js";
import type { MemoryReconciler, ReconciliationDecision } from "./reconciliation.js";
import {
  extractSkill,
  initialSuccessMetrics,
  isSkillWorthy,
  type SkillBody,
  type SkillExtractor,
} from "./skill-extraction.js";
import type { SkillLibrary } from "./skill-library.js";
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
 * Opt-in dependency bundle for post-episode skill extraction (Upgrade 6, J5
 * Voyager skill-library-as-code). Injected only when the caller wants it; absent
 * → no behavior change. The strict {@link isSkillWorthy} gate is applied per
 * episode before the (LLM-backed) extractor runs.
 */
export interface SkillExtractionDeps {
  /** Never-delete versioned skill registry the distilled skill is put into. */
  library: SkillLibrary;
  /** LLM-backed (test-stubbed) synthesis callback producing a SkillBody. */
  extractor: SkillExtractor;
  /**
   * Override the worthiness gate (default: the strict {@link isSkillWorthy}).
   * Test/seam hook — `detectEpisodes` always emits `keyDecisions: []`, so the
   * strict gate never fires on a freshly-detected episode; a richer detector
   * (or a test) can supply a different predicate. When the override is present
   * and returns true, extraction bypasses extractSkill's internal re-gate and
   * stamps the body directly (the override is authoritative).
   */
  isWorthy?: (episode: Episode, episodeEvents: MemoryEvent[]) => boolean;
}

/**
 * Opt-in dependency bundle for Mem0 write-reconciliation (Upgrade 8).
 * Injected only when the caller wants it; absent → no behavior change.
 */
export interface ReconciliationDeps {
  reconciler: MemoryReconciler;
  ledger: ReconciliationLedger;
  /**
   * Hard line bound for the suggest-only MEMORY.md serialization produced after
   * the sweep. Default {@link DEFAULT_MEMORY_MD_MAX_LINES} (500), mirroring
   * MEMORY.md's own bound. The writer NEVER touches disk — it only returns the
   * bounded content + demotion suggestions on the result.
   */
  memoryMdMaxLines?: number;
}

/** Default MEMORY.md line bound (mirrors createBoundedReconciler's 500). */
export const DEFAULT_MEMORY_MD_MAX_LINES = 500;

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
  /** Opt-in post-episode skill extraction into the skill library (Upgrade 6). */
  skillExtraction?: SkillExtractionDeps;
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
  /**
   * Of `recipeMutationsProposed`, how many are autoPromotable (needsHumanReview
   * false) — high-confidence, reversible mutations that may skip human review
   * (Upgrade 1, autonomy-first). 0 when dep absent.
   */
  recipeMutationsAutoPromotable?: number;
  /** Count of gated strategy-switch proposals written (Upgrade 4). 0 when dep absent. */
  strategySwitchesProposed?: number;
  /** Count of skills extracted into the skill library this run (Upgrade 6). 0 when dep absent. */
  skillsExtracted?: number;
  /** Count of reconciliation UPDATE/DELETE ledger entries (Upgrade 8). 0 when dep absent. */
  reconciliationDecisions?: { updated: number; deleted: number };
  /**
   * The suggest-only MEMORY.md serialization produced after the reconciliation
   * sweep (Upgrade 8). The writer NEVER touches disk; the caller (Wire phase,
   * behind ENGRAM_RECONCILE) decides whether to persist it. Absent when no
   * reconciliation dep is injected.
   */
  memoryMd?: MemoryMdResult;
}

/** A SkillBody is well-formed only with a name and at least one step. */
function isWellFormedSkillBody(body: SkillBody): boolean {
  return (
    typeof body.name === "string" &&
    body.name.length > 0 &&
    Array.isArray(body.steps) &&
    body.steps.length > 0
  );
}

/**
 * Stamp a SkillBody into a version-1 Skill (mirrors extractSkill's stamping).
 * Used ONLY on the worthiness-override path, which intentionally bypasses
 * extractSkill's internal isSkillWorthy re-gate (the override is authoritative).
 * The default path still routes through extractSkill so production behavior is
 * unchanged. Returns null for a malformed body (no empty skills enter the lib).
 */
function stampSkill(body: SkillBody, episode: Episode, atISO: string): Skill | null {
  if (!isWellFormedSkillBody(body)) {
    return null;
  }
  const skill: Skill = {
    skillId: generateULID(),
    version: 1,
    name: body.name,
    description: body.description ?? "",
    prerequisites: body.prerequisites ?? [],
    steps: body.steps,
    testCases: body.testCases ?? [],
    successMetrics: initialSuccessMetrics(),
    sourceEpisodeIds: [episode.id],
    created: atISO,
    deprecated: false,
  };
  if (body.verifiedCode !== undefined) {
    skill.verifiedCode = body.verifiedCode;
  }
  return skill;
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

  // Single timestamp for everything stamped this run (skills, manifest entries).
  const nowISO = new Date().toISOString();

  // 3. Generate & store summaries (+ opt-in per-episode skill extraction, U6).
  let summariesGenerated = 0;
  let skillsExtracted = 0;
  const episodeSummaries: string[] = [];
  for (const episode of episodes) {
    const episodeEvents = eventsOf(episode);
    const summary = await summarize(episode, episodeEvents);

    artifactStore.store(summary, "text");
    episodeSummaries.push(summary);
    summariesGenerated++;

    // 3a. Opt-in skill extraction (Upgrade 6). Skipped when no dep → no change.
    if (config.skillExtraction) {
      const { library, extractor, isWorthy } = config.skillExtraction;
      if (isWorthy) {
        // Override is authoritative — gate here, then stamp the body directly
        // (bypassing extractSkill's internal isSkillWorthy re-gate, which the
        // override exists to supersede).
        if (isWorthy(episode, episodeEvents)) {
          const body = await extractor(episode, episodeEvents);
          const skill = body ? stampSkill(body, episode, nowISO) : null;
          if (skill) {
            await library.put(skill);
            skillsExtracted++;
          }
        }
      } else if (isSkillWorthy(episode, episodeEvents)) {
        // Default strict path: extractSkill re-checks isSkillWorthy internally.
        const skill = await extractSkill(episode, episodeEvents, extractor, nowISO);
        if (skill) {
          await library.put(skill);
          skillsExtracted++;
        }
      }
    }
  }

  // 3b. Opt-in offline procedural-evolution steps (Upgrades 1, 4).
  //     ALL of this is skipped when no dep is injected → byte-identical output.
  const manifestEntries: ManifestEntry[] = [];
  const manifestBaseDir = config.manifestBaseDir;

  let recipeMutationsProposed = 0;
  let recipeMutationsAutoPromotable = 0;
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
    recipeMutationsAutoPromotable = proposals.filter((p) => p.autoPromotable).length;
    manifestEntries.push(...recipeMutationEntries(proposals, nowISO));

    // J5 self-apply (full autonomy): hand each autoPromotable proposal to the Prefrontal apply
    // loop via gateway RPC — engram cannot reach KitStore directly. Gated by RECIPE_AUTOAPPLY_ENABLED
    // ("true" only, so it is OFF in tests/clones). Fire-and-forget + try/caught: consolidation never
    // blocks or fails on it, and the proposal is already in the manifest as the audit trail. The
    // apply loop snapshots (rollback net), validates, and refuses hand-curated kits (authorship guard).
    if (process.env.RECIPE_AUTOAPPLY_ENABLED === "true") {
      for (const pr of proposals.filter((pp) => pp.autoPromotable)) {
        void (async () => {
          try {
            const { callGateway } = await import("../../gateway/call.js");
            await callGateway({
              method: "prefrontal.recipe.applyProposal",
              params: {
                recipeId: pr.recipeId,
                op: pr.op,
                intent: typeof pr.payload.note === "string" ? pr.payload.note : "",
                rationale: pr.rationale,
              },
              timeoutMs: 120_000,
            });
          } catch {
            // best-effort; the proposal stays in the manifest for human review
          }
        })();
      }
    }
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
  let memoryMd: MemoryMdResult | undefined;
  if (config.reconciliation) {
    const { reconciler, ledger, memoryMdMaxLines } = config.reconciliation;
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

    // Suggest-only MEMORY.md serialization (writeMemoryMd NEVER touches disk).
    // The surviving fact set = events not logically tombstoned/superseded by the
    // ledger. The Wire phase (behind ENGRAM_RECONCILE) decides whether to persist
    // the returned content + act on its demotion suggestions.
    const survivingFacts: MemoryMdFact[] = allEvents
      .filter((e) => !ledger.isTombstoned(e.id) && !ledger.isSuperseded(e.id))
      .map((e) => ({
        key: e.id,
        title: e.kind,
        summary: e.content,
        importance: e.metadata?.importance,
      }));
    memoryMd = writeMemoryMd(survivingFacts, episodeSummaries, {
      maxLines: memoryMdMaxLines ?? DEFAULT_MEMORY_MD_MAX_LINES,
    });
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
    ...(config.recipeEvolution ? { recipeMutationsProposed, recipeMutationsAutoPromotable } : {}),
    ...(config.strategySwitch ? { strategySwitchesProposed } : {}),
    ...(config.skillExtraction ? { skillsExtracted } : {}),
    ...(reconciliationDecisions ? { reconciliationDecisions } : {}),
    ...(memoryMd ? { memoryMd } : {}),
  };
}

export { createInitialConsolidationState };
