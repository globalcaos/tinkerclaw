import { describe, it, expect } from "vitest";
import { parseUsesDirective, parseLoopDirective, isDryNote } from "../recipe-runner.js";

describe("parseUsesDirective — step-level sub-kit delegation", () => {
  it("normalizes a bare own-kit slug to globalcaos/<slug> (first non-blank line)", () => {
    expect(parseUsesDirective("uses: debug")).toBe("globalcaos/debug");
    expect(parseUsesDirective("\n\n  uses: code-review  \n")).toBe("globalcaos/code-review");
  });

  it("preserves an explicit owner/slug ref", () => {
    expect(parseUsesDirective("uses: globalcaos/feature")).toBe("globalcaos/feature");
    expect(parseUsesDirective("uses: someowner/their-kit")).toBe("someowner/their-kit");
  });

  it("only triggers when uses: is the FIRST non-blank line (not buried in prose/code)", () => {
    // Buried in prose → must NOT dispatch (review finding 2026-05-29).
    expect(parseUsesDirective("Run the debugger.\nuses: code-review")).toBeUndefined();
    // Inside a fenced code block (documentation) → must NOT dispatch.
    expect(parseUsesDirective("```\nuses: debug\n```")).toBeUndefined();
  });

  it("returns undefined when there is no directive", () => {
    expect(parseUsesDirective("just a normal step body")).toBeUndefined();
    expect(parseUsesDirective("we use the debugger here")).toBeUndefined();
  });
});

describe("parseLoopDirective — recipe loops", () => {
  it("count mode", () => {
    expect(parseLoopDirective("loop: count 3")).toEqual({ mode: "count", max: 3 });
  });
  it("until-dry with default + explicit max", () => {
    expect(parseLoopDirective("loop: until-dry")).toEqual({ mode: "until-dry", max: 5 });
    expect(parseLoopDirective("loop: until-dry max 8")).toEqual({ mode: "until-dry", max: 8 });
  });
  it("until-marker", () => {
    expect(parseLoopDirective("loop: until DONE")).toEqual({
      mode: "until-marker",
      marker: "DONE",
      max: 5,
    });
    expect(parseLoopDirective("loop: until DONE max 6")).toEqual({
      mode: "until-marker",
      marker: "DONE",
      max: 6,
    });
  });
  it("clamps max to the hard ceiling (25)", () => {
    expect(parseLoopDirective("loop: count 999")?.max).toBe(25);
  });
  it("coexists with a uses: directive on the leading lines", () => {
    const body = "uses: debug\nloop: count 3";
    expect(parseUsesDirective(body)).toBe("globalcaos/debug");
    expect(parseLoopDirective(body)).toEqual({ mode: "count", max: 3 });
  });
  it("returns undefined when there is no loop directive", () => {
    expect(parseLoopDirective("just a normal step")).toBeUndefined();
    expect(parseLoopDirective("we loop over the files")).toBeUndefined();
  });
});

describe("isDryNote — until-dry stop condition", () => {
  it("empty/absent notes are dry", () => {
    expect(isDryNote(null)).toBe(true);
    expect(isDryNote("")).toBe(true);
    expect(isDryNote("   ")).toBe(true);
  });
  it("completion language is dry", () => {
    expect(isDryNote("no new findings this pass")).toBe(true);
    expect(isDryNote("DONE")).toBe(true);
    expect(isDryNote("scan complete, nothing left")).toBe(true);
    expect(isDryNote("exhausted the candidates")).toBe(true);
  });
  it("ongoing-work notes are NOT dry", () => {
    expect(isDryNote("found 3 new bugs")).toBe(false);
    expect(isDryNote("added 2 more sites to the corpus")).toBe(false);
  });
});
