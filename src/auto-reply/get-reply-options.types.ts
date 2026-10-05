import type { ImageContent } from "@mariozechner/pi-ai";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import type { ReplyPayload } from "./reply-payload.js";
import type { TypingController } from "./reply/typing.js";

export type BlockReplyContext = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Source assistant message index from the upstream stream, when available. */
  assistantMessageIndex?: number;
};

/** Context passed to onModelSelected callback with actual model used. */
export type ModelSelectedContext = {
  provider: string;
  model: string;
  thinkLevel: string | undefined;
};

export type TypingPolicy =
  | "auto"
  | "user_message"
  | "system_event"
  | "internal_webchat"
  | "heartbeat";

export type ReplyThreadingPolicy = {
  /** Override implicit reply-to-current behavior for the current turn. */
  implicitCurrentMessage?: "default" | "allow" | "deny";
};

export type SourceReplyDeliveryMode = "automatic" | "message_tool_only";

/**
 * FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 wire contract + §7 step G2,
 * principle PQ-8 "DISPOSITION IS REPORTED, NOT GUESSED"): what the gateway did with an accepted
 * prompt when a turn was already running.
 *
 * - "steered"    the running turn ACCEPTED the text for delivery (queueEmbeddedPiMessage true).
 * - "backlogged" a follow-up turn was really queued behind the running turn (enqueue returned true).
 * - "dropped"    the queue policy refused the turn outright.
 *
 * WIRE MIRROR: these three literals are re-declared as a TypeBox union on `ChatEventSchema` in
 * src/gateway/protocol/schema/logs-chat.ts. That object is `additionalProperties: false`, so the
 * two lists MUST stay identical — change one and change the other in the SAME commit.
 */
export type PromptDisposition = "steered" | "backlogged" | "dropped";

export type GetReplyOptions = {
  /** Override run id for agent events (defaults to random UUID). */
  runId?: string;
  /** Abort signal for the underlying agent run. */
  abortSignal?: AbortSignal;
  /** Optional inbound images (used for webchat attachments). */
  images?: ImageContent[];
  /** Original inline/offloaded attachment order for inbound images. */
  imageOrder?: PromptImageOrderEntry[];
  /** Notifies when an agent run actually starts (useful for webchat command handling). */
  onAgentRunStart?: (runId: string) => void;
  onReplyStart?: () => Promise<void> | void;
  /** Called when the typing controller cleans up (e.g., run ended with NO_REPLY). */
  onTypingCleanup?: () => void;
  onTypingController?: (typing: TypingController) => void;
  isHeartbeat?: boolean;
  /**
   * FORK (2026-07-27): the heartbeat run carries an actionable cron payload, so the
   * transcript body must be the real prompt instead of HEARTBEAT_TRANSCRIPT_PROMPT.
   * Otherwise `resolveRuntimeContextPromptParts` demotes the whole cron instruction
   * into runtime SYSTEM context ("runtime-generated, not user-authored") and the
   * model sees a bare "[OpenClaw heartbeat poll]" as its turn — so it acks and
   * no-ops. See reference_cron_main_session_wake_key_bug.
   */
  heartbeatCarriesCronPayload?: boolean;
  /** Policy-level typing control for run classes (user/system/internal/heartbeat). */
  typingPolicy?: TypingPolicy;
  /** Force-disable typing indicators for this run (system/internal/cross-channel routes). */
  suppressTyping?: boolean;
  /** Resolved heartbeat model override (provider/model string from merged per-agent config). */
  heartbeatModelOverride?: string;
  /** Controls bootstrap workspace context injection (default: full). */
  bootstrapContextMode?: "full" | "lightweight";
  /** If true, suppress tool error warning payloads for this run. */
  suppressToolErrorWarnings?: boolean;
  /**
   * If true, dispatch skips default tool/progress text messages and expects the
   * channel to surface progress via its own streaming/edit UX.
   */
  suppressDefaultToolProgressMessages?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when a thinking/reasoning block ends. */
  onReasoningEnd?: () => Promise<void> | void;
  /** Called when a new assistant message starts (e.g., after tool call or thinking block). */
  onAssistantMessageStart?: () => Promise<void> | void;
  /** Called synchronously when a block reply is logically emitted, before async
   * delivery drains. Useful for channels that need to rotate preview state at
   * block boundaries without waiting for transport acks. */
  onBlockReplyQueued?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when a tool phase starts/updates, before summary payloads are emitted. */
  onToolStart?: (payload: { name?: string; phase?: string }) => Promise<void> | void;
  /** Called when a concrete work item starts, updates, or completes. */
  onItemEvent?: (payload: {
    itemId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    approvalId?: string;
    approvalSlug?: string;
  }) => Promise<void> | void;
  /** Called when the agent emits a structured plan update. */
  onPlanUpdate?: (payload: {
    phase?: string;
    title?: string;
    explanation?: string;
    steps?: string[];
    source?: string;
  }) => Promise<void> | void;
  /** Called when an approval becomes pending or resolves. */
  onApprovalEvent?: (payload: {
    phase?: string;
    kind?: string;
    status?: string;
    title?: string;
    itemId?: string;
    toolCallId?: string;
    approvalId?: string;
    approvalSlug?: string;
    command?: string;
    host?: string;
    reason?: string;
    scope?: "turn" | "session";
    message?: string;
  }) => Promise<void> | void;
  /** Called when command output streams or completes. */
  onCommandOutput?: (payload: {
    itemId?: string;
    phase?: string;
    title?: string;
    toolCallId?: string;
    name?: string;
    output?: string;
    status?: string;
    exitCode?: number | null;
    durationMs?: number;
    cwd?: string;
  }) => Promise<void> | void;
  /** Called when a patch completes with a file summary. */
  onPatchSummary?: (payload: {
    itemId?: string;
    phase?: string;
    title?: string;
    toolCallId?: string;
    name?: string;
    added?: string[];
    modified?: string[];
    deleted?: string[];
    summary?: string;
  }) => Promise<void> | void;
  /** Called when context auto-compaction starts (allows UX feedback during the pause). */
  onCompactionStart?: () => Promise<void> | void;
  /** Called when context auto-compaction completes. */
  onCompactionEnd?: () => Promise<void> | void;
  /** Called when the actual model is selected (including after fallback).
   * Use this to get model/provider/thinkLevel for responsePrefix template interpolation. */
  onModelSelected?: (ctx: ModelSelectedContext) => void;
  /**
   * Controls whether normal assistant replies are automatically delivered to
   * the source conversation. `message_tool_only` keeps final/block/preview
   * output private; visible channel output must come from the message tool.
   */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  disableBlockStreaming?: boolean;
  /** Timeout for block reply delivery (ms). */
  blockReplyTimeoutMs?: number;
  /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[];
  /** Mutable ref to track if a reply was sent (for Slack "first" threading mode). */
  hasRepliedRef?: { value: boolean };
  /** Override agent timeout in seconds (0 = no timeout). Threads through to resolveAgentTimeoutMs. */
  timeoutOverrideSeconds?: number;
  /**
   * FORK 2026-09-24 (prompt-queue.md §7 step G2): called by the agent-runner queue branches when a
   * prompt did NOT start its own run, so the caller can REPORT the placement instead of letting the
   * client guess it (PQ-8). Never called for a prompt that runs now — absence is the "run now, or an
   * old gateway" case, and callers must keep their pre-G2 behaviour for it.
   *
   * May be called MORE THAN ONCE for one prompt: "steered" when the running turn accepts the text,
   * then "backlogged" if that delivery is later lost (the §2 STEERED → BEHIND edge). Reports are
   * best-effort and unordered with respect to the caller's own completion — the second one fires
   * from a debounce timer inside the steer buffer and may arrive after the caller has already
   * published the first. Treat this as a placement HINT, never as a terminal.
   *
   * `runPreparedReply` forwards the whole options object into `runReplyAgent`, so this threads
   * through unchanged; any future `Omit<GetReplyOptions, ...>` in the dispatch chain must NOT drop
   * it or the report dies silently.
   */
  onPromptDisposition?: (disposition: PromptDisposition) => void;
};
