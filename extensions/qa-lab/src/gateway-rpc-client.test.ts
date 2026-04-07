import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayRpcMock = vi.hoisted(() => {
  const callGatewayFromCli = vi.fn(async () => ({ ok: true }));
  return {
    callGatewayFromCli,
    reset() {
      callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
    },
  };
});

vi.mock("./runtime-api.js", () => ({
  callGatewayFromCli: gatewayRpcMock.callGatewayFromCli,
}));

import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

describe("startQaGatewayRpcClient", () => {
  beforeEach(() => {
    gatewayRpcMock.reset();
  });

  it("calls the in-process gateway cli helper with the qa runtime env", async () => {
    const originalHome = process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_QA_TEST_ONLY;

    gatewayRpcMock.callGatewayFromCli.mockImplementationOnce(async () => {
      expect(process.env.OPENCLAW_HOME).toBe("/tmp/openclaw-home");
      expect(process.env.OPENCLAW_QA_TEST_ONLY).toBe("1");
      return { ok: true };
    });

    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      env: {
        OPENCLAW_HOME: "/tmp/openclaw-home",
        OPENCLAW_QA_TEST_ONLY: "1",
      } as NodeJS.ProcessEnv,
      logs: () => "qa logs",
    });

    await expect(
      client.request("agent.run", { prompt: "hi" }, { expectFinal: true, timeoutMs: 45_000 }),
    ).resolves.toEqual({ ok: true });

    expect(gatewayRpcMock.callGatewayFromCli).toHaveBeenCalledWith(
      "agent.run",
      {
        url: "ws://127.0.0.1:18789",
        token: "qa-token",
        timeout: "45000",
        expectFinal: true,
        json: true,
      },
      { prompt: "hi" },
      {
        expectFinal: true,
        progress: false,
      },
    );

    expect(process.env.OPENCLAW_HOME).toBe(originalHome);
    expect(process.env.OPENCLAW_QA_TEST_ONLY).toBeUndefined();
  });

  it("wraps request failures with gateway logs", async () => {
    gatewayRpcMock.callGatewayFromCli.mockRejectedValueOnce(new Error("gateway not connected"));
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      env: { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      logs: () => "qa logs",
    });

    await expect(client.request("health")).rejects.toThrow(
      "gateway not connected\nGateway logs:\nqa logs",
    );
  });

  it("rejects new requests after stop", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      env: { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      logs: () => "qa logs",
    });

    await client.stop();

    await expect(client.request("health")).rejects.toThrow(
      "gateway rpc client already stopped\nGateway logs:\nqa logs",
    );
  });
});
