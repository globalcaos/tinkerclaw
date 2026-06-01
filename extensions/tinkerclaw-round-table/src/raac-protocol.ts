/**
 * SYNAPSE Phase 7B: RAAC Protocol -- 5-phase structured adversarial debate.
 * Phases: Propose -> Challenge -> Defend -> Synthesize -> Ratify
 *
 * Self-contained copy for the tinkerclaw-round-table extension.
 * Original: src/memory/synapse/raac-protocol.ts
 */

import type { ProviderProfile } from "./cognitive-diversity.js";

// -- Types --

export interface DebateConfig {
  maxRounds: number;
  convergenceThreshold: number; // epsilon for semantic distance
  convergenceLambda: number; // weight: embed distance vs judge agreement
  ratificationThreshold: number; // >50% REJECT triggers repair
  maxBudgetPerDebate: number; // USD
  warningThreshold: number; // USD
}

export const DEFAULT_DEBATE_CONFIG: DebateConfig = {
  maxRounds: 5,
  convergenceThreshold: 0.1,
  convergenceLambda: 0.5,
  ratificationThreshold: 0.5,
  maxBudgetPerDebate: 5.0,
  warningThreshold: 2.0,
};

export interface DebateParticipant {
  modelId: string;
  role: string;
  profile: ProviderProfile;
  /** Generate a proposal for the task. */
  propose(task: string, role: string, priorSynthesis?: string): Promise<string>;
  /** Challenge another participant's proposal. */
  challenge(proposal: string, role: string): Promise<string>;
  /** Defend against challenges. */
  defend(attacks: string[], role: string): Promise<string>;
  /** Synthesize all proposals, challenges, and defenses. */
  synthesize(proposals: string[], challenges: string[], defenses: string[]): Promise<string>;
  /** Vote on a synthesis. */
  ratify(synthesis: string): Promise<"accept" | "reject" | "amend">;
}

export interface DebateCost {
  phase: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface Dropout {
  modelId: string;
  phase: string;
  reason: string;
}

export interface DebateRound {
  roundNumber: number;
  proposals: Record<string, string>;
  challenges: Record<string, Record<string, string>>; // attacker -> { target -> attack }
  defenses: Record<string, string>;
  synthesis: string;
  ratification: Record<string, "accept" | "reject" | "amend">;
  converged: boolean;
  costs: DebateCost[];
  /** 7E: participants whose phase response was a sentinel and could not be recovered. */
  dropouts?: Dropout[];
}

export interface DebateResult {
  task: string;
  rounds: DebateRound[];
  finalSynthesis: string;
  totalCosts: DebateCost[];
  totalEstimatedCost: number;
  converged: boolean;
  convergenceRound: number | null;
}

// -- 7D: Cost-aware debate budget (billing-gate-aware) --

/**
 * 7D: remaining spend headroom for the current subscription/metered window, as
 * reported by the gateway billing state. `source` discriminates how the number
 * was derived; `"unknown"` means the gateway could not (or does not) report a
 * real figure, in which case the budget resolver becomes a no-op (today's
 * behaviour is preserved — see resolveDebateBudget).
 */
export interface BillingHeadroom {
  remainingUsd: number;
  source: "subscription" | "metered" | "unknown";
}

/** 7D: default fraction of remaining headroom a single debate may consume. */
export const DEFAULT_BUDGET_HEADROOM_FRACTION = 0.2;

/**
 * 7D: tie the per-debate USD cap to real billing headroom.
 *
 *   activeBudget = min(depthBudget, fraction * remainingHeadroom)
 *
 * - When `headroom` is absent or its `source` is `"unknown"`, returns
 *   `depthBudget` unchanged (non-blocking: identical to pre-7D behaviour, so an
 *   absent `agent.getBillingState` RPC degrades gracefully).
 * - Never returns a negative number (a negative `remainingUsd` clamps to 0, as
 *   does a negative `depthBudget`).
 *
 * Async so a caller can `await` a billing RPC inline without changing call sites
 * once the real headroom is threaded in.
 */
export async function resolveDebateBudget(
  depthBudget: number,
  headroom?: BillingHeadroom,
  fraction: number = DEFAULT_BUDGET_HEADROOM_FRACTION,
): Promise<number> {
  if (!headroom || headroom.source === "unknown") {
    return Math.max(0, depthBudget);
  }
  const fromHeadroom = fraction * headroom.remainingUsd;
  return Math.max(0, Math.min(depthBudget, fromHeadroom));
}

// -- Role Assignment via Bipartite Matching --

export const ROLE_AFFINITY: Record<string, Record<string, number>> = {
  "claude-opus": {
    architect: 0.95,
    critic: 0.7,
    pragmatist: 0.5,
    researcher: 0.6,
    synthesizer: 0.85,
  },
  "gpt-o3": { architect: 0.7, critic: 0.95, pragmatist: 0.6, researcher: 0.75, synthesizer: 0.65 },
  "gemini-pro": {
    architect: 0.5,
    critic: 0.6,
    pragmatist: 0.95,
    researcher: 0.7,
    synthesizer: 0.6,
  },
  "deepseek-r1": {
    architect: 0.6,
    critic: 0.7,
    pragmatist: 0.5,
    researcher: 0.95,
    synthesizer: 0.55,
  },
  "claude-sonnet": {
    architect: 0.65,
    critic: 0.6,
    pragmatist: 0.7,
    researcher: 0.6,
    synthesizer: 0.95,
  },
};

// Must stay in sync with ROLE_AFFINITY keys
const ALL_ROLES = ["architect", "critic", "pragmatist", "researcher", "synthesizer"] as const;

/**
 * Greedy bipartite matching: assign roles to models maximizing total affinity.
 * Uses greedy approach (sufficient for <=5 participants).
 */
export function assignRoles(modelIds: string[]): Record<string, string> {
  const assignment: Record<string, string> = {};
  const usedRoles = new Set<string>();
  const usedModels = new Set<string>();

  // Build all (model, role, score) pairs sorted by score desc
  const pairs: { model: string; role: string; score: number }[] = [];
  for (const model of modelIds) {
    const affinities = ROLE_AFFINITY[model] ?? {};
    for (const role of ALL_ROLES) {
      pairs.push({ model, role, score: affinities[role] ?? 0.5 });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  for (const { model, role } of pairs) {
    if (usedModels.has(model) || usedRoles.has(role)) {
      continue;
    }
    assignment[model] = role;
    usedModels.add(model);
    usedRoles.add(role);
    if (usedModels.size === modelIds.length) {
      break;
    }
  }

  // Assign remaining models to remaining roles
  for (const model of modelIds) {
    if (!assignment[model]) {
      for (const role of ALL_ROLES) {
        if (!usedRoles.has(role)) {
          assignment[model] = role;
          usedRoles.add(role);
          break;
        }
      }
      // If all roles taken, assign generic
      if (!assignment[model]) {
        assignment[model] = "participant";
      }
    }
  }

  return assignment;
}

// -- 7E: Dropout detection & recovery --

/**
 * Matches the exact sentinel text index.ts emits when a participant call fails:
 *   `[${model}/${role}] (error)` or `[${model}/${role}] (no response)`.
 * The model ref itself contains a slash (e.g. "openai/o3"), so the bracketed part is
 * matched non-greedily across any chars; the trailing parenthetical is the signal.
 */
export const DROPOUT_SENTINEL = /^\[.+\] \((error|no response)\)$/;

/** 7E: true when `text` is a participant-failure sentinel, not a real response. */
export function isDropout(text: string): boolean {
  return DROPOUT_SENTINEL.test(text.trim());
}

/**
 * 7E: recover a phase's `responses` map in place. For each id whose response is a
 * sentinel, ask `selectBackup(role)` for a not-yet-active backup profile and re-issue
 * the call once via `callBackup`. If the backup also returns a sentinel (or no backup
 * exists), record a Dropout. Returns the dropouts collected (responses mutated).
 *
 * Recovery is a SECOND serialized pass after the parallel phase — it raises latency
 * and re-spends budget (the backup call is charged like any other), and caps backup
 * attempts at 1 per slot so a provider-wide outage cannot loop.
 */
export async function recoverPhase(
  phase: string,
  responses: Record<string, string>,
  roleOf: (modelId: string) => string,
  selectBackup: (role: string, activeIds: Set<string>) => DebateParticipant | null,
  callBackup: (backup: DebateParticipant, phase: string) => Promise<string>,
): Promise<Dropout[]> {
  const dropouts: Dropout[] = [];
  const activeIds = new Set(Object.keys(responses));

  for (const [modelId, text] of Object.entries(responses)) {
    if (!isDropout(text)) continue;
    const role = roleOf(modelId);
    const backup = selectBackup(role, activeIds);
    if (!backup) {
      dropouts.push({ modelId, phase, reason: "no backup available" });
      continue;
    }
    let recovered: string;
    try {
      recovered = await callBackup(backup, phase);
    } catch {
      recovered = `[${backup.modelId}/${role}] (error)`;
    }
    if (isDropout(recovered)) {
      dropouts.push({ modelId, phase, reason: "backup also failed" });
    } else {
      // Promote the backup's text in place of the dropped participant's slot.
      responses[modelId] = recovered;
      activeIds.add(backup.modelId);
    }
  }
  return dropouts;
}

// -- Convergence Detection --

/**
 * Simple convergence: check if synthesis texts are semantically similar.
 * Uses Jaccard similarity of word sets as a lightweight proxy for embedding distance.
 */
export function checkConvergence(
  currentSynthesis: string,
  previousSynthesis: string | undefined,
  threshold: number = DEFAULT_DEBATE_CONFIG.convergenceThreshold,
): boolean {
  if (!previousSynthesis) {
    return false;
  }

  const wordsA = new Set(
    currentSynthesis
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const wordsB = new Set(
    previousSynthesis
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  if (wordsA.size === 0 && wordsB.size === 0) {
    return true;
  }

  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  const jaccard = union.size > 0 ? intersection.size / union.size : 0;
  // High jaccard = similar = converged. threshold is the max distance, so converged if (1-jaccard) < threshold
  return 1 - jaccard < threshold;
}

/**
 * Check convergence with a combined metric: text similarity + ratification agreement.
 */
export function checkConvergenceWithRatification(
  currentSynthesis: string,
  previousSynthesis: string | undefined,
  ratification: Record<string, "accept" | "reject" | "amend">,
  config: DebateConfig = DEFAULT_DEBATE_CONFIG,
): boolean {
  const textConverged = checkConvergence(
    currentSynthesis,
    previousSynthesis,
    config.convergenceThreshold,
  );

  const votes = Object.values(ratification);
  const acceptRate = votes.filter((v) => v === "accept").length / (votes.length || 1);

  // Combined: lambda * textSimilarity + (1-lambda) * acceptRate > (1 - threshold)
  // Simplified: if text converged AND majority accepts, converged
  const combined =
    config.convergenceLambda * (textConverged ? 1 : 0) +
    (1 - config.convergenceLambda) * acceptRate;
  return combined > 1 - config.convergenceThreshold;
}

// -- Cost Tracking --

export function estimatePhaseCost(
  model: ProviderProfile,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1000) * model.costPer1kInput + (outputTokens / 1000) * model.costPer1kOutput
  );
}

export function totalDebateCost(costs: DebateCost[]): number {
  return costs.reduce((sum, c) => sum + c.estimatedCost, 0);
}

// -- 5-Phase Protocol --

/**
 * Run a single debate round through all 5 phases.
 */
/**
 * 7E: optional dropout-recovery wiring. When supplied, the PROPOSE phase is scanned
 * for sentinel responses and each is recovered via a promoted backup participant (one
 * attempt). Omitting `recovery` leaves runDebateRound behaviour byte-identical to the
 * original protocol (the existing test suite asserts this).
 */
export interface RecoveryHooks {
  /** Pick a not-yet-active backup for a dropped role, or null. */
  selectBackup: (role: string, activeIds: Set<string>) => DebateParticipant | null;
  /** Re-issue the failing phase for the backup; resolves to the backup's text. */
  callBackup: (backup: DebateParticipant, phase: string) => Promise<string>;
}

export async function runDebateRound(
  task: string,
  participants: DebateParticipant[],
  roundNumber: number,
  prevRound?: DebateRound,
  config: DebateConfig = DEFAULT_DEBATE_CONFIG,
  recovery?: RecoveryHooks,
): Promise<DebateRound> {
  const costs: DebateCost[] = [];
  const dropouts: Dropout[] = [];

  // Phase 1: PROPOSE (parallel)
  const proposalEntries = await Promise.all(
    participants.map(async (p) => {
      const proposal = await p.propose(task, p.role, prevRound?.synthesis);
      costs.push({
        phase: "propose",
        model: p.modelId,
        inputTokens: estimateTokens(task + (prevRound?.synthesis ?? "")),
        outputTokens: estimateTokens(proposal),
        estimatedCost: estimatePhaseCost(p.profile, estimateTokens(task), estimateTokens(proposal)),
      });
      return [p.modelId, proposal] as const;
    }),
  );
  const proposals = Object.fromEntries(proposalEntries);

  // 7E: detect sentinel proposals and promote a backup rather than letting the
  // sentinel flow into challenge/synthesize as a real proposal (recon Risk 3).
  if (recovery) {
    const roleOf = (modelId: string): string =>
      participants.find((p) => p.modelId === modelId)?.role ?? "participant";
    const phaseDropouts = await recoverPhase(
      "propose",
      proposals,
      roleOf,
      recovery.selectBackup,
      recovery.callBackup,
    );
    dropouts.push(...phaseDropouts);
  }

  // Phase 2: CHALLENGE (each challenges all others, parallel)
  const challenges: Record<string, Record<string, string>> = {};
  await Promise.all(
    participants.map(async (attacker) => {
      challenges[attacker.modelId] = {};
      await Promise.all(
        participants
          .filter((t) => t.modelId !== attacker.modelId)
          .map(async (target) => {
            const challenge = await attacker.challenge(proposals[target.modelId], attacker.role);
            challenges[attacker.modelId][target.modelId] = challenge;
            costs.push({
              phase: "challenge",
              model: attacker.modelId,
              inputTokens: estimateTokens(proposals[target.modelId]),
              outputTokens: estimateTokens(challenge),
              estimatedCost: estimatePhaseCost(
                attacker.profile,
                estimateTokens(proposals[target.modelId]),
                estimateTokens(challenge),
              ),
            });
          }),
      );
    }),
  );

  // Phase 3: DEFEND (parallel)
  const defenseEntries = await Promise.all(
    participants.map(async (p) => {
      const attacks = Object.values(challenges)
        .map((c) => c[p.modelId])
        .filter(Boolean);
      const defense = await p.defend(attacks, p.role);
      costs.push({
        phase: "defend",
        model: p.modelId,
        inputTokens: attacks.reduce((s, a) => s + estimateTokens(a), 0),
        outputTokens: estimateTokens(defense),
        estimatedCost: estimatePhaseCost(
          p.profile,
          attacks.reduce((s, a) => s + estimateTokens(a), 0),
          estimateTokens(defense),
        ),
      });
      return [p.modelId, defense] as const;
    }),
  );
  const defenses = Object.fromEntries(defenseEntries);

  // Phase 4: SYNTHESIZE (single synthesizer)
  const synthesizer = participants.find((p) => p.role === "synthesizer") ?? participants[0];
  const allProposals = Object.values(proposals);
  const allChallenges = Object.values(challenges).flatMap((c) => Object.values(c));
  const allDefenses = Object.values(defenses);
  const synthesis = await synthesizer.synthesize(allProposals, allChallenges, allDefenses);
  costs.push({
    phase: "synthesize",
    model: synthesizer.modelId,
    inputTokens: estimateTokens(
      allProposals.join("") + allChallenges.join("") + allDefenses.join(""),
    ),
    outputTokens: estimateTokens(synthesis),
    estimatedCost: estimatePhaseCost(
      synthesizer.profile,
      estimateTokens(allProposals.join("") + allChallenges.join("") + allDefenses.join("")),
      estimateTokens(synthesis),
    ),
  });

  // Phase 5: RATIFY (parallel)
  const ratEntries = await Promise.all(
    participants.map(async (p) => {
      const vote = await p.ratify(synthesis);
      costs.push({
        phase: "ratify",
        model: p.modelId,
        inputTokens: estimateTokens(synthesis),
        outputTokens: 5, // single word
        estimatedCost: estimatePhaseCost(p.profile, estimateTokens(synthesis), 5),
      });
      return [p.modelId, vote] as const;
    }),
  );
  const ratification = Object.fromEntries(ratEntries) as Record<
    string,
    "accept" | "reject" | "amend"
  >;

  const converged = checkConvergenceWithRatification(
    synthesis,
    prevRound?.synthesis,
    ratification,
    config,
  );

  return {
    roundNumber,
    proposals,
    challenges,
    defenses,
    synthesis,
    ratification,
    converged,
    costs,
    ...(dropouts.length > 0 ? { dropouts } : {}),
  };
}

/**
 * 7F: cross-tool-call context carried into a resumed debate. Today it carries the
 * prior debate's last synthesis, which round 1's PROPOSE phase picks up exactly the
 * way an intra-debate prevRound synthesis already does (real-participant.ts seeds
 * `priorSynthesis` into the propose prompt). Optional and additive — omitting it
 * leaves runDebate behaviour byte-identical to the original (the existing suite
 * asserts this).
 */
export interface ContextMixin {
  priorSynthesis?: string;
}

/**
 * Run a full multi-round debate until convergence or max rounds.
 *
 * 7F: an optional `contextMixin` seeds round 1's propose with a prior synthesis
 * (multi-turn speaker memory) without changing the per-round protocol — round 1 is
 * given a synthetic `prevRound` whose only populated field is `synthesis`, which
 * `runDebateRound` already threads into `propose(task, role, prevRound.synthesis)`.
 */
export async function runDebate(
  task: string,
  participants: DebateParticipant[],
  config: DebateConfig = DEFAULT_DEBATE_CONFIG,
  recovery?: RecoveryHooks,
  contextMixin?: ContextMixin,
): Promise<DebateResult> {
  const rounds: DebateRound[] = [];
  let converged = false;
  let convergenceRound: number | null = null;

  // 7F: a non-empty priorSynthesis from a resumed debate seeds round 1 only. It is
  // context, NOT live state — never replayed as a real round (so it is not pushed
  // into `rounds` and does not affect convergence/cost math), only handed to
  // round 1's propose via the prevRound.synthesis seam.
  const seededPrior =
    contextMixin?.priorSynthesis && contextMixin.priorSynthesis.trim().length > 0
      ? ({ synthesis: contextMixin.priorSynthesis } as Pick<DebateRound, "synthesis">)
      : undefined;

  for (let i = 0; i < config.maxRounds; i++) {
    const prevRound =
      rounds.length > 0 ? rounds[rounds.length - 1] : (seededPrior as DebateRound | undefined);
    const round = await runDebateRound(task, participants, i + 1, prevRound, config, recovery);
    rounds.push(round);

    // Budget check
    const spent = totalDebateCost(rounds.flatMap((r) => r.costs));
    if (spent >= config.maxBudgetPerDebate) {
      break;
    }

    // Check for ratification failure -> repair (already handled in round logic)
    const rejectCount = Object.values(round.ratification).filter((v) => v === "reject").length;
    if (rejectCount > participants.length * config.ratificationThreshold) {
      // Continue to next round (repair round)
      continue;
    }

    if (round.converged) {
      converged = true;
      convergenceRound = i + 1;
      break;
    }
  }

  const allCosts = rounds.flatMap((r) => r.costs);
  return {
    task,
    rounds,
    finalSynthesis: rounds[rounds.length - 1]?.synthesis ?? "",
    totalCosts: allCosts,
    totalEstimatedCost: totalDebateCost(allCosts),
    converged,
    convergenceRound,
  };
}

// Local approximation: ~4 chars per token. Avoids importing engram event-store
// into the protocol layer, which would create a circular dependency.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
