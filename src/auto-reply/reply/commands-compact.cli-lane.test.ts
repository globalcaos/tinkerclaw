import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  compactEmbeddedPiSession: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: vi.fn(() => "Context 12.1k"),
  formatTokenCount: vi.fn((value: number) => `${value}`),
  incrementCompactionCount: vi.fn(),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  resolveFreshSessionTotalTokens: vi.fn(() => 12_345),
  resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
}));

const { compactEmbeddedPiSession, isEmbeddedPiRunActive } =
  await import("./commands-compact.runtime.js");
const { handleCompactCommand } = await import("./commands-compact.js");

const CFG = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
} as OpenClawConfig;

function buildParams(
  overrides: Partial<HandleCommandsParams> & { commandBody?: string } = {},
): HandleCommandsParams {
  const commandBody = overrides.commandBody ?? "/compact";
  return {
    cfg: CFG,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      CommandBody: commandBody,
    },
    command: {
      commandBodyNormalized: commandBody,
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: "owner",
      channel: "whatsapp",
      ownerList: [],
    },
    sessionKey: "agent:main:main",
    sessionStore: {},
    resolveDefaultThinkingLevel: async () => "medium",
    ...overrides,
  } as unknown as HandleCommandsParams;
}

/**
 * F2 — on the claude-code lane the model reads the claude CLI's OWN transcript, so compacting the
 * gateway's pi mirror leaves the next call exactly as large as before. A typed `/compact` there
 * must reach the agent runner as the turn prompt (the tinker-bridge writes it raw to the CLI), so
 * the handler hands the turn on instead of claiming it.
 */
describe("handleCompactCommand on a context-owning CLI lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
    resolveSessionAgentIdMock.mockReturnValue("main");
  });

  it("passes /compact through to the runner on a claude-code session", async () => {
    const params = buildParams({
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        modelProvider: "claude-code",
        model: "claude-opus-5",
      },
    } as Partial<HandleCommandsParams>);

    const result = await handleCompactCommand(params, true);

    // shouldContinue: true and no reply — get-reply-inline-actions returns kind:"continue", so the
    // untouched command body ("/compact") stays the turn prompt and reaches the agent runner.
    expect(result).toEqual({ shouldContinue: true });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
    // The pass-through is decided BEFORE the compaction runtime is loaded, so a live embedded run
    // is never interrupted to accomplish nothing — the lesson the EVICT button learned as F1.
    expect(vi.mocked(isEmbeddedPiRunActive)).not.toHaveBeenCalled();
    // The ORIGINAL command text is what the runner gets: this handler rewrites no body field.
    expect(params.ctx.CommandBody).toBe("/compact");
  });

  it("passes /compact with custom instructions through unchanged", async () => {
    const result = await handleCompactCommand(
      buildParams({
        commandBody: "/compact focus on decisions",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          modelProvider: "claude-code",
          model: "claude-opus-5",
        },
      } as Partial<HandleCommandsParams>),
      true,
    );

    expect(result).toEqual({ shouldContinue: true });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("honours the tab's model-picker override when resolving the lane", async () => {
    const result = await handleCompactCommand(
      buildParams({
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          // last run was embedded; the picker has since pinned the tab to claude-code, and the
          // refusal is about where the NEXT call goes.
          modelProvider: "openai",
          model: "gpt-5",
          providerOverride: "claude-code",
          modelOverride: "claude-opus-5",
        },
      } as Partial<HandleCommandsParams>),
      true,
    );

    expect(result).toEqual({ shouldContinue: true });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("prefers the target session entry's lane over the wrapper entry", async () => {
    const result = await handleCompactCommand(
      buildParams({
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
        },
        sessionStore: {
          "agent:target:whatsapp:direct:12345": {
            sessionId: "target-session",
            updatedAt: Date.now(),
            modelProvider: "claude-code",
            model: "claude-opus-5",
          },
        },
      } as Partial<HandleCommandsParams>),
      true,
    );

    expect(result).toEqual({ shouldContinue: true });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("passes through on a claude-code session with no session id", async () => {
    const result = await handleCompactCommand(
      buildParams({
        sessionEntry: {
          updatedAt: Date.now(),
          modelProvider: "claude-code",
          model: "claude-opus-5",
        },
      } as Partial<HandleCommandsParams>),
      true,
    );

    // The "missing session id" refusal is an embedded-compaction concern; the runner needs the
    // prompt either way.
    expect(result).toEqual({ shouldContinue: true });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("CONTROL: an embedded session still runs the embedded compaction", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    const result = await handleCompactCommand(
      buildParams({
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5",
        },
      } as Partial<HandleCommandsParams>),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledOnce();
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", trigger: "manual" }),
    );
  });

  it("CONTROL: an embedded session with no session id still refuses", async () => {
    const result = await handleCompactCommand(
      buildParams({
        sessionEntry: {
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5",
        },
      } as Partial<HandleCommandsParams>),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Compaction unavailable (missing session id)." },
    });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("CONTROL: an unauthorized /compact is still rejected on a claude-code session", async () => {
    const params = buildParams({
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        modelProvider: "claude-code",
        model: "claude-opus-5",
      },
    } as Partial<HandleCommandsParams>);

    const result = await handleCompactCommand(
      {
        ...params,
        command: { ...params.command, isAuthorizedSender: false, senderId: "unauthorized" },
      } as HandleCommandsParams,
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });
});
