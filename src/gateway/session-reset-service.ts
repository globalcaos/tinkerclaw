import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { retireSessionMcpRuntime } from "../agents/agent-bundle-mcp-tools.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../agents/embedded-agent.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../auto-reply/reply/session-hooks.js";
import { clearSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  snapshotSessionOrigin,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { clearAgentRunContextsForSession } from "../infra/agent-events.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closeTrackedBrowserTabsForSessions } from "../plugin-sdk/browser-maintenance.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPluginHostCleanup } from "../plugins/host-hook-cleanup.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { abortChatRunById, type ChatAbortOps } from "./chat-abort.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import {
  archiveSessionTranscriptsDetailed,
  resolveStableSessionEndTranscript,
  type ArchivedSessionTranscript,
} from "./session-transcript-files.fs.js";
import {
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "./session-utils.js";

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

function stripRuntimeModelState(entry?: SessionEntry): SessionEntry | undefined {
  if (!entry) {
    return entry;
  }
  return {
    ...entry,
    model: undefined,
    modelProvider: undefined,
    contextTokens: undefined,
    systemPromptReport: undefined,
  };
}

export function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  return archiveSessionTranscriptsForSessionDetailed(params).map((entry) => entry.archivedPath);
}

export function archiveSessionTranscriptsForSessionDetailed(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): ArchivedSessionTranscript[] {
  if (!params.sessionId) {
    return [];
  }
  return archiveSessionTranscriptsDetailed({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
  });
}

export function emitGatewaySessionEndPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
  archivedTranscripts?: ArchivedSessionTranscript[];
  nextSessionId?: string;
  nextSessionKey?: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_end")) {
    return;
  }
  const transcript = resolveStableSessionEndTranscript({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    archivedTranscripts: params.archivedTranscripts,
  });
  const payload = buildSessionEndHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cfg: params.cfg,
    reason: params.reason,
    sessionFile: transcript.sessionFile,
    transcriptArchived: transcript.transcriptArchived,
    nextSessionId: params.nextSessionId,
    nextSessionKey: params.nextSessionKey,
  });
  void hookRunner.runSessionEnd(payload.event, payload.context).catch((err) => {
    logVerbose(`session_end hook failed: ${String(err)}`);
  });
}

export function emitGatewaySessionStartPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  resumedFrom?: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_start")) {
    return;
  }
  const payload = buildSessionStartHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cfg: params.cfg,
    resumedFrom: params.resumedFrom,
  });
  void hookRunner.runSessionStart(payload.event, payload.context).catch((err) => {
    logVerbose(`session_start hook failed: ${String(err)}`);
  });
}

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  await getSessionBindingService().unbind({
    targetSessionKey: params.targetSessionKey,
    reason: params.reason,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

const SESSION_TURN_END_TIMEOUT_MS = 15_000;
const cleanupLog = createSubsystemLogger("gateway/session-reset");

/** Every form one session's key takes in the holders endSessionTurns ends. */
export type SessionTurnKeys = {
  /** The key the request carried, as carried: it may be an alias of the canonical one. */
  requestedKey: string;
  canonicalKey: string;
  storeKeys: readonly string[];
  sessionId?: string;
};

export type EndSessionTurnsResult = {
  /** false when a reply operation or the embedded run was still running at its 15 s deadline. */
  ended: boolean;
  /** Every runId that received its one `chat` `aborted` here: chat controllers and backlog. */
  abortedRunIds: string[];
  /**
   * Backlogged prompts dropped with no terminal: no prompt key, no chat-run state on this path, a
   * key that names another session's run, or a prompt the queue cap had folded into a summary. A
   * key in `exceptRunIds` is not counted: its own live chat.send sends its terminal.
   */
  unannouncedBacklog: number;
};

function uniqueKeyForms(keys: ReadonlyArray<string | undefined>): string[] {
  const forms: string[] = [];
  for (const key of keys) {
    const trimmed = key?.trim();
    if (trimmed && !forms.includes(trimmed)) {
      forms.push(trimmed);
    }
  }
  return forms;
}

/**
 * The chat-run state endSessionTurns ends runs through, or undefined when there is none to use.
 * Every gateway request context carries these maps (server-request-context.ts), and every caller
 * inside a gateway request hands them over: sessions.reset, sessions.delete, the `agent` method's
 * `/new` and `/reset` (runSessionResetFromAgent in agent.ts), and a `/new` or `/reset` TYPED
 * through chat.send, which lifts the context from the request scope its dispatch inherits
 * (endTypedResetSessionTurns in src/auto-reply/reply/session.ts; server-methods.ts runs every
 * handler under withPluginRuntimeGatewayRequestScope). A caller outside a gateway request (the TUI
 * embedded backend, the ACP driver, a typed reset arriving on a channel) passes none, and a
 * hand-built context such as a unit-test double may carry a partial one. Neither has chat
 * controllers to end, and walking a missing map would throw mid-cleanup.
 */
function usableChatAbortOps(ops: ChatAbortOps | undefined): ChatAbortOps | undefined {
  return ops?.chatAbortControllers instanceof Map ? ops : undefined;
}

/**
 * A backlogged prompt's one terminal: chat-abort.ts's broadcastChatAborted wire shape (a prompt
 * that never ran has no partial text), under the canonical key chat.send broadcast this prompt's
 * other events with. Deliberately NOT marked in chatAbortedRuns: this runs only once the prompt's
 * chat.send has settled (its controller is gone), so no completion is left to silence, and a mark
 * would outlive the prompt by the hour-long TTL.
 */
function broadcastBacklogAborted(
  ops: ChatAbortOps,
  params: { runId: string; sessionKey: string; stopReason: string },
): void {
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq: (ops.agentRunSeq.get(params.runId) ?? 0) + 1,
    state: "aborted" as const,
    stopReason: params.stopReason,
  };
  ops.broadcast("chat", payload);
  ops.nodeSendToSession(params.sessionKey, "chat", payload);
  ops.agentRunSeq.delete(params.runId);
}

/**
 * FORK 2026-09-24 — THE ONE TERMINATOR of a session's turns on every path that deletes or resets
 * one (TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.2; PQ-6 exactly one terminal per prompt, PQ-10
 * one owner of "live"): `sessions.delete` and `sessions.reset` (server-methods/sessions.ts,
 * through cleanupSessionBeforeMutation), the `agent` method's `/new` and `/reset`
 * (runSessionResetFromAgent in server-methods/agent.ts, through performGatewaySessionReset), the
 * TUI and ACP resets (the same reset, with no chat-run state), and a `/new` or `/reset` TYPED in
 * chat, which never reaches an RPC reset (endTypedResetSessionTurns in
 * src/auto-reply/reply/session.ts, called by initSessionState before it rotates the sessionId).
 * Before it, delete/reset ended only the embedded run (holder E). A turn still before the model
 * kept its reply operation (D), its chat controller (C) and its run-set entry (B): it could run on
 * against a soft-deleted or replaced session, the UI got no terminal for its runId, and `run.live`
 * stayed true until the silent 30-minute sweep. Backlogged prompts were cleared and only counted
 * (C10, C11).
 *
 * EXCEPTED RUNS. `exceptRunIds` names live chat runs of this session the cleanup must leave alone,
 * by runId: the typed /new's own run, whose chat.send controller is already registered under the
 * session it is about to reset. Every other run is still aborted through, and deleted from, the
 * caller's REAL controller map at once; a filtered COPY would keep aborted entries registered
 * until their chat.send settles, and a stop in that window would send them a second terminal. An
 * excepted key's one terminal is its own chat.send's, so a backlog item carrying it is neither
 * ended here nor counted in `unannouncedBacklog`: name only runs whose controller is registered.
 *
 * ORDER. Every ABORT (steps 2, 3, 4, 6) fires before the first await, and that is load-bearing:
 * an aborted reply operation lets its chat.send dispatch settle, and a settle that ran before
 * step 4 marked the runId would broadcast `final` / `error` while step 4 then found no controller
 * left: one terminal, of the wrong kind. With every abort first, chat.ts's D2 guard sees the mark
 * and stays silent, and the one terminal is `aborted`. The run-set close (step 5) comes AFTER the
 * waits instead: closing a context while its run still emits restarts that run's event seq.
 *
 * No requester authorization: the caller is already authorized to mutate the session, and
 * chat.abort's requester check would newly FAIL a delete issued from a page that does not own the
 * run. Never settleSessionAfterAbort and never `abortedLastRun`: on reset that flag would reach
 * the fresh session as a false "The previous agent run was aborted by the user" (failures.md M10).
 */
export async function endSessionTurns(params: {
  keys: SessionTurnKeys;
  reason: "session-delete" | "session-reset";
  chatAbortOps?: ChatAbortOps;
  /** Live chat runs of this session to leave alone, by runId (see EXCEPTED RUNS above). */
  exceptRunIds?: readonly string[];
}): Promise<EndSessionTurnsResult> {
  const { keys, reason } = params;
  const cleanupStartedAt = Date.now();
  const ops = usableChatAbortOps(params.chatAbortOps);
  const exceptRunIds = new Set(uniqueKeyForms(params.exceptRunIds ?? []));
  if (params.chatAbortOps && !ops) {
    logVerbose(
      `sessions cleanup: incomplete chat-run state for ${keys.canonicalKey}; its chat runs get no terminal here`,
    );
  }
  // 1. Every key form, once. The holders compare keys EXACTLY (abortChatRunById, the run set, the
  //    reply-run registry), and chat.send registers its controller under the key it was GIVEN,
  //    which may be an alias. The follow-up queue and command lane are also keyed by sessionId.
  //    initSessionState keys a store entry and its turns alike, so these forms reach every turn of
  //    what the caller rotates; the spellings the store folds in are left out on purpose
  //    (reply-registry-key.ts, NOT ROUTED HERE).
  const sessionKeys = uniqueKeyForms([keys.requestedKey, keys.canonicalKey, ...keys.storeKeys]);
  const queueKeys = uniqueKeyForms([...sessionKeys, keys.sessionId]);
  const abortedRunIds: string[] = [];

  // 2. Backlog: one `aborted` per dropped prompt, under ITS prompt key (C11).
  const cleared = clearSessionResetRuntimeState(queueKeys);
  const backlog = cleared.followupItems ?? [];
  // Prompts the queue cap had already folded into a summary line are counted, but left no item.
  let unannouncedBacklog = Math.max(0, cleared.followupCleared - backlog.length);
  for (const item of backlog) {
    const promptKey = item.messageId?.trim();
    if (!promptKey || !ops) {
      unannouncedBacklog += 1;
      continue;
    }
    // An excepted run's key: its live chat.send sends the one terminal, so it is neither ended here
    // nor counted as dropped with none.
    if (exceptRunIds.has(promptKey) || abortedRunIds.includes(promptKey)) {
      continue;
    }
    const live = ops.chatAbortControllers.get(promptKey);
    if (!live) {
      broadcastBacklogAborted(ops, {
        runId: promptKey,
        sessionKey: keys.canonicalKey,
        stopReason: reason,
      });
      abortedRunIds.push(promptKey);
    } else if (sessionKeys.includes(live.sessionKey)) {
      // Its chat.send has not settled yet: end it through its controller, so the runId gets
      // exactly one terminal and step 4 cannot find it a second time.
      const res = abortChatRunById(ops, {
        runId: promptKey,
        sessionKey: live.sessionKey,
        stopReason: reason,
      });
      if (res.aborted) {
        abortedRunIds.push(promptKey);
      }
    } else {
      // The key names ANOTHER session's live run (a provider message id can equal a client
      // idempotencyKey). Not this cleanup's to end (PQ-7).
      unannouncedBacklog += 1;
    }
  }

  // Each key form's reply-operation phase before the aborts below, for the give-up log.
  const phaseBefore = new Map(sessionKeys.map((key) => [key, replyRunRegistry.get(key)?.phase]));

  // 3. Reply operation, under every key form. A `queued` one clears itself now; a running one ends
  //    when its runner unwinds (awaited below). This is the holder abortEmbeddedPiRun cannot see:
  //    queued, or running but not yet registered as an embedded run.
  for (const key of sessionKeys) {
    replyRunRegistry.abort(key);
  }

  // 4. Chat controllers: exactly one `aborted` per runId. abortChatRunById deletes the controller
  //    before it broadcasts, so a later key form cannot end the same run twice. This is
  //    chat-abort.ts's abortChatRunsForSessionKey walk with an excepted run skipped by runId: it
  //    walks the caller's REAL map, and each abort deletes its own entry as it goes.
  if (ops) {
    for (const key of sessionKeys) {
      for (const [runId, active] of ops.chatAbortControllers) {
        if (active.sessionKey !== key || exceptRunIds.has(runId)) {
          continue;
        }
        if (abortChatRunById(ops, { runId, sessionKey: key, stopReason: reason }).aborted) {
          abortedRunIds.push(runId);
        }
      }
    }
  }

  // 6. Embedded run: unchanged, fired with the other aborts.
  if (keys.sessionId) {
    abortEmbeddedPiRun(keys.sessionId);
  }

  // Only now wait, each on today's 15 s budget. A turn that does not stop in time gets today's
  // embedded-path answer from the caller: UNAVAILABLE "still active".
  const replyIdle = await Promise.all(
    sessionKeys.map((key) => replyRunRegistry.waitForIdle(key, SESSION_TURN_END_TIMEOUT_MS)),
  );
  if (replyIdle.includes(false)) {
    // FORK 2026-10-02 (bug-log [reset-refused-after-a-turn]): name the holder and the key form, so
    // the next "still active" says what held it instead of leaving it to be guessed.
    const busy = sessionKeys
      .filter((_, i) => !replyIdle[i])
      .map((key) => {
        const op = replyRunRegistry.get(key);
        const startedAt = op?.startedAt;
        const age =
          typeof startedAt === "number" ? `${Math.round((Date.now() - startedAt) / 1000)}s` : "?";
        return `${key} (phase=${phaseBefore.get(key) ?? "none"}→${op?.phase ?? "gone"}, age=${age})`;
      });
    cleanupLog.warn(
      `${reason}: not ended — reply operation still active after ${SESSION_TURN_END_TIMEOUT_MS} ms for ${busy.join(", ")}`,
    );
    return { ended: false, abortedRunIds, unannouncedBacklog };
  }
  const ended = keys.sessionId
    ? await waitForEmbeddedPiRunEnd(keys.sessionId, SESSION_TURN_END_TIMEOUT_MS)
    : true;
  if (!ended) {
    cleanupLog.warn(
      `${reason}: not ended — embedded run of sessionId=${keys.sessionId} still active after ${SESSION_TURN_END_TIMEOUT_MS} ms (${keys.canonicalKey})`,
    );
  }
  if (ended) {
    // 5. Run set, once the turns have stopped, and only for runs registered before this cleanup
    //    began, so a turn another tab started on this key meanwhile keeps its entry. sessions.list
    //    stops reporting run.live now, not at the silent 30-minute sweep.
    for (const key of sessionKeys) {
      clearAgentRunContextsForSession(key, { registeredAtOrBefore: cleanupStartedAt });
    }
  }
  // 7. Holder A (diagnostic session state) goes idle by itself when dispatch returns (markIdle).
  // 8. Nothing is written here: no abortedLastRun, no settleSessionAfterAbort.
  return { ended, abortedRunIds, unannouncedBacklog };
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
  reason: "session-reset" | "session-delete";
  chatAbortOps?: ChatAbortOps;
}) {
  const closeTrackedBrowserTabs = async () => {
    const closeKeys = new Set<string>([
      params.key,
      params.target.canonicalKey,
      ...params.target.storeKeys,
      params.sessionId ?? "",
    ]);
    return await closeTrackedBrowserTabsForSessions({
      sessionKeys: [...closeKeys],
      onWarn: (message) => logVerbose(message),
    });
  };

  // Subagents are this session's children, not its turns: stopped ahead of endSessionTurns (they
  // used to be stopped between the queue clear and the embedded abort).
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  const turns = await endSessionTurns({
    keys: {
      requestedKey: params.key,
      canonicalKey: params.target.canonicalKey,
      storeKeys: params.target.storeKeys,
      sessionId: params.sessionId,
    },
    reason: params.reason,
    chatAbortOps: params.chatAbortOps,
  });
  if (turns.unannouncedBacklog > 0) {
    logVerbose(
      `sessions cleanup: ${turns.unannouncedBacklog} backlogged prompt(s) of ${params.target.canonicalKey} dropped with no chat terminal`,
    );
  }
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (!turns.ended) {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.key} is still active; try again in a moment.`,
    );
  }
  if (params.sessionId) {
    await retireSessionMcpRuntime({
      sessionId: params.sessionId,
      reason: "gateway-session-cleanup",
      onError: (error, sessionId) => {
        logVerbose(
          `sessions cleanup: failed to dispose bundle MCP runtime for ${sessionId}: ${String(error)}`,
        );
      },
    });
  }
  await closeTrackedBrowserTabs();
  return undefined;
}

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset" | "session-delete";
}) {
  if (!params.entry?.acp) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
      });
    },
  });
  if (cancelOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
        discardPersistentState: true,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      });
    },
  });
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  await ensureFreshAcpResetState({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    reason: params.reason,
    entry: params.entry,
  });
  return undefined;
}

function buildPendingAcpMeta(base: SessionAcpMeta, now: number): SessionAcpMeta {
  const currentIdentity = base.identity;
  const nextIdentity = currentIdentity
    ? {
        state: "pending" as const,
        ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
        source: currentIdentity.source,
        lastUpdatedAt: now,
      }
    : undefined;
  return {
    backend: base.backend,
    agent: base.agent,
    runtimeSessionName: base.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: base.mode,
    ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    state: "idle",
    lastActivityAt: now,
  };
}

async function ensureFreshAcpResetState(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: "session-reset" | "session-delete";
  entry?: SessionEntry;
}): Promise<void> {
  if (params.reason !== "session-reset" || !params.entry?.acp) {
    return;
  }
  const latestMeta = readAcpSessionEntry({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  })?.acp;
  if (
    !latestMeta?.identity ||
    latestMeta.identity.state !== "resolved" ||
    (!latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId)
  ) {
    return;
  }

  const backendId = (latestMeta.backend || params.cfg.acp?.backend || "").trim() || undefined;
  try {
    await getAcpRuntimeBackend(backendId)?.runtime.prepareFreshSession?.({
      sessionKey: params.sessionKey,
    });
  } catch (error) {
    logVerbose(
      `sessions.${params.reason}: ACP prepareFreshSession failed for ${params.sessionKey}: ${String(error)}`,
    );
  }

  const now = Date.now();
  await upsertAcpSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    mutate: (current, entry) => {
      const base = current ?? entry?.acp;
      if (!base) {
        return null;
      }
      return buildPendingAcpMeta(base, now);
    },
  });
}

export async function cleanupSessionBeforeMutation(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
  /** See performGatewaySessionReset's `chatAbortOps`. */
  chatAbortOps?: ChatAbortOps;
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    target: params.target,
    sessionId: params.entry?.sessionId,
    reason: params.reason,
    chatAbortOps: params.chatAbortOps,
  });
  if (cleanupError) {
    return cleanupError;
  }
  const pluginCleanup = await runPluginHostCleanup({
    cfg: params.cfg,
    registry: getActivePluginRegistry(),
    reason: params.reason === "session-reset" ? "reset" : "delete",
    sessionKey: params.target.canonicalKey ?? params.key,
  });
  for (const failure of pluginCleanup.failures) {
    logVerbose(
      `plugin host cleanup failed for ${failure.pluginId}/${failure.hookId}: ${String(failure.error)}`,
    );
  }
  return await closeAcpRuntimeForSession({
    cfg: params.cfg,
    sessionKey: params.legacyKey ?? params.canonicalKey ?? params.target.canonicalKey ?? params.key,
    entry: params.entry,
    reason: params.reason,
  });
}

function emitGatewayBeforeResetPluginHook(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  storePath: string;
  entry?: SessionEntry;
  reason: "new" | "reset";
}): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset")) {
    return;
  }

  const sessionKey = params.target.canonicalKey ?? params.key;
  const sessionId = params.entry?.sessionId;
  const sessionFile = params.entry?.sessionFile;
  const agentId = normalizeAgentId(params.target.agentId ?? resolveDefaultAgentId(params.cfg));
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  let messages: unknown[] = [];
  try {
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      messages = readSessionMessages(sessionId, params.storePath, sessionFile);
    }
  } catch (err) {
    logVerbose(
      `before_reset: failed to read session messages for ${sessionId ?? "(none)"}; firing hook with empty messages (${String(err)})`,
    );
  }

  void hookRunner
    .runBeforeReset(
      {
        sessionFile,
        messages,
        reason: params.reason,
      },
      {
        agentId,
        sessionKey,
        sessionId,
        workspaceDir,
      },
    )
    .catch((err) => {
      logVerbose(`before_reset hook failed: ${String(err)}`);
    });
}

export async function performGatewaySessionReset(params: {
  key: string;
  reason: "new" | "reset";
  commandSource: string;
  /**
   * The request's chat-run state (server-methods/chat.ts createChatAbortOps). With it the reset
   * ends the session's chat runs and backlogged prompts with one `chat` `aborted` each
   * (endSessionTurns); without it they get no terminal from the reset.
   */
  chatAbortOps?: ChatAbortOps;
}): Promise<
  | { ok: true; key: string; entry: SessionEntry }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const { cfg, target, storePath } = (() => {
    const cfg = getRuntimeConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key: params.key });
    return { cfg, target, storePath: target.storePath };
  })();
  const { entry, legacyKey, canonicalKey } = loadSessionEntry(params.key);
  const hadExistingEntry = Boolean(entry);
  const agentId = normalizeAgentId(target.agentId ?? resolveDefaultAgentId(cfg));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const hookEvent = createInternalHookEvent(
    "command",
    params.reason,
    target.canonicalKey ?? params.key,
    {
      sessionEntry: entry,
      previousSessionEntry: entry,
      commandSource: params.commandSource,
      cfg,
      workspaceDir,
    },
  );
  await triggerInternalHook(hookEvent);
  const mutationCleanupError = await cleanupSessionBeforeMutation({
    cfg,
    key: params.key,
    target,
    entry,
    legacyKey,
    canonicalKey,
    reason: "session-reset",
    chatAbortOps: params.chatAbortOps,
  });
  if (mutationCleanupError) {
    return { ok: false, error: mutationCleanupError };
  }

  let oldSessionId: string | undefined;
  let oldSessionFile: string | undefined;
  let resetSourceEntry: SessionEntry | undefined;
  const next = await updateSessionStore(storePath, (store) => {
    const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: params.key,
      store,
    });
    const currentEntry = store[primaryKey];
    resetSourceEntry = currentEntry ? { ...currentEntry } : undefined;
    const parsed = parseAgentSessionKey(primaryKey);
    const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resetPreservedSelection = resolveResetPreservedSelection({
      entry: currentEntry,
    });
    const resetEntry = {
      ...stripRuntimeModelState(currentEntry),
      providerOverride: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      authProfileOverride: undefined,
      authProfileOverrideSource: undefined,
      authProfileOverrideCompactionCount: undefined,
      ...resetPreservedSelection,
    };
    const resolvedModel = resolveSessionModelRef(cfg, resetEntry, sessionAgentId);
    oldSessionId = currentEntry?.sessionId;
    oldSessionFile = currentEntry?.sessionFile;
    const now = Date.now();
    const nextSessionId = randomUUID();
    const sessionFile = resolveSessionFilePath(
      nextSessionId,
      currentEntry?.sessionFile ? { sessionFile: currentEntry.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        storePath,
        agentId: sessionAgentId,
      }),
    );
    const nextEntry: SessionEntry = {
      sessionId: nextSessionId,
      sessionFile,
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: currentEntry?.thinkingLevel,
      fastMode: currentEntry?.fastMode,
      verboseLevel: currentEntry?.verboseLevel,
      traceLevel: currentEntry?.traceLevel,
      reasoningLevel: currentEntry?.reasoningLevel,
      elevatedLevel: currentEntry?.elevatedLevel,
      ttsAuto: currentEntry?.ttsAuto,
      execHost: currentEntry?.execHost,
      execSecurity: currentEntry?.execSecurity,
      execAsk: currentEntry?.execAsk,
      execNode: currentEntry?.execNode,
      responseUsage: currentEntry?.responseUsage,
      // Resets should keep the user's explicit selection, but clear any
      // temporary fallback model that was pinned during the previous run.
      ...resetPreservedSelection,
      groupActivation: currentEntry?.groupActivation,
      groupActivationNeedsSystemIntro: currentEntry?.groupActivationNeedsSystemIntro,
      chatType: currentEntry?.chatType,
      model: resolvedModel.model,
      modelProvider: resolvedModel.provider,
      contextTokens: resetEntry?.contextTokens,
      compactionCount: currentEntry?.compactionCount,
      compactionCheckpoints: currentEntry?.compactionCheckpoints,
      sendPolicy: currentEntry?.sendPolicy,
      queueMode: currentEntry?.queueMode,
      queueDebounceMs: currentEntry?.queueDebounceMs,
      queueCap: currentEntry?.queueCap,
      queueDrop: currentEntry?.queueDrop,
      spawnedBy: currentEntry?.spawnedBy,
      spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
      parentSessionKey: currentEntry?.parentSessionKey,
      forkedFromParent: currentEntry?.forkedFromParent,
      spawnDepth: currentEntry?.spawnDepth,
      subagentRole: currentEntry?.subagentRole,
      subagentControlScope: currentEntry?.subagentControlScope,
      label: currentEntry?.label,
      displayName: currentEntry?.displayName,
      channel: currentEntry?.channel,
      groupId: currentEntry?.groupId,
      subject: currentEntry?.subject,
      groupChannel: currentEntry?.groupChannel,
      space: currentEntry?.space,
      origin: snapshotSessionOrigin(currentEntry),
      deliveryContext: currentEntry?.deliveryContext,
      cliSessionBindings: currentEntry?.cliSessionBindings,
      cliSessionIds: currentEntry?.cliSessionIds,
      claudeCliSessionId: currentEntry?.claudeCliSessionId,
      lastChannel: currentEntry?.lastChannel,
      lastTo: currentEntry?.lastTo,
      lastAccountId: currentEntry?.lastAccountId,
      lastThreadId: currentEntry?.lastThreadId,
      skillsSnapshot: currentEntry?.skillsSnapshot,
      acp: currentEntry?.acp,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    };
    // FORK 2026-05-25 — clear CLI session bindings on reset so the
    // archived transcript can't be re-imported by chat.history.
    // Before this clear, the preserved cliSessionBindings.claude-cli
    // / cliSessionIds / claudeCliSessionId fields above pointed at
    // the OLD claude-cli sessionId. On the next chat.history, the
    // augmentChatHistoryWithCliSessionImports pass at
    // cli-session-history.ts:47 picked up that binding, read the
    // archived `~/.claude/projects/<cwd>/<oldId>.jsonl` transcript
    // back in, and the UI re-filled — the user typed /clear, hard-
    // refreshed, and the conversation came right back. Per user
    // 2026-05-25: "When a chat is cleared, there should be no going
    // back (unless I ask Jarvis to create a new tab with the
    // previous session)." Reset means reset: drop all the CLI
    // session pointers; the next chat.send spawns tinker-bridge fresh
    // (no --resume) under a new claude-cli sessionId, and the new
    // OpenClaw sessionId has no entry in tinker-bridge session-map.json
    // either, so the second augment-path is empty too.
    nextEntry.cliSessionBindings = undefined;
    nextEntry.cliSessionIds = undefined;
    nextEntry.claudeCliSessionId = undefined;
    store[primaryKey] = nextEntry;
    return nextEntry;
  });
  emitGatewayBeforeResetPluginHook({
    cfg,
    key: params.key,
    target,
    storePath,
    entry: resetSourceEntry,
    reason: params.reason,
  });

  const archivedTranscripts = archiveSessionTranscriptsForSessionDetailed({
    sessionId: oldSessionId,
    storePath,
    sessionFile: oldSessionFile,
    agentId: target.agentId,
    reason: "reset",
  });
  fs.mkdirSync(path.dirname(next.sessionFile as string), { recursive: true });
  if (!fs.existsSync(next.sessionFile as string)) {
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: next.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(next.sessionFile as string, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
  emitGatewaySessionEndPluginHook({
    cfg,
    sessionKey: target.canonicalKey ?? params.key,
    sessionId: oldSessionId,
    storePath,
    sessionFile: oldSessionFile,
    agentId: target.agentId,
    reason: params.reason,
    archivedTranscripts,
    nextSessionId: next.sessionId,
  });
  emitGatewaySessionStartPluginHook({
    cfg,
    sessionKey: target.canonicalKey ?? params.key,
    sessionId: next.sessionId,
    resumedFrom: oldSessionId,
  });
  if (hadExistingEntry) {
    await emitSessionUnboundLifecycleEvent({
      targetSessionKey: target.canonicalKey ?? params.key,
      reason: "session-reset",
    });
  }
  return { ok: true, key: target.canonicalKey, entry: next };
}
