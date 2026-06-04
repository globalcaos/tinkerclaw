import { describe, it, expect } from "vitest";
import { checkPortWiring, type CompileStep } from "../recipe-runner.js";

const produce: CompileStep = {
  title: "Produce",
  out: { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] },
  in: undefined,
};

describe("checkPortWiring (plan-compile)", () => {
  it("passes a correctly wired pair", () => {
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.1.out.passed" }],
    };
    expect(checkPortWiring([produce, consume])).toEqual([]);
  });
  it("fails when the producer declares no out: schema", () => {
    const plain: CompileStep = { title: "Plain" };
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.1.out.passed" }],
    };
    const errs = checkPortWiring([plain, consume]);
    expect(errs.join(" ")).toMatch(/step 1.*no out:/i);
  });
  it("fails when the producer's schema lacks the referenced field", () => {
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.1.out.missing" }],
    };
    expect(checkPortWiring([produce, consume]).join(" ")).toMatch(/missing/i);
  });
  it("fails when from references a later or non-existent step", () => {
    const consume: CompileStep = {
      title: "Consume",
      in: [{ name: "p", from: "steps.9.out.passed" }],
    };
    expect(checkPortWiring([produce, consume]).join(" ")).toMatch(
      /step 9.*does not exist|precede/i,
    );
  });
});
