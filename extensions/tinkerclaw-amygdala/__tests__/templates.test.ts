import { describe, expect, it } from "vitest";
import { isTemplateId, renderTemplate, TEMPLATE_IDS } from "../src/templates.js";

describe("templates", () => {
  it("fills slots and is one line", () => {
    const t = renderTemplate("surprise", { expected: "3 files", observed: "0" });
    expect(t).toBe("You expected 3 files; the result was 0. Look at that before the next step.");
    expect(t.includes("\n")).toBe(false);
  });
  it("throws on a missing slot or an unknown id instead of sending a blank to the agent", () => {
    expect(() => renderTemplate("surprise", { expected: "x" })).toThrow(/missing slot observed/);
    expect(() => renderTemplate("nope")).toThrow(/unknown template id/);
    expect(isTemplateId("nope")).toBe(false);
  });
  it("every template renders when all its slots are given, and none holds a home path", () => {
    for (const id of TEMPLATE_IDS) {
      const slots = Object.fromEntries(
        [
          "reading",
          "fact",
          "what",
          "needs",
          "rule",
          "explanation",
          "claim",
          "missing",
          "problem",
          "expected",
          "observed",
          "n",
          "facts",
          "readings",
          "id",
          "p",
        ].map((k) => [k, "v"]),
      );
      const out = renderTemplate(id, slots);
      expect(out).not.toMatch(/\{\w+\}/);
      expect(out).not.toMatch(/\/home\//);
    }
  });
});
