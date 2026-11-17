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
          "pick",
          "sources",
        ].map((k) => [k, "v"]),
      );
      const out = renderTemplate(id, slots);
      expect(out).not.toMatch(/\{\w+\}/);
      expect(out).not.toMatch(/\/home\//);
    }
  });
  it("the unchecked send-back asks for a check that stays on this machine (2026-11-11)", () => {
    const t = renderTemplate("send-back-unchecked", { what: "the revert deletes the message" });
    expect(t).toContain("the revert deletes the message");
    expect(t).toContain("a tool that only reads or runs on this machine");
    expect(t).toContain(
      "If only a step that sends, deletes, publishes or spends could check it, do not take it",
    );
  });
  it("a subagent's unchecked send-back keeps the local-only check and asks for the whole reply (2026-11-13)", () => {
    const t = renderTemplate("send-back-unchecked-subagent", { what: "the rate" });
    expect(t).toContain("a tool that only reads or runs on this machine");
    expect(t).toContain(
      "If only a step that sends, deletes, publishes or spends could check it, do not take it",
    );
    expect(t).toContain("only your last message reaches the agent that started you");
    expect(t).not.toContain("do not repeat the rest of the reply");
  });
});
