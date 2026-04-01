// extensions/prefrontal/effort-router.ts
// FORK: Code-enforced effort routing — validates model assignment against task
// complexity. Downgrades wasteful assignments (e.g., Opus for simple lookups).

export type EffortLevel = "minimal" | "standard" | "maximum";

export interface EffortRoutingConfig {
  enabled: boolean;
  minimal: string[];
  standard: string[];
  maximum: string[];
}

export const DEFAULT_EFFORT_ROUTING_CONFIG: EffortRoutingConfig = {
  enabled: true,
  minimal: ["anthropic/claude-haiku-4-5", "ollama/qwen3:14b"],
  standard: ["anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro"],
  maximum: ["anthropic/claude-opus-4-6"],
};

const MINIMAL_KEYWORDS = [
  "format",
  "lookup",
  "what time",
  "hello",
  "hi",
  "thanks",
  "ok",
  "acknowledge",
  "confirm",
  "yes",
  "no",
];

const MAXIMUM_KEYWORDS = [
  "architect",
  "design",
  "debug complex",
  "research",
  "investigate",
  "security review",
  "migrate",
  "rewrite",
  "analyze",
];

export function classifyEffort(taskDescription: string): EffortLevel {
  const lower = taskDescription.toLowerCase();

  // Check maximum-effort signals first — they override short-message heuristics.
  if (MAXIMUM_KEYWORDS.some((kw) => lower.includes(kw))) {
    return "maximum";
  }

  if (lower.length < 50 && MINIMAL_KEYWORDS.some((kw) => lower.includes(kw))) {
    return "minimal";
  }

  return "standard";
}

export function isModelInTier(model: string, tier: string[], config: EffortRoutingConfig): boolean {
  return tier.some((m) => model.includes(m) || m.includes(model));
}

export interface RoutingDecision {
  approved: boolean;
  suggestedModel?: string;
  reason?: string;
}

export function validateModelAssignment(
  assignedModel: string,
  taskDescription: string,
  config: EffortRoutingConfig,
): RoutingDecision {
  if (!config.enabled) return { approved: true };

  const effort = classifyEffort(taskDescription);

  // Opus assigned to minimal task → downgrade
  if (effort === "minimal" && isModelInTier(assignedModel, config.maximum, config)) {
    return {
      approved: false,
      suggestedModel: config.minimal[0],
      reason: `Task classified as minimal effort ("${taskDescription.slice(0, 60)}") — Opus is wasteful, use ${config.minimal[0]}`,
    };
  }

  // Opus assigned to standard task → downgrade
  if (effort === "standard" && isModelInTier(assignedModel, config.maximum, config)) {
    return {
      approved: false,
      suggestedModel: config.standard[0],
      reason: `Task classified as standard effort — use ${config.standard[0]} instead of Opus`,
    };
  }

  return { approved: true };
}
