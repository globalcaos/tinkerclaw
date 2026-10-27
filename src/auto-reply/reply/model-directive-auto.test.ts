import { describe, expect, it } from "vitest";
import { AUTO_MODEL_DIRECTIVE, isAutoModelDirective } from "./model-directive-auto.js";

describe("isAutoModelDirective", () => {
  it("recognises the literal the picker sends, in any case and with surrounding space", () => {
    expect(AUTO_MODEL_DIRECTIVE).toBe("auto");
    expect(isAutoModelDirective("auto")).toBe(true);
    expect(isAutoModelDirective("  AUTO ")).toBe(true);
    expect(isAutoModelDirective("Auto")).toBe(true);
  });

  it("is not fooled by a model whose id merely contains the word", () => {
    expect(isAutoModelDirective("openai/auto")).toBe(false);
    expect(isAutoModelDirective("auto-pilot")).toBe(false);
    expect(isAutoModelDirective("claude-code/claude-opus-5")).toBe(false);
  });

  it("answers false for anything that is not a non-empty string", () => {
    expect(isAutoModelDirective(undefined)).toBe(false);
    expect(isAutoModelDirective(null)).toBe(false);
    expect(isAutoModelDirective("")).toBe(false);
    expect(isAutoModelDirective(42)).toBe(false);
  });
});
