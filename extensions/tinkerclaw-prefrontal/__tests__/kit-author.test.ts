import { describe, it, expect } from "vitest";
import { validateKitSpec, buildKitMd, type KitSpec } from "../kit-author.js";
import { parseKitStepsAndParallelism } from "../kit-runner.js";

const good: KitSpec = {
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

describe("validateKitSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(validateKitSpec(good).ok).toBe(true);
  });

  it("rejects traversal / non-slug slugs", () => {
    expect(validateKitSpec({ ...good, slug: "../etc" }).ok).toBe(false);
    expect(validateKitSpec({ ...good, slug: "UPPER" }).ok).toBe(false);
    expect(validateKitSpec({ ...good, slug: "a" }).ok).toBe(false);
  });

  it("rejects empty tags / steps / missing fields", () => {
    expect(validateKitSpec({ ...good, tags: [] }).ok).toBe(false);
    expect(validateKitSpec({ ...good, steps: [] }).ok).toBe(false);
    expect(validateKitSpec({ ...good, summary: "" }).ok).toBe(false);
  });

  it("enforces parallelism coverage (every step exactly once)", () => {
    expect(validateKitSpec({ ...good, parallelismGroups: [[0]] }).ok).toBe(false); // misses step 1
    expect(validateKitSpec({ ...good, parallelismGroups: [[0], [0]] }).ok).toBe(false); // repeat
    expect(validateKitSpec({ ...good, parallelismGroups: [[0], [9]] }).ok).toBe(false); // out of range
    expect(validateKitSpec({ ...good, parallelismGroups: [[0, 1]] }).ok).toBe(true); // both, parallel
  });
});

describe("buildKitMd round-trips through the runner parser", () => {
  it("emits frontmatter + steps the runner can parse back", () => {
    const md = buildKitMd(good);
    expect(md).toContain('schema: "kit/1.0"');
    expect(md).toContain('slug: "my-kit"');
    expect(md).toContain("### 1. Scope");
    expect(md).toContain("### 2. Do");
    const parsed = parseKitStepsAndParallelism(md);
    expect(parsed.steps.map((s) => s.title)).toEqual(["Scope", "Do"]);
    expect(parsed.parallelism?.groups).toEqual([[0], [1]]);
  });

  it("defaults to fully-serial groups when none given", () => {
    const md = buildKitMd({ ...good, parallelismGroups: undefined });
    const parsed = parseKitStepsAndParallelism(md);
    expect(parsed.parallelism?.groups).toEqual([[0], [1]]);
  });
});
