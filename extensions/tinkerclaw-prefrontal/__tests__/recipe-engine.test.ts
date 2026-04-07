import { describe, it, expect } from "vitest";
import { selectRecipe, formatRecipePrompt, BUILT_IN_RECIPES } from "../recipe-engine.js";

describe("selectRecipe", () => {
  it("selects debug recipe for error-related messages", () => {
    const recipe = selectRecipe("There's a bug in the login flow");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("debug");
  });

  it("selects debug recipe for 'crash' messages", () => {
    const recipe = selectRecipe("The gateway crashes on startup");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("debug");
  });

  it("selects debug recipe for 'not working' messages", () => {
    const recipe = selectRecipe("The upload feature is not working");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("debug");
  });

  it("selects feature recipe for 'implement' messages", () => {
    const recipe = selectRecipe("Implement a new REST endpoint for users");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("feature");
  });

  it("selects feature recipe for 'create' messages", () => {
    const recipe = selectRecipe("Create a dashboard component");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("feature");
  });

  it("selects investigate recipe for 'analyze' messages", () => {
    const recipe = selectRecipe("Analyze the memory usage of the gateway");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("investigate");
  });

  it("selects investigate recipe for 'why does' messages", () => {
    const recipe = selectRecipe("Why does the build take so long?");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("investigate");
  });

  it("selects refactor recipe for 'refactor' messages", () => {
    const recipe = selectRecipe("Refactor the auth module to use dependency injection");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("refactor");
  });

  it("selects refactor recipe for 'clean up' messages", () => {
    const recipe = selectRecipe("Clean up the test helpers");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("refactor");
  });

  it("selects review recipe for 'review' messages", () => {
    const recipe = selectRecipe("Review the changes in PR #42");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("review");
  });

  it("selects review recipe for 'code review' messages", () => {
    const recipe = selectRecipe("Do a code review of the auth refactor");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("review");
  });

  it("returns null for irrelevant messages", () => {
    expect(selectRecipe("hello there")).toBeNull();
    expect(selectRecipe("good morning")).toBeNull();
    expect(selectRecipe("12345")).toBeNull();
  });

  it("prefers longer trigger matches (more specific)", () => {
    // "not working" (11 chars) should beat "fix" (3 chars) — both in debug
    const recipe = selectRecipe("The button is not working, please fix it");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("debug");
  });

  it("is case-insensitive", () => {
    const recipe = selectRecipe("INVESTIGATE the memory leak");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("investigate");
  });
});

describe("formatRecipePrompt", () => {
  const debugRecipe = BUILT_IN_RECIPES.find((r) => r.id === "debug")!;

  it("includes recipe name in header", () => {
    const prompt = formatRecipePrompt(debugRecipe);
    expect(prompt).toContain("Active Recipe: Debug & Fix");
  });

  it("includes recipe description", () => {
    const prompt = formatRecipePrompt(debugRecipe);
    expect(prompt).toContain("reproduce");
    expect(prompt).toContain("diagnose");
  });

  it("marks current step when provided", () => {
    const prompt = formatRecipePrompt(debugRecipe, "diagnose");
    expect(prompt).toContain("(CURRENT)");
    expect(prompt).toContain("-> diagnose");
  });

  it("includes success criteria", () => {
    const prompt = formatRecipePrompt(debugRecipe);
    expect(prompt).toContain("Done when:");
  });

  it("includes follow-the-recipe instruction", () => {
    const prompt = formatRecipePrompt(debugRecipe);
    expect(prompt).toContain("Follow this recipe step by step");
  });
});

describe("BUILT_IN_RECIPES", () => {
  it("has 5 built-in recipes", () => {
    expect(BUILT_IN_RECIPES).toHaveLength(5);
  });

  it("all recipes have non-empty triggers", () => {
    for (const recipe of BUILT_IN_RECIPES) {
      expect(recipe.triggers.length).toBeGreaterThan(0);
    }
  });

  it("all recipes have at least 2 steps", () => {
    for (const recipe of BUILT_IN_RECIPES) {
      expect(recipe.steps.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("investigate recipe has parallel steps", () => {
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === "investigate")!;
    const parallelSteps = recipe.steps.filter((s) => s.parallel);
    expect(parallelSteps.length).toBeGreaterThan(0);
    expect(parallelSteps[0].id).toBe("gather");
  });

  it("all step IDs are unique within each recipe", () => {
    for (const recipe of BUILT_IN_RECIPES) {
      const ids = recipe.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
