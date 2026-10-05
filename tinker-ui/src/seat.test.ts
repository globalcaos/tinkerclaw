import { describe, expect, it } from "vitest";
import { formatAgentBanner } from "../../src/shared/hivemind-seats.ts";

describe("formatAgentBanner (tinker re-export contract)", () => {
  it("matches GOKU (Alice)", () => {
    expect(formatAgentBanner("GOKU", "Alice")).toBe("GOKU (Alice)");
  });
});
