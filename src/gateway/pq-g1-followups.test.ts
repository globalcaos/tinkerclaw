import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.js";
import type { HealthSummary } from "../commands/health.js";
import {
  getAgentRunContext,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { STALE_SWEEP_REASON } from "./server-maintenance.js";
import { agentHandlers } from "./server-methods/agent.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";

// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7, the two follow-ups the G1 commit
// ("end a session's pending turns on delete or reset") and the G4 commit ("stop the run-set sweep
// dropping pending turns silently") left open.
//
// (1) G1/H5. The `agent` method's `/new` and `/reset` (runSessionResetFromAgent) run inside an
//     RPC handler and so hold the request's chat-run state, but handed none to the reset:
//     endSessionTurns skipped its chat-controller step, and a live chat.send run on the session
//     went on with no terminal. CONTROL: on the parent tree the controller is never aborted and
//     no `aborted` is broadcast, so this test fails there.
// (2) G4. The sweep sent its `sessions.changed` on the unscoped `broadcast`, because
//     startGatewayEarlyRuntime did not hand the maintenance timers `broadcastToConnIds` or the
//     `sessions.subscribe` set. Driven through startGatewayEarlyRuntime itself, with only the
//     host side effects stubbed (discovery, machine name, remote skills, task-registry
//     maintenance), so a param the startup path forgets to forward fails here. CONTROL: on the
//     parent tree the chat-terminal assertions pass and the `sessions.changed` routing ones fail.
//
// The third route, a `/new` or `/reset` TYPED in chat, was closed later by ae8261ea05d ("end the
// old session's turns on a typed /new or /reset"): when the session has an entry to rotate, the
// auto-reply session init (auto-reply/reply/session.ts endTypedResetSessionTurns) hands
// endSessionTurns the chat-run state of the request its dispatch inherits, excepting the command's
// own run by runId (b5dbfc9d573). Its tests live in auto-reply/reply/session.reset-ends-turns.test.ts.

const resetCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("./session-reset-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-reset-service.js")>();
  return {
    ...actual,
    // The reset cut down to the step this file is about: the REAL endSessionTurns, handed exactly
    // the chatAbortOps the caller passed. The G1 suite (sessions.delete-pending-turn.test.ts)
    // already drives the whole performGatewaySessionReset chain from sessions.reset; what is new
    // here is only what the `agent` method hands it. Answering ok:false ends the method right
    // after the reset, before it would start a model turn.
    performGatewaySessionReset: async (
      params: Parameters<typeof actual.performGatewaySessionReset>[0],
    ) => {
      resetCalls.push({ ...params });
      await actual.endSessionTurns({
        keys: { requestedKey: params.key, canonicalKey: params.key, storeKeys: [params.key] },
        reason: "session-reset",
        chatAbortOps: params.chatAbortOps,
      });
      return {
        ok: false as const,
        error: { code: "UNAVAILABLE", message: "pq-g1-followups: stopped after the reset cleanup" },
      };
    },
  };
});

vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: vi.fn(async () => ({ bonjourStop: null })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "pq-g1-followups"),
}));

vi.mock("../infra/skills-remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/skills-remote.js")>()),
  setSkillsRemoteRegistry: vi.fn(),
  primeRemoteSkillsCache: vi.fn(async () => {}),
  refreshRemoteBinsForConnectedNodes: vi.fn(async () => {}),
}));

vi.mock("../tasks/task-registry.maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/task-registry.maintenance.js")>()),
  configureTaskRegistryMaintenance: vi.fn(),
  startTaskRegistryMaintenance: vi.fn(),
}));

const TERMINAL_STATES = new Set(["final", "error", "aborted"]);

type CallMock = ReturnType<typeof vi.fn>;

/** Every `chat` terminal broadcast for one runId, in order. */
function chatTerminals(broadcast: CallMock, runId: string): Array<Record<string, unknown>> {
  return broadcast.mock.calls
    .filter(([event]) => event === "chat")
    .map(([, payload]) => payload as Record<string, unknown>)
    .filter((payload) => payload.runId === runId && TERMINAL_STATES.has(String(payload.state)));
}

function eventsOn(mock: CallMock, event: string) {
  return mock.mock.calls.filter(([name]) => name === event);
}

let early: Awaited<ReturnType<typeof startGatewayEarlyRuntime>> | undefined;

afterEach(() => {
  const maintenance = early?.maintenance;
  if (maintenance) {
    clearInterval(maintenance.tickInterval);
    clearInterval(maintenance.healthInterval);
    clearInterval(maintenance.dedupeCleanup);
    if (maintenance.mediaCleanup) {
      clearInterval(maintenance.mediaCleanup);
    }
  }
  early?.skillsChangeUnsub();
  early = undefined;
  vi.useRealTimers();
  resetCalls.length = 0;
  resetAgentRunContextForTest();
  replyRunTesting.resetReplyRunRegistry();
});

function createRequestContext() {
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
    getRuntimeConfig: () => ({}),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
}

describe("G1/H5: `/reset` through the `agent` method ends the session's chat runs", () => {
  it("aborts a live chat controller with exactly one `aborted` terminal", async () => {
    const key = "agent:main:tinker:pq-g1f-agent-reset";
    const runId = "prompt-pq-g1f-agent-reset";
    const context = createRequestContext();
    const { controller, registered } = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionId: "sess-pq-g1f-agent-reset",
      sessionKey: key,
      timeoutMs: 60_000,
      kind: "chat-send",
    });
    // The fixture holds a real live controller, so a green result cannot come from an empty map.
    expect(registered).toBe(true);
    expect(controller.signal.aborted).toBe(false);

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "/reset",
        agentId: "main",
        sessionKey: key,
        idempotencyKey: "idem-pq-g1f-agent-reset",
      },
      respond: respond as never,
      context: context as unknown as GatewayRequestContext,
      req: { type: "req", id: "pq-g1f-agent-reset", method: "agent" },
      client: { connect: { scopes: [ADMIN_SCOPE] } } as never,
      isWebchatConnect: () => false,
    });

    // The reset really ran, from the agent method (the admin-scope gate passed).
    expect(resetCalls).toEqual([
      expect.objectContaining({ key, reason: "reset", commandSource: "gateway:agent" }),
    ]);
    expect(controller.signal.aborted).toBe(true);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(chatTerminals(context.broadcast, runId)).toEqual([
      expect.objectContaining({ sessionKey: key, state: "aborted", stopReason: "session-reset" }),
    ]);
  });
});

describe("G4: the stale sweep, as startGatewayEarlyRuntime wires it", () => {
  const KEY = "agent:main:tinker:pq-g4f-sweep";
  const RUN = "run-pq-g4f-sweep";
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 8, 24, 9, 0, 0);

  async function startWithRealWiring(subscribers: ReadonlySet<string>) {
    const deps = {
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      // The gateway relayed three events for this run and sent no terminal: its stream is open.
      agentRunSeq: new Map<string, number>([[RUN, 3]]),
      nodeSendToSession: vi.fn(),
    };
    early = await startGatewayEarlyRuntime({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      tailscaleMode: "off" as never,
      log: { info: () => {}, warn: () => {} },
      logDiscovery: { info: () => {}, warn: () => {} },
      nodeRegistry: {} as never,
      broadcast: deps.broadcast,
      broadcastToConnIds: deps.broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => subscribers,
      nodeSendToAllSubscribed: () => {},
      getPresenceVersion: () => 1,
      getHealthVersion: () => 1,
      refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
      logHealth: { error: vi.fn(), info: vi.fn() },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState: { abortedRuns: new Map() },
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      removeChatRun: () => undefined,
      agentRunSeq: deps.agentRunSeq,
      nodeSendToSession: deps.nodeSendToSession,
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: () => {},
      getRuntimeConfig: () => ({}) as never,
    });
    // The REAL maintenance timers are running, not the minimal-test-gateway null.
    expect(early.maintenance).not.toBeNull();
    return deps;
  }

  it("one chat terminal per swept run, one subscriber-scoped sessions.changed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    registerAgentRunContext(RUN, { sessionKey: KEY });
    const subscribers: ReadonlySet<string> = new Set(["conn-pq-g4f-subscriber"]);
    const deps = await startWithRealWiring(subscribers);

    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(getAgentRunContext(RUN)).toBeUndefined();

    expect(chatTerminals(deps.broadcast, RUN)).toEqual([
      expect.objectContaining({
        sessionKey: KEY,
        seq: 4,
        state: "error",
        reason: STALE_SWEEP_REASON,
      }),
    ]);
    // Never unscoped: only the connections that called sessions.subscribe get it.
    expect(eventsOn(deps.broadcast, "sessions.changed")).toEqual([]);
    const changed = eventsOn(deps.broadcastToConnIds, "sessions.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.[1]).toMatchObject({
      sessionKey: KEY,
      reason: STALE_SWEEP_REASON,
      runId: RUN,
      run: { live: false, count: 0 },
    });
    expect(changed[0]?.[2]).toBe(subscribers);

    // Later ticks find nothing left to announce.
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(chatTerminals(deps.broadcast, RUN)).toHaveLength(1);
    expect(eventsOn(deps.broadcastToConnIds, "sessions.changed")).toHaveLength(1);
  });

  it("with no session subscriber: no sessions.changed anywhere, the chat terminal still goes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    registerAgentRunContext(RUN, { sessionKey: KEY });
    const deps = await startWithRealWiring(new Set<string>());

    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    expect(chatTerminals(deps.broadcast, RUN)).toHaveLength(1);
    expect(eventsOn(deps.broadcast, "sessions.changed")).toEqual([]);
    expect(eventsOn(deps.broadcastToConnIds, "sessions.changed")).toEqual([]);
  });
});
