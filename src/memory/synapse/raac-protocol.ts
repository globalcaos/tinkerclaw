/**
 * SYNAPSE Phase 7B: RAAC Protocol — 5-phase structured adversarial debate.
 * Phases: Propose → Challenge → Defend → Synthesize → Ratify
 * Reference: SYNAPSE §4.2–4.3
 */

import type { ProviderProfile } from "./cognitive-diversity.js";

// ── Types ──

export interface DebateConfig {
	maxRounds: number;
	convergenceThreshold: number; // ε for semantic distance
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

export interface DebateRound {
	roundNumber: number;
	proposals: Record<string, string>;
	challenges: Record<string, Record<string, string>>; // attacker → { target → attack }
	defenses: Record<string, string>;
	synthesis: string;
	ratification: Record<string, "accept" | "reject" | "amend">;
	converged: boolean;
	costs: DebateCost[];
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

// ── Role Assignment via Bipartite Matching ──

export const ROLE_AFFINITY: Record<string, Record<string, number>> = {
	"claude-opus": { architect: 0.95, critic: 0.7, pragmatist: 0.5, researcher: 0.6, synthesizer: 0.85 },
	"gpt-o3": { architect: 0.7, critic: 0.95, pragmatist: 0.6, researcher: 0.75, synthesizer: 0.65 },
	"gemini-pro": { architect: 0.5, critic: 0.6, pragmatist: 0.95, researcher: 0.7, synthesizer: 0.6 },
	"deepseek-r1": { architect: 0.6, critic: 0.7, pragmatist: 0.5, researcher: 0.95, synthesizer: 0.55 },
	"claude-sonnet": { architect: 0.65, critic: 0.6, pragmatist: 0.7, researcher: 0.6, synthesizer: 0.95 },
};

const ALL_ROLES = ["architect", "critic", "pragmatist", "researcher", "synthesizer"];

/**
 * Greedy bipartite matching: assign roles to models maximizing total affinity.
 * Uses greedy approach (sufficient for ≤5 participants).
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
		if (usedModels.has(model) || usedRoles.has(role)) continue;
		assignment[model] = role;
		usedModels.add(model);
		usedRoles.add(role);
		if (usedModels.size === modelIds.length) break;
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

// ── Convergence Detection ──

/**
 * Simple convergence: check if synthesis texts are semantically similar.
 * Uses Jaccard similarity of word sets as a lightweight proxy for embedding distance.
 */
export function checkConvergence(
	currentSynthesis: string,
	previousSynthesis: string | undefined,
	threshold: number = DEFAULT_DEBATE_CONFIG.convergenceThreshold,
): boolean {
	if (!previousSynthesis) return false;

	const wordsA = new Set(currentSynthesis.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
	const wordsB = new Set(previousSynthesis.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

	if (wordsA.size === 0 && wordsB.size === 0) return true;

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
	const textConverged = checkConvergence(currentSynthesis, previousSynthesis, config.convergenceThreshold);

	const votes = Object.values(ratification);
	const acceptRate = votes.filter((v) => v === "accept").length / (votes.length || 1);

	// Combined: λ * textSimilarity + (1-λ) * acceptRate > (1 - threshold)
	// Simplified: if text converged AND majority accepts, converged
	const combined = config.convergenceLambda * (textConverged ? 1 : 0) + (1 - config.convergenceLambda) * acceptRate;
	return combined > 1 - config.convergenceThreshold;
}

// ── Cost Tracking ──

export function estimatePhaseCost(model: ProviderProfile, inputTokens: number, outputTokens: number): number {
	return (inputTokens / 1000) * model.costPer1kInput + (outputTokens / 1000) * model.costPer1kOutput;
}

export function totalDebateCost(costs: DebateCost[]): number {
	return costs.reduce((sum, c) => sum + c.estimatedCost, 0);
}

// ── 5-Phase Protocol ──

/**
 * Run a single debate round through all 5 phases.
 */
export async function runDebateRound(
	task: string,
	participants: DebateParticipant[],
	roundNumber: number,
	prevRound?: DebateRound,
	config: DebateConfig = DEFAULT_DEBATE_CONFIG,
): Promise<DebateRound> {
	const costs: DebateCost[] = [];

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
		inputTokens: estimateTokens(allProposals.join("") + allChallenges.join("") + allDefenses.join("")),
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
	const ratification = Object.fromEntries(ratEntries) as Record<string, "accept" | "reject" | "amend">;

	const converged = checkConvergenceWithRatification(synthesis, prevRound?.synthesis, ratification, config);

	return { roundNumber, proposals, challenges, defenses, synthesis, ratification, converged, costs };
}

/**
 * Run a full multi-round debate until convergence or max rounds.
 */
export async function runDebate(
	task: string,
	participants: DebateParticipant[],
	config: DebateConfig = DEFAULT_DEBATE_CONFIG,
): Promise<DebateResult> {
	const rounds: DebateRound[] = [];
	let converged = false;
	let convergenceRound: number | null = null;

	for (let i = 0; i < config.maxRounds; i++) {
		const prevRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
		const round = await runDebateRound(task, participants, i + 1, prevRound, config);
		rounds.push(round);

		// Budget check
		const spent = totalDebateCost(rounds.flatMap((r) => r.costs));
		if (spent >= config.maxBudgetPerDebate) break;

		// Check for ratification failure → repair (already handled in round logic)
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

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
