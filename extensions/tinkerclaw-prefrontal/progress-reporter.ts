// extensions/prefrontal/progress-reporter.ts
// FORK: Prefrontal v3.0 progress reporter — emits periodic status
// updates to Tinker UI showing recipe progress via the "agent" broadcast
// stream with phase "prefrontal-progress".
//
// Wired in by: index.ts (llm_output + agent_end hooks)
// Consumed by: tinker-ui/src/app.ts (WS event handler)

export interface ProgressReport {
  recipeId: string;
  recipeName: string;
  currentStep: string;
  completedSteps: string[];
  totalSteps: number;
  activeWorkers: number;
  stalledWorkers: number;
  elapsedMs: number;
  estimatedRemainingMs?: number;
}

/**
 * Format a progress report into a broadcast event payload.
 */
export function formatProgressEvent(report: ProgressReport): {
  phase: string;
  data: ProgressReport;
} {
  return {
    phase: "prefrontal-progress",
    data: report,
  };
}
