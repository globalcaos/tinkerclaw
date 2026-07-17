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

// FORK 2026-06-22: quota-headroom bias. When the weekly token quota is mostly
// unspent (e.g. Monday morning, ~100% left) the owner wants the auto-allocator to
// "go aggressive in choosing both model and effort on the fly" — so a high
// headroom bumps every non-trivial turn up one gear, and a tight quota pulls it
// down one. Pure acks/greetings (trivial) are never escalated: spending opus on
// "thanks" is waste, not aggression. The bias is an input, not a guess — it is
// fed from real headroom via PREFRONTAL_EFFORT_BIAS (default neutral).
export type EffortBias = "conservative" | "neutral" | "aggressive";

const TIER_ORDER: ComplexityLevel[] = ["trivial", "standard", "deep", "ultra"];

function applyEffortBias(level: ComplexityLevel, bias: EffortBias): ComplexityLevel {
  if (bias === "neutral" || level === "trivial") return level;
  const i = TIER_ORDER.indexOf(level);
  if (bias === "aggressive") return TIER_ORDER[Math.min(TIER_ORDER.length - 1, i + 1)];
  // conservative: pull down a gear but never below standard for real work.
  return TIER_ORDER[Math.max(1, i - 1)];
}

/** Read the active headroom bias from env. Default neutral (behavior unchanged). */
export function resolveEffortBias(): EffortBias {
  const raw = (process.env.PREFRONTAL_EFFORT_BIAS ?? "").trim().toLowerCase();
  return raw === "aggressive" || raw === "conservative" ? raw : "neutral";
}

export interface ComplexitySignals {
  words: number;
  clauses: number;
  hasCode: boolean;
  hasPaths: boolean;
  deepHits: string[];
  ultraHits: string[];
  trivialHit: boolean;
  questionsAsked: number;
  /**
   * FORK 2026-06-25 ("Branch" layer, frontopolar / BA10 cognitive-branching):
   * how many DISTINCT independent asks the one prompt bundles. ≥2 ⇒ the turn
   * should split into one subagent per ask instead of running them serially.
   */
  independentAsks: number;
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

// Imperative action verbs that head a request. Used to tell apart a real
// second ask ("…and write the tests") from a noun conjunction ("code and
// workflows") or an infinitive ("to spin subagents"), which must NOT count.
const ACTION_VERBS = new Set([
  "add",
  "update",
  "fix",
  "create",
  "write",
  "build",
  "rebuild",
  "refactor",
  "remove",
  "delete",
  "drop",
  "rename",
  "implement",
  "make",
  "change",
  "modify",
  "move",
  "generate",
  "draft",
  "send",
  "name",
  "tell",
  "inform",
  "explain",
  "describe",
  "review",
  "test",
  "document",
  "investigate",
  "research",
  "audit",
  "analyze",
  "analyse",
  "compare",
  "plan",
  "design",
  "optimize",
  "optimise",
  "summarize",
  "summarise",
  "list",
  "find",
  "search",
  "check",
  "verify",
  "publish",
  "post",
  "deploy",
  "wire",
  "hook",
  "install",
  "setup",
  "configure",
  "translate",
  "render",
  "show",
  "give",
  "propose",
  "suggest",
  "let",
]);

/**
 * Count the DISTINCT independent asks bundled into one prompt — the signal the
 * "Branch" layer keys on to fan out one subagent per ask. A segment counts only
 * when an imperative action verb LEADS it (first 3 tokens), so noun
 * conjunctions and infinitives don't inflate the count. Conservative by design:
 * undercounting just means inline handling; overcounting would spam subagents.
 */
function countIndependentAsks(prompt: string): number {
  const segments = prompt
    .split(/(?:[.!?\n]+|^\s*[-*\d]+[.)]\s+|;|\bthen\b|\balso\b| and )/gi)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let asks = 0;
  for (const seg of segments) {
    const head = (seg.toLowerCase().match(/[a-z']+/g) ?? []).slice(0, 3);
    if (head.some((w) => ACTION_VERBS.has(w))) asks += 1;
  }
  return asks;
}

export function classifyComplexity(
  prompt: string,
  bias: EffortBias = "neutral",
): EffortRecommendation {
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
  const independentAsks = countIndependentAsks(prompt);

  const signals: ComplexitySignals = {
    words,
    clauses,
    hasCode,
    hasPaths,
    deepHits,
    ultraHits,
    trivialHit,
    questionsAsked,
    independentAsks,
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

  // Quota-headroom bias: shift the whole turn up/down a gear when the weekly
  // token budget is flush/tight. Applied last so it composes on the final tier.
  level = applyEffortBias(level, bias);

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
export function buildEffortGuidance(
  prompt: string,
  bias: EffortBias = resolveEffortBias(),
): string | null {
  const rec = classifyComplexity(prompt, bias);
  if (rec.level === "trivial") return null;
  const biasNote =
    bias === "aggressive"
      ? ` (quota-headroom bias: AGGRESSIVE — weekly budget is flush, so this turn is bumped up a gear; lean into the stronger model / more thinking on the fly)`
      : bias === "conservative"
        ? ` (quota-headroom bias: CONSERVATIVE — weekly budget is tight, pulled down a gear)`
        : "";
  const lines = [
    `<effort_adaptation level="${rec.level}" score="${rec.score}" bias="${bias}">`,
    `This turn was auto-classified **${rec.level}**${biasNote}. Adapt your reasoning accordingly:`,
    `- Reasoning: ${rec.thinkingHint}.`,
    `- Orchestration: ${rec.orchestration === "solo" ? "handle inline" : rec.orchestration === "parallel" ? "fan out independent work to parallel subagents" : "orchestrate a multi-phase workflow with verification"}.`,
    `- Tokens: ${rec.tokenGuidance}.`,
    rec.level === "ultra"
      ? `- This is your highest gear — be exhaustive and verify your conclusions. Do not under-deliver.`
      : `- Match depth to the task; don't over- or under-invest.`,
    `</effort_adaptation>`,
  ];
  // "Branch" layer (frontopolar / BA10 cognitive-branching): when one prompt
  // bundles ≥2 independent asks, override the solo default and fan out one
  // subagent per ask instead of doing them serially in this turn.
  const asks = rec.signals.independentAsks;
  if (asks >= 2) {
    lines.push(
      `<branch_decompose asks="${asks}">`,
      `This single prompt bundles **${asks} independent asks**. Do NOT handle them serially in one turn.`,
      `- Split into one subagent per ask and run them concurrently. Independent multi-file EDITS → ORCA (parallel-implement workflow); research / multi-domain / mixed work → an \`openclaw-orchestrate\` dynamic workflow (parallel/pipeline).`,
      `- Pick each unit's model by its OWN weight (haiku breadth → sonnet middle → opus hard); a light ask shouldn't ride the heaviest model just because a sibling ask is hard.`,
      `- Synthesize the unit results into ONE coherent answer; verify on the merged result before claiming done.`,
      `- If the asks share state or must run in order, say so and handle inline instead — don't force a fan-out that doesn't parallelize.`,
      `</branch_decompose>`,
    );
  }
  return lines.join("\n");
}
