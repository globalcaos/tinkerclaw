import { beforeEach, describe, expect, it } from "vitest";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { listSessionAttachments, type ProcessProbe } from "./session-attachments.js";

const SESSION_ID = "315076d6-1111-2222-3333-444455556666";
const NOW = 1_755_000_000_000;

function fakeProcesses(...probes: ProcessProbe[]): () => ProcessProbe[] {
  return () => probes;
}

beforeEach(() => {
  resetDiagnosticSessionStateForTest();
});

describe("listSessionAttachments", () => {
  it("finds a matching cli process, stoppable, with age from now", () => {
    const attachments = listSessionAttachments({
      sessionId: SESSION_ID,
      now: NOW,
      readProcesses: fakeProcesses({
        pid: 54_321,
        cmdline: `openclaw agent --session-id ${SESSION_ID}`,
        startedAt: NOW - 60_000,
      }),
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "process:54321",
      kind: "process",
      label: "cli agent",
      pid: 54_321,
      stoppable: true,
      startedAt: NOW - 60_000,
      ageMs: 60_000,
    });
  });

  it("labels a non-openclaw match as attached process and truncates detail to 160 chars", () => {
    const attachments = listSessionAttachments({
      sessionId: SESSION_ID,
      now: NOW,
      readProcesses: fakeProcesses({
        pid: 60_001,
        cmdline: `node worker.js --session ${SESSION_ID} ${"x".repeat(300)}`,
      }),
    });
    expect(attachments[0]?.label).toBe("attached process");
    expect(attachments[0]?.detail).toHaveLength(160);
  });

  it("excludes the gateway process even when its cmdline matches", () => {
    const attachments = listSessionAttachments({
      sessionId: SESSION_ID,
      now: NOW,
      readProcesses: fakeProcesses({
        pid: 60_002,
        cmdline: `openclaw gateway --port 18789 ${SESSION_ID}`,
      }),
    });
    expect(attachments).toEqual([]);
  });

  it("excludes the current process and pid 1", () => {
    const attachments = listSessionAttachments({
      sessionId: SESSION_ID,
      now: NOW,
      readProcesses: fakeProcesses(
        { pid: process.pid, cmdline: `openclaw agent --session-id ${SESSION_ID}` },
        { pid: 1, cmdline: `init ${SESSION_ID}` },
      ),
    });
    expect(attachments).toEqual([]);
  });

  it("emits a run row for a processing session", () => {
    const state = getDiagnosticSessionState({
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    });
    state.state = "processing";
    state.lastActivity = NOW - 5_000;
    const attachments = listSessionAttachments({
      sessionKey: "agent:main:main",
      now: NOW,
      readProcesses: fakeProcesses(),
    });
    expect(attachments).toEqual([
      {
        id: "run:agent:main:main",
        kind: "run",
        label: "turn running",
        startedAt: NOW - 5_000,
        ageMs: 5_000,
        stoppable: true,
      },
    ]);
  });

  // FORK 2026-08-28: the strip deliberately no longer mirrors `queueDepth`. These two tests
  // replace the former "emits a queued row with a singular/plural label" pair — the behaviour
  // they asserted is the bug (one prompt described twice), so the assertion is inverted rather
  // than deleted: a silent absence would let the row come back without a test going red.
  it("emits NO queued row, however deep the server-side queue is", () => {
    const state = getDiagnosticSessionState({ sessionKey: "agent:main:main" });
    state.queueDepth = 3;
    state.lastActivity = NOW - 1_000;
    const attachments = listSessionAttachments({
      sessionKey: "agent:main:main",
      now: NOW,
      readProcesses: fakeProcesses(),
    });
    expect(attachments).toEqual([]);
  });

  it("leaves the run row and the process rows untouched while queueDepth is non-zero", () => {
    const state = getDiagnosticSessionState({
      sessionKey: "agent:main:main",
      sessionId: SESSION_ID,
    });
    state.state = "processing";
    state.queueDepth = 2;
    state.lastActivity = NOW - 5_000;
    const attachments = listSessionAttachments({
      sessionId: SESSION_ID,
      sessionKey: "agent:main:main",
      now: NOW,
      readProcesses: fakeProcesses(
        {
          pid: 60_003,
          cmdline: `openclaw agent --session-id ${SESSION_ID}`,
          startedAt: NOW - 10_000,
        },
        {
          pid: 60_004,
          cmdline: `openclaw agent --session-id ${SESSION_ID}`,
          startedAt: NOW - 90_000,
        },
      ),
    });
    expect(attachments.map((a) => a.kind)).toEqual(["run", "process", "process"]);
    expect(attachments.some((a) => a.kind === "queued")).toBe(false);
    expect(attachments[0]).toMatchObject({
      id: "run:agent:main:main",
      label: "turn running",
      startedAt: NOW - 5_000,
      ageMs: 5_000,
      stoppable: true,
    });
    // processes still oldest-first
    expect(attachments[1]?.pid).toBe(60_004);
    expect(attachments[2]?.pid).toBe(60_003);
  });

  it("returns an empty list when nothing matches", () => {
    const attachments = listSessionAttachments({
      sessionId: "no-such-session",
      now: NOW,
      readProcesses: fakeProcesses({
        pid: 60_005,
        cmdline: "openclaw agent --session-id something-else",
      }),
    });
    expect(attachments).toEqual([]);
  });
});
