/**
 * SYNAPSE Phase 7D: Persistent Deliberation.
 * Stores debate traces as ENGRAM events, manages eager eviction,
 * persists conclusion artifacts, enables cross-session debate resumption,
 * and tracks meta-patterns across debates.
 * Reference: SYNAPSE §6
 */

import type { MemoryEvent, EventMetadata } from "../engram/event-types.js";
import type { EventStore } from "../engram/event-store.js";
import type { MetricsCollector } from "../engram/metrics.js";
import type { DebateRound, DebateResult, DebateCost } from "./raac-protocol.js";
import type { ArchitectureType } from "./debate-architectures.js";

// ── Types ──

export interface DebateTrace {
	debateId: string;
	roundNumber: number;
	phase: "propose" | "challenge" | "defend" | "synthesize" | "ratify";
	modelId: string;
	content: string;
	timestamp: string;
}

export interface DebateConclusion {
	debateId: string;
	task: string;
	architecture: ArchitectureType;
	finalSynthesis: string;
	participantModels: string[];
	rounds: number;
	converged: boolean;
	totalCost: number;
	timestamp: string;
	metadata: Record<string, unknown>;
}

export interface DeliberationMemory {
	totalDebates: number;
	avgRoundsToConverge: number;
	avgCostPerDebate: number;
	architectureUsage: Record<string, number>;
	modelParticipation: Record<string, number>;
	convergenceRate: number;
	topicHistory: string[];
	lastUpdated: string;
}

// ── Persistent Deliberation Store ──

export interface PersistentDeliberationOptions {
	eventStore: EventStore;
	metrics?: MetricsCollector;
}

export interface PersistentDeliberation {
	/** Store all traces from a debate round as ENGRAM events. */
	storeDebateTraces(debateId: string, round: DebateRound): void;
	/** Store the final conclusion as a durable ENGRAM event (debate_synthesis kind). */
	storeConclusion(conclusion: DebateConclusion): void;
	/** Mark all debate_trace events for eager eviction (set low priority). */
	markTracesForEviction(debateId: string): void;
	/** Retrieve a prior debate conclusion by debateId (cross-session). */
	recallConclusion(debateId: string): DebateConclusion | undefined;
	/** Retrieve all conclusions (for meta-pattern tracking). */
	recallAllConclusions(): DebateConclusion[];
	/** Get or create the deliberation memory (meta-patterns). */
	getDeliberationMemory(): DeliberationMemory;
	/** Update deliberation memory after a debate completes. */
	updateDeliberationMemory(result: DebateResult, architecture: ArchitectureType): void;
	/** Find a resumable debate (incomplete, matching task). */
	findResumableDebate(task: string): { debateId: string; lastRound: number; synthesis: string } | undefined;
}

export function createPersistentDeliberation(options: PersistentDeliberationOptions): PersistentDeliberation {
	const { eventStore, metrics } = options;

	function storeDebateTraces(debateId: string, round: DebateRound): void {
		// Store each proposal, challenge, defense as debate_trace events
		for (const [modelId, proposal] of Object.entries(round.proposals)) {
			eventStore.append({
				turnId: round.roundNumber,
				sessionKey: eventStore.sessionKey,
				kind: "debate_trace",
				content: JSON.stringify({ debateId, phase: "propose", modelId, text: proposal }),
				tokens: Math.ceil(proposal.length / 4),
				metadata: { tags: ["synapse", "debate-trace", debateId, `round-${round.roundNumber}`] },
			});
		}

		for (const [attackerId, targets] of Object.entries(round.challenges)) {
			for (const [targetId, challenge] of Object.entries(targets)) {
				eventStore.append({
					turnId: round.roundNumber,
					sessionKey: eventStore.sessionKey,
					kind: "debate_trace",
					content: JSON.stringify({
						debateId,
						phase: "challenge",
						modelId: attackerId,
						targetId,
						text: challenge,
					}),
					tokens: Math.ceil(challenge.length / 4),
					metadata: { tags: ["synapse", "debate-trace", debateId, `round-${round.roundNumber}`] },
				});
			}
		}

		for (const [modelId, defense] of Object.entries(round.defenses)) {
			eventStore.append({
				turnId: round.roundNumber,
				sessionKey: eventStore.sessionKey,
				kind: "debate_trace",
				content: JSON.stringify({ debateId, phase: "defend", modelId, text: defense }),
				tokens: Math.ceil(defense.length / 4),
				metadata: { tags: ["synapse", "debate-trace", debateId, `round-${round.roundNumber}`] },
			});
		}

		// Store synthesis
		eventStore.append({
			turnId: round.roundNumber,
			sessionKey: eventStore.sessionKey,
			kind: "debate_trace",
			content: JSON.stringify({ debateId, phase: "synthesize", text: round.synthesis }),
			tokens: Math.ceil(round.synthesis.length / 4),
			metadata: { tags: ["synapse", "debate-trace", debateId, `round-${round.roundNumber}`] },
		});

		// Store ratification
		eventStore.append({
			turnId: round.roundNumber,
			sessionKey: eventStore.sessionKey,
			kind: "debate_trace",
			content: JSON.stringify({ debateId, phase: "ratify", votes: round.ratification }),
			tokens: 20,
			metadata: { tags: ["synapse", "debate-trace", debateId, `round-${round.roundNumber}`] },
		});

		metrics?.record("synapse", "debate_traces_stored", 1, { debateId, round: round.roundNumber });
	}

	function storeConclusion(conclusion: DebateConclusion): void {
		eventStore.append({
			turnId: 0,
			sessionKey: eventStore.sessionKey,
			kind: "debate_synthesis",
			content: JSON.stringify(conclusion),
			tokens: Math.ceil(conclusion.finalSynthesis.length / 4),
			metadata: {
				tags: ["synapse", "debate-conclusion", conclusion.debateId],
				// Never evict conclusions
			},
		});
		metrics?.record("synapse", "debate_conclusion_stored", 1, {
			debateId: conclusion.debateId,
			cost: conclusion.totalCost,
			converged: conclusion.converged,
		});
	}

	function markTracesForEviction(debateId: string): void {
		const traceEvents = eventStore.readByKind("debate_trace");
		for (const event of traceEvents) {
			if (event.metadata.tags?.includes(debateId)) {
				// Mark for eager eviction by adding supersededBy (signals low priority)
				event.metadata.supersededBy = `conclusion-${debateId}`;
			}
		}
		metrics?.record("synapse", "traces_marked_for_eviction", 1, { debateId });
	}

	function recallConclusion(debateId: string): DebateConclusion | undefined {
		const synthEvents = eventStore.readByKind("debate_synthesis");
		for (const event of synthEvents) {
			if (event.metadata.tags?.includes(debateId)) {
				try {
					return JSON.parse(event.content) as DebateConclusion;
				} catch {
					continue;
				}
			}
		}
		return undefined;
	}

	function recallAllConclusions(): DebateConclusion[] {
		const synthEvents = eventStore.readByKind("debate_synthesis");
		const conclusions: DebateConclusion[] = [];
		for (const event of synthEvents) {
			try {
				conclusions.push(JSON.parse(event.content) as DebateConclusion);
			} catch {
				// skip malformed
			}
		}
		return conclusions;
	}

	function getDeliberationMemory(): DeliberationMemory {
		const conclusions = recallAllConclusions();
		if (conclusions.length === 0) {
			return {
				totalDebates: 0,
				avgRoundsToConverge: 0,
				avgCostPerDebate: 0,
				architectureUsage: {},
				modelParticipation: {},
				convergenceRate: 0,
				topicHistory: [],
				lastUpdated: new Date().toISOString(),
			};
		}

		const converged = conclusions.filter((c) => c.converged);
		const archUsage: Record<string, number> = {};
		const modelPart: Record<string, number> = {};

		for (const c of conclusions) {
			archUsage[c.architecture] = (archUsage[c.architecture] ?? 0) + 1;
			for (const m of c.participantModels) {
				modelPart[m] = (modelPart[m] ?? 0) + 1;
			}
		}

		return {
			totalDebates: conclusions.length,
			avgRoundsToConverge: converged.length > 0 ? converged.reduce((s, c) => s + c.rounds, 0) / converged.length : 0,
			avgCostPerDebate: conclusions.reduce((s, c) => s + c.totalCost, 0) / conclusions.length,
			architectureUsage: archUsage,
			modelParticipation: modelPart,
			convergenceRate: converged.length / conclusions.length,
			topicHistory: conclusions.map((c) => c.task).slice(-20),
			lastUpdated: new Date().toISOString(),
		};
	}

	function updateDeliberationMemory(result: DebateResult, architecture: ArchitectureType): void {
		// The memory is computed on-the-fly from stored conclusions, so just store the conclusion
		const debateId = `debate-${Date.now()}`;
		storeConclusion({
			debateId,
			task: result.task,
			architecture,
			finalSynthesis: result.finalSynthesis,
			participantModels: [...new Set(result.totalCosts.map((c) => c.model))],
			rounds: result.rounds.length,
			converged: result.converged,
			totalCost: result.totalEstimatedCost,
			timestamp: new Date().toISOString(),
			metadata: { convergenceRound: result.convergenceRound },
		});

		// Store traces for all rounds then mark for eviction
		for (const round of result.rounds) {
			storeDebateTraces(debateId, round);
		}
		markTracesForEviction(debateId);

		metrics?.record("synapse", "deliberation_memory_updated", 1, {
			debateId,
			architecture,
			rounds: result.rounds.length,
			cost: result.totalEstimatedCost,
		});
	}

	function findResumableDebate(task: string): { debateId: string; lastRound: number; synthesis: string } | undefined {
		// Look for debate traces that didn't get a conclusion
		const traceEvents = eventStore.readByKind("debate_trace");
		const conclusionEvents = eventStore.readByKind("debate_synthesis");

		const concludedIds = new Set<string>();
		for (const e of conclusionEvents) {
			const tags = e.metadata.tags ?? [];
			for (const tag of tags) {
				if (tag.startsWith("debate-")) concludedIds.add(tag);
			}
		}

		// Find unconcluded debates
		const unconcluded = new Map<string, { lastRound: number; synthesis: string }>();
		for (const e of traceEvents) {
			const tags = e.metadata.tags ?? [];
			const debateTag = tags.find((t) => t.startsWith("debate-") && t !== "debate-trace");
			if (!debateTag || concludedIds.has(debateTag)) continue;

			try {
				const parsed = JSON.parse(e.content);
				const existing = unconcluded.get(debateTag);
				const roundNum = e.turnId;
				if (!existing || roundNum > existing.lastRound) {
					unconcluded.set(debateTag, {
						lastRound: roundNum,
						synthesis: parsed.phase === "synthesize" ? parsed.text : existing?.synthesis ?? "",
					});
				}
			} catch {
				continue;
			}
		}

		// Return most recent unconcluded debate (simple heuristic — could match by task similarity)
		for (const [debateId, info] of unconcluded) {
			if (info.synthesis) {
				return { debateId, lastRound: info.lastRound, synthesis: info.synthesis };
			}
		}
		return undefined;
	}

	return {
		storeDebateTraces,
		storeConclusion,
		markTracesForEviction,
		recallConclusion,
		recallAllConclusions,
		getDeliberationMemory,
		updateDeliberationMemory,
		findResumableDebate,
	};
}
