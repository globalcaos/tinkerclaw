import { describe, it, expect } from "vitest";
import {
  classifyEffort,
  validateModelAssignment,
  DEFAULT_EFFORT_ROUTING_CONFIG,
} from "../effort-router.js";

describe("classifyEffort", () => {
  it("classifies short simple messages as minimal", () => {
    expect(classifyEffort("format this json")).toBe("minimal");
    expect(classifyEffort("hello")).toBe("minimal");
    expect(classifyEffort("what time is it?")).toBe("minimal");
  });

  it("classifies architecture tasks as maximum", () => {
    expect(classifyEffort("architect the new auth system")).toBe("maximum");
    expect(classifyEffort("debug complex race condition in the queue")).toBe("maximum");
    expect(classifyEffort("security review of the API endpoints")).toBe("maximum");
  });

  it("classifies regular coding as standard", () => {
    expect(classifyEffort("add a new endpoint for user profiles")).toBe("standard");
    expect(classifyEffort("fix the login button color")).toBe("standard");
    expect(classifyEffort("write tests for the auth module")).toBe("standard");
  });

  it("long messages with minimal keywords still classify as standard", () => {
    const long = "Please format " + "x".repeat(100);
    expect(classifyEffort(long)).toBe("standard");
  });
});

describe("validateModelAssignment", () => {
  const config = DEFAULT_EFFORT_ROUTING_CONFIG;

  it("approves Opus for maximum-effort tasks", () => {
    const result = validateModelAssignment(
      "anthropic/claude-opus-4-6",
      "architect the database layer",
      config,
    );
    expect(result.approved).toBe(true);
  });

  it("rejects Opus for minimal-effort tasks", () => {
    const result = validateModelAssignment("anthropic/claude-opus-4-6", "hello", config);
    expect(result.approved).toBe(false);
    expect(result.suggestedModel).toContain("haiku");
  });

  it("rejects Opus for standard-effort tasks", () => {
    const result = validateModelAssignment(
      "anthropic/claude-opus-4-6",
      "add a user profile endpoint",
      config,
    );
    expect(result.approved).toBe(false);
    expect(result.suggestedModel).toContain("sonnet");
  });

  it("approves Sonnet for standard tasks", () => {
    const result = validateModelAssignment(
      "anthropic/claude-sonnet-4-6",
      "add a user profile endpoint",
      config,
    );
    expect(result.approved).toBe(true);
  });

  it("approves Haiku for minimal tasks", () => {
    const result = validateModelAssignment("anthropic/claude-haiku-4-5", "hello", config);
    expect(result.approved).toBe(true);
  });

  it("approves everything when disabled", () => {
    const result = validateModelAssignment("anthropic/claude-opus-4-6", "hello", {
      ...config,
      enabled: false,
    });
    expect(result.approved).toBe(true);
  });

  it("provides reason when rejecting", () => {
    const result = validateModelAssignment("anthropic/claude-opus-4-6", "format this", config);
    expect(result.reason).toContain("wasteful");
  });
});
