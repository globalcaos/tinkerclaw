import { describe, it, expect } from "vitest";
import { parseInvokeSkillDirective } from "../recipe-runner.js";
import { parseStepIoDirectives, stripStepIoDirectives } from "../recipe-types.js";

describe("parseInvokeSkillDirective (SS3 Task 3)", () => {
  it("reads a leading invoke skill: directive", () => {
    expect(parseInvokeSkillDirective("invoke skill: summarize-text\n\nbody")).toBe(
      "summarize-text",
    );
  });

  it("returns undefined for prose", () => {
    expect(parseInvokeSkillDirective("just do the thing")).toBeUndefined();
  });

  it("accepts skill ids with dots/dashes/underscores", () => {
    expect(parseInvokeSkillDirective("invoke skill: stdlib-extract_json.field")).toBe(
      "stdlib-extract_json.field",
    );
  });

  it("coexists with out: in either order (io-scanner skips the invoke line)", () => {
    const body = 'invoke skill: extract-json-field\nout: {"type":"object"}\n\nbody';
    expect(parseInvokeSkillDirective(body)).toBe("extract-json-field");
    expect(parseStepIoDirectives(body).out).toEqual({ type: "object" });
  });

  it("finds invoke skill: even when out: precedes it (order-independent via strip)", () => {
    const body = 'out: {"type":"object"}\ninvoke skill: extract-json-field\n\nbody';
    // The runner parses directives off the STRIPPED body (io removed), so order
    // between io and invoke must not matter.
    expect(parseInvokeSkillDirective(stripStepIoDirectives(body))).toBe("extract-json-field");
    expect(parseStepIoDirectives(body).out).toEqual({ type: "object" });
  });

  it("a uses: directive is not mistaken for an invoke skill:", () => {
    expect(parseInvokeSkillDirective("uses: globalcaos/feature\n\nbody")).toBeUndefined();
  });
});
