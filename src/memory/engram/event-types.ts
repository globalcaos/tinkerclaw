/**
 * ENGRAM Phase 1A: Event type definitions.
 * Exact interfaces from the implementation plan.
 */

export type EventKind =
	| "user_message"
	| "agent_message"
	| "tool_call"
	| "tool_result"
	| "system_event"
	| "compaction_marker"
	| "artifact_reference"
	| "persona_state"
	| "probe_result"
	| "humor_attempt"
	| "humor_association"
	| "debate_synthesis"
	| "debate_trace";

export interface EventMetadata {
	taskId?: string;
	premiseRef?: string;
	supersededBy?: string;
	tags?: string[];
	artifactId?: string;
	embeddingStatus?: "pending" | "complete" | "failed";
	/** Importance score: 1–10. Higher = more valuable for recall (default 5). */
	importance?: number;
}

export interface MemoryEvent {
	id: string;
	timestamp: string;
	turnId: number;
	sessionKey: string;
	kind: EventKind;
	content: string;
	tokens: number;
	metadata: EventMetadata;
}

export interface ArtifactPreview {
	artifactId: string;
	contentType: "log" | "json" | "csv" | "search" | "text";
	preview: string;
	totalSize: number;
	lineCount: number;
}

/**
 * Non-evictable event kinds — compaction must never target these.
 */
export const NON_EVICTABLE_KINDS: ReadonlySet<EventKind> = new Set([
	"compaction_marker",
	"persona_state",
	"system_event",
]);
