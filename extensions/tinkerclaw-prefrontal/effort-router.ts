// extensions/prefrontal/effort-router.ts
// FORK: DYNAMIC reasoning-complexity adaptation.
//
//   recommendEffort / buildEffortGuidance (FORK 2026-05-29) — scores the
//   user prompt and auto-adapts Jarvis's reasoning posture along FOUR tiers
//   (trivial → standard → deep → ultra). The recommendation is injected into
//   the turn as prependSystemContext so Jarvis scales thinking budget, model
//   tier, orchestration mode (solo / parallel subagents / full workflow) and
//   token generosity to the task — "up to ultracode, generous with tokens".
//
// This is the "smart Jarvis" lever: the classification drives the turn.
//
// Retired 2026-06-14 (FOUNDATION #2, bible §5.84-B): the legacy
// validateModelAssignment guard + hardcoded DEFAULT_EFFORT_ROUTING_CONFIG tier
// list were log-only dead code that hardcoded a stale, drifting model roster —
// deleted along with isModelInTier and the EffortRoutingConfig/RoutingDecision
// types that only existed to serve them.

export type EffortLevel = "minimal" | "standard" | "maximum";

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

// ─── Dynamic complexity adaptation (FORK 2026-05-29) ────────────────────────

export type ComplexityLevel = "trivial" | "standard" | "deep" | "ultra";

export type OrchestrationMode = "solo" | "parallel" | "workflow";

export interface ComplexitySignals {
  words: number;
  clauses: number;
  hasCode: boolean;
  hasPaths: boolean;
  deepHits: string[];
  ultraHits: string[];
  trivialHit: boolean;
  questionsAsked: number;
}

export interface EffortRecommendation {
  level: ComplexityLevel;
  /** Numeric score behind the level — useful for logs/telemetry. */
  score: number;
  /** Suggested model tier alias. */
  modelTier: EffortLevel;
  /** One-line thinking-budget hint for the turn. */
  thinkingHint: string;
  /** How Jarvis should structure the work. */
  orchestration: OrchestrationMode;
  /** Token-generosity posture. */
  tokenGuidance: string;
  signals: ComplexitySignals;
}

// Signals that a task is genuinely hard / broad and rewards more reasoning.
const DEEP_KEYWORDS = [
  "architect",
  "design",
  "investigate",
  "research",
  "audit",
  "analyze",
  "analyse",
  "refactor",
  "migrate",
  "rewrite",
  "debug",
  "root cause",
  "trace",
  "compare",
  "evaluate",
  "review",
  "plan",
  "optimize",
  "optimise",
  "security",
  "performance",
];

// Signals that the user wants maximum effort / breadth — push to ultra.
const ULTRA_KEYWORDS = [
  "ultracode",
  "comprehensive",
  "exhaustive",
  "thorough",
  "everything",
  "end to end",
  "end-to-end",
  "fully",
  "all the",
  "as capable",
  "be generous",
  "no questions",
  "in one shot",
  "every ",
  "entire codebase",
  "deep dive",
  "across the",
];

// Short conversational turns that need no extra reasoning.
const TRIVIAL_KEYWORDS = [
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank you",
  "ok",
  "okay",
  "yes",
  "no",
  "got it",
  "ack",
  "lookup",
  "what time",
  "format this",
];

function countClauses(s: string): number {
  // Conjunctions, separators, list markers, and line breaks all signal
  // multi-part work. Cheap proxy for "how many things am I being asked to do".
  const seps = (s.match(/[,;]|\band\b|\bthen\b|\balso\b|\bplus\b|\bafter\b/gi) ?? []).length;
  const bullets = (s.match(/^\s*[-*\d]+[.)]\s+/gm) ?? []).length;
  const lines = (s.match(/\n/g) ?? []).length;
  return seps + bullets + lines;
}

export function classifyComplexity(prompt: string): EffortRecommendation {
  const lower = prompt.toLowerCase();
  const words = (prompt.trim().match(/\S+/g) ?? []).length;
  const clauses = countClauses(prompt);
  const hasCode = /```|\b\w+\.(ts|tsx|js|mjs|py|json|css|html|sh|md)\b|\bfunction\b|=>/.test(
    prompt,
  );
  const hasPaths = /(^|\s)[~./][\w./-]*\/[\w./-]+/.test(prompt);
  const deepHits = DEEP_KEYWORDS.filter((kw) => lower.includes(kw));
  const ultraHits = ULTRA_KEYWORDS.filter((kw) => lower.includes(kw));
  // Word-boundary match for trivial keywords so 2-char tokens ("no", "ok", "hi")
  // don't match as substrings inside real words ("another", "lookup", "this")
  // (review finding 2026-05-29). And a trivial turn must have NO deep/ultra verbs.
  const promptWords = new Set(lower.match(/[a-z']+/g) ?? []);
  const trivialHit =
    words <= 8 &&
    deepHits.length === 0 &&
    ultraHits.length === 0 &&
    TRIVIAL_KEYWORDS.some((kw) => (kw.includes(" ") ? lower.includes(kw) : promptWords.has(kw)));
  const questionsAsked = (prompt.match(/\?/g) ?? []).length;

  const signals: ComplexitySignals = {
    words,
    clauses,
    hasCode,
    hasPaths,
    deepHits,
    ultraHits,
    trivialHit,
    questionsAsked,
  };

  // Score. Each signal contributes; tuned so a one-liner stays trivial/standard
  // and a multi-part "build everything, be thorough" prompt reaches ultra.
  let score = 0;
  if (words > 40) score += 1;
  if (words > 120) score += 1;
  if (words > 300) score += 1;
  if (clauses >= 4) score += 1;
  if (clauses >= 10) score += 1;
  if (hasCode) score += 1;
  if (hasPaths) score += 1;
  score += Math.min(4, deepHits.length); // up to +4 for distinct deep verbs
  score += Math.min(4, ultraHits.length * 2); // ultra words weigh double, cap +4
  if (questionsAsked >= 3) score += 1;

  let level: ComplexityLevel;
  // Trivial = an explicit conversational/ack keyword, or a tiny no-signal turn.
  // Anything with real verbs, length, or code/paths is at least standard.
  if (trivialHit || (words <= 4 && score === 0)) level = "trivial";
  else if (score >= 7 || ultraHits.length >= 2) level = "ultra";
  else if (score >= 4) level = "deep";
  else level = "standard";
  // Floor: 3+ distinct hard verbs is deep work even if other signals are light.
  if (level === "standard" && deepHits.length >= 3) level = "deep";

  const byLevel: Record<
    ComplexityLevel,
    Omit<EffortRecommendation, "level" | "score" | "signals">
  > = {
    trivial: {
      modelTier: "minimal",
      thinkingHint: "no extended thinking — answer directly",
      orchestration: "solo",
      tokenGuidance: "terse; a sentence or two is enough",
    },
    standard: {
      modelTier: "standard",
      thinkingHint: "brief reasoning; verify before claiming done",
      orchestration: "solo",
      tokenGuidance: "normal; cover the ask without padding",
    },
    deep: {
      modelTier: "maximum",
      thinkingHint: "extended thinking; lay out KNOW/ASSUME/DON'T-KNOW before acting",
      orchestration: "parallel",
      tokenGuidance: "generous; fan out read-only exploration to subagents where independent",
    },
    ultra: {
      modelTier: "maximum",
      thinkingHint: "maximum reasoning; design before implementing",
      orchestration: "workflow",
      tokenGuidance:
        "very generous — correctness over cost; orchestrate a workflow (understand→design→implement→review), adversarially verify findings, run a completeness critic at the end",
    },
  };

  return { level, score, signals, ...byLevel[level] };
}

/**
 * Build the prependSystemContext block that auto-adapts Jarvis's posture for
 * this turn. Returns null for trivial turns (no guidance needed — keep them
 * cheap and fast). Used by the before_prompt_build hook.
 */
export function buildEffortGuidance(prompt: string): string | null {
  const rec = classifyComplexity(prompt);
  if (rec.level === "trivial") return null;
  const lines = [
    `<effort_adaptation level="${rec.level}" score="${rec.score}">`,
    `This turn was auto-classified **${rec.level}**. Adapt your reasoning accordingly:`,
    `- Reasoning: ${rec.thinkingHint}.`,
    `- Orchestration: ${rec.orchestration === "solo" ? "handle inline" : rec.orchestration === "parallel" ? "fan out independent work to parallel subagents" : "orchestrate a multi-phase workflow with verification"}.`,
    `- Tokens: ${rec.tokenGuidance}.`,
    rec.level === "ultra"
      ? `- This is your highest gear — be exhaustive and verify your conclusions. Do not under-deliver.`
      : `- Match depth to the task; don't over- or under-invest.`,
    `</effort_adaptation>`,
  ];
  return lines.join("\n");
}
