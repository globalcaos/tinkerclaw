// extensions/prefrontal/recipe-engine.ts
// FORK: Prefrontal v3.0 recipe execution engine — selects and manages
// structured workflows for agent tasks. Matches user intent to built-in
// recipes (debug, feature, investigate, refactor, review, and 12 more) and
// formats step-by-step prompts for injection into the agent context.
//
// Recipes are loaded from disk (recipes/ directory, YAML frontmatter + markdown)
// with hardcoded fallback if disk loading fails.
//
// Wired in by: orchestrator.ts (selectRecipe, formatRecipePrompt)
// Used from: index.ts before_prompt_build hook

import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

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

/** Parse YAML frontmatter from a recipe markdown file. */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2];
  const meta: Record<string, unknown> = {};

  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays: [item1, item2, "item 3"]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }

    meta[key] = value;
  }

  return { meta, body };
}

/** Extract steps from the markdown body of a recipe file. */
function parseStepsFromBody(body: string): RecipeStep[] {
  const steps: RecipeStep[] = [];
  // Match ### N. StepName patterns
  const stepPattern = /### \d+\.\s+(.+)\n([\s\S]*?)(?=### \d+\.|## Constraints|## Safety|## Failures|## When|$)/g;
  let match: RegExpExecArray | null;

  while ((match = stepPattern.exec(body)) !== null) {
    const name = match[1].trim();
    const content = match[2].trim();
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");

    // Extract tools line
    const toolsMatch = content.match(/\*\*Tools:\*\*\s*(.+)/);
    const requiredTools = toolsMatch
      ? toolsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;

    // Extract done-when line
    const doneMatch = content.match(/\*\*Done when:\*\*\s*(.+)/);
    const successCriteria = doneMatch ? doneMatch[1].trim() : undefined;

    // First paragraph after metadata lines is the description
    const descLines = content
      .split("\n")
      .filter((l) => !l.startsWith("**Tools:") && !l.startsWith("**Done when:") && l.trim())
      .slice(0, 2);
    const description = descLines.join(" ").trim() || name;

    steps.push({
      id,
      name,
      description,
      ...(requiredTools && { requiredTools }),
      ...(successCriteria && { successCriteria }),
    });
  }

  return steps;
}

/** Convert a parsed recipe file into a Recipe object. */
function fileToRecipe(meta: Record<string, unknown>, body: string): Recipe | null {
  const id = meta.id as string;
  const name = (meta.title as string) || id;
  const description = (meta.summary as string) || "";
  const triggers = (meta.triggers as string[]) || [];

  if (!id || triggers.length === 0) return null;

  const steps = parseStepsFromBody(body);
  if (steps.length === 0) return null;

  return { id, name, description, triggers, steps };
}

/**
 * Load all recipe .md files from the recipes/ subdirectories.
 * Returns parsed Recipe objects for each valid file found.
 */
export function loadRecipesFromDisk(recipesDir?: string): Recipe[] {
  const dir = recipesDir || join(__dirname, "recipes");
  const recipes: Recipe[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(entryPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Read .md files in subdirectory
        try {
          const files = readdirSync(entryPath);
          for (const file of files) {
            if (!file.endsWith(".md")) continue;
            try {
              const content = readFileSync(join(entryPath, file), "utf-8");
              const parsed = parseFrontmatter(content);
              if (!parsed) continue;
              const recipe = fileToRecipe(parsed.meta, parsed.body);
              if (recipe) recipes.push(recipe);
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Skip unreadable directories
        }
      } else if (entry.endsWith(".md") && entry !== "CATALOG.md") {
        // Top-level recipe file
        try {
          const content = readFileSync(entryPath, "utf-8");
          const parsed = parseFrontmatter(content);
          if (!parsed) continue;
          const recipe = fileToRecipe(parsed.meta, parsed.body);
          if (recipe) recipes.push(recipe);
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Directory not found or unreadable — fall through to empty
  }

  return recipes;
}

// ─── Hardcoded fallback recipes ───────────────────────────────────────────────
// Used when disk loading fails or returns no recipes.

const HARDCODED_RECIPES: Recipe[] = [
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

// ─── Recipe loading ───────────────────────────────────────────────────────────

let _loadedRecipes: Recipe[] | null = null;

/**
 * Get all available recipes. Loads from disk on first call, falls back to
 * hardcoded recipes if disk loading fails or returns nothing.
 */
function getRecipes(): Recipe[] {
  if (_loadedRecipes !== null) return _loadedRecipes;

  const diskRecipes = loadRecipesFromDisk();
  if (diskRecipes.length > 0) {
    _loadedRecipes = diskRecipes;
  } else {
    _loadedRecipes = HARDCODED_RECIPES;
  }

  return _loadedRecipes;
}

/** Force reload recipes from disk (e.g. after adding new recipe files). */
export function reloadRecipes(): void {
  _loadedRecipes = null;
}

/**
 * Exported recipe list. Uses getter to ensure lazy loading.
 * For backward compatibility, this is a const that delegates to getRecipes().
 */
export const BUILT_IN_RECIPES: Recipe[] = new Proxy([] as Recipe[], {
  get(target, prop, receiver) {
    const recipes = getRecipes();
    if (prop === "length") return recipes.length;
    if (prop === Symbol.iterator) return recipes[Symbol.iterator].bind(recipes);
    if (typeof prop === "string" && !isNaN(Number(prop))) return recipes[Number(prop)];
    if (typeof prop === "string" && prop in Array.prototype) {
      const val = (recipes as unknown as Record<string, unknown>)[prop];
      if (typeof val === "function") return val.bind(recipes);
      return val;
    }
    return Reflect.get(recipes, prop, receiver);
  },
});

/**
 * Classify user intent and select a recipe.
 * Returns null if no recipe matches (agent handles it directly).
 */
export function selectRecipe(userMessage: string): Recipe | null {
  const lower = userMessage.toLowerCase();
  const recipes = getRecipes();
  let bestMatch: Recipe | null = null;
  let bestScore = 0;

  for (const recipe of recipes) {
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

/**
 * Check whether a tool is allowed by the current recipe step's requiredTools list.
 * Returns true if no restriction exists (step has no requiredTools) or the tool is listed.
 */
export function isToolAllowedByCurrentStep(
  recipe: Recipe,
  currentStepId: string,
  toolName: string,
): boolean {
  const step = recipe.steps.find((s) => s.id === currentStepId);
  if (!step || !step.requiredTools || step.requiredTools.length === 0) return true;
  return step.requiredTools.includes(toolName) || step.requiredTools.includes(toolName.toLowerCase());
}

/**
 * Detect recipe activation patterns in model output text.
 * Returns the recipe ID if the model is requesting a recipe, null otherwise.
 */
export function detectRecipeActivation(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  const lower = text.toLowerCase();

  // Patterns: "following the X recipe", "using the X recipe",
  // "X recipe step", "starting the X workflow", "activating the X recipe"
  const patterns = [
    /following the ([\w-]+) recipe/,
    /using the ([\w-]+) recipe/,
    /([\w-]+) recipe step/,
    /starting the ([\w-]+) (?:recipe|workflow)/,
    /activating the ([\w-]+) recipe/,
  ];

  const recipes = getRecipes();
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) {
      const candidateId = match[1];
      const recipe = recipes.find((r) => r.id === candidateId);
      if (recipe) return recipe.id;
    }
  }

  return null;
}
