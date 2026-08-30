// FORK 2026-07-22 (error-partial-preserve): when an embedded run dies in
// error/timeout, the buffered streamed partial used to be discarded by
// clearBufferedChatState in the lifecycle-error branch — two 46-minute turns
// died to `FailoverError: LLM request timed out.` and the tab showed nothing.
// These tests pin the fix: the partial is captured before the wipe, persisted
// to the session transcript exactly once (abort-path `${runId}:assistant`
// idempotencyKey precedent), and attached to the error broadcast via the
// schema-legal `message` field.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";

const persistGatewaySessionLifecycleEventMock = vi.fn();

vi.mock("./server-chat.persist-session-lifecycle.runtime.js", () => ({
  persistGatewaySessionLifecycleEvent: (...args: unknown[]) =>
    persistGatewaySessionLifecycleEventMock(...args),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

vi.mock("./server-chat.load-gateway-session-row.runtime.js", () => ({
  loadGatewaySessionRow: vi.fn(),
}));

const loadSessionEntryMock = vi.fn();

vi.mock("./session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  };
});

import { getRuntimeConfig } from "../config/io.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createToolEventRecipientRegistry,
  persistPreservedErrorPartial,
  type PreservedErrorPartialParams,
} from "./server-chat.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";

describe("error-finalize partial preservation", () => {
  beforeEach(() => {
    vi.mocked(getRuntimeConfig).mockReturnValue({});
    vi.mocked(loadGatewaySessionRow).mockReset().mockReturnValue(null);
    persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
    loadSessionEntryMock.mockReset();
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentRunContextForTest();
  });

  function createHarness(params?: {
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
    lifecycleErrorRetryGraceMs?: number;
    isChatSendRunActive?: (runId: string) => boolean;
  }) {
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const clearAgentRunContext = vi.fn();
    const persistErrorPartial = vi.fn<(p: PreservedErrorPartialParams) => void>();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext,
      toolEventRecipients,
      sessionEventSubscribers,
      loadGatewaySessionRowForSnapshot: loadGatewaySessionRow,
      lifecycleErrorRetryGraceMs: params?.lifecycleErrorRetryGraceMs ?? 0,
      isChatSendRunActive: params?.isChatSendRunActive,
      persistErrorPartial,
    });

    return {
      broadcast,
      nodeSendToSession,
      persistErrorPartial,
      chatRunState,
      handler,
    };
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function addRun1(harness: ReturnType<typeof createHarness>) {
    harness.chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });
    return harness;
  }

  function emitAssistantText(
    handler: ReturnType<typeof createHarness>["handler"],
    text: string,
    seq = 1,
  ) {
    handler({
      runId: "run-1",
      seq,
      stream: "assistant",
      ts: Date.now(),
      data: { text },
    });
  }

  function emitLifecycleError(handler: ReturnType<typeof createHarness>["handler"], seq = 2) {
    handler({
      runId: "run-1",
      seq,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "FailoverError: LLM request timed out." },
    });
  }

  it("persists the buffered partial exactly once on error finalize and attaches it to the error broadcast", () => {
    const { broadcast, persistErrorPartial, handler } = addRun1(createHarness());

    emitAssistantText(handler, "Partial answer streamed before the timeout.");
    emitLifecycleError(handler);

    expect(persistErrorPartial).toHaveBeenCalledTimes(1);
    expect(persistErrorPartial).toHaveBeenCalledWith({
      sessionKey: "session-1",
      runId: "client-1",
      text: "Partial answer streamed before the timeout.",
    });

    const errorCalls = chatBroadcastCalls(broadcast).filter(
      ([, payload]) => (payload as { state?: string }).state === "error",
    );
    expect(errorCalls).toHaveLength(1);
    const errorPayload = errorCalls[0]?.[1] as {
      runId?: string;
      errorMessage?: string;
      message?: { role?: string; content?: Array<{ text?: string }> };
    };
    expect(errorPayload.runId).toBe("client-1");
    expect(errorPayload.errorMessage).toContain("LLM request timed out");
    expect(errorPayload.message?.role).toBe("assistant");
    expect(errorPayload.message?.content?.[0]?.text).toBe(
      "Partial answer streamed before the timeout.",
    );

    // Double finalize (duplicate terminal error event) must not persist twice.
    emitLifecycleError(handler, 3);
    expect(persistErrorPartial).toHaveBeenCalledTimes(1);
  });

  it("defers persistence until the retry grace expires", () => {
    vi.useFakeTimers();
    const { broadcast, persistErrorPartial, handler } = addRun1(
      createHarness({ lifecycleErrorRetryGraceMs: 100 }),
    );

    emitAssistantText(handler, "Half an answer");
    emitLifecycleError(handler);

    expect(persistErrorPartial).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(persistErrorPartial).toHaveBeenCalledTimes(1);
    expect(persistErrorPartial).toHaveBeenCalledWith({
      sessionKey: "session-1",
      runId: "client-1",
      text: "Half an answer",
    });
    const errorPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(errorPayload.state).toBe("error");
    expect(errorPayload.message?.content?.[0]?.text).toBe("Half an answer");
  });

  it("drops the captured partial when a retry supersedes the lifecycle error", () => {
    vi.useFakeTimers();
    const { broadcast, persistErrorPartial, handler } = addRun1(
      createHarness({ lifecycleErrorRetryGraceMs: 100 }),
    );

    emitAssistantText(handler, "Attempt one partial");
    emitLifecycleError(handler);

    // Fallback lifecycle event reuses the runId — the error was not terminal.
    handler({
      runId: "run-1",
      seq: 3,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "fallback", selectedProvider: "other", activeProvider: "primary" },
    });
    vi.advanceTimersByTime(200);

    expect(persistErrorPartial).not.toHaveBeenCalled();

    // The retry finishes cleanly: normal final, still no error persistence.
    emitAssistantText(handler, "Full retry answer", 4);
    handler({
      runId: "run-1",
      seq: 5,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });
    expect(persistErrorPartial).not.toHaveBeenCalled();
    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as { state?: string };
    expect(finalPayload.state).toBe("final");
  });

  it("does not persist when the buffer is empty", () => {
    const { broadcast, persistErrorPartial, handler } = addRun1(createHarness());

    emitLifecycleError(handler, 1);

    expect(persistErrorPartial).not.toHaveBeenCalled();
    const errorPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      message?: unknown;
    };
    expect(errorPayload.state).toBe("error");
    expect(errorPayload.message).toBeUndefined();
  });

  it("does not persist whitespace or silent-reply buffers", () => {
    for (const text of ["   ", "NO_REPLY"]) {
      const { persistErrorPartial, handler } = addRun1(createHarness());
      emitAssistantText(handler, text);
      emitLifecycleError(handler);
      expect(persistErrorPartial).not.toHaveBeenCalled();
    }
  });

  it("leaves the success finalize path untouched", () => {
    const { broadcast, persistErrorPartial, handler } = addRun1(createHarness());

    emitAssistantText(handler, "Complete answer");
    handler({
      runId: "run-1",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(persistErrorPartial).not.toHaveBeenCalled();
    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Complete answer");
  });

  it("skips persistence for aborted runs (abort path owns those partials)", () => {
    const { persistErrorPartial, chatRunState, handler } = addRun1(createHarness());

    emitAssistantText(handler, "Aborted partial");
    chatRunState.abortedRuns.set("client-1", Date.now());
    emitLifecycleError(handler);

    expect(persistErrorPartial).not.toHaveBeenCalled();
  });

  describe("persistPreservedErrorPartial (transcript-level idempotency)", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-partial-"));
    });

    afterEach(async () => {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    function writeTranscriptHeader(sessionId: string): string {
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
      return transcriptPath;
    }

    it("writes the partial once even when invoked twice (double finalize)", () => {
      const transcriptPath = writeTranscriptHeader("sess-partial");
      loadSessionEntryMock.mockReturnValue({
        cfg: {},
        storePath: path.join(tmpDir, "sessions.json"),
        store: {},
        entry: { sessionId: "sess-partial" },
        canonicalKey: "main",
        legacyKey: undefined,
      });

      const params = {
        sessionKey: "main",
        runId: "client-run-77",
        text: "Preserved partial body",
      };
      const first = persistPreservedErrorPartial(params);
      const second = persistPreservedErrorPartial(params);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      const lines = fs
        .readFileSync(transcriptPath, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.trim());
      const persisted = lines
        .map((line) => JSON.parse(line) as { message?: Record<string, unknown> })
        .filter((entry) => entry.message?.idempotencyKey === "client-run-77:assistant");
      expect(persisted).toHaveLength(1);
      const content = persisted[0]?.message?.content as Array<{ type?: string; text?: string }>;
      expect(content?.[0]?.text).toBe("Preserved partial body");
    });

    it("reports not-found instead of creating a transcript for unknown sessions", () => {
      loadSessionEntryMock.mockReturnValue({
        cfg: {},
        storePath: path.join(tmpDir, "sessions.json"),
        store: {},
        entry: { sessionId: "sess-missing" },
        canonicalKey: "main",
        legacyKey: undefined,
      });

      const result = persistPreservedErrorPartial({
        sessionKey: "main",
        runId: "client-run-88",
        text: "text",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("transcript file not found");
      expect(fs.existsSync(path.join(tmpDir, "sess-missing.jsonl"))).toBe(false);
    });
  });
});
