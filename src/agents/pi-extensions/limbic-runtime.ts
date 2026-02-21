/**
 * LIMBIC Phase 4 Runtime: Humor pipeline wiring.
 *
 * Wraps bridge-discovery.ts, humor-potential.ts, and sensitivity-gate.ts
 * into a session-scoped runtime with event-store persistence for reactions.
 *
 * Registry pattern mirrors cortex-runtime.ts / ingestion-runtime.ts.
 */

import {
	discoverBridges as discoverBridgesCascade,
	type BridgeCandidate,
} from "../../memory/limbic/bridge-discovery.js";
import { humorPotentialV2, type AnnIndex } from "../../memory/limbic/humor-potential.js";
import {
	sensitivityGate,
	computeSensitivityScore,
	type SensitivityResult,
} from "../../memory/limbic/sensitivity-gate.js";
import { createAssociation, recordOutcome, serializeAssociation } from "../../memory/limbic/humor-associations.js";
import { LIMBIC_CONFIG } from "../../memory/limbic/config.js";
import type { EventStore } from "../../memory/engram/event-store.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";
import type { CortexRuntime } from "./cortex-runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LimbicRuntimeOptions {
	/** Embedding dimension for concept vectors (default 128). */
	embeddingDim?: number;
	/** High-affinity concept pairs to pre-compute on init. */
	highAffinityPairs?: Array<[string, string]>;
}

export interface BridgeResult {
	bridge: string;
	quality: number;
	method: string;
}

export interface LimbicRuntime {
	/** Find conceptual bridges between two distant concepts. */
	discoverBridges(conceptA: string, conceptB: string): Promise<BridgeResult[]>;
	/** Score humor potential for a triplet using h_v2 (surprise-weighted coherence). */
	scoreHumor(conceptA: string, conceptB: string, bridge: string): number;
	/** Run sensitivity gate for a topic and optional context string. */
	checkSensitivity(topic: string, context?: string): SensitivityResult;
	/** Persist audience reaction to a humor attempt in the event store. */
	recordReaction(
		humorAttemptId: string,
		reaction: "positive" | "neutral" | "negative",
	): void;
}

// ---------------------------------------------------------------------------
// Deterministic concept → embedding (no external embedding service required)
// ---------------------------------------------------------------------------

/**
 * Convert a concept string into a deterministic unit-length vector.
 * Uses a multiplicative hash chain seeded from the string's characters.
 * Dimension is kept small (128) for fast tests and runtime use.
 */
function conceptToVector(concept: string, dim: number): number[] {
	// Seed from the full string for uniqueness
	let h = 2166136261; // FNV offset basis
	for (let i = 0; i < concept.length; i++) {
		h = Math.imul(h ^ concept.charCodeAt(i), 16777619) >>> 0; // FNV-1a
	}
	const v: number[] = new Array(dim);
	let s = h;
	for (let i = 0; i < dim; i++) {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0; // LCG
		v[i] = (s / 0x100000000) * 2 - 1;
	}
	// L2 normalise
	const mag = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
	return mag > 0 ? v.map((x) => x / mag) : v;
}

// ---------------------------------------------------------------------------
// In-memory ANN index (cosine similarity)
// ---------------------------------------------------------------------------

function createRuntimeIndex(entries: Array<{ id: string; vector: number[] }>): AnnIndex {
	return {
		query(vector: number[], k: number) {
			const scored = entries.map((e) => ({
				...e,
				sim: e.vector.reduce((s, x, i) => s + x * vector[i], 0), // dot product of unit vectors = cos sim
			}));
			scored.sort((a, b) => b.sim - a.sim);
			return scored.slice(0, k);
		},
		getId(vector: number[]) {
			for (const e of entries) {
				const sim = e.vector.reduce((s, x, i) => s + x * vector[i], 0);
				if (sim > 0.9999) return e.id;
			}
			return undefined;
		},
	};
}

// ---------------------------------------------------------------------------
// Pending-reaction index (in-memory, keyed by attempt ID)
// ---------------------------------------------------------------------------

interface PendingAttempt {
	conceptA: string;
	conceptB: string;
	bridge: string;
	audience: string;
	timestamp: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LIMBIC runtime backed by an ENGRAM event store.
 *
 * On construction, the runtime pre-computes bridge candidates for any
 * `highAffinityPairs` supplied in options.
 */
export function createLimbicRuntime(
	eventStore: EventStore,
	options: LimbicRuntimeOptions = {},
	cortexRuntime?: CortexRuntime,
): LimbicRuntime {
	const dim = options.embeddingDim ?? 128;

	// Concept vector cache — reuse vectors across calls for the same label.
	const vectorCache = new Map<string, number[]>();

	function getVector(concept: string): number[] {
		let v = vectorCache.get(concept);
		if (!v) {
			v = conceptToVector(concept, dim);
			vectorCache.set(concept, v);
		}
		return v;
	}

	// Build a shared ANN index from all cached concepts (grows over time).
	function buildIndex(): AnnIndex {
		const entries = Array.from(vectorCache.entries()).map(([id, vector]) => ({ id, vector }));
		return createRuntimeIndex(entries);
	}

	// In-memory pending-attempt registry (keyed by humorAttemptId).
	const pendingAttempts = new Map<string, PendingAttempt>();

	// ---------- Pre-computation for high-affinity pairs ----------
	if (options.highAffinityPairs?.length) {
		// Eagerly populate vector cache so the index is richer from the start.
		for (const [a, b] of options.highAffinityPairs) {
			getVector(a);
			getVector(b);
		}
	}

	// ---------- Humor calibration from CORTEX (or defaults) ----------
	function getCalibration() {
		return cortexRuntime?.persona.humor ?? {
			humorFrequency: 0.15,
			preferredPatterns: [1, 4, 7],
			sensitivityThreshold: 0.5,
			audienceModel: {},
		};
	}

	return {
		async discoverBridges(conceptA: string, conceptB: string): Promise<BridgeResult[]> {
			const A = getVector(conceptA);
			const B = getVector(conceptB);
			const index = buildIndex();

			const candidates: BridgeCandidate[] = await discoverBridgesCascade(A, B, index, {
				labelA: conceptA,
				labelB: conceptB,
				minQuality: LIMBIC_CONFIG.bridge.minBridgeQuality,
				maxResults: 5,
			});

			return candidates.map((c) => ({
				bridge: c.id,
				quality: c.quality,
				method: c.method,
			}));
		},

		scoreHumor(conceptA: string, conceptB: string, bridge: string): number {
			const A = getVector(conceptA);
			const B = getVector(conceptB);
			// Ensure the bridge vector is in the cache so getId() can resolve it.
			const bridgeVec = getVector(bridge);
			const index = buildIndex();
			return humorPotentialV2(A, B, bridgeVec, index);
		},

		checkSensitivity(topic: string, context?: string): SensitivityResult {
			const combinedText = context ? `${topic} ${context}` : topic;
			const calibration = getCalibration();
			// sensitivityGate needs conceptA/conceptB/bridge breakdown; map topic to those roles.
			return sensitivityGate(topic, context ?? "", "", calibration);
		},

		recordReaction(
			humorAttemptId: string,
			reaction: "positive" | "neutral" | "negative",
		): void {
			const pending = pendingAttempts.get(humorAttemptId);
			const conceptA = pending?.conceptA ?? "unknown";
			const conceptB = pending?.conceptB ?? "unknown";
			const bridge = pending?.bridge ?? "unknown";
			const audience = pending?.audience ?? eventStore.sessionKey;

			// Build/update a HumorAssociation and persist it to the event store.
			const association = createAssociation({
				conceptA,
				conceptB,
				bridge,
				patternType: 1,
				surpriseScore: pending ? this.scoreHumor(conceptA, conceptB, bridge) : 0,
				audience,
				discoveredVia: "conversation",
			});
			const updated = recordOutcome(association, reaction === "positive");

			eventStore.append({
				turnId: 0,
				sessionKey: eventStore.sessionKey,
				kind: "humor_association",
				content: serializeAssociation(updated),
				tokens: Math.ceil(serializeAssociation(updated).length / 4),
				metadata: {
					tags: ["limbic", "humor_reaction", reaction],
					importance: reaction === "positive" ? 7 : reaction === "negative" ? 4 : 5,
				},
			});

			pendingAttempts.delete(humorAttemptId);
		},
	};
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = createSessionManagerRuntimeRegistry<LimbicRuntime>();

/** Store a LimbicRuntime for a given session manager instance. */
export const setLimbicRuntime = registry.set;

/** Retrieve the LimbicRuntime for a given session manager instance, or null. */
export const getLimbicRuntime = registry.get;
