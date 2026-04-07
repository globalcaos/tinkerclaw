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
