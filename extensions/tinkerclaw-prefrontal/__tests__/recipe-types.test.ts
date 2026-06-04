import { describe, it, expect } from "vitest";
import {
  parseStepIoDirectives,
  stripStepIoDirectives,
  extractTypedOutput,
  dotGet,
  parseStepRef,
  resolveStepRefs,
} from "../recipe-types.js";

describe("parseStepIoDirectives", () => {
  it("reads leading out: and in: lines as JSON", () => {
    const body = [
      'out: {"type":"object","properties":{"passed":{"type":"boolean"}},"required":["passed"]}',
      'in: [{"name":"x","from":"steps.1.out.foo"}]',
      "",
      "Body text.",
    ].join("\n");
    const io = parseStepIoDirectives(body);
    expect(io.out).toEqual({
      type: "object",
      properties: { passed: { type: "boolean" } },
      required: ["passed"],
    });
    expect(io.in).toEqual([{ name: "x", from: "steps.1.out.foo" }]);
  });

  it("returns empty io for an untyped body (overlay-not-delete)", () => {
    expect(parseStepIoDirectives("Just prose.")).toEqual({});
  });

  it("ignores out:/in: that appear after the first non-directive line", () => {
    const body = 'Prose first.\nout: {"type":"string"}';
    expect(parseStepIoDirectives(body)).toEqual({});
  });

  it("throws a clear error on malformed directive JSON", () => {
    expect(() => parseStepIoDirectives("out: {not json}")).toThrow(/out:.*JSON/i);
  });
});

describe("stripStepIoDirectives", () => {
  it("removes the leading io lines, leaving the prose task", () => {
    const body = 'out: {"type":"string"}\nin: []\n\nDo the thing.';
    expect(stripStepIoDirectives(body)).toBe("Do the thing.");
  });
  it("leaves an untyped body unchanged", () => {
    expect(stripStepIoDirectives("Do the thing.")).toBe("Do the thing.");
  });
});

describe("extractTypedOutput", () => {
  it("pulls the last fenced json block", () => {
    const note = 'Reasoning...\n```json\n{"passed": true}\n```\ntrailing';
    expect(extractTypedOutput(note)).toEqual({ passed: true });
  });
  it("parses a bare-JSON note", () => {
    expect(extractTypedOutput('{"passed": false}')).toEqual({ passed: false });
  });
  it("returns undefined when no JSON is present", () => {
    expect(extractTypedOutput("no json here")).toBeUndefined();
  });
  it("prefers the LAST json block when several exist", () => {
    const note = '```json\n{"v":1}\n```\n```json\n{"v":2}\n```';
    expect(extractTypedOutput(note)).toEqual({ v: 2 });
  });
});

describe("dotGet", () => {
  it("navigates a dotted path", () => {
    expect(dotGet({ a: { b: 3 } }, "a.b")).toBe(3);
  });
  it("returns the whole object for an empty path", () => {
    expect(dotGet({ a: 1 }, "")).toEqual({ a: 1 });
  });
  it("returns undefined for a missing path", () => {
    expect(dotGet({ a: 1 }, "a.b.c")).toBeUndefined();
  });
});

describe("parseStepRef", () => {
  it("parses steps.N.out.path", () => {
    expect(parseStepRef("steps.2.out.failed")).toEqual({ stepNumber: 2, path: "failed" });
  });
  it("parses steps.N.out (whole object)", () => {
    expect(parseStepRef("steps.2.out")).toEqual({ stepNumber: 2, path: "" });
  });
  it("returns null for a non-ref", () => {
    expect(parseStepRef("not.a.ref")).toBeNull();
  });
});

describe("resolveStepRefs", () => {
  it("substitutes {{steps.N.out.path}} with the JSON value", () => {
    const outputs = new Map<number, unknown>([[2, { failed: 5 }]]);
    expect(resolveStepRefs("{{steps.2.out.failed}} failures", outputs)).toBe("5 failures");
  });
  it("stringifies object/array values", () => {
    const outputs = new Map<number, unknown>([[1, { a: [1, 2] }]]);
    expect(resolveStepRefs("{{steps.1.out.a}}", outputs)).toBe("[1,2]");
  });
  it("leaves an unresolvable ref untouched (compile-check is the guard)", () => {
    expect(resolveStepRefs("{{steps.9.out.x}}", new Map())).toBe("{{steps.9.out.x}}");
  });
});
