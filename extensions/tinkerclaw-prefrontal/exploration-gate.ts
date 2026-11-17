// extensions/prefrontal/exploration-gate.ts
// FORK: Exploration gate — blocks mutating tools until read-only tools have run.
// Forces agents to explore the codebase before writing code.

const READ_ONLY_TOOLS = new Set([
  // PascalCase (Claude Code / external tools)
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "TaskGet",
  "TaskList",
  // lowercase (OpenClaw native tools)
  "read",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "memory_search",
  "recall",
  "session_status",
  "sessions_list",
  "cron",
]);
const MUTATING_TOOLS = new Set([
  // PascalCase (Claude Code / external tools)
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "TaskCreate",
  "TaskUpdate",
  // lowercase (OpenClaw native tools)
  "edit",
  "write",
  "exec",
  "apply_patch",
  "sessions_send",
]);

export interface ExplorationGateConfig {
  enabled: boolean;
  minReadOnlyTools: number;
  exemptTriggers: string[];
  exemptSubagents: boolean;
}

export const DEFAULT_EXPLORATION_GATE_CONFIG: ExplorationGateConfig = {
  enabled: true,
  minReadOnlyTools: 1,
  exemptTriggers: ["heartbeat", "cron"],
  exemptSubagents: true,
};

export interface ExplorationGateCheckContext {
  trigger?: string;
  isSubagent?: boolean;
  /** The chat whose turn the call belongs to: only that chat's reads count. */
  sessionKey?: string;
}

export interface ExplorationGateResult {
  blocked: boolean;
  message?: string;
}

export interface ExplorationGate {
  checkTool(toolName: string, ctx?: ExplorationGateCheckContext): ExplorationGateResult;
  recordToolCall(toolName: string, sessionKey?: string): void;
  resetTurn(sessionKey?: string): void;
  getTurnReadOnlyCount(sessionKey?: string): number;
}

const READ_COUNTS = Symbol.for("tinkerclaw.prefrontal.explorationReads");
/** Chats remembered at once; the one that read least recently goes first. Each costs one map entry. */
const MAX_TRACKED_SESSIONS = 512;

/**
 * Read-only calls in each chat's current turn, one map per gateway process. A single counter broke on 2026-10-30:
 * every session's `llm_input` reset it (56 resets in one hour from a pilot's orchestrator and its subagents), and
 * the gateway runs register() several times, each building a new gate. A chat's read was gone within a minute, so
 * every later exec in that turn was refused, 587 times in an hour, until the model gave up.
 */
function readCounts(): Map<string, number> {
  const g = globalThis as { [READ_COUNTS]?: Map<string, number> };
  return (g[READ_COUNTS] ??= new Map<string, number>());
}

/** Test seam: forget every chat's reads. */
export function __resetExplorationGateForTest(): void {
  readCounts().clear();
}

export function createExplorationGate(config: ExplorationGateConfig): ExplorationGate {
  const counts = readCounts();
  const keyOf = (sessionKey?: string): string => sessionKey ?? "";

  function isReadOnly(toolName: string): boolean {
    return READ_ONLY_TOOLS.has(toolName);
  }

  function isMutating(toolName: string): boolean {
    // Only block tools explicitly listed as mutating — unknown tools pass through
    return MUTATING_TOOLS.has(toolName);
  }

  function checkTool(toolName: string, ctx?: ExplorationGateCheckContext): ExplorationGateResult {
    if (!config.enabled) {
      return { blocked: false };
    }

    // Exempt triggers (heartbeat, cron)
    if (ctx?.trigger && config.exemptTriggers.includes(ctx.trigger)) {
      return { blocked: false };
    }

    // Exempt subagents (they received context from the Overseer)
    if (ctx?.isSubagent && config.exemptSubagents) {
      return { blocked: false };
    }

    // Read-only tools always pass
    if (isReadOnly(toolName)) {
      return { blocked: false };
    }

    // Mutating tools blocked until exploration threshold met
    if (isMutating(toolName) && getTurnReadOnlyCount(ctx?.sessionKey) < config.minReadOnlyTools) {
      return {
        blocked: true,
        message: `Exploration required: you must use at least ${config.minReadOnlyTools} read-only tool(s) (Read, Grep, Glob) before using ${toolName}. Explore the codebase first to understand the existing code.`,
      };
    }

    return { blocked: false };
  }

  function recordToolCall(toolName: string, sessionKey?: string): void {
    if (!isReadOnly(toolName)) {
      return;
    }
    const key = keyOf(sessionKey);
    const n = (counts.get(key) ?? 0) + 1;
    // Re-insert so the map's order runs from least to most recently read.
    counts.delete(key);
    counts.set(key, n);
    if (counts.size > MAX_TRACKED_SESSIONS) {
      const oldest = counts.keys().next().value;
      if (oldest !== undefined) {
        counts.delete(oldest);
      }
    }
  }

  function resetTurn(sessionKey?: string): void {
    counts.delete(keyOf(sessionKey));
  }

  function getTurnReadOnlyCount(sessionKey?: string): number {
    return counts.get(keyOf(sessionKey)) ?? 0;
  }

  return { checkTool, recordToolCall, resetTurn, getTurnReadOnlyCount };
}
