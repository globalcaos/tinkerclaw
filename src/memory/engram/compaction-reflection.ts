/**
 * ENGRAM Phase 1.5: Compaction self-reflection loop.
 *
 * After every compaction event, produces a structured learning record that
 * diagnoses retrieval quality and stores insights for later review.
 * FORK-ISOLATED: This file is unique to our fork.
 */

import type { EventStore } from "./event-store.js";
import type { CompactionManifest } from "../../agents/pi-extensions/pointer-compaction-runtime.js";

// ---------------------------------------------------------------------------
// Recall detection constants
// ---------------------------------------------------------------------------

/**
 * Substrings that, when found in a tool_call's content, identify a
 * recall / retrieval invocation.
 */
const RECALL_PATTERNS = [
	"recall",
	"engram_recall",
	"memory_recall",
	"push_pack",
	"retrieve_memory",
];

/** Minimum content length (chars) for a tool_result to be considered a hit. */
const HIT_MIN_CHARS = 50;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CompactionReflection {
	timestamp: string;
	compactionId: string;
	contextTokensBefore: number;
	contextTokensAfter: number;
	retrievalHits: number;
	retrievalMisses: number;
	falsePositives: number;
	diagnosis: string;
	actionTaken: "none" | "auto_added_anchor" | "weight_adjusted" | "flagged_for_review";
	severity: "low" | "medium" | "high";
	needsHumanReview: boolean;
	learning: string;
}

export interface CompactionReflector {
	reflect(
		compactionId: string,
		preCompactionState: { contextTokens: number; activeTopics: string[] },
	): CompactionReflection;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecallToolCall(content: string): boolean {
	const lower = content.toLowerCase();
	return RECALL_PATTERNS.some((p) => lower.includes(p));
}

function isEmptyRecallResult(content: string): boolean {
	const lower = content.toLowerCase();
	return (
		lower.includes("no results") ||
		lower.includes("no events") ||
		lower.includes('"events":[]') ||
		lower.includes('"events": []') ||
		content.trim().length < 20
	);
}

/**
 * Walk events up to `upToTurnId` and count retrieval hits, misses, and
 * false positives by pairing tool_call/tool_result events.
 */
function countRetrievalStats(
	store: EventStore,
	upToTurnId: number,
): { hits: number; misses: number; falsePositives: number } {
	const events = store.readAll().filter((e) => e.turnId <= upToTurnId);

	let hits = 0;
	let misses = 0;
	let falsePositives = 0;

	for (let i = 0; i < events.length; i++) {
		const e = events[i];
		if (e.kind !== "tool_call" || !isRecallToolCall(e.content)) continue;

		// Find the matching tool_result on the same turn (first one after this call)
		const result = events.slice(i + 1).find((r) => r.kind === "tool_result" && r.turnId === e.turnId);

		if (!result) {
			// No result event found for this recall — treat as miss
			misses++;
			continue;
		}

		if (isEmptyRecallResult(result.content)) {
			misses++;
		} else if (result.content.trim().length < HIT_MIN_CHARS) {
			// Very short result — retrieval returned something but it was unhelpful
			falsePositives++;
		} else {
			hits++;
		}
	}

	return { hits, misses, falsePositives };
}

function classifySeverity(
	hits: number,
	misses: number,
	falsePositives: number,
): "low" | "medium" | "high" {
	const total = hits + misses;
	if (total === 0 && falsePositives === 0) return "low";
	const missRate = total > 0 ? misses / total : 0;
	if (missRate > 0.6 || falsePositives > 3) return "high";
	if (missRate > 0.3 || falsePositives > 1) return "medium";
	return "low";
}

function buildDiagnosis(
	hits: number,
	misses: number,
	falsePositives: number,
	manifest: CompactionManifest | null,
): string {
	const total = hits + misses;
	const manifestSuffix = manifest
		? ` Compacted ${manifest.eventCount} events (${manifest.tokenCount} tokens).`
		: "";

	if (total === 0 && falsePositives === 0) {
		return `No retrieval activity detected around compaction.${manifestSuffix}`;
	}

	const missRate = total > 0 ? Math.round((misses / total) * 100) : 0;
	const parts: string[] = [`Retrieval: ${hits} hits, ${misses} misses (${missRate}% miss rate).`];
	if (falsePositives > 0) parts.push(`${falsePositives} false positive(s).`);
	parts.push(manifestSuffix.trim());
	return parts.filter(Boolean).join(" ");
}

function buildLearning(
	severity: "low" | "medium" | "high",
	hits: number,
	misses: number,
	falsePositives: number,
): string {
	if (severity === "high") {
		if (misses > hits) {
			return (
				"High miss rate suggests critical events were evicted before retrieval. " +
				"Consider increasing hotTailTurns or adding anchor tags to important events."
			);
		}
		if (falsePositives > 3) {
			return (
				"Many false positives indicate poor retrieval precision. " +
				"Consider refining embedding weights or recall query construction."
			);
		}
		return "Compaction quality is poor. Manual review recommended.";
	}
	if (severity === "medium") {
		if (misses > 0) {
			return (
				"Moderate miss rate. Monitor retrieval coverage; consider tuning eviction " +
				"priority for frequently accessed event kinds."
			);
		}
		return "Some false positives detected. Retrieval is functional but imprecise.";
	}
	// low
	if (hits === 0 && misses === 0) {
		return "No retrieval activity detected. Compaction proceeded normally with no recall pressure.";
	}
	return "Retrieval quality is good. Compaction is operating within acceptable parameters.";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a compaction reflector bound to the given event store.
 *
 * @example
 * ```ts
 * const reflector = createCompactionReflector(eventStore);
 * const r = reflector.reflect(result.markerEventId, { contextTokens: 50_000, activeTopics: [] });
 * // r.severity, r.learning — act on the diagnosis
 * ```
 */
export function createCompactionReflector(eventStore: EventStore): CompactionReflector {
	return {
		reflect(
			compactionId: string,
			preCompactionState: { contextTokens: number; activeTopics: string[] },
		): CompactionReflection {
			const timestamp = new Date().toISOString();

			// ------------------------------------------------------------------
			// 1. Read compaction marker to obtain manifest
			// ------------------------------------------------------------------
			const markerEvent = eventStore.readById(compactionId);
			let manifest: CompactionManifest | null = null;
			let contextTokensAfter = preCompactionState.contextTokens;

			if (markerEvent) {
				try {
					manifest = JSON.parse(markerEvent.content) as CompactionManifest;
					contextTokensAfter = Math.max(0, preCompactionState.contextTokens - manifest.tokenCount);
				} catch {
					// Malformed marker content — proceed with defaults
				}
			}

			// ------------------------------------------------------------------
			// 2. Count retrieval quality stats from recent events
			// ------------------------------------------------------------------
			const upToTurnId = markerEvent?.turnId ?? Number.MAX_SAFE_INTEGER;
			const { hits, misses, falsePositives } = countRetrievalStats(eventStore, upToTurnId);

			// ------------------------------------------------------------------
			// 3. Severity routing
			// ------------------------------------------------------------------
			const severity = classifySeverity(hits, misses, falsePositives);
			const needsHumanReview = severity === "high";

			let actionTaken: CompactionReflection["actionTaken"] = "none";
			if (severity === "high") {
				actionTaken = "flagged_for_review";
			} else if (severity === "medium" && misses > 0) {
				actionTaken = "weight_adjusted";
			}

			// ------------------------------------------------------------------
			// 4. Build human-readable fields
			// ------------------------------------------------------------------
			const diagnosis = buildDiagnosis(hits, misses, falsePositives, manifest);
			const learning = buildLearning(severity, hits, misses, falsePositives);

			const reflection: CompactionReflection = {
				timestamp,
				compactionId,
				contextTokensBefore: preCompactionState.contextTokens,
				contextTokensAfter,
				retrievalHits: hits,
				retrievalMisses: misses,
				falsePositives,
				diagnosis,
				actionTaken,
				severity,
				needsHumanReview,
				learning,
			};

			// ------------------------------------------------------------------
			// 5. Persist reflection as a system_event tagged compaction_reflection
			// ------------------------------------------------------------------
			eventStore.append({
				turnId: markerEvent?.turnId ?? 0,
				sessionKey: eventStore.sessionKey,
				kind: "system_event",
				content: JSON.stringify(reflection),
				tokens: Math.ceil(JSON.stringify(reflection).length / 4),
				metadata: { tags: ["compaction_reflection"] },
			});

			return reflection;
		},
	};
}
