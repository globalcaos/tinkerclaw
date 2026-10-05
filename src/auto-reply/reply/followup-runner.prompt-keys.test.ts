import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onAgentEvent,
  resetAgentRunContextForTest,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { clearFollowupQueue, enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { createDeferred } from "./queue.test-helpers.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

// TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 / §7 step G3 — "link follow-up runs to their prompts".
//
// CONTROL (to record against the pre-G3 tree, this file kept): the runner emits no `followup`
// event there, so the three cases that expect a link fail. The other three pass on both trees by
// construction: two pin the additive half (no key, or no Control-UI client, means no event and
// today's behaviour), and one pins the stream choice (the link never rides `lifecycle`).
//
// COALESCED (FollowupRun.promptKeys, the G3 half that wave 2b left open): the last two cases drive a
// real collect-mode drain and a lost steer's re-enqueued run. CONTROL (to record against the tree
// before `promptKeys`, this file kept): the collect batch carries no `messageId` there and emits
// no link, and the lost steer's run names only its `messageId`, so both fail.

const runEmbeddedPiAgentMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedPiRun: vi.fn(async () => false),
  compactEmbeddedPiSession: vi.fn(async () => undefined),
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(async () => undefined),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  waitForEmbeddedPiRunEnd: vi.fn(async () => undefined),
}));

vi.mock(
  "../../agents/model-fallback.js",
  async () => await import("../../test-utils/model-fallback.mock.js"),
);

vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: async (params: { sessionEntry?: unknown }) => params.sessionEntry,
  runPreflightCompactionIfNeeded: (params: unknown) => runPreflightCompactionIfNeededMock(params),
}));

vi.mock("./session-run-accounting.js", () => ({
  incrementRunCompactionCount: vi.fn(async () => undefined),
  persistRunSessionUsage: vi.fn(async () => undefined),
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  // The real resolver reaches for gateway secrets; the config is irrelevant to the link.
  resolveQueuedReplyExecutionConfig: async (config: unknown) => config,
}));

let createFollowupRunner: typeof import("./followup-runner.js").createFollowupRunner;

const TINKER_SESSION_KEY = "agent:main:tinker:t1";

function webchatFollowup(overrides: Partial<Omit<FollowupRun, "run">> = {}): FollowupRun {
  return createMockFollowupRun({
    originatingChannel: "webchat",
    ...overrides,
    run: { messageProvider: "webchat", sessionKey: TINKER_SESSION_KEY },
  });
}

async function runFollowup(queued: FollowupRun): Promise<void> {
  const runner = createFollowupRunner({
    typing: createMockTypingController(),
    typingMode: "instant",
    defaultModel: "anthropic/claude",
  });
  await runner(queued);
}

describe("createFollowupRunner links a follow-up run to its prompt (prompt-queue.md G3 / C3)", () => {
  let events: AgentEventPayload[] = [];
  let unsubscribe: (() => void) | undefined;
  const linkEvents = () => events.filter((evt) => evt.stream === "followup");

  beforeAll(async () => {
    ({ createFollowupRunner } = await import("./followup-runner.js"));
  });

  beforeEach(() => {
    resetAgentRunContextForTest();
    events = [];
    unsubscribe = onAgentEvent((evt) => {
      events.push(evt);
    });
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });
    runPreflightCompactionIfNeededMock.mockReset();
    runPreflightCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    );
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    resetAgentRunContextForTest();
  });

  it("a follow-up drained on its own carries its one key, on the runId the model run uses", async () => {
    await runFollowup(webchatFollowup({ messageId: "idem-1" }));

    expect(linkEvents()).toHaveLength(1);
    const [link] = linkEvents();
    expect(link?.data).toEqual({ phase: "start", promptKeys: ["idem-1"] });
    expect(link?.sessionKey).toBe(TINKER_SESSION_KEY);
    const modelRunId = (runEmbeddedPiAgentMock.mock.calls[0]?.[0] as { runId?: string } | undefined)
      ?.runId;
    expect(modelRunId).toBeTruthy();
    expect(link?.runId).toBe(modelRunId);
  });

  it("links the run BEFORE preflight compaction and the model — the PREPARING stretch", async () => {
    let linksAtPreflight = -1;
    let linksAtModel = -1;
    runPreflightCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => {
        linksAtPreflight = linkEvents().length;
        return params.sessionEntry;
      },
    );
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      linksAtModel = linkEvents().length;
      return { payloads: [], meta: {} };
    });

    await runFollowup(webchatFollowup({ messageId: "idem-1" }));

    expect(linksAtPreflight).toBe(1);
    expect(linksAtModel).toBe(1);
  });

  it("names the key trimmed, the same form the delete/reset abort names it by", async () => {
    await runFollowup(webchatFollowup({ messageId: "  idem-2  " }));

    expect(linkEvents()[0]?.data.promptKeys).toEqual(["idem-2"]);
  });

  it("never rides the lifecycle stream (no second phase:start, nothing to stamp a model on)", async () => {
    await runFollowup(webchatFollowup({ messageId: "idem-1" }));

    expect(events.filter((evt) => evt.stream === "lifecycle")).toEqual([]);
  });

  it("emits nothing when the run has no key — today's behaviour", async () => {
    await runFollowup(webchatFollowup());
    await runFollowup(webchatFollowup({ messageId: "   " }));

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(linkEvents()).toEqual([]);
  });

  it("emits nothing for a channel-originated follow-up, which no Control UI client holds keys for", async () => {
    await runFollowup(createMockFollowupRun({ messageId: "wamid-1" }));

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(linkEvents()).toEqual([]);
  });

  it("a collect-mode batch carries EVERY batched key, in queue order (the coalesced half of G3)", async () => {
    const queueKey = TINKER_SESSION_KEY;
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
        run: { messageProvider: "webchat", sessionKey: TINKER_SESSION_KEY },
      });
    try {
      // A real enqueue and a real drain: collect mode folds both prompts into ONE run.
      enqueueFollowupRun(queueKey, batched("first", "collect-a"), settings);
      enqueueFollowupRun(queueKey, batched("second", "collect-b"), settings);
      const runner = createFollowupRunner({
        typing: createMockTypingController(),
        typingMode: "instant",
        defaultModel: "anthropic/claude",
      });
      const drained = createDeferred<void>();
      scheduleFollowupDrain(queueKey, async (queued) => {
        try {
          await runner(queued);
        } finally {
          drained.resolve();
        }
      });
      await drained.promise;
    } finally {
      clearFollowupQueue(queueKey);
    }

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const modelPrompt = (
      runEmbeddedPiAgentMock.mock.calls[0]?.[0] as { prompt?: string } | undefined
    )?.prompt;
    expect(modelPrompt).toContain("[Queued messages while agent was busy]");
    expect(linkEvents()).toHaveLength(1);
    expect(linkEvents()[0]?.data).toEqual({
      phase: "start",
      promptKeys: ["collect-a", "collect-b"],
    });
  });

  it("a lost steer's re-enqueued run names every buffered key once, in arrival order", async () => {
    // agent-runner.ts onDeliveryLost: the LAST caller's run, carrying every caller's key.
    await runFollowup(
      webchatFollowup({ messageId: "steer-2", promptKeys: ["steer-1", " steer-2 ", "steer-1"] }),
    );

    expect(linkEvents()[0]?.data.promptKeys).toEqual(["steer-1", "steer-2"]);
  });
});
