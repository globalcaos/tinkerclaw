// extensions/prefrontal/orchestrator.ts
// FORK: Prefrontal v3.0 orchestrator — the "first call" pattern.
// Before the main agent runs, classifies the task, selects a recipe,
// and produces an execution plan. Shares context with the main agent
// so Anthropic's prompt cache makes it nearly free.
//
// Wired in by: index.ts before_prompt_build hook
// Depends on: recipe-engine.ts (selectRecipe, BUILT_IN_RECIPES)

import { type Recipe, BUILT_IN_RECIPES, selectRecipe } from "./recipe-engine.js";

export interface OrchestrationPlan {
  recipe: Recipe | null;
  currentStep: string | null;
  parallelTasks?: string[];
  estimatedEffort: "minimal" | "standard" | "maximum";
  reasoning: string;
}

export interface ActiveRecipeState {
  recipeId: string;
  completedSteps: string[];
}

/**
 * Classify user message and produce an orchestration plan.
 * Runs BEFORE the main agent call.
 */
export function orchestrate(params: {
  userMessage: string;
  sessionHistory?: string[];
  activeRecipe?: ActiveRecipeState | null;
}): OrchestrationPlan {
  // Check if we're continuing an active recipe
  if (params.activeRecipe) {
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === params.activeRecipe!.recipeId);
    if (recipe) {
      const nextStep = recipe.steps.find(
        (s) => !params.activeRecipe!.completedSteps.includes(s.id),
      );
      if (nextStep) {
        return {
          recipe,
          currentStep: nextStep.id,
          estimatedEffort: "standard",
          reasoning: `Continuing ${recipe.name}: step ${nextStep.name}`,
        };
      }
      // Recipe complete — fall through to new classification
    }
  }

  // New task — classify and select recipe
  const recipe = selectRecipe(params.userMessage);

  if (!recipe) {
    return {
      recipe: null,
      currentStep: null,
      estimatedEffort: classifyEffort(params.userMessage),
      reasoning: "No recipe matched -- direct execution",
    };
  }

  const parallelSteps = recipe.steps.filter((s) => s.parallel).map((s) => s.id);

  return {
    recipe,
    currentStep: recipe.steps[0]?.id ?? null,
    parallelTasks: parallelSteps.length > 0 ? parallelSteps : undefined,
    estimatedEffort: classifyEffort(params.userMessage),
    reasoning: `Selected recipe: ${recipe.name} (${recipe.steps.length} steps)`,
  };
}

function classifyEffort(message: string): "minimal" | "standard" | "maximum" {
  const lower = message.toLowerCase();
  const maxKeywords = [
    "research",
    "paper",
    "design",
    "architecture",
    "investigate deeply",
    "analyze thoroughly",
  ];
  const minKeywords = ["what time", "status", "hello", "thanks", "ok"];

  if (maxKeywords.some((k) => lower.includes(k))) {
    return "maximum";
  }
  if (minKeywords.some((k) => lower.includes(k))) {
    return "minimal";
  }
  return "standard";
}

/** Exported for testing. */
export { classifyEffort };
