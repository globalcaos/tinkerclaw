/**
 * SS2a (2026-06-06): pure `when:` guard evaluator.
 * Target: when-eval.ts (evaluateWhen / collectWhenRefs / WhenEvalError).
 * Bible anchor: subagents-and-recipes.md (SS2 verify: block).
 * Bug-history: first SS2 control-flow tests — the evaluator must be a tiny grammar, never JS eval.
 * Catches: a guard that silently passes on a missing ref; comparison/boolean/not mis-evaluation.
 */
import { describe, it, expect } from "vitest";
import { evaluateWhen, collectWhenRefs, WhenEvalError } from "../when-eval.js";

const outs = (m: Record<number, unknown>) =>
  new Map<number, unknown>(Object.entries(m).map(([k, v]) => [Number(k), v]));

describe("evaluateWhen", () => {
  it("compares a boolean field with ==", () => {
    const o = outs({ 1: { passed: false } });
    expect(evaluateWhen("steps.1.out.passed == false", o)).toBe(true);
    expect(evaluateWhen("steps.1.out.passed == true", o)).toBe(false);
  });

  it("supports != and numeric comparisons", () => {
    const o = outs({ 1: { count: 3 } });
    expect(evaluateWhen("steps.1.out.count != 0", o)).toBe(true);
    expect(evaluateWhen("steps.1.out.count > 2", o)).toBe(true);
    expect(evaluateWhen("steps.1.out.count >= 3", o)).toBe(true);
    expect(evaluateWhen("steps.1.out.count < 3", o)).toBe(false);
  });

  it("composes with and / or with and binding tighter than or", () => {
    const o = outs({ 1: { passed: true, score: 10 } });
    expect(evaluateWhen("steps.1.out.passed == true and steps.1.out.score > 5", o)).toBe(true);
    expect(evaluateWhen("steps.1.out.passed == false or steps.1.out.score > 5", o)).toBe(true);
    expect(evaluateWhen("steps.1.out.passed == false and steps.1.out.score > 5", o)).toBe(false);
  });

  it("supports a not prefix and a bare truthiness operand", () => {
    const o = outs({ 1: { ready: true, blocked: false } });
    expect(evaluateWhen("not steps.1.out.blocked", o)).toBe(true);
    expect(evaluateWhen("steps.1.out.ready", o)).toBe(true);
    expect(evaluateWhen("not steps.1.out.ready", o)).toBe(false);
  });

  it("compares string literals", () => {
    const o = outs({ 1: { status: "green" } });
    expect(evaluateWhen('steps.1.out.status == "green"', o)).toBe(true);
    expect(evaluateWhen('steps.1.out.status == "red"', o)).toBe(false);
  });

  it("throws WhenEvalError when a referenced step has no output yet", () => {
    expect(() => evaluateWhen("steps.2.out.passed == true", outs({ 1: { passed: true } }))).toThrow(
      WhenEvalError,
    );
  });

  it("throws WhenEvalError on an operand that is neither a ref nor a JSON literal", () => {
    expect(() => evaluateWhen("steps.1.out.x == bogus", outs({ 1: { x: 1 } }))).toThrow(
      WhenEvalError,
    );
  });

  it("collectWhenRefs extracts every steps.<n>.out reference", () => {
    expect(collectWhenRefs("steps.1.out.passed == true and steps.3.out.count > 0")).toEqual([
      "steps.1.out.passed",
      "steps.3.out.count",
    ]);
    expect(collectWhenRefs('steps.2.out.status == "green"')).toEqual(["steps.2.out.status"]);
  });
});
