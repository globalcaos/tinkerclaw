/**
 * CORTEX Phase 5A: Behavioral Probes
 *
 * Three probe types that run async (non-blocking) after each agent response:
 *   - hard_rule: every turn — checks hard rule compliance
 *   - style: every 5th turn — checks voice/style consistency
 *   - full_audit: every 20th turn — comprehensive persona audit
 *
 * Results stored as probe_result events in the ENGRAM event store.
 * Implements CORTEX §6.3 and Appendix C probe templates.
 */

import type { EventStore } from "../engram/event-store.js";
import type { PersonaState } from "./persona-state.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const PROBE_SCHEDULE = {
	hardRule: 1,
	style: 5,
	fullAudit: 20,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProbeType = "hard_rule" | "style" | "full_audit";

export interface ProbeResult {
	probeType: ProbeType;
	turnNumber: number;
	timestamp: string;
	scores: Record<string, number>; // dimension → score (0–1)
	violations: string[]; // list of violated rules/dimensions
	rawOutput: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	cost: number; // estimated USD
}

/**
 * LLM call function signature — injected for testability.
 * Given a prompt, returns { output, inputTokens, outputTokens, model, latencyMs }.
 */
export interface ProbeLLMFn {
	(prompt: string): Promise<{
		output: string;
		inputTokens: number;
		outputTokens: number;
		model: string;
		latencyMs: number;
	}>;
}

// ---------------------------------------------------------------------------
// Probe prompt templates (CORTEX Appendix C)
// ---------------------------------------------------------------------------

export function buildHardRuleProbePrompt(response: string, persona: PersonaState): string {
	const rules = persona.hardRules
		.map((r) => `- [${r.id}] (${r.category}): ${r.rule}`)
		.join("\n");

	return `You are a compliance auditor. Check if the following response violates any of the persona's hard rules.

## Hard Rules
${rules}

## Forbidden Phrases
${persona.voiceMarkers.forbiddenPhrases.map((p) => `- "${p}"`).join("\n")}

## Response to Audit
${response}

## Output Format (JSON)
{
  "scores": { "<rule_id>": <0.0-1.0 compliance score> },
  "violations": ["<rule_id or phrase that was violated>"],
  "reasoning": "<brief explanation>"
}

Output ONLY valid JSON.`;
}

export function buildStyleProbePrompt(response: string, persona: PersonaState): string {
	const vm = persona.voiceMarkers;
	return `You are a style consistency auditor. Check if the following response matches the persona's voice profile.

## Voice Profile
- Target avg sentence length: ${vm.avgSentenceLength} words
- Vocabulary tier: ${vm.vocabularyTier}
- Hedging level: ${vm.hedgingLevel}
- Emoji usage: ${vm.emojiUsage}
- Signature phrases: ${vm.signaturePhrases.join(", ") || "none"}

## Traits
${persona.traits.map((t) => `- ${t.dimension}: target ${t.targetValue} (${t.description})`).join("\n")}

## Response to Audit
${response}

## Output Format (JSON)
{
  "scores": {
    "sentence_length": <0.0-1.0>,
    "vocabulary": <0.0-1.0>,
    "hedging": <0.0-1.0>,
    "emoji": <0.0-1.0>,
    "overall_style": <0.0-1.0>
  },
  "violations": ["<dimension that deviates significantly>"],
  "reasoning": "<brief explanation>"
}

Output ONLY valid JSON.`;
}

export function buildFullAuditProbePrompt(response: string, persona: PersonaState): string {
	return `You are a comprehensive persona auditor. Evaluate the following response against ALL aspects of the persona definition.

## Persona: ${persona.name}
### Identity
${persona.identityStatement}

### Hard Rules
${persona.hardRules.map((r) => `- [${r.id}] ${r.rule}`).join("\n")}

### Traits
${persona.traits.map((t) => `- ${t.dimension}: ${t.targetValue} — ${t.description}`).join("\n")}

### Voice
- Avg sentence length: ${persona.voiceMarkers.avgSentenceLength}
- Vocabulary: ${persona.voiceMarkers.vocabularyTier}
- Hedging: ${persona.voiceMarkers.hedgingLevel}
- Forbidden: ${persona.voiceMarkers.forbiddenPhrases.join(", ")}

### Reference Samples
${persona.referenceSamples.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Response to Audit
${response}

## Output Format (JSON)
{
  "scores": {
    "identity_alignment": <0.0-1.0>,
    "hard_rule_compliance": <0.0-1.0>,
    "trait_consistency": <0.0-1.0>,
    "voice_match": <0.0-1.0>,
    "overall": <0.0-1.0>
  },
  "violations": ["<any violated dimension or rule>"],
  "reasoning": "<brief explanation>"
}

Output ONLY valid JSON.`;
}

// ---------------------------------------------------------------------------
// Probe execution
// ---------------------------------------------------------------------------

/** Determine which probes should fire on this turn. */
export function getScheduledProbes(turnNumber: number): ProbeType[] {
	const probes: ProbeType[] = [];
	if (turnNumber % PROBE_SCHEDULE.hardRule === 0) probes.push("hard_rule");
	if (turnNumber % PROBE_SCHEDULE.style === 0) probes.push("style");
	if (turnNumber % PROBE_SCHEDULE.fullAudit === 0) probes.push("full_audit");
	return probes;
}

/** Build the prompt for a given probe type. */
export function buildProbePrompt(
	type: ProbeType,
	response: string,
	persona: PersonaState,
): string {
	switch (type) {
		case "hard_rule":
			return buildHardRuleProbePrompt(response, persona);
		case "style":
			return buildStyleProbePrompt(response, persona);
		case "full_audit":
			return buildFullAuditProbePrompt(response, persona);
	}
}

/** Parse LLM output into scores and violations. */
export function parseProbeOutput(raw: string): {
	scores: Record<string, number>;
	violations: string[];
} {
	try {
		// Extract JSON from potentially wrapped output
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return { scores: {}, violations: [] };
		const parsed = JSON.parse(jsonMatch[0]);
		return {
			scores: parsed.scores ?? {},
			violations: parsed.violations ?? [],
		};
	} catch {
		return { scores: {}, violations: [] };
	}
}

/** Estimated cost per probe (Gemini Flash pricing ~$0.075/1M input, ~$0.30/1M output). */
function estimateCost(inputTokens: number, outputTokens: number): number {
	return inputTokens * 0.000000075 + outputTokens * 0.0000003;
}

/**
 * Run a single probe. Returns result or null if not scheduled.
 */
export async function runProbe(
	type: ProbeType,
	response: string,
	persona: PersonaState,
	turnNumber: number,
	llmFn: ProbeLLMFn,
): Promise<ProbeResult | null> {
	const scheduled = getScheduledProbes(turnNumber);
	if (!scheduled.includes(type)) return null;

	const prompt = buildProbePrompt(type, response, persona);
	const result = await llmFn(prompt);
	const parsed = parseProbeOutput(result.output);

	return {
		probeType: type,
		turnNumber,
		timestamp: new Date().toISOString(),
		scores: parsed.scores,
		violations: parsed.violations,
		rawOutput: result.output,
		model: result.model,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		latencyMs: result.latencyMs,
		cost: estimateCost(result.inputTokens, result.outputTokens),
	};
}

/**
 * Run all scheduled probes for a given turn. Non-blocking — fire and forget.
 * Results are stored in the event store.
 */
export async function runAllScheduledProbes(
	response: string,
	persona: PersonaState,
	turnNumber: number,
	llmFn: ProbeLLMFn,
	store?: EventStore,
): Promise<ProbeResult[]> {
	const scheduled = getScheduledProbes(turnNumber);
	const results: ProbeResult[] = [];

	const promises = scheduled.map(async (type) => {
		const result = await runProbe(type, response, persona, turnNumber, llmFn);
		if (result) {
			results.push(result);
			if (store) {
				store.append({
					turnId: turnNumber,
					sessionKey: store.sessionKey,
					kind: "probe_result",
					content: JSON.stringify(result),
					tokens: Math.ceil(JSON.stringify(result).length / 4),
					metadata: { tags: ["cortex", "probe", type] },
				});
			}
		}
	});

	await Promise.all(promises);
	return results;
}

/**
 * Load probe results from the event store.
 */
export function loadProbeResults(store: EventStore, limit?: number): ProbeResult[] {
	const events = store.readByKind("probe_result");
	const results = events
		.map((e) => {
			try {
				return JSON.parse(e.content) as ProbeResult;
			} catch {
				return null;
			}
		})
		.filter((r): r is ProbeResult => r !== null);

	if (limit) return results.slice(-limit);
	return results;
}
