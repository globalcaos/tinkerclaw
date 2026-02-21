/**
 * SYNAPSE Phase 5: Runtime registry for structured multi-model debate.
 *
 * Wires the SYNAPSE debate engine (raac-protocol + cognitive-diversity +
 * persistent-deliberation) into an agent-callable service.  Each session
 * gets one SynapseRuntime keyed off the EventStore instance.
 */

import type { EventStore } from "../../memory/engram/event-store.js";
import {
	runDebate,
	DEFAULT_DEBATE_CONFIG,
	type DebateParticipant,
	type DebateConfig,
} from "../../memory/synapse/raac-protocol.js";
import {
	measureCDI,
	DEFAULT_PROVIDER_PROFILES,
	type ProviderProfile,
} from "../../memory/synapse/cognitive-diversity.js";
import { createPersistentDeliberation } from "../../memory/synapse/persistent-deliberation.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type DebateDepth = "quick" | "standard" | "deep";

export interface DebateOptions {
	depth?: DebateDepth;
	/** Override participant role names; must match DEFAULT_ROLES keys. */
	roles?: string[];
}

export interface DebateResult {
	consensus: string;
	confidence: number;
	dissent: string[];
	actionItems: string[];
	diversityScore: number;
}

export interface SynapseRuntime {
	debate(topic: string, options?: DebateOptions): Promise<DebateResult>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const ROUNDS_BY_DEPTH: Record<DebateDepth, number> = {
	quick: 2,
	standard: 4,
	deep: 6,
};

const DEFAULT_ROLES = ["Architect", "Critic", "Pragmatist"];

// Role-specific response generators (synthetic — no live LLM needed).
const ROLE_PROPOSE: Record<string, (topic: string, prior?: string) => string> = {
	Architect: (t, p) =>
		`[Architect] Creative synthesis: ${t}${p ? ` — building on: ${p.slice(0, 60)}` : ""}. Recommend a holistic, forward-looking solution that maximises long-term value.`,
	Critic: (t, p) =>
		`[Critic] Adversarial review: ${t}${p ? ` — challenges to: ${p.slice(0, 60)}` : ""}. Identify key failure modes, edge cases, and unstated assumptions.`,
	Pragmatist: (t, p) =>
		`[Pragmatist] Grounding: ${t}${p ? ` — refining: ${p.slice(0, 60)}` : ""}. Prioritise feasibility, resource constraints, and incremental delivery.`,
};

const ROLE_CHALLENGE: Record<string, (proposal: string) => string> = {
	Architect: (p) => `[Architect] Scalability concern: ${p.slice(0, 80)} lacks long-term adaptability.`,
	Critic: (p) => `[Critic] Logical gap: ${p.slice(0, 80)} fails under adversarial conditions.`,
	Pragmatist: (p) => `[Pragmatist] Feasibility issue: ${p.slice(0, 80)} exceeds realistic constraints.`,
};

const ROLE_DEFEND: Record<string, (attacks: string[]) => string> = {
	Architect: (a) => `[Architect] Rebuttal: addressed ${a.length} concern(s) by extending the design to cover edge cases.`,
	Critic: (a) => `[Critic] Counter: the ${a.length} objection(s) confirm the need for stricter validation.`,
	Pragmatist: (a) => `[Pragmatist] Mitigation: ${a.length} concern(s) resolved via staged rollout and fallback plan.`,
};

// ── Participant factory ────────────────────────────────────────────────────

function createSyntheticParticipant(role: string): DebateParticipant {
	const profile: ProviderProfile =
		DEFAULT_PROVIDER_PROFILES.find((p) => p.role === role.toLowerCase()) ??
		DEFAULT_PROVIDER_PROFILES[0];

	const propose = ROLE_PROPOSE[role] ?? ((t) => `[${role}] Perspective on: ${t}`);
	const challenge = ROLE_CHALLENGE[role] ?? ((p) => `[${role}] Challenge: ${p.slice(0, 80)}`);
	const defend = ROLE_DEFEND[role] ?? ((a) => `[${role}] Defense against ${a.length} attack(s).`);

	return {
		modelId: `synapse-${role.toLowerCase()}`,
		role: role.toLowerCase(),
		profile,
		propose: async (task, _r, priorSynthesis) => propose(task, priorSynthesis),
		challenge: async (proposal) => challenge(proposal),
		defend: async (attacks) => defend(attacks),
		synthesize: async (proposals, challenges, defenses) => {
			const points = [...proposals, ...defenses].filter(Boolean);
			return `Consensus synthesis across ${points.length} perspective(s): ${points.slice(0, 3).join(" | ")}. Divergences addressed: ${challenges.length} challenge(s).`;
		},
		ratify: async (synthesis) => {
			// Simple heuristic: accept if synthesis is non-trivial
			const words = synthesis.split(/\s+/).length;
			if (words > 10) return "accept";
			if (words > 5) return "amend";
			return "reject";
		},
	};
}

// ── Diversity score ────────────────────────────────────────────────────────

/**
 * Derive a CDI score from the debate rounds.
 * Uses whether each model issued a "reject" vote as a binary error proxy.
 */
function computeDiversityScore(
	rounds: Array<{ ratification: Record<string, "accept" | "reject" | "amend"> }>,
	modelIds: string[],
): number {
	if (rounds.length === 0 || modelIds.length < 2) return 0.5;

	const errorProfiles: Record<string, boolean[]> = {};
	for (const id of modelIds) {
		errorProfiles[id] = rounds.map((r) => r.ratification[id] === "reject");
	}
	return measureCDI(errorProfiles).cdi;
}

// ── Runtime factory ────────────────────────────────────────────────────────

export function createSynapseRuntime(eventStore: EventStore): SynapseRuntime {
	const deliberation = createPersistentDeliberation({ eventStore });

	return {
		async debate(topic: string, options: DebateOptions = {}): Promise<DebateResult> {
			const depth: DebateDepth = options.depth ?? "standard";
			const roleNames: string[] = options.roles ?? DEFAULT_ROLES;
			const maxRounds = ROUNDS_BY_DEPTH[depth];

			const participants = roleNames.map(createSyntheticParticipant);

			const config: DebateConfig = {
				...DEFAULT_DEBATE_CONFIG,
				maxRounds,
			};

			const result = await runDebate(topic, participants, config);

			// Compute confidence from final ratification acceptance rate
			const lastRound = result.rounds[result.rounds.length - 1];
			const votes = lastRound ? Object.values(lastRound.ratification) : [];
			const confidence =
				votes.length > 0
					? votes.filter((v) => v === "accept").length / votes.length
					: 0.5;

			// Collect dissenting content (challenges from non-accepting participants)
			const dissent: string[] = [];
			for (const round of result.rounds) {
				for (const [modelId, vote] of Object.entries(round.ratification)) {
					if (vote === "reject") {
						const challenge = Object.values(round.challenges[modelId] ?? {}).at(0);
						if (challenge) dissent.push(`[${modelId}] ${challenge.slice(0, 120)}`);
					}
				}
			}

			// Extract action items: lines starting with action verbs or bullet markers
			const actionItems = result.finalSynthesis
				.split(/[.!?\n]/)
				.map((s) => s.trim())
				.filter(
					(s) =>
						s.length > 10 &&
						/^(priorit|implement|deliver|rollout|validate|ensure|add|remove|refactor|test|monitor|review)/i.test(s),
				)
				.slice(0, 5);

			// Diversity score via CDI
			const modelIds = participants.map((p) => p.modelId);
			const diversityScore = computeDiversityScore(result.rounds, modelIds);

			// Persist traces + conclusion via persistent deliberation
			deliberation.updateDeliberationMemory(result, "full-synapse");

			return {
				consensus: result.finalSynthesis,
				confidence,
				dissent,
				actionItems,
				diversityScore,
			};
		},
	};
}

// ── Module-level registry (not per-session) ───────────────────────────────

// Simpler than a WeakMap here: the runtime is wired at session init time
// and stored in a module singleton, similar to how smaller runtimes work
// when there is no SessionManager available at tool call time.

let _runtime: SynapseRuntime | null = null;

export function setSynapseRuntime(runtime: SynapseRuntime | null): void {
	_runtime = runtime;
}

export function getSynapseRuntime(): SynapseRuntime | null {
	return _runtime;
}
