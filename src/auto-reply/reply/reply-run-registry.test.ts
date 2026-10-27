import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  abortActiveReplyRuns,
  createReplyOperation,
  isReplyRunActiveForSessionId,
  queueReplyRunMessage,
  replyRunRegistry,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "./reply-run-registry.js";

describe("reply run registry", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
    vi.restoreAllMocks();
  });

  it("keeps ownership stable by sessionKey while sessionId rotates", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-old",
        resetTriggered: false,
      });

      const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);

      operation.updateSessionId("session-new");

      expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
      expect(resolveActiveReplyRunSessionId("agent:main:main")).toBe("session-new");
      expect(isReplyRunActiveForSessionId("session-old")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-new")).toBe(true);

      let settled = false;
      void oldWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      operation.complete();

      await expect(oldWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  // FORK 2026-10-02 — bug-log [reset-refused-after-a-turn]. An operation that a newer one replaced
  // (the stale force-clear) must not clear the newer one when it finally ends. CONTROL: before the
  // owner check, `old.complete()` deleted the new operation's entry and woke its waiters.
  it("lets an operation that was replaced end without clearing the one that replaced it", async () => {
    const old = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-a",
      resetTriggered: false,
    });
    old.setPhase("running");
    const replacement = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-b",
      resetTriggered: false,
    });
    old.complete();
    expect(replyRunRegistry.get("agent:main:main")).toBe(replacement);
    await expect(replyRunRegistry.waitForIdle("agent:main:main", 100)).resolves.toBe(false);
    replacement.complete();
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("clears queued operations immediately on user abort", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-queued",
      resetTriggered: false,
    });

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("queues messages only through the active running backend", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });

    expect(queueReplyRunMessage("session-running", "before running")).toBe(false);

    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const compactingOperation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compacting",
      resetTriggered: false,
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
      resetTriggered: false,
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
  });
});
