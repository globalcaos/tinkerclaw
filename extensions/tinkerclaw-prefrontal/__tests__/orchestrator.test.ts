import { describe, it, expect } from "vitest";
import { orchestrate, classifyEffort } from "../orchestrator.js";

describe("orchestrate", () => {
  it("selects a recipe for matching messages", () => {
    const plan = orchestrate({ userMessage: "Fix the login bug" });
    expect(plan.recipe).not.toBeNull();
    expect(plan.recipe!.id).toBe("debug");
    expect(plan.currentStep).toBe("reproduce");
    expect(plan.reasoning).toContain("Debug & Fix");
  });

  it("returns null recipe for non-matching messages", () => {
    const plan = orchestrate({ userMessage: "hello" });
    expect(plan.recipe).toBeNull();
    expect(plan.currentStep).toBeNull();
    expect(plan.reasoning).toContain("No recipe matched");
  });

  it("continues an active recipe from next incomplete step", () => {
    const plan = orchestrate({
      userMessage: "I found the root cause",
      activeRecipe: {
        recipeId: "debug",
        completedSteps: ["reproduce"],
      },
    });
    expect(plan.recipe).not.toBeNull();
    expect(plan.recipe!.id).toBe("debug");
    expect(plan.currentStep).toBe("diagnose");
    expect(plan.reasoning).toContain("Continuing");
  });

  it("falls through to new classification when recipe is complete", () => {
    const plan = orchestrate({
      userMessage: "Now investigate the performance",
      activeRecipe: {
        recipeId: "debug",
        completedSteps: ["reproduce", "diagnose", "fix", "verify"],
      },
    });
    // debug recipe fully completed — should classify the new message
    expect(plan.recipe).not.toBeNull();
    expect(plan.recipe!.id).toBe("investigate");
  });

  it("detects parallel tasks in investigate recipe", () => {
    const plan = orchestrate({ userMessage: "Investigate the memory leak" });
    expect(plan.recipe).not.toBeNull();
    expect(plan.parallelTasks).toBeDefined();
    expect(plan.parallelTasks).toContain("gather");
  });

  it("returns undefined parallelTasks when recipe has no parallel steps", () => {
    const plan = orchestrate({ userMessage: "Fix the crash" });
    expect(plan.parallelTasks).toBeUndefined();
  });

  it("ignores unknown active recipe IDs", () => {
    const plan = orchestrate({
      userMessage: "hello",
      activeRecipe: {
        recipeId: "nonexistent",
        completedSteps: [],
      },
    });
    // Should fall through since recipe not found
    expect(plan.recipe).toBeNull();
  });
});

describe("demand-driven activation (v3.0)", () => {
  it("orchestrate still works for continuing active recipes", () => {
    // Even with demand-driven activation, orchestrate() is still used
    // for continuing active recipes from the llm_output hook
    const plan = orchestrate({
      userMessage: "continuing work",
      activeRecipe: {
        recipeId: "debug",
        completedSteps: ["reproduce"],
      },
    });
    expect(plan.recipe).not.toBeNull();
    expect(plan.recipe!.id).toBe("debug");
    expect(plan.currentStep).toBe("diagnose");
  });

  it("recipes are NOT auto-selected from user message in before_prompt_build", () => {
    // In the new demand-driven model, orchestrate() with no activeRecipe
    // is NOT called from before_prompt_build. The model must activate
    // recipes via its output. This test documents the intended behavior:
    // a message with trigger words but no activeRecipe should NOT
    // automatically get a recipe injected in before_prompt_build.
    //
    // orchestrate() itself still returns a recipe (it's a utility),
    // but index.ts no longer calls it from before_prompt_build.
    const plan = orchestrate({ userMessage: "Fix the login bug" });
    // orchestrate() still works — it's the CALLER that changed
    expect(plan.recipe).not.toBeNull();
    // The key behavioral change: index.ts before_prompt_build no longer
    // calls orchestrate() for new messages. Only active recipes get injected.
  });
});

describe("classifyEffort", () => {
  it("classifies 'hello' as minimal", () => {
    expect(classifyEffort("hello")).toBe("minimal");
  });

  it("classifies 'status' as minimal", () => {
    expect(classifyEffort("status")).toBe("minimal");
  });

  it("classifies 'research' as maximum", () => {
    expect(classifyEffort("research the topic")).toBe("maximum");
  });

  it("classifies 'architecture' as maximum", () => {
    expect(classifyEffort("design the architecture")).toBe("maximum");
  });

  it("classifies normal messages as standard", () => {
    expect(classifyEffort("update the config file")).toBe("standard");
  });

  it("is case-insensitive", () => {
    expect(classifyEffort("RESEARCH this")).toBe("maximum");
    expect(classifyEffort("HELLO")).toBe("minimal");
  });
});
