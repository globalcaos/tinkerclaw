import { describe, it, expect } from "vitest";
import { shouldInjectForcingQuestions, getForcingQuestionsPrompt } from "../forcing-questions.js";

describe("shouldInjectForcingQuestions", () => {
  it("injects for implementation keywords", () => {
    expect(shouldInjectForcingQuestions("implement the new auth flow")).toBe(true);
    expect(shouldInjectForcingQuestions("refactor the database layer")).toBe(true);
    expect(shouldInjectForcingQuestions("debug the login failure")).toBe(true);
  });

  it("injects for long messages", () => {
    expect(shouldInjectForcingQuestions("x".repeat(600))).toBe(true);
  });

  it("injects for multiple file paths", () => {
    expect(
      shouldInjectForcingQuestions("Fix errors in /src/a/b.ts, /src/c/d.ts, and /src/e/f.ts"),
    ).toBe(true);
  });

  it("skips for simple messages", () => {
    expect(shouldInjectForcingQuestions("what time is it?")).toBe(false);
    expect(shouldInjectForcingQuestions("hi")).toBe(false);
  });

  it("skips for heartbeat", () => {
    expect(shouldInjectForcingQuestions("implement X", { trigger: "heartbeat" })).toBe(false);
  });

  it("skips for cron", () => {
    expect(shouldInjectForcingQuestions("implement X", { trigger: "cron" })).toBe(false);
  });

  it("skips for empty message", () => {
    expect(shouldInjectForcingQuestions("")).toBe(false);
  });

  it("skips for very short message", () => {
    expect(shouldInjectForcingQuestions("ok")).toBe(false);
  });
});

describe("getForcingQuestionsPrompt", () => {
  it("contains all 5 questions", () => {
    const text = getForcingQuestionsPrompt();
    expect(text).toContain("SIMPLEST solution");
    expect(text).toContain("existing code/patterns");
    expect(text).toContain("What could go wrong");
    expect(text).toContain("How will I verify");
    expect(text).toContain("What should I NOT touch");
  });
});
