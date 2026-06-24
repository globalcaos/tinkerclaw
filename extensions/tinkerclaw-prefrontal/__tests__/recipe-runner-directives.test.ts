import { describe, it, expect } from "vitest";
import { parseModelDirective, parseThinkingDirective } from "../recipe-runner.js";

describe("per-step model/thinking directives (bible §5.84-A)", () => {
  it("parses leading model: and thinking: directives", () => {
    const body = "model: claude-code/claude-haiku-4-5\nthinking: low\nDo the thing.";
    expect(parseModelDirective(body)).toBe("claude-code/claude-haiku-4-5");
    expect(parseThinkingDirective(body)).toBe("low");
  });
  it("returns undefined when absent", () => {
    expect(parseModelDirective("just a task")).toBeUndefined();
    expect(parseThinkingDirective("just a task")).toBeUndefined();
  });
});
