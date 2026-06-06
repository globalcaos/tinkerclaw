/**
 * SS2a (2026-06-06): when:/return:/done: directive parsing + order independence.
 * Target: recipe-runner.ts (parseWhenDirective / parseEarlyExitDirective / leadingDirectives cap) + recipe-types.ts (OTHER_DIRECTIVE_RE).
 * Bible anchor: subagents-and-recipes.md (SS2 verify: block).
 * Bug-history: SS3 directive-order independence must survive — when: before out: must not break out: parsing.
 * Catches: a directive treated as prose; the old >=3 leading-directive cap dropping a 4th directive.
 */
import { describe, it, expect } from "vitest";
import { parseWhenDirective, parseEarlyExitDirective } from "../recipe-runner.js";
import { parseStepIoDirectives } from "../recipe-types.js";

describe("SS2a directive parsing", () => {
  it("parses a leading when: expression", () => {
    expect(parseWhenDirective("when: steps.1.out.passed == false\n\nDo the thing.")).toBe(
      "steps.1.out.passed == false",
    );
    expect(parseWhenDirective("Just prose, no directive.")).toBeUndefined();
  });

  it("detects a bare return:/done: early-exit marker, but not prose starting with done:", () => {
    expect(parseEarlyExitDirective("return:\n\nWrap up.")).toBe(true);
    expect(parseEarlyExitDirective("done:\n\nWrap up.")).toBe(true);
    expect(parseEarlyExitDirective("done: ship it tomorrow")).toBe(false);
    expect(parseEarlyExitDirective("Normal step.")).toBe(false);
  });

  it("keeps out: parsing when a when: directive leads the body (order independence)", () => {
    const io = parseStepIoDirectives('when: steps.1.out.ok == true\nout: {"type":"object"}');
    expect(io.out).toEqual({ type: "object" });
  });

  it("collects more than three leading directives (no frozen cap)", () => {
    const body = "when: steps.1.out.a == true\nreturn:\nuses: foo\nloop: count 2\n\nProse.";
    expect(parseWhenDirective(body)).toBe("steps.1.out.a == true");
    expect(parseEarlyExitDirective(body)).toBe(true);
  });
});

import { checkWhenRefs, type CompileStep } from "../recipe-runner.js";

describe("checkWhenRefs (seed-time)", () => {
  const producer: CompileStep = {
    title: "p",
    out: { type: "object", properties: { passed: { type: "boolean" } } },
  };

  it("accepts a when: that references a prior declared field", () => {
    const steps: CompileStep[] = [producer, { title: "c", when: "steps.1.out.passed == true" }];
    expect(checkWhenRefs(steps)).toEqual([]);
  });

  it("rejects a forward / self reference", () => {
    const steps: CompileStep[] = [{ title: "a", when: "steps.2.out.x == 1" }, producer];
    expect(checkWhenRefs(steps).join()).toMatch(/must precede it/);
  });

  it("rejects a reference to a step that declares no out: schema", () => {
    const steps: CompileStep[] = [{ title: "a" }, { title: "b", when: "steps.1.out.x == 1" }];
    expect(checkWhenRefs(steps).join()).toMatch(/declares no out:/);
  });

  it("rejects a reference to an undeclared field", () => {
    const steps: CompileStep[] = [producer, { title: "c", when: "steps.1.out.NOPE == true" }];
    expect(checkWhenRefs(steps).join()).toMatch(/has no field "NOPE"/);
  });
});
