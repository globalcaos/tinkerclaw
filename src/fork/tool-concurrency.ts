// src/fork/tool-concurrency.ts
// FORK: Tool concurrency partitioner — batches consecutive read-only tools for
// parallel execution, serializes mutating tools. Follows Claude Code's pattern.

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "memory_search",
  "recall",
  "TaskGet",
  "TaskList",
  "ToolSearch",
  "AskUserQuestion",
]);

export interface ToolCall {
  name: string;
  id: string;
  [key: string]: unknown;
}

export interface ToolBatch {
  mode: "parallel" | "serial";
  calls: ToolCall[];
}

export interface PartitionOptions {
  maxConcurrency?: number;
}

const DEFAULT_MAX_CONCURRENCY = 8;

export function classifyTool(name: string): "read-only" | "mutating" {
  return READ_ONLY_TOOLS.has(name) ? "read-only" : "mutating";
}

export function partitionToolCalls(calls: ToolCall[], opts?: PartitionOptions): ToolBatch[] {
  if (calls.length === 0) {
    return [];
  }

  const maxConcurrency = opts?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const batches: ToolBatch[] = [];
  let currentReadOnly: ToolCall[] = [];

  function flushReadOnly(): void {
    if (currentReadOnly.length === 0) {
      return;
    }
    // Split into chunks of maxConcurrency
    for (let i = 0; i < currentReadOnly.length; i += maxConcurrency) {
      batches.push({
        mode: "parallel",
        calls: currentReadOnly.slice(i, i + maxConcurrency),
      });
    }
    currentReadOnly = [];
  }

  for (const call of calls) {
    if (classifyTool(call.name) === "read-only") {
      currentReadOnly.push(call);
    } else {
      // Flush any accumulated read-only calls first
      flushReadOnly();
      // Each mutating call is its own serial batch
      batches.push({ mode: "serial", calls: [call] });
    }
  }

  // Flush remaining read-only calls
  flushReadOnly();

  return batches;
}
