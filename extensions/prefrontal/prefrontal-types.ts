// extensions/prefrontal/prefrontal-types.ts
// FORK: Prefrontal agent types — shared between gateway extension and Tinker UI API responses.

export interface PrefrontalTreeNode {
  runId: string;
  model: string;
  provider: string;
  label: string;
  status: "planning" | "running" | "monitoring" | "stalled" | "completed" | "failed" | "respawning";
  progress: number;
  lastEventAge: number;
  skill?: string;
  summary?: string;
  children: PrefrontalTreeNode[];
}

export interface PrefrontalTreeResponse {
  active: boolean;
  sessionFilter?: string;
  root: PrefrontalTreeNode | null;
}

export interface PrefrontalConfig {
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

export interface PrefrontalRecoveryState {
  timestamp: string;
  prefrontalSessionKey: string;
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

// FORK: Defaults now target the claude-code bridge (Anthropic subscription via
// the claude CLI) — the anthropic API provider path is suspended on this fork,
// so prefrontal's planner + summariser + subagent dispatch would otherwise 400
// on every call. Runtime config in openclaw.json can still override per-deploy.
export const DEFAULT_PREFRONTAL_CONFIG: PrefrontalConfig = {
  enabled: false,
  model: "claude-code/claude-opus-4-7",
  summaryModel: "claude-code/claude-sonnet-4-6",
  monitorIntervalMs: 120_000,
  staleThresholdMs: 180_000,
  guardianStaleThresholdMs: 300_000,
  maxConcurrentWorkers: 8,
  autoRoute: true,
  effortRouting: {
    minimal: ["claude-code/claude-haiku-4-5", "ollama/qwen3:14b"],
    standard: ["claude-code/claude-sonnet-4-6", "google/gemini-2.5-pro"],
    maximum: ["claude-code/claude-opus-4-7"],
  },
};

export function extractProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "unknown";
}
