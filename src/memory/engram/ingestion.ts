/**
 * ENGRAM Phase 1.1: Event ingestion pipeline.
 *
 * Thin integration layer that maps conversation events (user messages,
 * assistant replies, tool calls/results, system events) into ENGRAM
 * event store entries, with automatic artifact externalization for large
 * tool outputs (>1 KB by default).
 */

import { createArtifactStore } from "./artifact-store.js";
import { createEventStore, estimateTokens } from "./event-store.js";
import type { EventKind, MemoryEvent } from "./event-types.js";
import { createAlwaysAddReconciler, type MemoryReconciler } from "./reconciliation.js";

/**
 * Minimal structural interface for conversation messages that can be bulk-ingested.
 * Compatible with `AgentMessage` from @mariozechner/pi-agent-core without importing it.
 */
export interface IngestableMessage {
  /** Message role discriminator. */
  role: string;
  /** Content — string, array of blocks, or unknown for custom message types. */
  content?: unknown;
  /** Present on toolResult messages. */
  toolName?: string;
  /** Present on toolResult messages. */
  isError?: boolean;
}

/** Extract plain text from a message content field. */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .filter((c) => c["type"] === "text")
    .map((c) => (typeof c["text"] === "string" ? c["text"] : ""))
    .join("");
}

/** Extract ToolCall-shaped blocks from an assistant message content array. */
function extractToolCalls(
  content: unknown,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(
      (c): c is Record<string, unknown> =>
        c !== null && typeof c === "object" && c["type"] === "toolCall",
    )
    .map((c) => ({
      name: typeof c["name"] === "string" ? c["name"] : "unknown",
      arguments:
        c["arguments"] !== null && typeof c["arguments"] === "object"
          ? (c["arguments"] as Record<string, unknown>)
          : {},
    }));
}

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
  /**
   * Optional Mem0-style write reconciler (Upgrade 8). Consulted on the hot path
   * via `decideSync`, which MUST return only ADD or NONE. A NONE decision skips
   * the event entirely (not persisted). An ADD decision may carry an `importance`
   * override that replaces the static IMPORTANCE_BY_KIND value.
   *
   * BACK-COMPAT GATING: when no reconciler is supplied, the field defaults to
   * `createAlwaysAddReconciler()` (every event ADDed). The reconciler is only
   * *consulted* on the hot path when EITHER an explicit reconciler was passed OR
   * the `ENGRAM_RECONCILE` env flag is "true" (the active path). With neither,
   * the decision call is skipped entirely → byte-identical to pre-reconciliation
   * behavior.
   */
  reconciler?: MemoryReconciler;
}

export interface IngestionPipeline {
  /** Access the underlying event store (for pointer compaction). */
  readonly eventStore: import("./event-store.js").EventStore;
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
  /**
   * Bulk-ingest a full conversation snapshot (e.g. `messagesSnapshot` from attempt.ts).
   * Uses an internal cursor so repeated calls on a growing snapshot only process new messages.
   * Fire-and-forget safe: returns a resolved Promise once all new events are persisted.
   */
  ingest(messages: readonly IngestableMessage[]): Promise<void>;
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
  const { baseDir, sessionKey, artifactThresholdBytes = DEFAULT_ARTIFACT_THRESHOLD_BYTES } = config;

  // Default to the always-ADD reconciler so the field is never undefined
  // (Upgrade 8 back-compat default). The hot path only CONSULTS it when an
  // explicit reconciler was injected OR ENGRAM_RECONCILE is on — otherwise the
  // decision call is skipped and behavior is byte-identical to before.
  const reconciler = config.reconciler ?? createAlwaysAddReconciler();
  const reconcileActive = config.reconciler != null || process.env.ENGRAM_RECONCILE === "true";

  const eventStore = createEventStore({ baseDir, sessionKey });
  const artifactStore = createArtifactStore({ baseDir });

  /** Tracks ingestion position so repeated calls on a growing snapshot don't re-process old messages. */
  let ingestedCount = 0;
  let turnCounter = 0;

  function append(
    kind: EventKind,
    content: string,
    turnId: number,
    extraMetadata: Record<string, unknown> = {},
  ): MemoryEvent {
    const draft: Omit<MemoryEvent, "id" | "timestamp"> = {
      turnId,
      sessionKey,
      kind,
      content,
      tokens: estimateTokens(content),
      metadata: {
        importance: importanceFor(kind),
        ...extraMetadata,
      },
    };

    if (reconcileActive) {
      // Hot path: decideSync MUST return only ADD or NONE (enforced by the
      // reconciler implementations). NONE → skip persistence entirely.
      const decision = reconciler.decideSync(
        // The id/timestamp are not yet assigned; the hot-path decision does not
        // depend on them. A stable placeholder keeps the type satisfied.
        { id: "", timestamp: "", ...draft },
        {
          totalMemoryBytes: 0,
          eventCount: eventStore.count(),
          memoryMdLineCount: 0,
          phase: "ingest",
        },
      );
      if (decision.action === "NONE") {
        // Not persisted; return a synthetic (un-stored) event so callers that
        // inspect the return value still get a shaped object.
        return { id: "", timestamp: new Date().toISOString(), ...draft };
      }
      if (decision.importance != null) {
        draft.metadata = { ...draft.metadata, importance: decision.importance };
      }
    }

    return eventStore.append(draft);
  }

  return {
    eventStore,

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

    ingest(messages) {
      // Process only messages beyond the cursor to avoid duplicate events on
      // repeated calls with a growing snapshot (common in attempt.ts retry loops).
      const newMessages = messages.slice(ingestedCount);

      for (const msg of newMessages) {
        if (msg.role === "user") {
          turnCounter++;
          const text = extractText(msg.content);
          if (text) {
            this.ingestUserMessage(text, turnCounter);
          }
        } else if (msg.role === "assistant") {
          const text = extractText(msg.content);
          if (text) {
            this.ingestAssistantMessage(text, turnCounter);
          }
          // Also ingest any tool calls embedded in the assistant message.
          for (const tc of extractToolCalls(msg.content)) {
            this.ingestToolCall(tc.name, tc.arguments, turnCounter);
          }
        } else if (msg.role === "toolResult") {
          const output = extractText(msg.content);
          const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
          this.ingestToolResult(toolName, output, turnCounter);
        }
        // Custom message types (role not matching above) are silently skipped.
        ingestedCount++;
      }

      return Promise.resolve();
    },
  };
}
