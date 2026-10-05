import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { SessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { resolveSessionKeyForTranscriptFile } from "./session-transcript-key.js";
import type { SessionMessagesRead } from "./session-utils.fs.js";
import {
  attachOpenClawTranscriptMeta,
  loadGatewaySessionRow,
  loadSessionEntry,
  readSessionMessagesWithCursor,
  type GatewaySessionRow,
} from "./session-utils.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;

function buildGatewaySessionSnapshot(params: {
  sessionRow: GatewaySessionRow | null | undefined;
  includeSession?: boolean;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
}): Record<string, unknown> {
  const { sessionRow } = params;
  if (!sessionRow) {
    return {};
  }
  return {
    ...(params.includeSession ? { session: sessionRow } : {}),
    updatedAt: sessionRow.updatedAt ?? undefined,
    sessionId: sessionRow.sessionId,
    kind: sessionRow.kind,
    channel: sessionRow.channel,
    subject: sessionRow.subject,
    groupChannel: sessionRow.groupChannel,
    space: sessionRow.space,
    chatType: sessionRow.chatType,
    origin: sessionRow.origin,
    spawnedBy: sessionRow.spawnedBy,
    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
    forkedFromParent: sessionRow.forkedFromParent,
    spawnDepth: sessionRow.spawnDepth,
    subagentRole: sessionRow.subagentRole,
    subagentControlScope: sessionRow.subagentControlScope,
    label: params.label ?? sessionRow.label,
    displayName: params.displayName ?? sessionRow.displayName,
    deliveryContext: sessionRow.deliveryContext,
    parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
    childSessions: sessionRow.childSessions,
    thinkingLevel: sessionRow.thinkingLevel,
    fastMode: sessionRow.fastMode,
    verboseLevel: sessionRow.verboseLevel,
    reasoningLevel: sessionRow.reasoningLevel,
    elevatedLevel: sessionRow.elevatedLevel,
    sendPolicy: sessionRow.sendPolicy,
    systemSent: sessionRow.systemSent,
    abortedLastRun: sessionRow.abortedLastRun,
    inputTokens: sessionRow.inputTokens,
    outputTokens: sessionRow.outputTokens,
    lastChannel: sessionRow.lastChannel,
    lastTo: sessionRow.lastTo,
    lastAccountId: sessionRow.lastAccountId,
    lastThreadId: sessionRow.lastThreadId,
    totalTokens: sessionRow.totalTokens,
    totalTokensFresh: sessionRow.totalTokensFresh,
    contextTokens: sessionRow.contextTokens,
    estimatedCostUsd: sessionRow.estimatedCostUsd,
    responseUsage: sessionRow.responseUsage,
    modelProvider: sessionRow.modelProvider,
    model: sessionRow.model,
    status: sessionRow.status,
    subagentRunState: sessionRow.subagentRunState,
    hasActiveSubagentRun: sessionRow.hasActiveSubagentRun,
    startedAt: sessionRow.startedAt,
    endedAt: sessionRow.endedAt,
    runtimeMs: sessionRow.runtimeMs,
    compactionCheckpointCount: sessionRow.compactionCheckpointCount,
    latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
  };
}

/**
 * FORK 2026-09-23 (chat.history rehaul, plan task 6, ruling R6) — the seq a push event carries MUST
 * be the same number `chat.history` cursors use: the `__openclaw.seq` of the served row whose
 * `__openclaw.id` matches the appended entry. A raw branch-index position (`view.entries.findIndex
 * (...) + 1`) is NOT that number — it counts non-message entries (prompt-key markers) and
 * runtime-context-only rows that the message projection silently drops before it bumps `seq`, so a
 * positional index runs ahead of the true seq the moment either has appeared earlier in the branch.
 * `read` is already the SAME cached, index-backed call `chat.history` itself makes (Task 5), so this
 * costs nothing extra beyond the lookup.
 */
function resolveMessageSeqFromCursorRead(
  read: SessionMessagesRead | undefined,
  messageId: string | undefined,
): number | undefined {
  if (!read || typeof messageId !== "string") {
    return undefined;
  }
  for (let i = read.messages.length - 1; i >= 0; i--) {
    const row = read.messages[i] as { __openclaw?: { id?: unknown; seq?: unknown } } | null;
    if (row?.__openclaw?.id !== messageId) {
      continue;
    }
    const seq = row.__openclaw?.seq;
    return typeof seq === "number" ? seq : undefined;
  }
  return undefined;
}

export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
}) {
  return (update: SessionTranscriptUpdate): void => {
    const sessionKey = update.sessionKey ?? resolveSessionKeyForTranscriptFile(update.sessionFile);
    if (!sessionKey || update.message === undefined) {
      return;
    }
    const connIds = new Set<string>();
    for (const connId of params.sessionEventSubscribers.getAll()) {
      connIds.add(connId);
    }
    for (const connId of params.sessionMessageSubscribers.get(sessionKey)) {
      connIds.add(connId);
    }
    if (connIds.size === 0) {
      return;
    }
    const { entry, storePath } = loadSessionEntry(sessionKey);
    // Same cached, index-backed read `chat.history` serves cursors from (Task 5) — an append just
    // ahead of this call is a guaranteed cache miss, but the TranscriptIndex beneath it tail-parses
    // only the bytes appended since its last refresh, never the whole transcript again.
    const cursorRead = entry?.sessionId
      ? readSessionMessagesWithCursor(entry.sessionId, storePath, entry.sessionFile)
      : undefined;
    const epoch = cursorRead?.epoch ?? null;
    const messageSeq = resolveMessageSeqFromCursorRead(cursorRead, update.messageId);
    const sessionSnapshot = buildGatewaySessionSnapshot({
      sessionRow: loadGatewaySessionRow(sessionKey),
      includeSession: true,
    });
    const rawMessage = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      ...(typeof messageSeq === "number" ? { seq: messageSeq } : {}),
    });
    const message = projectChatDisplayMessage(rawMessage);
    if (message) {
      params.broadcastToConnIds(
        "session.message",
        {
          sessionKey,
          message,
          epoch,
          ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
          ...(typeof messageSeq === "number" ? { messageSeq } : {}),
          ...sessionSnapshot,
        },
        connIds,
        { dropIfSlow: true },
      );
    }

    const sessionEventConnIds = params.sessionEventSubscribers.getAll();
    if (sessionEventConnIds.size === 0) {
      return;
    }
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey,
        phase: "message",
        ts: Date.now(),
        epoch,
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(typeof messageSeq === "number" ? { messageSeq } : {}),
        ...sessionSnapshot,
      },
      sessionEventConnIds,
      { dropIfSlow: true },
    );
  };
}

export function createLifecycleEventBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
}) {
  return (event: SessionLifecycleEvent): void => {
    const connIds = params.sessionEventSubscribers.getAll();
    if (connIds.size === 0) {
      return;
    }
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey: event.sessionKey,
        reason: event.reason,
        parentSessionKey: event.parentSessionKey,
        label: event.label,
        displayName: event.displayName,
        ts: Date.now(),
        ...buildGatewaySessionSnapshot({
          sessionRow: loadGatewaySessionRow(event.sessionKey),
          label: event.label,
          displayName: event.displayName,
          parentSessionKey: event.parentSessionKey,
        }),
      },
      connIds,
      { dropIfSlow: true },
    );
  };
}
