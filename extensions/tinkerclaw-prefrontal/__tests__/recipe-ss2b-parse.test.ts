/**
 * SS2b (2026-06-06): dynamic uses: template + map:/filter: iteration parsers.
 * Target: recipe-runner.ts (parseUsesDirective {{…}} widening, isDynamicUsesRef,
 *   parseMapIterDirective, parseFilterIterDirective) + recipe-types.ts (OTHER_DIRECTIVE_RE).
 * Bible anchor: subagents-and-recipes.md (SS2b verify: block).
 * Bug-history: a map:/filter: body that is PROSE ("map: the files") must NOT be a directive;
 *   order-independence (a uses:/when:/map: lead must not break out: parsing) must survive.
 * Catches: a prose line treated as a map directive; a {{…}} uses: dropped or eagerly resolved.
 */
import { describe, it, expect } from "vitest";
import {
  parseUsesDirective,
  isDynamicUsesRef,
  parseMapIterDirective,
  parseFilterIterDirective,
} from "../recipe-runner.js";
import { parseStepIoDirectives } from "../recipe-types.js";

describe("SS2b parseUsesDirective — dynamic template", () => {
  it("still normalizes a static bare slug to globalcaos/<slug>", () => {
    expect(parseUsesDirective("uses: echo")).toBe("globalcaos/echo");
    expect(parseUsesDirective("uses: globalcaos/feature")).toBe("globalcaos/feature");
  });
  it("returns a {{steps.N.out.path}} template raw (unresolved)", () => {
    expect(parseUsesDirective("uses: {{steps.1.out.worker}}")).toBe("{{steps.1.out.worker}}");
    expect(parseUsesDirective("uses: {{steps.1.out.thenKit}}")).toBe("{{steps.1.out.thenKit}}");
  });
  it("isDynamicUsesRef distinguishes a template from a static ref", () => {
    expect(isDynamicUsesRef("{{steps.1.out.worker}}")).toBe(true);
    expect(isDynamicUsesRef("globalcaos/echo")).toBe(false);
    expect(isDynamicUsesRef(undefined)).toBe(false);
  });
});

describe("SS2b parseMapIterDirective / parseFilterIterDirective", () => {
  it("parses a map: steps.<n>.out ref", () => {
    expect(parseMapIterDirective("map: steps.1.out.items")).toBe("steps.1.out.items");
    expect(parseMapIterDirective("map: steps.2.out")).toBe("steps.2.out");
  });
  it("parses a filter: steps.<n>.out ref", () => {
    expect(parseFilterIterDirective("filter: steps.1.out.items")).toBe("steps.1.out.items");
  });
  it("treats a prose line as NOT a directive (prose-collision guard)", () => {
    expect(parseMapIterDirective("map: the files in src/ and tidy them")).toBeUndefined();
    expect(parseFilterIterDirective("filter: out the noisy logs")).toBeUndefined();
    expect(parseMapIterDirective("Map over the array described below.")).toBeUndefined();
  });
  it("coexists with a dynamic uses: directive on the leading lines (order-independent)", () => {
    const body = "map: steps.1.out.items\nuses: {{steps.1.out.worker}}";
    expect(parseMapIterDirective(body)).toBe("steps.1.out.items");
    expect(parseUsesDirective(body)).toBe("{{steps.1.out.worker}}");
  });
  it("keeps out: parsing when a map: directive leads the body", () => {
    const io = parseStepIoDirectives('map: steps.1.out.items\nout: {"type":"array"}');
    expect(io.out).toEqual({ type: "array" });
  });
});
