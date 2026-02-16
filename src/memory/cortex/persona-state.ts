/**
 * CORTEX Phase 4A: PersonaState schema, versioning, non-eviction guarantee,
 * storage in ENGRAM event store.
 *
 * Implements CORTEX §6.1 — structured persona representation.
 */

import type { EventStore } from "../engram/event-store.js";
import { estimateTokens } from "../engram/event-store.js";

// ---------------------------------------------------------------------------
// Schema (exact TypeScript interfaces from the plan)
// ---------------------------------------------------------------------------

export interface HardRule {
	id: string; // "HR-001"
	rule: string;
	category: "safety" | "identity" | "style" | "policy";
	examples: string[];
}

export interface Trait {
	dimension: string;
	targetValue: number; // 0.0–1.0
	description: string;
	calibrationExamples: string[];
}

export interface VoiceMarkers {
	avgSentenceLength: number;
	vocabularyTier: "casual" | "standard" | "technical" | "academic";
	hedgingLevel: "never" | "rare" | "moderate" | "frequent";
	emojiUsage: "never" | "rare" | "moderate" | "frequent";
	signaturePhrases: string[];
	forbiddenPhrases: string[];
}

export interface HumorCalibration {
	humorFrequency: number; // 0.0–1.0
	preferredPatterns: number[]; // LIMBIC pattern IDs 1-12
	sensitivityThreshold: number;
	audienceModel: Record<string, unknown>; // per-user
}

export interface RelationalState {
	userPreferences: Record<string, unknown>;
	interactionHistory: {
		totalTurns: number;
		firstInteraction: string; // ISO 8601
		lastInteraction: string;
	};
	rapport: number; // 0.0–1.0
}

export interface PersonaState {
	version: number;
	lastUpdated: string; // ISO 8601
	name: string;
	identityStatement: string;
	hardRules: HardRule[];
	traits: Trait[];
	voiceMarkers: VoiceMarkers;
	relational: RelationalState;
	humor: HumorCalibration;
	referenceSamples: string[]; // 3-5 exemplar responses
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class PersonaStateValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PersonaStateValidationError";
	}
}

/**
 * Validate a PersonaState object. Throws on invalid input.
 */
export function validatePersonaState(ps: unknown): PersonaState {
	if (!ps || typeof ps !== "object") {
		throw new PersonaStateValidationError("PersonaState must be a non-null object");
	}

	const obj = ps as Record<string, unknown>;

	// Required string fields
	for (const field of ["name", "identityStatement", "lastUpdated"] as const) {
		if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
			throw new PersonaStateValidationError(`Missing or empty required field: ${field}`);
		}
	}

	if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
		throw new PersonaStateValidationError("version must be a positive integer");
	}

	if (!Array.isArray(obj.hardRules)) {
		throw new PersonaStateValidationError("hardRules must be an array");
	}

	if (!Array.isArray(obj.traits)) {
		throw new PersonaStateValidationError("traits must be an array");
	}

	if (!obj.voiceMarkers || typeof obj.voiceMarkers !== "object") {
		throw new PersonaStateValidationError("voiceMarkers must be an object");
	}

	if (!obj.relational || typeof obj.relational !== "object") {
		throw new PersonaStateValidationError("relational must be an object");
	}

	if (!obj.humor || typeof obj.humor !== "object") {
		throw new PersonaStateValidationError("humor must be an object");
	}

	if (!Array.isArray(obj.referenceSamples)) {
		throw new PersonaStateValidationError("referenceSamples must be an array");
	}

	return ps as PersonaState;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Estimate how many tokens a PersonaState takes when rendered. */
export function estimatePersonaTokens(ps: PersonaState): number {
	return estimateTokens(renderPersonaStateFull(ps));
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Full render of PersonaState for context injection. */
export function renderPersonaStateFull(ps: PersonaState): string {
	const sections: string[] = [
		`# Persona: ${ps.name} (v${ps.version})`,
		`## Identity\n${ps.identityStatement}`,
	];

	if (ps.hardRules.length > 0) {
		sections.push(
			"## Hard Rules\n" +
				ps.hardRules.map((r) => `- [${r.id}] (${r.category}) ${r.rule}`).join("\n"),
		);
	}

	if (ps.traits.length > 0) {
		sections.push(
			"## Traits\n" +
				ps.traits.map((t) => `- ${t.dimension}: ${t.targetValue} — ${t.description}`).join("\n"),
		);
	}

	const vm = ps.voiceMarkers;
	sections.push(
		`## Voice\n` +
			`- Avg sentence length: ${vm.avgSentenceLength} words\n` +
			`- Vocabulary: ${vm.vocabularyTier}\n` +
			`- Hedging: ${vm.hedgingLevel}\n` +
			`- Emoji: ${vm.emojiUsage}\n` +
			(vm.signaturePhrases.length > 0
				? `- Signature phrases: ${vm.signaturePhrases.join(", ")}\n`
				: "") +
			(vm.forbiddenPhrases.length > 0
				? `- Forbidden phrases: ${vm.forbiddenPhrases.join(", ")}`
				: ""),
	);

	if (ps.humor.humorFrequency > 0) {
		sections.push(
			`## Humor\n` +
				`- Frequency: ${ps.humor.humorFrequency}\n` +
				`- Preferred patterns: ${ps.humor.preferredPatterns.join(", ")}\n` +
				`- Sensitivity threshold: ${ps.humor.sensitivityThreshold}`,
		);
	}

	if (ps.referenceSamples.length > 0) {
		sections.push(
			"## Reference Samples\n" +
				ps.referenceSamples.map((s, i) => `${i + 1}. ${s}`).join("\n"),
		);
	}

	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Storage (in ENGRAM event store)
// ---------------------------------------------------------------------------

/**
 * Save a PersonaState to the ENGRAM event store.
 * Each save creates a new event with incremented version.
 */
export function savePersonaState(store: EventStore, ps: PersonaState): PersonaState {
	const existing = loadLatestPersonaState(store);
	const nextVersion = existing ? existing.version + 1 : 1;

	const updated: PersonaState = {
		...ps,
		version: nextVersion,
		lastUpdated: new Date().toISOString(),
	};

	store.append({
		turnId: 0,
		sessionKey: store.sessionKey,
		kind: "persona_state",
		content: JSON.stringify(updated),
		tokens: estimatePersonaTokens(updated),
		metadata: { tags: ["persona", "cortex"] },
	});

	return updated;
}

/**
 * Load the latest PersonaState from the event store.
 * Returns null if none exists.
 */
export function loadLatestPersonaState(store: EventStore): PersonaState | null {
	const events = store.readByKind("persona_state");
	if (events.length === 0) return null;

	// Events are append-only and time-sorted; last one is latest
	const latest = events[events.length - 1];
	try {
		return validatePersonaState(JSON.parse(latest.content));
	} catch {
		return null;
	}
}

/**
 * Load all PersonaState versions (for audit trail).
 */
export function loadPersonaStateHistory(store: EventStore): PersonaState[] {
	return store
		.readByKind("persona_state")
		.map((e) => {
			try {
				return JSON.parse(e.content) as PersonaState;
			} catch {
				return null;
			}
		})
		.filter((ps): ps is PersonaState => ps !== null);
}

// ---------------------------------------------------------------------------
// Default / factory
// ---------------------------------------------------------------------------

/** Create a minimal valid PersonaState for bootstrapping. */
export function createDefaultPersonaState(name: string, identity: string): PersonaState {
	return {
		version: 1,
		lastUpdated: new Date().toISOString(),
		name,
		identityStatement: identity,
		hardRules: [],
		traits: [],
		voiceMarkers: {
			avgSentenceLength: 15,
			vocabularyTier: "standard",
			hedgingLevel: "rare",
			emojiUsage: "rare",
			signaturePhrases: [],
			forbiddenPhrases: [],
		},
		relational: {
			userPreferences: {},
			interactionHistory: {
				totalTurns: 0,
				firstInteraction: new Date().toISOString(),
				lastInteraction: new Date().toISOString(),
			},
			rapport: 0.5,
		},
		humor: {
			humorFrequency: 0.3,
			preferredPatterns: [],
			sensitivityThreshold: 0.5,
			audienceModel: {},
		},
		referenceSamples: [],
	};
}
