/**
 * FORK 2026-10-09 (effort slider) — WHO chose a turn's thinking level, and whether a pin outlives
 * its turn.
 *
 * The slider has two jobs: a pinned level applies to the turns it is pinned for, and Auto is
 * decided per turn by Thalamus. These tests pin the precedence (human pin > Thalamus > allocator >
 * model default); that the allocator, which writes every level it returns to the effort ledger,
 * runs only when nothing above it decided; that chat.send's `thinking` param pins ITS turn and
 * reaches no persistence path; and that the provenance rides the run to the attempt's smuggle keys.
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEffortSmuggleOptions } from "../../agents/embedded-agent-runner/run/attempt.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveChatSendTurnThinking } from "../../gateway/server-methods/chat-command-body.js";
import type { TemplateContext } from "../templating.js";
import { buildEmbeddedRunBaseParams } from "./agent-runner-run-params.js";
import { resolveReplyDirectives, type TurnThinkLevelContext } from "./get-reply-directives.js";
import type { FollowupRun } from "./queue.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = vi.hoisted(() => ({
  chooseAutoEffort: vi.fn(),
  createModelSelectionState: vi.fn(),
  applyInlineDirectiveOverrides: vi.fn(),
}));

// The allocator is a spy: half of these tests are about WHETHER it is called.
vi.mock("../../agents/effort-allocator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/effort-allocator.js")>()),
  chooseAutoEffort: (...args: unknown[]) => mocks.chooseAutoEffort(...args),
}));

vi.mock("../../agents/fast-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/fast-mode.js")>()),
  resolveFastModeState: () => ({ enabled: false }),
}));

// An authorized webchat sender, as a chat.send sender always is.
vi.mock("./commands-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands-context.js")>()),
  buildCommandContext: () => ({
    surface: "webchat",
    channel: "webchat",
    channelId: "webchat",
    ownerList: [],
    senderIsOwner: true,
    isAuthorizedSender: true,
    senderId: undefined,
    abortKey: "abort-key",
    rawBodyNormalized: "hello",
    commandBodyNormalized: "hello",
    from: "webchat:tab-1",
    to: "webchat:tab-1",
  }),
}));

// Every path that persists an inline directive (persistInlineDirectives, the directive fast lane,
// a directive-only reply) sits behind this call, so what it RECEIVES is all that could persist.
vi.mock("./get-reply-directives-apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-reply-directives-apply.js")>()),
  applyInlineDirectiveOverrides: (...args: unknown[]) =>
    mocks.applyInlineDirectiveOverrides(...args),
}));

vi.mock("./get-reply-fast-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-reply-fast-path.js")>()),
  shouldUseReplyFastTestRuntime: () => false,
}));

vi.mock("./groups.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./groups.js")>()),
  resolveGroupRequireMention: async () => false,
}));

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  createModelSelectionState: (...args: unknown[]) => mocks.createModelSelectionState(...args),
  resolveContextTokens: () => 4096,
}));

vi.mock("./reply-elevated.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-elevated.js")>()),
  resolveElevatedPermissions: () => ({ enabled: true, allowed: true, failures: [] }),
}));

const TAB_KEY = "agent:main:tinker:tab-1";

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "tab-session", updatedAt: Date.now(), ...overrides };
}

/** The model selection a turn gets back. No route = routing off, skipped, or nothing routed. */
function useModelState(thalamusRoute?: { effort: string; ultracode?: boolean }) {
  mocks.createModelSelectionState.mockResolvedValue({
    provider: "claude-code",
    model: "claude-opus-5",
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    resolveThinkingCatalog: vi.fn(async () => []),
    resolveDefaultThinkingLevel: vi.fn(async () => "low"),
    resolveDefaultReasoningLevel: vi.fn(async () => "off"),
    thalamusRoute,
  });
}

async function resolveTurn(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  body?: string;
  sessionKey?: string;
  turnThinkLevel?: string;
}) {
  const body = params.body ?? "hello";
  const ctx: ReturnType<typeof buildTestCtx> & TurnThinkLevelContext = {
    ...buildTestCtx({
      Body: body,
      CommandBody: body,
      Provider: "webchat",
      Surface: "webchat",
      CommandAuthorized: true,
    }),
    ...(params.turnThinkLevel ? { TurnThinkLevel: params.turnThinkLevel } : {}),
  };
  const result = await resolveReplyDirectives({
    ctx,
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: {},
    sessionCtx: {
      Body: body,
      BodyStripped: body,
      BodyForAgent: body,
      CommandBody: body,
      Provider: "webchat",
    } as TemplateContext,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey ?? TAB_KEY,
    storePath: undefined,
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: body,
    resetTriggered: false,
    commandAuthorized: true,
    defaultProvider: "claude-code",
    defaultModel: "claude-opus-5",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "claude-code",
    model: "claude-opus-5",
    hasResolvedHeartbeatModelOverride: false,
    typing: {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: vi.fn(),
    },
    opts: undefined,
    skillFilter: undefined,
  });
  if (result.kind !== "continue") {
    throw new Error("expected the turn to continue into the agent path");
  }
  return result.result;
}

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "tab-session",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    config: {},
    provider: "claude-code",
    model: "claude-opus-5",
    timeoutMs: 60_000,
    blockReplyBreak: "text_end",
    thinkLevel: "xhigh",
    ...overrides,
  };
}

describe("effort provenance", () => {
  beforeEach(() => {
    mocks.chooseAutoEffort.mockReset();
    mocks.chooseAutoEffort.mockReturnValue("medium");
    mocks.createModelSelectionState.mockReset();
    mocks.applyInlineDirectiveOverrides.mockReset();
    mocks.applyInlineDirectiveOverrides.mockImplementation(
      async (params: {
        directives: unknown;
        provider: string;
        model: string;
        contextTokens: number;
      }) => ({
        kind: "continue",
        directives: params.directives,
        provider: params.provider,
        model: params.model,
        contextTokens: params.contextTokens,
      }),
    );
  });

  describe("who decides the level", () => {
    it("an Auto turn with a Thalamus route runs the route's level and ultracode and never asks the allocator", async () => {
      useModelState({ effort: "xhigh", ultracode: true });
      const entry = makeSessionEntry();

      const turn = await resolveTurn({ sessionEntry: entry, sessionStore: { [TAB_KEY]: entry } });

      expect(turn).toMatchObject({
        resolvedThinkLevel: "xhigh",
        thinkSource: "thalamus",
        ultracode: true,
      });
      expect(mocks.chooseAutoEffort).not.toHaveBeenCalled();
    });

    it("with routing off the allocator decides, once", async () => {
      useModelState(undefined);
      const entry = makeSessionEntry();

      const turn = await resolveTurn({ sessionEntry: entry, sessionStore: { [TAB_KEY]: entry } });

      expect(turn).toMatchObject({
        resolvedThinkLevel: "medium",
        thinkSource: "allocator",
        ultracode: false,
      });
      expect(mocks.chooseAutoEffort).toHaveBeenCalledTimes(1);
      expect(mocks.chooseAutoEffort).toHaveBeenCalledWith({ prompt: "hello", sessionKey: TAB_KEY });
    });

    it("a route effort no ThinkLevel carries falls through to the allocator and drops ultracode", async () => {
      useModelState({ effort: "none", ultracode: true });
      const entry = makeSessionEntry();

      const turn = await resolveTurn({ sessionEntry: entry, sessionStore: { [TAB_KEY]: entry } });

      expect(turn).toMatchObject({
        resolvedThinkLevel: "medium",
        thinkSource: "allocator",
        ultracode: false,
      });
    });

    it("a level stored on the session wins as a pin and turns the route's ultracode off", async () => {
      useModelState({ effort: "xhigh", ultracode: true });
      const entry = makeSessionEntry({ thinkingLevel: "high" });

      const turn = await resolveTurn({ sessionEntry: entry, sessionStore: { [TAB_KEY]: entry } });

      expect(turn).toMatchObject({
        resolvedThinkLevel: "high",
        thinkSource: "pin",
        ultracode: false,
      });
      expect(mocks.chooseAutoEffort).not.toHaveBeenCalled();
    });

    it("a session outside the interactive allowlist falls to the model default", async () => {
      useModelState(undefined);
      const cronKey = "agent:main:cron:nightly";
      const entry = makeSessionEntry();

      const turn = await resolveTurn({
        sessionEntry: entry,
        sessionStore: { [cronKey]: entry },
        sessionKey: cronKey,
      });

      expect(turn).toMatchObject({
        resolvedThinkLevel: "low",
        thinkSource: "default",
        ultracode: false,
      });
      expect(mocks.chooseAutoEffort).not.toHaveBeenCalled();
    });

    it("a /think typed this turn beats the client's pin for the turn and stays a directive", async () => {
      useModelState({ effort: "xhigh", ultracode: true });
      const entry = makeSessionEntry();

      const turn = await resolveTurn({
        sessionEntry: entry,
        sessionStore: { [TAB_KEY]: entry },
        body: "/think low hello",
        turnThinkLevel: "high",
      });

      expect(turn).toMatchObject({
        resolvedThinkLevel: "low",
        thinkSource: "pin",
        ultracode: false,
      });
      // Today's behaviour for a typed level: the persistence path sees the directive.
      expect(mocks.applyInlineDirectiveOverrides).toHaveBeenLastCalledWith(
        expect.objectContaining({
          directives: expect.objectContaining({ hasThinkDirective: true, thinkLevel: "low" }),
        }),
      );
    });
  });

  describe("the chat.send thinking param pins its own turn only", () => {
    it("applies to the turn that carries it, reaches no persistence path, and the next turn is Auto again", async () => {
      useModelState({ effort: "xhigh", ultracode: true });
      const entry = makeSessionEntry();
      const store = { [TAB_KEY]: entry };

      const pinned = await resolveTurn({
        sessionEntry: entry,
        sessionStore: store,
        turnThinkLevel: "high",
      });

      expect(pinned).toMatchObject({
        resolvedThinkLevel: "high",
        thinkSource: "pin",
        ultracode: false,
      });
      expect(mocks.applyInlineDirectiveOverrides).toHaveBeenLastCalledWith(
        expect.objectContaining({
          directives: expect.objectContaining({ hasThinkDirective: false }),
        }),
      );
      expect(entry.thinkingLevel).toBeUndefined();

      const next = await resolveTurn({ sessionEntry: entry, sessionStore: store });

      expect(next).toMatchObject({
        resolvedThinkLevel: "xhigh",
        thinkSource: "thalamus",
        ultracode: true,
      });
      expect(mocks.chooseAutoEffort).not.toHaveBeenCalled();

      // A client that sends its Auto position as a level pins nothing either.
      const auto = await resolveTurn({
        sessionEntry: entry,
        sessionStore: store,
        turnThinkLevel: "auto",
      });
      expect(auto).toMatchObject({ thinkSource: "thalamus", resolvedThinkLevel: "xhigh" });
    });

    it("chat.send hands the level over on the context, never as a /think in the command body", () => {
      expect(resolveChatSendTurnThinking({ message: "hello", thinking: "high" })).toBe("high");
      expect(resolveChatSendTurnThinking({ message: "hello" })).toBeUndefined();
      // The user's own /think is the explicit level and stays a directive; a command owns its turn.
      expect(
        resolveChatSendTurnThinking({ message: "/think xhigh keep going", thinking: "high" }),
      ).toBeUndefined();
      expect(resolveChatSendTurnThinking({ message: "/clear", thinking: "high" })).toBeUndefined();
      expect(resolveChatSendTurnThinking({ message: "   ", thinking: "high" })).toBeUndefined();

      // The leak's producer was chat.send prefixing `/think <lvl>` to the command body. Pin the
      // wiring, not only the helper: the builder call carries no `thinking`, the context does.
      const chatSource = fs.readFileSync(
        new URL("../../gateway/server-methods/chat.ts", import.meta.url),
        "utf8",
      );
      const builderCall = chatSource.match(/buildChatSendCommandBody\(\{[\s\S]*?\}\)/)?.[0];
      expect(builderCall).toBeDefined();
      expect(builderCall).not.toContain("thinking");
      expect(chatSource).toContain("TurnThinkLevel: turnThinkLevel");
    });
  });

  describe("the provenance rides the run to the attempt", () => {
    it("the run seam carries thinkSource and ultracode, and an older run carries neither", () => {
      const base = buildEmbeddedRunBaseParams({
        run: makeRun({ thinkSource: "thalamus", ultracode: true }),
        provider: "claude-code",
        model: "claude-opus-5",
        runId: "run-1",
        authProfile: {},
      });
      expect(base).toMatchObject({ thinkLevel: "xhigh", thinkSource: "thalamus", ultracode: true });

      const legacy = buildEmbeddedRunBaseParams({
        run: makeRun(),
        provider: "claude-code",
        model: "claude-opus-5",
        runId: "run-2",
        authProfile: {},
      });
      expect(legacy.thinkSource).toBeUndefined();
      expect(legacy.ultracode).toBeUndefined();
    });

    it("the attempt smuggles __openclawThinkSource and __openclawUltracode next to the level", () => {
      expect(
        buildEffortSmuggleOptions({
          thinkLevel: "xhigh",
          thinkSource: "thalamus",
          ultracode: true,
          trigger: "user",
        }),
      ).toEqual({
        __openclawThinkLevel: "xhigh",
        __openclawThinkSource: "thalamus",
        __openclawUltracode: true,
      });
      // A run built by a path that resolved no provenance reads as the default, never as a pin.
      expect(buildEffortSmuggleOptions({ thinkLevel: "low" })).toEqual({
        __openclawThinkLevel: "low",
        __openclawThinkSource: "default",
        __openclawUltracode: false,
      });
      // A memory flush inherits the turn's base params; it must not fan out.
      expect(
        buildEffortSmuggleOptions({
          thinkLevel: "xhigh",
          thinkSource: "thalamus",
          ultracode: true,
          trigger: "memory",
        }).__openclawUltracode,
      ).toBe(false);

      // The helper is only evidence if the stream wrapper actually spreads it.
      const attemptSource = fs.readFileSync(
        new URL("../../agents/embedded-agent-runner/run/attempt.ts", import.meta.url),
        "utf8",
      );
      expect(attemptSource).toContain("...buildEffortSmuggleOptions(params)");
    });
  });
});
