import { describe, expect, it } from "vitest";
import {
  refreshAnchorInstruction,
  resolveTitleKind,
  sameSubject,
  titleWords,
  turnEndTitleAction,
} from "./tab-title-policy.js";

const ICON = "🏷️";

describe("resolveTitleKind", () => {
  it("honours an explicit kind", () => {
    expect(
      resolveTitleKind({ titleKind: "manual", titleLocked: true, title: `${ICON} x` }, ICON),
    ).toBe("manual");
    expect(resolveTitleKind({ titleKind: "auto", titleLocked: true, title: "plain" }, ICON)).toBe(
      "auto",
    );
    expect(resolveTitleKind({ titleKind: "fortune", titleLocked: true }, ICON)).toBe("fortune");
  });
  it("legacy unlocked tab is a fortune", () => {
    expect(resolveTitleKind({ title: "🌊 Let the river carry…" }, ICON)).toBe("fortune");
    expect(resolveTitleKind({ titleLocked: false, title: "anything" }, ICON)).toBe("fortune");
  });
  it("legacy locked tab is MANUAL unless it wears the auto icon", () => {
    expect(resolveTitleKind({ titleLocked: true, title: "🔧 Auth token refresh" }, ICON)).toBe(
      "manual",
    );
    expect(resolveTitleKind({ titleLocked: true, title: "my notes" }, ICON)).toBe("manual");
    expect(resolveTitleKind({ titleLocked: true, title: `${ICON} Flaky CI retries` }, ICON)).toBe(
      "auto",
    );
  });
  it("ignores a garbage kind value", () => {
    expect(
      resolveTitleKind(
        { titleKind: "weird" as unknown as "auto", titleLocked: true, title: "x" },
        ICON,
      ),
    ).toBe("manual");
  });
});

describe("turnEndTitleAction", () => {
  const base = { interval: 5, wearsDefaultName: false };
  it("manual: never, whatever the turn", () => {
    for (const tabTurns of [1, 2, 5, 10, 25]) {
      expect(turnEndTitleAction({ ...base, kind: "manual", tabTurns })).toBeNull();
      expect(
        turnEndTitleAction({ ...base, kind: "manual", tabTurns, wearsDefaultName: true }),
      ).toBeNull();
    }
  });
  it("fortune: fires at the first prompt", () => {
    expect(
      turnEndTitleAction({ ...base, kind: "fortune", tabTurns: 1, wearsDefaultName: true }),
    ).toBe("first");
    expect(turnEndTitleAction({ ...base, kind: "fortune", tabTurns: 1 })).toBe("first");
  });
  it("fortune: retries on every later turn while still wearing the cookie", () => {
    for (const tabTurns of [2, 3, 4, 7]) {
      expect(
        turnEndTitleAction({ ...base, kind: "fortune", tabTurns, wearsDefaultName: true }),
      ).toBe("retry");
    }
    expect(turnEndTitleAction({ ...base, kind: "fortune", tabTurns: 0 })).toBeNull();
  });
  it("auto: refreshes only on the interval", () => {
    expect(turnEndTitleAction({ ...base, kind: "auto", tabTurns: 1 })).toBeNull();
    expect(turnEndTitleAction({ ...base, kind: "auto", tabTurns: 4 })).toBeNull();
    expect(turnEndTitleAction({ ...base, kind: "auto", tabTurns: 5 })).toBe("refresh");
    expect(turnEndTitleAction({ ...base, kind: "auto", tabTurns: 10 })).toBe("refresh");
    expect(turnEndTitleAction({ ...base, kind: "auto", tabTurns: 0 })).toBeNull();
    expect(
      turnEndTitleAction({ kind: "auto", tabTurns: 5, wearsDefaultName: false, interval: 0 }),
    ).toBeNull();
  });
});

describe("titleWords / sameSubject", () => {
  it("strips a leading emoji, case, whitespace and trailing punctuation", () => {
    expect(titleWords("🔧 Auth token refresh")).toBe("auth token refresh");
    expect(titleWords(`${ICON}  Flaky   CI retries.`)).toBe("flaky ci retries");
    expect(titleWords("  plain  ")).toBe("plain");
    expect(titleWords("")).toBe("");
  });
  it("same words under a different emoji is the same subject", () => {
    expect(sameSubject("🔧 Auth token refresh", "🛠️ auth token refresh")).toBe(true);
    expect(sameSubject("🔧 Auth token refresh", "Auth token refresh")).toBe(true);
  });
  it("different words is a shifted subject", () => {
    expect(sameSubject("🔧 Auth token refresh", "📊 Q3 revenue model")).toBe(false);
    expect(sameSubject("🔧 Auth token refresh", "🔧 Auth token rotation")).toBe(false);
  });
  it("an empty or null proposal is never a rename", () => {
    expect(sameSubject("🔧 Auth token refresh", null)).toBe(true);
    expect(sameSubject("🔧 Auth token refresh", "")).toBe(true);
    expect(sameSubject("🔧 Auth token refresh", "🔧")).toBe(true);
  });
});

describe("refreshAnchorInstruction", () => {
  it("quotes the current words and asks for them back unless the subject shifted", () => {
    const s = refreshAnchorInstruction("🔧 Auth token refresh");
    expect(s).toContain('"auth token refresh"');
    expect(s).toMatch(/EXACTLY that current name/);
    expect(s).toMatch(/genuinely shifted/);
  });
});
