/**
 * FORK 2026-10-09 (effort slider) — the hop between resolveReplyDirectives and runPreparedReply.
 *
 * getReplyFromConfig destructures the directive continuation field by field and rebuilds the
 * runPreparedReply params by hand, so a field the continuation gains is dropped here unless it is
 * named twice. effort-provenance.test.ts covers both sides of this hop; this file covers the hop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  buildGetReplyGroupCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }) as unknown as HookRunner,
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

function continueWith(effort: Record<string, unknown>) {
  const base = createGetReplyContinueDirectivesResult({
    body: "hello world",
    abortKey: "agent:main:telegram:-100123",
    from: "telegram:user:42",
    to: "telegram:-100123",
    senderId: "42",
    commandSource: "text",
    senderIsOwner: true,
    resetHookTriggered: false,
  });
  return { ...base, result: { ...base.result, ...effort } };
}

describe("getReplyFromConfig carries the effort provenance to runPreparedReply", () => {
  beforeEach(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
    ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(runPreparedReplyMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({ OriginatingChannel: "Telegram", Provider: "telegram" }),
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
        triggerBodyNormalized: "hello world",
        bodyStripped: "hello world",
      }),
    );
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes Thalamus's level, thinkSource and ultracode through unchanged", async () => {
    mocks.resolveReplyDirectives.mockResolvedValue(
      continueWith({ resolvedThinkLevel: "xhigh", thinkSource: "thalamus", ultracode: true }),
    );

    await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedThinkLevel: "xhigh",
        thinkSource: "thalamus",
        ultracode: true,
      }),
    );
  });

  it("passes a human pin through as a pin", async () => {
    mocks.resolveReplyDirectives.mockResolvedValue(
      continueWith({ resolvedThinkLevel: "high", thinkSource: "pin", ultracode: false }),
    );

    await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedThinkLevel: "high", thinkSource: "pin", ultracode: false }),
    );
  });
});
