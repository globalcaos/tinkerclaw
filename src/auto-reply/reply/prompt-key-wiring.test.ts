import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as embeddedRunsTesting,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { deriveSessionPendingPrompts } from "../../gateway/session-utils.js";
import { resetAgentRunContextForTest } from "../../infra/agent-events.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  clearFollowupQueue,
  enqueueFollowupRun,
  resetRecentQueuedMessageIdDedupe,
  scheduleFollowupDrain,
} from "./queue.js";
import { createDeferred } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback } from "./queue/drain.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { __testing as replyRunTesting } from "./reply-run-registry.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

// TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 steps G3 (the coalesced half) and G5 (the wiring).
//
// G5's own suite (src/gateway/session-utils.pending-prompts.test.ts) drives the holders directly.
// This one drives the PRODUCTION producers: runReplyAgent's run and steer branches, the real steer
// buffer (embedded-agent-runner/runs.ts), a real follow-up drain and the real follow-up runner. It
// reads deriveSessionPendingPrompts, the derivation buildGatewaySessionRow puts on every
// sessions.list row (row-level shape pinned by the G5 suite). Only the model call, preflight
// compaction, memory flush and usage accounting are stubbed.
//
// CONTROL (to record against the pre-change tree, this file kept): every case fails there.
// agent-runner.ts and followup-runner.ts create their reply operation with no prompt key, so
// PREPARING and RUNNING are never reported (a batch shows BEHIND instead); nothing in production
// calls recordSteeredReplyPrompt, so STEERED is never reported; and a lost steer's follow-up
// carries only the last caller's `messageId`, so one of its two keys is missing.

const runEmbeddedPiAgentMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-fallback.js")>()),
  ...(await import("../../test-utils/model-fallback.mock.js")),
}));

vi.mock("./agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory.js")>()),
  runMemoryFlushIfNeeded: async (params: { sessionEntry?: unknown }) => params.sessionEntry,
  runPreflightCompactionIfNeeded: (params: unknown) => runPreflightCompactionIfNeededMock(params),
}));

vi.mock("./session-run-accounting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-run-accounting.js")>()),
  incrementRunCompactionCount: vi.fn(async () => undefined),
  persistRunSessionUsage: vi.fn(async () => undefined),
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  // The real resolver reaches for gateway secrets; the config is irrelevant to the keys.
  resolveQueuedReplyExecutionConfig: async (config: unknown) => config,
}));

type Session = { key: string; id: string };
type PendingSnapshot = ReturnType<typeof deriveSessionPendingPrompts>;

const TURN: Session = { key: "agent:main:tinker:pq-wiring-turn", id: "sess-pq-wiring-turn" };
const BATCH: Session = { key: "agent:main:tinker:pq-wiring-batch", id: "sess-pq-wiring-batch" };
const LOST: Session = { key: "agent:main:tinker:pq-wiring-lost", id: "sess-pq-wiring-lost" };

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;
let createFollowupRunner: typeof import("./followup-runner.js").createFollowupRunner;

/** One user prompt as get-reply-run.ts builds it: `messageId` is the chat.send idempotencyKey. */
function promptRun(session: Session, prompt: string, messageId: string): FollowupRun {
  return createMockFollowupRun({
    prompt,
    summaryLine: prompt,
    messageId,
    run: { sessionKey: session.key, sessionId: session.id },
  });
}

/** runReplyAgent's params as get-reply-run.ts passes them: an idle session runs, a busy one steers. */
function replyParams(
  session: Session,
  followupRun: FollowupRun,
  mode: "run" | "steer",
): Parameters<typeof runReplyAgent>[0] {
  const steering = mode === "steer";
  return {
    commandBody: followupRun.prompt,
    followupRun,
    queueKey: session.key,
    resolvedQueue: { mode: "steer-backlog" } as QueueSettings,
    shouldSteer: steering,
    shouldFollowup: false,
    isActive: steering,
    // Keep the liveness re-check from draining the follow-up queue inside the test.
    isRunActive: () => true,
    isStreaming: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: followupRun.messageId,
    } as unknown as TemplateContext,
    sessionKey: session.key,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  };
}

/** The handle runEmbeddedPiAgent registers for a live run: what lets a steer be accepted. */
function liveRunHandle() {
  return {
    queueMessage: vi.fn(async () => undefined),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
  };
}

describe("prompt keys reach sessions.list pendingPrompts through the production path (G3 + G5)", () => {
  beforeAll(async () => {
    ({ runReplyAgent } = await import("./agent-runner.js"));
    ({ createFollowupRunner } = await import("./followup-runner.js"));
  });

  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });
    runPreflightCompactionIfNeededMock.mockReset();
    runPreflightCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    );
  });

  afterEach(() => {
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetAgentRunContextForTest();
    for (const session of [TURN, BATCH, LOST]) {
      clearFollowupQueue(session.key);
      clearFollowupDrainCallback(session.key);
    }
    resetRecentQueuedMessageIdDedupe();
  });

  it("agent-runner: a turn's key is PREPARING before the model and RUNNING in it; a prompt steered into it is STEERED", async () => {
    const snapshots: {
      preflight?: PendingSnapshot;
      model?: PendingSnapshot;
      steered?: PendingSnapshot;
    } = {};
    runPreflightCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => {
        snapshots.preflight = deriveSessionPendingPrompts(TURN.key);
        return params.sessionEntry;
      },
    );
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      snapshots.model = deriveSessionPendingPrompts(TURN.key);
      // A prompt typed while the turn runs, through the REAL steer branch and the REAL buffer.
      setActiveEmbeddedRun(TURN.id, liveRunHandle(), TURN.key);
      await runReplyAgent(replyParams(TURN, promptRun(TURN, "and also this", "steer-a"), "steer"));
      snapshots.steered = deriveSessionPendingPrompts(TURN.key);
      // Drop the buffered steer unflushed: how it is delivered is not what this case pins.
      embeddedRunsTesting.resetActiveEmbeddedRuns();
      return { payloads: [{ text: "ok" }], meta: {} };
    });

    await runReplyAgent(replyParams(TURN, promptRun(TURN, "hello", "turn-a"), "run"));

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(snapshots.preflight).toEqual([
      { key: "turn-a", state: "preparing", since: expect.any(Number) },
    ]);
    expect(snapshots.model).toEqual([
      { key: "turn-a", state: "running", since: expect.any(Number) },
    ]);
    expect(snapshots.steered).toEqual([
      { key: "turn-a", state: "running", since: expect.any(Number) },
      { key: "steer-a", state: "steered", since: expect.any(Number) },
    ]);
  });

  it("followup-runner: a collect-mode batch reports EVERY batched key PREPARING, then RUNNING, not BEHIND", async () => {
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };
    // No originating route: a routed webchat item counts as cross-channel and is drained alone.
    const batched = (prompt: string, messageId: string) =>
      createMockFollowupRun({
        prompt,
        messageId,
        originatingChannel: undefined,
        originatingTo: undefined,
        run: { messageProvider: "webchat", sessionKey: BATCH.key, sessionId: BATCH.id },
      });
    enqueueFollowupRun(BATCH.key, batched("first", "batch-1"), settings);
    enqueueFollowupRun(BATCH.key, batched("second", "batch-2"), settings);
    const beforeDrain = deriveSessionPendingPrompts(BATCH.key);

    const snapshots: { preflight?: PendingSnapshot; model?: PendingSnapshot } = {};
    runPreflightCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => {
        snapshots.preflight = deriveSessionPendingPrompts(BATCH.key);
        return params.sessionEntry;
      },
    );
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      snapshots.model = deriveSessionPendingPrompts(BATCH.key);
      return { payloads: [], meta: {} };
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude",
    });
    const drained = createDeferred<void>();
    scheduleFollowupDrain(BATCH.key, async (queued) => {
      try {
        await runner(queued);
      } finally {
        drained.resolve();
      }
    });
    await drained.promise;

    expect(beforeDrain).toEqual([
      { key: "batch-1", state: "behind", since: expect.any(Number) },
      { key: "batch-2", state: "behind", since: expect.any(Number) },
    ]);
    // ONE run answers both: the batch stays in queue.items until it returns, and the operation's
    // keys beat the queue.
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(snapshots.preflight).toEqual([
      { key: "batch-1", state: "preparing", since: expect.any(Number) },
      { key: "batch-2", state: "preparing", since: expect.any(Number) },
    ]);
    expect(snapshots.model).toEqual([
      { key: "batch-1", state: "running", since: expect.any(Number) },
      { key: "batch-2", state: "running", since: expect.any(Number) },
    ]);
  });

  it("a lost steer delivery re-enqueues ONE follow-up carrying every buffered caller's key, each BEHIND", async () => {
    const handle = liveRunHandle();
    setActiveEmbeddedRun(LOST.id, handle, LOST.key);
    // Two prompts inside one debounce window: the REAL steer buffer coalesces them.
    await runReplyAgent(replyParams(LOST, promptRun(LOST, "first steer", "lost-1"), "steer"));
    await runReplyAgent(replyParams(LOST, promptRun(LOST, "second steer", "lost-2"), "steer"));
    // The run ends before the flush timer fires, so the buffer hands its text to the fallback.
    clearActiveEmbeddedRun(LOST.id, handle, LOST.key);

    expect(handle.queueMessage).not.toHaveBeenCalled();
    const items = getExistingFollowupQueue(LOST.key)?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toBe("first steer\n\nsecond steer");
    expect(items[0]?.messageId).toBe("lost-2");
    expect(items[0]?.promptKeys).toEqual(["lost-1", "lost-2"]);
    expect(deriveSessionPendingPrompts(LOST.key)).toEqual([
      { key: "lost-1", state: "behind", since: items[0]?.enqueuedAt },
      { key: "lost-2", state: "behind", since: items[0]?.enqueuedAt },
    ]);
  });
});
