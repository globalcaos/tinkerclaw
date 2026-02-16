/**
 * ENGRAM Phase 1C: Push pack assembly.
 * Builds the context window contents from task state, markers, and recent tail.
 * Matches ENGRAM Annex A.2.
 */

import type { MemoryEvent } from "./event-types.js";
import { estimateTokens } from "./event-store.js";
import type { TimeRangeMarker } from "./time-range-marker.js";
import { renderMarkers } from "./time-range-marker.js";
import { renderTaskState, type TaskState } from "./task-state.js";

/**
 * Budget allocation fractions (from ENGRAM_CONFIG).
 */
export interface BudgetFractions {
	system: number;
	persona: number;
	task: number;
	tail: number;
	retrieved: number;
}

export const DEFAULT_BUDGET_FRACTIONS: BudgetFractions = {
	system: 0.15,
	persona: 0.05,
	task: 0.03,
	tail: 0.30,
	retrieved: 0.47,
};

export interface ContextBlock {
	role: "system" | "user" | "assistant";
	content: string;
	label: string;
	tokens: number;
}

export interface ContextPack {
	blocks: ContextBlock[];
	totalTokens: number;
	budgetUsed: Record<string, number>;
}

const RECALL_TOOL_DECLARATION = `You have access to a recall(query) tool that retrieves past events from memory. Use it when you need information that was discussed earlier but is not visible in the current context. Markers like "[Events T12–T47 evicted...]" indicate compacted regions you can recall from.`;

/**
 * Build a push pack — the pre-assembled context sent to the model.
 */
export function buildPushPack(opts: {
	systemPrompt: string;
	userMessage: string;
	taskState: TaskState;
	recentTail: MemoryEvent[];
	markers: TimeRangeMarker[];
	contextWindow: number;
	budgetFractions?: BudgetFractions;
}): ContextPack {
	const fractions = opts.budgetFractions ?? DEFAULT_BUDGET_FRACTIONS;
	const ctx = opts.contextWindow;

	const budgets = {
		system: Math.floor(ctx * fractions.system),
		persona: Math.floor(ctx * fractions.persona),
		task: Math.floor(ctx * fractions.task),
		tail: Math.floor(ctx * fractions.tail),
		retrieved: Math.floor(ctx * fractions.retrieved),
	};

	const blocks: ContextBlock[] = [];
	const budgetUsed: Record<string, number> = {};

	// 1. System prompt
	const systemTokens = estimateTokens(opts.systemPrompt);
	blocks.push({ role: "system", content: opts.systemPrompt, label: "system", tokens: systemTokens });
	budgetUsed.system = systemTokens;

	// 2. PersonaState placeholder (Phase 4 integration point)
	// Will be injected by CORTEX persona-injection.ts
	budgetUsed.persona = 0;

	// 3. Task state
	const taskContent = renderTaskState(opts.taskState);
	const taskTokens = estimateTokens(taskContent);
	blocks.push({ role: "system", content: taskContent, label: "task", tokens: taskTokens });
	budgetUsed.task = taskTokens;

	// 4. Markers (compacted history pointers)
	const markersContent = renderMarkers(opts.markers);
	if (markersContent) {
		const markerTokens = estimateTokens(markersContent);
		blocks.push({ role: "system", content: markersContent, label: "markers", tokens: markerTokens });
	}

	// 5. Recall tool declaration
	const recallTokens = estimateTokens(RECALL_TOOL_DECLARATION);
	blocks.push({ role: "system", content: RECALL_TOOL_DECLARATION, label: "recall_decl", tokens: recallTokens });

	// 6. Recent tail (last K turns, verbatim)
	let tailTokensUsed = 0;
	for (const event of opts.recentTail) {
		if (tailTokensUsed + event.tokens > budgets.tail) break;
		const role = event.kind === "user_message" ? "user" as const : event.kind === "agent_message" ? "assistant" as const : "system" as const;
		blocks.push({ role, content: event.content, label: "tail", tokens: event.tokens });
		tailTokensUsed += event.tokens;
	}
	budgetUsed.tail = tailTokensUsed;

	// 7. User message
	const userTokens = estimateTokens(opts.userMessage);
	blocks.push({ role: "user", content: opts.userMessage, label: "user", tokens: userTokens });

	const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);
	budgetUsed.retrieved = 0; // Filled by pull retrieval (Phase 1D)

	return { blocks, totalTokens, budgetUsed };
}
