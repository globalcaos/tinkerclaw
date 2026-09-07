import { describe, expect, it } from "vitest";
import { detectSystemNotice } from "./system-notice.js";

// The exact string src/agents/main-session-restart-recovery.ts injects (buildResumeMessage).
const REAL_RESUME =
  "[System] The gateway restarted and interrupted your previous turn. Resume it, and make the resume legible to the user:\n" +
  "1. ORIENT FIRST — post one short message stating where you are picking up.\n" +
  "2. RECOVER CONTEXT — read any half-written artifacts.\n" +
  "3. CONTINUE as if nothing happened.";

describe("detectSystemNotice", () => {
  it("recognises the real post-restart wake-up as a restart-resume", () => {
    const n = detectSystemNotice(REAL_RESUME);
    expect(n?.kind).toBe("restart-resume");
    expect(n?.headline).toBe(
      "The gateway restarted and interrupted your previous turn. Resume it, and make the resume legible to the user:",
    );
    expect(n?.detail).toContain("1. ORIENT FIRST");
    expect(n?.detail).toContain("3. CONTINUE");
    // the prefix must not survive into what a human reads
    expect(n?.headline).not.toContain("[System]");
  });

  it("recognises the legacy prefrontal wording too", () => {
    const n = detectSystemNotice(
      "[System] Gateway restarted at 09:41 — resume from your current plan state.",
    );
    expect(n?.kind).toBe("restart-resume");
    expect(n?.detail).toBe("");
  });

  it("labels any other injected system prompt as generic, not as a restart", () => {
    const n = detectSystemNotice("[System] Your auth profile was rotated.");
    expect(n?.kind).toBe("system");
    expect(n?.headline).toBe("Your auth profile was rotated.");
  });

  it("leaves a human message alone even when it talks about restarts", () => {
    expect(detectSystemNotice("restart the gateway and resume please")).toBeNull();
    expect(detectSystemNotice("the gateway restarted and interrupted my turn")).toBeNull();
  });

  it("does not fire on a near-miss prefix — the bracket form must be exact", () => {
    expect(detectSystemNotice("[Systemd] unit failed")).toBeNull();
    expect(detectSystemNotice("System] stray")).toBeNull();
    expect(detectSystemNotice("(System) note")).toBeNull();
    expect(detectSystemNotice("[system] lowercase")).toBeNull();
  });

  it("tolerates leading whitespace, and refuses an empty body", () => {
    expect(detectSystemNotice("\n  [System] Something happened.")?.headline).toBe(
      "Something happened.",
    );
    expect(detectSystemNotice("[System]")).toBeNull();
    expect(detectSystemNotice("[System]    ")).toBeNull();
  });

  it("refuses non-strings", () => {
    expect(detectSystemNotice(undefined)).toBeNull();
    expect(detectSystemNotice(null)).toBeNull();
    expect(detectSystemNotice(42)).toBeNull();
  });
});
