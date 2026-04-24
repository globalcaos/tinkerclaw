// extensions/prefrontal/faar-tracker.ts
// FORK: Automated FAAR tracking — logs task outcomes for measuring
// compounded intelligence (first-attempt accuracy, tokens, model, category).

export type TaskCategory =
  | "coding"
  | "debugging"
  | "operational"
  | "research"
  | "conversation"
  | "unknown";

export interface TaskOutcome {
  timestamp: number;
  sessionKey: string;
  category: TaskCategory;
  firstAttemptSuccess: boolean;
  model: string;
  provider: string;
  tokensUsed: number;
  durationMs: number;
  retryCount: number;
}

export interface FaarMetrics {
  totalTasks: number;
  firstAttemptSuccesses: number;
  faar: number;
  avgTokens: number;
  byCategory: Record<string, { total: number; successes: number; faar: number }>;
  byModel: Record<string, { total: number; successes: number; faar: number }>;
}

const CATEGORY_KEYWORDS: Record<TaskCategory, string[]> = {
  coding: ["implement", "add feature", "create", "write code", "endpoint", "component"],
  debugging: ["fix", "bug", "debug", "error", "broken", "failing", "crash"],
  operational: ["deploy", "merge", "restart", "config", "update", "migrate"],
  research: ["research", "investigate", "analyze", "compare", "review paper"],
  conversation: ["hello", "hi", "thanks", "what time", "how are"],
  unknown: [],
};

export function classifyTask(description: string): TaskCategory {
  const lower = description.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (category === "unknown") {continue;}
    if (keywords.some((kw) => lower.includes(kw))) {
      return category as TaskCategory;
    }
  }
  return "unknown";
}

export interface FaarTracker {
  record(outcome: TaskOutcome): void;
  getMetrics(since?: number): FaarMetrics;
  getOutcomes(): TaskOutcome[];
}

export function createFaarTracker(): FaarTracker {
  const outcomes: TaskOutcome[] = [];

  function record(outcome: TaskOutcome): void {
    outcomes.push(outcome);
  }

  function getMetrics(since?: number): FaarMetrics {
    const filtered = since ? outcomes.filter((o) => o.timestamp >= since) : outcomes;

    const totalTasks = filtered.length;
    const firstAttemptSuccesses = filtered.filter((o) => o.firstAttemptSuccess).length;
    const faar = totalTasks > 0 ? firstAttemptSuccesses / totalTasks : 0;
    const avgTokens =
      totalTasks > 0 ? Math.round(filtered.reduce((s, o) => s + o.tokensUsed, 0) / totalTasks) : 0;

    const byCategory: FaarMetrics["byCategory"] = {};
    const byModel: FaarMetrics["byModel"] = {};

    for (const o of filtered) {
      // By category
      if (!byCategory[o.category]) {byCategory[o.category] = { total: 0, successes: 0, faar: 0 };}
      byCategory[o.category].total++;
      if (o.firstAttemptSuccess) {byCategory[o.category].successes++;}

      // By model
      if (!byModel[o.model]) {byModel[o.model] = { total: 0, successes: 0, faar: 0 };}
      byModel[o.model].total++;
      if (o.firstAttemptSuccess) {byModel[o.model].successes++;}
    }

    // Calculate per-category and per-model FAAR
    for (const cat of Object.values(byCategory)) {
      cat.faar = cat.total > 0 ? cat.successes / cat.total : 0;
    }
    for (const mod of Object.values(byModel)) {
      mod.faar = mod.total > 0 ? mod.successes / mod.total : 0;
    }

    return { totalTasks, firstAttemptSuccesses, faar, avgTokens, byCategory, byModel };
  }

  function getOutcomes(): TaskOutcome[] {
    return [...outcomes];
  }

  return { record, getMetrics, getOutcomes };
}
