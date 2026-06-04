import { describe, it, expect } from "vitest";
import { validateRecipeSpec, buildRecipeMd, type RecipeSpec } from "../recipe-author.js";
import { parseKitStepsAndParallelism } from "../recipe-runner.js";
import { parseStepIoDirectives } from "../recipe-types.js";

describe("SS1 typed ports", () => {
  const base = {
    slug: "typed-demo",
    title: "Typed Demo",
    summary: "demo",
    tags: ["demo"],
  };

  it("accepts a step with a valid out: schema", () => {
    const spec = {
      ...base,
      steps: [
        {
          title: "Produce",
          out: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          body: "do it",
        },
      ],
    };
    expect(validateRecipeSpec(spec).ok).toBe(true);
  });

  it("rejects an out: schema that is not an object schema", () => {
    const spec = { ...base, steps: [{ title: "X", out: "nope", body: "b" }] };
    const r = validateRecipeSpec(spec);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/out.*schema/i);
  });

  it("rejects an in: port whose from is not a steps.N.out reference", () => {
    const spec = {
      ...base,
      steps: [{ title: "X", in: [{ name: "a", from: "garbage" }], body: "b" }],
    };
    const r = validateRecipeSpec(spec);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/from.*steps\./i);
  });

  it("round-trips: buildRecipeMd emits directives parseStepIoDirectives reads back", () => {
    const out = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const md = buildRecipeMd({
      ...base,
      steps: [
        { title: "Produce", out, body: "do it" },
        { title: "Consume", in: [{ name: "ok", from: "steps.1.out.ok" }], body: "use it" },
      ],
    });
    // step 2 body begins after "### 2. Consume"
    const step2 = md.slice(md.indexOf("### 2."));
    const io = parseStepIoDirectives(step2.slice(step2.indexOf("\n") + 1));
    expect(io.in).toEqual([{ name: "ok", from: "steps.1.out.ok" }]);
  });

  it("emits no io lines for untyped steps (overlay-not-delete)", () => {
    const md = buildRecipeMd({ ...base, steps: [{ title: "Plain", body: "just prose" }] });
    expect(md).not.toMatch(/^out:/m);
    expect(md).not.toMatch(/^in:/m);
  });
});

const good: RecipeSpec = {
  slug: "my-kit",
  title: "My Kit",
  summary: "Does a thing in steps.",
  tags: ["thing", "operations"],
  category: "operations",
  steps: [
    { title: "Scope", tools: ["read"], doneWhen: "scope is clear", body: "Read the inputs." },
    { title: "Do", tools: ["edit"], doneWhen: "change applied", body: "Apply the change." },
  ],
  parallelismGroups: [[0], [1]],
};

describe("validateRecipeSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(validateRecipeSpec(good).ok).toBe(true);
  });

  it("rejects traversal / non-slug slugs", () => {
    expect(validateRecipeSpec({ ...good, slug: "../etc" }).ok).toBe(false);
    expect(validateRecipeSpec({ ...good, slug: "UPPER" }).ok).toBe(false);
    expect(validateRecipeSpec({ ...good, slug: "a" }).ok).toBe(false);
  });

  it("rejects empty tags / steps / missing fields", () => {
    expect(validateRecipeSpec({ ...good, tags: [] }).ok).toBe(false);
    expect(validateRecipeSpec({ ...good, steps: [] }).ok).toBe(false);
    expect(validateRecipeSpec({ ...good, summary: "" }).ok).toBe(false);
  });

  it("enforces parallelism coverage (every step exactly once)", () => {
    expect(validateRecipeSpec({ ...good, parallelismGroups: [[0]] }).ok).toBe(false); // misses step 1
    expect(validateRecipeSpec({ ...good, parallelismGroups: [[0], [0]] }).ok).toBe(false); // repeat
    expect(validateRecipeSpec({ ...good, parallelismGroups: [[0], [9]] }).ok).toBe(false); // out of range
    expect(validateRecipeSpec({ ...good, parallelismGroups: [[0, 1]] }).ok).toBe(true); // both, parallel
  });
});

describe("buildRecipeMd round-trips through the runner parser", () => {
  it("emits frontmatter + steps the runner can parse back", () => {
    const md = buildRecipeMd(good);
    expect(md).toContain('schema: "kit/1.0"');
    expect(md).toContain('slug: "my-kit"');
    expect(md).toContain("### 1. Scope");
    expect(md).toContain("### 2. Do");
    const parsed = parseKitStepsAndParallelism(md);
    expect(parsed.steps.map((s) => s.title)).toEqual(["Scope", "Do"]);
    expect(parsed.parallelism?.groups).toEqual([[0], [1]]);
  });

  it("defaults to fully-serial groups when none given", () => {
    const md = buildRecipeMd({ ...good, parallelismGroups: undefined });
    const parsed = parseKitStepsAndParallelism(md);
    expect(parsed.parallelism?.groups).toEqual([[0], [1]]);
  });
});
