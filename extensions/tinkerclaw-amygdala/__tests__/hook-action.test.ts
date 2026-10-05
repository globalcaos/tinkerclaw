import { describe, expect, it } from "vitest";
import { toHookAction } from "../src/hook-action.js";
import type { Decision, Response } from "../src/types.js";

const d = (response: Response, enforced = true): Decision => ({
  situationId: "s",
  response,
  family: "safety",
  reasonCode: "x[]",
  verdictIds: [],
  mode: "enforce",
  enforced,
  degraded: false,
});
const note: Response = {
  kind: "note",
  templateId: "relevant-fact",
  slots: { fact: "f" },
  channel: "additionalContext",
};
const proof: Response = {
  kind: "proof",
  templateId: "proof-required",
  slots: { what: "w", needs: "n" },
  needs: ["listing"],
};
const hold: Response = { kind: "hold", ruleOrQuestion: "danger-level", releasable: "user-only" };
const ask: Response = { kind: "ask", askId: "a", options: [{ id: "x", label: "X" }] };
const back: Response = {
  kind: "send-back",
  templateId: "send-back-dodged",
  slots: { problem: "leaves a placeholder" },
  attempt: 1,
};

describe("toHookAction", () => {
  it("prints nothing unless the decision was enforced (shadow)", () => {
    for (const r of [note, proof, hold, ask, back]) {
      expect(toHookAction("pre-tool", { decision: d(r, false) })).toEqual({ kind: "none" });
    }
  });
  it("proceed → none", () => {
    expect(toHookAction("pre-tool", { decision: d({ kind: "proceed" }) })).toEqual({
      kind: "none",
    });
  });
  it("note → context on prompt/pre/post, none at stop", () => {
    expect(toHookAction("post-tool", { decision: d(note) })).toEqual({
      kind: "context",
      text: "amygdala: f.",
    });
    expect(toHookAction("prompt", { decision: d(note) }).kind).toBe("context");
    expect(toHookAction("stop", { decision: d(note) }).kind).toBe("none");
  });
  it("proof → deny at pre-tool only", () => {
    const a = toHookAction("pre-tool", { decision: d(proof) });
    expect(a.kind).toBe("deny");
    expect((a as { reason: string }).reason).toMatch(/^Held: w\. To proceed, show: n\./);
    expect(toHookAction("post-tool", { decision: d(proof) }).kind).toBe("none");
  });
  it("hard-rule hold → deny naming the rule; judge hold and ask → wait with 300 s and both fallback texts", () => {
    const hard = toHookAction("pre-tool", {
      decision: d(hold),
      hard: { rule: "FS_X", explanation: "Rule-based block [FS_X]: no" },
    });
    expect(hard).toMatchObject({ kind: "deny" });
    expect((hard as { reason: string }).reason).toContain("FS_X");
    const w = toHookAction("pre-tool", { decision: d(hold), interventionId: "iv1" });
    expect(w).toMatchObject({ kind: "wait", interventionId: "iv1", timeoutMs: 300000 });
    expect((w as { onKeep: string }).onKeep).toMatch(/kept this step held/);
    expect((w as { onTimeout: string }).onTimeout).toMatch(/did not answer/);
    expect(toHookAction("pre-tool", { decision: d(ask), interventionId: "iv2" }).kind).toBe("wait");
  });
  it("a hold with no intervention id denies rather than waiting on nothing", () => {
    expect(toHookAction("pre-tool", { decision: d(hold) }).kind).toBe("deny");
  });
  it("send-back → block at stop only", () => {
    expect(toHookAction("stop", { decision: d(back) })).toMatchObject({ kind: "block" });
    expect(toHookAction("pre-tool", { decision: d(back) }).kind).toBe("none");
  });
});
