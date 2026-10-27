import { describe, expect, it } from "vitest";
import {
  approxTokens,
  decideDigest,
  digestBrief,
  digestNote,
  digestTokenBudget,
  rawResultName,
} from "./thalamus-digest.js";
import { digestPays } from "./thalamus-switch.js";

const OPUS = "claude-code/claude-opus-5";
const HAIKU = "claude-code/claude-haiku-4-5";

describe("decideDigest: the paper's inequality on real prices", () => {
  it("a long result read by a cheaper model pays", () => {
    const d = decideDigest({ resultTokens: 40_000, incumbentKey: OPUS, readerKey: HAIKU });
    expect(d.digest).toBe(true);
    expect(d.reason).toBe("pays");
    expect(d.q).toBeLessThan(1);
    expect(d.margin).toBeGreaterThan(0);
  });

  it("agrees with digestPays on the numbers it reports (no second formula)", () => {
    const d = decideDigest({
      resultTokens: 30_000,
      incumbentKey: OPUS,
      readerKey: HAIKU,
      laterSteps: 5,
    });
    expect(d.digest).toBe(
      digestPays({ dOverS: d.dOverS!, w: d.w!, rb: d.rb!, L: d.laterSteps!, q: d.q! }),
    );
  });

  it("the reader being the incumbent's own model still pays: q is 1 and the saving is not carrying it", () => {
    const d = decideDigest({ resultTokens: 30_000, incumbentKey: OPUS, readerKey: OPUS });
    expect(d.q).toBe(1);
    expect(d.digest).toBe(true);
  });

  it("paper §5.2: with w = 1.25 and no later steps, a digest under a fifth pays and one over a fifth does not", () => {
    // d/S = 1/6 (the default budget) is under a fifth; force a fifth-plus digest with a big requested budget.
    const under = decideDigest({
      resultTokens: 6_000,
      incumbentKey: OPUS,
      readerKey: OPUS,
      laterSteps: 0,
      tier: "5m",
    });
    expect(under.dOverS).toBeCloseTo(1 / 6, 5);
    expect(under.digest).toBe(true);
    // The default budget never goes over a sixth, so the other side of the boundary is the paper's inequality itself.
    expect(digestPays({ dOverS: 0.25, w: 1.25, rb: 0.1, L: 0, q: 1 })).toBe(false);
    expect(digestPays({ dOverS: 0.19, w: 1.25, rb: 0.1, L: 0, q: 1 })).toBe(true);
  });

  it("later steps only help: more re-reads never turn a paying digest into a losing one", () => {
    let last = -Infinity;
    for (let L = 0; L <= 20; L++) {
      const d = decideDigest({
        resultTokens: 20_000,
        incumbentKey: OPUS,
        readerKey: HAIKU,
        laterSteps: L,
      });
      expect(d.margin!).toBeGreaterThanOrEqual(last);
      last = d.margin!;
    }
  });

  it("a short result is left alone, whatever the arithmetic", () => {
    const d = decideDigest({ resultTokens: 500, incumbentKey: OPUS, readerKey: HAIKU });
    expect(d).toMatchObject({ digest: false, reason: "short" });
  });

  it("an item the step read needs in full stays raw", () => {
    const d = decideDigest({
      resultTokens: 40_000,
      incumbentKey: OPUS,
      readerKey: HAIKU,
      needsFull: true,
    });
    expect(d).toMatchObject({ digest: false, reason: "needs-full" });
  });

  it("a hand-picked thread is never touched", () => {
    const d = decideDigest({
      resultTokens: 40_000,
      incumbentKey: OPUS,
      readerKey: HAIKU,
      handPicked: true,
    });
    expect(d).toMatchObject({ digest: false, reason: "hand-picked" });
  });

  it("an unpriced model on either side means no digest, never a guess", () => {
    expect(
      decideDigest({ resultTokens: 40_000, incumbentKey: "nope/none", readerKey: HAIKU }),
    ).toMatchObject({
      digest: false,
      reason: "unpriced",
    });
    expect(
      decideDigest({ resultTokens: 40_000, incumbentKey: OPUS, readerKey: "nope/none" }),
    ).toMatchObject({
      digest: false,
      reason: "unpriced",
    });
  });
});

describe("the digest size", () => {
  it("is a sixth of the result, capped, and never below one", () => {
    expect(digestTokenBudget(6_000)).toBe(1_000);
    expect(digestTokenBudget(600_000)).toBe(1_200);
    expect(digestTokenBudget(0)).toBe(1);
  });
});

describe("the raw name", () => {
  it("is stable for the same text and different for different text or length", () => {
    expect(rawResultName("abc")).toBe(rawResultName("abc"));
    expect(rawResultName("abc")).not.toBe(rawResultName("abd"));
    expect(rawResultName("abc")).not.toBe(rawResultName("abcc"));
  });
  it("carries no path and nothing from the text", () => {
    const n = rawResultName("secret /home/oscar/file");
    expect(n).toMatch(/^res-[0-9a-f]{8}-[0-9a-z]+$/);
    expect(n).not.toContain("secret");
    expect(n).not.toContain("/");
  });
});

describe("the texts around the digest", () => {
  it("the brief carries the aim and the tool name, capped, and never the whole thread", () => {
    const b = digestBrief({
      aim: "find why the build fails ".repeat(100),
      toolName: "exec",
      digestTokens: 800,
    });
    expect(b).toContain('"exec"');
    expect(b).toContain("800 tokens");
    expect(b.length).toBeLessThan(1500);
  });
  it("the brief copes with an empty aim", () => {
    expect(digestBrief({ aim: "  ", toolName: "read", digestTokens: 100 })).toContain(
      "no aim was given",
    );
  });
  it("the note says where the full result is, by path when it has one and by name when it does not", () => {
    const withPath = digestNote({
      toolName: "exec",
      rawTokens: 9000,
      rawName: "res-1",
      rawPath: "/tmp/x/res-1",
      digest: "D",
    });
    expect(withPath).toContain("/tmp/x/res-1");
    expect(withPath.endsWith("\nD")).toBe(true);
    const byName = digestNote({ toolName: "exec", rawTokens: 9000, rawName: "res-1", digest: "D" });
    expect(byName).toContain("res-1");
    expect(byName).not.toContain("/tmp");
  });
  it("approxTokens is about four characters a token", () => {
    expect(approxTokens("x".repeat(400))).toBe(100);
  });
});
