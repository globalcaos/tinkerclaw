import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticLogger } from "../../logging/diagnostic.js";
import { registerInflightSteerHook } from "./inflight-steer-hook.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  consumeEmbeddedRunModelSwitch,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedPiRunActive,
  queueEmbeddedPiMessage,
  requestEmbeddedRunModelSwitch,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
} from "./runs.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: { isCompacting?: boolean; abort?: () => void } = {},
): RunHandle {
  const abort = overrides.abort ?? (() => {});
  return {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => overrides.isCompacting ?? false,
    abort,
  };
}

describe("queueEmbeddedPiMessage in-flight steer (P4)", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    registerInflightSteerHook(null);
    vi.restoreAllMocks();
  });

  it("folds a steered message into the live provider worker (inflight hook) and does NOT also pi-steer", async () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      setActiveEmbeddedRun("sess-live", {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
      });
      const steered: Array<[string, string]> = [];
      registerInflightSteerHook((sid, text) => {
        steered.push([sid, text]);
        return true; // a live worker accepted it
      });

      expect(queueEmbeddedPiMessage("sess-live", "fold me in")).toBe(true);
      await vi.advanceTimersByTimeAsync(350); // past the 300ms debounce

      expect(steered).toEqual([["sess-live", "fold me in"]]);
      expect(queueMessage).not.toHaveBeenCalled(); // NOT re-delivered as a next round
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the pi steeringQueue when no live worker accepts (hook returns false)", async () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      setActiveEmbeddedRun("sess-fallback", {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
      });
      registerInflightSteerHook(() => false); // no live provider worker

      queueEmbeddedPiMessage("sess-fallback", "queue me");
      await vi.advanceTimersByTimeAsync(350);

      expect(queueMessage).toHaveBeenCalledWith("queue me"); // existing next-round path
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches rapid steers into one injection before handing to the hook", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("sess-batch", createRunHandle());
      const steered: string[] = [];
      registerInflightSteerHook((_sid, text) => {
        steered.push(text);
        return true;
      });

      queueEmbeddedPiMessage("sess-batch", "one");
      queueEmbeddedPiMessage("sess-batch", "two");
      await vi.advanceTimersByTimeAsync(350);

      expect(steered).toEqual(["one\n\ntwo"]); // 300ms debounce coalesced both
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("steer buffer delivery contract (FORK 2026-08-28)", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    registerInflightSteerHook(null);
    vi.restoreAllMocks();
  });

  it("delivers a buffered follow-up as a NEW turn when the run ends inside the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      const handle = {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
      };
      setActiveEmbeddedRun("sess-ending", handle);
      const steered: string[] = [];
      registerInflightSteerHook((_sid, text) => {
        steered.push(text);
        return true; // would happily accept — must NOT be reached
      });
      const followups: Array<{ texts: string[]; combined: string }> = [];

      queueEmbeddedPiMessage("sess-ending", "wait, also check the logs", {
        onDeliveryLost: (texts, combined) => followups.push({ texts, combined }),
      });
      // the run finishes BEFORE the 300 ms debounce fires
      clearActiveEmbeddedRun("sess-ending", handle);
      await vi.advanceTimersByTimeAsync(350);

      expect(followups).toEqual([
        { texts: ["wait, also check the logs"], combined: "wait, also check the logs" },
      ]);
      // mutual exclusion: exactly ONE delivery path, never two
      expect(steered).toEqual([]);
      expect(queueMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("CONTROL: without a fallback the run-ending flush still lands on the dying run's queue", async () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      const handle = {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
      };
      setActiveEmbeddedRun("sess-ending-control", handle);

      queueEmbeddedPiMessage("sess-ending-control", "wait, also check the logs");
      clearActiveEmbeddedRun("sess-ending-control", handle);
      await vi.advanceTimersByTimeAsync(350);

      // Pre-fix shape: handed to a run that is deleted on the very next line.
      expect(queueMessage).toHaveBeenCalledWith("wait, also check the logs");
      expect(isEmbeddedPiRunActive("sess-ending-control")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers via the fallback when the run vanished before the flush timer fired", async () => {
    // The run registry is a global singleton but the steer buffer is
    // module-local, so a second module instance can end the run while this
    // one's debounce timer is still pending — the exact "no_active_run at
    // flush time" race that used to drop the message behind a debug line.
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=steer-lost-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=steer-lost-b",
    );
    runsA.__testing.resetActiveEmbeddedRuns();
    runsB.__testing.resetActiveEmbeddedRuns();
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      const handle = {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
      };
      runsA.setActiveEmbeddedRun("sess-lost", handle);
      const delivered: string[] = [];

      runsA.queueEmbeddedPiMessage("sess-lost", "please also check the logs", {
        onDeliveryLost: (_texts, combined) => delivered.push(combined),
      });
      runsB.clearActiveEmbeddedRun("sess-lost", handle);
      await vi.advanceTimersByTimeAsync(350);

      expect(delivered).toEqual(["please also check the logs"]);
      expect(queueMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      runsA.__testing.resetActiveEmbeddedRuns();
      runsB.__testing.resetActiveEmbeddedRuns();
    }
  });

  it("CONTROL: the same vanished-run flush with no fallback delivers nowhere and logs loudly", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=steer-lost-control-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=steer-lost-control-b",
    );
    runsA.__testing.resetActiveEmbeddedRuns();
    runsB.__testing.resetActiveEmbeddedRuns();
    const errorSpy = vi.spyOn(diagnosticLogger, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      const handle = {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
      };
      runsA.setActiveEmbeddedRun("sess-lost-control", handle);

      runsA.queueEmbeddedPiMessage("sess-lost-control", "the follow-up nobody registered for");
      runsB.clearActiveEmbeddedRun("sess-lost-control", handle);
      await vi.advanceTimersByTimeAsync(350);

      expect(queueMessage).not.toHaveBeenCalled();
      const dropLines = errorSpy.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("DROPPED a buffered user message"));
      expect(dropLines).toHaveLength(1);
      expect(dropLines[0]).toContain("the follow-up nobody registered for");
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
      runsA.__testing.resetActiveEmbeddedRuns();
      runsB.__testing.resetActiveEmbeddedRuns();
    }
  });

  it("caps the total buffering wait so a fast typist cannot postpone injection forever", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("sess-cap", createRunHandle());
      const steered: Array<{ text: string; atMs: number }> = [];
      const startedAt = Date.now();
      registerInflightSteerHook((_sid, text) => {
        steered.push({ text, atMs: Date.now() - startedAt });
        return true;
      });

      // A message every 250 ms — always inside the 300 ms debounce, so the
      // reset-on-every-message timer alone would NEVER fire.
      for (let i = 0; i < 6; i += 1) {
        queueEmbeddedPiMessage("sess-cap", `msg-${i}`);
        expect(steered).toHaveLength(0); // still nothing injected while typing
        await vi.advanceTimersByTimeAsync(250);
      }

      expect(steered).toHaveLength(1);
      expect(steered[0]?.atMs).toBe(1_500); // STEER_MAX_WAIT_MS from the FIRST message
      expect(steered[0]?.text).toBe("msg-0\n\nmsg-1\n\nmsg-2\n\nmsg-3\n\nmsg-4\n\nmsg-5");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("embedded-agent runner run registry", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun(
      "session-compacting",
      createRunHandle({ isCompacting: true, abort: abortCompacting }),
    );

    setActiveEmbeddedRun("session-normal", createRunHandle({ abort: abortNormal }));

    const aborted = abortEmbeddedPiRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", createRunHandle({ isCompacting: true, abort: abortA }));

    setActiveEmbeddedRun("session-b", createRunHandle({ abort: abortB }));

    const aborted = abortEmbeddedPiRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for active runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-a", handle);
      setTimeout(() => {
        clearActiveEmbeddedRun("session-a", handle);
      }, 500);

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await waitPromise;

      expect(result.drained).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns drained=false when timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("session-a", createRunHandle());

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waitPromise;
      expect(result.drained).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("shares active run state across distinct module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-b",
    );
    const handle = createRunHandle();

    runsA.__testing.resetActiveEmbeddedRuns();
    runsB.__testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedPiRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedPiRunActive("session-shared")).toBe(false);
    } finally {
      runsA.__testing.resetActiveEmbeddedRuns();
      runsB.__testing.resetActiveEmbeddedRuns();
    }
  });

  it("tracks and clears per-session transcript snapshots for active runs", () => {
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-snapshot", handle);
    updateActiveEmbeddedRunSnapshot("session-snapshot", {
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toEqual({
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });

    clearActiveEmbeddedRun("session-snapshot", handle);
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toBeUndefined();
  });

  it("stores and consumes pending live model switch requests", () => {
    expect(
      requestEmbeddedRunModelSwitch("session-switch", {
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toBe(true);

    expect(consumeEmbeddedRunModelSwitch("session-switch")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(consumeEmbeddedRunModelSwitch("session-switch")).toBeUndefined();
  });

  it("drops pending live model switch requests when the run clears", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-clear-switch", handle);
    requestEmbeddedRunModelSwitch("session-clear-switch", {
      provider: "openai",
      model: "gpt-5.4",
    });

    clearActiveEmbeddedRun("session-clear-switch", handle);

    expect(consumeEmbeddedRunModelSwitch("session-clear-switch")).toBeUndefined();
  });
});
