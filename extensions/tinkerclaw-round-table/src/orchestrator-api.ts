/**
 * 7G: Swappable orchestrator contract.
 *
 * `runDebate` (raac-protocol.ts) is the only orchestration path today and it hardcodes
 * the 5-phase RAAC choreography. 7G defines a `DebateOrchestrator` contract so any
 * choreography (RAAC, fan-out, sequential, moderated-tribunal, or an external
 * AG2-style manager) can drive the SAME `callModel` fabric. This turns SYNAPSE from
 * "a protocol" into "a platform" — the strongest version of the paper's open-substrate
 * claim.
 *
 * RAAC stays the default and `raacOrchestrator.runDebate` wraps the existing function
 * UNCHANGED, so every current test passes byte-for-byte. Non-RAAC architectures from
 * debate-architectures.ts are exposed through a thin adapter that maps their
 * `ArchitectureResult` onto the universal `DebateResult` shape (sparse rounds — they
 * have no challenge/ratify phases).
 */

import {
  fanOut,
  moderatedTribunal,
  sequential,
  type ArchitectureResult,
} from "./debate-architectures.js";
import {
  runDebate,
  type ContextMixin,
  type DebateConfig,
  type DebateParticipant,
  type DebateResult,
  type RecoveryHooks,
} from "./raac-protocol.js";

/**
 * 7G: choreography-agnostic debate driver. Every orchestrator consumes the same
 * `(task, participants, config)` fabric and returns the universal `DebateResult`.
 * `recovery` (7E dropout recovery) and `contextMixin` (7F multi-turn memory) are
 * forwarded so swapping the orchestrator never silently drops those capabilities.
 *
 * NOTE: the per-debate budget cap (7D `config.maxBudgetPerDebate`) is enforced
 * INSIDE the RAAC `runDebate` loop. Non-RAAC orchestrators that don't honour it must
 * be wrapped by the caller (index.ts) if a hard cap is required — the contract
 * obligation is documented here rather than re-implemented per orchestrator.
 */
export interface DebateOrchestrator {
  id: string;
  name: string;
  runDebate(
    task: string,
    participants: DebateParticipant[],
    config: DebateConfig,
    recovery?: RecoveryHooks,
    contextMixin?: ContextMixin,
  ): Promise<DebateResult>;
}

/**
 * 7G: the default orchestrator. Wraps the bare `runDebate` with NO behavioural change
 * — `raacOrchestrator.runDebate(...args)` === `runDebate(...args)` — so the existing
 * raac-protocol suite is the regression guard for this orchestrator.
 */
export const raacOrchestrator: DebateOrchestrator = {
  id: "raac",
  name: "RAAC 5-phase",
  runDebate,
};

/**
 * 7G adapter: widen an `ArchitectureResult` (fan-out / sequential / tribunal) onto the
 * universal `DebateResult`. These choreographies have no challenge/defend/ratify
 * phases, so the synthesized output becomes a single synthetic round's synthesis and
 * ratification is left empty (the persistence/meta-pattern layer will see a sparse
 * trace — expected for non-RAAC orchestrators).
 */
function architectureResultToDebateResult(ar: ArchitectureResult): DebateResult {
  return {
    task: ar.task,
    rounds: [
      {
        roundNumber: 1,
        proposals: {},
        challenges: {},
        defenses: {},
        synthesis: ar.output,
        ratification: {},
        converged: true,
        costs: ar.costs,
      },
    ],
    finalSynthesis: ar.output,
    totalCosts: ar.costs,
    totalEstimatedCost: ar.totalEstimatedCost,
    converged: true,
    convergenceRound: 1,
  };
}

function architectureOrchestrator(
  id: string,
  name: string,
  fn: (task: string, participants: DebateParticipant[]) => Promise<ArchitectureResult>,
): DebateOrchestrator {
  return {
    id,
    name,
    async runDebate(task, participants) {
      // ArchitectureResult adapter: recovery/contextMixin are RAAC-specific seams and
      // are intentionally not forwarded to the simpler architectures.
      return architectureResultToDebateResult(await fn(task, participants));
    },
  };
}

/**
 * 7G: the builtin non-RAAC architectures, exposed as orchestrators so the existing
 * fan-out / sequential / moderated-tribunal choreographies become reachable via
 * `orchestratorId` instead of being dead code the tool never calls.
 */
export const BUILTIN_ARCHITECTURE_ORCHESTRATORS: Record<string, DebateOrchestrator> = {
  "fan-out": architectureOrchestrator("fan-out", "Fan-Out", fanOut),
  sequential: architectureOrchestrator("sequential", "Sequential", sequential),
  "moderated-tribunal": architectureOrchestrator(
    "moderated-tribunal",
    "Moderated Tribunal",
    moderatedTribunal,
  ),
};

/**
 * 7G: external orchestrator loader hook. An AG2-style manager living in a sibling
 * plugin can register an orchestrator the gateway hands back here. Kept as an
 * injectable so the resolution path is unit-testable and so this extension carries no
 * hard dependency on a provider being present (null on miss). READY; binds once
 * plugins.getOrchestrator ships — that gateway RPC does not exist yet, so the loader
 * index.ts wires always returns null and getOrchestrator falls back to a builtin.
 */
export type ExternalOrchestratorLoader = (id: string) => Promise<DebateOrchestrator | null>;

let externalLoader: ExternalOrchestratorLoader | null = null;

/** 7G: register the external-orchestrator loader (index.ts wires the gateway RPC). */
export function setExternalOrchestratorLoader(loader: ExternalOrchestratorLoader | null): void {
  externalLoader = loader;
}

/**
 * 7G: resolve an orchestrator by id. Precedence: RAAC default -> builtin architecture
 * orchestrators -> external loader (sibling plugin / gateway). Returns null on a miss
 * so the caller can fall back to `raacOrchestrator`.
 */
export async function getOrchestrator(id: string): Promise<DebateOrchestrator | null> {
  if (id === "raac") return raacOrchestrator;
  if (id in BUILTIN_ARCHITECTURE_ORCHESTRATORS) return BUILTIN_ARCHITECTURE_ORCHESTRATORS[id];
  if (externalLoader) {
    try {
      return await externalLoader(id);
    } catch {
      return null;
    }
  }
  return null;
}
