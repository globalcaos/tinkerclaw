import { describe, expect, it } from "vitest";
import { isLongUsageWindow, usageWindowOf } from "./usage-window.js";

describe("usageWindowOf — which limit window a provider message names", () => {
  it("reads the windows the Claude CLI and the API name", () => {
    expect(usageWindowOf("You've hit your weekly limit · resets Oct 8, 6pm (Europe/Madrid)")).toBe(
      "weekly",
    );
    expect(usageWindowOf("You've hit your session limit · resets 3pm")).toBe("session");
    expect(usageWindowOf("5-hour usage limit reached")).toBe("five-hour");
    expect(usageWindowOf("429 Too Many Requests: rate limit of 50 requests per minute")).toBe(
      "burst",
    );
    expect(usageWindowOf("Rate limited")).toBeNull();
    expect(usageWindowOf(undefined)).toBeNull();
  });

  it("only hours-or-days windows are long", () => {
    expect(isLongUsageWindow("You've hit your weekly limit · resets Oct 8, 6pm")).toBe(true);
    expect(isLongUsageWindow("You've hit your session limit")).toBe(true);
    expect(isLongUsageWindow("five-hour limit reached")).toBe(true);
    expect(isLongUsageWindow("429 too many requests")).toBe(false);
    expect(isLongUsageWindow("The provider is rate-limiting requests")).toBe(false);
    expect(isLongUsageWindow(42)).toBe(false);
  });
});
