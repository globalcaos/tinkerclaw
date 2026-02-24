/**
 * Context Anatomy — Per-turn prompt decomposition.
 *
 * Records what goes into every LLM call: system prompt, workspace files,
 * skills, tool schemas, conversation history, tool results, and user message.
 * Each record is tagged with a compaction cycle counter and context utilization.
 *
 * Events are written to a JSONL file per session for historical analysis,
 * and returned on the attempt result for real-time consumption.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";

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
  /** Which memory files were injected. */
  memoriesInjected: {
    /** Files injected as workspace bootstrap (MEMORY.md, SOUL.md, etc). */
    autoRecall: string[];
    /** Files retrieved via memory_search tool calls (populated later). */
    searched: string[];
  };
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
  "a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of", "and",
  "or", "but", "with", "from", "by", "as", "be", "was", "are", "were", "been",
  "has", "have", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "shall", "can", "need", "i", "me", "my", "we", "you", "he",
  "she", "they", "them", "this", "that", "these", "those", "what", "how", "why",
  "when", "where", "which", "who", "not", "no", "so", "if", "then", "up", "out",
  "now", "also", "just", "about", "into", "than", "its", "your", "our", "their",
  "there", "here", "get", "got", "let", "run", "want", "make", "like", "know",
  "look", "see", "use", "find", "give", "think", "tell", "show", "work",
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
  const lastUserMsg = [...messagesSnapshot].reverse().find((m) => m.role === "user");
  if (lastUserMsg) {
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
    const sorted = [...wordFreq.entries()].sort((a, b) => b[1] - a[1]);
    for (const [word] of sorted.slice(0, 3)) {
      topics.push(word);
    }
  }

  // --- Source 2: tool names from assistant messages ---
  for (const msg of messagesSnapshot) {
    if (msg.role !== "assistant") {continue;}
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_use" &&
          typeof (block as Record<string, unknown>).name === "string"
        ) {
          const toolName = (block as Record<string, unknown>).name as string;
          if (!topics.includes(toolName)) {
            topics.push(toolName);
          }
        }
      }
    }
  }

  // --- Source 3: file paths from tool results ---
  for (const msg of messagesSnapshot) {
    if (msg.role !== "tool") {continue;}
    const text =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
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
  compactionCycle: number;
  provider: string;
  model: string;
  sessionKey?: string;
  systemPromptReport: SessionSystemPromptReport;
  messagesSnapshot: AgentMessage[];
  contextWindowTokens: number;
  totalTokensUsed?: number;
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
  const toolSchemasChars =
    report.tools.listChars + report.tools.schemaChars;

  // Conversation history and tool results from messages snapshot
  let conversationHistoryChars = 0;
  let toolResultsChars = 0;
  let userMessageChars = 0;

  const messages = params.messagesSnapshot;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) {continue;}
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const chars = content.length;
    const isLast = i === messages.length - 1;

    if (msg.role === "user" && isLast) {
      userMessageChars = chars;
    } else if (msg.role === "tool") {
      toolResultsChars += chars;
    } else if (msg.role === "user" || msg.role === "assistant") {
      conversationHistoryChars += chars;
    }
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
  const usedTokens = params.totalTokensUsed ?? totalTokens;

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
    memoriesInjected: {
      autoRecall,
      searched: [],
    },
  };
}

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

const ANATOMY_DIR = ".openclaw/context-anatomy";

function resolveAnatomyPath(sessionKey: string): string {
  const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(homeDir, ANATOMY_DIR, `${safeName}.jsonl`);
}

export async function writeAnatomyEvent(
  sessionKey: string,
  event: ContextAnatomyEvent,
): Promise<void> {
  const filePath = resolveAnatomyPath(sessionKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
}

export async function readAnatomyEvents(
  sessionKey: string,
  limit = 50,
): Promise<ContextAnatomyEvent[]> {
  const filePath = resolveAnatomyPath(sessionKey);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as ContextAnatomyEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is ContextAnatomyEvent => e !== null);
    return events.slice(-limit);
  } catch {
    return [];
  }
}

export async function readLatestAnatomyEvent(
  sessionKey: string,
): Promise<ContextAnatomyEvent | null> {
  const events = await readAnatomyEvents(sessionKey, 1);
  return events[0] ?? null;
}
