/**
 * LIMBIC Phase 4: Humor Trigger.
 *
 * Evaluates whether conditions are right to attempt humor on a given turn.
 * Applies:
 *  - Rate limiting (configurable; default: 1 attempt per 10 turns)
 *  - Sensitivity gate (topic check before attempting)
 *  - Bridge discovery via LimbicRuntime
 *
 * Usage:
 *   const trigger = createHumorTrigger(limbicRuntime);
 *   const result = await trigger.evaluateOpportunity(recentMessages, turnCount);
 *   if (result.shouldAttempt) { ... }
 */

import type { LimbicRuntime } from "./limbic-runtime.js";
import type { CortexRuntime } from "./cortex-runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HumorTriggerOptions {
	/** Minimum turns between humor attempts (default: 10). */
	minTurnsBetweenAttempts?: number;
}

export interface HumorOpportunity {
	shouldAttempt: boolean;
	/** Unique ID for this attempt (use with LimbicRuntime.captureReaction). */
	attemptId?: string;
	/** Bridge concept connecting conceptA and conceptB (if found). */
	bridge?: string;
	/** Concept pair sourced from recent messages (if detected). */
	concepts?: [string, string];
	/** h_v2 humor potential score for the chosen bridge. */
	score?: number;
	/** Reason humor was skipped (for diagnostics). */
	reason?: string;
}

export interface HumorTrigger {
	/** Evaluate whether to attempt humor on the current turn. */
	evaluateOpportunity(
		recentMessages: string[],
		turnCount: number,
	): Promise<HumorOpportunity>;
	/** Reset internal state (e.g. between test runs). */
	reset(): void;
}

// ---------------------------------------------------------------------------
// Concept extraction (lightweight keyword heuristic — no embedding required)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "shall", "can", "to", "of", "in", "on",
	"at", "by", "for", "with", "about", "from", "into", "and", "or",
	"but", "not", "so", "if", "that", "this", "it", "i", "you", "we",
	"they", "he", "she", "what", "which", "who", "how", "when", "where",
]);

/**
 * Extract candidate concept tokens from a list of recent messages.
 * Returns a deduplicated list of meaningful nouns/tokens (lowercase).
 */
function extractConcepts(messages: string[]): string[] {
	const counts = new Map<string, number>();
	for (const msg of messages) {
		const tokens = msg
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 3 && !STOP_WORDS.has(t));
		for (const t of tokens) {
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
	}
	// Return tokens sorted by frequency desc, top 20
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20)
		.map(([t]) => t);
}

/**
 * Pick the most distant concept pair from the extracted list.
 * Without actual embeddings we approximate "distance" by string-character
 * dissimilarity (Jaccard on character bigrams) — good enough for gating.
 */
function pickConceptPair(concepts: string[]): [string, string] | undefined {
	if (concepts.length < 2) return undefined;

	function bigrams(s: string): Set<string> {
		const bg = new Set<string>();
		for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
		return bg;
	}

	function jaccardDistance(a: string, b: string): number {
		const ba = bigrams(a);
		const bb = bigrams(b);
		let intersection = 0;
		for (const g of ba) if (bb.has(g)) intersection++;
		const union = ba.size + bb.size - intersection;
		return union === 0 ? 0 : 1 - intersection / union;
	}

	let bestPair: [string, string] = [concepts[0], concepts[1]];
	let bestDist = 0;
	for (let i = 0; i < Math.min(concepts.length, 10); i++) {
		for (let j = i + 1; j < Math.min(concepts.length, 10); j++) {
			const d = jaccardDistance(concepts[i], concepts[j]);
			if (d > bestDist) {
				bestDist = d;
				bestPair = [concepts[i], concepts[j]];
			}
		}
	}
	return bestDist > 0 ? bestPair : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a HumorTrigger that uses the provided LimbicRuntime for bridge
 * discovery and sensitivity gating.  An optional CortexRuntime provides
 * audience-aware frequency calibration.
 */
export function createHumorTrigger(
	limbicRuntime: LimbicRuntime,
	_cortexRuntime?: CortexRuntime,
	options: HumorTriggerOptions = {},
): HumorTrigger {
	const minTurns = options.minTurnsBetweenAttempts ?? 10;
	let lastAttemptTurn = -Infinity;

	return {
		async evaluateOpportunity(
			recentMessages: string[],
			turnCount: number,
		): Promise<HumorOpportunity> {
			// Rate limit: block if too soon since last attempt
			if (turnCount - lastAttemptTurn < minTurns) {
				return {
					shouldAttempt: false,
					reason: `Rate limited: only ${turnCount - lastAttemptTurn} turns since last attempt (min ${minTurns})`,
				};
			}

			// Extract concept candidates from recent conversation
			if (recentMessages.length === 0) {
				return { shouldAttempt: false, reason: "No messages to analyse" };
			}
			const concepts = extractConcepts(recentMessages);
			if (concepts.length < 2) {
				return { shouldAttempt: false, reason: "Insufficient concept diversity" };
			}

			const pair = pickConceptPair(concepts);
			if (!pair) {
				return { shouldAttempt: false, reason: "Could not select a concept pair" };
			}
			const [conceptA, conceptB] = pair;

			// Sensitivity gate: check topic before committing
			const combinedTopic = `${conceptA} ${conceptB}`;
			const sensitivityResult = limbicRuntime.checkSensitivity(combinedTopic);
			if (!sensitivityResult.allowed) {
				return {
					shouldAttempt: false,
					reason: `Sensitivity gate: ${sensitivityResult.reason ?? "topic blocked"}`,
				};
			}

			// Mark that we have committed to evaluating humor on this turn.
			// The rate limit applies regardless of whether bridge discovery succeeds,
			// so we record the attempt here (after the sensitivity gate) rather than
			// only on a successful shouldAttempt=true outcome.
			lastAttemptTurn = turnCount;

			// Bridge discovery
			const bridges = await limbicRuntime.discoverBridges(conceptA, conceptB);
			if (bridges.length === 0) {
				return {
					shouldAttempt: false,
					concepts: [conceptA, conceptB],
					reason: "No bridges found above quality threshold",
				};
			}

			// Score the top bridge
			const topBridge = bridges[0];
			const score = limbicRuntime.scoreHumor(conceptA, conceptB, topBridge.bridge);

			// Generate a stable attempt ID and persist it to the event store.
			const attemptId = `ha-${turnCount}-${Date.now()}`;
			limbicRuntime.logAttempt(
				attemptId,
				{ conceptA, conceptB, bridge: topBridge.bridge, score },
				turnCount,
			);

			return {
				shouldAttempt: true,
				attemptId,
				bridge: topBridge.bridge,
				concepts: [conceptA, conceptB],
				score,
			};
		},

		reset(): void {
			lastAttemptTurn = -Infinity;
		},
	};
}
