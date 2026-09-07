import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  resolveConversationDeliveryTarget,
} from "../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey, resolveQueueAnnounceId } from "./announce-idempotency.js";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  callGateway,
  createBoundDeliveryRouter,
  getGlobalHookRunner,
  isEmbeddedPiRunActive,
  getRuntimeConfig,
  loadSessionStore,
  queueEmbeddedPiMessage,
  resolveActiveEmbeddedRunSessionIdUnique,
  resolveAgentIdFromSessionKey,
  resolveConversationIdFromTargets,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  resolveStorePath,
  sendMessage,
} from "./subagent-announce-delivery.runtime.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin, type DeliveryContext } from "./subagent-announce-origin.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export { resolveAnnounceOrigin } from "./subagent-announce-origin.js";

const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;

type SubagentAnnounceDeliveryDeps = {
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    sessionId?: string;
    isActive: boolean;
    /** Several live runs share this session key; no single tab can be targeted. */
    ambiguous?: boolean;
  };
  queueEmbeddedPiMessage: typeof queueEmbeddedPiMessage;
  sendMessage: typeof sendMessage;
};

const defaultSubagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps = {
  callGateway,
  getRuntimeConfig,
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    const resolved = resolveActiveEmbeddedRunSessionIdUnique(requesterSessionKey);
    if (resolved.ambiguous) {
      // Two or more live runs answer to this key (multiple UI tabs under one
      // agent session). Announcing to either would inject a completion into a
      // tab that never requested it, and that tab will act on it. Fail closed.
      //
      // ASYMMETRY (documented here deliberately; NOT changed in this unit): the
      // "fail closed" only holds for STEERING into an existing run. Nulling
      // sessionId skips the steer branch in sendSubagentAnnounceDirectly, but
      // control then falls THROUGH to the direct `agent` gateway call, which
      // targets the same shared session key and fails OPEN by starting a NEW
      // run -- re-introducing the injection this guard just refused, through a
      // different door. BOTH dispatch orders reach it: the queue-primary order
      // returns "none" here (maybeQueueSubagentAnnounce bails on the missing
      // sessionId) and then falls through to the same direct call, so fixing
      // only the completion path would leave the hole open. A fix belongs at
      // that call site, not here.
      return { sessionId: undefined, isActive: false, ambiguous: true };
    }
    const sessionId =
      resolved.sessionId ?? loadRequesterSessionEntry(requesterSessionKey).entry?.sessionId;
    return {
      sessionId,
      isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId)),
    };
  },
  queueEmbeddedPiMessage,
  sendMessage,
};

let subagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps =
  defaultSubagentAnnounceDeliveryDeps;

function resolveBoundConversationOrigin(params: {
  bindingConversation: ConversationRef & { parentConversationId?: string };
  requesterConversation?: ConversationRef;
  requesterOrigin?: DeliveryContext;
}): DeliveryContext {
  const conversation = params.bindingConversation;
  const conversationId = conversation.conversationId?.trim() ?? "";
  const parentConversationId = conversation.parentConversationId?.trim() ?? "";
  const requesterConversationId = params.requesterConversation?.conversationId?.trim() ?? "";
  const requesterTo = params.requesterOrigin?.to?.trim();
  if (
    conversation.channel === "matrix" &&
    parentConversationId &&
    requesterConversationId &&
    parentConversationId === requesterConversationId &&
    requesterTo
  ) {
    return {
      channel: conversation.channel,
      accountId: conversation.accountId,
      to: requesterTo,
      ...(conversationId ? { threadId: conversationId } : {}),
    };
  }

  const boundTarget = resolveConversationDeliveryTarget({
    channel: conversation.channel,
    conversationId,
    parentConversationId,
  });
  const inferredThreadId =
    boundTarget.threadId ??
    (parentConversationId && parentConversationId !== conversationId
      ? conversationId
      : undefined) ??
    (params.requesterOrigin?.threadId != null && params.requesterOrigin.threadId !== ""
      ? stringifyRouteThreadId(params.requesterOrigin.threadId)
      : undefined);
  if (
    requesterTo &&
    conversationId &&
    requesterConversationId &&
    conversationId.toLowerCase() === requesterConversationId.toLowerCase()
  ) {
    return {
      channel: conversation.channel,
      accountId: conversation.accountId,
      to: requesterTo,
      threadId: inferredThreadId,
    };
  }
  return {
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: boundTarget.to,
    threadId: inferredThreadId,
  };
}

function resolveRequesterSessionActivity(requesterSessionKey: string) {
  const activity = subagentAnnounceDeliveryDeps.getRequesterSessionActivity(requesterSessionKey);
  if (activity.ambiguous) {
    // Do NOT fall through to the persisted session entry: it is looked up by the
    // same shared key and would re-introduce the guess we just refused.
    return { sessionId: undefined, isActive: false, ambiguous: true };
  }
  if (activity.sessionId || activity.isActive) {
    return activity;
  }
  const { entry } = loadRequesterSessionEntry(requesterSessionKey);
  const sessionId = entry?.sessionId;
  return {
    sessionId,
    isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId)),
  };
}

function resolveDirectAnnounceTransientRetryDelaysMs() {
  return process.env.OPENCLAW_TEST_FAST === "1"
    ? ([8, 16, 32] as const)
    : ([5_000, 10_000, 20_000] as const);
}

export function resolveSubagentAnnounceTimeoutMs(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, Math.floor(configured)), MAX_TIMER_SAFE_TIMEOUT_MS);
}

export function isInternalAnnounceRequesterSession(sessionKey: string | undefined): boolean {
  return getSubagentDepthFromSessionStore(sessionKey) >= 1 || isCronSessionKey(sessionKey);
}

function summarizeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

const TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
];

const PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
];

function isTransientAnnounceDeliveryError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  if (!message) {
    return false;
  }
  if (PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}

function isPermanentAnnounceDeliveryError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  return Boolean(
    message && PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message)),
  );
}

async function waitForAnnounceRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
  let retryIndex = 0;
  for (;;) {
    if (params.signal?.aborted) {
      throw new Error("announce delivery aborted");
    }
    try {
      return await params.run();
    } catch (err) {
      const delayMs = retryDelaysMs[retryIndex];
      if (delayMs == null || !isTransientAnnounceDeliveryError(err) || params.signal?.aborted) {
        throw err;
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      defaultRuntime.log(
        `[warn] Subagent announce ${params.operation} transient failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDeliveryError(err)}`,
      );
      retryIndex += 1;
      await waitForAnnounceRetryDelay(delayMs, params.signal);
    }
  }
}

export async function resolveSubagentCompletionOrigin(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childRunId?: string;
  spawnMode?: SpawnSubagentMode;
  expectsCompletionMessage: boolean;
}): Promise<DeliveryContext | undefined> {
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const channel = normalizeOptionalLowercaseString(requesterOrigin?.channel);
  const to = requesterOrigin?.to?.trim();
  const accountId = normalizeAccountId(requesterOrigin?.accountId);
  const threadId =
    requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
      ? stringifyRouteThreadId(requesterOrigin.threadId)
      : undefined;
  const conversationId =
    threadId ||
    resolveConversationIdFromTargets({
      targets: [to],
    }) ||
    "";
  const requesterConversation: ConversationRef | undefined =
    channel && conversationId ? { channel, accountId, conversationId } : undefined;

  const router = createBoundDeliveryRouter();
  const childRoute = router.resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: params.childSessionKey,
    requester: requesterConversation,
    failClosed: true,
  });
  if (childRoute.mode === "bound" && childRoute.binding) {
    return mergeDeliveryContext(
      resolveBoundConversationOrigin({
        bindingConversation: childRoute.binding.conversation,
        requesterConversation,
        requesterOrigin,
      }),
      requesterOrigin,
    );
  }

  const route = router.resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: params.requesterSessionKey,
    requester: requesterConversation,
    failClosed: true,
  });
  if (route.mode === "bound" && route.binding) {
    return mergeDeliveryContext(
      resolveBoundConversationOrigin({
        bindingConversation: route.binding.conversation,
        requesterConversation,
        requesterOrigin,
      }),
      requesterOrigin,
    );
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_delivery_target")) {
    return requesterOrigin;
  }
  try {
    const result = await hookRunner.runSubagentDeliveryTarget(
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        requesterOrigin,
        childRunId: params.childRunId,
        spawnMode: params.spawnMode,
        expectsCompletionMessage: params.expectsCompletionMessage,
      },
      {
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    const hookOrigin = normalizeDeliveryContext(result?.origin);
    if (!hookOrigin) {
      return requesterOrigin;
    }
    if (hookOrigin.channel && isInternalMessageChannel(hookOrigin.channel)) {
      return requesterOrigin;
    }
    return mergeDeliveryContext(hookOrigin, requesterOrigin);
  } catch {
    return requesterOrigin;
  }
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const requesterIsSubagent = isInternalAnnounceRequesterSession(item.sessionKey);
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== ""
      ? stringifyRouteThreadId(origin.threadId)
      : undefined;
  const deliveryTarget = !requesterIsSubagent
    ? resolveExternalBestEffortDeliveryTarget({
        channel: origin?.channel,
        to: origin?.to,
        accountId: origin?.accountId,
        threadId,
      })
    : { deliver: false };
  const idempotencyKey = buildAnnounceIdempotencyKey(
    resolveQueueAnnounceId({
      announceId: item.announceId,
      sessionKey: item.sessionKey,
      enqueuedAt: item.enqueuedAt,
    }),
  );
  await subagentAnnounceDeliveryDeps.callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: deliveryTarget.deliver ? deliveryTarget.channel : undefined,
      accountId: deliveryTarget.deliver ? deliveryTarget.accountId : undefined,
      to: deliveryTarget.deliver ? deliveryTarget.to : undefined,
      threadId: deliveryTarget.deliver ? deliveryTarget.threadId : undefined,
      deliver: deliveryTarget.deliver,
      internalEvents: item.internalEvents,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: item.sourceSessionKey,
        sourceChannel: item.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
        sourceTool: item.sourceTool ?? "subagent_announce",
      },
      idempotencyKey,
    },
    timeoutMs: announceTimeoutMs,
  });
}

export function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, entry, canonicalKey };
}

export function loadSessionEntryByKey(sessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  return store[sessionKey];
}

function buildAnnounceQueueKey(sessionKey: string, origin?: DeliveryContext): string {
  const accountId = normalizeAccountId(origin?.accountId);
  if (!accountId) {
    return sessionKey;
  }
  return `${sessionKey}:acct:${accountId}`;
}

async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  internalEvents?: AgentInternalEvent[];
  signal?: AbortSignal;
}): Promise<"steered" | "queued" | "none" | "dropped"> {
  if (params.signal?.aborted) {
    return "none";
  }
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const { sessionId, isActive } = resolveRequesterSessionActivity(canonicalKey);
  if (!sessionId) {
    return "none";
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
    sessionEntry: entry,
  });

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = subagentAnnounceDeliveryDeps.queueEmbeddedPiMessage(
      sessionId,
      params.steerMessage,
    );
    if (steered) {
      return "steered";
    }
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    const didQueue = enqueueAnnounce({
      key: buildAnnounceQueueKey(canonicalKey, origin),
      item: {
        announceId: params.announceId,
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        internalEvents: params.internalEvents,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
      },
      settings: queueSettings,
      send: sendAnnounce,
      shouldDefer: (item) => resolveRequesterSessionActivity(item.sessionKey).isActive,
    });
    return didQueue ? "queued" : "dropped";
  }

  return "none";
}

export function extractThreadCompletionFallbackText(internalEvents?: AgentInternalEvent[]): string {
  if (!internalEvents || internalEvents.length === 0) {
    return "";
  }
  for (const event of internalEvents) {
    if (event.type !== "task_completion") {
      continue;
    }
    const result = event.result.trim();
    if (result) {
      return result;
    }
    const statusLabel = event.statusLabel.trim();
    const taskLabel = event.taskLabel.trim();
    if (statusLabel && taskLabel) {
      return `${taskLabel}: ${statusLabel}`;
    }
    if (statusLabel) {
      return statusLabel;
    }
    if (taskLabel) {
      return taskLabel;
    }
  }
  return "";
}

function hasVisibleGatewayAgentPayload(response: unknown): boolean {
  const result =
    response && typeof response === "object" && "result" in response
      ? (response as { result?: unknown }).result
      : undefined;
  const payloads =
    result && typeof result === "object" && "payloads" in result
      ? (result as { payloads?: unknown }).payloads
      : undefined;
  if (!Array.isArray(payloads)) {
    return false;
  }
  return payloads.some((payload) => {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const record = payload as {
      text?: unknown;
      mediaUrl?: unknown;
      mediaUrls?: unknown;
      presentation?: unknown;
      interactive?: unknown;
      channelData?: unknown;
    };
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const mediaUrl = typeof record.mediaUrl === "string" ? record.mediaUrl.trim() : "";
    const mediaUrls = Array.isArray(record.mediaUrls)
      ? record.mediaUrls.some((item) => typeof item === "string" && item.trim())
      : false;
    return Boolean(
      text ||
      mediaUrl ||
      mediaUrls ||
      record.presentation ||
      record.interactive ||
      record.channelData,
    );
  });
}

async function sendCompletionFallback(params: {
  cfg: OpenClawConfig;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  content: string;
  requesterSessionKey: string;
  bestEffortDeliver?: boolean;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const channel = params.channel?.trim();
  const to = params.to?.trim();
  const content = params.content.trim();
  if (!channel || !to || !content) {
    return false;
  }
  await runAnnounceDeliveryWithRetry({
    operation: params.threadId
      ? "completion direct thread fallback send"
      : "completion direct fallback send",
    signal: params.signal,
    run: async () =>
      await subagentAnnounceDeliveryDeps.sendMessage({
        cfg: params.cfg,
        channel,
        to,
        accountId: params.accountId,
        threadId: params.threadId,
        content,
        requesterSessionKey: params.requesterSessionKey,
        bestEffort: params.bestEffortDeliver,
        idempotencyKey: params.idempotencyKey,
        abortSignal: params.signal,
      }),
  });
  return true;
}

function resolveCompletionFallbackPath(threadId: string | undefined) {
  return threadId ? ("direct-thread-fallback" as const) : ("direct-fallback" as const);
}

function stripNonDeliverableChannelForCompletionOrigin(
  context?: DeliveryContext,
): DeliveryContext | undefined {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel) {
    return normalized;
  }
  const channel = normalizeMessageChannel(normalized.channel);
  if (!channel || isDeliverableMessageChannel(channel)) {
    return normalized;
  }
  const { channel: _channel, ...rest } = normalized;
  return normalizeDeliveryContext(rest);
}

async function sendSubagentAnnounceDirectly(params: {
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  requesterIsSubagent: boolean;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  if (params.signal?.aborted) {
    return {
      delivered: false,
      path: "none",
    };
  }
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
  );
  try {
    const completionDirectOrigin = normalizeDeliveryContext(params.completionDirectOrigin);
    const directOrigin = normalizeDeliveryContext(params.directOrigin);
    const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
    // Merge completionDirectOrigin with directOrigin so that missing fields
    // (channel, to, accountId) fall back to the originating session's
    // lastChannel / lastTo. Without this, a completion origin that carries a
    // channel but not a `to` would prevent external delivery.
    const externalCompletionDirectOrigin =
      stripNonDeliverableChannelForCompletionOrigin(completionDirectOrigin);
    const completionExternalFallbackOrigin = mergeDeliveryContext(
      directOrigin,
      requesterSessionOrigin,
    );
    const effectiveDirectOrigin = params.expectsCompletionMessage
      ? mergeDeliveryContext(externalCompletionDirectOrigin, completionExternalFallbackOrigin)
      : directOrigin;
    const sessionOnlyOrigin = effectiveDirectOrigin?.channel
      ? effectiveDirectOrigin
      : requesterSessionOrigin;
    const deliveryTarget = !params.requesterIsSubagent
      ? resolveExternalBestEffortDeliveryTarget({
          channel: effectiveDirectOrigin?.channel,
          to: effectiveDirectOrigin?.to,
          accountId: effectiveDirectOrigin?.accountId,
          threadId: effectiveDirectOrigin?.threadId,
        })
      : { deliver: false };
    const normalizedSessionOnlyOriginChannel = !params.requesterIsSubagent
      ? normalizeMessageChannel(sessionOnlyOrigin?.channel)
      : undefined;
    const sessionOnlyOriginChannel =
      normalizedSessionOnlyOriginChannel &&
      isGatewayMessageChannel(normalizedSessionOnlyOriginChannel)
        ? normalizedSessionOnlyOriginChannel
        : undefined;
    const completionFallbackText =
      params.expectsCompletionMessage && deliveryTarget.deliver
        ? extractThreadCompletionFallbackText(params.internalEvents)
        : "";
    const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
    if (params.expectsCompletionMessage && requesterActivity.sessionId) {
      const woke = requesterActivity.sessionId
        ? subagentAnnounceDeliveryDeps.queueEmbeddedPiMessage(
            requesterActivity.sessionId,
            params.triggerMessage,
          )
        : false;
      if (woke) {
        return {
          delivered: true,
          path: "steered",
        };
      }
      if (requesterActivity.isActive) {
        try {
          const didFallback = await sendCompletionFallback({
            cfg,
            channel: deliveryTarget.channel,
            to: deliveryTarget.to,
            accountId: deliveryTarget.accountId,
            threadId: deliveryTarget.threadId,
            content: completionFallbackText,
            requesterSessionKey: canonicalRequesterSessionKey,
            bestEffortDeliver: params.bestEffortDeliver,
            idempotencyKey: params.directIdempotencyKey,
            signal: params.signal,
          });
          if (didFallback) {
            return {
              delivered: true,
              path: resolveCompletionFallbackPath(deliveryTarget.threadId),
            };
          }
        } catch (err) {
          return {
            delivered: false,
            path: "direct",
            error: `active requester session could not be woken; fallback send failed: ${summarizeDeliveryError(err)}`,
          };
        }
        return {
          delivered: false,
          path: "direct",
          error: "active requester session could not be woken",
        };
      }
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
    }
    let directAnnounceResponse: unknown;
    try {
      directAnnounceResponse = await runAnnounceDeliveryWithRetry({
        operation: params.expectsCompletionMessage
          ? "completion direct announce agent call"
          : "direct announce agent call",
        signal: params.signal,
        run: async () =>
          await subagentAnnounceDeliveryDeps.callGateway({
            method: "agent",
            params: {
              sessionKey: canonicalRequesterSessionKey,
              message: params.triggerMessage,
              deliver: deliveryTarget.deliver,
              bestEffortDeliver: params.bestEffortDeliver,
              internalEvents: params.internalEvents,
              channel: deliveryTarget.deliver ? deliveryTarget.channel : sessionOnlyOriginChannel,
              accountId: deliveryTarget.deliver
                ? deliveryTarget.accountId
                : sessionOnlyOriginChannel
                  ? sessionOnlyOrigin?.accountId
                  : undefined,
              to: deliveryTarget.deliver
                ? deliveryTarget.to
                : sessionOnlyOriginChannel
                  ? sessionOnlyOrigin?.to
                  : undefined,
              threadId: deliveryTarget.deliver
                ? deliveryTarget.threadId
                : sessionOnlyOriginChannel
                  ? sessionOnlyOrigin?.threadId
                  : undefined,
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: params.sourceSessionKey,
                sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
                sourceTool: params.sourceTool ?? "subagent_announce",
              },
              idempotencyKey: params.directIdempotencyKey,
            },
            // Wait for ADMISSION (the gateway's `accepted` ack), not for the
            // requester's turn to finish. `expectFinal: true` made this one call
            // span lane wait + the entire requester turn under a single hard
            // wall-clock timer armed before the call: a requester session is one
            // serialized lane, so a few long turns ahead of us starved announces
            // out before they were ever dequeued, and every retry appended to the
            // very lane it was starving in. The queued path (`sendAnnounce`) has
            // never set `expectFinal`; this makes the direct path consistent.
            //
            // This is a cure rather than a bigger bucket, and the reason is the
            // ordering: `respond(true, accepted, ...)` in server-methods/agent.ts
            // fires ON RECEIPT, before the request is handed to the session lane.
            // Dropping `expectFinal` therefore takes the lane wait out from under
            // this timer entirely instead of merely shortening it.
            //
            // The final response is needed for exactly one thing: the completion
            // fallback below inspects `result.payloads` to avoid double-sending
            // output the requester already surfaced, and an `accepted` ack carries
            // no payloads. That read is gated on `completionFallbackText` and
            // `directAnnounceResponse` has no other reader, so on the SUCCESS path
            // this is payload-equivalent -- with no fallback text the value was
            // already dead. On the ERROR path it is deliberately not equivalent:
            // a failure during the requester's turn used to reject here, and now
            // goes unobserved. Where that mattered (non-empty fallback text) we
            // still wait; where it did not, `sendCompletionFallback` already
            // early-returned on empty content, so the only delta is that an
            // admitted announce now reports delivered -- exactly what the queued
            // path has always reported.
            expectFinal: Boolean(completionFallbackText),
            timeoutMs: announceTimeoutMs,
          }),
      });
    } catch (err) {
      if (isPermanentAnnounceDeliveryError(err)) {
        throw err;
      }
      let didFallback = false;
      try {
        didFallback = await sendCompletionFallback({
          cfg,
          channel: deliveryTarget.channel,
          to: deliveryTarget.to,
          accountId: deliveryTarget.accountId,
          threadId: deliveryTarget.threadId,
          content: completionFallbackText,
          requesterSessionKey: canonicalRequesterSessionKey,
          bestEffortDeliver: params.bestEffortDeliver,
          idempotencyKey: params.directIdempotencyKey,
          signal: params.signal,
        });
      } catch (fallbackErr) {
        throw new Error(
          `${summarizeDeliveryError(err)}; fallback send failed: ${summarizeDeliveryError(fallbackErr)}`,
          { cause: fallbackErr },
        );
      }
      if (didFallback) {
        return {
          delivered: true,
          path: resolveCompletionFallbackPath(deliveryTarget.threadId),
        };
      }
      throw err;
    }

    if (completionFallbackText && !hasVisibleGatewayAgentPayload(directAnnounceResponse)) {
      const didFallback = await sendCompletionFallback({
        cfg,
        channel: deliveryTarget.channel,
        to: deliveryTarget.to,
        accountId: deliveryTarget.accountId,
        threadId: deliveryTarget.threadId,
        content: completionFallbackText,
        requesterSessionKey: canonicalRequesterSessionKey,
        bestEffortDeliver: params.bestEffortDeliver,
        idempotencyKey: params.directIdempotencyKey,
        signal: params.signal,
      });
      if (didFallback) {
        return {
          delivered: true,
          path: resolveCompletionFallbackPath(deliveryTarget.threadId),
        };
      }
    }

    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
    };
  }
}

/**
 * Emit exactly one structured line per announce, naming the delivery target we
 * chose, before anything is dispatched.
 *
 * Diagnosing the announce-starvation incident took a full forensic pass because
 * routing left no trace: which requester key we resolved, whether that
 * resolution was ambiguous, and which path we took were all only recoverable by
 * inferring them from `HOOK llm_input sessionKey=` further downstream.
 *
 * PII boundary (this repo is a public fork): session keys, channel names and
 * flags only -- never the announce text. Note that a DM-shaped session key
 * (`agent:main:<channel>:<address>`) embeds the channel address itself, which is
 * why the `to` field is not logged separately and why nothing here widens what
 * the surrounding gateway logs already record.
 */
function logAnnounceRoutingDecision(params: {
  requesterSessionKey: string;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  directOrigin?: DeliveryContext;
}): void {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  // The dispatcher tries `direct` first for completion announces and `queue`
  // first otherwise, and the two paths canonicalize DIFFERENT input keys, so
  // report the key the primary path will actually use.
  //
  // `primaryPath`, not `path`: this line is emitted BEFORE dispatch (the whole
  // point is to survive a call that never returns), and runSubagentAnnounceDispatch
  // falls through in both directions -- a queue-primary announce that fails to
  // queue is still delivered direct. Naming it `primaryPath` keeps the log from
  // asserting an outcome it cannot yet know; the realized path is in
  // `result.phases`.
  const primaryPath = params.expectsCompletionMessage ? "direct" : "queued";
  const requested = params.expectsCompletionMessage
    ? params.targetRequesterSessionKey
    : params.requesterSessionKey;
  const target = resolveRequesterStoreKey(cfg, requested);
  // Ambiguity only -- do NOT call getRequesterSessionActivity here. That dep is
  // also used to decide steer/queue vs direct, and some callers (and tests)
  // treat successive reads as a state machine on isActive. A pre-dispatch log
  // must not burn that observation.
  const activeRuns = resolveActiveEmbeddedRunSessionIdUnique(target);
  const channel = normalizeMessageChannel(params.directOrigin?.channel) ?? "none";
  defaultRuntime.log(
    `[info] Subagent announce routing primaryPath=${primaryPath} target=${target} requested=${requested} ambiguous=${activeRuns.ambiguous === true} candidates=${activeRuns.candidateCount} requesterIsSubagent=${params.requesterIsSubagent} channel=${channel}`,
  );
}

export async function deliverSubagentAnnouncement(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  internalEvents?: AgentInternalEvent[];
  summaryLine?: string;
  requesterSessionOrigin?: DeliveryContext;
  requesterOrigin?: DeliveryContext;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  logAnnounceRoutingDecision({
    requesterSessionKey: params.requesterSessionKey,
    targetRequesterSessionKey: params.targetRequesterSessionKey,
    requesterIsSubagent: params.requesterIsSubagent,
    expectsCompletionMessage: params.expectsCompletionMessage,
    directOrigin: params.directOrigin,
  });
  return await runSubagentAnnounceDispatch({
    expectsCompletionMessage: params.expectsCompletionMessage,
    signal: params.signal,
    queue: async () =>
      await maybeQueueSubagentAnnounce({
        requesterSessionKey: params.requesterSessionKey,
        announceId: params.announceId,
        triggerMessage: params.triggerMessage,
        steerMessage: params.steerMessage,
        summaryLine: params.summaryLine,
        requesterOrigin: params.requesterOrigin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
        internalEvents: params.internalEvents,
        signal: params.signal,
      }),
    direct: async () =>
      await sendSubagentAnnounceDirectly({
        targetRequesterSessionKey: params.targetRequesterSessionKey,
        triggerMessage: params.triggerMessage,
        internalEvents: params.internalEvents,
        directIdempotencyKey: params.directIdempotencyKey,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
        requesterIsSubagent: params.requesterIsSubagent,
        expectsCompletionMessage: params.expectsCompletionMessage,
        signal: params.signal,
        bestEffortDeliver: params.bestEffortDeliver,
      }),
  });
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps>) {
    subagentAnnounceDeliveryDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeliveryDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDeliveryDeps;
  },
};
