import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { logCompactionDecision } from "../../compaction-diagnostics.js";
import { SAFETY_MARGIN, estimateMessagesTokens } from "../../compaction.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../pi-compaction-constants.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

export type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

function charsToTokens(chars: number | undefined): number {
  if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN);
}

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  /**
   * Size of the system prompt for callers that only hold a char count (e.g. a
   * persisted SessionSystemPromptReport) and cannot materialize the text.
   * Ignored when `systemPrompt` is a non-blank string.
   */
  systemPromptChars?: number;
  /**
   * Size of the serialized tool schemas shipped with every request. pi's
   * estimateTokens() only walks messages, so these were never counted at all.
   */
  toolSchemaChars?: number;
  prompt: string;
}): number {
  const { messages, systemPrompt, prompt } = params;
  // BUG FIX 2026-07-27: the system prompt used to be wrapped in a synthetic
  // `{role:"system"}` AgentMessage and handed to pi's estimateTokens(). That
  // function switches on `message.role`, has NO `system` case, and falls through
  // to `return 0` — so a 55k-61k char (~15k token) system prompt scored as ZERO
  // and this gate under-read the real prompt by ~200x. Count it here by chars.
  // `role:"user"` IS handled by pi at the same chars/4 rate, so the user prompt
  // deliberately still goes through estimateTokens().
  const systemPromptTokens =
    typeof systemPrompt === "string" && systemPrompt.trim().length > 0
      ? Math.ceil(systemPrompt.length / ESTIMATED_CHARS_PER_TOKEN)
      : charsToTokens(params.systemPromptChars);
  const toolSchemaTokens = charsToTokens(params.toolSchemaChars);

  const estimated =
    estimateMessagesTokens(messages) +
    systemPromptTokens +
    toolSchemaTokens +
    estimateTokens({ role: "user", content: prompt, timestamp: 0 } as AgentMessage);
  return Math.max(0, Math.ceil(estimated * SAFETY_MARGIN));
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  /** Char count of the system prompt, for callers that cannot pass the text. */
  systemPromptChars?: number;
  /** Char count of the serialized tool schemas shipped with the request. */
  toolSchemaChars?: number;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
} {
  let messagesForPressure = params.messages;
  let estimatedPromptTokens = estimatePrePromptTokens({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    systemPromptChars: params.systemPromptChars,
    toolSchemaChars: params.toolSchemaChars,
    prompt: params.prompt,
  });
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedEstimatedPromptTokens = estimatePrePromptTokens({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      systemPromptChars: params.systemPromptChars,
      toolSchemaChars: params.toolSchemaChars,
      prompt: params.prompt,
    });
    if (unwindowedEstimatedPromptTokens > estimatedPromptTokens) {
      estimatedPromptTokens = unwindowedEstimatedPromptTokens;
      messagesForPressure = params.unwindowedMessages;
    }
  }
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: messagesForPressure,
    contextWindowTokens: params.contextTokenBudget,
    maxCharsOverride: params.toolResultMaxChars,
  });
  const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0) {
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  }
  // FORK 2026-07-27 (the architect: "instrument the compaction predicate") — this decider uses a
  // char estimate over the REAL messages PLUS the system prompt and the tool schemas, so
  // unlike the memory-flush gate it should track live context. Logging it is how we tell
  // the two apart on a live turn: if THIS one fires at ~5% of the window the estimator is
  // wrong; if it fires at ~95% it is working and the early compactions are coming from one
  // of the other two gates. `source=` names which inputs the CALLER actually supplied: a
  // `-systemPrompt` reading means that call site is still under-counting by roughly the
  // size of the system prompt (~15k tokens), not that the estimator itself is broken.
  const countedSystemPrompt =
    (typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0) ||
    charsToTokens(params.systemPromptChars) > 0;
  const countedToolSchemas = charsToTokens(params.toolSchemaChars) > 0;
  const estimateSource = `estimatePrePromptTokens(messages+prompt${
    countedSystemPrompt ? "+systemPrompt" : "-systemPrompt"
  }${countedToolSchemas ? "+toolSchemas" : "-toolSchemas"})`;
  logCompactionDecision({
    gate: "preemptive",
    tokens: estimatedPromptTokens,
    threshold: promptBudgetBeforeReserve,
    contextWindow: contextTokenBudget,
    source: estimateSource,
    fires: route === "compact_only" || route === "compact_then_truncate",
  });

  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}
