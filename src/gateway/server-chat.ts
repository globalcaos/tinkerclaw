import fs from "node:fs";
import path from "node:path";
import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionFilePath } from "../config/sessions.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { detectErrorKind, type ErrorKind } from "../infra/errors.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import {
  normalizeLiveAssistantEventText,
  projectLiveAssistantBufferedText,
  resolveMergedAssistantText,
  shouldSuppressAssistantEventForLiveChat,
} from "./live-chat-projector.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";
import { persistGatewaySessionLifecycleEvent } from "./server-chat.persist-session-lifecycle.runtime.js";
import { appendInjectedAssistantMessageToTranscript } from "./server-methods/chat-transcript-inject.js";
import { deriveGatewaySessionLifecycleSnapshot } from "./session-lifecycle-state.js";
import { loadSessionEntry, resolveSessionModelRef } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = getRuntimeConfig();
    return Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}

function resolveHeartbeatContext(runId: string, sourceRunId?: string) {
  const primary = getAgentRunContext(runId);
  if (primary?.isHeartbeat) {
    return primary;
  }
  if (sourceRunId && sourceRunId !== runId) {
    const source = getAgentRunContext(sourceRunId);
    if (source?.isHeartbeat) {
      return source;
    }
  }
  return primary;
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
function shouldHideHeartbeatChatOutput(runId: string, sourceRunId?: string): boolean {
  const runContext = resolveHeartbeatContext(runId, sourceRunId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = getRuntimeConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: resolveHeartbeatAckMaxChars(),
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  rawBuffers: Map<string, string>;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  /** Length of text at the time of the last broadcast, used to avoid duplicate flushes. */
  deltaLastBroadcastLen: Map<string, number>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const rawBuffers = new Map<string, string>();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const deltaLastBroadcastLen = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    rawBuffers.clear();
    buffers.clear();
    deltaSentAt.clear();
    deltaLastBroadcastLen.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    rawBuffers,
    buffers,
    deltaSentAt,
    deltaLastBroadcastLen,
    abortedRuns,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

export type SessionEventSubscriberRegistry = {
  subscribe: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  getAll: () => ReadonlySet<string>;
  clear: () => void;
};

export type SessionMessageSubscriberRegistry = {
  subscribe: (connId: string, sessionKey: string) => void;
  unsubscribe: (connId: string, sessionKey: string) => void;
  unsubscribeAll: (connId: string) => void;
  get: (sessionKey: string) => ReadonlySet<string>;
  clear: () => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;
/**
 * Keep this aligned with the agent.wait lifecycle-error grace so chat surfaces
 * do not finalize a run before fallback or retry reuses the same runId.
 */
const AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;

export function createSessionEventSubscriberRegistry(): SessionEventSubscriberRegistry {
  const connIds = new Set<string>();
  const empty = new Set<string>();

  return {
    subscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      connIds.add(normalized);
    },
    unsubscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      connIds.delete(normalized);
    },
    getAll: () => (connIds.size > 0 ? connIds : empty),
    clear: () => {
      connIds.clear();
    },
  };
}

export function createSessionMessageSubscriberRegistry(): SessionMessageSubscriberRegistry {
  const sessionToConnIds = new Map<string, Set<string>>();
  const connToSessionKeys = new Map<string, Set<string>>();
  const empty = new Set<string>();

  const normalize = (value: string): string => value.trim();

  return {
    subscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      const connIds = sessionToConnIds.get(normalizedSessionKey) ?? new Set<string>();
      connIds.add(normalizedConnId);
      sessionToConnIds.set(normalizedSessionKey, connIds);

      const sessionKeys = connToSessionKeys.get(normalizedConnId) ?? new Set<string>();
      sessionKeys.add(normalizedSessionKey);
      connToSessionKeys.set(normalizedConnId, sessionKeys);
    },
    unsubscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      const connIds = sessionToConnIds.get(normalizedSessionKey);
      if (connIds) {
        connIds.delete(normalizedConnId);
        if (connIds.size === 0) {
          sessionToConnIds.delete(normalizedSessionKey);
        }
      }
      const sessionKeys = connToSessionKeys.get(normalizedConnId);
      if (sessionKeys) {
        sessionKeys.delete(normalizedSessionKey);
        if (sessionKeys.size === 0) {
          connToSessionKeys.delete(normalizedConnId);
        }
      }
    },
    unsubscribeAll: (connId: string) => {
      const normalizedConnId = normalize(connId);
      if (!normalizedConnId) {
        return;
      }
      const sessionKeys = connToSessionKeys.get(normalizedConnId);
      if (!sessionKeys) {
        return;
      }
      for (const sessionKey of sessionKeys) {
        const connIds = sessionToConnIds.get(sessionKey);
        if (!connIds) {
          continue;
        }
        connIds.delete(normalizedConnId);
        if (connIds.size === 0) {
          sessionToConnIds.delete(sessionKey);
        }
      }
      connToSessionKeys.delete(normalizedConnId);
    },
    get: (sessionKey: string) => {
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedSessionKey) {
        return empty;
      }
      return sessionToConnIds.get(normalizedSessionKey) ?? empty;
    },
    clear: () => {
      sessionToConnIds.clear();
      connToSessionKeys.clear();
    },
  };
}

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

const CHAT_ERROR_KINDS = new Set<ErrorKind>([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
  "unknown",
]);

function readChatErrorKind(value: unknown): ErrorKind | undefined {
  return typeof value === "string" && CHAT_ERROR_KINDS.has(value as ErrorKind)
    ? (value as ErrorKind)
    : undefined;
}

export type PreservedErrorPartialParams = {
  sessionKey: string;
  /** Client-facing runId (matches the abort-path buffer keying). */
  runId: string;
  text: string;
};

// FORK 2026-07-22 (error-partial-preserve): idempotency probe mirroring the
// non-exported transcriptHasIdempotencyKey in server-methods/chat.ts — kept
// local because that helper is not exported and chat.ts is owned by a sibling
// edit-unit.
function transcriptAlreadyHasIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): boolean {
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

// FORK 2026-07-22 (error-partial-preserve): when an embedded run dies in
// error/timeout (e.g. `FailoverError: LLM request timed out.` after a 46-min
// turn), the buffered streamed partial used to be discarded by
// clearBufferedChatState — the tab showed nothing after reload. Persist the
// partial to the session transcript following the abort-path precedent
// (persistAbortedPartials in server-methods/chat.ts): same
// `${runId}:assistant` idempotencyKey, same SessionManager-backed append via
// appendInjectedAssistantMessageToTranscript. Exported for tests.
export function persistPreservedErrorPartial(params: PreservedErrorPartialParams): {
  ok: boolean;
  error?: string;
} {
  try {
    const { storePath, entry } = loadSessionEntry(params.sessionKey);
    if (!storePath && !entry?.sessionFile) {
      return { ok: false, error: "transcript path not resolved" };
    }
    const sessionId = entry?.sessionId ?? params.runId;
    const sessionsDir = storePath ? path.dirname(path.resolve(storePath)) : undefined;
    const transcriptPath = resolveSessionFilePath(
      sessionId,
      entry?.sessionFile ? { sessionFile: entry.sessionFile } : undefined,
      sessionsDir ? { sessionsDir } : undefined,
    );
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      // Unlike the abort path we do not create the transcript: a run that
      // streamed partial text always has a transcript with the user turn.
      return { ok: false, error: "transcript file not found" };
    }
    const idempotencyKey = `${params.runId}:assistant`;
    if (transcriptAlreadyHasIdempotencyKey(transcriptPath, idempotencyKey)) {
      return { ok: true };
    }
    return appendInjectedAssistantMessageToTranscript({
      transcriptPath,
      message: params.text,
      idempotencyKey,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// FORK 2026-08-05 (duprep — the "I see my answer twice" report): the chat delta payload carries
// the SERVER-CUMULATIVE assistant buffer, and the client indexes into that one string with
// integer cursors (tinker-ui/src/app.ts: the global `lastDeltaLen` plus a per-bubble
// `_segmentStart`, sliced at app.ts:4460-4467 — its own comment says "deltaText is the
// SERVER-CUMULATIVE text for the current run, NOT a per-delta increment").
//
// `resolveMergedAssistantText` (live-chat-projector.ts) does NOT always extend that buffer. It
// invalidates every client cursor two ways:
//   1. RESET — when the incoming snapshot is neither a prefix-extension of the buffer nor a
//      stale prefix of it and carries no delta, the whole buffer becomes `nextText`
//      (live-chat-projector.ts:42-44). This is the path the agent stream takes when it decides
//      the text is a replacement: embedded-agent-subscribe.handlers.messages.ts:571-572 sets
//      `replace = !cleanedText.startsWith(previousCleaned)` and clears the delta, so a reset
//      arrives here as text-without-delta.
//   2. CAP — once the buffer passes MAX_LIVE_CHAT_BUFFER_CHARS it is silently tail-sliced
//      (live-chat-projector.ts:18-23), re-basing every offset. No upstream flag can announce
//      this; only the gateway knows.
// Either way the client keeps slicing the NEW text at OLD offsets and re-renders text it has
// already shown — the duplicate.
//
// Why derive the flag here instead of relaying `evt.data.replace` from the agent stream: that
// upstream flag is computed in the RUNNER's coordinate space (its own `lastStreamedAssistantCleaned`),
// while the client indexes THIS buffer. When the two have drifted, relaying it raw would fire
// on a snapshot that actually extends the gateway buffer, telling the client to reset when
// nothing moved. Comparing the projector's own input and output is exact for the contract the
// client consumes, and it covers case 2 as well.
//
// Branch table (proven against live-chat-projector.ts:25-46):
//   prefix-extension  → returns nextText ⊃ prev      → startsWith → false ✓
//   stale prefix      → returns previousText         → startsWith → false ✓
//   delta append      → returns prev + delta         → startsWith → false ✓
//   delta + cap slice → returns tail slice           → NOT startsWith → true ✓
//   RESET             → returns nextText             → NOT startsWith → true ✓
//   no-op             → returns previousText         → startsWith → false ✓
export function isLiveChatBufferReplaced(previousText: string, mergedText: string): boolean {
  return previousText.length > 0 && !mergedText.startsWith(previousText);
}

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  loadGatewaySessionRowForSnapshot?: typeof loadGatewaySessionRow;
  lifecycleErrorRetryGraceMs?: number;
  isChatSendRunActive?: (runId: string) => boolean;
  /** Injectable for tests; defaults to persistPreservedErrorPartial. */
  persistErrorPartial?: (params: PreservedErrorPartialParams) => void;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
  sessionEventSubscribers,
  loadGatewaySessionRowForSnapshot = loadGatewaySessionRow,
  lifecycleErrorRetryGraceMs = AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS,
  isChatSendRunActive = () => false,
  persistErrorPartial = (params) => {
    void persistPreservedErrorPartial(params);
  },
}: AgentEventHandlerOptions) {
  const pendingTerminalLifecycleErrors = new Map<string, NodeJS.Timeout>();
  // FORK 2026-07-22 (error-partial-preserve): buffered partial text captured at
  // the lifecycle-error event (before clearBufferedChatState wipes it), keyed
  // by the source runId. Consumed by finalizeLifecycleEvent's error path;
  // dropped when a retry reuses the runId (any non-error event) or when the
  // run ends successfully.
  const preservedErrorPartials = new Map<
    string,
    { sessionKey: string; clientRunId: string; text: string }
  >();

  // FORK 2026-08-05 (duprep): client runIds whose live buffer was re-based by
  // resolveMergedAssistantText since the last delta we ACTUALLY broadcast. Sticky on purpose:
  // emitChatDelta returns at the 150 ms throttle (and on a suppressed projection) BEFORE it
  // builds a payload, so computing the flag per-event and dropping it would silently lose every
  // reset that lands inside a throttled window — which is the common case, since a reset
  // typically arrives immediately after a tool call. The flag is held until a delta or a flush
  // is really sent, then cleared.
  const pendingDeltaReplace = new Set<string>();

  const clearBufferedChatState = (clientRunId: string) => {
    chatRunState.rawBuffers.delete(clientRunId);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    chatRunState.deltaLastBroadcastLen.delete(clientRunId);
    pendingDeltaReplace.delete(clientRunId);
  };

  const clearPendingTerminalLifecycleError = (runId: string) => {
    const pending = pendingTerminalLifecycleErrors.get(runId);
    if (!pending) {
      return;
    }
    clearTimeout(pending);
    pendingTerminalLifecycleErrors.delete(runId);
  };

  const buildSessionEventSnapshot = (sessionKey: string, evt?: AgentEventPayload) => {
    const row = loadGatewaySessionRowForSnapshot(sessionKey);
    const lifecyclePatch = evt
      ? deriveGatewaySessionLifecycleSnapshot({
          session: row
            ? {
                updatedAt: row.updatedAt ?? undefined,
                status: row.status,
                startedAt: row.startedAt,
                endedAt: row.endedAt,
                runtimeMs: row.runtimeMs,
                abortedLastRun: row.abortedLastRun,
              }
            : undefined,
          event: evt,
        })
      : {};
    const session = row ? { ...row, ...lifecyclePatch } : undefined;
    const snapshotSource = session ?? lifecyclePatch;
    return {
      ...(session ? { session } : {}),
      updatedAt: snapshotSource.updatedAt,
      sessionId: row?.sessionId,
      kind: row?.kind,
      channel: row?.channel,
      subject: row?.subject,
      groupChannel: row?.groupChannel,
      space: row?.space,
      chatType: row?.chatType,
      origin: row?.origin,
      spawnedBy: row?.spawnedBy,
      spawnedWorkspaceDir: row?.spawnedWorkspaceDir,
      forkedFromParent: row?.forkedFromParent,
      spawnDepth: row?.spawnDepth,
      subagentRole: row?.subagentRole,
      subagentControlScope: row?.subagentControlScope,
      label: row?.label,
      displayName: row?.displayName,
      deliveryContext: row?.deliveryContext,
      parentSessionKey: row?.parentSessionKey,
      childSessions: row?.childSessions,
      thinkingLevel: row?.thinkingLevel,
      fastMode: row?.fastMode,
      verboseLevel: row?.verboseLevel,
      traceLevel: row?.traceLevel,
      reasoningLevel: row?.reasoningLevel,
      elevatedLevel: row?.elevatedLevel,
      sendPolicy: row?.sendPolicy,
      systemSent: row?.systemSent,
      inputTokens: row?.inputTokens,
      outputTokens: row?.outputTokens,
      lastChannel: row?.lastChannel,
      lastTo: row?.lastTo,
      lastAccountId: row?.lastAccountId,
      lastThreadId: row?.lastThreadId,
      totalTokens: row?.totalTokens,
      totalTokensFresh: row?.totalTokensFresh,
      contextTokens: row?.contextTokens,
      estimatedCostUsd: row?.estimatedCostUsd,
      responseUsage: row?.responseUsage,
      modelProvider: row?.modelProvider,
      model: row?.model,
      status: snapshotSource.status,
      startedAt: snapshotSource.startedAt,
      endedAt: snapshotSource.endedAt,
      runtimeMs: snapshotSource.runtimeMs,
      abortedLastRun: snapshotSource.abortedLastRun,
    };
  };

  const finalizeLifecycleEvent = (
    evt: AgentEventPayload,
    opts?: { skipChatErrorFinal?: boolean },
  ) => {
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    if (lifecyclePhase !== "end" && lifecyclePhase !== "error") {
      return;
    }

    clearPendingTerminalLifecycleError(evt.runId);

    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);

    // FORK 2026-07-22 (error-partial-preserve): consume the partial captured at
    // the lifecycle-error event. Deleting on BOTH phases keeps the map from
    // leaking when a retry turned the error into a successful end.
    const preservedPartial = preservedErrorPartials.get(evt.runId);
    preservedErrorPartials.delete(evt.runId);
    const preservedPartialText =
      lifecyclePhase === "error" && !isAborted ? preservedPartial?.text : undefined;
    if (preservedPartialText && preservedPartial) {
      persistErrorPartial({
        sessionKey: preservedPartial.sessionKey,
        runId: preservedPartial.clientRunId,
        text: preservedPartialText,
      });
    }

    if (isControlUiVisible && sessionKey) {
      if (!isAborted) {
        const evtStopReason =
          typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
        const evtErrorKind =
          readChatErrorKind(evt.data?.errorKind) ?? detectErrorKind(evt.data?.error);
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          if (!(opts?.skipChatErrorFinal && lifecyclePhase === "error")) {
            emitChatFinal(
              finished.sessionKey,
              finished.clientRunId,
              evt.runId,
              evt.seq,
              lifecyclePhase === "error" ? "error" : "done",
              evt.data?.error,
              evtStopReason,
              evtErrorKind,
              preservedPartialText,
            );
          }
        } else if (!(opts?.skipChatErrorFinal && lifecyclePhase === "error")) {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            evtStopReason,
            evtErrorKind,
            preservedPartialText,
          );
        }
      } else {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        clearBufferedChatState(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    toolEventRecipients.markFinal(evt.runId);
    clearAgentRunContext(evt.runId);
    agentRunSeq.delete(evt.runId);
    agentRunSeq.delete(clientRunId);

    if (sessionKey) {
      void persistGatewaySessionLifecycleEvent({ sessionKey, event: evt }).catch(() => undefined);
      const sessionEventConnIds = sessionEventSubscribers.getAll();
      if (sessionEventConnIds.size > 0) {
        broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey,
            phase: lifecyclePhase,
            runId: evt.runId,
            ts: evt.ts,
            ...buildSessionEventSnapshot(sessionKey, evt),
          },
          sessionEventConnIds,
          { dropIfSlow: true },
        );
      }
    }
  };

  const scheduleTerminalLifecycleError = (
    evt: AgentEventPayload,
    opts?: { skipChatErrorFinal?: boolean },
  ) => {
    clearPendingTerminalLifecycleError(evt.runId);
    const timer = setSafeTimeout(() => {
      pendingTerminalLifecycleErrors.delete(evt.runId);
      finalizeLifecycleEvent(evt, opts);
    }, lifecycleErrorRetryGraceMs);
    timer.unref?.();
    pendingTerminalLifecycleErrors.set(evt.runId, timer);
  };

  const emitChatDelta = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    text: string,
    delta?: unknown,
  ) => {
    const cleaned = normalizeLiveAssistantEventText({ text, delta });
    const previousRawText = chatRunState.rawBuffers.get(clientRunId) ?? "";
    const mergedRawText = resolveMergedAssistantText({
      previousText: previousRawText,
      nextText: cleaned.text,
      nextDelta: cleaned.delta,
    });
    if (!mergedRawText) {
      return;
    }
    // FORK 2026-08-05 (duprep): record a buffer re-base BEFORE the throttle/suppress early
    // returns below can swallow it. See `isLiveChatBufferReplaced` and `pendingDeltaReplace`.
    if (isLiveChatBufferReplaced(previousRawText, mergedRawText)) {
      pendingDeltaReplace.add(clientRunId);
    }
    chatRunState.rawBuffers.set(clientRunId, mergedRawText);
    const projected = projectLiveAssistantBufferedText(mergedRawText);
    const mergedText = projected.text;
    chatRunState.buffers.set(clientRunId, mergedText);
    if (projected.suppress) {
      return;
    }
    if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      return;
    }
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    chatRunState.deltaLastBroadcastLen.set(clientRunId, mergedText.length);
    const replaceBuffer = pendingDeltaReplace.has(clientRunId);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      // FORK 2026-08-05 (duprep): present (and always literally `true`) ONLY when the cumulative
      // buffer was re-based, absent on an ordinary extension. Clients must drop the cursors and
      // bubbles they hold for this run and re-render from this text instead of appending —
      // otherwise they slice new text at stale offsets and the answer appears twice. Clients
      // that ignore the field behave exactly as before.
      // NOTE: ChatEventSchema (src/gateway/protocol/schema/logs-chat.ts) is
      // additionalProperties:false and does not declare `replace` yet — it needs
      // `replace: Type.Optional(Type.Literal(true))` added. `validateChatEvent`
      // (protocol/index.ts:586) is compiled but has NO call site today, so this is a contract
      // gap, not a runtime break. The schema file is owned by a different edit-unit; same
      // split as the reason/retryAfter fields already documented in that schema.
      ...(replaceBuffer && { replace: true as const }),
      message: {
        role: "assistant",
        content: [{ type: "text", text: mergedText }],
        timestamp: now,
      },
    };
    // Suppress webchat broadcast for heartbeat runs when showOk is false
    if (!shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      pendingDeltaReplace.delete(clientRunId);
      broadcast("chat", payload, { dropIfSlow: true });
      nodeSendToSession(sessionKey, "chat", payload);
    }
  };

  const resolveBufferedChatTextState = (
    clientRunId: string,
    sourceRunId: string,
    options?: { suppressLeadFragments?: boolean },
  ) => {
    const bufferedText = normalizeLiveAssistantEventText({
      text: chatRunState.buffers.get(clientRunId) ?? "",
    }).text.trim();
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: clientRunId,
      sourceRunId,
      text: bufferedText,
    });
    const projected = projectLiveAssistantBufferedText(normalizedHeartbeatText.text.trim(), {
      suppressLeadFragments: options?.suppressLeadFragments,
    });
    return {
      text: projected.text.trim(),
      shouldSuppressSilent: normalizedHeartbeatText.suppress || projected.suppress,
    };
  };

  const flushBufferedChatDeltaIfNeeded = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
  ) => {
    const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId, {
      suppressLeadFragments: true,
    });
    const shouldSuppressHeartbeatStreaming = shouldHideHeartbeatChatOutput(
      clientRunId,
      sourceRunId,
    );
    if (!text || shouldSuppressSilent || shouldSuppressHeartbeatStreaming) {
      return;
    }

    // FORK 2026-08-05 (duprep): the grow-only guard compares lengths, which is only meaningful
    // while the buffer stays in ONE coordinate space. After a re-base the new buffer is often
    // SHORTER than what we last broadcast, so the guard would suppress the flush and leave the
    // client showing stale text right up to the `final` event. A pending replace overrides it.
    const replaceBuffer = pendingDeltaReplace.has(clientRunId);
    const lastBroadcastLen = chatRunState.deltaLastBroadcastLen.get(clientRunId) ?? 0;
    if (!replaceBuffer && text.length <= lastBroadcastLen) {
      return;
    }

    const now = Date.now();
    const flushPayload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      ...(replaceBuffer && { replace: true as const }),
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    pendingDeltaReplace.delete(clientRunId);
    broadcast("chat", flushPayload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", flushPayload);
    chatRunState.deltaLastBroadcastLen.set(clientRunId, text.length);
    chatRunState.deltaSentAt.set(clientRunId, now);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
    stopReason?: string,
    errorKind?: ErrorKind,
    preservedPartialText?: string,
  ) => {
    const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId, {
      suppressLeadFragments: false,
    });
    // Flush any throttled delta so streaming clients receive the complete text
    // before the final event. The 150 ms throttle in emitChatDelta may have
    // suppressed the most recent chunk, leaving the client with stale text.
    // Only flush if the buffer has grown since the last broadcast to avoid duplicates.
    flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, sourceRunId, seq);
    chatRunState.deltaLastBroadcastLen.delete(clientRunId);
    chatRunState.rawBuffers.delete(clientRunId);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    chatRunState.deltaSentAt.delete(`thinking:${clientRunId}`);
    // FORK 2026-08-05 (duprep): the flush above already carried any pending replace; drop it so
    // a runId reused by a retry cannot inherit a stale reset signal.
    pendingDeltaReplace.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        ...(stopReason && { stopReason }),
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      // Suppress webchat broadcast for heartbeat runs when showOk is false
      if (!shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
        broadcast("chat", payload);
        nodeSendToSession(sessionKey, "chat", payload);
      }
      return;
    }
    // FORK 2026-06-24 (recoverable-error retry, spec Component 1): surface the
    // failover decision's recoverability class as the machine-readable `reason`
    // so the Tinker auto-retry controller no longer has to text-match
    // `errorMessage`. `resolveFailoverReasonFromError` unwraps a FailoverError
    // (returns its `.reason`) or classifies the raw error signal — exactly the
    // value the embedded-runner logs as `decision=surface_error reason=...`.
    // `retryAfter` (provider Retry-After) is not attached to the error object at
    // this layer, so it is intentionally OMITTED; the frontend backoff ladder
    // owns the timing. `errorMessage` (human text) is unchanged.
    const failoverReason = resolveFailoverReasonFromError(error) ?? undefined;
    // FORK 2026-07-22 (error-partial-preserve): surface the preserved partial
    // on the error broadcast via the standard `message` field (ChatEventSchema
    // is additionalProperties:false, so a new `partialText` field would be
    // schema-illegal; `message` is already Type.Optional(Type.Unknown()) for
    // every state). Live clients keyed by runId can render it above the error
    // bubble exactly like a done-final message.
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
      ...(errorKind && { errorKind }),
      ...(failoverReason && { reason: failoverReason }),
      ...(preservedPartialText
        ? {
            message: {
              role: "assistant",
              content: [{ type: "text", text: preservedPartialText }],
              timestamp: Date.now(),
            },
          }
        : {}),
    };
    // Suppress webchat broadcast for heartbeat error events too
    if (!shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
    }
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    if (evt.stream !== "lifecycle" || lifecyclePhase !== "error") {
      clearPendingTerminalLifecycleError(evt.runId);
      // A non-error event means a fallback/retry reused this runId — the
      // captured partial is superseded by the new attempt's stream.
      preservedErrorPartials.delete(evt.runId);
    }

    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build tool payload: strip result/partialResult unless verbose=full
    const toolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForClients, sessionKey, data }
              : { ...eventForClients, data };
          })()
        : agentPayload;
    if (last > 0 && evt.seq !== last + 1) {
      broadcast("agent", {
        runId: eventRunId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (isToolEvent) {
      const toolPhase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      // Flush pending assistant text before tool-start events so clients can
      // render complete pre-tool text above tool cards (not truncated by delta throttle).
      if (toolPhase === "start" && isControlUiVisible && sessionKey && !isAborted) {
        flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
      }
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      //
      // FORK (2026-04-24): use `agentPayload` (UNSTRIPPED) for WS clients
      // so Tinker UI + CLI tool consumers receive `result`/`partialResult`
      // and can render full stdout on expand. The comment at line 1021
      // already states "WS clients already received the event above" —
      // the intent has always been "strip only for channel surfaces,
      // keep for WS" but the toolPayload used here had the result deleted,
      // which made every tool row in the UI render `(completed)` instead
      // of the actual stdout.
      const recipients = toolEventRecipients.get(evt.runId);
      if (recipients && recipients.size > 0) {
        broadcastToConnIds(
          "agent",
          sessionKey ? { ...agentPayload, ...buildSessionEventSnapshot(sessionKey) } : agentPayload,
          recipients,
        );
      }
      // Session subscribers power operator UIs that attach to an existing
      // in-flight session after the run has already started. Those clients do
      // not know the runId in advance, so they cannot register as run-scoped
      // tool recipients. Mirror tool lifecycle onto a session-scoped event so
      // they can render live pending tool cards without polling history.
      if (sessionKey) {
        const sessionSubscribers = sessionEventSubscribers.getAll();
        if (sessionSubscribers.size > 0) {
          broadcastToConnIds(
            "session.tool",
            { ...agentPayload, ...buildSessionEventSnapshot(sessionKey) },
            sessionSubscribers,
            { dropIfSlow: true },
          );
        }
      }
    } else {
      // Enrich lifecycle events with model info for observability clients.
      // If the runner already provided model/modelProvider/authProfileId in the
      // event data (e.g. from handleAgentStart), prefer those — the runner knows
      // the actual model and auth profile being used. Only fall back to
      // session-entry resolution when the event lacks model info.
      let enrichedPayload = agentPayload;
      if (evt.stream === "lifecycle" && typeof evt.data?.phase === "string" && sessionKey) {
        if (evt.data.model && evt.data.modelProvider) {
          // Runner already provided authoritative model info — just ensure
          // model is in provider/model format and pass through authProfileId.
          const evtModel = String(evt.data.model);
          const evtProvider = String(evt.data.modelProvider);
          const formattedModel = evtModel.includes("/") ? evtModel : `${evtProvider}/${evtModel}`;
          enrichedPayload = {
            ...agentPayload,
            data: {
              ...evt.data,
              model: formattedModel,
              modelProvider: evtProvider,
            },
          };
        } else {
          try {
            const { cfg, entry } = loadSessionEntry(sessionKey);
            const resolved = resolveSessionModelRef(cfg, entry);
            if (resolved.model) {
              enrichedPayload = {
                ...agentPayload,
                data: {
                  ...evt.data,
                  model: resolved.provider
                    ? `${resolved.provider}/${resolved.model}`
                    : resolved.model,
                  modelProvider: resolved.provider,
                },
              };
            }
          } catch {
            /* non-critical enrichment failure */
          }
        }
      }
      broadcast("agent", enrichedPayload);
    }

    if (isControlUiVisible && sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(
          sessionKey,
          "agent",
          isToolEvent ? { ...toolPayload, ...buildSessionEventSnapshot(sessionKey) } : agentPayload,
        );
      }
      if (
        !isAborted &&
        evt.stream === "assistant" &&
        typeof evt.data?.text === "string" &&
        !shouldSuppressAssistantEventForLiveChat(evt.data)
      ) {
        emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text, evt.data.delta);
      }
    }

    if (lifecyclePhase === "error") {
      // FORK 2026-07-22 (error-partial-preserve): capture the buffered partial
      // BEFORE clearBufferedChatState discards it. Empty/whitespace text and
      // silent-reply (NO_REPLY-family) buffers are filtered out by
      // resolveBufferedChatTextState. Abort partials are persisted by the
      // chat.abort path in server-methods/chat.ts — skip them here.
      if (!isAborted && sessionKey) {
        const preserved = resolveBufferedChatTextState(clientRunId, evt.runId, {
          suppressLeadFragments: false,
        });
        if (preserved.text && !preserved.shouldSuppressSilent) {
          preservedErrorPartials.set(evt.runId, {
            sessionKey,
            clientRunId,
            text: preserved.text,
          });
        }
      }
      clearBufferedChatState(clientRunId);
      const skipChatErrorFinal = isChatSendRunActive(evt.runId) && !chatLink;
      if (isAborted || lifecycleErrorRetryGraceMs <= 0) {
        finalizeLifecycleEvent(evt, { skipChatErrorFinal });
      } else {
        scheduleTerminalLifecycleError(evt, { skipChatErrorFinal });
      }
      return;
    }

    if (lifecyclePhase === "end") {
      finalizeLifecycleEvent(evt);
      return;
    }

    if (sessionKey && lifecyclePhase === "start") {
      void persistGatewaySessionLifecycleEvent({ sessionKey, event: evt }).catch(() => undefined);
      const sessionEventConnIds = sessionEventSubscribers.getAll();
      if (sessionEventConnIds.size > 0) {
        broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey,
            phase: lifecyclePhase,
            runId: evt.runId,
            ts: evt.ts,
            ...buildSessionEventSnapshot(sessionKey, evt),
          },
          sessionEventConnIds,
          { dropIfSlow: true },
        );
      }
    }
  };
}
