/**
 * SS2b (2026-06-06): seed-time combinator-ref validation.
 * Target: recipe-runner.ts (checkCombinatorRefs + CompileStep.usesKitRef/usesWorkerRef).
 * Bible anchor: subagents-and-recipes.md (SS2b verify: block).
 * Bug-history: a malformed static kitRef / a dynamic worker ref pointing forward must fail FAST at seed
 *   (mirrors checkPortWiring / checkWhenRefs), not blow up mid-dispatch.
 * Catches: a self-referencing static kitRef accepted; a {{steps.N.out…}} worker ref to a later/missing step accepted.
 */
import { describe, it, expect } from "vitest";
import { checkCombinatorRefs, type CompileStep } from "../recipe-runner.js";

describe("checkCombinatorRefs (seed-time)", () => {
  it("accepts a well-formed static kitRef", () => {
    const steps: CompileStep[] = [{ title: "a", usesKitRef: "globalcaos/echo" }];
    expect(checkCombinatorRefs(steps, "globalcaos/host")).toEqual([]);
  });
  it("rejects a malformed static kitRef", () => {
    const steps: CompileStep[] = [{ title: "a", usesKitRef: "Bad Ref!" }];
    expect(checkCombinatorRefs(steps, "globalcaos/host").join()).toMatch(/not a valid kitRef/);
  });
  it("rejects a static kitRef that is the host kit itself (self-cycle)", () => {
    const steps: CompileStep[] = [{ title: "a", usesKitRef: "globalcaos/host" }];
    expect(checkCombinatorRefs(steps, "globalcaos/host").join()).toMatch(/cycle|itself/i);
  });
  it("accepts a dynamic worker ref to an EARLIER step", () => {
    const producer: CompileStep = {
      title: "p",
      out: { type: "object", properties: { worker: { type: "string" } } },
    };
    const steps: CompileStep[] = [
      producer,
      { title: "c", usesWorkerRef: "{{steps.1.out.worker}}" },
    ];
    expect(checkCombinatorRefs(steps, "globalcaos/host")).toEqual([]);
  });
  it("rejects a dynamic worker ref to a forward / self step", () => {
    const steps: CompileStep[] = [
      { title: "a", usesWorkerRef: "{{steps.2.out.worker}}" },
      { title: "b", out: { type: "object", properties: { worker: { type: "string" } } } },
    ];
    expect(checkCombinatorRefs(steps, "globalcaos/host").join()).toMatch(/must precede it/);
  });
  it("rejects a dynamic worker ref to a step that declares no out:", () => {
    const steps: CompileStep[] = [
      { title: "a" },
      { title: "b", usesWorkerRef: "{{steps.1.out.worker}}" },
    ];
    expect(checkCombinatorRefs(steps, "globalcaos/host").join()).toMatch(/declares no out:/);
  });
});
