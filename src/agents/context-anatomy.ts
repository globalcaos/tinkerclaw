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

  return {
    turn: params.turn,
    compactionCycle: params.compactionCycle,
    timestamp: new Date(now).toISOString(),
    timestampMs: now,
    model: params.model,
    provider: params.provider,
    sessionKey: params.sessionKey,
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
