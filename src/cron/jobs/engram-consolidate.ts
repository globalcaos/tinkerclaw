/**
 * FORK — Upgrade 4 runtime wiring: ENGRAM sleep-consolidation cron job.
 *
 * Runs the offline consolidation pipeline (sleep-consolidation.ts) across every
 * session event store, with the per-upgrade procedural-evolution lanes wired in:
 *  - U4 failure-count → strategy-switch loop: loads the durable per-strategy
 *    failure-state map (failure-tracking-store.ts), hands it to
 *    runSleepConsolidation as `StrategySwitchDeps` (the loop mutates the map in
 *    place and writes gated switch proposals to the daily manifest), persists it.
 *  - U6 post-episode skill extraction: injects a never-delete `SkillLibrary`
 *    (createSkillLibrary, the same one fork.skill.* RPCs read) plus a deterministic
 *    no-LLM `SkillExtractor`. The strict `isSkillWorthy` gate keeps the library
 *    from filling — and since SS3 Task 0b `detectEpisodes` derives keyDecisions
 *    from a multi-step procedure's tool-call trace, so genuinely-worthy episodes
 *    now extract a skill while trivial one-shots are still declined.
 *  - U8 Mem0 write-reconciliation: gated behind `ENGRAM_RECONCILE` (default OFF →
 *    today's behavior). The default reconciler is `createAlwaysAddReconciler()`
 *    (every event ADD, nothing reconciled away), with a persisted ledger.
 *  - U1 offline recipe-fitness/evolution loop: injects a `RecipeArchive`
 *    (createRecipeArchive) so recipe-tagged episodes accrue fitness + gated
 *    mutation proposals into the daily manifest.
 *
 * Every lane is opt-in / safe-default: absence of a backend (no embed provider,
 * ENGRAM_RECONCILE unset, declining extractor) leaves the consolidation output
 * exactly as it was before this wiring landed.
 *
 * This module exports a self-describing JOB DESCRIPTOR (`engramConsolidateJob`).
 * The Wire phase registers it in the cron registry — this module deliberately
 * does NOT import or mutate the registry itself (single-owner: registry edits
 * belong to the Wire phase).
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrades 1/4/6/8).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createArtifactStore } from "../../memory/engram/artifact-store.js";
import {
  type ConsolidationState,
  type Episode,
  createInitialConsolidationState,
} from "../../memory/engram/episode-detection.js";
import { createEventStore } from "../../memory/engram/event-store.js";
import type { MemoryEvent } from "../../memory/engram/event-types.js";
import {
  loadFailureStateMap,
  saveFailureStateMap,
} from "../../memory/engram/failure-tracking-store.js";
import type { FailureStateMap } from "../../memory/engram/failure-tracking.js";
import { createRecipeArchive } from "../../memory/engram/recipe-archive.js";
import { createReconciliationLedger } from "../../memory/engram/reconciliation-ledger.js";
import { createAlwaysAddReconciler } from "../../memory/engram/reconciliation.js";
import { resolveSkillEmbedFn } from "../../memory/engram/skill-embed.js";
import type { SkillBody, SkillExtractor } from "../../memory/engram/skill-extraction.js";
import { createSkillLibrary } from "../../memory/engram/skill-library.js";
import {
  runSleepConsolidation as runSleepConsolidationImpl,
  type ConsolidationResult,
  type SleepConsolidationConfig,
} from "../../memory/engram/sleep-consolidation.js";

/**
 * Indirection seam over runSleepConsolidation so a test can spy on the EXACT
 * config (skillExtraction / reconciliation / recipeEvolution deps) this job
 * injects at the real call site. Mirrors the `__set…ForTest` hook convention in
 * fork/memory-rpc.ts. Default = the real implementation.
 */
type RunSleepConsolidationFn = typeof runSleepConsolidationImpl;
let runSleepConsolidation: RunSleepConsolidationFn = runSleepConsolidationImpl;

/** TEST-ONLY: override runSleepConsolidation (pass undefined to restore the real impl). */
export function __setRunSleepConsolidationForTest(fn: RunSleepConsolidationFn | undefined): void {
  runSleepConsolidation = fn ?? runSleepConsolidationImpl;
}

/** Minimal, self-describing cron job descriptor the Wire phase can register. */
export interface ForkCronJobDescriptor {
  /** Stable unique id for the cron registry. */
  id: string;
  /** Cron expression (default: nightly at 04:00). */
  schedule: string;
  /** Human-readable label. */
  description: string;
  /** Idempotent runner; resolves with a summary the cron service can log. */
  run: (opts?: EngramConsolidateOptions) => Promise<EngramConsolidateResult>;
}

export interface EngramConsolidateOptions {
  /** ENGRAM root (default `~/.openclaw/engram`). Override in tests. */
  baseDir?: string;
  /** Restrict to a single session (default: all sessions found on disk). */
  sessionFilter?: string;
  /** Logger (default no-op so the cron service controls logging). */
  log?: (msg: string) => void;
  /**
   * Extra per-run config forwarded into runSleepConsolidation (e.g. an
   * LLM-backed `summarizeEpisode`, or `strategySwitch.config` overrides). The
   * `strategySwitch.state` and `manifestBaseDir` fields are managed by this job.
   */
  config?: Omit<SleepConsolidationConfig, "strategySwitch" | "manifestBaseDir">;
}

export interface EngramConsolidateResult {
  sessionsProcessed: number;
  episodes: number;
  eventsProcessed: number;
  strategySwitchesProposed: number;
  /** U6 skills distilled into the library this run (0 when the lane declines). */
  skillsExtracted: number;
  /** U1 gated recipe-mutation proposals written this run. */
  recipeMutationsProposed: number;
  /** U8 reconciliation UPDATE/DELETE ledger entries this run (only when ENGRAM_RECONCILE). */
  reconciliationDecisions: { updated: number; deleted: number };
  baseDir: string;
}

function engramRoot(baseDir?: string): string {
  return baseDir ?? join(process.env.OPENCLAW_HOME ?? homedir(), ".openclaw", "engram");
}

function consolidationStatePath(baseDir: string): string {
  return join(baseDir, "consolidation-state.json");
}

function loadConsolidationState(baseDir: string): Record<string, ConsolidationState> {
  const path = consolidationStatePath(baseDir);
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, ConsolidationState>;
  } catch {
    return {};
  }
}

function saveConsolidationState(baseDir: string, state: Record<string, ConsolidationState>): void {
  const path = consolidationStatePath(baseDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * Deterministic, no-LLM default skill extractor. Synthesizes a "skill-as-recipe"
 * body (steps[] = the episode's tool-call sequence) from a skill-WORTHY episode.
 * Production has no LLM-backed extractor wired yet, so this safe default keeps the
 * U6 lane live without inventing a model dependency: the strict `isSkillWorthy`
 * gate (applied by runSleepConsolidation BEFORE this runs) already requires a
 * completed, tool-using episode with ≥1 keyDecision. Since SS3 Task 0b,
 * `detectEpisodes` derives keyDecisions from a multi-step procedure's tool-call
 * trace, so a genuinely-worthy episode now reaches this extractor and a real
 * skill is synthesized (a lone one-shot tool call still yields no keyDecisions
 * and is declined upstream). Returns null on a body that would be empty so no
 * spurious skill ever enters the library.
 */
function defaultSkillExtractor(episode: Episode, episodeEvents: MemoryEvent[]): SkillBody | null {
  const steps = episodeEvents
    .filter((e) => e.kind === "tool_call")
    .map((e) => e.content.slice(0, 200))
    .filter((s) => s.length > 0);
  if (steps.length === 0) {
    return null; // no executable core → decline (mirrors isSkillWorthy's tool gate)
  }
  return {
    name: episode.topic || `skill-${episode.id}`,
    description: `Distilled from episode ${episode.id} (${episode.outcome}).`,
    prerequisites: [],
    steps,
    testCases: [],
  };
}

/**
 * Run sleep consolidation across all session event stores, with the
 * strategy-switch loop wired to the durable failure-state map.
 */
export async function runEngramConsolidate(
  opts: EngramConsolidateOptions = {},
): Promise<EngramConsolidateResult> {
  const baseDir = engramRoot(opts.baseDir);
  const log = opts.log ?? (() => {});
  const eventsDir = join(baseDir, "events");

  const result: EngramConsolidateResult = {
    sessionsProcessed: 0,
    episodes: 0,
    eventsProcessed: 0,
    strategySwitchesProposed: 0,
    skillsExtracted: 0,
    recipeMutationsProposed: 0,
    reconciliationDecisions: { updated: 0, deleted: 0 },
    baseDir,
  };

  if (!existsSync(eventsDir)) {
    log(`[engram-consolidate] no events dir at ${eventsDir}; nothing to do.`);
    return result;
  }

  const sessions = readdirSync(eventsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, ".jsonl"))
    .filter((s) => !opts.sessionFilter || s === opts.sessionFilter);

  if (sessions.length === 0) {
    return result;
  }

  const consolidationState = loadConsolidationState(baseDir);
  // ONE shared failure-state map across all sessions: a strategy can recur in
  // more than one session, and its consecutive-error count must be global.
  const failureState: FailureStateMap = loadFailureStateMap(baseDir);
  const artifactStore = createArtifactStore({ baseDir });

  // --- Procedural-evolution lane deps, built once and shared across sessions ---
  // (so a skill/recipe recurring in multiple sessions accrues a single version
  // history + fitness, mirroring the global failure-state map above).
  const embedFn = await resolveSkillEmbedFn();

  // U6: never-delete skill library (same store the fork.skill.* RPCs read), with
  // a deterministic no-LLM extractor. Caller-supplied skillExtraction (e.g. a
  // test stub or an LLM-backed extractor) wins over this default.
  const skillExtraction: SleepConsolidationConfig["skillExtraction"] = opts.config
    ?.skillExtraction ?? {
    library: createSkillLibrary({ baseDir, ...(embedFn ? { embedFn } : {}) }),
    extractor: defaultSkillExtractor as SkillExtractor,
  };

  // U1: offline recipe-fitness/evolution archive. Caller override wins.
  const recipeEvolution: SleepConsolidationConfig["recipeEvolution"] = opts.config
    ?.recipeEvolution ?? { archive: createRecipeArchive({ baseDir }) };

  // U8: Mem0 write-reconciliation — OPT-IN behind ENGRAM_RECONCILE ("true" only,
  // so it is OFF in tests/clones). Default reconciler ADDs every event (nothing
  // reconciled away), backed by a persisted ledger. Caller override wins.
  const reconciliation: SleepConsolidationConfig["reconciliation"] | undefined =
    opts.config?.reconciliation ??
    (process.env.ENGRAM_RECONCILE === "true"
      ? {
          reconciler: createAlwaysAddReconciler(),
          ledger: createReconciliationLedger({
            filePath: join(baseDir, "reconciliation-ledger.json"),
          }),
        }
      : undefined);

  for (const sessionKey of sessions) {
    const store = createEventStore({ baseDir, sessionKey });
    if (store.count() === 0) {
      continue;
    }
    const sessionState = consolidationState[sessionKey] ?? createInitialConsolidationState();

    const runResult: ConsolidationResult = await runSleepConsolidation(
      store,
      artifactStore,
      sessionState,
      {
        ...opts.config,
        manifestBaseDir: baseDir,
        strategySwitch: { state: failureState },
        skillExtraction,
        recipeEvolution,
        ...(reconciliation ? { reconciliation } : {}),
      },
    );

    consolidationState[sessionKey] = sessionState;
    result.sessionsProcessed++;
    result.episodes += runResult.newEpisodes.length;
    result.eventsProcessed += runResult.eventsProcessed;
    result.strategySwitchesProposed += runResult.strategySwitchesProposed ?? 0;
    result.skillsExtracted += runResult.skillsExtracted ?? 0;
    result.recipeMutationsProposed += runResult.recipeMutationsProposed ?? 0;
    if (runResult.reconciliationDecisions) {
      result.reconciliationDecisions.updated += runResult.reconciliationDecisions.updated;
      result.reconciliationDecisions.deleted += runResult.reconciliationDecisions.deleted;
    }
  }

  // Persist both cursors atomically.
  saveConsolidationState(baseDir, consolidationState);
  saveFailureStateMap(failureState, baseDir);

  log(
    `[engram-consolidate] sessions=${result.sessionsProcessed} episodes=${result.episodes} events=${result.eventsProcessed} switches=${result.strategySwitchesProposed} skills=${result.skillsExtracted} recipeMutations=${result.recipeMutationsProposed} reconcile=${result.reconciliationDecisions.updated}/${result.reconciliationDecisions.deleted}`,
  );
  return result;
}

/**
 * Job descriptor for the Wire phase to register in the cron registry.
 * Default schedule: nightly at 04:00 (the canonical sleep-consolidation slot).
 */
export const engramConsolidateJob: ForkCronJobDescriptor = {
  id: "engram-consolidate",
  schedule: "0 4 * * *",
  description:
    "ENGRAM nightly sleep-consolidation: strategy-switch (U4) + skill-extraction (U6) + recipe-evolution (U1) + reconciliation (U8, gated by ENGRAM_RECONCILE)",
  run: runEngramConsolidate,
};
