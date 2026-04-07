// extensions/prefrontal/recipe-engine.ts
// FORK: Prefrontal v3.0 recipe execution engine — selects and manages
// structured workflows for agent tasks. Matches user intent to built-in
// recipes (debug, feature, investigate, refactor, review) and formats
// step-by-step prompts for injection into the agent context.
//
// Wired in by: orchestrator.ts (selectRecipe, formatRecipePrompt)
// Used from: index.ts before_prompt_build hook

export type RecipeStep = {
  id: string;
  name: string;
  description: string;
  requiredTools?: string[];
  precondition?: string;
  successCriteria?: string;
  parallel?: boolean;
};

export type Recipe = {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  steps: RecipeStep[];
};

export const BUILT_IN_RECIPES: Recipe[] = [
  {
    id: "debug",
    name: "Debug & Fix",
    description: "Systematic debugging: reproduce → diagnose → fix → verify",
    triggers: ["bug", "error", "crash", "broken", "not working", "fails", "exception", "fix"],
    steps: [
      {
        id: "reproduce",
        name: "Reproduce",
        description: "Read error logs/messages, understand the failure",
        requiredTools: ["Read", "Grep", "Bash"],
        precondition: "Have error description",
        successCriteria: "Can describe the exact failure",
      },
      {
        id: "diagnose",
        name: "Diagnose",
        description: "Trace the root cause through code",
        requiredTools: ["Read", "Grep", "Glob"],
        precondition: "Failure reproduced",
        successCriteria: "Root cause identified with file:line",
      },
      {
        id: "fix",
        name: "Fix",
        description: "Apply the minimal fix",
        requiredTools: ["Edit", "Write"],
        precondition: "Root cause known",
        successCriteria: "Code changed",
      },
      {
        id: "verify",
        name: "Verify",
        description: "Run tests, verify the fix",
        requiredTools: ["Bash"],
        precondition: "Fix applied",
        successCriteria: "Tests pass, error gone",
      },
    ],
  },
  {
    id: "feature",
    name: "Build Feature",
    description: "Explore → design → test → implement → verify",
    triggers: ["add", "create", "build", "implement", "new feature", "make it"],
    steps: [
      {
        id: "explore",
        name: "Explore",
        description: "Read existing code, understand patterns",
        requiredTools: ["Read", "Grep", "Glob"],
        successCriteria: "Understand codebase structure",
      },
      {
        id: "design",
        name: "Design",
        description: "Plan the approach, identify files to change",
        successCriteria: "Clear plan with file list",
      },
      {
        id: "test",
        name: "Write Tests",
        description: "Write failing tests first (TDD)",
        requiredTools: ["Write"],
        successCriteria: "Tests exist and fail",
      },
      {
        id: "implement",
        name: "Implement",
        description: "Write the minimal code to pass tests",
        requiredTools: ["Edit", "Write"],
        successCriteria: "Tests pass",
      },
      {
        id: "verify",
        name: "Verify",
        description: "Run full test suite, check for regressions",
        requiredTools: ["Bash"],
        successCriteria: "All tests pass",
      },
    ],
  },
  {
    id: "investigate",
    name: "Investigate",
    description: "Gather information, analyze, report findings",
    triggers: [
      "investigate",
      "analyze",
      "check",
      "look into",
      "find out",
      "what is",
      "why does",
      "how does",
    ],
    steps: [
      {
        id: "scope",
        name: "Scope",
        description: "Understand what we're looking for",
        successCriteria: "Clear question defined",
      },
      {
        id: "gather",
        name: "Gather",
        description: "Read files, search code, check logs",
        requiredTools: ["Read", "Grep", "Glob", "Bash"],
        parallel: true,
        successCriteria: "Evidence collected",
      },
      {
        id: "analyze",
        name: "Analyze",
        description: "Synthesize findings into an answer",
        successCriteria: "Answer with evidence",
      },
      {
        id: "report",
        name: "Report",
        description: "Present findings clearly",
        successCriteria: "Concise report delivered",
      },
    ],
  },
  {
    id: "refactor",
    name: "Refactor",
    description: "Improve code structure without changing behavior",
    triggers: ["refactor", "clean up", "restructure", "reorganize", "simplify"],
    steps: [
      {
        id: "understand",
        name: "Understand",
        description: "Read the code, identify what to change",
        requiredTools: ["Read", "Grep"],
        successCriteria: "Current structure understood",
      },
      {
        id: "test-baseline",
        name: "Baseline Tests",
        description: "Ensure tests exist and pass before changes",
        requiredTools: ["Bash"],
        successCriteria: "Tests pass",
      },
      {
        id: "refactor",
        name: "Refactor",
        description: "Apply structural changes",
        requiredTools: ["Edit"],
        successCriteria: "Code restructured",
      },
      {
        id: "verify",
        name: "Verify",
        description: "Run tests, confirm behavior unchanged",
        requiredTools: ["Bash"],
        successCriteria: "All tests still pass",
      },
    ],
  },
  {
    id: "review",
    name: "Code Review",
    description: "Review changes for correctness, security, and quality",
    triggers: ["review", "check this", "look at this PR", "code review"],
    steps: [
      {
        id: "diff",
        name: "Read Changes",
        description: "Read the diff or changed files",
        requiredTools: ["Read", "Bash"],
        successCriteria: "All changes read",
      },
      {
        id: "context",
        name: "Understand Context",
        description: "Read surrounding code for context",
        requiredTools: ["Read", "Grep"],
        successCriteria: "Context understood",
      },
      {
        id: "assess",
        name: "Assess",
        description: "Check correctness, security, style",
        successCriteria: "Issues identified",
      },
      {
        id: "report",
        name: "Report",
        description: "Present review findings",
        successCriteria: "Review delivered",
      },
    ],
  },
];

/**
 * Classify user intent and select a recipe.
 * Returns null if no recipe matches (agent handles it directly).
 */
export function selectRecipe(userMessage: string): Recipe | null {
  const lower = userMessage.toLowerCase();
  let bestMatch: Recipe | null = null;
  let bestScore = 0;

  for (const recipe of BUILT_IN_RECIPES) {
    let score = 0;
    for (const trigger of recipe.triggers) {
      if (lower.includes(trigger)) {
        score += trigger.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = recipe;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

/**
 * Format a recipe as a structured prompt injection for the agent.
 */
export function formatRecipePrompt(recipe: Recipe, currentStep?: string): string {
  const lines: string[] = [
    `## Active Recipe: ${recipe.name}`,
    `**Goal:** ${recipe.description}`,
    "",
    "### Steps:",
  ];

  for (const step of recipe.steps) {
    const marker = step.id === currentStep ? "-> " : "   ";
    const status = step.id === currentStep ? "(CURRENT)" : "";
    lines.push(`${marker}${step.id}. **${step.name}** -- ${step.description} ${status}`);
    if (step.successCriteria) {
      lines.push(`    Done when: ${step.successCriteria}`);
    }
  }

  lines.push("");
  lines.push(
    "**Follow this recipe step by step. Do not skip steps. Report completion of each step before moving to the next.**",
  );

  return lines.join("\n");
}
