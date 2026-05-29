import { describe, it, expect } from "vitest";
import { parseUsesDirective } from "../kit-runner.js";

describe("parseUsesDirective — step-level sub-kit delegation", () => {
  it("normalizes a bare own-kit slug to globalcaos/<slug>", () => {
    expect(parseUsesDirective("uses: debug")).toBe("globalcaos/debug");
    expect(parseUsesDirective("Run the debugger.\nuses: code-review\nThen continue.")).toBe(
      "globalcaos/code-review",
    );
  });

  it("preserves an explicit owner/slug ref", () => {
    expect(parseUsesDirective("uses: globalcaos/feature")).toBe("globalcaos/feature");
    expect(parseUsesDirective("uses: someowner/their-kit")).toBe("someowner/their-kit");
  });

  it("returns undefined when there is no directive", () => {
    expect(parseUsesDirective("just a normal step body")).toBeUndefined();
    expect(parseUsesDirective("we use the debugger here")).toBeUndefined();
  });
});
