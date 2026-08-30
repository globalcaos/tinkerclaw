import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { copyAnatomyEventsToNewKey } from "../../agents/context-anatomy-db.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/embedded-agent-runner/runs.js";
import { compactEmbeddedPiSession } from "../../agents/embedded-agent.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasInternalHookListeners,
  triggerInternalHook,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
} from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsAbortParams,
  validateSessionsCompactParams,
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionGetParams,
  validateSessionsCompactionListParams,
  validateSessionsCompactionRestoreParams,
  validateSessionsCreateParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsPatchParams,
  validateSessionsPluginPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsSendParams,
} from "../protocol/index.js";
import {
  getSessionCompactionCheckpoint,
  listSessionCompactionCheckpoints,
} from "../session-compaction-checkpoints.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadGatewaySessionRow,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionPreviewItemsFromTranscript,
  resolveDeletedAgentIdFromSessionKey,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
  readSessionMessages,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { chatHandlers } from "./chat.js";
import { suggestTitleViaBridge } from "./suggest-title.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

type SessionsRuntimeModule = typeof import("./sessions.runtime.js");

let sessionsRuntimeModulePromise: Promise<SessionsRuntimeModule> | undefined;

function loadSessionsRuntimeModule(): Promise<SessionsRuntimeModule> {
  sessionsRuntimeModulePromise ??= import("./sessions.runtime.js");
  return sessionsRuntimeModulePromise;
}

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = normalizeOptionalString(raw) ?? "";
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function rejectPluginRuntimeDeleteMismatch(params: {
  client: GatewayClient | null;
  key: string;
  entry: SessionEntry | undefined;
  respond: RespondFn;
}): boolean {
  const pluginOwnerId = normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId);
  if (!pluginOwnerId || !params.entry) {
    return false;
  }
  if (normalizeOptionalString(params.entry.pluginOwnerId) === pluginOwnerId) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Plugin "${pluginOwnerId}" cannot delete session "${params.key}" because it did not create it.`,
    ),
  );
  return true;
}

function resolveGatewaySessionTargetFromKey(key: string, cfg: OpenClawConfig) {
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function resolveOptionalInitialSessionMessage(params: {
  task?: unknown;
  message?: unknown;
}): string | undefined {
  if (typeof params.task === "string" && params.task.trim()) {
    return params.task;
  }
  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }
  return undefined;
}

function shouldAttachPendingMessageSeq(params: { payload: unknown; cached?: boolean }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

function emitSessionsChanged(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: { sessionKey?: string; reason: string; compacted?: boolean },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
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
            label: sessionRow.label,
            displayName: sessionRow.displayName,
            deliveryContext: sessionRow.deliveryContext,
            parentSessionKey: sessionRow.parentSessionKey,
            childSessions: sessionRow.childSessions,
            thinkingLevel: sessionRow.thinkingLevel,
            fastMode: sessionRow.fastMode,
            verboseLevel: sessionRow.verboseLevel,
            traceLevel: sessionRow.traceLevel,
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
            startedAt: sessionRow.startedAt,
            endedAt: sessionRow.endedAt,
            runtimeMs: sessionRow.runtimeMs,
            compactionCheckpointCount: sessionRow.compactionCheckpointCount,
            latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
            pluginExtensions: sessionRow.pluginExtensions,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete" | "compact" | "restore";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  // Allow webchat delete — handler already prevents deleting the main session
  if (params.action === "delete") {
    return false;
  }
  // FORK 2026-08-28 (the architect: manual evict/compact buttons in the CONTEXT WINDOW panel) — allow
  // webchat compact. This adds NO authority:
  //   - `sessions.compact` is ADMIN-scoped in method-scopes.ts, and that gate has already run by
  //     the time this handler is reached. This check is a client-CLASS check, not an authz one.
  //   - `/compact` is ALREADY reachable from exactly this client through `chat.send` — see
  //     handleCompactCommand in src/auto-reply/reply/commands-compact.ts. A webchat client can
  //     therefore run a narrative compaction today, by typing it.
  //   - The Tinker UI is the operator console, but it connects with mode "webchat" by
  //     construction (id "webchat-ui"), which is the only reason isWebchatClient catches it at
  //     all — the same asymmetry the model-picker carve-out documents below.
  // Deliberately NOT extended to patch/restore: those still stay behind the class check.
  if (params.action === "compact") {
    return false;
  }

  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

const DISPLAY_NAME_PATCH_KEYS = new Set(["key", "cookiePhrase", "cookiePhraseUserSet"]);
// FORK 2026-06-10 — u3-tab-naming: a patch that ONLY sets the display name
// (cookiePhrase / cookiePhraseUserSet) is safe to accept from the Tinker UI
// webchat client so a renamed/auto-named tab persists server-side. Every other
// session-metadata mutation stays behind rejectWebchatSessionMutation.
function isDisplayNameOnlyPatch(params: { [k: string]: unknown }): boolean {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined);
  return (
    keys.some((k) => k === "cookiePhrase" || k === "cookiePhraseUserSet") &&
    keys.every((k) => DISPLAY_NAME_PATCH_KEYS.has(k))
  );
}

const MODEL_PATCH_KEYS = new Set(["key", "model"]);
// FORK 2026-08-06 — the Tinker UI model picker. A patch that ONLY sets the session
// model (or clears it with `model: null`) is safe to accept from the webchat client,
// because that client can ALREADY write a durable override through `chat.send`'s
// `model` param — agent-command persists it as modelOverrideSource:"user". This adds
// no authority; it only lets the picker CLEAR what it can already SET.
//
// That asymmetry was the bug: pressing Auto dropped the client-side pin and sent no
// `model` param, so the stored override survived and every "Auto" turn kept routing to
// the last model pinned in that tab. `model: null` reaches
// applyModelOverrideToSessionEntry({ isDefault: true }), which deletes
// modelOverride/providerOverride so the default chain resolves again.
//
// Deliberately NARROW: `model` is the only mutable field allowed through, and only
// when it is the whole patch. Every other session-metadata mutation stays behind
// rejectWebchatSessionMutation.
function isModelOnlyPatch(params: { [k: string]: unknown }): boolean {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined);
  return keys.includes("model") && keys.every((k) => MODEL_PATCH_KEYS.has(k));
}

// FORK 2026-08-28 (the architect: the CONTEXT WINDOW panel's manual "evict" button) — transcript-aware
// EVICTION: drop the oldest turns, keep the newest, no model call.
//
// This exists instead of reusing the `maxLines` branch of sessions.compact, which does a raw
// `lines.slice(-maxLines)`. A pi transcript is NOT a flat log: line 0 is a `{type:"session"}`
// header and every later entry carries `id` + `parentId`, forming a chain that
// SessionManager.open(file).getBranch() walks (session-utils.fs.ts). A blind tail slice drops the
// header and severs that chain, so the branch walk stops at the first broken link and silently
// loses everything before it. `maxLines` is left exactly as it was — other callers depend on it —
// but it must not be what a button in the UI fires.
//
// Three rules make the rewrite safe:
//   1. EVERY non-message entry is kept regardless of position (session header, model_change,
//      thinking_level_change, custom). They are tiny, they are structural, and any of them may be
//      the parent of a kept message.
//   2. The cut is snapped FORWARD to a turn boundary: the first kept message must be a `user`
//      message carrying no tool-result blocks. Cutting mid-turn would orphan a toolResult from
//      its toolCall, which every provider rejects with an immediate 400. When no such boundary
//      exists at or after the target we keep MORE messages, never fewer.
//   3. The kept entries are re-chained — each one's `parentId` is rewritten to the previous kept
//      entry's `id` — so the walk is unbroken end to end.
export type TranscriptEvictionResult =
  | { ok: false; reason: string }
  | { ok: true; evicted: 0; evictedTokens: 0; kept: number; lines: null; reason: string }
  | {
      ok: true;
      evicted: number;
      /** ESTIMATE. ceil(chars / 3.5) over the dropped entries — the same ladder
       *  context-anatomy uses, so the panel's numbers stay on one scale. Never a billed count:
       *  nothing re-tokenises an evicted transcript, so a real figure does not exist. */
      evictedTokens: number;
      kept: number;
      lines: string[];
      reason?: undefined;
    };

/** True when a transcript entry's message carries a tool RESULT block. */
function entryCarriesToolResult(entry: { message?: unknown }): boolean {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    const type = (block as { type?: unknown } | null)?.type;
    return type === "tool_result" || type === "toolResult";
  });
}

/** The transcript's own role for an entry, or "" when it is not a message. */
function entryRole(entry: { type?: unknown; message?: unknown }): string {
  if (entry.type !== "message") {
    return "";
  }
  const role = (entry.message as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : "";
}

export function evictTranscriptTail(raw: string, keepFraction: number): TranscriptEvictionResult {
  const rawLines = raw.split(/\r?\n/).filter((l) => Boolean(normalizeOptionalString(l)));
  const entries: Array<Record<string, unknown>> = [];
  for (const line of rawLines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "unparsable transcript" };
      }
      entries.push(parsed as Record<string, unknown>);
    } catch {
      // Abort rather than write: a transcript we cannot fully parse is one we cannot safely
      // rewrite, and half-understanding it is how you lose a conversation.
      return { ok: false, reason: "unparsable transcript" };
    }
  }

  const messageIdx = entries.map((e, i) => (e.type === "message" ? i : -1)).filter((i) => i >= 0);
  if (messageIdx.length < 4) {
    return {
      ok: true,
      evicted: 0,
      evictedTokens: 0,
      kept: messageIdx.length,
      lines: null,
      reason: "too few messages to evict",
    };
  }

  // Target: keep the newest ceil(count * keepFraction), never fewer than 2.
  const targetKeep = Math.max(2, Math.ceil(messageIdx.length * keepFraction));
  const targetOrdinal = messageIdx.length - targetKeep;
  // Rule 2 — snap FORWARD from the target to the first safe boundary.
  let cutOrdinal = -1;
  for (let ord = targetOrdinal; ord < messageIdx.length; ord++) {
    const entry = entries[messageIdx[ord]];
    if (entryRole(entry) === "user" && !entryCarriesToolResult(entry)) {
      cutOrdinal = ord;
      break;
    }
  }
  if (cutOrdinal < 0 || cutOrdinal === 0) {
    // No safe boundary after the target (or the only one is the very first message): there is
    // nothing we can drop without risking an orphaned tool result.
    return {
      ok: true,
      evicted: 0,
      evictedTokens: 0,
      kept: messageIdx.length,
      lines: null,
      reason: "no safe turn boundary to evict at",
    };
  }

  const firstKeptIndex = messageIdx[cutOrdinal];
  const kept: Array<Record<string, unknown>> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Rule 1 — structural entries always survive; messages only from the cut onwards.
    if (entry.type !== "message" || i >= firstKeptIndex) {
      kept.push(entry);
    }
  }

  // Rule 3 — re-chain. The first kept entry keeps whatever parent link it had (it is the session
  // header in practice, which has none).
  let prevId: string | undefined;
  for (const entry of kept) {
    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (prevId !== undefined && "parentId" in entry) {
      entry.parentId = prevId;
    }
    if (id !== undefined) {
      prevId = id;
    }
  }

  const keptMessages = kept.filter((e) => e.type === "message").length;
  // Estimate what the eviction actually bought, in tokens. Measured over the DROPPED message
  // entries only — the structural entries all survive, so counting them would inflate the win.
  // ceil(chars / 3.5) is the anatomy's own ladder; reusing it keeps this number comparable with
  // the composition figures the panel shows beside it instead of introducing a second scale.
  const keptSet = new Set(kept);
  let droppedChars = 0;
  for (const entry of entries) {
    if (entry.type === "message" && !keptSet.has(entry)) {
      droppedChars += JSON.stringify(entry).length;
    }
  }
  return {
    ok: true,
    evicted: messageIdx.length - keptMessages,
    evictedTokens: Math.ceil(droppedChars / 3.5),
    kept: keptMessages,
    lines: kept.map((e) => JSON.stringify(e)),
  };
}

function buildDashboardSessionKey(agentId: string): string {
  return `agent:${agentId}:dashboard:${randomUUID()}`;
}

function cloneCheckpointSessionEntry(params: {
  currentEntry: SessionEntry;
  nextSessionId: string;
  nextSessionFile: string;
  label?: string;
  parentSessionKey?: string;
  totalTokens?: number;
  preserveCompactionCheckpoints?: boolean;
}): SessionEntry {
  return {
    ...params.currentEntry,
    sessionId: params.nextSessionId,
    sessionFile: params.nextSessionFile,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? params.totalTokens
        : undefined,
    totalTokensFresh:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? true
        : undefined,
    label: params.label ?? params.currentEntry.label,
    parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
    compactionCheckpoints: params.preserveCompactionCheckpoints
      ? params.currentEntry.compactionCheckpoints
      : undefined,
  };
}

function ensureSessionTranscriptFile(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
}): { ok: true; transcriptPath: string } | { ok: false; error: string } {
  try {
    const transcriptPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        storePath: params.storePath,
        agentId: params.agentId,
      }),
    );
    if (!fs.existsSync(transcriptPath)) {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    return { ok: true, transcriptPath };
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
  runId?: string;
}): string {
  const activeRunKey =
    typeof params.runId === "string"
      ? params.context.chatAbortControllers.get(params.runId)?.sessionKey
      : undefined;
  if (activeRunKey) {
    return activeRunKey;
  }
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.canonicalKey) {
      return params.canonicalKey;
    }
    if (active.sessionKey === params.requestedKey) {
      return params.requestedKey;
    }
  }
  return params.requestedKey;
}

function hasTrackedActiveSessionRun(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
}): boolean {
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.canonicalKey || active.sessionKey === params.requestedKey) {
      return true;
    }
  }
  return false;
}

async function interruptSessionRunIfActive(params: {
  req: GatewayRequestHandlerOptions["req"];
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const hasTrackedRun = hasTrackedActiveSessionRun({
    context: params.context,
    requestedKey: params.requestedKey,
    canonicalKey: params.canonicalKey,
  });
  const hasEmbeddedRun =
    typeof params.sessionId === "string" && params.sessionId
      ? isEmbeddedPiRunActive(params.sessionId)
      : false;

  if (!hasTrackedRun && !hasEmbeddedRun) {
    return { interrupted: false };
  }

  if (hasTrackedRun) {
    let abortOk = true;
    let abortError: ReturnType<typeof errorShape> | undefined;
    const abortSessionKey = resolveAbortSessionKey({
      context: params.context,
      requestedKey: params.requestedKey,
      canonicalKey: params.canonicalKey,
    });

    await chatHandlers["chat.abort"]({
      req: params.req,
      params: {
        sessionKey: abortSessionKey,
      },
      respond: (ok, _payload, error) => {
        abortOk = ok;
        abortError = error;
      },
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });

    if (!abortOk) {
      return {
        interrupted: true,
        error:
          abortError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session"),
      };
    }
  }

  if (hasEmbeddedRun && params.sessionId) {
    abortEmbeddedPiRun(params.sessionId);
  }

  clearSessionQueues([params.requestedKey, params.canonicalKey, params.sessionId]);

  if (hasEmbeddedRun && params.sessionId) {
    const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
    if (!ended) {
      return {
        interrupted: true,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${params.requestedKey} is still active; try again in a moment.`,
        ),
      };
    }
  }

  return { interrupted: true };
}

async function handleSessionSend(params: {
  method: "sessions.send" | "sessions.steer";
  req: GatewayRequestHandlerOptions["req"];
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  interruptIfActive: boolean;
}) {
  if (
    !assertValidParams(params.params, validateSessionsSendParams, params.method, params.respond)
  ) {
    return;
  }
  const p = params.params;
  const key = requireSessionKey((p as { key?: unknown }).key, params.respond);
  if (!key) {
    return;
  }
  const { cfg, entry, canonicalKey, storePath } = loadSessionEntry(key);
  // Reject sends/steers targeting sessions whose owning agent was deleted (#65524).
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, canonicalKey);
  if (deletedAgentId !== null) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Agent "${deletedAgentId}" no longer exists in configuration`,
      ),
    );
    return;
  }
  if (!entry?.sessionId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
    );
    return;
  }

  let interruptedActiveRun = false;
  if (params.interruptIfActive) {
    const interruptResult = await interruptSessionRunIfActive({
      req: params.req,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
      requestedKey: key,
      canonicalKey,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      params.respond(false, undefined, interruptResult.error);
      return;
    }
    interruptedActiveRun = interruptResult.interrupted;
  }

  const messageSeq = readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length + 1;
  let sendAcked = false;
  let sendPayload: unknown;
  let sendCached = false;
  let startedRunId: string | undefined;
  const rawIdempotencyKey = (p as { idempotencyKey?: string }).idempotencyKey;
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : randomUUID();
  await chatHandlers["chat.send"]({
    req: params.req,
    params: {
      sessionKey: canonicalKey,
      message: (p as { message: string }).message,
      thinking: (p as { thinking?: string }).thinking,
      attachments: (p as { attachments?: unknown[] }).attachments,
      timeoutMs: (p as { timeoutMs?: number }).timeoutMs,
      idempotencyKey,
    },
    respond: (ok, payload, error, meta) => {
      sendAcked = ok;
      sendPayload = payload;
      sendCached = meta?.cached === true;
      startedRunId =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId
          : undefined;
      if (ok && shouldAttachPendingMessageSeq({ payload, cached: meta?.cached === true })) {
        params.respond(
          true,
          {
            ...(payload && typeof payload === "object" ? payload : {}),
            messageSeq,
            ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
          },
          undefined,
          meta,
        );
        return;
      }
      params.respond(
        ok,
        ok && payload && typeof payload === "object"
          ? {
              ...payload,
              ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
            }
          : payload,
        error,
        meta,
      );
    },
    context: params.context,
    client: params.client,
    isWebchatConnect: params.isWebchatConnect,
  });
  if (sendAcked) {
    if (shouldAttachPendingMessageSeq({ payload: sendPayload, cached: sendCached })) {
      await reactivateCompletedSubagentSession({
        sessionKey: canonicalKey,
        runId: startedRunId,
      });
    }
    emitSessionsChanged(params.context, {
      sessionKey: canonicalKey,
      reason: interruptedActiveRun ? "steer" : "send",
    });
  }
}
export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const loadedCatalog = await context.loadGatewayModelCatalog().catch(() => undefined);
    const modelCatalog = Array.isArray(loadedCatalog) ? loadedCatalog : undefined;
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      modelCatalog,
      opts: p,
    });
    respond(true, result, undefined);
  },
  // FORK 2026-06-25: one-shot cc-bridge Sonnet title suggester. Read params
  // manually (no params-schema validator), like forensic.summarize.
  // SUBSCRIPTION-billed via the claude-code provider — not the metered API.
  "sessions.suggestTitle": async ({ params, respond, context }) => {
    const prompt =
      params && typeof (params as { prompt?: unknown }).prompt === "string"
        ? ((params as { prompt: string }).prompt as string)
        : "";
    if (!prompt) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "prompt required"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    const title = await suggestTitleViaBridge({ prompt, cfg });
    respond(true, { title }, undefined);
  },
  "sessions.subscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.subscribeSessionEvents(connId);
    }
    respond(true, { subscribed: Boolean(connId) }, undefined);
  },
  "sessions.unsubscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.unsubscribeSessionEvents(connId);
    }
    respond(true, { subscribed: false }, undefined);
  },
  "sessions.messages.subscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSubscribeParams,
        "sessions.messages.subscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.subscribeSessionMessageEvents(connId, canonicalKey);
      respond(true, { subscribed: true, key: canonicalKey }, undefined);
      return;
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.messages.unsubscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesUnsubscribeParams,
        "sessions.messages.unsubscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.unsubscribeSessionMessageEvents(connId, canonicalKey);
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.preview": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => normalizeOptionalString(key ?? ""))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.compaction.list": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionListParams,
        "sessions.compaction.list",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { entry, canonicalKey } = loadSessionEntry(key);
    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        checkpoints: listSessionCompactionCheckpoints(entry),
      },
      undefined,
    );
  },
  "sessions.compaction.get": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionGetParams,
        "sessions.compaction.get",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const checkpointId = normalizeOptionalString(p.checkpointId) ?? "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const { entry, canonicalKey } = loadSessionEntry(key);
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        checkpoint,
      },
      undefined,
    );
  },
  "sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const requestedKey = normalizeOptionalString(p.key);
    const agentId = normalizeAgentId(
      normalizeOptionalString(p.agentId) ?? resolveDefaultAgentId(cfg),
    );
    if (requestedKey) {
      const requestedAgentId = parseAgentSessionKey(requestedKey)?.agentId;
      if (requestedAgentId && requestedAgentId !== agentId && normalizeOptionalString(p.agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `sessions.create key agent (${requestedAgentId}) does not match agentId (${agentId})`,
          ),
        );
        return;
      }
    }
    const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
    let canonicalParentSessionKey: string | undefined;
    if (parentSessionKey) {
      const parent = loadSessionEntry(parentSessionKey);
      if (!parent.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown parent session: ${parentSessionKey}`),
        );
        return;
      }
      canonicalParentSessionKey = parent.canonicalKey;
    }
    const loweredRequestedKey = normalizeOptionalLowercaseString(requestedKey);
    const key = requestedKey
      ? loweredRequestedKey === "global" || loweredRequestedKey === "unknown"
        ? loweredRequestedKey
        : toAgentStoreSessionKey({
            agentId,
            requestKey: requestedKey,
            mainKey: cfg.session?.mainKey,
          })
      : buildDashboardSessionKey(agentId);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const targetAgentId = resolveAgentIdFromSessionKey(target.canonicalKey);
    const created = await updateSessionStore(target.storePath, async (store) => {
      const patched = await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: target.canonicalKey,
        patch: {
          key: target.canonicalKey,
          label: normalizeOptionalString(p.label),
          model: normalizeOptionalString(p.model),
        },
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
      if (!patched.ok || !canonicalParentSessionKey) {
        return patched;
      }
      const nextEntry: SessionEntry = {
        ...patched.entry,
        parentSessionKey: canonicalParentSessionKey,
      };
      store[target.canonicalKey] = nextEntry;
      return {
        ...patched,
        entry: nextEntry,
      };
    });
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    const ensured = ensureSessionTranscriptFile({
      sessionId: created.entry.sessionId,
      storePath: target.storePath,
      sessionFile: created.entry.sessionFile,
      agentId: targetAgentId,
    });
    if (!ensured.ok) {
      await updateSessionStore(target.storePath, (store) => {
        delete store[target.canonicalKey];
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to create session transcript: ${ensured.error}`),
      );
      return;
    }

    const createdEntry =
      created.entry.sessionFile === ensured.transcriptPath
        ? created.entry
        : {
            ...created.entry,
            sessionFile: ensured.transcriptPath,
          };
    if (createdEntry !== created.entry) {
      await updateSessionStore(target.storePath, (store) => {
        const existing = store[target.canonicalKey];
        if (existing) {
          store[target.canonicalKey] = {
            ...existing,
            sessionFile: ensured.transcriptPath,
          };
        }
      });
    }

    const initialMessage = resolveOptionalInitialSessionMessage(p);
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    const messageSeq = initialMessage
      ? readSessionMessages(createdEntry.sessionId, target.storePath, createdEntry.sessionFile)
          .length + 1
      : undefined;

    if (initialMessage) {
      await chatHandlers["chat.send"]({
        req,
        params: {
          sessionKey: target.canonicalKey,
          message: initialMessage,
          idempotencyKey: randomUUID(),
        },
        respond: (ok, payload, error, meta) => {
          if (ok && payload && typeof payload === "object") {
            runPayload = payload as Record<string, unknown>;
          } else {
            runError = error;
          }
          runMeta = meta;
        },
        context,
        client,
        isWebchatConnect,
      });
    }

    const runStarted =
      runPayload !== undefined &&
      shouldAttachPendingMessageSeq({
        payload: runPayload,
        cached: runMeta?.cached === true,
      });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        sessionId: createdEntry.sessionId,
        entry: createdEntry,
        runStarted,
        ...(runPayload ? runPayload : {}),
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
        ...(runError ? { runError } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "send",
      });
    }
  },
  // FORK 2026-06-24 — sessions.fork: true EAGER transcript fork for the Tinker "Clone tab" action.
  // The dashboard clones a tab by calling this RPC first; we copy the parent session's live
  // transcript into a brand-new session (via SessionManager.forkFrom — the same primitive that
  // powers compaction branch/restore), so the clone opens already showing the parent's full
  // conversation. The client falls back to lineage-only sessions.create ONLY if this RPC is absent.
  "sessions.fork": async ({ params, respond, context }) => {
    const p = params as { key?: unknown; label?: unknown };
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const loaded = loadSessionEntry(key);
    const { cfg, entry, canonicalKey } = loaded;
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const target = resolveGatewaySessionStoreTarget({ cfg, key: canonicalKey });
    // FORK 2026-07-16 — resolve the source transcript by sessionId the SAME way chat.history does,
    // instead of trusting entry.sessionFile. `tinker:*` sessions routinely carry a null/stale
    // sessionFile in the store while a real <sessionId>.jsonl exists on disk: chat.history finds it
    // (so the tab shows full history), but the old fork read entry.sessionFile directly, saw
    // null/stale, and bailed "session transcript is missing" — the client then fell back to an
    // EMPTY clone. Cloning a live, populated tinker tab must NOT come up blank.
    // See reference_tinker_clone_tab_and_session_fork_paths.
    const sourceFile = resolveSessionFilePath(
      entry.sessionId,
      entry.sessionFile ? { sessionFile: entry.sessionFile } : undefined,
      resolveSessionFilePathOptions({ agentId: target.agentId, storePath: target.storePath }),
    );
    if (!sourceFile || !fs.existsSync(sourceFile)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session transcript is missing"),
      );
      return;
    }
    const sourceSession = SessionManager.open(sourceFile, path.dirname(sourceFile));
    const forkedSession = SessionManager.forkFrom(
      sourceFile,
      sourceSession.getCwd(),
      path.dirname(sourceFile),
    );
    const forkedSessionFile = forkedSession.getSessionFile();
    if (!forkedSessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create fork transcript"),
      );
      return;
    }
    const nextKey = buildDashboardSessionKey(target.agentId);
    const label =
      normalizeOptionalString(p.label) ?? (entry.label?.trim() ? entry.label.trim() : undefined);
    const nextEntry = cloneCheckpointSessionEntry({
      currentEntry: entry,
      nextSessionId: forkedSession.getSessionId(),
      nextSessionFile: forkedSessionFile,
      label,
      parentSessionKey: canonicalKey,
    });
    await updateSessionStore(target.storePath, (store) => {
      store[nextKey] = nextEntry;
    });
    // Fork the EEG/anatomy trace alongside the transcript: copy the parent's
    // anatomy_events rows under the clone's new key so the clone's seismograph
    // restores durably on load (the client reconciles the EEG from the server,
    // keyed by session_key). Best-effort — an anatomy-DB hiccup must never fail
    // the transcript fork itself.
    try {
      copyAnatomyEventsToNewKey(canonicalKey, nextKey);
    } catch {
      // anatomy DB unavailable/locked — the transcript fork still succeeds
    }
    respond(
      true,
      {
        ok: true,
        sourceKey: canonicalKey,
        key: nextKey,
        sessionId: nextEntry.sessionId,
        entry: nextEntry,
      },
      undefined,
    );
    emitSessionsChanged(context, { sessionKey: nextKey, reason: "fork" });
  },
  "sessions.compaction.branch": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionBranchParams,
        "sessions.compaction.branch",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const loaded = loadSessionEntry(key);
    const { cfg, entry, canonicalKey } = loaded;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: canonicalKey });
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint?.preCompaction.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    if (!fs.existsSync(checkpoint.preCompaction.sessionFile)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "checkpoint snapshot transcript is missing"),
      );
      return;
    }

    const snapshotSession = SessionManager.open(
      checkpoint.preCompaction.sessionFile,
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const branchedSession = SessionManager.forkFrom(
      checkpoint.preCompaction.sessionFile,
      snapshotSession.getCwd(),
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const branchedSessionFile = branchedSession.getSessionFile();
    if (!branchedSessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create checkpoint branch transcript"),
      );
      return;
    }
    const nextKey = buildDashboardSessionKey(target.agentId);
    const label = entry.label?.trim() ? `${entry.label.trim()} (checkpoint)` : "Checkpoint branch";
    const nextEntry = cloneCheckpointSessionEntry({
      currentEntry: entry,
      nextSessionId: branchedSession.getSessionId(),
      nextSessionFile: branchedSessionFile,
      label,
      parentSessionKey: canonicalKey,
      totalTokens: checkpoint.tokensBefore,
    });

    await updateSessionStore(target.storePath, (store) => {
      store[nextKey] = nextEntry;
    });

    respond(
      true,
      {
        ok: true,
        sourceKey: canonicalKey,
        key: nextKey,
        sessionId: nextEntry.sessionId,
        checkpoint,
        entry: nextEntry,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: canonicalKey,
      reason: "checkpoint-branch",
    });
    emitSessionsChanged(context, {
      sessionKey: nextKey,
      reason: "checkpoint-branch",
    });
  },
  "sessions.compaction.restore": async ({
    req,
    params,
    respond,
    context,
    client,
    isWebchatConnect,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionRestoreParams,
        "sessions.compaction.restore",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "restore", client, isWebchatConnect, respond })) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const loaded = loadSessionEntry(key);
    const { entry, canonicalKey, storePath } = loaded;
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ entry, checkpointId });
    if (!checkpoint?.preCompaction.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    if (!fs.existsSync(checkpoint.preCompaction.sessionFile)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "checkpoint snapshot transcript is missing"),
      );
      return;
    }

    const interruptResult = await interruptSessionRunIfActive({
      req,
      context,
      client,
      isWebchatConnect,
      requestedKey: key,
      canonicalKey,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      respond(false, undefined, interruptResult.error);
      return;
    }

    const snapshotSession = SessionManager.open(
      checkpoint.preCompaction.sessionFile,
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const restoredSession = SessionManager.forkFrom(
      checkpoint.preCompaction.sessionFile,
      snapshotSession.getCwd(),
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const restoredSessionFile = restoredSession.getSessionFile();
    if (!restoredSessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to restore checkpoint transcript"),
      );
      return;
    }
    const nextEntry = cloneCheckpointSessionEntry({
      currentEntry: entry,
      nextSessionId: restoredSession.getSessionId(),
      nextSessionFile: restoredSessionFile,
      totalTokens: checkpoint.tokensBefore,
      preserveCompactionCheckpoints: true,
    });

    await updateSessionStore(storePath, (store) => {
      store[canonicalKey] = nextEntry;
    });

    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        sessionId: nextEntry.sessionId,
        checkpoint,
        entry: nextEntry,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: canonicalKey,
      reason: "checkpoint-restore",
    });
  },
  "sessions.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.send",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: false,
    });
  },
  "sessions.steer": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.steer",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: true,
    });
  },
  "sessions.abort": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    const abortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      runId: readStringValue(p.runId),
    });
    let abortedRunId: string | null = null;
    await chatHandlers["chat.abort"]({
      req,
      params: {
        sessionKey: abortSessionKey,
        runId: readStringValue(p.runId),
      },
      respond: (ok, payload, error, meta) => {
        if (!ok) {
          respond(ok, payload, error, meta);
          return;
        }
        const runIds =
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { runIds?: unknown[] }).runIds)
            ? (payload as { runIds: unknown[] }).runIds.filter((value): value is string =>
                Boolean(normalizeOptionalString(value)),
              )
            : [];
        abortedRunId = runIds[0] ?? null;
        respond(
          true,
          {
            ok: true,
            abortedRunId,
            status: abortedRunId ? "aborted" : "no-active-run",
          },
          undefined,
          meta,
        );
      },
      context,
      client,
      isWebchatConnect,
    });
    if (abortedRunId) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        reason: "abort",
      });
    }
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    // FORK 2026-06-10 — u3-tab-naming: allow a display-name-ONLY patch from the
    // Tinker UI webchat client (durable server-side tab names); block all else.
    if (
      !isDisplayNameOnlyPatch(p as unknown as { [k: string]: unknown }) &&
      !isModelOnlyPatch(p as unknown as { [k: string]: unknown }) &&
      rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })
    ) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }

    if (hasInternalHookListeners("session", "patch")) {
      const hookContext: SessionPatchHookContext = structuredClone({
        sessionEntry: applied.entry,
        patch: p,
        cfg,
      });
      const hookEvent: SessionPatchHookEvent = {
        type: "session",
        action: "patch",
        sessionKey: target.canonicalKey ?? key,
        context: hookContext,
        timestamp: new Date(),
        messages: [],
      };
      void triggerInternalHook(hookEvent);
    }

    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "patch",
    });
  },
  "sessions.pluginPatch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (
      !assertValidParams(params, validateSessionsPluginPatchParams, "sessions.pluginPatch", respond)
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    if (!scopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.pluginPatch requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    const pluginId = normalizeOptionalString(params.pluginId);
    const namespace = normalizeOptionalString(params.namespace);
    if (!pluginId || !namespace) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "pluginId and namespace are required"),
      );
      return;
    }
    if (params.unset === true && params.value !== undefined) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch cannot specify both unset and value",
        ),
      );
      return;
    }
    if (params.value !== undefined && !isPluginJsonValue(params.value)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch value must be JSON-compatible",
        ),
      );
      return;
    }
    const patched = await patchPluginSessionExtension({
      cfg: context.getRuntimeConfig(),
      sessionKey: key,
      pluginId,
      namespace,
      value: params.value,
      unset: params.unset === true,
    });
    if (!patched.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, patched.error));
      return;
    }
    respond(true, { ok: true, key: patched.key, value: patched.value }, undefined);
    emitSessionsChanged(context, {
      sessionKey: patched.key,
      reason: "plugin-patch",
    });
  },
  "sessions.reset": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const { performGatewaySessionReset } = await loadSessionsRuntimeModule();
    const result = await performGatewaySessionReset({
      key,
      reason,
      commandSource: "gateway:sessions.reset",
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, key: result.key, entry: result.entry }, undefined);
    emitSessionsChanged(context, {
      sessionKey: result.key,
      reason,
    });
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect, context }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
    const {
      archiveSessionTranscriptsForSessionDetailed,
      cleanupSessionBeforeMutation,
      emitGatewaySessionEndPluginHook,
      emitSessionUnboundLifecycleEvent,
    } = await loadSessionsRuntimeModule();

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    if (rejectPluginRuntimeDeleteMismatch({ client, key: canonicalKey ?? key, entry, respond })) {
      return;
    }
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    // FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts ("Tabs behavior" part 1):
    // SOFT-delete. Previously this site did `delete store[primaryKey]`,
    // physically removing the metadata entry; the user explicitly
    // asked for the entry to be kept so Jarvis can retrieve it later
    // ("it will stay somewhere Jarvis can retrieve if necessary").
    // Now we stamp `deletedAt = Date.now()` on the entry — the
    // sessions.list filter at session-utils.ts hides deletedAt entries
    // by default (the includeDeleted:true param surfaces them for
    // archaeology). The transcript file archival via
    // archiveSessionTranscriptsForSessionDetailed (below) is unchanged
    // — it still renames the JSONL with `.deleted.<ts>` suffix, so
    // BOTH the metadata + the transcript persist as soft-deleted.
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      const existing = store[primaryKey];
      if (!existing) {
        return false;
      }
      existing.deletedAt = Date.now();
      return true;
    });

    const archivedTranscripts =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSessionDetailed({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    const archived = archivedTranscripts.map((entry) => entry.archivedPath);
    if (deleted) {
      emitGatewaySessionEndPluginHook({
        cfg,
        sessionKey: target.canonicalKey ?? key,
        sessionId,
        storePath,
        sessionFile: entry?.sessionFile,
        agentId: target.agentId,
        reason: "deleted",
        archivedTranscripts,
      });
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
    if (deleted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "delete",
      });
    }
  },
  "sessions.get": ({ params, respond, context }) => {
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const { target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    const store = loadSessionStore(storePath);
    const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const allMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const messages = limit < allMessages.length ? allMessages.slice(-limit) : allMessages;
    respond(true, { messages }, undefined);
  },
  "sessions.compact": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "compact", client, isWebchatConnect, respond })) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : undefined;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(
      key,
      context.getRuntimeConfig(),
    );
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    // FORK 2026-08-28 — EVICTION mode. Checked FIRST: it is the only branch that rewrites the
    // transcript without a model call, and `keepFraction` is what selects it.
    const keepFraction =
      typeof p.keepFraction === "number" && Number.isFinite(p.keepFraction)
        ? p.keepFraction
        : undefined;
    if (keepFraction !== undefined) {
      // Rewriting a transcript under a live run is exactly the race that corrupts a session, so
      // stop the run first — the same call the narrative branch below makes.
      const interruptResult = await interruptSessionRunIfActive({
        req,
        context,
        client,
        isWebchatConnect,
        requestedKey: key,
        canonicalKey: target.canonicalKey,
        sessionId,
      });
      if (interruptResult.error) {
        respond(false, undefined, interruptResult.error);
        return;
      }

      const eviction = evictTranscriptTail(fs.readFileSync(filePath, "utf-8"), keepFraction);
      if (!eviction.ok) {
        respond(
          true,
          { ok: false, key: target.canonicalKey, compacted: false, reason: eviction.reason },
          undefined,
        );
        return;
      }
      if (eviction.lines === null) {
        // Nothing safely evictable — say so and leave the file byte-identical on disk.
        respond(
          true,
          {
            ok: true,
            key: target.canonicalKey,
            compacted: false,
            kept: eviction.kept,
            reason: eviction.reason,
          },
          undefined,
        );
        return;
      }

      const archivedTranscript = archiveFileOnDisk(filePath, "bak");
      fs.writeFileSync(filePath, `${eviction.lines.join("\n")}\n`, "utf-8");

      await updateSessionStore(storePath, (store) => {
        const entryKey = compactTarget.primaryKey;
        const entryToUpdate = store[entryKey];
        if (!entryToUpdate) {
          return;
        }
        // Same invalidation as the maxLines branch: every cached token count now describes a
        // transcript that no longer exists.
        delete entryToUpdate.inputTokens;
        delete entryToUpdate.outputTokens;
        delete entryToUpdate.totalTokens;
        delete entryToUpdate.totalTokensFresh;
        entryToUpdate.updatedAt = Date.now();
      });

      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: true,
          evicted: eviction.evicted,
          evictedTokens: eviction.evictedTokens,
          kept: eviction.kept,
          archived: archivedTranscript,
        },
        undefined,
      );
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "compact",
        compacted: true,
      });
      return;
    }

    if (maxLines === undefined) {
      const interruptResult = await interruptSessionRunIfActive({
        req,
        context,
        client,
        isWebchatConnect,
        requestedKey: key,
        canonicalKey: target.canonicalKey,
        sessionId,
      });
      if (interruptResult.error) {
        respond(false, undefined, interruptResult.error);
        return;
      }

      const resolvedModel = resolveSessionModelRef(cfg, entry, target.agentId);
      const workspaceDir =
        normalizeOptionalString(entry?.spawnedWorkspaceDir) ||
        resolveAgentWorkspaceDir(cfg, target.agentId);
      const result = await compactEmbeddedPiSession({
        sessionId,
        sessionKey: target.canonicalKey,
        allowGatewaySubagentBinding: true,
        sessionFile: filePath,
        workspaceDir,
        config: cfg,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        agentHarnessId: entry?.sessionId === sessionId ? entry.agentHarnessId : undefined,
        thinkLevel: normalizeThinkLevel(entry?.thinkingLevel),
        reasoningLevel: normalizeReasoningLevel(entry?.reasoningLevel),
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        trigger: "manual",
      });

      if (result.ok && result.compacted) {
        await updateSessionStore(storePath, (store) => {
          const entryKey = compactTarget.primaryKey;
          const entryToUpdate = store[entryKey];
          if (!entryToUpdate) {
            return;
          }
          entryToUpdate.updatedAt = Date.now();
          entryToUpdate.compactionCount = Math.max(0, entryToUpdate.compactionCount ?? 0) + 1;
          if (result.result?.sessionId && result.result.sessionId !== entryToUpdate.sessionId) {
            entryToUpdate.sessionId = result.result.sessionId;
          }
          if (result.result?.sessionFile) {
            entryToUpdate.sessionFile = result.result.sessionFile;
          }
          delete entryToUpdate.inputTokens;
          delete entryToUpdate.outputTokens;
          if (
            typeof result.result?.tokensAfter === "number" &&
            Number.isFinite(result.result.tokensAfter)
          ) {
            entryToUpdate.totalTokens = result.result.tokensAfter;
            entryToUpdate.totalTokensFresh = true;
          } else {
            delete entryToUpdate.totalTokens;
            delete entryToUpdate.totalTokensFresh;
          }
        });
      }

      respond(
        true,
        {
          ok: result.ok,
          key: target.canonicalKey,
          compacted: result.compacted,
          reason: result.reason,
          result: result.result,
        },
        undefined,
      );
      if (result.ok) {
        emitSessionsChanged(context, {
          sessionKey: target.canonicalKey,
          reason: "compact",
          compacted: result.compacted,
        });
      }
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => Boolean(normalizeOptionalString(l)));
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    // HAZARD (documented 2026-08-28, deliberately NOT changed — callers depend on this exact
    // behaviour): this is a blind tail slice of the raw JSONL. It drops the `{type:"session"}`
    // header on line 0 and severs the `parentId` chain, so SessionManager.getBranch() will stop
    // at the first broken link. Use `keepFraction` (the eviction branch above) for anything
    // user-facing; this path is an admin escape hatch.
    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "compact",
      compacted: true,
    });
  },
};
