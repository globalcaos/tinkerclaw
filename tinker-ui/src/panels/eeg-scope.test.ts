import { describe, expect, it } from "vitest";
import { eegAxisLabel, eegIsInScope, eegRenderClassOf, type EegScopeDeps } from "./eeg-scope.js";

const VIEWED = "agent:main:dashboard:aaaa";
const OTHER_TAB = "agent:main:tinker:bbbb";
const LEG = "agent:main:subagent:cccc"; // a fan-out leg the viewed tab launched
const ORCHESTRATOR = "agent:main:orchestrator";
const FRACTAL = "agent:main:fractal-reflection:dddd";
const TEMP = "temp:title-suggest";

function deps(over: Partial<EegScopeDeps> = {}): EegScopeDeps {
  return {
    isTab: (sk) => sk === VIEWED || sk === OTHER_TAB,
    belongsToViewedTab: (sk) => sk === VIEWED,
    ...over,
  };
}

describe("eegRenderClassOf", () => {
  it("classifies the viewed tab, another tab, and machinery", () => {
    const d = deps();
    expect(eegRenderClassOf(VIEWED, d)).toBe("viewed");
    expect(eegRenderClassOf(OTHER_TAB, d)).toBe("other-tab");
    expect(eegRenderClassOf(ORCHESTRATOR, d)).toBe("background");
    expect(eegRenderClassOf(FRACTAL, d)).toBe("background");
    expect(eegRenderClassOf(TEMP, d)).toBe("background");
  });

  // The point of the whole exercise: work the viewed tab STARTED is the viewed tab's work, even
  // though a fan-out leg's own key is not a tab key.
  it("draws a leg the viewed tab launched as solid, not as machinery", () => {
    const d = deps({ belongsToViewedTab: (sk) => sk === VIEWED || sk === LEG });
    expect(eegRenderClassOf(LEG, d)).toBe("viewed");
  });

  it("never lets ownership be outranked by not-a-tab", () => {
    // A leg is not a tab; ownership must still win, or the fix regresses to invisibility.
    const d = deps({ isTab: () => false, belongsToViewedTab: (sk) => sk === LEG });
    expect(eegRenderClassOf(LEG, d)).toBe("viewed");
  });

  it("treats an empty key as machinery rather than throwing", () => {
    expect(eegRenderClassOf("", deps())).toBe("background");
  });
});

describe("eegIsInScope", () => {
  it("Session shows only the viewed tab's own work", () => {
    expect(eegIsInScope("viewed", "session", false)).toBe(true);
    expect(eegIsInScope("other-tab", "session", false)).toBe(false);
    expect(eegIsInScope("background", "session", false)).toBe(false);
  });

  it("All shows every tab, and machinery unless muted", () => {
    expect(eegIsInScope("viewed", "all", false)).toBe(true);
    expect(eegIsInScope("other-tab", "all", false)).toBe(true);
    expect(eegIsInScope("background", "all", false)).toBe(true);
    expect(eegIsInScope("background", "all", true)).toBe(false);
  });

  it("muting background never hides a human tab", () => {
    expect(eegIsInScope("viewed", "all", true)).toBe(true);
    expect(eegIsInScope("other-tab", "all", true)).toBe(true);
  });
});

describe("eegAxisLabel — the honesty contract", () => {
  it("says TOTAL only when the paper really is the total", () => {
    expect(eegAxisLabel("all", false, true)).toBe("€ total spend");
    expect(eegAxisLabel("all", false, false)).toBe("€ total spend");
  });

  // Muting background lanes makes the grid a partial ledger; it must stop claiming to be the bill.
  it("downgrades to SHOWN spend the moment background lanes are hidden", () => {
    expect(eegAxisLabel("all", true, true)).toBe("€ shown spend");
  });

  it("does not cry wolf when there was no background spend to hide", () => {
    expect(eegAxisLabel("all", true, false)).toBe("€ total spend");
  });

  it("never claims total in Session scope, which is one tab by construction", () => {
    expect(eegAxisLabel("session", false, true)).toBe("€ this tab");
    expect(eegAxisLabel("session", true, true)).toBe("€ this tab");
  });
});
