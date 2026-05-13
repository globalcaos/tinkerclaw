// extensions/prefrontal/corf-trigger.ts
// FORK: CORF auto-invocation — detects high-stakes decisions and triggers
// SYNAPSE round-table debate for cross-model validation.

export interface CorfTriggerConfig {
  enabled: boolean;
}

export const DEFAULT_CORF_CONFIG: CorfTriggerConfig = {
  enabled: true,
};

const HIGH_STAKES_KEYWORDS = [
  "architect",
  "architecture",
  "delete",
  "remove permanently",
  "migrate",
  "migration",
  "security",
  "credential",
  "secret",
  "production",
  "deploy to prod",
  "database schema",
  "drop table",
  "breaking change",
  "backwards incompatible",
  "rewrite from scratch",
];

const EXPLICIT_TRIGGERS = [
  "multi-model review",
  "cross-model",
  "debate this",
  "synapse",
  "round table",
  "second opinion",
  "validate with",
];

export function shouldTriggerCorf(taskDescription: string, config: CorfTriggerConfig): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!taskDescription || taskDescription.length < 10) {
    return false;
  }

  const lower = taskDescription.toLowerCase();

  // Explicit user request always triggers
  if (EXPLICIT_TRIGGERS.some((t) => lower.includes(t))) {
    return true;
  }

  // High-stakes keyword detection
  if (HIGH_STAKES_KEYWORDS.some((kw) => lower.includes(kw))) {
    return true;
  }

  return false;
}

export function getCorfDebatePrompt(taskDescription: string): string {
  return `## SYNAPSE Round-Table Debate Request

The following task has been classified as high-stakes and requires cross-model validation before proceeding.

**Task:** ${taskDescription}

**Instructions for debate:**
1. Propose your approach with reasoning
2. Identify risks and failure modes
3. Consider alternative approaches
4. Recommend the safest path forward

Resolve disagreements by majority. Flag unresolvable disagreements for human review.`;
}
