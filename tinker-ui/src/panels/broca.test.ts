import { describe, it, expect } from "vitest";
import { renderBrocaProgram, colorSkillTokens, type BrocaRecipe } from "./broca";

const recipe: BrocaRecipe = {
  slug: "deep-research",
  title: "deep-research",
  summary: "research a topic",
  steps: [
    {
      n: 1,
      title: "search",
      skillId: "web-search-and-cite",
      out: { type: "object" },
      prose: "search the web, gather citations",
    },
    {
      n: 2,
      title: "summarize",
      skillId: "summarize-text",
      ins: [{ name: "sources", from: "steps.1.out" }],
      prose: "condense the sources",
    },
    {
      n: 3,
      title: "verify",
      skillId: "verify-claims",
      when: "steps.1.out.count > 0",
      returns: true,
      prose: "fact-check every claim",
    },
  ],
};

describe("renderBrocaProgram", () => {
  it("wraps each skill id in a .broca-skill span", () => {
    const html = renderBrocaProgram(recipe);
    expect(html).toContain('class="broca-skill"');
    expect(html).toContain("web-search-and-cite");
    expect((html.match(/broca-skill/g) || []).length).toBe(3);
  });
  it("renders the recipe title as a .broca-recipe-link with data-recipe-ref by default", () => {
    const html = renderBrocaProgram(recipe);
    expect(html).toContain('class="broca-recipe-link"');
    expect(html).toContain('data-recipe-ref="deep-research"');
  });
  it("does NOT link the title when linkTitle:false", () => {
    expect(renderBrocaProgram(recipe, { linkTitle: false })).not.toContain("broca-recipe-link");
  });
  it("renders BROCA keywords (invoke skill:, in:, out:, when:, return:) in .broca-kw", () => {
    const html = renderBrocaProgram(recipe);
    for (const kw of ["invoke skill:", "when", "return"]) expect(html).toContain(kw);
    expect(html).toContain("broca-kw");
  });
  it("marks the live step", () => {
    expect(renderBrocaProgram(recipe, { liveStep: 2 })).toContain("broca-step--live");
  });
  it("renders the prose subtitle for each step", () => {
    expect(renderBrocaProgram(recipe)).toContain("condense the sources");
  });
  it("escapes HTML in titles/prose", () => {
    const evil: BrocaRecipe = {
      slug: "x",
      title: "<img>",
      summary: "",
      steps: [{ n: 1, title: "<b>", prose: "<script>" }],
    };
    const html = renderBrocaProgram(evil);
    expect(html).not.toContain("<img>");
    expect(html).not.toContain("<script>");
  });
});

describe("colorSkillTokens", () => {
  const known = new Set(["summarize-text", "verify-claims"]);
  it("wraps an exact known skill id", () => {
    expect(colorSkillTokens("summarize-text", known)).toContain("broca-skill");
  });
  it("does NOT match arbitrary prose words (structured-only)", () => {
    expect(colorSkillTokens("please verify the summary", known)).not.toContain("broca-skill");
  });
  it("escapes and leaves unknown labels untouched", () => {
    expect(colorSkillTokens("random-label", known)).toBe("random-label");
  });
});
