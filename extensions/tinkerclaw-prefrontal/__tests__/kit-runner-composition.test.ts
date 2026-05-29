import { describe, it, expect } from "vitest";
import { parseUsesDirective } from "../kit-runner.js";

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
