import AjvPkg from "ajv";
import { describe, it, expect } from "vitest";
import {
  parseStepIoDirectives,
  stripStepIoDirectives,
  extractTypedOutput,
  dotGet,
  parseStepRef,
  resolveStepRefs,
  validateTypedNote,
  parseKitRefValue,
  isRecoverableKind,
  classifyError,
  type ErrorKind,
} from "../recipe-types.js";

const AjvCtor = AjvPkg as unknown as typeof import("ajv").default;

describe("validateTypedNote", () => {
  const ajv = new AjvCtor({ allErrors: true });
  const validate = ajv.compile({
    type: "object",
    properties: { passed: { type: "boolean" } },
    required: ["passed"],
  });

  it("accepts a conforming json block", () => {
    const r = validateTypedNote('```json\n{"passed": true}\n```', validate);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ passed: true });
  });
  it("reports missing-block clearly", () => {
    const r = validateTypedNote("no json", validate);
    expect(r.ok).toBe(false);
    expect(r.errorText).toMatch(/no fenced/i);
  });
  it("reports a schema violation with field detail", () => {
    const r = validateTypedNote('```json\n{"passed": "yes"}\n```', validate);
    expect(r.ok).toBe(false);
    expect(r.errorText).toMatch(/passed|boolean/i);
  });
});

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

  it("skips a leading uses:/loop: directive and still reads out: (order-independent)", () => {
    const body = 'loop: count 2\nout: {"type":"object"}\n\nprose';
    expect(parseStepIoDirectives(body).out).toEqual({ type: "object" });
  });

  it("treats a prose line that merely starts with out:/in: as prose, never throwing", () => {
    expect(parseStepIoDirectives("out: of scope for this step, skip it")).toEqual({});
    expect(parseStepIoDirectives("in: the previous run we saw a flake")).toEqual({});
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
  it("preserves a leading uses:/loop: directive while dropping io", () => {
    const out = stripStepIoDirectives('out: {"type":"object"}\nuses: foo\n\nDo it.');
    expect(out).toContain("uses: foo");
    expect(out).toContain("Do it.");
    expect(out).not.toContain("out:");
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

describe("parseKitRefValue (SS2b kitRef value)", () => {
  it("normalizes a bare slug to globalcaos/<slug>", () => {
    expect(parseKitRefValue("echo")).toBe("globalcaos/echo");
    expect(parseKitRefValue("code-review")).toBe("globalcaos/code-review");
  });
  it("preserves an explicit owner/slug", () => {
    expect(parseKitRefValue("globalcaos/feature")).toBe("globalcaos/feature");
    expect(parseKitRefValue("someowner/their-kit")).toBe("someowner/their-kit");
  });
  it("trims surrounding whitespace", () => {
    expect(parseKitRefValue("  echo  ")).toBe("globalcaos/echo");
  });
  it("rejects malformed refs (returns null)", () => {
    expect(parseKitRefValue("")).toBeNull();
    expect(parseKitRefValue("UPPER")).toBeNull();
    expect(parseKitRefValue("a/b/c")).toBeNull();
    expect(parseKitRefValue("../escape")).toBeNull();
    expect(parseKitRefValue("{{steps.1.out.worker}}")).toBeNull();
    expect(parseKitRefValue("steps.1.out.worker")).toBeNull();
    expect(parseKitRefValue("has space")).toBeNull();
  });
  it("rejects a non-string", () => {
    expect(parseKitRefValue(undefined as unknown as string)).toBeNull();
    expect(parseKitRefValue(42 as unknown as string)).toBeNull();
  });
});

describe("SS5a isRecoverableKind (single source of truth for auto-retry)", () => {
  it("recoverable for the transient set {schema-mismatch, timeout, spawn-failure, execution-error}", () => {
    expect(isRecoverableKind("schema-mismatch")).toBe(true);
    expect(isRecoverableKind("timeout")).toBe(true);
    expect(isRecoverableKind("spawn-failure")).toBe(true);
  });
  it("execution-error is recoverable by default (a retryable-marked step that errors can retry; markError's auto-path forces false for a truly-unclassified failure)", () => {
    expect(isRecoverableKind("execution-error")).toBe(true);
  });
  it("hard-limit kinds are NOT recoverable", () => {
    for (const k of [
      "budget-exceeded",
      "guard-eval-error",
      "skill-not-found",
      "depth-limit",
      "map-filter-resolution",
      "fallback-failed",
      "recovery-exhausted",
      "sub-kit-failure",
    ] as ErrorKind[]) {
      expect(isRecoverableKind(k)).toBe(false);
    }
  });
  it("classifyError stamps recoverable from the kind (single source) and carries message + details", () => {
    const e = classifyError("timeout", "step timed out", { stepIndex: 2 });
    expect(e.kind).toBe("timeout");
    expect(e.message).toBe("step timed out");
    expect(e.recoverable).toBe(true);
    expect(e.details).toEqual({ stepIndex: 2 });
    const x = classifyError("execution-error", "boom");
    expect(x.recoverable).toBe(true);
    expect(x.details).toBeUndefined();
    // the markError auto-path forces recoverable:false for a truly-unclassified failure
    expect(classifyError("execution-error", "unknown", undefined, false).recoverable).toBe(false);
  });
  it("classifyError honors an explicit recoverable override", () => {
    expect(classifyError("timeout", "now terminal", undefined, false).recoverable).toBe(false);
  });
});

describe("SS5a io-scanner skips a leading onError: (order-independence)", () => {
  it("keeps out: parsing when an onError: directive leads the body", () => {
    const io = parseStepIoDirectives('onError: retry 2\nout: {"type":"array"}');
    expect(io.out).toEqual({ type: "array" });
  });
  it("treats a leading onError: as a sibling directive, not a prose stop", () => {
    const io = parseStepIoDirectives(
      'onError: continue-partial\nin: [{"name":"x","from":"steps.1.out"}]',
    );
    expect(io.in).toEqual([{ name: "x", from: "steps.1.out" }]);
  });
});
