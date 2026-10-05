import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { SkillSnapshot } from "../../../agents/skills.js";
import type { SilentReplyPromptMode } from "../../../agents/system-prompt.types.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { SourceReplyDeliveryMode } from "../../get-reply-options.types.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../directives.js";

export type QueueMode = "steer" | "followup" | "collect" | "steer-backlog" | "interrupt" | "queue";

export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type QueueDedupeMode = "message-id" | "prompt" | "none";

export type FollowupRun = {
  prompt: string;
  /** User-visible prompt body persisted to transcript; excludes runtime-only prompt context. */
  transcriptPrompt?: string;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  /**
   * FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 / §7 G3) — EVERY prompt key this
   * run answers when it answers more than the one in `messageId`, in arrival order. PQ-1's one
   * identity: for webchat each key is a client's chat.send idempotencyKey. Set by the producers that
   * merge several prompts into one run: collect mode's batch (queue/drain.ts) and a lost steer
   * delivery re-enqueued with every buffered caller's key (agent-runner.ts `onDeliveryLost`).
   * Absent on an ordinary run, whose one key is `messageId`. Read it through
   * resolveFollowupRunPromptKeys, never directly: that is the one place `messageId` is folded in.
   * Not a dedupe key: enqueue.ts keeps deduplicating on `messageId`.
   */
  promptKeys?: string[];
  summaryLine?: string;
  enqueuedAt: number;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder?: PromptImageOrderEntry[];
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string;
  /** Provider account id (multi-account). */
  originatingAccountId?: string;
  /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number;
  /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: {
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    runtimePolicySessionKey?: string;
    messageProvider?: string;
    agentAccountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner?: boolean;
    traceAuthorized?: boolean;
    sessionFile: string;
    workspaceDir: string;
    config: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    hasSessionModelOverride?: boolean;
    modelOverrideSource?: "auto" | "user";
    /**
     * THALAMUS's per-turn recovery ladder (`ThalamusAutoRoute.chain`) — ordered `provider/model`
     * keys, one per OTHER supply. Carried on the run because the router decides it during model
     * selection while `resolveModelFallbackOptions` needs it at execution time. PERSISTED
     * NOWHERE, for the same reason the route itself is not: a written ladder would outlive the
     * dial move that produced it and would later be indistinguishable from configuration.
     */
    thalamusChain?: readonly string[];
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    thinkLevel?: ThinkLevel;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    inputProvenance?: InputProvenance;
    extraSystemPrompt?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    silentReplyPromptMode?: SilentReplyPromptMode;
    extraSystemPromptStatic?: string;
    enforceFinalTag?: boolean;
    skipProviderRuntimeHints?: boolean;
    silentExpected?: boolean;
    allowEmptyAssistantReplyAsSilent?: boolean;
  };
};

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
  pluginDebounceMs?: number;
};

/**
 * FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 / §7 G3 and G5) — the prompt keys a
 * FollowupRun answers: its `promptKeys` in order, then its `messageId` when not already listed; each
 * trimmed, with empties and repeats dropped (the first occurrence wins). ONE definition for every
 * producer and reader, so the client sees the same key set from each: queue/drain.ts (a batch's
 * keys), agent-runner.ts (a lost steer's keys, a turn's reply operation), followup-runner.ts (the
 * `followup` start event, the reply operation) and gateway/session-utils.ts (BEHIND). It lives beside
 * the type because this module has no runtime imports, which keeps it cheap for the gateway to load.
 */
export function resolveFollowupRunPromptKeys(
  run: Pick<FollowupRun, "messageId" | "promptKeys">,
): string[] {
  const keys: string[] = [];
  for (const raw of [...(run.promptKeys ?? []), run.messageId]) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}
