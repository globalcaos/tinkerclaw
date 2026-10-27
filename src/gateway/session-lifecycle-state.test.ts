import { describe, expect, it } from "vitest";
import {
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
} from "./session-lifecycle-state.js";

describe("session lifecycle state", () => {
  // FORK 2026-09-29 (lifecycles.md L4b): a run that ENDS because the gateway is shutting down is
  // interrupted, not finished. Stored as done, it hid from boot recovery, which only resumes chats
  // still `running`; a plain restart silently dropped every mid-turn chat.
  it("keeps a run that ends during shutdown running and marks it aborted", () => {
    for (const phase of ["end", "error"]) {
      expect(
        derivePersistedSessionLifecyclePatch({
          entry: { updatedAt: 1_000, status: "running", startedAt: 1_200 },
          event: { ts: 2_000, data: { phase, startedAt: 1_200, endedAt: 1_900 } },
          shuttingDown: true,
        }),
      ).toEqual({ updatedAt: 1_900, status: "running", abortedLastRun: true });
    }
  });

  it("treats a run that starts during shutdown normally", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: { status: "done" },
        event: { ts: 2_000, data: { phase: "start", startedAt: 1_950 } },
        shuttingDown: true,
      }),
    ).toMatchObject({ status: "running", abortedLastRun: false });
  });

  it("still marks an ordinary end as done when the gateway is not shutting down", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: { status: "running", startedAt: 1_200 },
        event: { ts: 2_000, data: { phase: "end", startedAt: 1_200, endedAt: 1_900 } },
        shuttingDown: false,
      }),
    ).toMatchObject({ status: "done", abortedLastRun: false });
  });

  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 500,
          status: "done",
          startedAt: 100,
          endedAt: 400,
          runtimeMs: 300,
          abortedLastRun: true,
        },
        event: {
          ts: 1_000,
          data: {
            phase: "start",
            startedAt: 900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 900,
      status: "running",
      startedAt: 900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_200,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            startedAt: 1_200,
            endedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "done",
      startedAt: 1_200,
      endedAt: 1_900,
      runtimeMs: 700,
      abortedLastRun: false,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_800,
            stopReason: "aborted",
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_800,
      status: "killed",
      startedAt: 1_100,
      endedAt: 1_800,
      runtimeMs: 700,
      abortedLastRun: true,
    });
  });

  it("maps aborted lifecycle end events without stopReason to timeout", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_550,
            aborted: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });
});
