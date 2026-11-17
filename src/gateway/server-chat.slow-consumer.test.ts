/**
 * FORK 2026-11-04 — a reply's final must reach a client that stopped reading while the reply
 * streamed (a phone page frozen by sleep keeps its socket open but drains nothing).
 *
 * The incident this replays: a page stopped reading while a long answer streamed, so the gateway
 * queued every frame for its socket. Each assistant `agent` event carries the WHOLE text so far
 * and was not droppable, so during a 41 KB card the queue passed MAX_BUFFERED_BYTES, the next
 * frame closed the socket with 1008 ("slow consumer"), and both finals (the whole 47,052-char
 * reply) found it closing. When the page woke it held the answer up to char 10,248, inside the
 * card, and nothing ever sent it the rest.
 *
 * The replay follows the incident's sizes and cadence: the queue starts to grow when the reply is
 * at char 10,248, the text grows ~16 chars every 50 ms (about 2,300 assistant events in two
 * minutes), chat deltas go out at most every 150 ms, and the final carries 47,052 chars. The text
 * is invented. On the code before this fix the socket is closed with 1008 and no final is queued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./server-chat.persist-session-lifecycle.runtime.js", () => ({
  persistGatewaySessionLifecycleEvent: vi.fn(async () => undefined),
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
  loadGatewaySessionRow: vi.fn(() => null),
}));

import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";
import { DROP_IF_SLOW_BUFFERED_BYTES, MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const SESSION = "agent:main:tinker:test-phone";
const RUN = "run-card";
const REPLY_CHARS = 47_052;
const QUEUE_GROWS_FROM = 10_248;
const CHARS_PER_EVENT = 16;
const MS_PER_EVENT = 50;

/** An invented reply with the incident's shape: an intro, a long html-render card, a short tail. */
function inventedReply(): string {
  const intro = "Here is the comparison you asked for, with sources. ".repeat(160);
  const cardHead = '```html-render\n<div class="cards">\n';
  const cardRow =
    '  <div class="card"><h3>Option</h3><p>Price, size, delivery and a link.</p></div>\n';
  const tail = "```\n\nThat is the whole list; the cheapest one is the third.";
  const body = intro + cardHead + cardRow.repeat(420);
  const filler = "x".repeat(REPLY_CHARS - body.length - tail.length);
  return body + filler + tail;
}

type QueuedChat = { state?: string; runId?: string; text: string };

/** A socket whose reader stopped: every frame stays queued, so bufferedAmount only grows. */
function frozenSocket() {
  const socket = {
    bufferedAmount: 0,
    chats: [] as QueuedChat[],
    closes: [] as Array<{ code: number; reason: string }>,
    send(frame: string) {
      socket.bufferedAmount += Buffer.byteLength(frame);
      if (frame.startsWith('{"type":"event","event":"chat"') && frame.includes('"state":"final"')) {
        const parsed = JSON.parse(frame) as {
          payload: {
            state?: string;
            runId?: string;
            message?: { content?: Array<{ text?: string }> };
          };
        };
        socket.chats.push({
          state: parsed.payload.state,
          runId: parsed.payload.runId,
          text: parsed.payload.message?.content?.map((part) => part.text ?? "").join("") ?? "",
        });
      }
    },
    close(code: number, reason: string) {
      socket.closes.push({ code, reason });
    },
  };
  return socket;
}

function harness() {
  const socket = frozenSocket();
  const clients = new Set<GatewayWsClient>([
    {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: {
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      } as GatewayWsClient["connect"],
      connId: "phone-page",
      usesSharedGatewayAuth: false,
    },
  ]);
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });
  const chatRunState = createChatRunState();
  chatRunState.registry.add(RUN, { sessionKey: SESSION, clientRunId: RUN });
  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds,
    nodeSendToSession: () => {},
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: () => SESSION,
    clearAgentRunContext: () => {},
    toolEventRecipients: createToolEventRecipientRegistry(),
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    loadGatewaySessionRowForSnapshot: loadGatewaySessionRow,
  });
  return { socket, handler };
}

describe("a reply's final reaches a client that stopped reading (2026-11-04)", () => {
  let now = 0;

  beforeEach(() => {
    resetAgentRunContextForTest();
    now = Date.parse("2026-11-04T17:15:54.400Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentRunContextForTest();
  });

  it("queues the whole final instead of closing the socket on the streamed frames", () => {
    const text = inventedReply();
    expect(text.length).toBe(REPLY_CHARS);
    const { socket, handler } = harness();

    let seq = 1;
    handler({ runId: RUN, seq: seq++, stream: "lifecycle", ts: now, data: { phase: "start" } });
    let offeredChars = 0;
    let previous = 0;
    for (let end = QUEUE_GROWS_FROM; ; end = Math.min(text.length, end + CHARS_PER_EVENT)) {
      offeredChars += end;
      handler({
        runId: RUN,
        seq: seq++,
        stream: "assistant",
        ts: now,
        data: { text: text.slice(0, end), delta: text.slice(previous, end) },
      });
      previous = end;
      now += MS_PER_EVENT;
      if (end === text.length) {
        break;
      }
    }
    // The replay is big enough to matter: its assistant frames alone are past the close limit.
    expect(offeredChars).toBeGreaterThan(MAX_BUFFERED_BYTES);

    now += 3_000;
    handler({ runId: RUN, seq: seq++, stream: "lifecycle", ts: now, data: { phase: "end" } });

    expect(socket.closes).toEqual([]);
    const finals = socket.chats.filter((c) => c.state === "final" && c.runId === RUN);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text.length).toBe(REPLY_CHARS);
    expect(finals[0]?.text).toBe(text);
    expect(socket.bufferedAmount).toBeLessThan(MAX_BUFFERED_BYTES);
  });

  it("drops early only the frames the next one makes whole again", () => {
    const broadcast = vi.fn();
    const chatRunState = createChatRunState();
    chatRunState.registry.add(RUN, { sessionKey: SESSION, clientRunId: RUN });
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds: vi.fn(),
      nodeSendToSession: () => {},
      agentRunSeq: new Map(),
      chatRunState,
      resolveSessionKeyForRun: () => SESSION,
      clearAgentRunContext: () => {},
      toolEventRecipients: createToolEventRecipientRegistry(),
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      loadGatewaySessionRowForSnapshot: loadGatewaySessionRow,
    });

    handler({ runId: RUN, seq: 1, stream: "lifecycle", ts: now, data: { phase: "start" } });
    handler({
      runId: RUN,
      seq: 2,
      stream: "assistant",
      ts: now,
      data: { text: "Hello there", delta: "Hello there" },
    });
    // Each step waits out the 150 ms delta throttle, so every assistant event yields a chat delta.
    now += 200;
    handler({
      runId: RUN,
      seq: 3,
      stream: "assistant",
      ts: now,
      data: {
        text: "Hello there, a picture",
        delta: ", a picture",
        mediaUrls: ["https://example.test/picture.png"],
      },
    });
    now += 200;
    // A re-base: the text no longer extends what was streamed.
    handler({
      runId: RUN,
      seq: 4,
      stream: "assistant",
      ts: now,
      data: { text: "A new start", delta: "", replace: true },
    });

    const callsOf = (event: string) =>
      broadcast.mock.calls
        .filter(([name]) => name === event)
        .map(([, payload, opts]) => ({ payload: payload as Record<string, unknown>, opts }));
    const early = { dropIfSlow: true, supersededByNext: true };
    expect(callsOf("agent").map(({ payload, opts }) => [payload.stream, opts])).toEqual([
      ["lifecycle", undefined],
      ["assistant", early],
      // Media and a re-base ride on one event only, so those still have to arrive.
      ["assistant", undefined],
      ["assistant", undefined],
    ]);
    expect(callsOf("chat").map(({ payload, opts }) => [payload.replace, opts])).toEqual([
      [undefined, early],
      [undefined, early],
      // The next delta does not repeat `replace`, so this one is dropped only at the close limit.
      [true, { dropIfSlow: true }],
    ]);
  });
});

/**
 * FORK 2026-11-04 — the low drop limit is only for frames a later frame makes whole again. A tool
 * row, a rail row or a run's end reaches a page once: nothing sends it again and the page does not
 * repair a gap, so a stalled page must still get it queued while the cumulative frames around it
 * are dropped.
 *
 * Two pages watch one run. The laptop started it, reads everything and receives the run's tool
 * events directly. The phone stopped reading from the start and follows the session as a session
 * subscriber. The run streams a 20,000-char answer, 16 chars every 50 ms, then calls one tool and
 * ends. With every droppable frame held to the low limit, the phone got neither tool row nor the
 * run's end, and its socket stayed open, so nothing told it to resync.
 */
describe("a stalled page still gets the frames no later frame repeats (2026-11-04)", () => {
  const ANSWER_CHARS = 20_000;
  let now = 0;

  type SeenFrame = {
    event: string;
    stream?: string;
    state?: string;
    phase?: string;
    finalText?: string;
  };

  /** A page's socket that records what it is sent. A stalled one keeps every byte queued. */
  function pageSocket(params: { reads: boolean }) {
    const socket = {
      bufferedAmount: 0,
      seen: [] as SeenFrame[],
      closes: [] as Array<{ code: number; reason: string }>,
      send(frame: string) {
        if (!params.reads) {
          socket.bufferedAmount += Buffer.byteLength(frame);
        }
        const { event, payload } = JSON.parse(frame) as {
          event: string;
          payload?: {
            stream?: unknown;
            state?: unknown;
            phase?: unknown;
            data?: { phase?: unknown };
            message?: { content?: Array<{ text?: string }> };
          };
        };
        const p = payload ?? {};
        const phase = typeof p.data?.phase === "string" ? p.data.phase : p.phase;
        socket.seen.push({
          event,
          stream: typeof p.stream === "string" ? p.stream : undefined,
          state: typeof p.state === "string" ? p.state : undefined,
          phase: typeof phase === "string" ? phase : undefined,
          finalText:
            p.state === "final"
              ? (p.message?.content ?? []).map((part) => part.text ?? "").join("")
              : undefined,
        });
      },
      close(code: number, reason: string) {
        socket.closes.push({ code, reason });
      },
    };
    return socket;
  }

  type PageSocket = ReturnType<typeof pageSocket>;

  function pageClient(connId: string, socket: PageSocket): GatewayWsClient {
    return {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: {
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    };
  }

  function framesOf(socket: PageSocket, event: string, stream?: string): SeenFrame[] {
    return socket.seen.filter(
      (frame) => frame.event === event && (stream === undefined || frame.stream === stream),
    );
  }

  /** Invented plain text of the given length, ending on a full stop. */
  function inventedAnswer(chars: number): string {
    const sentence = "The answer keeps going, one plain sentence after another. ";
    return `${sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars - 1)}.`;
  }

  beforeEach(() => {
    resetAgentRunContextForTest();
    now = Date.parse("2026-11-04T17:15:54.400Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentRunContextForTest();
  });

  it("queues the tool rows and the run's end for a stalled session subscriber", () => {
    const laptop = pageSocket({ reads: true });
    const phone = pageSocket({ reads: false });
    const clients = new Set<GatewayWsClient>([
      pageClient("laptop", laptop),
      pageClient("phone", phone),
    ]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });
    const chatRunState = createChatRunState();
    chatRunState.registry.add(RUN, { sessionKey: SESSION, clientRunId: RUN });
    const toolEventRecipients = createToolEventRecipientRegistry();
    toolEventRecipients.add(RUN, "laptop");
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    sessionEventSubscribers.subscribe("phone");
    // The run's own verbose level and model, so no session store is read for them.
    registerAgentRunContext(RUN, { sessionKey: SESSION, verboseLevel: "off" });
    const model = { model: "test-model", modelProvider: "test-provider" };
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession: () => {},
      agentRunSeq: new Map(),
      chatRunState,
      resolveSessionKeyForRun: () => SESSION,
      clearAgentRunContext: () => {},
      toolEventRecipients,
      sessionEventSubscribers,
      loadGatewaySessionRowForSnapshot: loadGatewaySessionRow,
    });

    const answer = inventedAnswer(ANSWER_CHARS);
    expect(answer).toHaveLength(ANSWER_CHARS);
    let seq = 1;
    handler({
      runId: RUN,
      seq: seq++,
      stream: "lifecycle",
      ts: now,
      data: { phase: "start", ...model },
    });
    let assistantEvents = 0;
    let previous = 0;
    for (let end = CHARS_PER_EVENT; ; end = Math.min(answer.length, end + CHARS_PER_EVENT)) {
      handler({
        runId: RUN,
        seq: seq++,
        stream: "assistant",
        ts: now,
        data: { text: answer.slice(0, end), delta: answer.slice(previous, end) },
      });
      assistantEvents += 1;
      previous = end;
      now += MS_PER_EVENT;
      if (end === answer.length) {
        break;
      }
    }
    // The answer alone queued the phone past the low limit, so every frame after it meets a
    // queue the cumulative frames are already dropped at.
    expect(phone.bufferedAmount).toBeGreaterThan(DROP_IF_SLOW_BUFFERED_BYTES);

    handler({
      runId: RUN,
      seq: seq++,
      stream: "tool",
      ts: now,
      data: { phase: "start", name: "read", toolCallId: "call-1", args: { path: "notes.txt" } },
    });
    now += 400;
    handler({
      runId: RUN,
      seq: seq++,
      stream: "tool",
      ts: now,
      data: {
        phase: "result",
        name: "read",
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "Three lines of notes." }] },
      },
    });
    now += 400;
    handler({
      runId: RUN,
      seq: seq++,
      stream: "lifecycle",
      ts: now,
      data: { phase: "end", ...model },
    });

    // The phone: both tool rows and the run's end are queued, the socket stays open and the final
    // carries the whole answer.
    expect(phone.closes).toEqual([]);
    expect(framesOf(phone, "session.tool").map((frame) => frame.phase)).toEqual([
      "start",
      "result",
    ]);
    expect(framesOf(phone, "sessions.changed").map((frame) => frame.phase)).toEqual([
      "start",
      "end",
    ]);
    expect(
      framesOf(phone, "chat")
        .filter((frame) => frame.state === "final")
        .map((frame) => frame.finalText),
    ).toEqual([answer]);
    // The cumulative frames past the low limit were still dropped, so the queue stayed near it.
    expect(framesOf(phone, "agent", "assistant").length).toBeLessThan(assistantEvents);
    expect(phone.bufferedAmount).toBeLessThan(DROP_IF_SLOW_BUFFERED_BYTES + 1024 * 1024);

    // The laptop read everything, the run's own tool events included.
    expect(laptop.closes).toEqual([]);
    expect(framesOf(laptop, "agent", "assistant")).toHaveLength(assistantEvents);
    expect(framesOf(laptop, "agent", "tool").map((frame) => frame.phase)).toEqual([
      "start",
      "result",
    ]);
    expect(
      framesOf(laptop, "chat")
        .filter((frame) => frame.state === "final")
        .map((frame) => frame.finalText),
    ).toEqual([answer]);
  });
});
