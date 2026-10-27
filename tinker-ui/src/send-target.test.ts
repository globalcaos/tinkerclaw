import { describe, expect, it } from "vitest";
import { captureSendTarget, sendTargetIsActive } from "./send-target.js";

const matches = (a?: string, b?: string) => Boolean(a && b && (a === b || a.endsWith(b)));

describe("send target isolation", () => {
  it("keeps the tab and session captured before an await when the active tab later changes", () => {
    let activeTabId = "tab-neurocoin";
    let activeSessionKey = "agent:main:tinker:neurocoin";
    const target = captureSendTarget(activeTabId, activeSessionKey);

    activeTabId = "tab-goku";
    activeSessionKey = "agent:main:tinker:goku";

    expect(target).toEqual({
      tabId: "tab-neurocoin",
      sessionKey: "agent:main:tinker:neurocoin",
    });
    expect(target && sendTargetIsActive(target, activeTabId, activeSessionKey, matches)).toBe(
      false,
    );
  });

  it("requires both the tab and its session binding to remain active", () => {
    const target = captureSendTarget("tab-neurocoin", "agent:main:tinker:neurocoin")!;
    expect(sendTargetIsActive(target, "tab-neurocoin", "tinker:neurocoin", matches)).toBe(true);
    expect(sendTargetIsActive(target, "tab-neurocoin", "tinker:goku", matches)).toBe(false);
    expect(sendTargetIsActive(target, "tab-goku", "tinker:neurocoin", matches)).toBe(false);
  });

  it("rejects an unresolved destination", () => {
    expect(captureSendTarget("tab-neurocoin", "")).toBeNull();
    expect(captureSendTarget("", "tinker:neurocoin")).toBeNull();
  });
});
