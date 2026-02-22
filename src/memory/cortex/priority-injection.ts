/**
 * CORTEX Phase 4B: Priority-aware persona injection.
 *
 * Implements CORTEX §5.1 — tiered injection with budget enforcement.
 *
 * Tier structure:
 *   Tier 1 (pinned) — PersonaState (with intra-persona 1A/1B/1C sub-tiers)
 *   Tier 2 (recent) — recent tail events
 *   Tier 3 (scored) — retrieved events by task-conditioned score
 *
 * Intra-persona tiers:
 *   1A — immutable core: name, identity, hard rules, core voice markers
 *   1B — compressible: traits, humor calibration, reference samples
 *   1C — relational: per-user relational state
 */

import { estimateTokens } from "../engram/event-store.js";
import type { PersonaState } from "./persona-state.js";

// ---------------------------------------------------------------------------
// Configuration (from CORTEX_CONFIG)
// ---------------------------------------------------------------------------

export const CORTEX_PERSONA_CONFIG = {
	maxBudgetFraction: 0.05, // η_max — persona never exceeds 5% of context
	tier1ABudgetFraction: 0.02, // immutable core
	tier1BBudgetFraction: 0.02, // compressible
	tier1CBudgetFraction: 0.01, // relational
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InjectionBlock {
	role: "system";
	content: string;
	tier: "1-pinned" | "1A-immutable" | "1B-compressible" | "1C-relational";
	tokens: number;
}

export interface InjectionResult {
	blocks: InjectionBlock[];
	totalTokens: number;
	budgetLimit: number;
	overflow: boolean; // true if 1B or 1C were dropped
}

// ---------------------------------------------------------------------------
// Rendering sub-tiers
// ---------------------------------------------------------------------------

export interface RenderTier1AOptions {
	/** When true, skip identity & voice sections already covered by SOUL.md. */
	hasSoulFile?: boolean;
}

/** Tier 1A: immutable core — name, identity, hard rules, core voice markers. */
export function renderTier1A(ps: PersonaState, opts?: RenderTier1AOptions): string {
	const lines: string[] = [];

	if (!opts?.hasSoulFile) {
		// Identity & voice only injected when SOUL.md is absent
		lines.push(
			`# Persona: ${ps.name} (v${ps.version})`,
			`## Identity\n${ps.identityStatement}`,
		);

		const vm = ps.voiceMarkers;
		lines.push(
			`## Voice (core)\n` +
				`- Avg sentence length: ${vm.avgSentenceLength} words\n` +
				`- Vocabulary: ${vm.vocabularyTier}\n` +
				`- Hedging: ${vm.hedgingLevel}\n` +
				`- Emoji: ${vm.emojiUsage}`,
		);
	}

	if (ps.hardRules.length > 0) {
		lines.push(
			"## Hard Rules\n" +
				ps.hardRules.map((r) => `- [${r.id}] (${r.category}) ${r.rule}`).join("\n"),
		);
	}

	if (ps.voiceMarkers.forbiddenPhrases.length > 0) {
		lines.push(`- FORBIDDEN: ${ps.voiceMarkers.forbiddenPhrases.join(", ")}`);
	}

	return lines.join("\n\n");
}

/** Tier 1B: compressible — traits, humor, reference samples, signature phrases. */
export function renderTier1B(ps: PersonaState): string {
	const lines: string[] = [];

	if (ps.traits.length > 0) {
		lines.push(
			"## Traits\n" +
				ps.traits.map((t) => `- ${t.dimension}: ${t.targetValue} — ${t.description}`).join("\n"),
		);
	}

	if (ps.humor.humorFrequency > 0) {
		lines.push(
			`## Humor\n` +
				`- Frequency: ${ps.humor.humorFrequency}\n` +
				`- Patterns: ${ps.humor.preferredPatterns.join(", ") || "none"}\n` +
				`- Sensitivity: ${ps.humor.sensitivityThreshold}`,
		);
	}

	if (ps.voiceMarkers.signaturePhrases.length > 0) {
		lines.push(`## Signature Phrases\n${ps.voiceMarkers.signaturePhrases.join(", ")}`);
	}

	if (ps.referenceSamples.length > 0) {
		lines.push(
			"## Reference Samples\n" +
				ps.referenceSamples.map((s, i) => `${i + 1}. ${s}`).join("\n"),
		);
	}

	return lines.join("\n\n");
}

/** Tier 1C: relational — per-user state. */
export function renderTier1C(ps: PersonaState): string {
	const rel = ps.relational;
	const lines: string[] = [
		`## Relational State`,
		`- Rapport: ${rel.rapport}`,
		`- Total turns: ${rel.interactionHistory.totalTurns}`,
		`- First interaction: ${rel.interactionHistory.firstInteraction}`,
		`- Last interaction: ${rel.interactionHistory.lastInteraction}`,
	];

	const prefKeys = Object.keys(rel.userPreferences);
	if (prefKeys.length > 0) {
		lines.push(
			`- Preferences: ${prefKeys.map((k) => `${k}=${JSON.stringify(rel.userPreferences[k])}`).join(", ")}`,
		);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main injection function
// ---------------------------------------------------------------------------

/**
 * Inject PersonaState into context with budget enforcement and tiered fallback.
 *
 * @param ps - The PersonaState to inject
 * @param contextWindow - Total context window size in tokens
 * @returns Injection blocks ready to insert into the push pack
 */
export interface InjectPersonaOptions {
	/** When true, skip identity & voice sections already covered by SOUL.md. */
	hasSoulFile?: boolean;
	/** When true, skip relational state (Tier 1C) injection. */
	skipRelational?: boolean;
}

export function injectPersonaState(
	ps: PersonaState,
	contextWindow: number,
	opts?: InjectPersonaOptions,
): InjectionResult {
	const totalBudget = Math.floor(contextWindow * CORTEX_PERSONA_CONFIG.maxBudgetFraction);

	const skipRelational = opts?.skipRelational || opts?.hasSoulFile;

	// Try full render first
	const fullContent = [renderTier1A(ps, opts), renderTier1B(ps), skipRelational ? "" : renderTier1C(ps)]
		.filter(Boolean)
		.join("\n\n");
	const fullTokens = estimateTokens(fullContent);

	if (fullTokens <= totalBudget) {
		return {
			blocks: [{ role: "system", content: fullContent, tier: "1-pinned", tokens: fullTokens }],
			totalTokens: fullTokens,
			budgetLimit: totalBudget,
			overflow: false,
		};
	}

	// Tiered fallback: always include 1A, then 1B/1C if they fit
	const content1A = renderTier1A(ps, opts);
	const content1B = renderTier1B(ps);
	const content1C = renderTier1C(ps);

	const tokens1A = estimateTokens(content1A);
	const tokens1B = estimateTokens(content1B);
	const tokens1C = estimateTokens(content1C);

	const blocks: InjectionBlock[] = [];
	let used = 0;
	let overflow = false;

	// 1A always included (even if it exceeds budget — identity is non-negotiable)
	blocks.push({ role: "system", content: content1A, tier: "1A-immutable", tokens: tokens1A });
	used += tokens1A;

	// 1B if room
	if (used + tokens1B <= totalBudget) {
		blocks.push({ role: "system", content: content1B, tier: "1B-compressible", tokens: tokens1B });
		used += tokens1B;
	} else {
		overflow = true;
	}

	// 1C if room (and not skipped)
	if (!skipRelational && used + tokens1C <= totalBudget) {
		blocks.push({ role: "system", content: content1C, tier: "1C-relational", tokens: tokens1C });
		used += tokens1C;
	} else if (!skipRelational) {
		overflow = true;
	}

	return {
		blocks,
		totalTokens: used,
		budgetLimit: totalBudget,
		overflow,
	};
}
