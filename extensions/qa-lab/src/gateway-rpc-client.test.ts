import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientMock = vi.hoisted(() => {
  const request = vi.fn(async (_method?: string, _params?: unknown, _opts?: unknown) => ({
    ok: true,
  }));
  const stopAndWait = vi.fn(async () => {});
  const stop = vi.fn();
  const constructorCalls: Array<Record<string, unknown>> = [];
  let startMode: "hello" | "connect-error" = "hello";

  class MockGatewayClient {
    private readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      constructorCalls.push(options);
    }

    start() {
      queueMicrotask(() => {
        if (startMode === "connect-error") {
          const onConnectError = this.options.onConnectError;
          if (typeof onConnectError === "function") {
            onConnectError(new Error("connect boom"));
          }
          return;
        }
        const onHelloOk = this.options.onHelloOk;
        if (typeof onHelloOk === "function") {
          onHelloOk({});
        }
      });
    }

    async request(method: string, params?: unknown, opts?: unknown) {
      return await request(method, params, opts);
    }

    async stopAndWait() {
      await stopAndWait();
    }

    stop() {
      stop();
    }
  }

  return {
    MockGatewayClient,
    request,
    stopAndWait,
    stop,
    constructorCalls,
    reset() {
      request.mockReset().mockResolvedValue({ ok: true });
      stopAndWait.mockReset().mockResolvedValue(undefined);
      stop.mockReset();
      constructorCalls.splice(0, constructorCalls.length);
      startMode = "hello";
    },
    setStartMode(mode: "hello" | "connect-error") {
      startMode = mode;
    },
  };
});

vi.mock("./runtime-api.js", () => ({
  GatewayClient: gatewayClientMock.MockGatewayClient,
}));

import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

describe("startQaGatewayRpcClient", () => {
  beforeEach(() => {
    gatewayClientMock.reset();
  });

  it("starts a gateway client without device identity and forwards requests", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    expect(gatewayClientMock.constructorCalls[0]).toEqual(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "qa-token",
        deviceIdentity: null,
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
          "operator.talk.secrets",
        ],
      }),
    );

    await expect(
      client.request("agent.run", { prompt: "hi" }, { expectFinal: true, timeoutMs: 45_000 }),
    ).resolves.toEqual({ ok: true });

    expect(gatewayClientMock.request).toHaveBeenCalledWith(
      "agent.run",
      { prompt: "hi" },
      {
        expectFinal: true,
        timeoutMs: 45_000,
      },
    );

    await client.stop();
    expect(gatewayClientMock.stopAndWait).toHaveBeenCalledTimes(1);
  });

  it("wraps request failures with gateway logs", async () => {
    gatewayClientMock.request.mockRejectedValueOnce(new Error("gateway not connected"));
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await expect(client.request("health")).rejects.toThrow(
      "gateway not connected\nGateway logs:\nqa logs",
    );
  });

  it("wraps connect failures with gateway logs", async () => {
    gatewayClientMock.setStartMode("connect-error");

    await expect(
      startQaGatewayRpcClient({
        wsUrl: "ws://127.0.0.1:18789",
        token: "qa-token",
        logs: () => "qa logs",
      }),
    ).rejects.toThrow("connect boom\nGateway logs:\nqa logs");
  });
});
