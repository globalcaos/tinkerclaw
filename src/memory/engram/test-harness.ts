/**
 * ENGRAM Phase 0C: Test harness for simulated conversations.
 * Replays a trace through the memory pipeline, measuring metrics at each step.
 */

import type { MemoryEvent, EventKind } from "./event-types.js";
import type { EventStore } from "./event-store.js";
import type { MetricsCollector } from "./metrics.js";

export interface TraceTurn {
	turnId: number;
	role: "user" | "assistant" | "tool";
	content: string;
	toolName?: string;
	kind?: EventKind;
}

export interface TraceReplayResult {
	totalTurns: number;
	totalEvents: number;
	totalTokens: number;
	perTurnMetrics: TurnMetrics[];
}

export interface TurnMetrics {
	turnId: number;
	eventCount: number;
	cumulativeTokens: number;
	cumulativeEvents: number;
}

/**
 * Replay a conversation trace through an event store, recording metrics.
 */
export function replayTrace(
	trace: TraceTurn[],
	store: EventStore,
	metrics?: MetricsCollector,
): TraceReplayResult {
	const perTurnMetrics: TurnMetrics[] = [];
	let cumulativeTokens = 0;
	let cumulativeEvents = 0;

	for (const turn of trace) {
		const kind: EventKind =
			turn.kind ?? (turn.role === "user" ? "user_message" : turn.role === "tool" ? "tool_result" : "agent_message");

		const event = store.append({
			turnId: turn.turnId,
			sessionKey: store.sessionKey,
			kind,
			content: turn.content,
			tokens: Math.ceil(turn.content.length / 4),
			metadata: turn.toolName ? { tags: [turn.toolName] } : {},
		});

		cumulativeTokens += event.tokens;
		cumulativeEvents += 1;

		perTurnMetrics.push({
			turnId: turn.turnId,
			eventCount: 1,
			cumulativeTokens,
			cumulativeEvents,
		});

		metrics?.record("harness", "turn_processed", turn.turnId, {
			kind,
			tokens: event.tokens,
			cumulativeTokens,
		});
	}

	return {
		totalTurns: trace.length,
		totalEvents: cumulativeEvents,
		totalTokens: cumulativeTokens,
		perTurnMetrics,
	};
}

/**
 * Generate a synthetic conversation trace with embedded needles.
 */
export function generateSyntheticTrace(options: {
	turnCount: number;
	needles: Array<{ turnId: number; content: string }>;
	floodTokensPerTurn?: number;
	seed?: number;
}): TraceTurn[] {
	const { turnCount, needles, floodTokensPerTurn = 500 } = options;
	const trace: TraceTurn[] = [];
	const needleMap = new Map(needles.map((n) => [n.turnId, n.content]));

	for (let i = 1; i <= turnCount; i++) {
		const isUserTurn = i % 2 === 1;
		const needle = needleMap.get(i);

		if (needle) {
			trace.push({
				turnId: i,
				role: "user",
				content: needle,
				kind: "user_message",
			});
		} else if (isUserTurn) {
			trace.push({
				turnId: i,
				role: "user",
				content: `User message at turn ${i}: ${"x".repeat(floodTokensPerTurn * 4)}`,
				kind: "user_message",
			});
		} else {
			// Simulate tool results (bulk of tokens in real sessions)
			trace.push({
				turnId: i,
				role: "tool",
				content: `Tool output at turn ${i}: ${"data ".repeat(floodTokensPerTurn)}`,
				kind: "tool_result",
				toolName: "build_tool",
			});
		}
	}

	return trace;
}
