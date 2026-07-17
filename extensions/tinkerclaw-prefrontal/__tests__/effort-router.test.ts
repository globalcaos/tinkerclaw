import { describe, it, expect } from "vitest";
import { classifyEffort } from "../effort-router.js";

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
