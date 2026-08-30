import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { logCompactionDecision } from "../compaction-diagnostics.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateMessageWeightedCharsCached,
  estimateRawContextChars,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";
export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Context overflow: estimated context size exceeds safe threshold during tool loop.";
const TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO = 4 / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

export function formatContextLimitTruncationNotice(truncatedChars: number): string {
  return `[... ${Math.max(1, Math.floor(truncatedChars))} ${CONTEXT_LIMIT_TRUNCATION_NOTICE}]`;
}

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return formatContextLimitTruncationNotice(text.length);
  }

  let bodyBudget = maxChars;
  for (let i = 0; i < 4; i += 1) {
    const estimatedSuffix = formatContextLimitTruncationNotice(
      Math.max(1, text.length - bodyBudget),
    );
    bodyBudget = Math.max(0, maxChars - estimatedSuffix.length);
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", cutPoint);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  const omittedChars = text.length - cutPoint;
  return text.slice(0, cutPoint) + formatContextLimitTruncationNotice(omittedChars);
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function estimateBudgetToTextBudget(maxChars: number): number {
  return Math.max(0, Math.floor(maxChars / TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO));
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  // Single-tool-result budget stays on the conservative weighted estimate.
  const estimatedChars = estimateMessageWeightedCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    const omittedChars = Math.max(
      1,
      estimateBudgetToTextBudget(Math.max(estimatedChars - maxChars, 1)),
    );
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(omittedChars));
  }

  const textBudget = estimateBudgetToTextBudget(maxChars);
  if (textBudget <= 0) {
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(rawText.length));
  }

  if (rawText.length <= textBudget) {
    return replaceToolResultText(msg, rawText);
  }

  const truncatedText = truncateTextToBudget(rawText, textBudget);
  return replaceToolResultText(msg, truncatedText);
}

function cloneMessagesForGuard(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(
    (msg) => ({ ...(msg as unknown as Record<string, unknown>) }) as unknown as AgentMessage,
  );
}

function toolResultsNeedTruncation(params: {
  messages: AgentMessage[];
  maxSingleToolResultChars: number;
}): boolean {
  const { messages, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    if (estimateMessageWeightedCharsCached(message, estimateCache) > maxSingleToolResultChars) {
      return true;
    }
  }
  return false;
}

/**
 * Raw on-the-wire char total for the whole transformed context. Same 4-chars/token
 * convention as `maxContextChars`, so the comparison against it is honest: it trips
 * near ~90% of the model window rather than at roughly half of it.
 */
function estimateGuardContextChars(messages: AgentMessage[]): number {
  return estimateRawContextChars(messages, createMessageCharEstimateCache());
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function enforceToolResultLimitInPlace(params: {
  messages: AgentMessage[];
  maxSingleToolResultChars: number;
}): void {
  const { messages, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();

  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }
}

/**
 * Per-iteration `afterTurn` + `assemble` wrapper for sessions where
 * the context engine owns compaction. Lets the engine compact inside
 * a long tool loop instead of only at end of attempt.
 */
export function installContextEngineLoopHook(params: {
  agent: GuardableAgent;
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  tokenBudget?: number;
  modelId: string;
  getPrePromptMessageCount?: () => number;
  getRuntimeContext?: (params: {
    messages: AgentMessage[];
    prePromptMessageCount: number;
  }) => ContextEngineRuntimeContext | undefined;
}): () => void {
  const { contextEngine, sessionId, sessionKey, sessionFile, tokenBudget, modelId } = params;
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;
  let lastAssembledView: AgentMessage[] | null = null;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;

    // Seed the loop fence from the attempt's pre-prompt message count when available.
    // This keeps the first real post-tool-call iteration eligible for compaction even
    // if the hook's first observed call happens after tool results were appended.
    const prePromptMessageCount = Math.max(
      0,
      Math.min(
        sourceMessages.length,
        lastSeenLength ?? params.getPrePromptMessageCount?.() ?? sourceMessages.length,
      ),
    );
    lastSeenLength = prePromptMessageCount;

    const hasNewMessages = sourceMessages.length > prePromptMessageCount;
    if (!hasNewMessages) {
      return lastAssembledView ?? sourceMessages;
    }

    try {
      if (typeof contextEngine.afterTurn === "function") {
        await contextEngine.afterTurn({
          sessionId,
          sessionKey,
          sessionFile,
          messages: sourceMessages,
          prePromptMessageCount,
          tokenBudget,
          runtimeContext: params.getRuntimeContext?.({
            messages: sourceMessages,
            prePromptMessageCount,
          }),
        });
      } else {
        const newMessages = sourceMessages.slice(prePromptMessageCount);
        if (newMessages.length > 0) {
          if (typeof contextEngine.ingestBatch === "function") {
            await contextEngine.ingestBatch({
              sessionId,
              sessionKey,
              messages: newMessages,
            });
          } else {
            for (const message of newMessages) {
              await contextEngine.ingest({
                sessionId,
                sessionKey,
                message,
              });
            }
          }
        }
      }
      lastSeenLength = sourceMessages.length;
      const assembled = await contextEngine.assemble({
        sessionId,
        sessionKey,
        messages: sourceMessages,
        tokenBudget,
        model: modelId,
      });
      if (assembled && Array.isArray(assembled.messages) && assembled.messages !== sourceMessages) {
        lastAssembledView = assembled.messages;
        return assembled.messages;
      }
      lastAssembledView = null;
    } catch {
      // Best-effort: any engine failure falls through to the raw source
      // messages so the tool loop still makes forward progress.
    }

    return sourceMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const maxContextChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * PREEMPTIVE_OVERFLOW_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  // Agent.transformContext is private in pi-coding-agent, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const contextMessages = toolResultsNeedTruncation({
      messages: sourceMessages,
      maxSingleToolResultChars,
    })
      ? cloneMessagesForGuard(sourceMessages)
      : sourceMessages;
    if (contextMessages !== sourceMessages) {
      enforceToolResultLimitInPlace({
        messages: contextMessages,
        maxSingleToolResultChars,
      });
    }
    const estimatedContextChars = estimateGuardContextChars(contextMessages);
    if (estimatedContextChars > maxContextChars) {
      // FORK 2026-07-27 (the architect: "instrument the compaction predicate") — this guard is the
      // one observed throwing live: every [context-overflow-diag] line carries this exact
      // message, and all of them land on small-window models (grok/codex), because
      // maxContextChars is linear in the window.
      // The estimate used to count toolResult.details — STRIPPED before send by
      // normalizeMessagesForLlmBoundary — and then weighted tool results at 2 chars/token
      // against a 4-chars/token budget, so the nominal 0.9 ratio actually tripped at
      // roughly half of the real window. It is now the raw on-the-wire char count under
      // one uniform 4-chars/token convention. The pessimistic 2-chars/token weighting and
      // the details charge survive only in maxSingleToolResultChars, where being
      // conservative about ONE oversized tool result is the intent.
      logCompactionDecision({
        gate: "tool-loop-guard",
        tokens: Math.round(estimatedContextChars / CHARS_PER_TOKEN_ESTIMATE),
        threshold: Math.round(maxContextChars / CHARS_PER_TOKEN_ESTIMATE),
        contextWindow: contextWindowTokens,
        source: "raw chars/token over transformed messages (details excluded, unweighted)",
        fires: true,
      });
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
