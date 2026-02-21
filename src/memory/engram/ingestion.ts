/**
 * ENGRAM Phase 1.1: Event ingestion pipeline.
 *
 * Thin integration layer that maps conversation events (user messages,
 * assistant replies, tool calls/results, system events) into ENGRAM
 * event store entries, with automatic artifact externalization for large
 * tool outputs (>1 KB by default).
 */

import { createEventStore, estimateTokens } from "./event-store.js";
import { createArtifactStore } from "./artifact-store.js";
import type { EventKind, MemoryEvent } from "./event-types.js";

/** Default threshold above which tool output is externalised to the artifact store. */
export const DEFAULT_ARTIFACT_THRESHOLD_BYTES = 1024;

/** Default importance scores per event kind (1–10 scale). */
const IMPORTANCE_BY_KIND: Partial<Record<EventKind, number>> = {
	user_message: 7,
	agent_message: 5,
	tool_call: 5,
	tool_result: 3,
	artifact_reference: 3,
	system_event: 5,
};
const DEFAULT_IMPORTANCE = 5;

function importanceFor(kind: EventKind): number {
	return IMPORTANCE_BY_KIND[kind] ?? DEFAULT_IMPORTANCE;
}

export interface IngestionPipelineConfig {
	/** Root directory for event store and artifact store (e.g. ~/.openclaw/engram). */
	baseDir: string;
	/** Unique key identifying the current session. */
	sessionKey: string;
	/**
	 * Byte length above which tool result output is externalised to the
	 * artifact store and replaced with an artifact_reference event.
	 * Default: 1024 (1 KB).
	 */
	artifactThresholdBytes?: number;
}

export interface IngestionPipeline {
	/** Ingest a user-authored message. Returns the stored MemoryEvent. */
	ingestUserMessage(text: string, turnId: number): MemoryEvent;
	/** Ingest an assistant (agent) reply. Returns the stored MemoryEvent. */
	ingestAssistantMessage(text: string, turnId: number): MemoryEvent;
	/**
	 * Ingest a tool invocation.
	 * Content is serialised as `{ tool, args }` JSON.
	 */
	ingestToolCall(name: string, args: Record<string, unknown>, turnId: number): MemoryEvent;
	/**
	 * Ingest a tool result.
	 * If `output.length > artifactThresholdBytes`, the output is externalised
	 * and an artifact_reference event is stored instead of a tool_result.
	 */
	ingestToolResult(name: string, output: string, turnId: number): MemoryEvent;
	/** Ingest a system-level event or meta-note. */
	ingestSystemEvent(text: string, turnId: number): MemoryEvent;
}

/**
 * Create a new ingestion pipeline bound to a specific session.
 *
 * @example
 * ```ts
 * const pipeline = createIngestionPipeline({
 *   baseDir: join(homedir(), ".openclaw", "engram"),
 *   sessionKey: "agent-abc123",
 * });
 * pipeline.ingestUserMessage("Hello!", 1);
 * ```
 */
export function createIngestionPipeline(config: IngestionPipelineConfig): IngestionPipeline {
	const {
		baseDir,
		sessionKey,
		artifactThresholdBytes = DEFAULT_ARTIFACT_THRESHOLD_BYTES,
	} = config;

	const eventStore = createEventStore({ baseDir, sessionKey });
	const artifactStore = createArtifactStore({ baseDir });

	/** Append one event, filling in tokens + importance. */
	function append(
		kind: EventKind,
		content: string,
		turnId: number,
		extraMetadata: Record<string, unknown> = {},
	): MemoryEvent {
		return eventStore.append({
			turnId,
			sessionKey,
			kind,
			content,
			tokens: estimateTokens(content),
			metadata: {
				importance: importanceFor(kind),
				...extraMetadata,
			},
		});
	}

	return {
		ingestUserMessage(text, turnId) {
			return append("user_message", text, turnId);
		},

		ingestAssistantMessage(text, turnId) {
			return append("agent_message", text, turnId);
		},

		ingestToolCall(name, args, turnId) {
			const content = JSON.stringify({ tool: name, args });
			return append("tool_call", content, turnId);
		},

		ingestToolResult(name, output, turnId) {
			if (output.length > artifactThresholdBytes) {
				// Externalise to artifact store; store a reference event.
				const artifact = artifactStore.store(output, "text");
				const refContent = JSON.stringify({
					tool: name,
					artifactId: artifact.artifactId,
					preview: artifact.preview,
					totalSize: artifact.totalSize,
				});
				return append("artifact_reference", refContent, turnId, {
					artifactId: artifact.artifactId,
				});
			}
			const content = JSON.stringify({ tool: name, output });
			return append("tool_result", content, turnId);
		},

		ingestSystemEvent(text, turnId) {
			return append("system_event", text, turnId);
		},
	};
}
