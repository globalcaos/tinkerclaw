import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { getExistingFollowupQueue, getFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import {
  __testing as replyRunTesting,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  clearAgentRunContextsForSession,
  getSessionRunLiveness,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../../infra/agent-events.js";
import {
  abortChatRunsForSessionKey,
  registerChatAbortController,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "../chat-abort.js";
import { chatHandlers } from "./chat.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestContext } from "./types.js";

// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 row G1, tests (a)–(e), against §6.2.
// Drives the REAL sessions.delete / sessions.reset / chat.send handlers with the real reply-run
// registry, run set and follow-up queue. Stubbed: where the session store lives (getRuntimeConfig),
// the model dispatch, and three side-effect seams (subagent stop, tracked browser tabs, the bundle
// MCP runtime), none of which holds a turn.
//
// CONTROL (prompt-queue.md §7): on the tree before endSessionTurns and the D2 guard, (a), (b), both
// terminal cases of (d), the clearSessionQueues snapshot, the run-set cutoff and both abort cases
// of (e) FAIL; (c), the foreign-key case of (d) and the two no-abort cases of (e) pass on both.

const testConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const dispatchMock = vi.hoisted(() => ({ dispatchInboundMessage: vi.fn() }));

vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  getRuntimeConfig: () => testConfig.current,
}));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/dispatch.js")>()),
  dispatchInboundMessage: dispatchMock.dispatchInboundMessage,
}));

vi.mock("../../auto-reply/reply/abort.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/abort.js")>()),
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
  movePathToTrash: vi.fn(async () => {}),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => ({
  disposeSessionMcpRuntime: vi.fn(async () => {}),
  disposeAllSessionMcpRuntimes: vi.fn(async () => {}),
  retireSessionMcpRuntime: vi.fn(async () => true),
}));

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  stopReason?: string;
};

type SessionsResult = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

const TERMINAL_STATES = new Set(["final", "error", "aborted"]);
const tempDirs: string[] = [];

function names(suffix: string) {
  return {
    key: `agent:main:tinker:pq-g1-${suffix}`,
    sessionId: `sess-pq-g1-${suffix}`,
    promptKey: `prompt-pq-g1-${suffix}`,
  };
}

/** A temp session store, reached through `session.store`, the key the gateway test helpers use. */
function useTempStore(entries: Record<string, Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pq-g1-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries, null, 2), "utf-8");
  testConfig.current = { session: { store: storePath } };
  return storePath;
}

function createGatewayContext() {
  return {
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    chatRunBuffers: new Map<string, string>(),
    chatDeltaSentAt: new Map<string, number>(),
    chatDeltaLastBroadcastLen: new Map<string, number>(),
    chatAbortedRuns: new Map<string, number>(),
    agentRunSeq: new Map<string, number>(),
    dedupe: new Map<string, unknown>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig: () => testConfig.current,
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    registerToolEventRecipient: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
}

type TestContext = ReturnType<typeof createGatewayContext>;

/** Every tier-1 chat terminal broadcast for one runId, in order. */
function chatTerminals(context: TestContext, runId: string): ChatEventPayload[] {
  return context.broadcast.mock.calls
    .filter(([event]) => event === "chat")
    .map(([, payload]) => payload as ChatEventPayload)
    .filter((payload) => payload.runId === runId && TERMINAL_STATES.has(payload.state ?? ""));
}

async function callSessions(
  method: "sessions.delete" | "sessions.reset",
  params: Record<string, unknown>,
  context: TestContext,
): Promise<SessionsResult> {
  let result: SessionsResult | undefined;
  await sessionsHandlers[method]({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: context as unknown as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
  });
  if (!result) {
    throw new Error(`${method} did not respond`);
  }
  return result;
}

/**
 * A turn accepted but still before the model, holding holders B, C and D (prompt-queue.md §4).
 * The lane gate models embedded-agent-runner/run.ts: when the session and global lanes free, the
 * queued task re-checks its operation's abortSignal (throwIfAborted) before anything starts.
 */
function seedPendingTurn(context: TestContext, t: ReturnType<typeof names>) {
  const operation = replyRunRegistry.begin({
    sessionKey: t.key,
    sessionId: t.sessionId,
    resetTriggered: false,
  });
  registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: t.promptKey,
    sessionId: t.sessionId,
    sessionKey: t.key,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  registerAgentRunContext(t.promptKey, { sessionKey: t.key });
  let releaseLanes: () => void = () => {};
  const lanesFree = new Promise<void>((resolve) => {
    releaseLanes = () => resolve();
  });
  const taskStarted = vi.fn();
  const queuedTask = lanesFree.then(() => {
    if (!operation.abortSignal.aborted) {
      taskStarted();
    }
  });
  return { operation, releaseLanes: () => releaseLanes(), queuedTask, taskStarted };
}

function enqueueBacklog(key: string, promptKey: string): void {
  getFollowupQueue(key, { mode: "steer-backlog" }).items.push({
    prompt: "typed while the current turn was running",
    messageId: promptKey,
    enqueuedAt: Date.now(),
    run: { sessionKey: key },
  } as unknown as FollowupRun);
}

afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetAgentRunContextForTest();
  dispatchMock.dispatchInboundMessage.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions.delete / sessions.reset end a turn that has not reached the model (G1)", () => {
  it("(a) delete: one `aborted` per runId, no reply operation, no run.live, task never starts", async () => {
    const t = names("delete");
    useTempStore({ [t.key]: { sessionId: t.sessionId, updatedAt: Date.now() } });
    const context = createGatewayContext();
    const pending = seedPendingTurn(context, t);
    // The fixture holds all three holders, so a green result cannot come from an empty one.
    expect(replyRunRegistry.isActive(t.key)).toBe(true);
    expect(context.chatAbortControllers.has(t.promptKey)).toBe(true);
    expect(getSessionRunLiveness(t.key).live).toBe(true);

    const res = await callSessions("sessions.delete", { key: t.key }, context);

    expect(res.ok).toBe(true);
    expect(chatTerminals(context, t.promptKey)).toEqual([
      expect.objectContaining({ state: "aborted", stopReason: "session-delete" }),
    ]);
    expect(context.chatAbortControllers.has(t.promptKey)).toBe(false);
    expect(replyRunRegistry.isActive(t.key)).toBe(false);
    expect(pending.operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(getSessionRunLiveness(t.key).live).toBe(false);
    pending.releaseLanes();
    await pending.queuedTask;
    expect(pending.taskStarted).not.toHaveBeenCalled();
  });

  it("(b) reset: the same, and the fresh entry carries no abortedLastRun", async () => {
    const t = names("reset");
    const storePath = useTempStore({ [t.key]: { sessionId: t.sessionId, updatedAt: Date.now() } });
    const context = createGatewayContext();
    const pending = seedPendingTurn(context, t);
    expect(replyRunRegistry.isActive(t.key)).toBe(true);
    expect(getSessionRunLiveness(t.key).live).toBe(true);

    const res = await callSessions("sessions.reset", { key: t.key }, context);

    expect(res.ok).toBe(true);
    expect(chatTerminals(context, t.promptKey)).toEqual([
      expect.objectContaining({ state: "aborted", stopReason: "session-reset" }),
    ]);
    expect(replyRunRegistry.isActive(t.key)).toBe(false);
    expect(getSessionRunLiveness(t.key).live).toBe(false);
    pending.releaseLanes();
    await pending.queuedTask;
    expect(pending.taskStarted).not.toHaveBeenCalled();
    // Step 8 regression guard, not a gap control: the reset has always written `false` here. It
    // pins that endSessionTurns routes nothing through chat.abort's settleSessionAfterAbort.
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string; abortedLastRun?: boolean }
    >;
    expect(store[t.key]?.sessionId).toEqual(expect.any(String));
    expect(store[t.key]?.sessionId).not.toBe(t.sessionId);
    expect(store[t.key]?.abortedLastRun).not.toBe(true);
  });

  it("(c) delete with no live turn broadcasts no chat event at all", async () => {
    const t = names("idle");
    useTempStore({ [t.key]: { sessionId: t.sessionId, updatedAt: Date.now() } });
    const context = createGatewayContext();

    const res = await callSessions("sessions.delete", { key: t.key }, context);

    expect(res.ok).toBe(true);
    expect(context.broadcast.mock.calls.filter(([event]) => event === "chat")).toEqual([]);
    expect(context.nodeSendToSession).not.toHaveBeenCalled();
  });

  it("(d) a backlogged follow-up gets exactly one `aborted`, under its prompt key", async () => {
    const t = names("backlog");
    useTempStore({ [t.key]: { sessionId: t.sessionId, updatedAt: Date.now() } });
    const context = createGatewayContext();
    enqueueBacklog(t.key, t.promptKey);

    const res = await callSessions("sessions.delete", { key: t.key }, context);

    expect(res.ok).toBe(true);
    expect(chatTerminals(context, t.promptKey)).toEqual([
      expect.objectContaining({
        state: "aborted",
        stopReason: "session-delete",
        sessionKey: t.key,
      }),
    ]);
    expect(getExistingFollowupQueue(t.key)).toBeUndefined();
  });

  it("(d) a backlogged prompt whose chat.send has not settled still gets exactly one", async () => {
    const t = names("backlog-live");
    useTempStore({ [t.key]: { sessionId: t.sessionId, updatedAt: Date.now() } });
    const context = createGatewayContext();
    enqueueBacklog(t.key, t.promptKey);
    registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: t.promptKey,
      sessionId: t.sessionId,
      sessionKey: t.key,
      timeoutMs: 60_000,
      kind: "chat-send",
    });

    const res = await callSessions("sessions.delete", { key: t.key }, context);

    expect(res.ok).toBe(true);
    expect(chatTerminals(context, t.promptKey)).toEqual([
      expect.objectContaining({ state: "aborted", stopReason: "session-delete" }),
    ]);
    expect(context.chatAbortedRuns.has(t.promptKey)).toBe(true);
  });

  it("(d) a backlog key that names ANOTHER session's live run is left alone (PQ-7)", async () => {
    const t = names("backlog-foreign");
    const other = names("backlog-foreign-other");
    useTempStore({ [t.key]: { sessionId: t.sessionId, updatedAt: Date.now() } });
    const context = createGatewayContext();
    enqueueBacklog(t.key, other.promptKey);
    registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: other.promptKey,
      sessionId: other.sessionId,
      sessionKey: other.key,
      timeoutMs: 60_000,
      kind: "chat-send",
    });

    const res = await callSessions("sessions.delete", { key: t.key }, context);

    expect(res.ok).toBe(true);
    expect(chatTerminals(context, other.promptKey)).toEqual([]);
    expect(context.chatAbortControllers.has(other.promptKey)).toBe(true);
  });

  it("clearSessionQueues hands back the prompts it dropped, from the registry state.ts writes", () => {
    const key = names("snapshot").key;
    enqueueBacklog(key, "prompt-pq-g1-snapshot");

    const cleared = clearSessionQueues([key]);

    expect(cleared.followupCleared).toBe(1);
    expect(cleared.followupItems?.map((item) => item.messageId)).toEqual(["prompt-pq-g1-snapshot"]);
    expect(clearSessionQueues([key])).not.toHaveProperty("followupItems");
  });

  it("the run-set close keeps a run registered after the cleanup began", () => {
    const key = names("run-set-cutoff").key;
    const cutoff = Date.now();
    registerAgentRunContext("run-pq-g1-before", { sessionKey: key, registeredAt: cutoff - 1 });
    registerAgentRunContext("run-pq-g1-after", { sessionKey: key, registeredAt: cutoff + 1 });

    expect(clearAgentRunContextsForSession(key, { registeredAtOrBefore: cutoff })).toEqual([
      "run-pq-g1-before",
    ]);
    expect(getSessionRunLiveness(key).count).toBe(1);
  });
});

describe("(e) D2: chat.send's completion adds no second terminal after an abort", () => {
  const key = "agent:main:tinker:pq-g1-d2";
  let settle: { resolve: () => void; reject: (err: Error) => void } | undefined;

  beforeEach(() => {
    settle = undefined;
    useTempStore({});
    dispatchMock.dispatchInboundMessage.mockImplementation(
      (params: {
        replyOptions?: { runId?: string; onAgentRunStart?: (runId: string) => void };
      }) => {
        params.replyOptions?.onAgentRunStart?.(params.replyOptions.runId ?? "");
        return new Promise<void>((resolve, reject) => {
          settle = { resolve: () => resolve(), reject };
        });
      },
    );
  });

  async function sendAndHold(context: TestContext, promptKey: string): Promise<void> {
    const respond = vi.fn();
    await chatHandlers["chat.send"]({
      req: {} as never,
      params: { sessionKey: key, message: "hello", idempotencyKey: promptKey },
      respond: respond as never,
      context: context as unknown as GatewayRequestContext,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(true, { runId: promptKey, status: "started" }, undefined, {
      runId: promptKey,
    });
    expect(context.chatAbortControllers.has(promptKey)).toBe(true);
    expect(settle).toBeDefined();
  }

  it.each(["resolves", "rejects"] as const)(
    "abort, then the dispatch %s: exactly one terminal, and it is `aborted`",
    async (outcome) => {
      const context = createGatewayContext();
      const promptKey = `prompt-pq-g1-d2-${outcome}`;
      await sendAndHold(context, promptKey);

      const aborted = abortChatRunsForSessionKey(context as unknown as ChatAbortOps, {
        sessionKey: key,
        stopReason: "session-delete",
      });
      expect(aborted.runIds).toEqual([promptKey]);
      if (outcome === "resolves") {
        settle?.resolve();
      } else {
        settle?.reject(new Error("Reply operation aborted by user"));
      }
      await vi.waitFor(() => {
        expect(context.dedupe.has(`chat:${promptKey}`)).toBe(true);
      });

      expect(chatTerminals(context, promptKey)).toEqual([
        expect.objectContaining({ state: "aborted", stopReason: "session-delete" }),
      ]);
    },
  );

  it("with no abort the completion still sends its one `final`: the guard is not a mute", async () => {
    const context = createGatewayContext();
    const promptKey = "prompt-pq-g1-d2-clean";
    await sendAndHold(context, promptKey);

    settle?.resolve();
    await vi.waitFor(() => {
      expect(context.dedupe.has(`chat:${promptKey}`)).toBe(true);
    });

    expect(chatTerminals(context, promptKey)).toEqual([
      expect.objectContaining({ state: "final" }),
    ]);
  });

  it("an abort mark older than this send (an earlier run under the same key) does not mute it", async () => {
    const context = createGatewayContext();
    const promptKey = "prompt-pq-g1-d2-replayed";
    context.chatAbortedRuns.set(promptKey, Date.now() - 10 * 60_000);
    await sendAndHold(context, promptKey);

    settle?.resolve();
    await vi.waitFor(() => {
      expect(context.dedupe.has(`chat:${promptKey}`)).toBe(true);
    });

    expect(chatTerminals(context, promptKey)).toEqual([
      expect.objectContaining({ state: "final" }),
    ]);
  });
});
