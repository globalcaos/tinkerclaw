import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type TestSocket = {
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code: number, reason: string) => void;
};

type RecordingSocket = TestSocket & { frames: Array<{ event: string; seq?: number }> };

function makeRecordingSocket(): RecordingSocket {
  const socket: RecordingSocket = {
    bufferedAmount: 0,
    frames: [],
    send: (payload: string) => {
      socket.frames.push(JSON.parse(payload) as { event: string; seq?: number });
    },
    close: vi.fn(),
  };
  return socket;
}

function makeReadClient(connId: string, socket: TestSocket): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
    connId,
    usesSharedGatewayAuth: false,
  };
}

describe("gateway broadcaster", () => {
  it("filters approval and pairing events by scope", () => {
    const approvalsSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const pairingSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const readSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };

    const clients = new Set<GatewayWsClient>([
      {
        socket: approvalsSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.approvals"] } as GatewayWsClient["connect"],
        connId: "c-approvals",
      },
      {
        socket: pairingSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.pairing"] } as GatewayWsClient["connect"],
        connId: "c-pairing",
      },
      {
        socket: readSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
        connId: "c-read",
      },
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("exec.approval.requested", { id: "1" });
    broadcast("device.pair.requested", { requestId: "r1" });

    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
    expect(readSocket.send).toHaveBeenCalledTimes(0);
  });

  // FORK 2026-08-26 (chat-deliver): the broadcaster used to return nothing and
  // swallow send failures, so "this chat final reached zero sockets" looked
  // exactly like a healthy delivery. These pin the counters that replaced it.
  // `heartbeat` is the carrier for the pure counter cases because its scope guard
  // is `[]` (server-broadcast.ts), so scopeSkipped noise cannot creep in.
  it("reports one send per delivered socket", () => {
    const first = makeRecordingSocket();
    const second = makeRecordingSocket();
    const clients = new Set<GatewayWsClient>([
      makeReadClient("c-first", first),
      makeReadClient("c-second", second),
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    expect(broadcast("heartbeat", { ts: 1 })).toEqual({
      attempted: 2,
      sent: 2,
      scopeSkipped: 0,
      droppedSlow: 0,
      sendThrew: 0,
    });
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(1);
  });

  it("counts a throwing send instead of swallowing it", () => {
    const broken = makeRecordingSocket();
    broken.send = () => {
      throw new Error("socket already closed");
    };
    const healthy = makeRecordingSocket();
    const clients = new Set<GatewayWsClient>([
      makeReadClient("c-broken", broken),
      makeReadClient("c-healthy", healthy),
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    expect(broadcast("heartbeat", { ts: 1 })).toEqual({
      attempted: 2,
      sent: 1,
      scopeSkipped: 0,
      droppedSlow: 0,
      sendThrew: 1,
    });
    expect(healthy.frames).toHaveLength(1);
  });

  it("counts a dropIfSlow drop and still advances that client's seq", () => {
    const slow = makeRecordingSocket();
    slow.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    const clients = new Set<GatewayWsClient>([makeReadClient("c-slow", slow)]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    expect(broadcast("heartbeat", { ts: 1 }, { dropIfSlow: true })).toEqual({
      attempted: 1,
      sent: 0,
      scopeSkipped: 0,
      droppedSlow: 1,
      sendThrew: 0,
    });
    expect(slow.frames).toEqual([]);

    // The dropped frame still consumed seq 1, so the next frame this client
    // actually receives must be seq 2 — the behaviour droppedSlow now records.
    slow.bufferedAmount = 0;
    expect(broadcast("heartbeat", { ts: 2 }).sent).toBe(1);
    expect(slow.frames.map((frame) => frame.seq)).toEqual([2]);
  });

  it("counts an out-of-scope client as scopeSkipped", () => {
    const pairing = makeRecordingSocket();
    const reader = makeRecordingSocket();
    const clients = new Set<GatewayWsClient>([
      {
        socket: pairing as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.pairing"] } as GatewayWsClient["connect"],
        connId: "c-pairing",
        usesSharedGatewayAuth: false,
      },
      makeReadClient("c-read", reader),
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    expect(broadcast("chat", { sessionKey: "agent:main:main", message: "secret" })).toEqual({
      attempted: 2,
      sent: 1,
      scopeSkipped: 1,
      droppedSlow: 0,
      sendThrew: 0,
    });
  });

  it("returns zeroed counters — not undefined — for an empty client set", () => {
    const { broadcast } = createGatewayBroadcaster({ clients: new Set<GatewayWsClient>() });

    expect(
      broadcast("chat", {
        runId: "run-1",
        sessionKey: "agent:main:main",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "nobody home" }] },
      }),
    ).toEqual({
      attempted: 0,
      sent: 0,
      scopeSkipped: 0,
      droppedSlow: 0,
      sendThrew: 0,
    });
  });

  it("always logs a [chat-deliver] line for a chat final, whatever the ws log flag says", () => {
    const socket = makeRecordingSocket();
    const clients = new Set<GatewayWsClient>([makeReadClient("c-read", socket)]);
    const { broadcast } = createGatewayBroadcaster({ clients });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      broadcast("chat", {
        runId: "run-1",
        sessionKey: "agent:main:main",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "12345" }] },
      });
      // A non-final chat event stays silent: at most one line per completed turn.
      broadcast("chat", { runId: "run-1", sessionKey: "agent:main:main", state: "delta" });

      expect(
        log.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith("[chat-deliver] ")),
      ).toEqual([
        "[chat-deliver] sessionKey=agent:main:main runId=run-1 attempted=1 sent=1 scopeSkipped=0 droppedSlow=0 sendThrew=0 textLen=5",
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
