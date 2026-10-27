import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as replyRunTesting,
  createReplyOperation,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import type { HealthSummary } from "../commands/health.js";
import type { ChatAbortControllerEntry } from "../gateway/chat-abort.js";
import {
  REPLY_OPERATION_KEEPALIVE_CEILING_MS,
  STALE_SWEEP_REASON,
  startGatewayMaintenanceTimers,
} from "../gateway/server-maintenance.js";
import {
  getAgentRunContext,
  getSessionRunLiveness,
  registerAgentRunContext,
  resetAgentEventsForTest,
  sweepStaleRunContexts,
} from "./agent-events.js";

// prompt-queue.md §7 step G4, "no silent sweep of a pending turn" (§6.2 "Sweep (C9)").
//
// CONTROL: before G4 the maintenance timer called the bare `sweepStaleRunContexts()`, which drops
// a context after 30 min of silence whatever still holds its turn, and broadcast nothing. The first
// test pins that the unguarded form still does exactly that, so every "kept" assertion below is
// measured against a sweep that really would have fired.
//
// Ordering mirrors production: the reply operation is created BEFORE its run registers a context
// (agent-runner.ts createReplyOperation -> runAgentTurnWithFallback; followup-runner.ts :155/:171).

const SESSION = "agent:main:tinker:g4-sweep";
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);
/** One connection that called `sessions.subscribe`: the sweep's `sessions.changed` goes to it. */
const SESSION_SUBSCRIBERS: ReadonlySet<string> = new Set(["conn-g4-subscriber"]);

function createDeps() {
  return {
    broadcast: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    logHealth: { error: vi.fn(), info: vi.fn() },
    dedupe: new Map(),
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    chatRunState: { abortedRuns: new Map<string, number>() },
    chatRunBuffers: new Map<string, string>(),
    chatDeltaSentAt: new Map<string, number>(),
    chatDeltaLastBroadcastLen: new Map<string, number>(),
    removeChatRun: () => undefined,
    agentRunSeq: new Map<string, number>(),
    nodeSendToSession: vi.fn(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => SESSION_SUBSCRIBERS,
  };
}

type Deps = ReturnType<typeof createDeps>;

// `chat` goes out on `broadcast`, `sessions.changed` on `broadcastToConnIds` (to the subscribers);
// this reads both, so each assertion below counts an event whichever channel carries it.
function payloadsOf(deps: Deps, event: string): Array<Record<string, unknown>> {
  return [...deps.broadcast.mock.calls, ...deps.broadcastToConnIds.mock.calls]
    .filter((call) => call[0] === event)
    .map((call) => call[1] as Record<string, unknown>);
}

function sweepLogLines(deps: Deps): string[] {
  return deps.logHealth.info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("stale-sweep:"));
}

function beginReplyOperation() {
  return createReplyOperation({ sessionKey: SESSION, sessionId: "sid-g4", resetTriggered: false });
}

let timers: ReturnType<typeof startGatewayMaintenanceTimers> | undefined;

function startTimers(deps: Deps) {
  timers = startGatewayMaintenanceTimers(deps);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetAgentEventsForTest();
  replyRunTesting.resetReplyRunRegistry();
});

afterEach(() => {
  if (timers) {
    clearInterval(timers.tickInterval);
    clearInterval(timers.healthInterval);
    clearInterval(timers.dedupeCleanup);
    if (timers.mediaCleanup) {
      clearInterval(timers.mediaCleanup);
    }
    timers = undefined;
  }
  vi.useRealTimers();
  resetAgentEventsForTest();
  replyRunTesting.resetReplyRunRegistry();
});

describe("run-context sweep: no silent sweep of a pending turn (prompt-queue G4)", () => {
  it("CONTROL: the unguarded count-only sweep still drops a busy session's context", () => {
    beginReplyOperation();
    registerAgentRunContext("run-control", { sessionKey: SESSION });

    vi.setSystemTime(T0 + 31 * MIN);
    expect(sweepStaleRunContexts()).toBe(1);
    expect(getAgentRunContext("run-control")).toBeUndefined();
  });

  it("keeps a busy session's context, then ends it with exactly one terminal", async () => {
    const op = beginReplyOperation();
    registerAgentRunContext("run-pending", { sessionKey: SESSION });
    const deps = createDeps();
    // The gateway has relayed three events for this run and sent no terminal yet.
    deps.agentRunSeq.set("run-pending", 3);
    deps.chatRunBuffers.set("run-pending", "partial");
    startTimers(deps);

    await vi.advanceTimersByTimeAsync(32 * MIN);
    expect(getAgentRunContext("run-pending")).toBeDefined();
    expect(getSessionRunLiveness(SESSION).live).toBe(true);
    expect(payloadsOf(deps, "chat")).toEqual([]);
    expect(payloadsOf(deps, "sessions.changed")).toEqual([]);

    op.complete();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(getAgentRunContext("run-pending")).toBeUndefined();

    const chat = payloadsOf(deps, "chat");
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({
      runId: "run-pending",
      sessionKey: SESSION,
      seq: 4,
      state: "error",
      reason: STALE_SWEEP_REASON,
    });
    // Not a recoverable class, so the UI retry ladder never re-sends it (retry-policy.ts).
    expect(String(chat[0]?.errorMessage)).not.toMatch(
      /quota|rate.?limit|tpm|rpm|\b429\b|overloaded|temporarily unavailable|draining for restart/i,
    );
    expect(deps.nodeSendToSession).toHaveBeenCalledWith(SESSION, "chat", chat[0]);
    expect(deps.agentRunSeq.has("run-pending")).toBe(false);
    expect(deps.chatRunBuffers.has("run-pending")).toBe(false);

    const changed = payloadsOf(deps, "sessions.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      sessionKey: SESSION,
      reason: STALE_SWEEP_REASON,
      runId: "run-pending",
      run: { live: false, count: 0 },
    });
    expect(sweepLogLines(deps)).toHaveLength(1);
    expect(sweepLogLines(deps)[0]).toContain("replyOp=none");

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(payloadsOf(deps, "chat")).toHaveLength(1);
    expect(payloadsOf(deps, "sessions.changed")).toHaveLength(1);
  });

  it("a reply-operation phase change refreshes lastActiveAt for that session only", () => {
    const op = beginReplyOperation();
    registerAgentRunContext("run-phase", { sessionKey: SESSION });
    registerAgentRunContext("run-other", { sessionKey: "agent:main:tinker:other" });

    vi.setSystemTime(T0 + 20 * MIN);
    op.setPhase("running");
    expect(getAgentRunContext("run-phase")?.lastActiveAt).toBe(T0 + 20 * MIN);
    expect(getAgentRunContext("run-other")?.lastActiveAt).toBeUndefined();

    // 45 min after registration, 25 min after the phase change: only the untouched context is
    // stale, even for the unguarded sweep. CONTROL: without the phase hook both are dropped.
    op.complete();
    vi.setSystemTime(T0 + 45 * MIN);
    expect(sweepStaleRunContexts()).toBe(1);
    expect(getAgentRunContext("run-phase")).toBeDefined();
    expect(getAgentRunContext("run-other")).toBeUndefined();
  });

  it("an earlier turn's orphan on the same session is neither refreshed nor shielded", async () => {
    // The previous turn's lifecycle end was lost, so its context outlived it.
    registerAgentRunContext("run-orphan", { sessionKey: SESSION });
    vi.setSystemTime(T0 + 10 * MIN);
    const op = beginReplyOperation();
    registerAgentRunContext("run-current", { sessionKey: SESSION });
    const deps = createDeps();
    deps.agentRunSeq.set("run-orphan", 7);
    startTimers(deps);

    await vi.advanceTimersByTimeAsync(10 * MIN);
    op.setPhase("running");
    expect(getAgentRunContext("run-orphan")?.lastActiveAt).toBeUndefined();
    expect(getAgentRunContext("run-current")?.lastActiveAt).toBe(T0 + 20 * MIN);

    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(replyRunRegistry.isActive(SESSION)).toBe(true);
    expect(getAgentRunContext("run-orphan")).toBeUndefined();
    expect(getAgentRunContext("run-current")).toBeDefined();
    const chat = payloadsOf(deps, "chat");
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ runId: "run-orphan", state: "error" });
    expect(sweepLogLines(deps)[0]).toContain("replyOp=later-turn");
  });

  it("a live chat controller keeps the context; its expiry emits the only terminal", async () => {
    registerAgentRunContext("run-chat", { sessionKey: SESSION });
    const deps = createDeps();
    deps.agentRunSeq.set("run-chat", 2);
    deps.chatAbortControllers.set("run-chat", {
      controller: new AbortController(),
      sessionId: "sid-chat",
      sessionKey: SESSION,
      startedAtMs: T0,
      expiresAtMs: T0 + 40 * MIN,
    });
    startTimers(deps);

    await vi.advanceTimersByTimeAsync(35 * MIN);
    expect(getAgentRunContext("run-chat")).toBeDefined();
    expect(payloadsOf(deps, "chat")).toEqual([]);

    await vi.advanceTimersByTimeAsync(7 * MIN);
    expect(getAgentRunContext("run-chat")).toBeUndefined();
    const chat = payloadsOf(deps, "chat");
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ runId: "run-chat", state: "aborted", stopReason: "timeout" });
    expect(payloadsOf(deps, "sessions.changed")).toHaveLength(1);
  });

  it("an active reply operation shields a silent context only up to the ceiling", async () => {
    beginReplyOperation();
    registerAgentRunContext("run-leaked", { sessionKey: SESSION });
    const deps = createDeps();
    deps.agentRunSeq.set("run-leaked", 1);
    startTimers(deps);

    vi.setSystemTime(T0 + REPLY_OPERATION_KEEPALIVE_CEILING_MS + MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(replyRunRegistry.isActive(SESSION)).toBe(true);
    expect(getAgentRunContext("run-leaked")).toBeUndefined();
    expect(payloadsOf(deps, "chat")).toHaveLength(1);
    expect(sweepLogLines(deps)[0]).toContain("replyOp=past-ceiling");
  });

  it("sends no chat terminal for an already-closed or non-chat run", async () => {
    // chat.ts's backstop final already ended this chat.send run (it deletes agentRunSeq) but
    // nothing cleared its context: the common orphan. A terminal here would be a false red bubble.
    registerAgentRunContext("run-answered", { sessionKey: SESSION });
    const channelSession = "agent:main:whatsapp:g4";
    registerAgentRunContext("run-channel", {
      sessionKey: channelSession,
      isControlUiVisible: false,
    });
    const deps = createDeps();
    deps.agentRunSeq.set("run-channel", 5);
    startTimers(deps);

    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(getAgentRunContext("run-answered")).toBeUndefined();
    expect(getAgentRunContext("run-channel")).toBeUndefined();
    expect(payloadsOf(deps, "chat")).toEqual([]);
    const changedKeys = payloadsOf(deps, "sessions.changed").map((payload) => payload.sessionKey);
    expect(changedKeys.toSorted()).toEqual([SESSION, channelSession].toSorted());
    const lines = sweepLogLines(deps);
    expect(lines.some((line) => line.includes("none (no open chat stream)"))).toBe(true);
    expect(lines.some((line) => line.includes("none (not shown in chat)"))).toBe(true);
  });
});
