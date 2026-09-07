import { describe, expect, it } from "vitest";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import {
  HEADLESS_REQUESTER_SUFFIX,
  resolveHeadlessRequesterSessionKey,
} from "./headless-requester-session-key.js";

describe("resolveHeadlessRequesterSessionKey", () => {
  it("falls back to the default agent id when none is provided", () => {
    expect(resolveHeadlessRequesterSessionKey()).toBe("agent:main:orchestrator");
    expect(resolveHeadlessRequesterSessionKey(undefined)).toBe("agent:main:orchestrator");
    expect(resolveHeadlessRequesterSessionKey("")).toBe("agent:main:orchestrator");
    expect(resolveHeadlessRequesterSessionKey("   ")).toBe("agent:main:orchestrator");
  });

  it("uses the explicit agent id when provided", () => {
    expect(resolveHeadlessRequesterSessionKey("ops")).toBe("agent:ops:orchestrator");
    // Agent ids are normalized (lowercased) like everywhere else.
    expect(resolveHeadlessRequesterSessionKey("OPS")).toBe("agent:ops:orchestrator");
  });

  it("parses as a canonical agent session key with the orchestrator rest", () => {
    const parsed = parseAgentSessionKey(resolveHeadlessRequesterSessionKey("ops"));
    expect(parsed).toEqual({ agentId: "ops", rest: HEADLESS_REQUESTER_SUFFIX });
  });

  it("never collides with the protected Main tab key", () => {
    // tinker-ui/src/app.ts identifies the protected "🏠 Main" tab with
    // `key.endsWith(":main")` — the headless sink must never satisfy it.
    const candidates = [
      resolveHeadlessRequesterSessionKey(),
      resolveHeadlessRequesterSessionKey("main"),
      resolveHeadlessRequesterSessionKey("ops"),
      // Hostile input: ":" is not a valid agent-id character and is collapsed,
      // so it cannot smuggle a ":main" suffix into the key.
      resolveHeadlessRequesterSessionKey("evil:main"),
    ];
    for (const key of candidates) {
      expect(key.endsWith(":main")).toBe(false);
      expect(key).not.toMatch(/^agent:[^:]*:main$/);
    }
  });
});
