import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { abortEmbeddedPiRun } from "../../agents/embedded-agent-runner/runs.js";
import { rewriteTranscriptEntriesInSessionFile } from "../../agents/embedded-agent-runner/transcript-rewrite.js";
import { resolveFailoverReasonFromError } from "../../agents/failover-error.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { stageSandboxMedia } from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { extractCanvasFromText } from "../../chat/canvas-render.js";
import { resolveSessionFilePath, updateSessionStore } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { logLargePayload } from "../../logging/diagnostic-payload.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { isAudioFileName } from "../../media/mime.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import {
  deleteMediaBuffer,
  MEDIA_MAX_BYTES,
  type SavedMedia,
  saveMediaBuffer,
} from "../../media/store.js";
import { createChannelReplyPipeline } from "../../plugin-sdk/channel-reply-pipeline.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  stripInlineDirectiveTagsForDisplay,
  sanitizeReplyDirectiveId,
} from "../../utils/directive-tags.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayCliClient,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  registerChatAbortController,
} from "../chat-abort.js";
import {
  type ChatImageContent,
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
  resolveChatAttachmentMaxBytes,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import {
  isToolHistoryBlockType,
  projectChatDisplayMessage,
  projectRecentChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { stripEnvelopeFromMessage } from "../chat-sanitize.js";
import {
  augmentChatHistoryWithCliSessionImports,
  resolveClaudeCliProvenanceSessionIds,
  resolveClaudeCliSessionFilePath,
} from "../cli-session-history.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  attachManagedOutgoingImagesToMessage,
  cleanupManagedOutgoingImageRecords,
  createManagedOutgoingImageBlocks,
} from "../managed-image-attachments.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  hasGatewayClientCap,
} from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../protocol/schema/primitives.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  resolveGatewayModelSupportsImages,
  resolveGatewaySessionThinkingDefault,
  resolveDeletedAgentIdFromSessionKey,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { buildChatSendCommandBody } from "./chat-command-body.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import {
  buildWebchatAssistantMessageFromReplyPayloads,
  buildWebchatAudioContentBlocksFromReplyPayloads,
} from "./chat-webchat-media.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

export type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

type AbortOrigin = "rpc" | "stop-command";

type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  text: string;
  abortOrigin: AbortOrigin;
};

type ChatAbortRequester = {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
};

/** True when a reply payload carries at least one media reference (mediaUrl or mediaUrls). */
function isMediaBearingPayload(payload: ReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return false;
  }
  if (payload.mediaUrl?.trim()) {
    return true;
  }
  if (payload.mediaUrls?.some((url) => url.trim())) {
    return true;
  }
  return false;
}

function isTtsSupplementPayload(payload: ReplyPayload): boolean {
  return (
    typeof payload.spokenText === "string" &&
    payload.spokenText.trim().length > 0 &&
    isMediaBearingPayload(payload)
  );
}

function stripVisibleTextFromTtsSupplement(payload: ReplyPayload): ReplyPayload {
  return isTtsSupplementPayload(payload) ? { ...payload, text: undefined } : payload;
}

async function buildWebchatAssistantMediaMessage(
  payloads: ReplyPayload[],
  options?: {
    localRoots?: readonly string[];
    onLocalAudioAccessDenied?: (message: string) => void;
  },
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  return buildWebchatAssistantMessageFromReplyPayloads(payloads, {
    localRoots: options?.localRoots,
    onLocalAudioAccessDenied: (err) => {
      options?.onLocalAudioAccessDenied?.(formatForLog(err));
    },
  });
}

export {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../chat-display-projection.js";

export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const MANAGED_OUTGOING_IMAGE_PATH_PREFIX = "/api/chat/media/outgoing/";
let chatHistoryPlaceholderEmitCount = 0;
const chatHistoryManagedImageCleanupState = new Map<string, Promise<void>>();
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main",
  "direct",
  "dm",
  "group",
  "channel",
  "cron",
  "run",
  "subagent",
  "acp",
  "thread",
  "topic",
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

type ChatSendDeliveryEntry = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

type ChatSendOriginatingRoute = {
  originatingChannel: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  explicitDeliverRoute: boolean;
};

type ChatSendExplicitOrigin = {
  originatingChannel?: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string;
};

type SideResultPayload = {
  kind: "btw";
  runId: string;
  sessionKey: string;
  question: string;
  text: string;
  isError?: boolean;
  ts: number;
};

function buildTranscriptReplyText(payloads: ReplyPayload[]): string {
  const chunks = payloads
    .map((payload) => {
      if (payload.isReasoning === true) {
        return "";
      }
      const parts = resolveSendableOutboundReplyParts(payload);
      const lines: string[] = [];
      const replyToId = sanitizeReplyDirectiveId(payload.replyToId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text = payload.text?.trim();
      if (text && !isSuppressedControlReplyText(text)) {
        lines.push(text);
      }
      for (const mediaUrl of parts.mediaUrls) {
        if (payload.sensitiveMedia === true) {
          continue;
        }
        const trimmed = mediaUrl.trim();
        if (trimmed) {
          lines.push(`MEDIA:${trimmed}`);
        }
      }
      if (payload.audioAsVoice && parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n").trim();
    })
    .filter(Boolean);
  return chunks.join("\n\n").trim();
}

function hasSensitiveMediaPayload(payloads: ReplyPayload[]): boolean {
  return payloads.some(
    (payload) => payload.sensitiveMedia === true && isMediaBearingPayload(payload),
  );
}

type AssistantDisplayContentBlock = Record<string, unknown>;

function sanitizeAssistantDisplayText(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutEnvelope = stripEnvelopeFromMessage(value);
  const normalized = typeof withoutEnvelope === "string" ? withoutEnvelope : value;
  const stripped = stripInlineDirectiveTagsForDisplay(normalized).text.trim();
  return stripped || undefined;
}

function extractAssistantDisplayTextFromContent(
  content?: readonly AssistantDisplayContentBlock[] | null,
): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const parts = content
    .map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") {
        return "";
      }
      return block.text.trim();
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

async function buildAssistantDisplayContentFromReplyPayloads(params: {
  sessionKey: string;
  payloads: ReplyPayload[];
  managedImageLocalRoots?: Parameters<typeof createManagedOutgoingImageBlocks>[0]["localRoots"];
  includeSensitiveMedia?: boolean;
  onLocalAudioAccessDenied?: (message: string) => void;
  onManagedImagePrepareError?: (message: string) => void;
}): Promise<AssistantDisplayContentBlock[] | undefined> {
  const rawTextPayloadCount = params.payloads.filter(
    (payload) =>
      payload.isReasoning !== true &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0,
  ).length;
  const normalized = normalizeReplyPayloadsForDelivery(params.payloads);
  if (normalized.length === 0) {
    return rawTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
  }

  const content: AssistantDisplayContentBlock[] = [];
  let strippedTextPayloadCount = 0;
  for (const payload of normalized) {
    const text = sanitizeAssistantDisplayText(payload.text);
    if (text) {
      content.push({ type: "text", text });
    } else if (typeof payload.text === "string" && payload.text.trim().length > 0) {
      strippedTextPayloadCount += 1;
    }
    if (params.includeSensitiveMedia === false && payload.sensitiveMedia === true) {
      continue;
    }
    const audioBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads([payload], {
      localRoots: Array.isArray(params.managedImageLocalRoots)
        ? params.managedImageLocalRoots
        : undefined,
      onLocalAudioAccessDenied: (err) => {
        params.onLocalAudioAccessDenied?.(formatForLog(err));
      },
    });
    content.push(...audioBlocks);

    const mediaUrls = Array.from(
      new Set([
        ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
        ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
      ]),
    );
    const imageBlocks = await createManagedOutgoingImageBlocks({
      sessionKey: params.sessionKey,
      mediaUrls,
      localRoots: params.managedImageLocalRoots,
      continueOnPrepareError: true,
      onPrepareError: (error) => {
        params.onManagedImagePrepareError?.(error.message);
      },
    });
    if (imageBlocks.length > 0) {
      content.push(...imageBlocks);
    }
  }

  if (content.length > 0) {
    return content;
  }
  return strippedTextPayloadCount > 0 ? [{ type: "text", text: "" }] : undefined;
}

function replaceAssistantContentTextBlocks(
  content: readonly AssistantDisplayContentBlock[] | undefined,
  transcriptMediaMessage: { content: Array<Record<string, unknown>> } | null,
): AssistantDisplayContentBlock[] | undefined {
  const transcriptTextBlocks = (transcriptMediaMessage?.content ?? []).filter(
    (block): block is AssistantDisplayContentBlock =>
      Boolean(block) &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string",
  );
  if (transcriptTextBlocks.length === 0) {
    return content ? [...content] : undefined;
  }
  if (!content || content.length === 0) {
    return [...transcriptTextBlocks];
  }
  const merged: AssistantDisplayContentBlock[] = [];
  let transcriptTextIndex = 0;
  for (const block of content) {
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      transcriptTextIndex < transcriptTextBlocks.length
    ) {
      merged.push(transcriptTextBlocks[transcriptTextIndex++]);
      continue;
    }
    merged.push(block);
  }
  if (transcriptTextIndex < transcriptTextBlocks.length) {
    merged.unshift(...transcriptTextBlocks.slice(transcriptTextIndex));
  }
  return merged;
}

function isManagedOutgoingImageUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const parsed = new URL(value, "http://localhost");
    return parsed.pathname.startsWith(MANAGED_OUTGOING_IMAGE_PATH_PREFIX);
  } catch {
    return false;
  }
}

function stripManagedOutgoingAssistantContentBlocks(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): AssistantDisplayContentBlock[] | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }
  const filtered = content.filter((block) => {
    if (block?.type !== "image") {
      return true;
    }
    return !(isManagedOutgoingImageUrl(block.url) || isManagedOutgoingImageUrl(block.openUrl));
  });
  return filtered.length > 0 ? filtered : undefined;
}

function extractAssistantDisplayText(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): string | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }
  const text = content
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function hasAssistantDisplayMediaContent(
  content: readonly AssistantDisplayContentBlock[] | undefined,
): boolean {
  return Boolean(content?.some((block) => block?.type !== "text"));
}

function scheduleChatHistoryManagedImageCleanup(params: {
  sessionKey: string;
  context: Pick<GatewayRequestContext, "logGateway">;
}) {
  if (chatHistoryManagedImageCleanupState.has(params.sessionKey)) {
    return;
  }
  const pending = cleanupManagedOutgoingImageRecords({ sessionKey: params.sessionKey })
    .then(() => undefined)
    .catch((error) => {
      params.context.logGateway.debug(
        `chat.history managed image cleanup skipped sessionKey=${JSON.stringify(params.sessionKey)} error=${formatForLog(error)}`,
      );
    })
    .finally(() => {
      if (chatHistoryManagedImageCleanupState.get(params.sessionKey) === pending) {
        chatHistoryManagedImageCleanupState.delete(params.sessionKey);
      }
    });
  chatHistoryManagedImageCleanupState.set(params.sessionKey, pending);
}

function resolveChatSendOriginatingRoute(params: {
  client?: { mode?: string | null; id?: string | null } | null;
  deliver?: boolean;
  entry?: ChatSendDeliveryEntry;
  explicitOrigin?: ChatSendExplicitOrigin;
  hasConnectedClient?: boolean;
  mainKey?: string;
  sessionKey: string;
}): ChatSendOriginatingRoute {
  if (params.explicitOrigin?.originatingChannel && params.explicitOrigin.originatingTo) {
    return {
      originatingChannel: params.explicitOrigin.originatingChannel,
      originatingTo: params.explicitOrigin.originatingTo,
      ...(params.explicitOrigin.accountId ? { accountId: params.explicitOrigin.accountId } : {}),
      ...(params.explicitOrigin.messageThreadId
        ? { messageThreadId: params.explicitOrigin.messageThreadId }
        : {}),
      explicitDeliverRoute: params.deliver === true,
    };
  }
  const shouldDeliverExternally = params.deliver === true;
  if (!shouldDeliverExternally) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const routeChannelCandidate = normalizeMessageChannel(
    params.entry?.deliveryContext?.channel ??
      params.entry?.lastChannel ??
      params.entry?.origin?.provider,
  );
  const routeToCandidate = params.entry?.deliveryContext?.to ?? params.entry?.lastTo;
  const routeAccountIdCandidate =
    params.entry?.deliveryContext?.accountId ??
    params.entry?.lastAccountId ??
    params.entry?.origin?.accountId ??
    undefined;
  const routeThreadIdCandidate =
    params.entry?.deliveryContext?.threadId ??
    params.entry?.lastThreadId ??
    params.entry?.origin?.threadId;
  if (params.sessionKey.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  const sessionScopeHead = sessionScopeParts[0];
  const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
  const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => (part ?? "").trim().toLowerCase())
    .filter(Boolean);
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === routeChannelCandidate;
  const isFromWebchatClient = isWebchatClient(params.client);
  const isFromGatewayCliClient = isGatewayCliClient(params.client);
  const hasClientMetadata =
    (typeof params.client?.mode === "string" && params.client.mode.trim().length > 0) ||
    (typeof params.client?.id === "string" && params.client.id.trim().length > 0);
  const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
  const isConfiguredMainSessionScope =
    normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey;
  const canInheritConfiguredMainRoute =
    isConfiguredMainSessionScope &&
    params.hasConnectedClient &&
    (isFromGatewayCliClient || !hasClientMetadata);

  // Webchat clients never inherit external delivery routes. Configured-main
  // sessions are stricter than channel-scoped sessions: only CLI callers, or
  // legacy callers with no client metadata, may inherit the last external route.
  const canInheritDeliverableRoute = Boolean(
    !isFromWebchatClient &&
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    ((!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape)) ||
      canInheritConfiguredMainRoute),
  );
  const hasDeliverableRoute =
    canInheritDeliverableRoute &&
    routeChannelCandidate &&
    routeChannelCandidate !== INTERNAL_MESSAGE_CHANNEL &&
    typeof routeToCandidate === "string" &&
    routeToCandidate.trim().length > 0;

  if (!hasDeliverableRoute) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  return {
    originatingChannel: routeChannelCandidate,
    originatingTo: routeToCandidate,
    accountId: routeAccountIdCandidate,
    messageThreadId: routeThreadIdCandidate,
    explicitDeliverRoute: true,
  };
}

function isAcpSessionKey(sessionKey: string | undefined): boolean {
  return Boolean(sessionKey?.split(":").includes("acp"));
}

function explicitOriginTargetsAcpSession(origin: ChatSendExplicitOrigin | undefined): boolean {
  if (!origin?.originatingChannel || !origin.originatingTo || !origin.accountId) {
    return false;
  }
  const channel = normalizeMessageChannel(origin.originatingChannel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel,
    accountId: origin.accountId,
    conversationId: origin.originatingTo,
  });
  return isAcpSessionKey(binding?.targetSessionKey);
}

function explicitOriginTargetsPluginBinding(origin: ChatSendExplicitOrigin | undefined): boolean {
  if (!origin?.originatingChannel || !origin.originatingTo || !origin.accountId) {
    return false;
  }
  const channel = normalizeMessageChannel(origin.originatingChannel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel,
    accountId: origin.accountId,
    conversationId: origin.originatingTo,
  });
  return isPluginOwnedSessionBindingRecord(binding);
}

function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}

export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}

function normalizeOptionalChatSystemReceipt(
  value: unknown,
): { ok: true; receipt?: string } | { ok: false; error: string } {
  if (value == null) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "systemProvenanceReceipt must be a string" };
  }
  const sanitized = sanitizeChatSendMessageInput(value);
  if (!sanitized.ok) {
    return sanitized;
  }
  const receipt = sanitized.message.trim();
  return { ok: true, receipt: receipt || undefined };
}

function isAcpBridgeClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const info = client?.connect?.client;
  return (
    info?.id === GATEWAY_CLIENT_NAMES.CLI &&
    info?.mode === GATEWAY_CLIENT_MODES.CLI &&
    info?.displayName === "ACP" &&
    info?.version === "acp"
  );
}

function canInjectSystemProvenance(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

async function persistChatSendImages(params: {
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<SavedMedia[]> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return [];
  }
  const inlineSaved: SavedMedia[] = [];
  for (const img of params.images) {
    try {
      inlineSaved.push(
        await saveMediaBuffer(Buffer.from(img.data, "base64"), img.mimeType, "inbound"),
      );
    } catch (err) {
      params.logGateway.warn(
        `chat.send: failed to persist inbound image (${img.mimeType}): ${formatForLog(err)}`,
      );
    }
  }
  // imageOrder now only tracks image slots (see chat-attachments.ts), so split
  // offloaded refs by mime: image offloads interleave with inline images via
  // imageOrder, and non-image offloads append to the transcript tail. Without
  // this split a non-image file would consume the next image slot whenever
  // both kinds appear in the same request.
  const imageOffloadedSaved: SavedMedia[] = [];
  const nonImageOffloadedSaved: SavedMedia[] = [];
  for (const ref of params.offloadedRefs) {
    const entry: SavedMedia = {
      id: ref.id,
      path: ref.path,
      size: 0,
      contentType: ref.mimeType,
    };
    if (ref.mimeType.startsWith("image/")) {
      imageOffloadedSaved.push(entry);
    } else {
      nonImageOffloadedSaved.push(entry);
    }
  }
  if (params.imageOrder.length === 0) {
    return [...inlineSaved, ...imageOffloadedSaved, ...nonImageOffloadedSaved];
  }
  const saved: SavedMedia[] = [];
  let inlineIndex = 0;
  let offloadedIndex = 0;
  for (const entry of params.imageOrder) {
    if (entry === "inline") {
      const inline = inlineSaved[inlineIndex++];
      if (inline) {
        saved.push(inline);
      }
      continue;
    }
    const offloaded = imageOffloadedSaved[offloadedIndex++];
    if (offloaded) {
      saved.push(offloaded);
    }
  }
  for (; inlineIndex < inlineSaved.length; inlineIndex++) {
    const inline = inlineSaved[inlineIndex];
    if (inline) {
      saved.push(inline);
    }
  }
  for (; offloadedIndex < imageOffloadedSaved.length; offloadedIndex++) {
    const offloaded = imageOffloadedSaved[offloadedIndex];
    if (offloaded) {
      saved.push(offloaded);
    }
  }
  for (const offloaded of nonImageOffloadedSaved) {
    saved.push(offloaded);
  }
  return saved;
}

function buildChatSendTranscriptMessage(params: {
  message: string;
  savedImages: SavedMedia[];
  timestamp: number;
  // FORK 2026-08-16 — stamp the client's idempotencyKey onto the PERSISTED user turn.
  //
  // Every other transcript writer here already records one (see appendAssistantTranscriptMessage),
  // and `transcriptHasIdempotencyKey` reads exactly this field to make appends idempotent ACROSS a
  // restart — but the user turn, the one message a human actually typed, was written without it.
  // Consequences, both real: the durable dedup could never protect a user turn, and a client
  // holding an unconfirmed prompt had no way to ask "did you already get this?" except by
  // comparing text, which is ambiguous the moment the same thing is sent twice. The webchat outbox
  // (tinker-ui/src/outbox.ts) resends unconfirmed prompts after a restart, so this key is what
  // makes that replay exact instead of a guess.
  idempotencyKey?: string;
}) {
  const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
  return {
    role: "user" as const,
    content: params.message,
    timestamp: params.timestamp,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...mediaFields,
  };
}

function stripTrailingOffloadedMediaMarkers(message: string, refs: OffloadedRef[]): string {
  if (refs.length === 0) {
    return message;
  }
  const removableRefs = new Set(refs.map((ref) => ref.mediaRef));
  const lines = message.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? "";
    const match = /^\[media attached:\s*(media:\/\/inbound\/[^\]\s]+)\]$/.exec(last);
    if (!match?.[1] || !removableRefs.delete(match[1])) {
      break;
    }
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

// Stages media-path offloads into the agent sandbox synchronously so chat.send
// can surface 5xx before respond(). Throws MediaOffloadError on any staging
// failure (ENOSPC / EPERM / partial-stage) so the outer chat.send handler can
// map it to UNAVAILABLE (5xx); plain Error would be misclassified as 4xx. All
// offloaded refs are cleaned up from the media store before rethrow.
// Callers MUST set ctx.MediaStaged=true when this runs so the dispatch
// pipeline skips its own stageSandboxMedia pass.
//
// Returned paths are absolute media-store paths when no sandbox is active, or
// sandbox-relative paths plus `workspaceDir` when sandboxing is active. Host-side
// media-understanding uses MediaWorkspaceDir to resolve those relative paths.
async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  includeImageRefs?: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): Promise<{ paths: string[]; types: string[]; workspaceDir?: string }> {
  const mediaPathRefs = params.offloadedRefs.filter(
    (ref) => params.includeImageRefs || !ref.mimeType.startsWith("image/"),
  );
  if (mediaPathRefs.length === 0) {
    return { paths: [], types: [] };
  }

  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return {
        paths: mediaPathRefs.map((ref) => ref.path),
        types: mediaPathRefs.map((ref) => ref.mimeType),
      };
    }

    // stageSandboxMedia caps each file at STAGED_MEDIA_MAX_BYTES (=
    // MEDIA_MAX_BYTES, 5MB) and silently skips oversized files. The parse cap
    // (resolveChatAttachmentMaxBytes, default 20MB) is higher, so a sandboxed
    // session receiving a file between the two caps would otherwise
    // pass parse, fail staging, and surface as a retryable 5xx even though
    // retry cannot succeed. Reject here as a client-side 4xx instead.
    const oversizedForSandbox = mediaPathRefs.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      MediaPath: mediaPathRefs[0].path,
      MediaPaths: mediaPathRefs.map((ref) => ref.path),
      MediaType: mediaPathRefs[0].mimeType,
      MediaTypes: mediaPathRefs.map((ref) => ref.mimeType),
    };
    const stageResult = await stageSandboxMedia({
      ctx: stagingCtx,
      sessionCtx: stagingCtx as TemplateContext,
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });

    // stageSandboxMedia silently keeps unstaged entries as their original
    // absolute path, so length parity with `nonImage` does not prove every
    // file landed in the sandbox. The RPC max (20MB via
    // resolveChatAttachmentMaxBytes) admits files above the staging cap
    // (STAGED_MEDIA_MAX_BYTES = 5MB); check the returned `staged` map so any
    // missing source becomes a 5xx MediaOffloadError the client can retry.
    const stagedSources = stageResult.staged;
    const missing = mediaPathRefs.filter((ref) => !stagedSources.has(ref.path));
    if (missing.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${mediaPathRefs.length} paths staged into sandbox workspace (missing: ${missing.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedPaths = stagingCtx.MediaPaths ?? [];
    const stagedTypes = stagingCtx.MediaTypes ?? mediaPathRefs.map((ref) => ref.mimeType);

    // Keep stagedPaths sandbox-relative (e.g. `media/inbound/foo.pdf`) so the
    // agent inside the container can read them. Host-side media-understanding
    // resolves them via ctx.MediaWorkspaceDir, which we carry separately.
    return { paths: stagedPaths, types: stagedTypes, workspaceDir: sandbox.workspaceDir };
  } catch (err) {
    await Promise.allSettled(
      params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")),
    );
    if (err instanceof MediaOffloadError) {
      throw err;
    }
    // Sandbox-oversize rejections are client-side 4xx (see check above). Wrapping
    // them as MediaOffloadError would misclassify them as retryable 5xx.
    if (err instanceof UnsupportedAttachmentError) {
      throw err;
    }
    throw new MediaOffloadError(
      `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

function resolveChatSendTranscriptMediaFields(savedImages: SavedMedia[]) {
  const mediaPaths = savedImages.map((entry) => entry.path);
  if (mediaPaths.length === 0) {
    return {};
  }
  const mediaTypes = savedImages.map((entry) => entry.contentType ?? "application/octet-stream");
  return {
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes,
  };
}

function extractTranscriptUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block && typeof block === "object" && "text" in block ? block.text : undefined,
    )
    .filter((text): text is string => typeof text === "string");
  return textBlocks.length > 0 ? textBlocks.join("") : undefined;
}

async function rewriteChatSendUserTurnMediaPaths(params: {
  transcriptPath: string;
  sessionKey: string;
  message: string;
  savedImages: SavedMedia[];
}) {
  const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
  if (!("MediaPath" in mediaFields)) {
    return;
  }
  const sessionManager = SessionManager.open(params.transcriptPath);
  const branch = sessionManager.getBranch();
  const target = [...branch].toReversed().find((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") {
      return false;
    }
    const existingPaths = Array.isArray((entry.message as { MediaPaths?: unknown }).MediaPaths)
      ? (entry.message as { MediaPaths?: unknown[] }).MediaPaths
      : undefined;
    if (
      (typeof (entry.message as { MediaPath?: unknown }).MediaPath === "string" &&
        (entry.message as { MediaPath?: string }).MediaPath) ||
      (existingPaths && existingPaths.length > 0)
    ) {
      return false;
    }
    return (
      extractTranscriptUserText((entry.message as { content?: unknown }).content) === params.message
    );
  });
  if (!target || target.type !== "message") {
    return;
  }
  const rewrittenMessage = {
    ...target.message,
    ...mediaFields,
  };
  await rewriteTranscriptEntriesInSessionFile({
    sessionFile: params.transcriptPath,
    sessionKey: params.sessionKey,
    request: {
      replacements: [
        {
          entryId: target.id,
          message: rewrittenMessage,
        },
      ],
    },
  });
}

function extractChatHistoryBlockText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const textParts = entry.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return undefined;
      }
      const typed = block as { text?: unknown; type?: unknown };
      return typeof typed.text === "string" ? typed.text : undefined;
    })
    .filter((value): value is string => typeof value === "string");
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function appendCanvasBlockToAssistantHistoryMessage(params: {
  message: unknown;
  preview: ReturnType<typeof extractCanvasFromText>;
  rawText: string | null;
}): unknown {
  const preview = params.preview;
  if (!preview || !params.message || typeof params.message !== "object") {
    return params.message;
  }
  const entry = params.message as Record<string, unknown>;
  const baseContent = Array.isArray(entry.content)
    ? [...entry.content]
    : typeof entry.content === "string"
      ? [{ type: "text", text: entry.content }]
      : typeof entry.text === "string"
        ? [{ type: "text", text: entry.text }]
        : [];
  const alreadyPresent = baseContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as { type?: unknown; preview?: unknown };
    return (
      typed.type === "canvas" &&
      typed.preview &&
      typeof typed.preview === "object" &&
      (((typed.preview as { viewId?: unknown }).viewId &&
        (typed.preview as { viewId?: unknown }).viewId === preview.viewId) ||
        ((typed.preview as { url?: unknown }).url &&
          (typed.preview as { url?: unknown }).url === preview.url))
    );
  });
  if (!alreadyPresent) {
    baseContent.push({
      type: "canvas",
      preview,
      rawText: params.rawText,
    });
  }
  return {
    ...entry,
    content: baseContent,
  };
}

function messageContainsToolHistoryContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string"
  ) {
    return true;
  }
  if (!Array.isArray(entry.content)) {
    return false;
  }
  return entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
}

export function augmentChatHistoryWithCanvasBlocks(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  const next = [...messages];
  let changed = false;
  let lastAssistantIndex = -1;
  let lastRenderableAssistantIndex = -1;
  const pending: Array<{
    preview: NonNullable<ReturnType<typeof extractCanvasFromText>>;
    rawText: string | null;
  }> = [];
  for (let index = 0; index < next.length; index++) {
    const message = next[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    if (role === "assistant") {
      lastAssistantIndex = index;
      if (!messageContainsToolHistoryContent(entry)) {
        lastRenderableAssistantIndex = index;
        if (pending.length > 0) {
          let target = next[index];
          for (const item of pending) {
            target = appendCanvasBlockToAssistantHistoryMessage({
              message: target,
              preview: item.preview,
              rawText: item.rawText,
            });
          }
          next[index] = target;
          pending.length = 0;
          changed = true;
        }
      }
      continue;
    }
    if (!messageContainsToolHistoryContent(entry)) {
      continue;
    }
    const toolName =
      typeof entry.toolName === "string"
        ? entry.toolName
        : typeof entry.tool_name === "string"
          ? entry.tool_name
          : undefined;
    const text = extractChatHistoryBlockText(entry);
    const preview = extractCanvasFromText(text, toolName);
    if (!preview) {
      continue;
    }
    pending.push({
      preview,
      rawText: text ?? null,
    });
  }
  if (pending.length > 0) {
    const targetIndex =
      lastRenderableAssistantIndex >= 0 ? lastRenderableAssistantIndex : lastAssistantIndex;
    if (targetIndex >= 0) {
      let target = next[targetIndex];
      for (const item of pending) {
        target = appendCanvasBlockToAssistantHistoryMessage({
          message: target,
          preview: item.preview,
          rawText: item.rawText,
        });
      }
      next[targetIndex] = target;
      changed = true;
    }
  }
  return changed ? next : messages;
}

export function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: { truncated: true, reason: "oversized" },
  };
}

// FORK 2026-08-25 (the architect: "the intermediate thinking gets deleted in the chat") — a message goes
// over the cap because of ONE fat block: a screenshot's base64, or a tool_result carrying a whole
// file. The prose in the same message is a few hundred bytes and is innocent, but the whole-message
// placeholder threw it away with the image, so the narration the user had already READ came back
// from the next chat.history as "[chat.history omitted: message too large]".
//
// That is a deletion, not a truncation, and the client cannot undo it: a frozen streamed bubble
// carries no CLIENT_ONLY flag (tinker-ui msg-order.ts), so `loadChat`'s `messages = incoming`
// replaces the good on-screen copy with the stub. The reload is DEFERRED during a live turn and
// fires the moment the turn ends — which is why INTERRUPTING a turn is when the text visibly
// disappears: the interrupt is what ends the turn and releases the swap.
//
// So shrink the BLOCK, not the message. Text blocks are always kept verbatim; only the heavy
// carriers are replaced, each with a stub naming what was dropped. The whole-message placeholder
// survives as the last resort for a message that is still oversized after shrinking (or that is not
// block-shaped at all) — that path is genuinely unrepresentable, and it is now rare.
//
// FORK 2026-08-28 (R3: what the gateway answers must be what the chat shows). The shrink above
// only ran when the message carried prose. A message with NO text block — a lone fat tool_result,
// the commonest shape — still went to the whole-message placeholder, which throws away the block's
// type, its name and its tool_use_id. tinker-ui decides a bubble is renderable from exactly those
// (msgHasVisibleContent keys on tool_use / tool_result), so the tool did not appear truncated: it
// VANISHED. Measured live on the dashboard session, 6 of 428 served messages were such stubs — six
// tool results the architect could never see.
//
// The cap is not the bug and is deliberately unchanged. What changes is that an omitted body now
// degrades to a per-BLOCK stub that keeps the row's identity and states how many bytes were left
// out, so truncation stays but becomes visible and structured instead of destroying the record.

/** Heavy carriers that are NOT tool rows; tool block types match via isToolHistoryBlockType. */
const OVERSIZED_BLOCK_KINDS = new Set(["image"]);

/** Identity keys a stub must carry, or the UI cannot pair the row with the call that made it. */
const OVERSIZED_BLOCK_IDENTITY_KEYS = [
  "id",
  "tool_use_id",
  "toolUseId",
  "tool_call_id",
  "toolCallId",
  "name",
  "tool_name",
  "toolName",
] as const;

// Every spelling the transcript uses (tool_use / tooluse / toolcall / tool_result / toolResult …)
// behind one predicate, instead of a hand-maintained casing list that silently misses one.
function isOversizedDroppableBlockKind(kind: string): boolean {
  return isToolHistoryBlockType(kind) || OVERSIZED_BLOCK_KINDS.has(kind.trim().toLowerCase());
}

/**
 * Per-block replacement for a carrier that blew the cap: keeps the block's own `type` and every
 * identity key it carries, and states the byte size of the body that was left out. The row still
 * renders, and the omission is legible instead of invisible.
 */
function buildOmittedBlockStub(block: unknown, bytes: number): Record<string, unknown> {
  const rec = (block && typeof block === "object" ? block : {}) as Record<string, unknown>;
  const kind = typeof rec.type === "string" && rec.type.trim() ? rec.type : "content";
  const note = `[${kind} omitted: ${bytes} bytes]`;
  const omission = { omitted: true, reason: "oversized", bytes };
  if (!isToolHistoryBlockType(kind)) {
    // A screenshot stripped of its base64 is not renderable as an image, so a non-tool carrier
    // still degrades to a text marker — but the marker now says how much was left out.
    const marker: Record<string, unknown> = { type: "text", text: note, __openclaw: omission };
    const id = rec.tool_use_id;
    if (typeof id === "string" && id) {
      marker.tool_use_id = id;
    }
    return marker;
  }
  const stub: Record<string, unknown> = { type: kind };
  for (const key of OVERSIZED_BLOCK_IDENTITY_KEYS) {
    const value = rec[key];
    if (typeof value === "string" && value) {
      stub[key] = value;
    }
  }
  if (typeof rec.is_error === "boolean") {
    stub.is_error = rec.is_error;
  }
  // tinker-ui renders a tool_result body from a STRING `content` and a tool_use's arguments from
  // `input`, so put the note where the block's own shape expects to find its body.
  stub.content = note;
  if (rec.input !== undefined) {
    stub.input = { omitted: note };
  }
  stub.__openclaw = omission;
  return stub;
}

function shrinkOversizedBlocks(
  message: unknown,
  maxSingleMessageBytes: number,
): { message: unknown; shrunk: boolean } {
  if (!message || typeof message !== "object") {
    return { message, shrunk: false };
  }
  const rec = message as Record<string, unknown>;
  const content = rec.content;
  if (!Array.isArray(content)) {
    return { message, shrunk: false };
  }
  // FORK 2026-08-28: no `carriesText` gate any more. A message with no prose used to bail out here
  // and lose its whole record to the placeholder; every oversized carrier is now stubbed in place.
  //
  // Biggest blocks first: drop only as many as the cap actually requires, so a message with one
  // huge screenshot and three small ones keeps the three.
  const sized = content.map((block, index) => ({ index, bytes: jsonUtf8Bytes(block) }));
  sized.sort((a, b) => b.bytes - a.bytes);
  const stubs = new Map<number, Record<string, unknown>>();
  let running = jsonUtf8Bytes(message);
  for (const { index, bytes } of sized) {
    if (running <= maxSingleMessageBytes) {
      break;
    }
    const block = content[index] as { type?: unknown } | null;
    const kind = typeof block?.type === "string" ? block.type : "";
    // NEVER a text (or thinking) block. Losing prose is the defect this function exists to stop; a
    // message that is oversized on prose alone falls through to the whole-message placeholder.
    if (!isOversizedDroppableBlockKind(kind)) {
      continue;
    }
    const stub = buildOmittedBlockStub(block, bytes);
    stubs.set(index, stub);
    // Charge the stub against the saving, not just the block against the total: a message built
    // from many mid-sized carriers would otherwise measure under the cap here, fail the re-check in
    // replaceOversizedChatHistoryMessages, and fall back to the whole-message placeholder anyway.
    running -= bytes - jsonUtf8Bytes(stub);
  }
  if (stubs.size === 0) {
    return { message, shrunk: false };
  }
  const nextContent = content.map((block, index) => stubs.get(index) ?? block);
  return {
    message: {
      ...rec,
      content: nextContent,
      __openclaw: {
        ...((rec.__openclaw as Record<string, unknown> | undefined) ?? {}),
        truncated: true,
        reason: "oversized-blocks",
      },
    },
    shrunk: true,
  };
}

export function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  let changed = false;
  const next = messages.map((message) => {
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    const shrunk = shrinkOversizedBlocks(message, maxSingleMessageBytes);
    if (shrunk.shrunk && jsonUtf8Bytes(shrunk.message) <= maxSingleMessageBytes) {
      changed = true;
      return shrunk.message;
    }
    replacedCount += 1;
    changed = true;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: changed ? next : messages, replacedCount };
}

export function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  return { messages: [], placeholderCount: 0 };
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function transcriptHasIdempotencyKey(transcriptPath: string, idempotencyKey: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (parsed?.message?.idempotencyKey === idempotencyKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  return appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    message: params.message,
    label: params.label,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
  });
}

// FORK 2026-07-22 (chat-error-persist): projection of the delivered replies
// that the !agentRunStarted completion path renders + persists. Includes BOTH
// dispatcher kinds:
// - "final": the normal agent reply / fast pre-start failure text
// - "block": command acks delivered via dispatcher.sendBlockReply (e.g.
//   "Model set to claude-code/claude-fable-5." from a /model directive).
//   These were previously filtered out (kind==="final" only) and thus
//   structurally invisible in webchat — proven 2026-07-22 when a /model ack
//   never rendered.
// Exported for tests (chat.error-persistence.test.ts).
export function projectPreRunReplyPayloads(
  deliveredReplies: ReadonlyArray<{ payload: ReplyPayload; kind: "block" | "final" }>,
): ReplyPayload[] {
  return deliveredReplies
    .filter((entry) => entry.kind === "final" || entry.kind === "block")
    .map((entry) => entry.payload);
}

// FORK 2026-07-22 (chat-error-persist): persist only agent-started ERROR
// fallback text (e.g. "⚠️ Agent failed before reply: …" after a mid-run agent
// death) to the session transcript. Successful replies are already persisted
// by the agent runtime; persisting the successful backstop too creates a
// second gateway-injected assistant message. Previously error text was only
// fire-and-forget WS-broadcast: any tab reload / WS reconnect lost it and the
// user saw NOTHING. The persisted text block carries `isError: true` so the UI
// can render the bubble red on reload.
// Exported for tests (chat.error-persistence.test.ts).
export function persistAgentStartedFallbackReply(params: {
  sessionKey: string;
  clientRunId: string;
  agentId?: string;
  fallbackText: string;
  isError?: boolean;
  logWarn?: (message: string) => void;
}): TranscriptAppendResult | undefined {
  const trimmed = params.fallbackText.trim();
  if (params.isError !== true || !trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
    return undefined;
  }
  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(params.sessionKey);
  const sessionId = latestEntry?.sessionId ?? params.clientRunId;
  const appended = appendAssistantTranscriptMessage({
    message: trimmed,
    content: [{ type: "text", text: trimmed, isError: true }],
    sessionId,
    storePath: latestStorePath,
    sessionFile: latestEntry?.sessionFile,
    agentId: params.agentId,
    createIfMissing: true,
    idempotencyKey: `${params.clientRunId}:assistant-final`,
  });
  if (!appended.ok) {
    params.logWarn?.(
      `webchat agent-started fallback transcript append failed: ${appended.error ?? "unknown error"}`,
    );
  }
  return appended;
}

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  runIds: ReadonlySet<string>;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (!params.runIds.has(runId)) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}) {
  if (params.snapshots.length === 0) {
    return;
  }
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  for (const snapshot of params.snapshots) {
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = appendAssistantTranscriptMessage({
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatDeltaSentAt: context.chatDeltaSentAt,
    chatDeltaLastBroadcastLen: context.chatDeltaLastBroadcastLen,
    chatAbortedRuns: context.chatAbortedRuns,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

function normalizeOptionalText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeExplicitChatSendOrigin(
  params: ChatSendExplicitOrigin,
): { ok: true; value?: ChatSendExplicitOrigin } | { ok: false; error: string } {
  const originatingChannel = normalizeOptionalText(params.originatingChannel);
  const originatingTo = normalizeOptionalText(params.originatingTo);
  const accountId = normalizeOptionalText(params.accountId);
  const messageThreadId = normalizeOptionalText(params.messageThreadId);
  const hasAnyExplicitOriginField = Boolean(
    originatingChannel || originatingTo || accountId || messageThreadId,
  );
  if (!hasAnyExplicitOriginField) {
    return { ok: true };
  }
  const normalizedChannel = normalizeMessageChannel(originatingChannel);
  if (!normalizedChannel) {
    return {
      ok: false,
      error: "originatingChannel is required when using originating route fields",
    };
  }
  if (!originatingTo) {
    return {
      ok: false,
      error: "originatingTo is required when using originating route fields",
    };
  }
  return {
    ok: true,
    value: {
      originatingChannel: normalizedChannel,
      originatingTo,
      ...(accountId ? { accountId } : {}),
      ...(messageThreadId ? { messageThreadId } : {}),
    },
  };
}

function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
): ChatAbortRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return {
    connId: normalizeOptionalText(client?.connId),
    deviceId: normalizeOptionalText(client?.connect?.device?.id),
    isAdmin: scopes.includes(ADMIN_SCOPE),
  };
}

function canRequesterAbortChatRun(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  if (!ownerDeviceId && !ownerConnId) {
    return true;
  }
  if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) {
    return true;
  }
  if (ownerConnId && requester.connId && ownerConnId === requester.connId) {
    return true;
  }
  return false;
}

function resolveAuthorizedRunIdsForSession(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  sessionKey: string;
  requester: ChatAbortRequester;
}) {
  const authorizedRunIds: string[] = [];
  let matchedSessionRuns = 0;
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortChatRun(active, params.requester)) {
      authorizedRunIds.push(runId);
    }
  }
  return {
    matchedSessionRuns,
    authorizedRunIds,
  };
}

/**
 * FORK 2026-08-20 (the architect: Stop Grok, it spins again). `chat.abort` used to
 * abort only the in-flight AbortController. The `/stop` text path already
 * drained the followup queue, aborted the embedded runner, and killed
 * children — the UI Stop button never did, so a queued followup or a
 * leftover tool-call started a fresh turn the moment the controller died.
 * Best-effort: abort must never throw.
 */
function settleSessionAfterAbort(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
}): void {
  try {
    const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(params.sessionKey);
    const key = canonicalKey || params.sessionKey;
    const sessionId =
      replyRunRegistry.resolveSessionId(key) ??
      replyRunRegistry.resolveSessionId(params.sessionKey) ??
      entry?.sessionId;
    const abortedRunner =
      replyRunRegistry.abort(key) ||
      (key !== params.sessionKey ? replyRunRegistry.abort(params.sessionKey) : false) ||
      (sessionId ? abortEmbeddedPiRun(sessionId) : false);
    const cleared = clearSessionQueues([key, params.sessionKey, sessionId]);
    let stoppedChildren = 0;
    try {
      stoppedChildren = stopSubagentsForRequester({
        cfg,
        requesterSessionKey: key,
      }).stopped;
    } catch (err) {
      params.context.logGateway.warn(`chat.abort child-stop failed: ${formatErrorMessage(err)}`);
    }
    if (
      abortedRunner ||
      cleared.followupCleared > 0 ||
      cleared.laneCleared > 0 ||
      stoppedChildren > 0
    ) {
      params.context.logGateway.info?.(
        `chat.abort settled ${key} runner=${abortedRunner} followups=${cleared.followupCleared} lane=${cleared.laneCleared} children=${stoppedChildren}`,
      );
    }
    if (storePath && key && entry) {
      void updateSessionStore(
        storePath,
        (store) => {
          const current = store[key];
          if (!current) {
            return;
          }
          current.abortedLastRun = true;
          if (current.status === "running") {
            current.status = "done";
            current.endedAt = Date.now();
          }
          current.updatedAt = Date.now();
        },
        { skipMaintenance: true },
      ).catch((err) => {
        params.context.logGateway.warn(
          `chat.abort could not persist abortedLastRun: ${formatErrorMessage(err)}`,
        );
      });
    }
  } catch (err) {
    params.context.logGateway.warn(`chat.abort session settle failed: ${formatErrorMessage(err)}`);
  }
}

function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
}) {
  const { matchedSessionRuns, authorizedRunIds } = resolveAuthorizedRunIdsForSession({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKey: params.sessionKey,
    requester: params.requester,
  });
  if (authorizedRunIds.length === 0 && matchedSessionRuns > 0) {
    return {
      aborted: false,
      runIds: [],
      unauthorized: true,
    };
  }
  const authorizedRunIdSet = new Set(authorizedRunIds);
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  const runIds: string[] = [];
  for (const runId of authorizedRunIds) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey: params.sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const res = { aborted: runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted) {
    persistAbortedPartials({
      context: params.context,
      sessionKey: params.sessionKey,
      snapshots,
    });
  }
  // Drain even when no live controller matched — a queued followup is how
  // Stop "lands" and then thinking starts again.
  settleSessionAfterAbort({
    context: params.context,
    sessionKey: params.sessionKey,
  });
  return res;
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: projectChatDisplayMessage(params.message),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

function isBtwReplyPayload(payload: ReplyPayload | undefined): payload is ReplyPayload & {
  btw: { question: string };
  text: string;
} {
  return (
    typeof payload?.btw?.question === "string" &&
    payload.btw.question.trim().length > 0 &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0
  );
}

function broadcastSideResult(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  payload: SideResultPayload;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.payload.runId);
  params.context.broadcast("chat.side_result", {
    ...params.payload,
    seq,
  });
  params.context.nodeSendToSession(params.payload.sessionKey, "chat.side_result", {
    ...params.payload,
    seq,
  });
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
  error?: unknown;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  // FORK 2026-06-24 (recoverable-error retry, spec Component 1): mirror the
  // emitChatFinal error path — surface the failover recoverability class as the
  // machine-readable `reason` derived from the raw error (FailoverError.reason
  // or a classified error signal), so the Tinker auto-retry controller does not
  // have to text-match `errorMessage`. `retryAfter` (provider Retry-After) is
  // not attached to the error object at this layer and is intentionally OMITTED.
  // `errorMessage` (human text) is unchanged.
  const failoverReason =
    params.error !== undefined
      ? (resolveFailoverReasonFromError(params.error) ?? undefined)
      : undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
    ...(failoverReason && { reason: failoverReason }),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

// FORK 2026-08-05 (dedup REMOVED — do NOT re-add): a content-based serve-boundary dedup
// (`dedupeServedAssistantAnswers`, added 2026-06-24 for the "repeating answers" bug) used to
// run here. It dropped any assistant message whose normalized text was a strict PREFIX of any
// other assistant message anywhere in the session — earlier OR LATER, because the double loop
// was `for i: for j`, not `j < i` — and additionally dropped the LONGER message whenever it
// ENDED WITH a shorter one. Measured on the real store for agent:main:tinker:ms39dshj it
// deleted 19 of 59 assistant messages (32%), one of them killed by a message 13 positions
// LATER. `loadChat` consumes this result, so that was permanent, silent deletion from screen:
// a genuine short answer is legitimately a prefix of a longer later answer all the time.
//
// Chat history is now served VERBATIM and IN ORDER; nothing is dropped on content. The
// duplicate text it was papering over is fixed at its SOURCE instead:
//   - live streaming duplicates → the buffer-replace signal in src/gateway/server-chat.ts
//     (`isLiveChatBufferReplaced` + the `replace: true` field on chat delta events)
//   - abort echoes → `suppressSupersededAbortEchoes` (chat-display-projection.ts), which stays:
//     it is narrowly keyed on the openclawAbort marker, not on free-text similarity
// Known consequence (accepted, tracked separately): answers re-persisted across a cc-bridge
// respawn/compaction — same text, different id/parentId — are no longer hidden here. That is a
// persistence/merge-layer defect and belongs in augmentChatHistoryWithCliSessionImports /
// cli-session-history.merge.ts, not in a lossy filter at the serve boundary.
// Contract pinned by chat.dedup.test.ts.

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit, maxChars } = params as {
      sessionKey: string;
      limit?: number;
      maxChars?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const localMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const rawMessages = augmentChatHistoryWithCliSessionImports({
      entry,
      // Attribution for the flood-valve warn ONLY (never affects what is served). Without it the
      // valve logs entry.sessionId — a raw UUID that cannot be joined against the [duprep-history]
      // line below, which keys on sessionKey. The two must name the same thing to be readable
      // together, and they are the only diagnostics for this path.
      sessionKey,
      provider: resolvedSessionModel.provider,
      localMessages,
    });
    // FORK 2026-05-26 (task-mpkw1a0b-9jsfy): chat.history instrumentation
    // for the "user prompt appears twice on hard refresh" bug. Counts the
    // sources merged here so next reproduction tells us which layer
    // duplicated. Tag "[duprep-history]" for grep. localMessages = what
    // the OpenClaw sessionFile holds. rawMessages = after the cli-session
    // imports merge (binding + tinker-bridge-map chained per the orphan fix
    // a1b7819258). If rawMessages.user-count > localMessages.user-count
    // by more than the legitimate gap, the merge dedup is missing a case.
    const countUser = (msgs: unknown[]): number =>
      msgs.filter(
        (m) => m != null && typeof m === "object" && (m as { role?: unknown }).role === "user",
      ).length;
    const lastUserText = (msgs: unknown[]): string => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && typeof m === "object" && (m as { role?: unknown }).role === "user") {
          const content = (m as { content?: unknown }).content;
          if (typeof content === "string") {
            return content.replace(/\n/g, "↵").slice(0, 80);
          }
          if (Array.isArray(content)) {
            const txt = content
              .map((b: unknown) =>
                b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
                  ? ((b as { text: string }).text as string)
                  : "",
              )
              .join("");
            return txt.replace(/\n/g, "↵").slice(0, 80);
          }
          break;
        }
      }
      return "";
    };
    const localUsers = countUser(localMessages);
    const rawUsers = countUser(rawMessages);
    if (rawUsers > localUsers || rawUsers >= 2) {
      // FORK 2026-08-26 (duprep source diagnostics): name the SOURCE of the import on this
      // SAME line. The counts alone say "the merge added user rows" without saying WHICH
      // claude-code transcript they came from or how big it had grown — and the 8 MB
      // oversized-resume guard rebinds a tab to a FRESH transcript mid-day (it fired 3x on
      // 2026-08-26), which silently changes the answer every other field here reports.
      // Without the id, a rebind and a merge regression are indistinguishable in the log.
      //
      // Re-resolved from the SAME `entry` the augment call above used (both default homeDir),
      // because augmentChatHistoryWithCliSessionImports does not return what it read.
      // Provenance is a LIST, not a scalar: the binding id and the tinker-bridge-map id are
      // chained (orphan fix a1b7819258) and the merge reads BOTH, so a single-valued field
      // would hide exactly the second source this exists to expose. `cliSessionId` and
      // `cliTranscriptBytes` are therefore comma-joined and INDEX-ALIGNED. `none` — never
      // `0` — for "no id recorded" and for "id recorded but no readable .jsonl", so neither
      // can ever be misread as an empty transcript.
      //
      // Cost/safety: resolveClaudeCliProvenanceSessionIds already ran unconditionally in the
      // augment call above, so this adds no new throw class; resolveClaudeCliSessionFilePath
      // swallows its own readdir failure and the statSync is guarded. The readdir+stat is
      // negligible beside the full .jsonl read that same call already performed, but it is
      // kept INSIDE the log gate regardless so unlogged chat.history calls pay nothing.
      const importedCliSessionIds = resolveClaudeCliProvenanceSessionIds({ entry });
      const importedCliTranscriptBytes = importedCliSessionIds.map((cliSessionId) => {
        const transcriptPath = resolveClaudeCliSessionFilePath({ cliSessionId });
        if (!transcriptPath) {
          return "none";
        }
        try {
          return String(fs.statSync(transcriptPath).size);
        } catch {
          return "none";
        }
      });
      context.logGateway.info(
        `[duprep-history] sessionKey=${sessionKey} local.total=${localMessages.length} local.user=${localUsers} raw.total=${rawMessages.length} raw.user=${rawUsers} lastLocalUser=${JSON.stringify(lastUserText(localMessages))} lastRawUser=${JSON.stringify(lastUserText(rawMessages))} cliSessionId=${importedCliSessionIds.join(",") || "none"} cliTranscriptBytes=${importedCliTranscriptBytes.join(",") || "none"}`,
      );
    }
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
    // FORK 2026-08-05: served VERBATIM — no content-based dedup pass. See the tombstone
    // comment above `chatHandlers` for what was removed and why.
    const normalized = augmentChatHistoryWithCanvasBlocks(
      projectRecentChatDisplayMessages(rawMessages, {
        maxChars: effectiveMaxChars,
        maxMessages: max,
      }),
    );
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = replaceOversizedChatHistoryMessages({
      messages: normalized,
      maxSingleMessageBytes: perMessageHardCap,
    });
    scheduleChatHistoryManagedImageCleanup({ sessionKey, context });
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
    if (placeholderCount > 0) {
      chatHistoryPlaceholderEmitCount += placeholderCount;
      logLargePayload({
        surface: "gateway.chat.history",
        action: "truncated",
        bytes: jsonUtf8Bytes(normalized),
        limitBytes: maxHistoryBytes,
        count: placeholderCount,
        reason: "chat_history_budget",
      });
      context.logGateway.debug(
        `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
      );
    }
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const loadedCatalog = await context.loadGatewayModelCatalog().catch(() => undefined);
      const modelCatalog = Array.isArray(loadedCatalog) ? loadedCatalog : undefined;
      thinkingLevel = resolveGatewaySessionThinkingDefault({
        cfg,
        agentId: sessionAgentId,
        provider: resolvedSessionModel.provider,
        model: resolvedSessionModel.model,
        modelCatalog,
      });
    }
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    respond(true, {
      sessionKey,
      sessionId,
      messages: bounded.messages,
      thinkingLevel,
      fastMode: entry?.fastMode,
      verboseLevel,
    });
  },
  "chat.abort": ({ params, respond, context, client }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = createChatAbortOps(context);
    const requester = resolveChatAbortRequester(client);

    if (!runId) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: rawSessionKey,
        abortOrigin: "rpc",
        stopReason: "rpc",
        requester,
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== rawSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }
    if (!canRequesterAbortChatRun(active, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: rawSessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && partialText && partialText.trim()) {
      persistAbortedPartials({
        context,
        sessionKey: rawSessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            text: partialText,
            abortOrigin: "rpc",
          },
        ],
      });
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      model?: string;
      deliver?: boolean;
      dispatchAgent?: boolean;
      originatingChannel?: string;
      originatingTo?: string;
      originatingAccountId?: string;
      originatingThreadId?: string;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      systemInputProvenance?: InputProvenance;
      systemProvenanceReceipt?: string;
      idempotencyKey: string;
    };
    const explicitOriginResult = normalizeExplicitChatSendOrigin({
      originatingChannel: p.originatingChannel,
      originatingTo: p.originatingTo,
      accountId: p.originatingAccountId,
      messageThreadId: p.originatingThreadId,
    });
    if (!explicitOriginResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, explicitOriginResult.error));
      return;
    }
    if (
      (p.systemInputProvenance || p.systemProvenanceReceipt || explicitOriginResult.value) &&
      !canInjectSystemProvenance(client)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          p.systemInputProvenance || p.systemProvenanceReceipt
            ? "system provenance fields require admin scope"
            : "originating route fields require admin scope",
        ),
      );
      return;
    }
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
    if (!systemReceiptResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, systemReceiptResult.error));
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
    const systemProvenanceReceipt = systemReceiptResult.receipt;
    const stopCommand = isChatStopCommandText(inboundMessage);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    const rawSessionKey = p.sessionKey;
    const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, sessionKey);
    if (deletedAgentId !== null) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${deletedAgentId}" no longer exists in configuration`,
        ),
      );
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
    });
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    let imageOrder: PromptImageOrderEntry[] = [];
    let offloadedRefs: OffloadedRef[] = [];
    let mediaPathOffloadPaths: string[] = [];
    let mediaPathOffloadTypes: string[] = [];
    let mediaPathOffloadWorkspaceDir: string | undefined;
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        abortOrigin: "stop-command",
        stopReason: "stop",
        requester: resolveChatAbortRequester(client),
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(
      explicitOriginResult.value,
    );
    if (normalizedAttachments.length > 0) {
      const modelRef = resolveSessionModelRef(cfg, entry, agentId);
      const supportsSessionModelImages = await resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        provider: modelRef.provider,
        model: modelRef.model,
      });
      // Bound plugin sessions own the real recipient model, so keep image
      // attachments even when the parent OpenClaw session model is text-only.
      const supportsImages =
        supportsSessionModelImages ||
        explicitOriginTargetsAcpSession(explicitOriginResult.value) ||
        explicitOriginTargetsPlugin;
      const routeImageOffloadsAsMediaPaths = !supportsImages;
      try {
        const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
          maxBytes: resolveChatAttachmentMaxBytes(cfg),
          log: context.logGateway,
          supportsImages,
          // chat.send routes selected offloadedRefs into ctx.MediaPaths below
          // so the auto-reply stage pipeline can surface them to the agent.
          acceptNonImage: true,
        });
        parsedMessage = stripTrailingOffloadedMediaMarkers(
          parsed.message,
          routeImageOffloadsAsMediaPaths
            ? parsed.offloadedRefs.filter((ref) => ref.mimeType.startsWith("image/"))
            : [],
        );
        parsedImages = parsed.images;
        imageOrder = routeImageOffloadsAsMediaPaths ? [] : parsed.imageOrder;
        offloadedRefs = parsed.offloadedRefs;
        ({
          paths: mediaPathOffloadPaths,
          types: mediaPathOffloadTypes,
          workspaceDir: mediaPathOffloadWorkspaceDir,
        } = await prestageMediaPathOffloads({
          offloadedRefs,
          // Text-only image offloads need ctx.MediaPaths so media-understanding
          // can describe them via agents.defaults.imageModel. Vision-capable
          // image offloads stay as prompt refs for native image loading.
          includeImageRefs: routeImageOffloadsAsMediaPaths,
          cfg,
          sessionKey,
          agentId,
        }));
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(err),
          ),
        );
        return;
      }
    }

    try {
      const activeRunAbort = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: clientRunId,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: rawSessionKey,
        timeoutMs,
        now,
        ownerConnId: normalizeOptionalText(client?.connId),
        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
        kind: "chat-send",
      });
      if (!activeRunAbort.registered) {
        respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      context.addChatRun(clientRunId, {
        sessionKey,
        clientRunId,
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });
      // dispatchAgent:false short-circuits everything past the synchronous
      // ack — no transcript write, no agent dispatch, no chat broadcasts.
      // Lets bible invariant probes verify "dispatch path alive" without
      // polluting the user's webchat session. See flows.md F1.
      if (p.dispatchAgent === false) {
        return;
      }
      const persistedImagesPromise = persistChatSendImages({
        images: parsedImages,
        imageOrder,
        offloadedRefs,
        client,
        logGateway: context.logGateway,
      });
      const pluginBoundMediaFields =
        explicitOriginTargetsPlugin && parsedImages.length > 0
          ? resolveChatSendTranscriptMediaFields(await persistedImagesPromise)
          : {};

      const commandBody = buildChatSendCommandBody({
        message: parsedMessage,
        thinking: p.thinking,
        model: p.model,
      });
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const clientInfo = client?.connect?.client;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = resolveChatSendOriginatingRoute({
        client: clientInfo,
        deliver: p.deliver,
        entry,
        explicitOrigin: explicitOriginResult.value,
        hasConnectedClient: client?.connect !== undefined,
        mainKey: cfg.session?.mainKey,
        sessionKey,
      });
      // Inject timestamp so agents know the current date/time.
      // Only BodyForAgent gets the timestamp — Body stays raw for UI display.
      // See: https://github.com/moltbot/moltbot/issues/3658
      const stampedMessage = injectTimestamp(messageForAgent, timestampOptsFromConfig(cfg));

      const ctx: MsgContext = {
        Body: messageForAgent,
        BodyForAgent: stampedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        InputProvenance: systemInputProvenance,
        SessionKey: sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
        GatewayClientScopes: client?.connect?.scopes ?? [],
        ...pluginBoundMediaFields,
      };
      if (mediaPathOffloadPaths.length > 0) {
        // Inject offloads via the same MsgContext fields the channel
        // path uses so buildInboundMediaNote renders a real `[media attached:
        // <workspace-relative-path>]` line into the agent prompt. Marker
        // blocks the dispatch pipeline from re-running stageSandboxMedia; see
        // prestageMediaPathOffloads.
        ctx.MediaPath = mediaPathOffloadPaths[0];
        ctx.MediaPaths = mediaPathOffloadPaths;
        ctx.MediaType = mediaPathOffloadTypes[0];
        ctx.MediaTypes = mediaPathOffloadTypes;
        ctx.MediaWorkspaceDir = mediaPathOffloadWorkspaceDir;
        ctx.MediaStaged = true;
      }

      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const deliveredReplies: Array<{ payload: ReplyPayload; kind: "block" | "final" }> = [];
      let appendedWebchatAgentMedia = false;
      let userTranscriptUpdatePromise: Promise<void> | null = null;
      const emitUserTranscriptUpdate = async () => {
        if (userTranscriptUpdatePromise) {
          await userTranscriptUpdatePromise;
          return;
        }
        userTranscriptUpdatePromise = (async () => {
          const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
          const resolvedSessionId = latestEntry?.sessionId ?? entry?.sessionId;
          if (!resolvedSessionId) {
            return;
          }
          const transcriptPath = resolveTranscriptPath({
            sessionId: resolvedSessionId,
            storePath: latestStorePath,
            sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
            agentId,
          });
          if (!transcriptPath) {
            return;
          }
          const persistedImages = await persistedImagesPromise;
          emitSessionTranscriptUpdate({
            sessionFile: transcriptPath,
            sessionKey,
            message: buildChatSendTranscriptMessage({
              message: parsedMessage,
              savedImages: persistedImages,
              timestamp: now,
              idempotencyKey: clientRunId,
            }),
          });
        })();
        await userTranscriptUpdatePromise;
      };
      let transcriptMediaRewriteDone = false;
      const rewriteUserTranscriptMedia = async () => {
        if (transcriptMediaRewriteDone) {
          return;
        }
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
        const resolvedSessionId = latestEntry?.sessionId ?? entry?.sessionId;
        if (!resolvedSessionId) {
          return;
        }
        const transcriptPath = resolveTranscriptPath({
          sessionId: resolvedSessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
          agentId,
        });
        if (!transcriptPath) {
          return;
        }
        transcriptMediaRewriteDone = true;
        await rewriteChatSendUserTurnMediaPaths({
          transcriptPath,
          sessionKey,
          message: parsedMessage,
          savedImages: await persistedImagesPromise,
        });
      };
      const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
        if (!agentRunStarted || appendedWebchatAgentMedia || !isMediaBearingPayload(payload)) {
          return;
        }
        const transcriptPayload = stripVisibleTextFromTtsSupplement(payload);
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
        const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
        const resolvedTranscriptPath = resolveTranscriptPath({
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
          agentId,
        });
        const mediaLocalRoots = appendLocalMediaParentRoots(
          getAgentScopedMediaLocalRoots(cfg, agentId),
          resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
        );
        const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
          sessionKey,
          payloads: [transcriptPayload],
          managedImageLocalRoots: mediaLocalRoots,
          includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
          onManagedImagePrepareError: (message) => {
            context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
          },
        });
        const mediaMessage = await buildWebchatAssistantMediaMessage([transcriptPayload], {
          localRoots: mediaLocalRoots,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
        });
        const persistedAssistantContent = replaceAssistantContentTextBlocks(
          assistantContent,
          mediaMessage,
        );
        const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent)
          ? persistedAssistantContent
          : undefined;
        const transcriptReply =
          mediaMessage?.transcriptText ??
          extractAssistantDisplayTextFromContent(assistantContent) ??
          buildTranscriptReplyText([transcriptPayload]);
        if (!transcriptReply && !persistedAssistantContent?.length && !assistantContent?.length) {
          return;
        }
        const appended = appendAssistantTranscriptMessage({
          message: transcriptReply,
          ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile,
          agentId,
          createIfMissing: true,
          idempotencyKey: `${clientRunId}:assistant-media`,
        });
        if (appended.ok) {
          if (appended.messageId && assistantContent?.length) {
            await attachManagedOutgoingImagesToMessage({
              messageId: appended.messageId,
              blocks: assistantContent,
            });
          }
          appendedWebchatAgentMedia = true;
          return;
        }
        context.logGateway.warn(
          `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
        );
      };
      const dispatcher = createReplyDispatcher({
        ...replyPipeline,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          switch (info.kind) {
            case "block":
            case "final":
              deliveredReplies.push({ payload, kind: info.kind });
              await appendWebchatAgentMediaTranscriptIfNeeded(payload);
              break;
            case "tool":
              // Tool results that carry audio (e.g. the TTS tool) must be promoted
              // to "final" so the downstream audio extraction path can pick them up.
              // Strip text to avoid leaking tool summary into the combined reply.
              if (isMediaBearingPayload(payload)) {
                deliveredReplies.push({
                  payload: { ...payload, text: undefined },
                  kind: "final",
                });
              }
              break;
          }
        },
      });

      // Surface accepted inbound turns immediately so transcript subscribers
      // (gateway watchers, MCP bridges, external channel backends) do not wait
      // on model startup, completion, or failure paths before seeing the user turn.
      void emitUserTranscriptUpdate().catch((transcriptErr) => {
        context.logGateway.warn(
          `webchat eager user transcript update failed: ${formatForLog(transcriptErr)}`,
        );
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: activeRunAbort.controller.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
          onAgentRunStart: (runId) => {
            agentRunStarted = true;
            void emitUserTranscriptUpdate();
            const connId = typeof client?.connId === "string" ? client.connId : undefined;
            const wantsToolEvents = hasGatewayClientCap(
              client?.connect?.caps,
              GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
            );
            if (connId && wantsToolEvents) {
              context.registerToolEventRecipient(runId, connId);
              // Register for any other active runs *in the same session* so
              // late-joining clients (e.g. page refresh mid-response) receive
              // in-progress tool events without leaking cross-session data.
              for (const [activeRunId, active] of context.chatAbortControllers) {
                if (activeRunId !== runId && active.sessionKey === p.sessionKey) {
                  context.registerToolEventRecipient(activeRunId, connId);
                }
              }
            }
          },
          onModelSelected,
        },
      })
        .then(async () => {
          await rewriteUserTranscriptMedia();
          if (!agentRunStarted) {
            await emitUserTranscriptUpdate();
            const btwReplies = deliveredReplies
              .map((entry) => entry.payload)
              .filter(isBtwReplyPayload);
            const btwText = btwReplies
              .map((payload) => payload.text.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            if (btwReplies.length > 0 && btwText) {
              broadcastSideResult({
                context,
                payload: {
                  kind: "btw",
                  runId: clientRunId,
                  sessionKey,
                  question: btwReplies[0].btw.question.trim(),
                  text: btwText,
                  isError: btwReplies.some((payload) => payload.isError),
                  ts: Date.now(),
                },
              });
              broadcastChatFinal({
                context,
                runId: clientRunId,
                sessionKey,
              });
            } else {
              // FORK 2026-07-22 (chat-error-persist): include "block" acks too —
              // see projectPreRunReplyPayloads.
              const finalPayloads = appendedWebchatAgentMedia
                ? []
                : projectPreRunReplyPayloads(deliveredReplies);
              const { storePath: latestStorePath, entry: latestEntry } =
                loadSessionEntry(sessionKey);
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const resolvedTranscriptPath = resolveTranscriptPath({
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
                agentId,
              });
              const mediaLocalRoots = appendLocalMediaParentRoots(
                getAgentScopedMediaLocalRoots(cfg, agentId),
                resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
              );
              const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
                sessionKey,
                payloads: finalPayloads,
                managedImageLocalRoots: mediaLocalRoots,
                includeSensitiveMedia: false,
                onLocalAudioAccessDenied: (message) => {
                  context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
                },
                onManagedImagePrepareError: (message) => {
                  context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
                },
              });
              const mediaMessage = await buildWebchatAssistantMediaMessage(finalPayloads, {
                localRoots: mediaLocalRoots,
                onLocalAudioAccessDenied: (message) => {
                  context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
                },
              });
              const hasSensitiveMedia = hasSensitiveMediaPayload(finalPayloads);
              const persistedAssistantContent = replaceAssistantContentTextBlocks(
                hasSensitiveMedia
                  ? await buildAssistantDisplayContentFromReplyPayloads({
                      sessionKey,
                      payloads: finalPayloads,
                      managedImageLocalRoots: mediaLocalRoots,
                      includeSensitiveMedia: false,
                      onLocalAudioAccessDenied: (message) => {
                        context.logGateway.warn(
                          `webchat audio embedding denied local path: ${message}`,
                        );
                      },
                      onManagedImagePrepareError: (message) => {
                        context.logGateway.warn(
                          `webchat image embedding skipped attachment: ${message}`,
                        );
                      },
                    })
                  : assistantContent,
                mediaMessage,
              );
              const persistedContentForAppend = hasAssistantDisplayMediaContent(
                persistedAssistantContent,
              )
                ? persistedAssistantContent
                : undefined;
              const broadcastAssistantContent = hasAssistantDisplayMediaContent(assistantContent)
                ? assistantContent
                : hasAssistantDisplayMediaContent(mediaMessage?.content)
                  ? mediaMessage?.content
                  : assistantContent;
              const displayReply =
                extractAssistantDisplayTextFromContent(assistantContent) ??
                buildTranscriptReplyText(finalPayloads);
              const transcriptReply =
                mediaMessage?.transcriptText ||
                buildTranscriptReplyText(finalPayloads) ||
                displayReply;
              let message: Record<string, unknown> | undefined;
              if (
                transcriptReply ||
                persistedContentForAppend?.length ||
                assistantContent?.length
              ) {
                const appended = appendAssistantTranscriptMessage({
                  message: transcriptReply,
                  ...(persistedContentForAppend?.length
                    ? { content: persistedContentForAppend }
                    : {}),
                  sessionId,
                  storePath: latestStorePath,
                  sessionFile: latestEntry?.sessionFile,
                  agentId,
                  createIfMissing: true,
                });
                if (appended.ok) {
                  if (appended.messageId && assistantContent?.length) {
                    await attachManagedOutgoingImagesToMessage({
                      messageId: appended.messageId,
                      blocks: assistantContent,
                    });
                  }
                  message = broadcastAssistantContent?.length
                    ? { ...appended.message, content: broadcastAssistantContent }
                    : appended.message;
                } else {
                  context.logGateway.warn(
                    `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                  );
                  const fallbackAssistantContent =
                    stripManagedOutgoingAssistantContentBlocks(persistedAssistantContent) ??
                    stripManagedOutgoingAssistantContentBlocks(assistantContent);
                  const fallbackText =
                    extractAssistantDisplayText(fallbackAssistantContent) ?? displayReply;
                  const now = Date.now();
                  message = {
                    role: "assistant",
                    ...(fallbackAssistantContent?.length
                      ? { content: fallbackAssistantContent }
                      : fallbackText
                        ? { content: [{ type: "text", text: fallbackText }] }
                        : {}),
                    ...(fallbackText ? { text: fallbackText } : {}),
                    timestamp: now,
                    // Keep this compatible with Pi stopReason enums even though this message isn't
                    // persisted to the transcript due to the append failure.
                    stopReason: "stop",
                    usage: { input: 0, output: 0, totalTokens: 0 },
                  };
                }
              }
              broadcastChatFinal({
                context,
                runId: clientRunId,
                sessionKey,
                message,
              });
            }
          } else {
            void emitUserTranscriptUpdate();
            // FORK 2026-05-10: backstop broadcastChatFinal for agent-started
            // runs. The normal completion path is the agent-runtime lifecycle
            // event (`emitChatFinal` in `server-chat.ts`), which fires on
            // `lifecyclePhase=done` or `=error`. If that lifecycle event is
            // dropped (e.g. control UI not visible flag, error envelope
            // surfacing without the lifecycle hook firing, surface_error
            // timeout where the run "completed" without throwing), the TUI
            // spinner stays on `sending...` forever — this is exactly the
            // 16:59:34 stuck-spinner symptom we hit when the tinker-bridge LLM
            // idle watchdog SIGTERMed.
            // The backstop emits state="final" with whatever the dispatcher
            // actually delivered (deliveredReplies). The spinner clears
            // either way; if the lifecycle event already fired the client
            // de-dupes by runId+state. If `deliveredReplies` is empty we
            // still broadcast `final` with no message so the spinner clears.
            // The agentRunSeq is delete()-d inside broadcastChatFinal so
            // subsequent late events for this runId become no-ops.
            const finalPayloads = deliveredReplies
              .filter((entry) => entry.kind === "final")
              .map((entry) => entry.payload);
            const fallbackText =
              finalPayloads
                .map((p) => (typeof p?.text === "string" ? p.text.trim() : ""))
                .filter(Boolean)
                .join("\n\n") || undefined;
            // FORK 2026-07-22 (chat-error-persist): optional error flag set by
            // agent-runner-execution on failure payloads (sibling change —
            // optional chaining so this compiles standalone). Propagated on the
            // broadcast message AND the persisted transcript entry so the UI
            // can render the bubble red, live and after reload.
            const fallbackIsError = finalPayloads.some((p) => p?.isError === true);
            const fallbackMessage = fallbackText
              ? {
                  role: "assistant",
                  content: [{ type: "text", text: fallbackText }],
                  text: fallbackText,
                  timestamp: Date.now(),
                  stopReason: "stop",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                  ...(fallbackIsError ? { isError: true } : {}),
                }
              : undefined;
            // FORK 2026-07-22 (chat-error-persist): ALSO persist the backstop
            // ERROR text. A mid-run agent death ("⚠️ Agent failed before
            // reply: …") was broadcast-only here, so any tab reload / WS
            // reconnect showed NOTHING. Successful replies are already
            // persisted by the agent runtime; persisting the successful
            // backstop here creates a duplicate assistant transcript entry.
            if (
              fallbackIsError &&
              fallbackText &&
              !isSilentReplyText(fallbackText, SILENT_REPLY_TOKEN)
            ) {
              persistAgentStartedFallbackReply({
                sessionKey,
                clientRunId,
                agentId,
                fallbackText,
                isError: fallbackIsError,
                logWarn: (message) => context.logGateway.warn(message),
              });
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey,
              ...(fallbackMessage ? { message: fallbackMessage } : {}),
            });
          }
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            },
          });
        })
        .catch((err) => {
          void rewriteUserTranscriptMedia().catch((rewriteErr) => {
            context.logGateway.warn(
              `webchat transcript media rewrite failed after error: ${formatForLog(rewriteErr)}`,
            );
          });
          void emitUserTranscriptUpdate().catch((transcriptErr) => {
            context.logGateway.warn(
              `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
            );
          });
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(err),
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey,
            errorMessage: String(err),
            error: err,
          });
        })
        .finally(() => {
          activeRunAbort.cleanup();
          context.removeChatRun(clientRunId, clientRunId, sessionKey);
        });
    } catch (err) {
      context.chatAbortControllers.delete(clientRunId);
      context.removeChatRun(clientRunId, clientRunId, sessionKey);
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    const appended = appendAssistantTranscriptMessage({
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: resolveSessionAgentId({ sessionKey, config: cfg }),
      createIfMissing: true,
    });
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const message = projectChatDisplayMessage(appended.message, {
      maxChars: resolveEffectiveChatHistoryMaxChars(cfg),
    });
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(sessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
