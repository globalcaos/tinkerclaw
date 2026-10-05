import { afterEach, describe, expect, it, vi } from "vitest";

// FORK 2026-10-02 — bug-log [reset-refused-after-a-turn]. When endSessionTurns gives up, the
// gateway answered only "still active", and it took a night of guessing to learn which holder it
// was. The warning now names the key form, the operation's phase before the cleanup's abort and
// after it, and its age.
//
// CONTROL. Before the change nothing is logged: the warn spy is never called.

const warn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "gateway/session-reset" ? { ...logger, warn } : logger;
    },
  };
});

import {
  __testing as replyRunTesting,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { endSessionTurns } from "./session-reset-service.js";

const KEY = "agent:main:tinker:held-probe";

afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  warn.mockReset();
  vi.useRealTimers();
});

describe("endSessionTurns names what held the session when it gives up", () => {
  it("logs the key form, the phase before and after the abort, and the age", async () => {
    vi.useFakeTimers();
    const op = createReplyOperation({
      sessionKey: KEY,
      sessionId: "s-held",
      resetTriggered: false,
    });
    op.setPhase("running");
    const pending = endSessionTurns({
      keys: { requestedKey: KEY, canonicalKey: KEY, storeKeys: [KEY] },
      reason: "session-reset",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ ended: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`${KEY} (phase=running→aborted, age=`);
    expect(warn.mock.calls[0][0]).toContain("session-reset: not ended");
  });

  it("logs nothing when the session ends", async () => {
    const pending = endSessionTurns({
      keys: { requestedKey: KEY, canonicalKey: KEY, storeKeys: [KEY] },
      reason: "session-reset",
    });
    await expect(pending).resolves.toMatchObject({ ended: true });
    expect(warn).not.toHaveBeenCalled();
  });
});
