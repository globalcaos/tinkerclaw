/**
 * SYNAPSE Phase 7C: Debate Architectures.
 * Four patterns: Fan-Out, Sequential, Moderated Tribunal, Tournament.
 * Reference: SYNAPSE §5
 */

import type { DebateParticipant, DebateCost, DebateConfig, DebateResult } from "./raac-protocol.js";
import { runDebate, DEFAULT_DEBATE_CONFIG, totalDebateCost, estimatePhaseCost } from "./raac-protocol.js";

export type ArchitectureType = "fan-out" | "sequential" | "moderated-tribunal" | "full-synapse";

export interface ArchitectureResult {
	architecture: ArchitectureType;
	task: string;
	output: string;
	costs: DebateCost[];
	totalEstimatedCost: number;
	rounds: number;
	participantCount: number;
}

// ── Helper ──

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ── 1. Fan-Out Architecture ──
// All models respond independently in parallel, then one synthesizes.
// Cheapest: no challenge/defense phases.

export async function fanOut(
	task: string,
	participants: DebateParticipant[],
): Promise<ArchitectureResult> {
	const costs: DebateCost[] = [];

	// Parallel proposals
	const proposals = await Promise.all(
		participants.map(async (p) => {
			const proposal = await p.propose(task, p.role);
			costs.push({
				phase: "propose",
				model: p.modelId,
				inputTokens: estimateTokens(task),
				outputTokens: estimateTokens(proposal),
				estimatedCost: estimatePhaseCost(p.profile, estimateTokens(task), estimateTokens(proposal)),
			});
			return proposal;
		}),
	);

	// Synthesis by first participant (or designated synthesizer)
	const synthesizer = participants.find((p) => p.role === "synthesizer") ?? participants[0];
	const output = await synthesizer.synthesize(proposals, [], []);
	const synthInput = estimateTokens(proposals.join(""));
	costs.push({
		phase: "synthesize",
		model: synthesizer.modelId,
		inputTokens: synthInput,
		outputTokens: estimateTokens(output),
		estimatedCost: estimatePhaseCost(synthesizer.profile, synthInput, estimateTokens(output)),
	});

	return {
		architecture: "fan-out",
		task,
		output,
		costs,
		totalEstimatedCost: totalDebateCost(costs),
		rounds: 1,
		participantCount: participants.length,
	};
}

// ── 2. Sequential Debate ──
// Models respond in sequence, each seeing all prior responses.

export async function sequential(
	task: string,
	participants: DebateParticipant[],
): Promise<ArchitectureResult> {
	const costs: DebateCost[] = [];
	const responses: string[] = [];

	for (const p of participants) {
		const context = responses.length > 0 ? `Prior responses:\n${responses.join("\n---\n")}` : "";
		const fullTask = context ? `${task}\n\n${context}` : task;
		const response = await p.propose(fullTask, p.role);
		responses.push(response);
		costs.push({
			phase: "propose-sequential",
			model: p.modelId,
			inputTokens: estimateTokens(fullTask),
			outputTokens: estimateTokens(response),
			estimatedCost: estimatePhaseCost(p.profile, estimateTokens(fullTask), estimateTokens(response)),
		});
	}

	// Last response is the final output (it saw everything)
	return {
		architecture: "sequential",
		task,
		output: responses[responses.length - 1],
		costs,
		totalEstimatedCost: totalDebateCost(costs),
		rounds: participants.length,
		participantCount: participants.length,
	};
}

// ── 3. Moderated Tribunal ──
// Moderator poses question, all respond, moderator synthesizes.

export async function moderatedTribunal(
	task: string,
	participants: DebateParticipant[],
): Promise<ArchitectureResult> {
	const costs: DebateCost[] = [];
	const moderator = participants.find((p) => p.role === "synthesizer") ?? participants[0];
	const panelists = participants.filter((p) => p !== moderator);

	// Moderator frames the question (reuse propose for framing)
	const framing = await moderator.propose(`Frame this debate question for a panel: ${task}`, moderator.role);
	costs.push({
		phase: "frame",
		model: moderator.modelId,
		inputTokens: estimateTokens(task),
		outputTokens: estimateTokens(framing),
		estimatedCost: estimatePhaseCost(moderator.profile, estimateTokens(task), estimateTokens(framing)),
	});

	// Panelists respond in parallel
	const responses = await Promise.all(
		panelists.map(async (p) => {
			const response = await p.propose(framing, p.role);
			costs.push({
				phase: "respond",
				model: p.modelId,
				inputTokens: estimateTokens(framing),
				outputTokens: estimateTokens(response),
				estimatedCost: estimatePhaseCost(p.profile, estimateTokens(framing), estimateTokens(response)),
			});
			return response;
		}),
	);

	// Moderator synthesizes
	const output = await moderator.synthesize(responses, [], []);
	const synthInput = estimateTokens(responses.join(""));
	costs.push({
		phase: "synthesize",
		model: moderator.modelId,
		inputTokens: synthInput,
		outputTokens: estimateTokens(output),
		estimatedCost: estimatePhaseCost(moderator.profile, synthInput, estimateTokens(output)),
	});

	return {
		architecture: "moderated-tribunal",
		task,
		output,
		costs,
		totalEstimatedCost: totalDebateCost(costs),
		rounds: 1,
		participantCount: participants.length,
	};
}

// ── 4. Full SYNAPSE (delegates to raac-protocol) ──

export async function fullSynapse(
	task: string,
	participants: DebateParticipant[],
	config: DebateConfig = DEFAULT_DEBATE_CONFIG,
): Promise<ArchitectureResult> {
	const result = await runDebate(task, participants, config);
	return {
		architecture: "full-synapse",
		task,
		output: result.finalSynthesis,
		costs: result.totalCosts,
		totalEstimatedCost: result.totalEstimatedCost,
		rounds: result.rounds.length,
		participantCount: participants.length,
	};
}

// ── Architecture Selection ──

export interface ArchitectureRecommendation {
	architecture: ArchitectureType;
	reason: string;
	estimatedCostMultiplier: number; // relative to fan-out
}

/**
 * Recommend an architecture based on task characteristics.
 * Reference: SYNAPSE §5.5
 */
export function recommendArchitecture(opts: {
	stakesLevel: "low" | "medium" | "high" | "critical";
	budgetUsd?: number;
	participantCount: number;
	needsAdversarial?: boolean;
}): ArchitectureRecommendation {
	if (opts.stakesLevel === "low" || (opts.budgetUsd !== undefined && opts.budgetUsd < 0.2)) {
		return { architecture: "fan-out", reason: "Low stakes or tight budget", estimatedCostMultiplier: 1.0 };
	}
	if (opts.stakesLevel === "medium" && !opts.needsAdversarial) {
		return {
			architecture: "moderated-tribunal",
			reason: "Medium stakes, structured discussion sufficient",
			estimatedCostMultiplier: 1.5,
		};
	}
	if (opts.stakesLevel === "high" || opts.needsAdversarial) {
		return {
			architecture: "full-synapse",
			reason: "High stakes or adversarial challenge needed",
			estimatedCostMultiplier: 5.0,
		};
	}
	// Critical
	return {
		architecture: "full-synapse",
		reason: "Critical decision — full protocol with maximum rounds",
		estimatedCostMultiplier: 8.0,
	};
}

/**
 * Run debate using the recommended architecture.
 */
export async function runWithArchitecture(
	architecture: ArchitectureType,
	task: string,
	participants: DebateParticipant[],
	config?: DebateConfig,
): Promise<ArchitectureResult> {
	switch (architecture) {
		case "fan-out":
			return fanOut(task, participants);
		case "sequential":
			return sequential(task, participants);
		case "moderated-tribunal":
			return moderatedTribunal(task, participants);
		case "full-synapse":
			return fullSynapse(task, participants, config);
	}
}
