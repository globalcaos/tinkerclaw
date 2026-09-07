import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;

/**
 * Two separate estimate spaces, deliberately never mixed:
 *  - `raw`      : characters that actually go on the wire (uniform 4 chars/token).
 *  - `weighted` : conservative 2-chars/token tool-result weighting + `details`.
 * Keeping them in distinct maps makes cross-contamination impossible.
 */
export type MessageCharEstimateCache = {
  readonly weighted: WeakMap<AgentMessage, number>;
  readonly raw: WeakMap<AgentMessage, number>;
};

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

export function isToolResultMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: unknown }).role;
  const type = (msg as { type?: unknown }).type;
  return role === "toolResult" || role === "tool" || type === "toolResult";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if (!isToolResultMessage(msg)) {
    return [];
  }
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) {
      chars += block.text.length;
    } else if (isImageBlock(block)) {
      chars += IMAGE_CHAR_ESTIMATE;
    } else {
      chars += estimateUnknownChars(block);
    }
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

/**
 * RAW estimate: the characters that actually reach the provider, under ONE uniform
 * 4-chars/token convention. `toolResult.details` is EXCLUDED because it is stripped
 * at the LLM boundary (`normalizeMessagesForLlmBoundary` -> `stripToolResultDetails`),
 * and tool-result text is NOT re-weighted. This is the input to the whole-context
 * overflow predicate, so it stays directly comparable to a `contextWindow * 4` budget.
 */
function estimateMessageRawChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return estimateContentBlockChars(content);
    }
    return 0;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typed = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (typed.type === "text" && typeof typed.text === "string") {
          chars += typed.text.length;
        } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
          chars += typed.thinking.length;
        } else if (typed.type === "toolCall") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        } else {
          chars += estimateUnknownChars(block);
        }
      }
    }
    return chars;
  }

  if (isToolResultMessage(msg)) {
    return estimateContentBlockChars(getToolResultContent(msg));
  }

  return 256;
}

/**
 * WEIGHTED estimate: intentionally pessimistic. Tool results are scored at
 * 2 chars/token and `toolResult.details` is counted. Used ONLY to decide whether a
 * SINGLE tool result must be truncated (`maxSingleToolResultChars`) — never for the
 * whole-context overflow predicate, whose budget is denominated in 4 chars/token.
 */
function estimateMessageWeightedChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }

  if (!isToolResultMessage(msg)) {
    return estimateMessageRawChars(msg);
  }

  const content = getToolResultContent(msg);
  let chars = estimateContentBlockChars(content);
  const details = (msg as { details?: unknown }).details;
  chars += estimateUnknownChars(details);
  const weightedChars = Math.ceil(
    chars * (CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE),
  );
  return Math.max(chars, weightedChars);
}

export function createMessageCharEstimateCache(): MessageCharEstimateCache {
  return {
    weighted: new WeakMap<AgentMessage, number>(),
    raw: new WeakMap<AgentMessage, number>(),
  };
}

/** Truncation semantics: `details` counted, tool results weighted x2. */
export function estimateMessageWeightedCharsCached(
  msg: AgentMessage,
  cache: MessageCharEstimateCache,
): number {
  const hit = cache.weighted.get(msg);
  if (hit !== undefined) {
    return hit;
  }
  const estimated = estimateMessageWeightedChars(msg);
  cache.weighted.set(msg, estimated);
  return estimated;
}

/** Wire semantics: `details` excluded, uniform 4 chars/token, no weighting. */
export function estimateMessageRawCharsCached(
  msg: AgentMessage,
  cache: MessageCharEstimateCache,
): number {
  const hit = cache.raw.get(msg);
  if (hit !== undefined) {
    return hit;
  }
  const estimated = estimateMessageRawChars(msg);
  cache.raw.set(msg, estimated);
  return estimated;
}

/**
 * Whole-context total consumed by the preemptive-overflow predicate. Raw chars only,
 * so `estimateRawContextChars(msgs) > contextWindowTokens * 4 * 0.9` really means
 * "past ~90% of the window".
 */
export function estimateRawContextChars(
  messages: AgentMessage[],
  cache: MessageCharEstimateCache,
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageRawCharsCached(msg, cache), 0);
}

export function invalidateMessageCharsCacheEntry(
  cache: MessageCharEstimateCache,
  msg: AgentMessage,
): void {
  cache.weighted.delete(msg);
  cache.raw.delete(msg);
}
