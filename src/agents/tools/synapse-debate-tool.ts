/**
 * SYNAPSE Phase 5: synapse_debate agent tool.
 *
 * Exposes the SYNAPSE multi-model debate engine as a first-class agent tool.
 * The agent invokes this to run a structured adversarial deliberation and get
 * back a formatted consensus suitable for incorporation into its response.
 */

import { Type } from "@sinclair/typebox";
import { getSynapseRuntime, type DebateDepth } from "../pi-extensions/synapse-runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ── Schema ─────────────────────────────────────────────────────────────────

const SynapseDebateSchema = Type.Object({
	topic: Type.String({ description: "The question or decision to deliberate on." }),
	depth: Type.Optional(
		Type.Union(
			[
				Type.Literal("quick"),
				Type.Literal("standard"),
				Type.Literal("deep"),
			],
			{
				description:
					"Deliberation depth — quick (2 rounds), standard (4 rounds), deep (6 rounds). Defaults to standard.",
			},
		),
	),
});

// ── Formatting helpers ─────────────────────────────────────────────────────

function confidenceLabel(score: number): string {
	if (score >= 0.8) return "high";
	if (score >= 0.5) return "moderate";
	return "low";
}

function formatDebateResult(params: {
	topic: string;
	consensus: string;
	confidence: number;
	dissent: string[];
	actionItems: string[];
	diversityScore: number;
	depth: DebateDepth;
}): string {
	const { topic, consensus, confidence, dissent, actionItems, diversityScore, depth } = params;
	const lines: string[] = [
		`## SYNAPSE Debate: ${topic}`,
		`**Depth:** ${depth} | **Confidence:** ${confidenceLabel(confidence)} (${(confidence * 100).toFixed(0)}%) | **Diversity Score (CDI):** ${diversityScore.toFixed(2)}`,
		"",
		"### Consensus",
		consensus,
	];

	if (dissent.length > 0) {
		lines.push("", "### Dissenting Views");
		for (const d of dissent) {
			lines.push(`- ${d}`);
		}
	}

	if (actionItems.length > 0) {
		lines.push("", "### Action Items");
		for (const a of actionItems) {
			lines.push(`- ${a}`);
		}
	}

	return lines.join("\n");
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createSynapseDebateTool(): AnyAgentTool | null {
	const runtime = getSynapseRuntime();
	if (!runtime) {
		return null;
	}

	return {
		label: "SYNAPSE Debate",
		name: "synapse_debate",
		description:
			"Run a structured multi-model adversarial debate on a topic using the SYNAPSE protocol. " +
			"Three synthetic roles (Architect, Critic, Pragmatist) deliberate through Propose→Challenge→Defend→Synthesize→Ratify rounds. " +
			"Returns consensus text, confidence score, dissenting views, and action items. " +
			"Use for complex decisions, architectural trade-offs, or when you need adversarial validation of a plan.",
		parameters: SynapseDebateSchema,
		execute: async (_toolCallId, params) => {
			const topic = readStringParam(params, "topic", { required: true });
			const rawDepth = readStringParam(params, "depth");
			const depth: DebateDepth =
				rawDepth === "quick" || rawDepth === "standard" || rawDepth === "deep"
					? rawDepth
					: "standard";

			const rt = getSynapseRuntime();
			if (!rt) {
				return jsonResult({ error: "SYNAPSE runtime not available — compaction.mode must be 'engram'." });
			}

			try {
				const result = await rt.debate(topic, { depth });
				const formatted = formatDebateResult({ topic, depth, ...result });
				return jsonResult({
					topic,
					depth,
					consensus: result.consensus,
					confidence: result.confidence,
					dissent: result.dissent,
					actionItems: result.actionItems,
					diversityScore: result.diversityScore,
					formatted,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ error: `Debate failed: ${message}` });
			}
		},
	};
}
