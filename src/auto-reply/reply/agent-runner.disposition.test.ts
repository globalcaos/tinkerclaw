import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

// TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 step G2 — "report the disposition".
//
// CONTROL (recorded before the change): on the pre-G2 tree `GetReplyOptions` has no
// `onPromptDisposition`, so this file fails to type-check, and at runtime the four cases that
// expect a report fail (4 failed | 1 passed). The "reports NOTHING" case passes on both trees by
// construction: it pins the refusal half, that a false enqueue never claims a placement.

type SteerOpts = {
  onDeliveryLost?: (texts: string[], combined: string) => void;
  onDelivered?: (combined: string, mode?: string) => void;
};

const queueEmbeddedPiMessageMock = vi.fn(
  (_sessionId: string | undefined, _text: string, _opts?: SteerOpts) => false,
);
const enqueueFollowupRunMock = vi.fn((..._args: unknown[]) => true);
const createFollowupRunnerMock = vi.fn((..._args: unknown[]) => vi.fn(async () => undefined));

vi.mock("../../agents/embedded-agent-runner/runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent-runner/runs.js")>()),
  queueEmbeddedPiMessage: (sessionId: string | undefined, text: string, opts?: SteerOpts) =>
    queueEmbeddedPiMessageMock(sessionId, text, opts),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
}));

vi.mock("./followup-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-runner.js")>()),
  createFollowupRunner: (...args: unknown[]) => createFollowupRunnerMock(...args),
}));

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;

function makeParams(
  overrides: Partial<Parameters<typeof runReplyAgent>[0]> = {},
): Parameters<typeof runReplyAgent>[0] {
  return {
    commandBody: "hello",
    followupRun: createMockFollowupRun({ prompt: "hello", messageId: "idem-1" }),
    queueKey: "agent:main:tinker:t1",
    resolvedQueue: { mode: "steer-backlog" } as QueueSettings,
    shouldSteer: false,
    shouldFollowup: false,
    // Every disposition branch below is reachable only while a turn is already running.
    isActive: true,
    // Keep the ordinary liveness re-check from finalizing the follow-up queue inside the test.
    isRunActive: () => true,
    isStreaming: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: "webchat",
      Surface: "webchat",
      AccountId: "default",
      MessageSid: "idem-1",
    } as unknown as TemplateContext,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    ...overrides,
  };
}

describe("runReplyAgent reports the prompt disposition (prompt-queue.md G2 / PQ-8)", () => {
  beforeAll(async () => {
    ({ runReplyAgent } = await import("./agent-runner.js"));
  });

  beforeEach(() => {
    vi.resetAllMocks();
    queueEmbeddedPiMessageMock.mockReturnValue(false);
    enqueueFollowupRunMock.mockReturnValue(true);
    createFollowupRunnerMock.mockImplementation(() => vi.fn(async () => undefined));
  });

  it("reports 'steered' when the running turn accepts the prompt", async () => {
    queueEmbeddedPiMessageMock.mockReturnValue(true);
    const onPromptDisposition = vi.fn();

    const result = await runReplyAgent(
      makeParams({ shouldSteer: true, opts: { onPromptDisposition } }),
    );

    expect(result).toBeUndefined();
    expect(onPromptDisposition.mock.calls).toEqual([["steered"]]);
  });

  it("corrects to 'backlogged' when the steer delivery is lost and a follow-up is really queued", async () => {
    let steerOpts: SteerOpts | undefined;
    queueEmbeddedPiMessageMock.mockImplementation((_sessionId, _text, opts) => {
      steerOpts = opts;
      return true;
    });
    const onPromptDisposition = vi.fn();

    await runReplyAgent(makeParams({ shouldSteer: true, opts: { onPromptDisposition } }));
    expect(onPromptDisposition.mock.calls).toEqual([["steered"]]);

    // flushSteerBuffer runs behind a debounce timer in production; fire the registered fallback
    // directly so the correction is asserted without depending on that timing.
    steerOpts?.onDeliveryLost?.(["hello"], "hello");

    expect(enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
    expect(onPromptDisposition.mock.calls).toEqual([["steered"], ["backlogged"]]);
  });

  it("reports 'backlogged' when the prompt is really queued behind the running turn", async () => {
    const onPromptDisposition = vi.fn();

    const result = await runReplyAgent(
      makeParams({ shouldFollowup: true, opts: { onPromptDisposition } }),
    );

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
    expect(onPromptDisposition.mock.calls).toEqual([["backlogged"]]);
  });

  it("reports NOTHING when the enqueue is refused — an authoritative wrong answer is worse than none", async () => {
    // enqueueFollowupRun returns false for a message-id dedupe hit, for an item already in the
    // queue, and for a full queue under dropPolicy "new". Only the last actually discards the
    // prompt, and the boolean cannot tell them apart, so nothing may be claimed.
    enqueueFollowupRunMock.mockReturnValue(false);
    const onPromptDisposition = vi.fn();

    const result = await runReplyAgent(
      makeParams({ shouldFollowup: true, opts: { onPromptDisposition } }),
    );

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
    expect(onPromptDisposition).not.toHaveBeenCalled();
  });

  it("reports 'dropped' when the queue policy refuses the turn outright", async () => {
    const onPromptDisposition = vi.fn();

    const result = await runReplyAgent(
      makeParams({ opts: { isHeartbeat: true, onPromptDisposition } }),
    );

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(onPromptDisposition.mock.calls).toEqual([["dropped"]]);
  });
});
