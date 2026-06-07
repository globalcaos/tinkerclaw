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

import {
  buildRecipeMd,
  validateRecipeSpec,
  type RecipeSpec,
  type RecipeParamSpec,
} from "../recipe-author.js";
import { parseRecipeMd } from "../recipe-parse.js";

function baseSpec(params?: Record<string, RecipeParamSpec>): RecipeSpec {
  const spec: RecipeSpec = {
    slug: "p-test",
    title: "Param Test",
    summary: "A recipe for param round-trip tests.",
    tags: ["test"],
    steps: [{ title: "Only step", body: "Do the thing." }],
  };
  if (params) spec.params = params;
  return spec;
}

describe("SS-params frontmatter round-trip", () => {
  it("round-trips all 5 param types through build → parse", () => {
    const params: Record<string, RecipeParamSpec> = {
      repo: { type: "string", required: true, description: "the repo" },
      pattern_str: { type: "string", default: "abc", pattern: "^[a-z]+$" },
      count: { type: "number", default: 3 },
      verbose: { type: "boolean", default: false },
      mode: { type: "enum", enum: ["fast", "slow"], default: "fast" },
      domains: { type: "list<string>", default: ["a.com", "b.com"] },
    };
    const md = buildRecipeMd(baseSpec(params));
    const parsed = parseRecipeMd(md);
    expect(parsed.params).toEqual(params);
  });

  it("strips a secret:true param's default from the emitted .md (PII boundary)", () => {
    const params: Record<string, RecipeParamSpec> = {
      api_key: { type: "string", secret: true, default: "sk-LEAK-123", description: "the key" },
    };
    const md = buildRecipeMd(baseSpec(params));
    expect(md).not.toContain("sk-LEAK-123");
    expect(md).toContain("secret: true");
    const parsed = parseRecipeMd(md);
    expect(parsed.params?.api_key.default).toBeUndefined();
    expect(parsed.params?.api_key.secret).toBe(true);
  });

  it("builds + parses byte-identically when there are NO params (overlay-not-delete)", () => {
    const md = buildRecipeMd(baseSpec());
    expect(md).not.toContain("params:");
    const parsed = parseRecipeMd(md);
    expect(parsed.params).toBeUndefined();
    // baseline build is unchanged by the params feature
    expect(buildRecipeMd(baseSpec())).toBe(md);
  });
});

describe("validateRecipeSpec params validation", () => {
  it("accepts a well-formed params block", () => {
    const r = validateRecipeSpec(
      baseSpec({
        repo: { type: "string", required: true },
        mode: { type: "enum", enum: ["a", "b"], default: "a" },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects an unknown param type", () => {
    const r = validateRecipeSpec(
      baseSpec({ x: { type: "date" as unknown as RecipeParamSpec["type"] } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/must be one of/);
  });

  it("rejects a reserved param name (item)", () => {
    const r = validateRecipeSpec(baseSpec({ item: { type: "string" } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/reserved name/);
  });

  it("rejects required + default together", () => {
    const r = validateRecipeSpec(baseSpec({ x: { type: "string", required: true, default: "y" } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/mutually exclusive/);
  });

  it("rejects a type-mismatched default", () => {
    const r = validateRecipeSpec(
      baseSpec({ n: { type: "number", default: "not-a-number" as unknown as number } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/finite number/);
  });

  it("rejects an enum type without an enum list", () => {
    const r = validateRecipeSpec(baseSpec({ e: { type: "enum" } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/non-empty string\[\]/);
  });

  it("rejects a non-string pattern type and an uncompilable pattern", () => {
    const badType = validateRecipeSpec(baseSpec({ n: { type: "number", pattern: "^\\d+$" } }));
    expect(badType.ok).toBe(false);
    expect(badType.errors.join()).toMatch(/only allowed when type is "string"/);
    const badRe = validateRecipeSpec(baseSpec({ s: { type: "string", pattern: "([" } }));
    expect(badRe.ok).toBe(false);
    expect(badRe.errors.join()).toMatch(/not a valid RegExp/);
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
