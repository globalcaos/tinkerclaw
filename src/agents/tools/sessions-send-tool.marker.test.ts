import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

// The tool resolves/visibility-checks the target session through these helpers
// and through the announce-delivery loader; for the marker test we stub them so
// the send reaches the gateway `agent` call cleanly (no DB / registry state).
vi.mock("./sessions-helpers.js", () => ({
  resolveSessionToolContext: () => ({
    cfg: {},
    mainKey: "main",
    alias: undefined,
    effectiveRequesterKey: "agent:main:main",
    restrictToSpawned: false,
  }),
  createAgentToAgentPolicy: () => ({
    enabled: true,
    isAllowed: () => true,
  }),
  resolveEffectiveSessionToolsVisibility: () => "spawned",
  resolveSessionReference: async (params: { sessionKey: string }) => ({
    ok: true,
    key: params.sessionKey,
    displayKey: params.sessionKey,
    status: "ok",
  }),
  resolveVisibleSessionReference: async (params: {
    resolvedSession: { key: string; displayKey: string };
  }) => ({
    ok: true,
    key: params.resolvedSession.key,
    displayKey: params.resolvedSession.displayKey,
    status: "ok",
  }),
  createSessionVisibilityGuard: async () => ({
    check: () => ({ allowed: true, status: "ok" }),
  }),
}));

vi.mock("../subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: () => undefined,
}));

vi.mock("../run-wait.js", () => ({
  readLatestAssistantReplySnapshot: vi.fn().mockResolvedValue(undefined),
  waitForAgentRunAndReadUpdatedAssistantReply: vi.fn(),
}));

// The A2A announce flow is the path that can forward to a REAL external
// recipient; assert it is invoked with the raw, UNMARKED message.
const runSessionsSendA2AFlowMock = vi.fn();
vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: (args: unknown) => runSessionsSendA2AFlowMock(args),
}));

vi.mock("../../acp/session-interaction-mode.js", () => ({
  isRequesterParentOfBackgroundAcpSession: () => false,
}));

import { createSessionsSendTool } from "./sessions-send-tool.js";

describe("sessions_send agent marker", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    gatewayCalls = [];
    runSessionsSendA2AFlowMock.mockReset();
  });

  const makeTool = () =>
    createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "whatsapp",
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        return { runId: "run-1" } as T;
      },
    });

  it("prepends the AGENT marker to the INTERNAL Tinker-UI send", async () => {
    const tool = makeTool();
    await tool.execute("call1", {
      sessionKey: "agent:main:main",
      message: "hello world",
      timeoutSeconds: 0,
    });

    const agentCall = gatewayCalls.find((c) => c.method === "agent");
    expect(agentCall).toBeDefined();
    const sendParams = agentCall?.params as Record<string, unknown>;
    // The copy delivered into the internal chat carries the marker...
    expect(sendParams.message).toBe("⟦AGENT⟧ hello world");
    // ...and it really is the internal channel.
    expect(sendParams.channel).toBe(INTERNAL_MESSAGE_CHANNEL);
  });

  it("forwards the UNMARKED message to the A2A announce flow (external recipients)", async () => {
    const tool = makeTool();
    await tool.execute("call2", {
      sessionKey: "agent:main:main",
      message: "hello world",
      timeoutSeconds: 0,
    });

    expect(runSessionsSendA2AFlowMock).toHaveBeenCalled();
    const a2aArgs = runSessionsSendA2AFlowMock.mock.calls[0][0] as Record<string, unknown>;
    // The A2A path can deliver to a real external channel: it must NOT carry
    // the internal-only marker.
    expect(a2aArgs.message).toBe("hello world");
    expect(a2aArgs.message).not.toContain("⟦AGENT⟧");
  });
});
