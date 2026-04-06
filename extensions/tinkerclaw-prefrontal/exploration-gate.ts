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
}

export interface ExplorationGateResult {
  blocked: boolean;
  message?: string;
}

export interface ExplorationGate {
  checkTool(toolName: string, ctx?: ExplorationGateCheckContext): ExplorationGateResult;
  recordToolCall(toolName: string): void;
  resetTurn(): void;
  getTurnReadOnlyCount(): number;
}

export function createExplorationGate(config: ExplorationGateConfig): ExplorationGate {
  let turnReadOnlyCount = 0;

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
    if (isMutating(toolName) && turnReadOnlyCount < config.minReadOnlyTools) {
      return {
        blocked: true,
        message: `Exploration required: you must use at least ${config.minReadOnlyTools} read-only tool(s) (Read, Grep, Glob) before using ${toolName}. Explore the codebase first to understand the existing code.`,
      };
    }

    return { blocked: false };
  }

  function recordToolCall(toolName: string): void {
    if (isReadOnly(toolName)) {
      turnReadOnlyCount++;
    }
  }

  function resetTurn(): void {
    turnReadOnlyCount = 0;
  }

  function getTurnReadOnlyCount(): number {
    return turnReadOnlyCount;
  }

  return { checkTool, recordToolCall, resetTurn, getTurnReadOnlyCount };
}
