/**
 * SS-params (2026-06-07): run-ingress parameter validation/coercion + the seed-time
 * checkParamRefs gate.
 * Target: recipe-runner.ts (validateParams / checkParamRefs / parseParamsFromText).
 * Bible anchor: subagents-and-recipes.md (SS-params verify: block — FOLLOW-UP, see
 *   the unit notes: a bible-gate unit must add a `verify:` for validateParams).
 * Catches: an unknown provided key surviving; a missing required value spawning a
 *   subagent; a type/pattern/enum mismatch; a default not filled; an undeclared
 *   {{token}} surviving substitution; a steps.<n>.out / item / index ref wrongly
 *   flagged as a param.
 */
import { describe, it, expect } from "vitest";
import type { RecipeParamSpec } from "../recipe-author.js";
import { validateParams, checkParamRefs, type CompileStep } from "../recipe-runner.js";

describe("validateParams (run-ingress)", () => {
  it("passes an un-parameterized recipe through untouched", () => {
    expect(validateParams(undefined, { foo: "bar" })).toEqual({
      ok: true,
      values: { foo: "bar" },
      errors: [],
    });
    expect(validateParams({}, undefined)).toEqual({ ok: true, values: {}, errors: [] });
  });

  it("rejects an unknown provided key", () => {
    const decls: Record<string, RecipeParamSpec> = { name: { type: "string" } };
    const r = validateParams(decls, { name: "x", bogus: "y" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown parameter "bogus"/);
  });

  it("rejects a missing required value and names the description", () => {
    const decls: Record<string, RecipeParamSpec> = {
      target: { type: "string", required: true, description: "the repo to scan" },
    };
    const r = validateParams(decls, {});
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/missing required parameter "target".*the repo to scan/);
  });

  it("fills a declared default when no value is provided", () => {
    const decls: Record<string, RecipeParamSpec> = {
      depth: { type: "number", default: 3 },
      tags: { type: "list<string>", default: ["a", "b"] },
    };
    const r = validateParams(decls, {});
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({ depth: "3", tags: "a,b" });
  });

  it("coerces string (happy) and enforces pattern (sad)", () => {
    const decls: Record<string, RecipeParamSpec> = {
      slug: { type: "string", pattern: "^[a-z]+$" },
    };
    expect(validateParams(decls, { slug: "abc" })).toEqual({
      ok: true,
      values: { slug: "abc" },
      errors: [],
    });
    const sad = validateParams(decls, { slug: "AB1" });
    expect(sad.ok).toBe(false);
    expect(sad.errors.join(" ")).toMatch(/must match/);
  });

  it("coerces number (happy) and rejects non-finite (sad)", () => {
    const decls: Record<string, RecipeParamSpec> = { n: { type: "number" } };
    expect(validateParams(decls, { n: "42" }).values).toEqual({ n: "42" });
    const sad = validateParams(decls, { n: "not-a-number" });
    expect(sad.ok).toBe(false);
    expect(sad.errors.join(" ")).toMatch(/finite number/);
  });

  it("coerces boolean truthy/falsy literals (happy) and rejects garbage (sad)", () => {
    const decls: Record<string, RecipeParamSpec> = { flag: { type: "boolean" } };
    expect(validateParams(decls, { flag: "yes" }).values).toEqual({ flag: "true" });
    expect(validateParams(decls, { flag: "0" }).values).toEqual({ flag: "false" });
    expect(validateParams(decls, { flag: "TRUE" }).values).toEqual({ flag: "true" });
    const sad = validateParams(decls, { flag: "maybe" });
    expect(sad.ok).toBe(false);
    expect(sad.errors.join(" ")).toMatch(/must be a boolean/);
  });

  it("enforces enum membership (happy + sad)", () => {
    const decls: Record<string, RecipeParamSpec> = {
      mode: { type: "enum", enum: ["fast", "safe"] },
    };
    expect(validateParams(decls, { mode: "safe" }).values).toEqual({ mode: "safe" });
    const sad = validateParams(decls, { mode: "wild" });
    expect(sad.ok).toBe(false);
    expect(sad.errors.join(" ")).toMatch(/must be one of fast\|safe/);
  });

  it("normalizes a list<string> CSV (trim, drop empties, re-join)", () => {
    const decls: Record<string, RecipeParamSpec> = { items: { type: "list<string>" } };
    expect(validateParams(decls, { items: " a , ,b ,, c " }).values).toEqual({ items: "a,b,c" });
  });
});

describe("checkParamRefs (seed-time gate)", () => {
  const declared: Record<string, RecipeParamSpec> = { target: { type: "string" } };

  it("catches an undeclared {{token}}", () => {
    const steps: CompileStep[] = [{ title: "Scan", body: "Scan {{target}} for {{undeclared}}." }];
    const errs = checkParamRefs(steps, declared);
    expect(errs.join(" ")).toMatch(/\{\{undeclared\}\} is not a declared parameter/);
    expect(errs.join(" ")).not.toMatch(/target/);
  });

  it("ignores steps.<n>.out / item / index refs (resolved elsewhere)", () => {
    const steps: CompileStep[] = [
      {
        title: "Use",
        body: "Use {{steps.1.out.passed}} on {{item}} at {{index}} with {{target}}.",
      },
    ];
    expect(checkParamRefs(steps, declared)).toEqual([]);
  });

  it("passes when every token is a declared param, a step ref, or item/index", () => {
    const steps: CompileStep[] = [{ title: "Plain", body: "No tokens here." }];
    expect(checkParamRefs(steps, declared)).toEqual([]);
  });

  it("flags an undeclared token when the recipe declares no params at all", () => {
    const steps: CompileStep[] = [{ title: "X", body: "Run {{foo}}." }];
    expect(checkParamRefs(steps, undefined).join(" ")).toMatch(/\{\{foo\}\}/);
  });
});
