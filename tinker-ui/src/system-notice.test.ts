import { describe, expect, it } from "vitest";
import { detectAgentMessage, detectSystemNotice } from "./system-notice.js";

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

// the architect 2026-10-03, about a restart resume that reached his chat behind Thalamus's advice and drew as his bubble:
// "If it was an agent that introduced it ... it should be properly presented as such, with the identity of the
// agent, and in blue".
const ADVICE =
  "These enhancements may fit this task, most likely first. It is advice: take one, take another, or take none.\n" +
  "1. recipe Finish a branch, 99%: The definition of done (/x/finish-branch.md)\n" +
  "None of these may fit; use your own judgment.\n\n";

describe("detectSystemNotice: who sent it, past a delivery stamp and Thalamus advice", () => {
  it("the 10-02 18:20 resume: advice, then a delivery stamp, then [System]", () => {
    const n = detectSystemNotice(
      `${ADVICE}[Fri 2026-10-02 18:19 GMT+2] [System] The gateway restarted and interrupted your previous turn. Resume it.\n1. ORIENT FIRST`,
    );
    expect(n).toMatchObject({ kind: "restart-resume", who: "the gateway · restart recovery" });
    expect(n!.headline).toBe(
      "The gateway restarted and interrupted your previous turn. Resume it.",
    );
    expect(n!.advice).toContain("Finish a branch");
  });

  it("names the gateway's other notes, a producer's own [System · name], and a bare [System]", () => {
    expect(
      detectSystemNotice("[System] The gateway restart you requested at 16:29 finished.")!.who,
    ).toBe("the gateway-restart skill");
    expect(
      detectSystemNotice("[System] Your previous turn was interrupted by a gateway reload.")!.who,
    ).toBe("the gateway · subagent recovery");
    expect(detectSystemNotice("[System · longjob] build-42 finished")).toMatchObject({
      who: "longjob",
      headline: "build-42 finished",
    });
    expect(detectSystemNotice("[Thu 2026-10-01 16:31 GMT+2] [System] continue")!.who).toBe(
      "the system",
    );
  });

  it("his own words stay his, with advice or a stamp in front", () => {
    expect(
      detectSystemNotice(`${ADVICE}[Sat 2026-10-03 08:32 GMT+2] Where does this come from?`),
    ).toBeNull();
    expect(
      detectSystemNotice("[Sat 2026-10-03 08:32 GMT+2] I typed [System] in a sentence"),
    ).toBeNull();
  });
});

describe("detectAgentMessage", () => {
  it("another agent's message names that agent", () => {
    const m = detectAgentMessage(
      '<cross-session-message from="uds:/run/user/1000/cc-socks/1.sock" from-name="jarvis-workspace-05">\nrun phase F\nthen report\n</cross-session-message>',
    );
    expect(m).toMatchObject({
      who: "jarvis-workspace-05",
      headline: "run phase F",
      detail: "then report",
    });
  });
  it("anything else is not an agent message", () => {
    expect(detectAgentMessage("How is Amygdala going?")).toBeNull();
    expect(detectAgentMessage("[System] x")).toBeNull();
  });
});
