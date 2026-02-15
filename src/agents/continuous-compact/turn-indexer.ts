/**
 * Turn indexer: window partitioning, pair grouping, text flattening.
 *
 * Embeds conversation turns that age out of the active window into a
 * per-session vector store for later retrieval.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { TurnIndexerConfig } from "./config.js";
import { DEFAULT_INDEXER_CONFIG } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────

export interface TurnChunk {
  id: string;
  sessionId: string;
  text: string;
  embedding?: number[];
  tokenEstimate: number;
  timestamp: number;
  turnStartIndex: number;
  turnEndIndex: number;
  roles: string[];
  metadata?: {
    toolNames?: string[];
    hasError?: boolean;
    userMessagePreview?: string;
    topicId?: number;
  };
}

// ── Window Partitioning ─────────────────────────────────────────────

/**
 * Partition messages into active window (recent, in-context) and
 * aged-out (to be embedded and removed from context).
 *
 * Walks backward from the end, keeping turns until either windowSize
 * or windowTokenBudget is exhausted (whichever comes first).
 */
export function partitionActiveWindow(
  messages: AgentMessage[],
  config: TurnIndexerConfig = DEFAULT_INDEXER_CONFIG,
): { activeWindow: AgentMessage[]; agedOut: AgentMessage[] } {
  if (messages.length === 0) {
    return { activeWindow: [], agedOut: [] };
  }

  let tokenBudget = config.windowTokenBudget;
  let turnCount = 0;
  let splitIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i]);
    turnCount++;
    tokenBudget -= tokens;

    if (turnCount > config.windowSize || tokenBudget < 0) {
      splitIndex = i + 1;
      break;
    }
  }

  return {
    activeWindow: messages.slice(splitIndex),
    agedOut: messages.slice(0, splitIndex),
  };
}

// ── Pair Grouping ───────────────────────────────────────────────────

/**
 * Group messages into user→assistant exchange pairs for embedding.
 * A "pair" is one user message + all following non-user messages
 * until the next user message.
 */
export function groupIntoPairs(messages: AgentMessage[]): AgentMessage[][] {
  const pairs: AgentMessage[][] = [];
  let current: AgentMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      pairs.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) {
    pairs.push(current);
  }

  return pairs;
}

// ── Text Flattening ─────────────────────────────────────────────────

/**
 * Flatten a message into embeddable text.
 */
export function flattenMessageText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }

  const text = parts.join("\n");
  const toolName = (msg as { toolName?: string }).toolName;
  if (toolName && msg.role === "toolResult") {
    return `[Tool: ${toolName}] ${text.slice(0, 2000)}`;
  }
  return text;
}

/**
 * Flatten a group of messages (user+assistant pair) into a single
 * text string for embedding.
 */
export function flattenPairText(pair: AgentMessage[], maxChars: number): string {
  return pair
    .map((msg) => {
      const role =
        msg.role === "user"
          ? "User"
          : msg.role === "assistant"
            ? "Assistant"
            : `Tool(${(msg as { toolName?: string }).toolName ?? "?"})`;
      const text = flattenMessageText(msg);
      return `${role}: ${text}`;
    })
    .join("\n")
    .slice(0, maxChars);
}

// ── Chunk Building ──────────────────────────────────────────────────

/**
 * Build TurnChunks from aged-out messages, grouped into pairs.
 */
export function buildTurnChunks(
  agedOut: AgentMessage[],
  sessionId: string,
  globalOffset: number,
  config: TurnIndexerConfig,
): TurnChunk[] {
  const pairs = groupIntoPairs(agedOut);
  const chunks: TurnChunk[] = [];
  let msgIndex = globalOffset;

  for (const pair of pairs) {
    const text = flattenPairText(pair, config.maxEmbedChars);
    if (text.length < config.minTurnChars) {
      msgIndex += pair.length;
      continue;
    }

    const toolNames = pair
      .filter((m) => m.role === "toolResult")
      .map((m) => (m as { toolName?: string }).toolName)
      .filter(Boolean) as string[];

    const userMsg = pair.find((m) => m.role === "user");
    const userPreview = userMsg ? flattenMessageText(userMsg).slice(0, 200) : undefined;

    chunks.push({
      id: `${sessionId}-pair-${msgIndex}`,
      sessionId,
      text,
      tokenEstimate: pair.reduce((sum, m) => sum + estimateTokens(m), 0),
      timestamp: (pair[0] as { timestamp?: number }).timestamp ?? Date.now(),
      turnStartIndex: msgIndex,
      turnEndIndex: msgIndex + pair.length - 1,
      roles: pair.map((m) => m.role as string),
      metadata: {
        toolNames: toolNames.length > 0 ? toolNames : undefined,
        hasError: pair.some((m) => (m as { isError?: boolean }).isError),
        userMessagePreview: userPreview,
      },
    });

    msgIndex += pair.length;
  }

  return chunks;
}
