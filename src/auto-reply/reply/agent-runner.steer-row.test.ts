import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

// FORK 2026-10-05 (bug-log `steer-written-twice`): a steered prompt's delivery callback writes the
// prompt's transcript row only when the run does not write it itself. A pi-native run persists the
// injected steer, keyed (runs.ts `persistsSteeredPrompt`), and a second row here was the prompt
// shown twice. The claude-cli stdin steer and the codex harness persist nothing, so they keep it.

type SteerOpts = {
  onDelivered?: (
    combined: string,
    via: "inflight-steer" | "next-round",
    info?: { persistedByRun: boolean },
  ) => void;
};

const queueEmbeddedPiMessageMock = vi.fn(
  (_sessionId: string | undefined, _text: string, _opts?: SteerOpts) => true,
);
const appendUserMessageMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("../../agents/embedded-agent-runner/runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent-runner/runs.js")>()),
  queueEmbeddedPiMessage: (sessionId: string | undefined, text: string, opts?: SteerOpts) =>
    queueEmbeddedPiMessageMock(sessionId, text, opts),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  appendUserMessageToSessionTranscript: (...args: unknown[]) => appendUserMessageMock(...args),
}));

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;

async function steer(): Promise<SteerOpts> {
  let captured: SteerOpts | undefined;
  queueEmbeddedPiMessageMock.mockImplementation((_sessionId, _text, opts) => {
    captured = opts;
    return true;
  });
  await runReplyAgent({
    commandBody: "stop for now",
    followupRun: createMockFollowupRun({ prompt: "stop for now", messageId: "idem-steer" }),
    queueKey: "agent:main:tinker:t1",
    resolvedQueue: { mode: "steer-backlog" } as QueueSettings,
    shouldSteer: true,
    shouldFollowup: false,
    isActive: true,
    isRunActive: () => true,
    isStreaming: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: "webchat",
      Surface: "webchat",
      AccountId: "default",
      MessageSid: "idem-steer",
    } as unknown as TemplateContext,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
  expect(captured?.onDelivered).toBeTypeOf("function");
  return captured as SteerOpts;
}

describe("a delivered steer writes its prompt's row once", () => {
  beforeAll(async () => {
    ({ runReplyAgent } = await import("./agent-runner.js"));
  });

  beforeEach(() => {
    vi.resetAllMocks();
    appendUserMessageMock.mockResolvedValue(undefined);
  });

  it("writes nothing when the run persists the injected steer itself", async () => {
    const opts = await steer();
    opts.onDelivered?.("stop for now", "next-round", { persistedByRun: true });
    expect(appendUserMessageMock).not.toHaveBeenCalled();
  });

  it("writes the keyed row for a run that persists nothing (codex harness, claude-cli stdin)", async () => {
    const opts = await steer();
    opts.onDelivered?.("stop for now", "next-round", { persistedByRun: false });
    opts.onDelivered?.("stop for now", "inflight-steer");
    expect(appendUserMessageMock).toHaveBeenCalledTimes(2);
    expect(appendUserMessageMock.mock.calls[0]?.[0]).toMatchObject({
      text: "stop for now",
      idempotencyKey: "idem-steer",
    });
  });
});
