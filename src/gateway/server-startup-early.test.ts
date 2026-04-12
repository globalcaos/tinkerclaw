import { describe, expect, it } from "vitest";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";

describe("startGatewayEarlyRuntime", () => {
  it("does not eagerly start the MCP loopback server", async () => {
    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      tailscaleMode: "off" as never,
      log: {
        info: () => {},
        warn: () => {},
      },
      logDiscovery: {
        info: () => {},
        warn: () => {},
      },
      nodeRegistry: {} as never,
      broadcast: () => {},
      nodeSendToAllSubscribed: () => {},
      getPresenceVersion: () => 0,
      getHealthVersion: () => 0,
      refreshGatewayHealthSnapshot: () => {},
      logHealth: () => {},
      dedupe: () => {},
      chatAbortControllers: new Map(),
      chatRunState: new Map(),
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      removeChatRun: () => {},
      agentRunSeq: () => 0,
      nodeSendToSession: () => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: () => {},
      loadConfig: () => ({}) as never,
    });

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
  });
});
