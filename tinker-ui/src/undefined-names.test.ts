import { describe, expect, it } from "vitest";
import { findUndefinedNames } from "../scripts/undefined-names.mjs";

// vite build does not type-check: a name that was never imported or declared ships and throws a
// ReferenceError when its line runs (2026-11-03: send() threw before painting the prompt and before
// chat.send). The build refuses such a tree (vite.config.ts); this keeps the test suite in step.
describe("tinker-ui undefined names", () => {
  it("calls no name the type checker cannot find", () => {
    const { checked, errors, reason } = findUndefinedNames();
    expect(checked, reason).toBe(true);
    expect(errors).toEqual([]);
  }, 180_000);
});
