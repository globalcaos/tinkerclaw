/**
 * BROCA visibility (2026-06-06): parseRecipeMd round-trips buildRecipeMd output.
 * Target: recipe-parse.ts (parseRecipeMd / recipeStepProse / firstSentence).
 * Bible anchor: subagents-and-recipes.md; handoff 2026-06-06-broca-visibility-server-handoff.md.
 * Bug-history: the panel renders what the runner executes — the parser must recover
 *   skillId/ins/out/when/returns/prose from a real authored recipe (single-source).
 * Catches: a directive the author emits but the parser drops; prose mis-extraction.
 */
import { describe, it, expect } from "vitest";
import { buildRecipeMd, type RecipeSpec } from "../recipe-author.js";
import { parseRecipeMd, recipeStepProse, firstSentence } from "../recipe-parse.js";

const spec: RecipeSpec = {
  slug: "broca-demo",
  title: "BROCA Demo",
  summary: "demo recipe",
  tags: ["demo"],
  category: "operations",
  steps: [
    {
      title: "Invoke",
      invokeSkill: "echo",
      doneWhen: "the echo returns",
      body: "Call the echo skill.",
    },
    {
      title: "Produce",
      out: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      body: "Produce a value.",
    },
    {
      title: "Consume",
      in: [{ name: "ok", from: "steps.2.out.ok" }],
      when: "steps.2.out.ok == true",
      earlyExit: true,
      body: "Consume and finish.",
    },
  ],
};

describe("parseRecipeMd round-trips buildRecipeMd", () => {
  const md = buildRecipeMd(spec);
  const parsed = parseRecipeMd(md);

  it("recovers frontmatter (slug/title/summary/category) + step count", () => {
    expect(parsed.slug).toBe("broca-demo");
    expect(parsed.title).toBe("BROCA Demo");
    expect(parsed.summary).toBe("demo recipe");
    expect(parsed.category).toBe("operations");
    expect(parsed.steps).toHaveLength(3);
  });

  it("recovers skillId (invokeSkill) + doneWhen on the invoke-skill step", () => {
    expect(parsed.steps[0].invokeSkill).toBe("echo");
    expect(parsed.steps[0].doneWhen).toBe("the echo returns");
  });

  it("recovers out: on the producing step", () => {
    expect(parsed.steps[1].out).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    expect(parsed.steps[1].in).toBeUndefined();
  });

  it("recovers ins (in:), when:, and returns (earlyExit) on the consuming step", () => {
    expect(parsed.steps[2].in).toEqual([{ name: "ok", from: "steps.2.out.ok" }]);
    expect(parsed.steps[2].when).toBe("steps.2.out.ok == true");
    expect(parsed.steps[2].earlyExit).toBe(true);
  });

  it("recipeStepProse strips directives + meta; firstSentence trims to one sentence", () => {
    expect(recipeStepProse(parsed.steps[1].body)).toBe("Produce a value.");
    expect(recipeStepProse(parsed.steps[0].body)).toBe("Call the echo skill.");
    expect(firstSentence("One sentence. Two sentence.")).toBe("One sentence.");
    expect(firstSentence("No terminal punctuation here")).toBe("No terminal punctuation here");
  });
});
