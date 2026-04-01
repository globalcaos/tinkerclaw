// extensions/overseer/overseer-types.ts
// FORK: Overseer agent types — shared between gateway extension and Tinker UI API responses.

export interface OverseerTreeNode {
  runId: string;
  model: string;
  provider: string;
  label: string;
  status: "planning" | "running" | "monitoring" | "stalled" | "completed" | "failed" | "respawning";
  progress: number;
  lastEventAge: number;
  skill?: string;
  summary?: string;
  children: OverseerTreeNode[];
}

export interface OverseerTreeResponse {
  active: boolean;
  sessionFilter?: string;
  root: OverseerTreeNode | null;
}

export interface OverseerConfig {
  enabled: boolean;
  model: string;
  summaryModel: string;
  monitorIntervalMs: number;
  staleThresholdMs: number;
  guardianStaleThresholdMs: number;
  maxConcurrentWorkers: number;
  autoRoute: boolean;
  effortRouting: {
    minimal: string[];
    standard: string[];
    maximum: string[];
  };
}

export interface OverseerRecoveryState {
  timestamp: string;
  overseerSessionKey: string;
  activeSubagents: Array<{
    runId: string;
    childSessionKey: string;
    task: string;
    model: string;
    status: "running" | "stalled";
  }>;
  pendingTasks: string[];
  originalPrompt: string;
}

export const DEFAULT_OVERSEER_CONFIG: OverseerConfig = {
  enabled: false,
  model: "anthropic/claude-opus-4-6",
  summaryModel: "anthropic/claude-sonnet-4-6",
  monitorIntervalMs: 120_000,
  staleThresholdMs: 180_000,
  guardianStaleThresholdMs: 300_000,
  maxConcurrentWorkers: 8,
  autoRoute: true,
  effortRouting: {
    minimal: ["anthropic/claude-haiku-4-5", "ollama/qwen3:14b"],
    standard: ["anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro"],
    maximum: ["anthropic/claude-opus-4-6"],
  },
};

/** Display name shown in chat and UI. Internal plugin ID remains "overseer". */
export const OVERSEER_DISPLAY_NAME = "Prefrontal";

export function extractProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "unknown";
}
