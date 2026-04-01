// src/fork/fork-subagent.ts
// FORK: Fork subagent — creates child agents that inherit parent's rendered
// system prompt bytes for cache sharing. Follows Claude Code's fork pattern.

export interface ForkParams {
  task: string;
  renderedSystemPrompt?: string;
  parentMessages?: Array<{ role: string; content: unknown }>;
  contextDepth?: number;
  background?: boolean;
  renderSystemPrompt?: () => string;
}

export interface ForkResult {
  systemPrompt: string;
  messages: Array<{ role: string; content: unknown }>;
  taskPrompt: string;
  background: boolean;
}

const DEFAULT_CONTEXT_DEPTH = 10;

export function createFork(params: ForkParams): ForkResult {
  // Key: use parent's rendered bytes verbatim — never re-render
  const systemPrompt = params.renderedSystemPrompt ?? "";

  // Include parent conversation context (last N messages)
  const depth = params.contextDepth ?? DEFAULT_CONTEXT_DEPTH;
  const allMessages = params.parentMessages ?? [];
  const messages = allMessages.slice(-depth);

  return {
    systemPrompt,
    messages,
    taskPrompt: params.task,
    background: params.background ?? true,
  };
}

export function estimateForkCacheSavings(
  renderedPromptTokens: number,
  childCount: number,
): { savedTokens: number; savingsPct: number } {
  // Each child reuses the parent's cached prompt instead of re-rendering
  const savedTokens = renderedPromptTokens * childCount;
  const totalWithoutCache = renderedPromptTokens * (childCount + 1);
  const savingsPct =
    totalWithoutCache > 0 ? Math.round((savedTokens / totalWithoutCache) * 100) : 0;
  return { savedTokens, savingsPct };
}
