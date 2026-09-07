/**
 * Context Anatomy — Per-turn prompt decomposition.
 *
 * Records what goes into every LLM call: system prompt, workspace files,
 * skills, tool schemas, conversation history, tool results, and user message.
 * Each record is tagged with a compaction cycle counter and context utilization.
 *
 * Events are returned on the attempt result for real-time consumption.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
// FORK 2026-07-28: single owner of "is this a tool result?" — it handles the production
// `"toolResult"` role plus the `"tool"` / `type:"toolResult"` variants. Reusing it is the point:
// this file previously carried its own, differently-wrong role test.
import { isToolResultMessage } from "./embedded-agent-runner/tool-result-char-estimator.js";

const log = createSubsystemLogger("agents/context-anatomy");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextAnatomyFileEntry = {
  name: string;
  chars: number;
  tokens: number;
};

export type ContextAnatomyEvent = {
  /** Monotonically increasing turn number within this session. */
  turn: number;
  /** Round number within this turn (1-based). Each tool-use loop iteration is one round. */
  roundNumber?: number;
  /** How many compactions have occurred in this session so far. */
  compactionCycle: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Epoch millis. */
  timestampMs: number;
  /** Model used for this turn. */
  model: string;
  /** Provider used for this turn. */
  provider: string;
  /** Session key (if available). */
  sessionKey?: string;
  /** Top 3-5 topic keywords extracted from this turn's context. */
  topics: string[];
  /** Topic transition from previous turn (undefined on first turn or no session key). */
  topicTransition?: { from: string[]; to: string[]; changed: boolean };
  /** Breakdown of context sent to the model. */
  contextSent: {
    systemPromptChars: number;
    systemPromptTokens: number;
    injectedFiles: ContextAnatomyFileEntry[];
    injectedFilesTotalChars: number;
    injectedFilesTotalTokens: number;
    skillsChars: number;
    skillsTokens: number;
    toolSchemasChars: number;
    toolSchemasTokens: number;
    conversationHistoryChars: number;
    conversationHistoryTokens: number;
    toolResultsChars: number;
    toolResultsTokens: number;
    userMessageChars: number;
    userMessageTokens: number;
    totalChars: number;
    totalTokens: number;
  };
  /** Context window utilization. */
  contextWindow: {
    maxTokens: number;
    usedTokens: number;
    utilizationPercent: number;
  };
  /** Auth profile used for this turn (e.g. "oauth-sv", "api", "cli-gm"). */
  authProfileId?: string;
  /** Output/response tokens from the model (if available). */
  responseTokens?: number;
  /** Which memory files were injected. */
  memoriesInjected: {
    /** Files injected as workspace bootstrap (MEMORY.md, SOUL.md, etc). */
    autoRecall: string[];
    /** Files retrieved via memory_search tool calls (populated later). */
    searched: string[];
  };

  // --- response breakdown (new) ---
  runId?: string;
  durationMs?: number;
  stopReason?: string;
  toolsTriggered?: Array<{
    name: string;
    toolCallId: string;
    inputChars?: number;
    outputChars?: number;
    durationMs?: number;
    isError?: boolean;
  }>;
  responseThinkingTokens?: number;
  responseTextTokens?: number;
  responseToolCallTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  responseContent?: {
    thinkingChars?: number;
    textChars?: number;
    toolCallChars?: number;
  };
  /** The user message that triggered this LLM turn (text only, max 50K chars). */
  userMessage?: string;
  /** The assistant's response text for this turn (max 50K chars). */
  assistantResponse?: string;
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough chars-to-tokens ratio. Good enough for anatomy — not billing. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

/** Common English stop words to filter during keyword extraction. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "it",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "but",
  "with",
  "from",
  "by",
  "as",
  "be",
  "was",
  "are",
  "were",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "i",
  "me",
  "my",
  "we",
  "you",
  "he",
  "she",
  "they",
  "them",
  "this",
  "that",
  "these",
  "those",
  "what",
  "how",
  "why",
  "when",
  "where",
  "which",
  "who",
  "not",
  "no",
  "so",
  "if",
  "then",
  "up",
  "out",
  "now",
  "also",
  "just",
  "about",
  "into",
  "than",
  "its",
  "your",
  "our",
  "their",
  "there",
  "here",
  "get",
  "got",
  "let",
  "run",
  "want",
  "make",
  "like",
  "know",
  "look",
  "see",
  "use",
  "find",
  "give",
  "think",
  "tell",
  "show",
  "work",
]);

/** Regex to detect file paths (e.g. src/foo/bar.ts, /home/user/file.md). */
const FILE_PATH_REGEX = /(?:^|\s|["'`(])(\/?(?:[\w.-]+\/)+[\w.-]+\.[\w]+)/gm;

/**
 * Extract topic keywords from a messages snapshot.
 *
 * Sources (in order of priority):
 * 1. Last user message: key nouns/verbs via word frequency.
 * 2. Tool calls in assistant messages: tool names used.
 * 3. Tool result messages: file paths mentioned.
 *
 * Returns 3–5 topic keywords.
 */
export function extractTopics(messagesSnapshot: AgentMessage[]): string[] {
  const topics: string[] = [];

  // --- Source 1: keywords from last user message ---
  const lastUserMsg = [...messagesSnapshot]
    .toReversed()
    .find((m) => m.role === "user" && "content" in m);
  if (lastUserMsg && "content" in lastUserMsg) {
    const text =
      typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : JSON.stringify(lastUserMsg.content);
    const wordFreq = new Map<string, number>();
    for (const word of text.toLowerCase().split(/\W+/)) {
      if (word.length >= 4 && !STOP_WORDS.has(word)) {
        wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
    }
    const sorted = [...wordFreq.entries()].toSorted((a, b) => b[1] - a[1]);
    for (const [word] of sorted.slice(0, 3)) {
      topics.push(word);
    }
  }

  // --- Source 2: tool names from assistant messages ---
  for (const msg of messagesSnapshot) {
    if (msg.role !== "assistant" || !("content" in msg)) {
      continue;
    }
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as unknown as Record<string, unknown>;
        if (b && typeof b === "object" && b.type === "tool_use" && typeof b.name === "string") {
          const toolName = b.name as string;
          if (!topics.includes(toolName)) {
            topics.push(toolName);
          }
        }
      }
    }
  }

  // --- Source 3: file paths from tool results ---
  for (const msg of messagesSnapshot) {
    if ((msg.role as string) !== "tool" || !("content" in msg)) {
      continue;
    }
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    for (const match of text.matchAll(FILE_PATH_REGEX)) {
      const filePath = match[1];
      if (filePath && !topics.includes(filePath)) {
        topics.push(filePath);
      }
    }
  }

  return topics.slice(0, 5);
}

/** Per-session topic history used to compute turn-to-turn transitions. */
const sessionTopicsState = new Map<string, string[]>();

/**
 * Compare two topic arrays to determine if the topic has meaningfully changed.
 * "Changed" when fewer than half of the new topics overlap with the previous ones.
 */
function computeTopicTransition(
  from: string[],
  to: string[],
): { from: string[]; to: string[]; changed: boolean } {
  if (from.length === 0 && to.length === 0) {
    return { from, to, changed: false };
  }
  const fromSet = new Set(from);
  const overlap = to.filter((t) => fromSet.has(t)).length;
  const threshold = Math.max(1, Math.floor(Math.min(from.length, to.length) / 2));
  return { from, to, changed: overlap < threshold };
}

// ---------------------------------------------------------------------------
// Build anatomy from attempt data
// ---------------------------------------------------------------------------

export function buildContextAnatomy(params: {
  turn: number;
  roundNumber?: number;
  compactionCycle: number;
  provider: string;
  model: string;
  sessionKey?: string;
  systemPromptReport: SessionSystemPromptReport;
  messagesSnapshot: AgentMessage[];
  contextWindowTokens: number;
  totalTokensUsed?: number;
  outputTokens?: number;
  authProfileId?: string;
}): ContextAnatomyEvent {
  const { systemPromptReport: report } = params;
  const now = Date.now();

  // System prompt (non-project-context = framework instructions, runtime info, etc)
  const systemPromptChars = report.systemPrompt.nonProjectContextChars;

  // Injected workspace files
  const injectedFiles: ContextAnatomyFileEntry[] = report.injectedWorkspaceFiles
    .filter((f) => !f.missing && f.injectedChars > 0)
    .map((f) => ({
      name: f.name,
      chars: f.injectedChars,
      tokens: estimateTokens(f.injectedChars),
    }));
  const injectedFilesTotalChars = injectedFiles.reduce((sum, f) => sum + f.chars, 0);

  // Skills
  const skillsChars = report.skills.promptChars;

  // Tool schemas
  const toolSchemasChars = report.tools.listChars + report.tools.schemaChars;

  // Conversation history and tool results from messages snapshot
  let conversationHistoryChars = 0;
  let toolResultsChars = 0;
  let userMessageChars = 0;
  /** Chars matching no slab. Non-zero means the composition under-reads the real context. */
  let unattributedChars = 0;

  const messages = params.messagesSnapshot;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) {
      continue;
    }
    if (!("content" in msg)) {
      continue;
    }
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const chars = content.length;
    const isLast = i === messages.length - 1;

    // FORK 2026-07-28 — THIS CHAIN SILENTLY DROPPED EVERY TOOL RESULT.
    //
    // It tested `msg.role === ("tool" as string)`, but the production role literal is
    // `"toolResult"` (@mariozechner/pi-ai `types.d.ts:154`). A tool-result message therefore
    // matched NO branch and contributed ZERO to `totalChars` — and the `as string` cast is what
    // silenced the TypeScript error that would have caught it, which is the whole lesson.
    //
    // Consequence, and it reached published figures: the decoded composition read
    // "tool results 0", which was taken as "no tool results resident" when it actually meant
    // "tool results were not counted". Anything derived from that total under-reads the real
    // context. The correct predicate already existed three directories away, so we now use it
    // rather than re-deriving a second, differently-wrong role test.
    //
    // The terminal `else` is the other half: an unclassified message is ACCUMULATED and
    // reported rather than dropped, so the next role the union grows shows up as a visible
    // unattributed slab instead of silently shrinking the total.
    if (msg.role === "user" && isLast) {
      userMessageChars = chars;
    } else if (isToolResultMessage(msg as never)) {
      toolResultsChars += chars;
    } else if (msg.role === "user" || msg.role === "assistant") {
      conversationHistoryChars += chars;
    } else {
      unattributedChars += chars;
    }
  }

  if (unattributedChars > 0) {
    // Loud on purpose: a slab nobody can attribute is exactly how "tool results 0" happened.
    log.warn(
      `[context-anatomy] ${unattributedChars} chars did not match any composition slab — ` +
        `a message role is unaccounted for, so the reported total UNDER-reads the real context`,
    );
  }

  const totalChars =
    systemPromptChars +
    injectedFilesTotalChars +
    skillsChars +
    toolSchemasChars +
    conversationHistoryChars +
    toolResultsChars +
    userMessageChars;

  const totalTokens = estimateTokens(totalChars);
  const maxTokens = params.contextWindowTokens;
  // FORK 2026-07-28 — `totalTokensUsed` is RUN-CUMULATIVE, not a context snapshot.
  //
  // It arrives from `embedded-agent-subscribe.ts` `usageTotals.total`, which accumulates
  // input+output+cacheRead+cacheWrite across EVERY committed assistant message of the run and
  // never resets — not even on compaction. Preferring it over the char estimate published an
  // accumulator as context fill, and this event is the SOURCE the timeline, the treemap and the
  // persisted anatomy DB all read, so one bad number reached three consumers.
  //
  // A used-figure larger than the whole window cannot be a context size. When that happens we
  // fall back to the honest local char estimate rather than clamping to 100%: clamping would
  // hide the same poison one layer down and still report a fabricated fill. Same rule as the
  // `deriveContextPromptTokens` chokepoint — reject, do not fabricate.
  const reportedUsed = params.totalTokensUsed;
  const reportedIsPlausible =
    typeof reportedUsed === "number" &&
    Number.isFinite(reportedUsed) &&
    reportedUsed > 0 &&
    (maxTokens <= 0 || reportedUsed <= maxTokens);
  const usedTokens = reportedIsPlausible ? (reportedUsed as number) : totalTokens;

  // Auto-recalled memories = injected workspace files that look like memory paths
  const autoRecall = report.injectedWorkspaceFiles
    .filter(
      (f) =>
        !f.missing &&
        f.injectedChars > 0 &&
        (f.path.includes("memory") ||
          f.path.includes("MEMORY") ||
          f.name === "MEMORY.md" ||
          f.name === "SOUL.md"),
    )
    .map((f) => f.path);

  // Topic extraction + transition tracking
  const topics = extractTopics(params.messagesSnapshot);
  const stateKey = params.sessionKey ?? "";
  const previousTopics = stateKey ? sessionTopicsState.get(stateKey) : undefined;
  const topicTransition =
    previousTopics !== undefined ? computeTopicTransition(previousTopics, topics) : undefined;
  if (stateKey) {
    sessionTopicsState.set(stateKey, topics);
  }

  return {
    turn: params.turn,
    roundNumber: params.roundNumber,
    compactionCycle: params.compactionCycle,
    timestamp: new Date(now).toISOString(),
    timestampMs: now,
    model: params.model,
    provider: params.provider,
    sessionKey: params.sessionKey,
    topics,
    topicTransition,
    contextSent: {
      systemPromptChars,
      systemPromptTokens: estimateTokens(systemPromptChars),
      injectedFiles,
      injectedFilesTotalChars,
      injectedFilesTotalTokens: estimateTokens(injectedFilesTotalChars),
      skillsChars,
      skillsTokens: estimateTokens(skillsChars),
      toolSchemasChars,
      toolSchemasTokens: estimateTokens(toolSchemasChars),
      conversationHistoryChars,
      conversationHistoryTokens: estimateTokens(conversationHistoryChars),
      toolResultsChars,
      toolResultsTokens: estimateTokens(toolResultsChars),
      userMessageChars,
      userMessageTokens: estimateTokens(userMessageChars),
      totalChars,
      totalTokens,
    },
    contextWindow: {
      maxTokens,
      usedTokens,
      utilizationPercent: maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 1000) / 10 : 0,
    },
    authProfileId: params.authProfileId,
    responseTokens: params.outputTokens,
    memoriesInjected: {
      autoRecall,
      searched: [],
    },
  };
}
