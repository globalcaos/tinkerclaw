import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  registerChatAbortController,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "../../gateway/chat-abort.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { endSessionTurns } from "../../gateway/session-reset-service.js";
import {
  getSessionRunLiveness,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { MsgContext } from "../templating.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { kickFollowupDrainIfIdle, rememberFollowupDrainCallback } from "./queue/drain.js";
import { getExistingFollowupQueue, getFollowupQueue } from "./queue/state.js";
import type { FollowupRun } from "./queue/types.js";
import { __testing as replyRunTesting, replyRunRegistry } from "./reply-run-registry.js";
import { initSessionState } from "./session.js";

// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md PQ-6 / §6.2 on the TYPED reset path.
// A "/new" or "/reset" typed in chat reaches initSessionState (resetTriggered), not sessions.reset.
// Drives the REAL initSessionState and the REAL endSessionTurns with the real reply-run registry,
// run set and follow-up queue. Stubbed: tracked browser tabs only.
//
// The command reaches the init the way chat.send sends it (src/gateway/server-methods/chat.ts):
// its OWN abort controller already registered under the session key, MessageSid = its
// idempotencyKey, and the dispatch running inside the RPC's request scope (server-methods.ts runs
// every handler under withPluginRuntimeGatewayRequestScope).
//
// CONTROL: on the parent tree (a) and (c) FAIL: the backlogged prompt and the running turn get no
// terminal, and the running reply operation stays active. (b) passes on both trees. It is the
// guard that the reset spares the command's own turn, and it fails if the cleanup is handed the
// request's controllers without excepting that run. (d) drives endSessionTurns directly with
// `exceptRunIds`: on a tree whose endSessionTurns ignores it, the spared run gets an `aborted`
// and (d) fails.

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
  movePathToTrash: vi.fn(async () => {}),
}));

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  stopReason?: string;
};

const TERMINAL_STATES = new Set(["final", "error", "aborted"]);
const tempDirs: string[] = [];

function names(suffix: string) {
  return {
    key: `agent:main:tinker:pq-typed-reset-${suffix}`,
    sessionId: `sess-pq-typed-reset-${suffix}`,
    runningKey: `prompt-pq-typed-reset-${suffix}-running`,
    queuedKey: `prompt-pq-typed-reset-${suffix}-queued`,
    commandKey: `prompt-pq-typed-reset-${suffix}-command`,
  };
}

type Names = ReturnType<typeof names>;

function useTempStore(t: Names): OpenClawConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pq-typed-reset-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  const entries = { [t.key]: { sessionId: t.sessionId, updatedAt: Date.now() } };
  fs.writeFileSync(storePath, JSON.stringify(entries, null, 2), "utf-8");
  return {
    agents: { defaults: { workspace: dir }, list: [{ id: "main", workspace: dir }] },
    session: { store: storePath },
    channels: {},
    plugins: { entries: {} },
  };
}

/** The chat-run state a gateway request context carries (server-request-context.ts). */
function createGatewayContext() {
  return {
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    chatRunBuffers: new Map<string, string>(),
    chatDeltaSentAt: new Map<string, number>(),
    chatDeltaLastBroadcastLen: new Map<string, number>(),
    chatAbortedRuns: new Map<string, number>(),
    agentRunSeq: new Map<string, number>(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
}

type TestContext = ReturnType<typeof createGatewayContext>;

function chatEvents(context: TestContext): ChatEventPayload[] {
  return context.broadcast.mock.calls
    .filter(([event]) => event === "chat")
    .map(([, payload]) => payload as ChatEventPayload);
}

/** Every tier-1 chat terminal broadcast for one runId, in order. */
function chatTerminals(context: TestContext, runId: string): ChatEventPayload[] {
  return chatEvents(context).filter(
    (payload) => payload.runId === runId && TERMINAL_STATES.has(payload.state ?? ""),
  );
}

function registerChatRun(context: TestContext, t: Names, runId: string): void {
  registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId: t.sessionId,
    sessionKey: t.key,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
}

/**
 * A turn running on the old session: its reply operation (holder D), its chat.send controller
 * (holder C) and its run context (holder B). Cancelling it settles the operation, as the runner's
 * `finally` does when it unwinds.
 */
function seedRunningTurn(context: TestContext, t: Names) {
  const operation = replyRunRegistry.begin({
    sessionKey: t.key,
    sessionId: t.sessionId,
    resetTriggered: false,
    promptKey: t.runningKey,
  });
  operation.setPhase("running");
  operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
  registerChatRun(context, t, t.runningKey);
  registerAgentRunContext(t.runningKey, { sessionKey: t.key });
  return operation;
}

/**
 * A prompt typed while that turn ran and BACKLOGGED behind it: its chat.send has settled (no
 * controller), its follow-up item waits in the queue, and the queue holds the drain callback that
 * would start it once the running turn ends (enqueueFollowupRun).
 */
function backlogBehind(t: Names, runFollowup: (run: FollowupRun) => Promise<void>): void {
  getFollowupQueue(t.key, { mode: "steer-backlog" }).items.push({
    prompt: "typed while the current turn was running",
    messageId: t.queuedKey,
    enqueuedAt: Date.now(),
    run: { sessionKey: t.key },
  } as unknown as FollowupRun);
  rememberFollowupDrainCallback(t.key, runFollowup);
}

function typedCommand(t: Names, text: string, overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Body: text,
    BodyForCommands: text,
    CommandBody: text,
    RawBody: text,
    SessionKey: t.key,
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "direct",
    CommandAuthorized: true,
    MessageSid: t.commandKey,
    GatewayClientScopes: [],
    ...overrides,
  };
}

/** A typed command as chat.send dispatches it: own controller first, then init in the RPC scope. */
async function typeInChat(context: TestContext, cfg: OpenClawConfig, t: Names, text = "/new") {
  registerChatRun(context, t, t.commandKey);
  return await withPluginRuntimeGatewayRequestScope(
    { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
    () => initSessionState({ ctx: typedCommand(t, text), cfg, commandAuthorized: true }),
  );
}

afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetAgentRunContextForTest();
  for (const t of ["queued", "idle", "channel", "spared"].map(names)) {
    clearSessionQueues([t.key, t.sessionId]);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("a /new or /reset TYPED in chat ends the old session's pending turns", () => {
  it("(a) a prompt backlogged behind a running turn: one aborted, never starts", async () => {
    const t = names("queued");
    const cfg = useTempStore(t);
    const context = createGatewayContext();
    const running = seedRunningTurn(context, t);
    const runFollowup = vi.fn(async () => {});
    backlogBehind(t, runFollowup);
    // The fixture fills every holder, so a green result cannot come from an empty one.
    expect(replyRunRegistry.isActive(t.key)).toBe(true);
    expect(getExistingFollowupQueue(t.key)?.items).toHaveLength(1);
    expect(getSessionRunLiveness(t.key).live).toBe(true);

    const result = await typeInChat(context, cfg, t);

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(t.sessionId);
    expect(chatTerminals(context, t.queuedKey)).toEqual([
      expect.objectContaining({ state: "aborted", stopReason: "session-reset", sessionKey: t.key }),
    ]);
    expect(chatTerminals(context, t.runningKey)).toEqual([
      expect.objectContaining({ state: "aborted", stopReason: "session-reset" }),
    ]);
    expect(running.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(t.key)).toBe(false);
    expect(getSessionRunLiveness(t.key).live).toBe(false);
    // The queued task never starts: its item and its drain callback left with the old session.
    expect(getExistingFollowupQueue(t.key)).toBeUndefined();
    kickFollowupDrainIfIdle(t.key);
    await Promise.resolve();
    expect(runFollowup).not.toHaveBeenCalled();
    // The command's own turn is untouched.
    expect(chatTerminals(context, t.commandKey)).toEqual([]);
    expect(context.chatAbortControllers.has(t.commandKey)).toBe(true);
    expect(context.chatAbortedRuns.has(t.commandKey)).toBe(false);
  });

  it("(b) idle session: no chat event, and the command's own turn lives on", async () => {
    const t = names("idle");
    const cfg = useTempStore(t);
    const context = createGatewayContext();

    const result = await typeInChat(context, cfg, t);

    expect(result.resetTriggered).toBe(true);
    expect(chatEvents(context)).toEqual([]);
    expect(context.nodeSendToSession).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(t.commandKey)).toBe(true);
  });

  it("(c) a channel /reset (no request scope) still ends the running turn", async () => {
    const t = names("channel");
    const cfg = useTempStore(t);
    const context = createGatewayContext();
    const running = seedRunningTurn(context, t);

    const result = await initSessionState({
      ctx: typedCommand(t, "/reset", {
        Provider: "quietchat",
        Surface: "quietchat",
        From: "user123",
        MessageSid: "channel-message-1",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(running.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(t.key)).toBe(false);
    expect(getSessionRunLiveness(t.key).live).toBe(false);
    // GAP PIN: a channel message carries no gateway request scope, so a Tinker chat.send
    // controller on the same session is out of its reach (as for the TUI and ACP resets).
    expect(chatEvents(context)).toEqual([]);
    expect(context.chatAbortControllers.has(t.runningKey)).toBe(true);
  });

  it("(d) exceptRunIds spares the named live run and ends every other run through the REAL map", async () => {
    const t = names("spared");
    const context = createGatewayContext();
    // The command's own run, as chat.send registers it before it dispatches, next to the turn the
    // reset is there to end.
    registerChatRun(context, t, t.commandKey);
    const running = seedRunningTurn(context, t);
    // A backlog item carrying the spared key: unreachable on the typed path today (the init runs
    // before the queue gate), and the one case the Proxy got wrong, since a hidden run read as "no
    // live controller" and was handed a backlog terminal.
    getFollowupQueue(t.key, { mode: "steer-backlog" }).items.push({
      prompt: "the command's own key, backlogged",
      messageId: t.commandKey,
      enqueuedAt: Date.now(),
      run: { sessionKey: t.key },
    } as unknown as FollowupRun);

    const turns = await endSessionTurns({
      keys: {
        requestedKey: t.key,
        canonicalKey: t.key,
        storeKeys: [t.key],
        sessionId: t.sessionId,
      },
      reason: "session-reset",
      chatAbortOps: context as unknown as ChatAbortOps,
      exceptRunIds: [t.commandKey],
    });

    expect(turns.abortedRunIds).toEqual([t.runningKey]);
    // The spared key's terminal is its own live run's to send, so it is not "dropped with none".
    expect(turns.unannouncedBacklog).toBe(0);
    expect(running.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    // The spared run: no terminal, its controller registered and not aborted, not marked aborted.
    expect(chatTerminals(context, t.commandKey)).toEqual([]);
    expect(context.chatAbortControllers.get(t.commandKey)?.controller.signal.aborted).toBe(false);
    expect(context.chatAbortedRuns.has(t.commandKey)).toBe(false);
    // Every other run gets its one terminal AND leaves the real map at once: a copy-based exception
    // would keep it registered until its chat.send settled, and a stop then would end it twice.
    expect(chatTerminals(context, t.runningKey)).toEqual([
      expect.objectContaining({ state: "aborted", stopReason: "session-reset" }),
    ]);
    expect(context.chatAbortControllers.has(t.runningKey)).toBe(false);
    expect(context.chatAbortedRuns.has(t.runningKey)).toBe(true);
  });
});
