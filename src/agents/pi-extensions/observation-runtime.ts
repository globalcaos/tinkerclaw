/**
 * CORTEX Integration: Observation extractor.
 *
 * Extracts facts, preferences, and beliefs from conversations via lightweight
 * pattern matching. Batch extraction fires when accumulated token count crosses
 * a 30K threshold — not per-turn — to avoid noise.
 *
 * Extracted observations are stored in the ENGRAM event store as `system_event`
 * entries tagged "observation". Auto-extraction is always-on; no explicit
 * "remember this" trigger needed.
 *
 * Registry pattern mirrors ingestion-runtime.ts / retrieval-runtime.ts.
 */

import type { EventStore } from "../../memory/engram/event-store.js";
import { estimateTokens } from "../../memory/engram/event-store.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default token accumulation threshold before a batch extraction fires. */
export const DEFAULT_OBSERVATION_THRESHOLD = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObservationType = "fact" | "preference" | "belief";

export interface Observation {
	type: ObservationType;
	content: string;
	/** Confidence estimate in [0, 1]. */
	confidence: number;
	/** Source messages that yielded this observation. */
	sourceMessages: string[];
}

export interface ObservationExtractor {
	/**
	 * Extract observations from `messages` when the accumulated token count
	 * crosses `threshold` (default: 30K). Returns extracted observations;
	 * returns an empty array if the threshold is not yet reached.
	 */
	extractObservations(messages: string[], threshold?: number): Observation[];
	/** Accumulated token count since the last successful extraction. */
	readonly tokensSinceLastExtraction: number;
	/** Total observations extracted across all batches. */
	readonly totalExtracted: number;
}

// ---------------------------------------------------------------------------
// Pattern-based sentence classifier (no LLM call required)
// ---------------------------------------------------------------------------

/** Patterns that indicate factual statements about the user or environment. */
const FACT_PATTERNS: RegExp[] = [
	/\bI (?:am|work|live|have|use|own|know|went|studied)\b/i,
	/\bmy (?:name|job|role|company|project|team|language|stack|preference)\b/i,
	/\bwe (?:use|build|deploy|run|manage)\b/i,
];

/** Patterns that indicate user preferences or intent. */
const PREFERENCE_PATTERNS: RegExp[] = [
	/\bI (?:prefer|like|love|hate|dislike|want|need|always|never)\b/i,
	/\bI(?:'d| would) (?:rather|prefer|like)\b/i,
	/\bmake sure (?:to|you)\b/i,
	/\bplease (?:don'?t|always|never|make)\b/i,
];

/** Patterns that indicate beliefs or opinions held by the user. */
const BELIEF_PATTERNS: RegExp[] = [
	/\bI (?:think|believe|feel|suspect|assume|expect)\b/i,
	/\bin my (?:opinion|view|experience)\b/i,
	/\bI(?:'m| am) (?:convinced|sure|confident|worried|concerned)\b/i,
];

/** Classify a single sentence and return its type + confidence, or null. */
function classifySentence(
	sentence: string,
): Pick<Observation, "type" | "confidence"> | null {
	// Preference takes precedence (more actionable)
	if (PREFERENCE_PATTERNS.some((p) => p.test(sentence))) {
		return { type: "preference", confidence: 0.8 };
	}
	if (BELIEF_PATTERNS.some((p) => p.test(sentence))) {
		return { type: "belief", confidence: 0.75 };
	}
	if (FACT_PATTERNS.some((p) => p.test(sentence))) {
		return { type: "fact", confidence: 0.85 };
	}
	return null;
}

/** Extract all classifiable observations from a single message string. */
function extractFromMessage(message: string): Observation[] {
	// Split on sentence-ending punctuation; skip very short fragments
	const sentences = message
		.split(/(?<=[.!?])\s+/)
		.filter((s) => s.trim().length > 10);

	const observations: Observation[] = [];
	for (const sentence of sentences) {
		const classified = classifySentence(sentence);
		if (classified) {
			observations.push({
				...classified,
				content: sentence.trim(),
				sourceMessages: [message],
			});
		}
	}
	return observations;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ObservationExtractor backed by the given ENGRAM event store.
 *
 * Call `extractObservations(messages)` after each batch of messages.
 * When the accumulated token count crosses the threshold, observations are
 * extracted and persisted as `system_event` entries tagged "observation".
 */
export function createObservationExtractor(eventStore: EventStore): ObservationExtractor {
	let tokensSinceLastExtraction = 0;
	let totalExtracted = 0;

	return {
		get tokensSinceLastExtraction() {
			return tokensSinceLastExtraction;
		},

		get totalExtracted() {
			return totalExtracted;
		},

		extractObservations(
			messages: string[],
			threshold = DEFAULT_OBSERVATION_THRESHOLD,
		): Observation[] {
			// Accumulate tokens for this call
			const batchTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
			tokensSinceLastExtraction += batchTokens;

			// Only extract when we cross the threshold
			if (tokensSinceLastExtraction < threshold) {
				return [];
			}

			// Reset accumulator before running extraction
			tokensSinceLastExtraction = 0;

			const observations: Observation[] = [];
			for (const message of messages) {
				observations.push(...extractFromMessage(message));
			}

			if (observations.length === 0) {
				return [];
			}

			// Persist each observation as a system_event with tag "observation"
			for (const obs of observations) {
				const content = JSON.stringify({
					type: obs.type,
					content: obs.content,
					confidence: obs.confidence,
				});

				eventStore.append({
					turnId: 0,
					sessionKey: eventStore.sessionKey,
					kind: "system_event",
					content,
					tokens: estimateTokens(content),
					metadata: {
						tags: ["observation", obs.type],
						// Map confidence to importance (1–10)
						importance: Math.max(1, Math.round(obs.confidence * 10)),
					},
				});
			}

			totalExtracted += observations.length;
			return observations;
		},
	};
}

// ---------------------------------------------------------------------------
// Registry (WeakMap keyed by SessionManager)
// ---------------------------------------------------------------------------

const registry = createSessionManagerRuntimeRegistry<ObservationExtractor>();

/** Store an ObservationExtractor for a given session manager instance. */
export const setObservationRuntime = registry.set;

/** Retrieve the ObservationExtractor for a given session manager instance, or null. */
export const getObservationRuntime = registry.get;
