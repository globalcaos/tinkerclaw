import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { ContextEngine, ContextEnginePromptCacheInfo } from "../../../context-engine/types.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { PluginHookBeforeAgentStartResult } from "../../../plugins/hook-before-agent-start.types.js";
import type { ContextAnatomyEvent } from "../../context-anatomy.js";
import type { MessagingToolSend } from "../../embedded-agent-messaging.types.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import type { NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunReplayMetadata, EmbeddedRunReplayState } from "../replay-state.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

/**
 * FORK 2026-10-09 (effort slider) — WHO chose a turn's thinking level. Decided once, in reply
 * resolution (auto-reply/reply/get-reply-directives.ts), and carried beside the level to the
 * attempt's `__openclawThinkSource` smuggle key, so the tinker-bridge can apply a human's pin as a
 * pin and an Auto decision as Auto:
 * - "pin": a human chose it: a `/think` typed this turn, a level the client pinned for this turn
 *   (chat.send `thinking`), or a level stored on the session.
 * - "thalamus": the router's rung named the effort (ThalamusAutoRoute.effort).
 * - "allocator": chooseAutoEffort picked it because neither of the above decided.
 * - "default": the model's default thinking level or `thinkingDefault`.
 * Absent anywhere along the way reads as "default", never as a pin.
 */
export type ThinkSource = "pin" | "thalamus" | "allocator" | "default";

type EmbeddedRunAttemptBase = Omit<
  RunEmbeddedPiAgentParams,
  "provider" | "model" | "authProfileIdSource" | "thinkLevel" | "lane" | "enqueue"
>;

export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  initialReplayState?: EmbeddedRunReplayState;
  /** Pluggable context engine for ingest/assemble/compact lifecycle. */
  contextEngine?: ContextEngine;
  /** Resolved model context window in tokens for assemble/compact budgeting. */
  contextTokenBudget?: number;
  /** Resolved API key for this run when runtime auth did not replace it. */
  resolvedApiKey?: string;
  /** Auth profile resolved for this attempt's provider/model call. */
  authProfileId?: string;
  /** Source for the resolved auth profile (user-locked or automatic). */
  authProfileIdSource?: "auto" | "user";
  provider: string;
  modelId: string;
  /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string;
  /** OpenClaw-owned runtime policy prepared by the orchestrator for this attempt. */
  runtimePlan?: AgentRuntimePlan;
  model: Model<Api>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
  /**
   * FORK 2026-10-09 (effort slider): who chose `thinkLevel`; absent reads as "default". When the
   * run lowers the level for provider support (run.ts thinking fallback) the value changes and
   * the source does not.
   */
  thinkSource?: ThinkSource;
  /** FORK 2026-10-09: Thalamus called ultracode for this turn (only with thinkSource "thalamus"). */
  ultracode?: boolean;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
  /** Optional tool allow-list; when set, only these tools are sent to the model. */
  toolsAllow?: string[];
  /** Optional per-run output token budget, read by attempt.ts. */
  maxTokens?: number;
  /** Optional per-run tool-call budget, read by attempt.ts. */
  maxToolCalls?: number;
};

export type EmbeddedRunAttemptResult = {
  aborted: boolean;
  /** True when the abort originated from the caller-provided abortSignal. */
  externalAbort: boolean;
  timedOut: boolean;
  /** True when the no-response LLM idle watchdog caused the timeout. */
  idleTimedOut: boolean;
  /** True if the timeout occurred while compaction was in progress or pending. */
  timedOutDuringCompaction: boolean;
  promptError: unknown;
  /**
   * Identifies which phase produced the promptError.
   * - "prompt": the LLM call itself failed and may be eligible for retry/fallback.
   * - "compaction": the prompt succeeded, but waiting for compaction/retry teardown was aborted;
   *   this must not be retried as a fresh prompt or the same tool turn can replay.
   * - "precheck": pre-prompt overflow recovery intentionally short-circuited the prompt so the
   *   outer run loop can recover via compaction/truncation before any model call is made.
   * - null: no promptError.
   */
  promptErrorSource: "prompt" | "compaction" | "precheck" | null;
  preflightRecovery?:
    | {
        route: Exclude<PreemptiveCompactionRoute, "fits">;
        handled: true;
        truncatedCount?: number;
      }
    | {
        route: Exclude<PreemptiveCompactionRoute, "fits">;
        handled?: false;
      };
  sessionIdUsed: string;
  sessionFileUsed?: string;
  diagnosticTrace?: DiagnosticTraceContext;
  agentHarnessId?: string;
  agentHarnessResultClassification?: "empty" | "reasoning-only" | "planning-only";
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  systemPromptReport?: SessionSystemPromptReport;
  finalPromptText?: string;
  messagesSnapshot: AgentMessage[];
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  lastAssistant: AssistantMessage | undefined;
  currentAttemptAssistant?: AssistantMessage | undefined;
  lastToolError?: ToolErrorSummary;
  didSendViaMessagingTool: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;
  promptCache?: ContextEnginePromptCacheInfo;
  compactionCount?: number;
  compactionTokensAfter?: number;
  /** Client tool call detected (OpenResponses hosted tools). */
  clientToolCall?: { name: string; params: Record<string, unknown> };
  /** Per-turn context anatomy — decomposition of what was sent to the model. */
  contextAnatomy?: ContextAnatomyEvent;
  /** True when sessions_yield tool was called during this attempt. */
  yieldDetected?: boolean;
  replayMetadata: EmbeddedRunReplayMetadata;
  itemLifecycle: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
  setTerminalLifecycleMeta?: (meta: {
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    stopReason?: string;
    yielded?: boolean;
  }) => void;
};
