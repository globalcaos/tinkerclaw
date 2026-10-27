import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { lookupContextTokens, resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  findModelCatalogEntry,
  modelSupportsInput,
  type ModelCatalogEntry,
} from "../agents/model-catalog.js";
import {
  inferUniqueProviderFromConfiguredModels,
  normalizeStoredOverrideModel,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  listSubagentRunsForController,
  resolveSubagentSessionStatus,
} from "../agents/subagent-registry-read.js";
import {
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  shouldKeepSubagentRunChildLink,
} from "../agents/subagent-run-liveness.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { resolveFollowupRunPromptKeys } from "../auto-reply/reply/queue/types.js";
import {
  listSteeredReplyPrompts,
  replyRunRegistry,
  type ReplyOperationPhase,
} from "../auto-reply/reply/reply-run-registry.js";
import { listThinkingLevelOptions } from "../auto-reply/thinking.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import {
  buildGroupDisplayName,
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveAgentMainSessionKey,
  resolveFreshSessionTotalTokens,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  type SessionStoreTarget,
  type SessionScope,
  updateSessionStore,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionRunLiveness } from "../infra/agent-events.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { readCompactionLedger } from "../infra/compaction-ledger.js";
import { projectPluginSessionExtensionsSync } from "../plugins/host-hook-state.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import {
  AVATAR_MAX_BYTES,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWorkspaceRelativeAvatarPath,
  resolveAvatarMime,
} from "../shared/avatar-policy.js";
import { fortuneForKey } from "../shared/fortune-cookies.js";
import { sessionVisibleToOperator } from "../shared/hivemind-seats.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
import { resolveReplyHolderKey } from "./reply-registry-key.js";
// FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts ("Tabs behavior" part 1):
// FORK 2026-05-24 (fourth pass) — bug task-mpjhzu3j-ma9ts: server-side
// lazy-mint restored, now drawing from the shared FORTUNE_COOKIES pool
// (src/shared/fortune-cookies.json — 218 long poetic greetings). The
// previous removal (second pass 000c7a0b7d) was on the assumption the
// client could patch via sessions.patch — but the
// `rejectWebchatSessionMutation` guard blocks webchat clients from
// patching. Server is the only path that can actually write cookiePhrase
// for chat-originated sessions. See bible session-naming.md history.
import {
  collectExistingPhrases,
  generateCookiePhrase,
  isLegacy2WordPhrase,
} from "./session-cookie-phrase.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import {
  readLatestSessionUsageFromTranscript,
  readSessionTitleFieldsFromTranscript,
} from "./session-utils.fs.js";
import type {
  GatewayAgentRow,
  GatewaySessionPendingPrompt,
  GatewaySessionPendingPromptState,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionRunStatus,
  SessionsListResult,
} from "./session-utils.types.js";

export {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  attachOpenClawTranscriptMeta,
  capArrayByJsonBytes,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readLatestSessionUsageFromTranscript,
  readSessionTitleFieldsFromTranscript,
  readSessionPreviewItemsFromTranscript,
  readSessionMessages,
  readSessionMessagesWithCursor,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";
export { canonicalizeSpawnedByForAgent, resolveSessionStoreKey } from "./session-store-key.js";
export type {
  GatewayAgentRow,
  GatewaySessionPendingPrompt,
  GatewaySessionPendingPromptState,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
  SessionsPatchResult,
  SessionsPreviewEntry,
  SessionsPreviewResult,
} from "./session-utils.types.js";

const DERIVED_TITLE_MAX_LEN = 60;

function tryResolveExistingPath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function resolveIdentityAvatarUrl(
  cfg: OpenClawConfig,
  agentId: string,
  avatar: string | undefined,
): string | undefined {
  if (!avatar) {
    return undefined;
  }
  const trimmed = normalizeOptionalString(avatar) ?? "";
  if (!trimmed) {
    return undefined;
  }
  if (isAvatarDataUrl(trimmed) || isAvatarHttpUrl(trimmed)) {
    return trimmed;
  }
  if (!isWorkspaceRelativeAvatarPath(trimmed)) {
    return undefined;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const workspaceRoot = tryResolveExistingPath(workspaceDir) ?? path.resolve(workspaceDir);
  const resolvedCandidate = path.resolve(workspaceRoot, trimmed);
  if (!isPathWithinRoot(workspaceRoot, resolvedCandidate)) {
    return undefined;
  }
  try {
    const opened = openBoundaryFileSync({
      absolutePath: resolvedCandidate,
      rootPath: workspaceRoot,
      rootRealPath: workspaceRoot,
      boundaryLabel: "workspace root",
      maxBytes: AVATAR_MAX_BYTES,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      return undefined;
    }
    try {
      const buffer = fs.readFileSync(opened.fd);
      const mime = resolveAvatarMime(resolvedCandidate);
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch {
    return undefined;
  }
}

function formatSessionIdPrefix(sessionId: string, updatedAt?: number | null): string {
  const prefix = sessionId.slice(0, 8);
  if (updatedAt && updatedAt > 0) {
    const d = new Date(updatedAt);
    const date = d.toISOString().slice(0, 10);
    return `${prefix} (${date})`;
  }
  return prefix;
}

function truncateTitle(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) {
    return cut.slice(0, lastSpace) + "…";
  }
  return cut + "…";
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }

  if (normalizeOptionalString(entry.displayName)) {
    return normalizeOptionalString(entry.displayName);
  }

  if (normalizeOptionalString(entry.subject)) {
    return normalizeOptionalString(entry.subject);
  }

  if (firstUserMessage?.trim()) {
    const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
    return truncateTitle(normalized, DERIVED_TITLE_MAX_LEN);
  }

  if (entry.sessionId) {
    return formatSessionIdPrefix(entry.sessionId, entry.updatedAt);
  }

  return undefined;
}

function resolveSessionRuntimeMs(
  run: { startedAt?: number; endedAt?: number; accumulatedRuntimeMs?: number } | null,
  now: number,
) {
  return getSubagentSessionRuntimeMs(run, now);
}

function resolvePositiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveNonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolveLatestCompactionCheckpoint(
  entry?: Pick<SessionEntry, "compactionCheckpoints"> | null,
): NonNullable<SessionEntry["compactionCheckpoints"]>[number] | undefined {
  const checkpoints = entry?.compactionCheckpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return undefined;
  }
  return checkpoints.reduce((latest, checkpoint) =>
    !latest || checkpoint.createdAt > latest.createdAt ? checkpoint : latest,
  );
}

function resolveEstimatedSessionCostUsd(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  entry?: Pick<
    SessionEntry,
    "estimatedCostUsd" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite"
  >;
  explicitCostUsd?: number;
}): number | undefined {
  const explicitCostUsd = resolveNonNegativeNumber(
    params.explicitCostUsd ?? params.entry?.estimatedCostUsd,
  );
  if (explicitCostUsd !== undefined) {
    return explicitCostUsd;
  }
  const input = resolvePositiveNumber(params.entry?.inputTokens);
  const output = resolvePositiveNumber(params.entry?.outputTokens);
  const cacheRead = resolvePositiveNumber(params.entry?.cacheRead);
  const cacheWrite = resolvePositiveNumber(params.entry?.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.cfg,
  });
  if (!cost) {
    return undefined;
  }
  const estimated = estimateUsageCost({
    usage: {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    cost,
  });
  return resolveNonNegativeNumber(estimated);
}

const STALE_STORE_ONLY_CHILD_LINK_MS = 60 * 60 * 1_000;

function isFinitePositiveTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isTerminalSessionStatus(status: unknown): status is Exclude<SessionRunStatus, "running"> {
  return status === "done" || status === "failed" || status === "killed" || status === "timeout";
}

function shouldKeepStoreOnlyChildLink(entry: SessionEntry, now: number): boolean {
  if (isTerminalSessionStatus(entry.status) || isFinitePositiveTimestamp(entry.endedAt)) {
    const endedAt = isFinitePositiveTimestamp(entry.endedAt) ? entry.endedAt : entry.updatedAt;
    return (
      isFinitePositiveTimestamp(endedAt) && now - endedAt <= RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS
    );
  }
  if (entry.status === "running" || isFinitePositiveTimestamp(entry.startedAt)) {
    return true;
  }
  return (
    isFinitePositiveTimestamp(entry.updatedAt) &&
    now - entry.updatedAt <= STALE_STORE_ONLY_CHILD_LINK_MS
  );
}

function resolveChildSessionKeys(
  controllerSessionKey: string,
  store: Record<string, SessionEntry>,
  now = Date.now(),
): string[] | undefined {
  const childSessionKeys = new Set<string>();
  for (const entry of listSubagentRunsForController(controllerSessionKey)) {
    const childSessionKey = normalizeOptionalString(entry.childSessionKey);
    if (!childSessionKey) {
      continue;
    }
    const latest = getSessionDisplaySubagentRunByChildSessionKey(childSessionKey);
    if (!latest) {
      continue;
    }
    const latestControllerSessionKey =
      normalizeOptionalString(latest?.controllerSessionKey) ||
      normalizeOptionalString(latest?.requesterSessionKey);
    if (latestControllerSessionKey !== controllerSessionKey) {
      continue;
    }
    if (
      !shouldKeepSubagentRunChildLink(latest, {
        activeDescendants: countActiveDescendantRuns(childSessionKey),
        now,
      })
    ) {
      continue;
    }
    childSessionKeys.add(childSessionKey);
  }
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || key === controllerSessionKey) {
      continue;
    }
    const spawnedBy = normalizeOptionalString(entry.spawnedBy);
    const parentSessionKey = normalizeOptionalString(entry.parentSessionKey);
    if (spawnedBy !== controllerSessionKey && parentSessionKey !== controllerSessionKey) {
      continue;
    }
    const latest = getSessionDisplaySubagentRunByChildSessionKey(key);
    if (latest) {
      const latestControllerSessionKey =
        normalizeOptionalString(latest.controllerSessionKey) ||
        normalizeOptionalString(latest.requesterSessionKey);
      if (latestControllerSessionKey !== controllerSessionKey) {
        continue;
      }
      if (
        !shouldKeepSubagentRunChildLink(latest, {
          activeDescendants: countActiveDescendantRuns(key),
          now,
        })
      ) {
        continue;
      }
    } else if (!shouldKeepStoreOnlyChildLink(entry, now)) {
      continue;
    }
    childSessionKeys.add(key);
  }
  const childSessions = Array.from(childSessionKeys);
  return childSessions.length > 0 ? childSessions : undefined;
}

function resolveTranscriptUsageFallback(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  storePath: string;
  fallbackProvider?: string;
  fallbackModel?: string;
}): {
  estimatedCostUsd?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  modelProvider?: string;
  model?: string;
} | null {
  const entry = params.entry;
  if (!entry?.sessionId) {
    return null;
  }
  const parsed = parseAgentSessionKey(params.key);
  const agentId = parsed?.agentId
    ? normalizeAgentId(parsed.agentId)
    : resolveDefaultAgentId(params.cfg);
  const snapshot = readLatestSessionUsageFromTranscript(
    entry.sessionId,
    params.storePath,
    entry.sessionFile,
    agentId,
  );
  if (!snapshot) {
    return null;
  }
  const modelProvider = snapshot.modelProvider ?? params.fallbackProvider;
  const model = snapshot.model ?? params.fallbackModel;
  const contextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: modelProvider,
    model,
    // Gateway/session listing is read-only; don't start async model discovery.
    allowAsyncLoad: false,
  });
  const estimatedCostUsd = resolveEstimatedSessionCostUsd({
    cfg: params.cfg,
    provider: modelProvider,
    model,
    explicitCostUsd: snapshot.costUsd,
    entry: {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheRead: snapshot.cacheRead,
      cacheWrite: snapshot.cacheWrite,
    },
  });
  return {
    modelProvider,
    model,
    totalTokens: resolvePositiveNumber(snapshot.totalTokens),
    totalTokensFresh: snapshot.totalTokensFresh === true,
    contextTokens: resolvePositiveNumber(contextTokens),
    estimatedCostUsd,
  };
}

/**
 * Returns the owning agent id if the session key belongs to an agent that is no
 * longer present in config (deleted). Returns null for non-agent legacy/global
 * keys, or when the owning agent still exists (#65524).
 */
export function resolveDeletedAgentIdFromSessionKey(
  cfg: OpenClawConfig,
  sessionKey: string,
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const agentId = normalizeAgentId(parsed.agentId);
  if (listAgentIds(cfg).includes(agentId)) {
    return null;
  }
  return agentId;
}

// FORK 2026-09-21 — loadSessionEntry used loadSessionStore's default
// clone:true, i.e. a structuredClone of the WHOLE store (~16 MB on the live
// gateway) on every call. It sits on the hot path of chat.history (~10/min
// from the Tinker UI), sessions.delete/reset and every sessions.changed
// broadcast (loadGatewaySessionRow), yet almost every caller reads only
// `entry`. The shared loader below returns the CACHED store object — a
// READ-ONLY contract, same as readSessionStoreCache({ clone: false }) — and
// the public wrappers copy only what they hand out.
function loadSessionEntryShared(sessionKey: string) {
  const cfg = getRuntimeConfig();
  const key = normalizeOptionalString(sessionKey) ?? "";
  const target = resolveGatewaySessionStoreTarget({
    cfg,
    key,
  });
  const storePath = target.storePath;
  // READ-ONLY: this is the cache's own object. Never mutate it here.
  const rawStore = loadSessionStore(storePath, { clone: false });
  const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(rawStore, target.storeKeys);
  const legacyKey = freshestMatch?.key !== target.canonicalKey ? freshestMatch?.key : undefined;
  return {
    cfg,
    storePath,
    rawStore,
    freshestMatch,
    canonicalKey: target.canonicalKey,
    legacyKey,
  };
}

type LoadedGatewaySessionEntry = {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  entry: SessionEntry | undefined;
  canonicalKey: string;
  legacyKey: string | undefined;
};

/**
 * Load one session entry. `entry` is a private deep copy (callers may mutate
 * it). `store` is a LAZY getter: the full-store structuredClone happens only
 * on first access, then is memoised. Inside that clone the matched key is
 * re-pointed at the returned `entry`, so `store[matchedKey] === entry` holds
 * exactly as it did when both came from one eagerly cloned store
 * (command-status.runtime hands both to createModelSelectionState).
 */
export function loadSessionEntry(sessionKey: string): LoadedGatewaySessionEntry {
  const { cfg, storePath, rawStore, freshestMatch, canonicalKey, legacyKey } =
    loadSessionEntryShared(sessionKey);
  const entry = freshestMatch ? structuredClone(freshestMatch.entry) : undefined;
  const matchedKey = freshestMatch?.key;
  let storeClone: Record<string, SessionEntry> | undefined;
  const result = {
    cfg,
    storePath,
    entry,
    canonicalKey,
    legacyKey,
  } as Omit<LoadedGatewaySessionEntry, "store"> as LoadedGatewaySessionEntry;
  Object.defineProperty(result, "store", {
    enumerable: true,
    configurable: true,
    get(): Record<string, SessionEntry> {
      if (!storeClone) {
        storeClone = structuredClone(rawStore);
        if (matchedKey !== undefined && entry) {
          storeClone[matchedKey] = entry;
        }
      }
      return storeClone;
    },
  });
  return result;
}

export function resolveFreshestSessionStoreMatchFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of storeKeys) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    const match = { key, entry };
    if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = match;
    }
  }
  return freshest;
}

export function resolveFreshestSessionEntryFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): SessionEntry | undefined {
  return resolveFreshestSessionStoreMatchFromStoreKeys(store, storeKeys)?.entry;
}

function findFreshestStoreMatch(
  store: Record<string, SessionEntry>,
  ...candidates: string[]
): { entry: SessionEntry; key: string } | undefined {
  const matches = new Map<string, { entry: SessionEntry; key: string }>();
  for (const candidate of candidates) {
    const trimmed = normalizeOptionalString(candidate) ?? "";
    if (!trimmed) {
      continue;
    }
    const exact = store[trimmed];
    if (exact) {
      matches.set(trimmed, { entry: exact, key: trimmed });
    }
    for (const key of findStoreKeysIgnoreCase(store, trimmed)) {
      const entry = store[key];
      if (entry) {
        matches.set(key, { entry, key });
      }
    }
  }
  if (matches.size === 0) {
    return undefined;
  }
  let freshest: { entry: SessionEntry; key: string } | undefined;
  for (const match of matches.values()) {
    if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = match;
    }
  }
  return freshest;
}

/**
 * Find all on-disk store keys that match the given key case-insensitively.
 * Returns every key from the store whose lowercased form equals the target's lowercased form.
 */
export function findStoreKeysIgnoreCase(
  store: Record<string, unknown>,
  targetKey: string,
): string[] {
  const lowered = normalizeLowercaseStringOrEmpty(targetKey);
  const matches: string[] = [];
  for (const key of Object.keys(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === lowered) {
      matches.push(key);
    }
  }
  return matches;
}

/**
 * Remove legacy key variants for one canonical session key.
 * Candidates can include aliases (for example, "agent:ops:main" when canonical is "agent:ops:work").
 */
export function pruneLegacyStoreKeys(params: {
  store: Record<string, unknown>;
  canonicalKey: string;
  candidates: Iterable<string>;
}) {
  const keysToDelete = new Set<string>();
  for (const candidate of params.candidates) {
    const trimmed = normalizeOptionalString(candidate ?? "") ?? "";
    if (!trimmed) {
      continue;
    }
    if (trimmed !== params.canonicalKey) {
      keysToDelete.add(trimmed);
    }
    for (const match of findStoreKeysIgnoreCase(params.store, trimmed)) {
      if (match !== params.canonicalKey) {
        keysToDelete.add(match);
      }
    }
  }
  for (const key of keysToDelete) {
    delete params.store[key];
  }
}

export function migrateAndPruneGatewaySessionStoreKey(params: {
  cfg: OpenClawConfig;
  key: string;
  store: Record<string, SessionEntry>;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
  });
  const primaryKey = target.canonicalKey;
  const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(
    params.store,
    target.storeKeys,
  );
  if (freshestMatch) {
    const currentPrimary = params.store[primaryKey];
    if (!currentPrimary || (freshestMatch.entry.updatedAt ?? 0) > (currentPrimary.updatedAt ?? 0)) {
      params.store[primaryKey] = freshestMatch.entry;
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

export function classifySessionKey(key: string, entry?: SessionEntry): GatewaySessionRow["kind"] {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

export function parseGroupKey(
  key: string,
): { channel?: string; kind?: "group" | "channel"; id?: string } | null {
  const agentParsed = parseAgentSessionKey(key);
  const rawKey = agentParsed?.rest ?? key;
  const parts = rawKey.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const [channel, kind, ...rest] = parts;
    if (kind === "group" || kind === "channel") {
      const id = rest.join(":");
      return { channel, kind, id };
    }
  }
  return null;
}

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function listExistingAgentIdsFromDisk(): string[] {
  const root = resolveStateDir();
  const agentsDir = path.join(root, "agents");
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  ids.add(defaultId);

  for (const entry of cfg.agents?.list ?? []) {
    if (entry?.id) {
      ids.add(normalizeAgentId(entry.id));
    }
  }

  for (const id of listExistingAgentIdsFromDisk()) {
    ids.add(id);
  }

  const sorted = Array.from(ids).filter(Boolean);
  sorted.sort((a, b) => a.localeCompare(b));
  return sorted.includes(defaultId)
    ? [defaultId, ...sorted.filter((id) => id !== defaultId)]
    : sorted;
}

function normalizeFallbackList(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function resolveGatewayAgentModel(
  cfg: OpenClawConfig,
  agentId: string,
): GatewayAgentRow["model"] | undefined {
  const primary = resolveAgentEffectiveModelPrimary(cfg, agentId)?.trim();
  const fallbackOverride = resolveAgentModelFallbacksOverride(cfg, agentId);
  const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const fallbacks = normalizeFallbackList(fallbackOverride ?? defaultFallbacks);
  if (!primary && fallbacks.length === 0) {
    return undefined;
  }
  return {
    ...(primary ? { primary } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

export function listAgentsForGateway(cfg: OpenClawConfig): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
} {
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<
    string,
    { name?: string; identity?: GatewayAgentRow["identity"] }
  >();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) {
      continue;
    }
    const identity = entry.identity
      ? {
          name: normalizeOptionalString(entry.identity.name),
          theme: normalizeOptionalString(entry.identity.theme),
          emoji: normalizeOptionalString(entry.identity.emoji),
          avatar: normalizeOptionalString(entry.identity.avatar),
          avatarUrl: resolveIdentityAvatarUrl(
            cfg,
            normalizeAgentId(entry.id),
            normalizeOptionalString(entry.identity.avatar),
          ),
        }
      : undefined;
    configuredById.set(normalizeAgentId(entry.id), {
      name: normalizeOptionalString(entry.name),
      identity,
    });
  }
  const explicitIds = new Set(
    (cfg.agents?.list ?? [])
      .map((entry) => (entry?.id ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
  let agentIds = listConfiguredAgentIds(cfg).filter((id) =>
    allowedIds ? allowedIds.has(id) : true,
  );
  if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) {
    agentIds = [...agentIds, mainKey];
  }
  const agents = agentIds.map((id) => {
    const meta = configuredById.get(id);
    const model = resolveGatewayAgentModel(cfg, id);
    return Object.assign(
      {
        id,
        name: meta?.name,
        identity: meta?.identity,
        workspace: resolveAgentWorkspaceDir(cfg, id),
      },
      model ? { model } : {},
    );
  });
  return { defaultId, mainKey, scope, agents };
}

function buildGatewaySessionStoreScanTargets(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.key && params.key !== params.canonicalKey) {
    targets.add(params.key);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
): SessionStoreTarget[] {
  const storeConfig = cfg.session?.store;
  const defaultTarget = {
    agentId,
    storePath: resolveStorePath(storeConfig, { agentId }),
  };
  if (!isStorePathTemplate(storeConfig)) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function resolveGatewaySessionStoreLookup(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
  initialStore?: Record<string, SessionEntry>;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
  match: { entry: SessionEntry; key: string } | undefined;
} {
  const scanTargets = buildGatewaySessionStoreScanTargets(params);
  const candidates = resolveGatewaySessionStoreCandidates(params.cfg, params.agentId);
  const fallback = candidates[0] ?? {
    agentId: params.agentId,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
  };
  let selectedStorePath = fallback.storePath;
  // FORK 2026-09-23 — READ-ONLY borrows (clone:false): the stores are only
  // scanned for keys and never leave resolveGatewaySessionStoreTarget, which
  // returns paths and key strings. The default clone:true deep-copied the WHOLE
  // store on every chat.history / loadGatewaySessionRow call (~20% of the live
  // gateway main thread). Never mutate `selectedStore` or `store` here.
  let selectedStore = params.initialStore ?? loadSessionStore(fallback.storePath, { clone: false });
  let selectedMatch = findFreshestStoreMatch(selectedStore, ...scanTargets);
  let selectedUpdatedAt = selectedMatch?.entry.updatedAt ?? Number.NEGATIVE_INFINITY;

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const store = loadSessionStore(candidate.storePath, { clone: false });
    const match = findFreshestStoreMatch(store, ...scanTargets);
    if (!match) {
      continue;
    }
    const updatedAt = match.entry.updatedAt ?? 0;
    // Mirror combined-store merge behavior so follow-up mutations target the
    // same backing store that won the listing merge when ids collide.
    if (!selectedMatch || updatedAt >= selectedUpdatedAt) {
      selectedStorePath = candidate.storePath;
      selectedStore = store;
      selectedMatch = match;
      selectedUpdatedAt = updatedAt;
    }
  }

  return {
    storePath: selectedStorePath,
    store: selectedStore,
    match: selectedMatch,
  };
}

function resolveExplicitDeletedLegacyMainStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  scanLegacyKeys?: boolean;
}): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} | null {
  const parsed = parseAgentSessionKey(params.key);
  const legacyAgentId = normalizeAgentId(parsed?.agentId);
  if (
    !parsed ||
    legacyAgentId !== DEFAULT_AGENT_ID ||
    listAgentIds(params.cfg).includes(legacyAgentId)
  ) {
    return null;
  }

  // Only preserve agent:main:* when it is backed by a discovered deleted-main store.
  // Shared-store legacy aliases should continue remapping to the configured default agent.
  const canonicalKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: legacyAgentId,
    sessionKey: params.key,
  });
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: legacyAgentId });
  const legacyAgentMainKey = `agent:${legacyAgentId}:main`;
  const lookupSeeds = Array.from(
    new Set([params.key, canonicalKey, agentMainKey, legacyAgentMainKey]),
  );
  let best:
    | {
        storePath: string;
        store: Record<string, SessionEntry>;
        match: { entry: SessionEntry; key: string };
      }
    | undefined;
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
    if (target.agentId !== legacyAgentId) {
      continue;
    }
    // READ-ONLY borrow: only scanned for keys; the result holds paths and strings.
    const store = loadSessionStore(target.storePath, { clone: false });
    const match = findFreshestStoreMatch(store, ...lookupSeeds);
    if (!match) {
      continue;
    }
    if (!best || (match.entry.updatedAt ?? 0) >= (best.match.entry.updatedAt ?? 0)) {
      best = { storePath: target.storePath, store, match };
    }
  }
  if (!best) {
    return null;
  }

  const storeKeys = new Set<string>([canonicalKey]);
  if (params.key !== canonicalKey) {
    storeKeys.add(params.key);
  }
  storeKeys.add(best.match.key);
  if (params.scanLegacyKeys !== false) {
    for (const seed of lookupSeeds) {
      storeKeys.add(seed);
      for (const legacyKey of findStoreKeysIgnoreCase(best.store, seed)) {
        storeKeys.add(legacyKey);
      }
    }
  }
  return {
    agentId: legacyAgentId,
    storePath: best.storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

export function resolveGatewaySessionStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  scanLegacyKeys?: boolean;
  store?: Record<string, SessionEntry>;
}): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const key = normalizeOptionalString(params.key) ?? "";
  const explicitDeletedMainTarget = resolveExplicitDeletedLegacyMainStoreTarget({
    cfg: params.cfg,
    key,
    scanLegacyKeys: params.scanLegacyKeys,
  });
  if (explicitDeletedMainTarget) {
    return explicitDeletedMainTarget;
  }

  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const { storePath, store } = resolveGatewaySessionStoreLookup({
    cfg: params.cfg,
    key,
    canonicalKey,
    agentId,
    initialStore: params.store,
  });

  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return { agentId, storePath, canonicalKey, storeKeys };
  }

  const storeKeys = new Set<string>();
  storeKeys.add(canonicalKey);
  if (key && key !== canonicalKey) {
    storeKeys.add(key);
  }
  if (params.scanLegacyKeys !== false) {
    // Scan the on-disk store for case variants of every target to find
    // legacy mixed-case entries (e.g. "agent:ops:MAIN" when canonical is "agent:ops:work").
    const scanTargets = buildGatewaySessionStoreScanTargets({
      cfg: params.cfg,
      key,
      canonicalKey,
      agentId,
    });
    for (const seed of scanTargets) {
      for (const legacyKey of findStoreKeysIgnoreCase(store, seed)) {
        storeKeys.add(legacyKey);
      }
    }
  }
  return {
    agentId,
    storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

export { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";

export function resolveGatewaySessionThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  modelCatalog?: ModelCatalogEntry[];
}) {
  const agentThinkingDefault = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault
    : undefined;
  return (
    agentThinkingDefault ??
    resolveThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      catalog: params.modelCatalog,
    })
  );
}

export function getSessionDefaults(
  cfg: OpenClawConfig,
  modelCatalog?: ModelCatalogEntry[],
): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const contextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model, { allowAsyncLoad: false }) ??
    DEFAULT_CONTEXT_TOKENS;
  const thinkingLevels = listThinkingLevelOptions(resolved.provider, resolved.model, modelCatalog);
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
    thinkingLevels,
    thinkingOptions: thinkingLevels.map((level) => level.label),
    thinkingDefault: resolveGatewaySessionThinkingDefault({
      cfg,
      provider: resolved.provider,
      model: resolved.model,
      modelCatalog,
    }),
  };
}

export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
): { provider: string; model: string } {
  const resolved = agentId
    ? resolveDefaultModelForAgent({ cfg, agentId })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });

  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });

  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: resolved.provider || DEFAULT_PROVIDER,
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
  });
  if (persisted) {
    return persisted;
  }
  return resolved;
}

export async function resolveGatewayModelSupportsImages(params: {
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  provider?: string;
  model?: string;
}): Promise<boolean> {
  if (!params.model) {
    return true;
  }

  try {
    const catalog = await params.loadGatewayModelCatalog();
    const modelEntry = findModelCatalogEntry(catalog, {
      provider: params.provider,
      modelId: params.model,
    });
    const normalizedProvider = normalizeOptionalLowercaseString(
      params.provider ?? modelEntry?.provider,
    );
    const normalizedCandidates = [
      normalizeLowercaseStringOrEmpty(params.model),
      normalizeLowercaseStringOrEmpty(modelEntry?.name),
    ].filter(Boolean);
    if (modelEntry) {
      if (modelSupportsInput(modelEntry, "image")) {
        return true;
      }
      // Legacy safety shim for stale persisted Foundry rows that predate
      // provider-owned capability normalization.
      if (
        normalizedProvider === "microsoft-foundry" &&
        normalizedCandidates.some(
          (candidate) =>
            candidate.startsWith("gpt-") ||
            candidate.startsWith("o1") ||
            candidate.startsWith("o3") ||
            candidate.startsWith("o4") ||
            candidate === "computer-use-preview",
        )
      ) {
        return true;
      }
      if (
        normalizedProvider === "claude-cli" &&
        normalizedCandidates.some(
          (candidate) =>
            candidate === "opus" ||
            candidate === "sonnet" ||
            candidate === "haiku" ||
            candidate.startsWith("claude-"),
        )
      ) {
        return true;
      }
      return false;
    }
    if (
      normalizedProvider === "claude-cli" &&
      normalizedCandidates.some(
        (candidate) =>
          candidate === "opus" ||
          candidate === "sonnet" ||
          candidate === "haiku" ||
          candidate.startsWith("claude-"),
      )
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveSessionModelIdentityRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
  fallbackModelRef?: string,
): { provider?: string; model: string } {
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: runtimeModel,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: runtimeModel };
    }
    if (runtimeModel.includes("/")) {
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER);
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
      return { model: runtimeModel };
    }
    return { model: runtimeModel };
  }
  const fallbackRef = fallbackModelRef?.trim();
  if (fallbackRef) {
    const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER);
    if (parsedFallback) {
      return { provider: parsedFallback.provider, model: parsedFallback.model };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: fallbackRef,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: fallbackRef };
    }
    return { model: fallbackRef };
  }
  const resolved = resolveSessionModelRef(cfg, entry, agentId);
  return { provider: resolved.provider, model: resolved.model };
}

/** Reply-operation phases whose prompt has not reached its run yet: §2 PREPARING. */
const PREPARING_REPLY_PHASES: ReadonlySet<ReplyOperationPhase> = new Set<ReplyOperationPhase>([
  "queued",
  "preflight_compacting",
  "memory_flushing",
]);

/** The two run-set facts deriveSessionPendingPrompts reads (see getSessionRunLiveness). */
type PendingPromptRunLiveness = Pick<
  ReturnType<typeof getSessionRunLiveness>,
  "live" | "lastActiveAt"
>;

/** One exact-key reading of the run set (getSessionRunLiveness): the row's `run` field. */
type SessionRunLiveness = ReturnType<typeof getSessionRunLiveness>;

/**
 * Two exact-key readings of the run set as one. A run context carries ONE session key, so no run is
 * counted twice: the counts add, `since` is the earlier and `lastActiveAt` the later of the two.
 */
function joinRunLiveness(a: SessionRunLiveness, b: SessionRunLiveness): SessionRunLiveness {
  const count = a.count + b.count;
  return {
    live: count > 0,
    count,
    heartbeatCount: a.heartbeatCount + b.heartbeatCount,
    since: pickDefinedNumber(a.since, b.since, Math.min),
    lastActiveAt: pickDefinedNumber(a.lastActiveAt, b.lastActiveAt, Math.max),
  };
}

function pickDefinedNumber(
  a: number | undefined,
  b: number | undefined,
  pick: (x: number, y: number) => number,
): number | undefined {
  return a === undefined ? b : b === undefined ? a : pick(a, b);
}

/**
 * FORK 2026-09-25 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §2 ACCEPTED, §4 holder C, §7 G5.
 * chat.send acks a prompt, then get-reply runs media and link understanding and the prepared-reply
 * setup before runReplyAgent creates the reply operation, which can take seconds. The steer, the
 * backlog and the reply operation all happen inside runReplyAgent, so in that span only the chat
 * abort controller (holder C) holds the prompt, and a sessions.list row built then listed the
 * session's other prompts and not this one. The UI had to keep a page-liveness veto so that the
 * absence did not read as LOST (tinker-ui/src/prompt-state.ts gatewayHolderFacts).
 *
 * chat.send marks that span here: from right after its ack until the reply pipeline PLACES the
 * prompt (its run starts, or it is steered, backlogged or dropped: onAgentRunStart and
 * onPromptDisposition), its controller is aborted (abortChatRunById aborts it), or its dispatch
 * settles or throws. Every way holder C lets go of the prompt also releases the mark, so a mark
 * never outlives its controller. deriveSessionPendingPrompts reports a marked key PREPARING: the
 * wire has no ACCEPTED state, and §2 gives ACCEPTED the same "preparing context" pill.
 *
 * WHY A MARK, NOT A READ OF THE CONTROLLERS MAP (prompt-queue.md §6.4 rejects a new per-prompt
 * store; this is a named exception). A controller lives for the WHOLE dispatch: through the run,
 * and through chat.send's transcript and final work after the run ends. A controller whose key no
 * reply operation names is either not placed yet or already answered, and only chat.send knows
 * which. Derived from the map alone, an answered prompt would come back PREPARING after its
 * terminal. The mark holds no "live" of its own: it is holder C's unplaced span, released by
 * holder C's own exits, and nothing but deriveSessionPendingPrompts reads it.
 */
type AcceptedChatSend = { sessionKey: string; since: number };
const acceptedChatSends = new Map<string, AcceptedChatSend>();

/**
 * Mark a chat.send prompt as accepted and not yet placed (see acceptedChatSends), under the store
 * key chat.send loaded. Returns the release, which drops only THIS mark and may be called any
 * number of times: a later send under the same key owns whatever mark is there by then. A prompt
 * with no key, or no session, is not marked (PQ-1).
 */
export function trackAcceptedChatSend(params: {
  promptKey: string;
  sessionKey: string | undefined;
  since: number;
}): () => void {
  const promptKey = normalizeOptionalString(params.promptKey);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!promptKey || !sessionKey) {
    return () => {};
  }
  const mark: AcceptedChatSend = { sessionKey, since: params.since };
  acceptedChatSends.set(promptKey, mark);
  return () => {
    if (acceptedChatSends.get(promptKey) === mark) {
      acceptedChatSends.delete(promptKey);
    }
  };
}

/** Test-only: drop every mark (session-utils.pending-prompts.test.ts). */
export function resetAcceptedChatSendsForTest(): void {
  acceptedChatSends.clear();
}

/**
 * FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 / §7 step G5. Every prompt of ONE
 * session that a gateway holder still owns, in the §2 state that holder puts it in. PQ-11
 * re-derives a prompt's state from this after a reload or reconnect, and PQ-5 counts a key's
 * absence as evidence for LOST.
 *
 * DERIVED, never stored: a per-prompt store would be an eighth holder of "live" (§6.4). Each state
 * comes from the holder that owns it:
 *   - PREPARING: the reply operation, through EVERY key it was created for (`promptKeys`; a
 *     coalesced follow-up answers several, all since the operation's `startedAt`), while its phase
 *     is `queued`, `preflight_compacting` or `memory_flushing`.
 *   - RUNNING: the same operation in phase `running`, while the run set holds a run of this session
 *     active since the operation began. The run registers synchronously right after the phase
 *     flips (agent-runner.ts → agent-runner-execution.ts registerAgentRunContext; followup-runner.ts
 *     registers it even earlier), and server-chat.ts clears it when the run's lifecycle ends (the
 *     same handler emits the chat final for a control-UI run). So a `running` operation with no such
 *     run is a turn whose run has ENDED and whose operation is only finishing up: its prompts are
 *     reported as nothing, never as RUNNING and never back as PREPARING (PQ-5; PQ-10, the run set
 *     owns "live"). "Active since the operation began" is read from getSessionRunLiveness's
 *     `lastActiveAt`, which this turn's run always satisfies; an earlier turn's run still emitting
 *     events satisfies it too, and agent-events.ts exposes no per-run read that would exclude it.
 *   - BEHIND: the follow-up queue, in queue order, one entry per key each item carries
 *     (queue/types.ts resolveFollowupRunPromptKeys: its `promptKeys`, then its `messageId`). A lost
 *     steer is re-enqueued as ONE item holding every buffered caller's key, so each one is BEHIND.
 *   - STEERED: prompts that turn accepted by steer (reply-run-registry.ts recordSteeredReplyPrompt,
 *     called by agent-runner.ts's steer branch), reported only while the turn is RUNNING, because
 *     they end with it (§2 STEERED → ANSWERED). The steer buffer holds its callers' keys only until
 *     it flushes, within 1.5 s, which is why the key is kept on the operation.
 *   - PREPARING, from holder C (§2 ACCEPTED, 2026-09-25): a chat.send prompt acked and not yet
 *     placed by the reply pipeline (trackAcceptedChatSend above), since its controller registered.
 *
 * ONE key, ONE state (PQ-2). When two holders name the same key, the first wins:
 *   1. the operation's own prompts. drain.ts leaves a follow-up item in `queue.items` until its run
 *      RETURNS (drainNextQueueItem shifts, and a collect batch is spliced, after the await), so the
 *      prompts a follow-up turn is answering are still queued while it runs;
 *   2. BEHIND over STEERED. A steer whose delivery was lost is re-enqueued as a follow-up
 *      (agent-runner.ts onDeliveryLost, the §2 STEERED → BEHIND edge), and the queue is the later
 *      fact;
 *   3. holder C last, and never for a key the reply operation names, even one it reports as
 *      nothing: a turn whose run has ended must not come back as PREPARING.
 * Output order is the same: the operation's prompts, then the queue in order, then steered prompts,
 * then accepted chat.send prompts in the order they were acked.
 *
 * In-memory holders only: no session-store read (failures.md M21, pinned by a spy in
 * session-utils.pending-prompts.test.ts). Returns undefined when nothing is pending, so the row
 * field is ABSENT rather than `[]`.
 *
 * KEY (2026-09-25). `sessionKey` is the row's STORE key (resolveSessionStoreKey: the combined store
 * sessions.list iterates, and loadGatewaySessionRow). The holders are keyed by the key
 * initSessionState registered the turn under, and for some configs the two part: with no `main`
 * agent and a renamed main key, a legacy `agent:main:<mainKey>` folds into
 * `agent:<default>:<mainKey>`, and a bare `x` into `agent:<default>:x`. resolveReplyHolderKey
 * (reply-registry-key.ts) picks the ONE key they are held under; the row key wins whenever it
 * holds anything, and an exact hit or an idle gateway reads no config. `getConfig` defaults to the
 * runtime config (buildGatewaySessionRow resolves the key itself, with the row's own `cfg`). The
 * run set is read under that same holder key, because agent-runner registers the operation's run
 * there too: `runLiveness` defaults to that reading, and a caller that passes one must read it
 * there. Holder C is matched on the row key (chat.send marks the store key it loaded) or the
 * holder key.
 */
export function deriveSessionPendingPrompts(
  sessionKey: string,
  runLiveness?: PendingPromptRunLiveness,
  getConfig: () => OpenClawConfig = getRuntimeConfig,
): GatewaySessionPendingPrompt[] | undefined {
  const rowKey = normalizeOptionalString(sessionKey);
  if (!rowKey) {
    return undefined;
  }
  const key = resolveReplyHolderKey(rowKey, getConfig);
  return derivePendingPromptsHeldUnder(rowKey, key, runLiveness ?? getSessionRunLiveness(key));
}

/**
 * deriveSessionPendingPrompts once the holder key is known: `rowKey` is the row's store key, `key`
 * the key its reply holders are read under, and `runLiveness` the run set read under `key`.
 */
function derivePendingPromptsHeldUnder(
  rowKey: string,
  key: string,
  runLiveness: PendingPromptRunLiveness,
): GatewaySessionPendingPrompt[] | undefined {
  const pending = new Map<string, GatewaySessionPendingPrompt>();
  const report = (
    promptKey: string | undefined,
    state: GatewaySessionPendingPromptState,
    since: number | undefined,
  ): void => {
    const normalizedKey = normalizeOptionalString(promptKey);
    // PQ-1: a prompt with no key has no identity to report, and a synthetic key would be matched
    // against the client's outbox. `since` is always a holder's own timestamp; only a hand-built
    // ReplyOperation double lacks `startedAt` (createReplyOperation always sets it).
    if (!normalizedKey || typeof since !== "number" || pending.has(normalizedKey)) {
      return;
    }
    pending.set(normalizedKey, { key: normalizedKey, state, since });
  };

  const operation = replyRunRegistry.get(key);
  // Every key the operation answers (a coalesced follow-up has several), all since its start.
  // `promptKeys` is absent only on a hand-built double; its `promptKey` is then the whole list.
  // Read whatever the operation's state: holder C yields every key the operation names (rule 3).
  const operationPromptKeys: ReadonlyArray<string | undefined> = operation
    ? (operation.promptKeys ?? [operation.promptKey])
    : [];
  let turnRunning = false;
  // `result` is set the moment an operation completes, fails or is aborted. An aborted one can stay
  // registered until its backend lets go, but its prompt's terminal is already on its way (PQ-6).
  if (operation && operation.result === null) {
    if (PREPARING_REPLY_PHASES.has(operation.phase)) {
      for (const promptKey of operationPromptKeys) {
        report(promptKey, "preparing", operation.startedAt);
      }
    } else if (operation.phase === "running") {
      turnRunning =
        runLiveness.live &&
        (runLiveness.lastActiveAt ?? Number.NEGATIVE_INFINITY) >=
          (operation.startedAt ?? Number.NEGATIVE_INFINITY);
      if (turnRunning) {
        for (const promptKey of operationPromptKeys) {
          report(promptKey, "running", operation.startedAt);
        }
      }
    }
  }

  for (const item of getExistingFollowupQueue(key)?.items ?? []) {
    // An item re-enqueued from a lost steer holds every buffered caller's key.
    for (const promptKey of resolveFollowupRunPromptKeys(item)) {
      report(promptKey, "behind", item.enqueuedAt);
    }
  }

  if (turnRunning) {
    for (const steered of listSteeredReplyPrompts(key)) {
      report(steered.key, "steered", steered.since);
    }
  }

  // HOLDER C, last (rule 3): a chat.send prompt acked and not yet placed by the reply pipeline.
  for (const [promptKey, accepted] of acceptedChatSends) {
    if (
      (accepted.sessionKey === rowKey || accepted.sessionKey === key) &&
      !operationPromptKeys.includes(promptKey)
    ) {
      report(promptKey, "preparing", accepted.since);
    }
  }

  return pending.size > 0 ? [...pending.values()] : undefined;
}

export function buildGatewaySessionRow(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  key: string;
  entry?: SessionEntry;
  modelCatalog?: ModelCatalogEntry[];
  now?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
}): GatewaySessionRow {
  const { cfg, storePath, store, key, entry } = params;
  const now = params.now ?? Date.now();
  const updatedAt = entry?.updatedAt ?? null;
  const parsed = parseGroupKey(key);
  const channel = entry?.channel ?? parsed?.channel;
  const subject = entry?.subject;
  const groupChannel = entry?.groupChannel;
  const space = entry?.space;
  const id = parsed?.id;
  const origin = entry?.origin;
  const originLabel = origin?.label;
  // FORK 2026-05-23 — filter out known WS-client identification strings that
  // were leaking into session displayName via origin.label. The Tinker UI
  // WS-client connects with `client.displayName = "Tinker UI"` (see
  // tinker-ui/src/app.ts:1211) to identify itself for pairing + security
  // audit. That string was inheriting into every chat-originated session's
  // origin.label and surfacing in the right-panel sessions list as a
  // useless label like "Tinker UI" on every freshly-cleared main tab and
  // every orphaned tinker:* session whose tab has since been closed.
  // The filter applies to BOTH entry.displayName and origin.label so it
  // catches old persisted rows + new query-time resolutions; meaningful
  // origin labels (e.g. "jarvis-inject", group titles) pass through.
  const GENERIC_WS_CLIENT_LABELS = new Set(["Tinker UI", "webchat-ui", "openclaw-cli"]);
  const cleanedEntryDisplayName =
    entry?.displayName && !GENERIC_WS_CLIENT_LABELS.has(entry.displayName)
      ? entry.displayName
      : undefined;
  const cleanedOriginLabel =
    originLabel && !GENERIC_WS_CLIENT_LABELS.has(originLabel) ? originLabel : undefined;
  const displayName =
    cleanedEntryDisplayName ??
    (channel
      ? buildGroupDisplayName({
          provider: channel,
          subject,
          groupChannel,
          space,
          id,
          key,
        })
      : undefined) ??
    entry?.label ??
    cleanedOriginLabel;
  const deliveryFields = normalizeSessionDeliveryFields(entry);
  const parsedAgent = parseAgentSessionKey(key);
  const sessionAgentId = normalizeAgentId(parsedAgent?.agentId ?? resolveDefaultAgentId(cfg));
  const subagentRun = getSessionDisplaySubagentRunByChildSessionKey(key);
  const subagentOwner =
    normalizeOptionalString(subagentRun?.controllerSessionKey) ||
    normalizeOptionalString(subagentRun?.requesterSessionKey);
  const liveSubagentRunActive = isSubagentRunLive(subagentRun);
  const persistedSessionStatus = entry?.status;
  const persistedSessionEndedAt = entry?.endedAt;
  const persistedSessionStartedAt = entry?.startedAt;
  const persistedSessionRuntimeMs = entry?.runtimeMs;
  const subagentRunState = subagentRun
    ? liveSubagentRunActive
      ? "active"
      : typeof subagentRun.endedAt === "number" ||
          persistedSessionStatus === "done" ||
          persistedSessionStatus === "failed" ||
          persistedSessionStatus === "killed" ||
          persistedSessionStatus === "timeout" ||
          typeof persistedSessionEndedAt === "number"
        ? "historical"
        : "interrupted"
    : undefined;
  const subagentStatus = subagentRun
    ? liveSubagentRunActive
      ? resolveSubagentSessionStatus(subagentRun)
      : persistedSessionStatus === "running"
        ? undefined
        : (persistedSessionStatus ??
          (typeof subagentRun.endedAt === "number"
            ? resolveSubagentSessionStatus(subagentRun)
            : undefined))
    : undefined;
  const subagentStartedAt = subagentRun
    ? liveSubagentRunActive
      ? getSubagentSessionStartedAt(subagentRun)
      : (persistedSessionStartedAt ?? getSubagentSessionStartedAt(subagentRun))
    : undefined;
  const subagentEndedAt = subagentRun
    ? liveSubagentRunActive
      ? subagentRun.endedAt
      : (persistedSessionEndedAt ?? subagentRun.endedAt)
    : undefined;
  const subagentRuntimeMs = subagentRun
    ? liveSubagentRunActive
      ? resolveSessionRuntimeMs(subagentRun, now)
      : (persistedSessionRuntimeMs ??
        (typeof subagentRun.endedAt === "number"
          ? resolveSessionRuntimeMs(subagentRun, now)
          : undefined))
    : undefined;
  const selectedModel = entry?.modelOverride?.trim()
    ? resolveSessionModelRef(cfg, entry, sessionAgentId)
    : null;
  const resolvedModel = resolveSessionModelIdentityRef(
    cfg,
    entry,
    sessionAgentId,
    subagentRun?.model,
  );
  const runtimeModelPresent =
    Boolean(entry?.model?.trim()) || Boolean(entry?.modelProvider?.trim());
  const needsTranscriptTotalTokens =
    resolvePositiveNumber(resolveFreshSessionTotalTokens(entry)) === undefined;
  const needsTranscriptContextTokens = resolvePositiveNumber(entry?.contextTokens) === undefined;
  const needsTranscriptEstimatedCostUsd =
    resolveEstimatedSessionCostUsd({
      cfg,
      provider: resolvedModel.provider,
      model: resolvedModel.model ?? DEFAULT_MODEL,
      entry,
    }) === undefined;
  const transcriptUsage =
    needsTranscriptTotalTokens || needsTranscriptContextTokens || needsTranscriptEstimatedCostUsd
      ? resolveTranscriptUsageFallback({
          cfg,
          key,
          entry,
          storePath,
          fallbackProvider: resolvedModel.provider,
          fallbackModel: resolvedModel.model ?? DEFAULT_MODEL,
        })
      : null;
  const preferLiveSubagentModelIdentity =
    Boolean(subagentRun?.model?.trim()) && subagentStatus === "running";
  const shouldUseTranscriptModelIdentity =
    runtimeModelPresent &&
    !preferLiveSubagentModelIdentity &&
    (needsTranscriptTotalTokens || needsTranscriptContextTokens);
  const resolvedModelIdentity = {
    provider: resolvedModel.provider,
    model: resolvedModel.model ?? DEFAULT_MODEL,
  };
  const modelIdentity = shouldUseTranscriptModelIdentity
    ? {
        provider: transcriptUsage?.modelProvider ?? resolvedModelIdentity.provider,
        model: transcriptUsage?.model ?? resolvedModelIdentity.model,
      }
    : resolvedModelIdentity;
  const { provider: modelProvider, model } = modelIdentity;
  const totalTokens =
    resolvePositiveNumber(resolveFreshSessionTotalTokens(entry)) ??
    resolvePositiveNumber(transcriptUsage?.totalTokens);
  const totalTokensFresh =
    typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0
      ? true
      : transcriptUsage?.totalTokensFresh === true;
  const childSessions = resolveChildSessionKeys(key, store, now);
  const latestCompactionCheckpoint = resolveLatestCompactionCheckpoint(entry);
  const estimatedCostUsd =
    resolveEstimatedSessionCostUsd({
      cfg,
      provider: modelProvider,
      model,
      entry,
    }) ?? resolveNonNegativeNumber(transcriptUsage?.estimatedCostUsd);
  const contextTokens =
    resolvePositiveNumber(entry?.contextTokens) ??
    resolvePositiveNumber(transcriptUsage?.contextTokens) ??
    resolvePositiveNumber(
      resolveContextTokensForModel({
        cfg,
        provider: modelProvider,
        model,
        // Gateway/session listing is read-only; don't start async model discovery.
        allowAsyncLoad: false,
      }),
    );

  let derivedTitle: string | undefined;
  let lastMessagePreview: string | undefined;
  if (entry?.sessionId && (params.includeDerivedTitles || params.includeLastMessage)) {
    const fields = readSessionTitleFieldsFromTranscript(
      entry.sessionId,
      storePath,
      entry.sessionFile,
      sessionAgentId,
    );
    if (params.includeDerivedTitles) {
      derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
    }
    if (params.includeLastMessage && fields.lastMessagePreview) {
      lastMessagePreview = fields.lastMessagePreview;
    }
  }

  const rowModelProvider = selectedModel?.provider ?? modelProvider;
  const rowModel = selectedModel?.model ?? model;
  const thinkingProvider = rowModelProvider ?? DEFAULT_PROVIDER;
  const thinkingModel = rowModel ?? DEFAULT_MODEL;
  const thinkingLevels = listThinkingLevelOptions(
    thinkingProvider,
    thinkingModel,
    params.modelCatalog,
  );
  const pluginExtensions = entry
    ? projectPluginSessionExtensionsSync({ sessionKey: key, entry })
    : [];
  // FORK 2026-09-24 (prompt-queue.md §7 G5) — ONE observation of the run set serves both `run` and
  // `pendingPrompts`, so the two fields cannot disagree about a run that registers between them.
  // FORK 2026-09-25 — read under the HOLDER key (reply-registry-key.ts resolveReplyHolderKey). For
  // some configs the reply pipeline registers a turn's operation, queue and run under a key the
  // store folds into this row, and a reading under the row key alone reported that turn's prompts
  // PREPARING or BEHIND but never RUNNING, with `run.live` false while it ran. `pendingPrompts`
  // reads the holder key's run set, where agent-runner registers the operation's run; `run` joins
  // it with the row key's own reading, so the row never loses a run it showed before. An ordinary
  // row (its own key is the holder key) takes one reading, as before. The row's own `cfg` decides
  // the fold, as it decides everything else here.
  const holderKey = resolveReplyHolderKey(key, () => cfg);
  const heldRunLiveness = getSessionRunLiveness(holderKey, now);
  const runLiveness =
    holderKey === key
      ? heldRunLiveness
      : joinRunLiveness(getSessionRunLiveness(key, now), heldRunLiveness);
  const pendingPrompts = derivePendingPromptsHeldUnder(key, holderKey, heldRunLiveness);
  // FORK 2026-09-24 (context-window-panel.md §6.1 A7; failures.md M21) — the compaction LEDGER's
  // per-session figures, from memory only (src/infra/compaction-ledger.ts). Undefined until the
  // session's history from earlier gateway processes is seeded; the first read of an unseeded
  // session queues that seed on the events writer's worker. Until then the row carries none of
  // the ledger's fields (P10: absent, not zero).
  const compactionLedger = readCompactionLedger(key, now);

  return {
    key,
    spawnedBy: subagentOwner || entry?.spawnedBy,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    forkedFromParent: entry?.forkedFromParent,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
    kind: classifySessionKey(key, entry),
    label: entry?.label,
    displayName,
    // FORK 2026-05-24 (bug task-mpjhzu3j-ma9ts) — surface cookiePhrase
    // and deletedAt to the client. The Tinker UI's renderSessionRow uses
    // cookiePhrase as the primary display name for non-main sessions
    // (above generic-filtered label/displayName); deletedAt presence is
    // an audit signal (only reaches the client when includeDeleted is
    // requested, since the lister filters by default).
    cookiePhrase: entry?.cookiePhrase,
    cookiePhraseUserSet: entry?.cookiePhraseUserSet,
    deletedAt: entry?.deletedAt,
    derivedTitle,
    lastMessagePreview,
    channel,
    subject,
    groupChannel,
    space,
    chatType: entry?.chatType,
    origin,
    updatedAt,
    sessionId: entry?.sessionId,
    systemSent: entry?.systemSent,
    abortedLastRun: entry?.abortedLastRun,
    thinkingLevel: entry?.thinkingLevel,
    thinkingLevels,
    thinkingOptions: thinkingLevels.map((level) => level.label),
    thinkingDefault: resolveGatewaySessionThinkingDefault({
      cfg,
      provider: thinkingProvider,
      model: thinkingModel,
      agentId: sessionAgentId,
      modelCatalog: params.modelCatalog,
    }),
    fastMode: entry?.fastMode,
    verboseLevel: entry?.verboseLevel,
    traceLevel: entry?.traceLevel,
    reasoningLevel: entry?.reasoningLevel,
    elevatedLevel: entry?.elevatedLevel,
    sendPolicy: entry?.sendPolicy,
    inputTokens: entry?.inputTokens,
    outputTokens: entry?.outputTokens,
    totalTokens,
    totalTokensFresh,
    estimatedCostUsd,
    status: subagentRun ? subagentStatus : entry?.status,
    // FORK 2026-07-29 — publish THE RUN SET alongside the persisted status. `status` above is a
    // verbatim passthrough of the archive and can latch at "running" (measured live) or be absent
    // (measured on 61 of 348 rows); this is what the PROCESS is actually holding open right now.
    // Additive: stage 2 publishes, no surface reads it yet.
    run: runLiveness,
    subagentRunState,
    hasActiveSubagentRun: subagentRun ? liveSubagentRunActive : undefined,
    startedAt: subagentRun ? subagentStartedAt : entry?.startedAt,
    endedAt: subagentRun ? subagentEndedAt : entry?.endedAt,
    runtimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs,
    parentSessionKey: subagentOwner || entry?.parentSessionKey,
    childSessions,
    responseUsage: entry?.responseUsage,
    modelProvider: rowModelProvider,
    model: rowModel,
    // FORK 2026-08-29 — publish the DURABLE PIN alongside the runtime pair above. The pair is
    // `pin ?? last-served`, so it cannot answer "is this session on Auto?"; these three fields
    // can, by presence. `selectedModel` (computed above, non-null only when entry.modelOverride
    // is set) is already exactly the resolved pin — no new computation — and lines 1469-1470
    // are untouched, so the pair keeps meaning "what served" for every existing consumer.
    modelOverride: selectedModel?.model,
    providerOverride: selectedModel?.provider,
    modelOverrideSource: entry?.modelOverrideSource,
    contextTokens,
    deliveryContext: deliveryFields.deliveryContext,
    lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
    lastTo: deliveryFields.lastTo ?? entry?.lastTo,
    lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
    lastThreadId: deliveryFields.lastThreadId ?? entry?.lastThreadId,
    compactionCheckpointCount: entry?.compactionCheckpoints?.length,
    latestCompactionCheckpoint,
    // FORK 2026-09-24 (context-window-panel.md §6.1 A7) — the entry's own durable counter as
    // stored (absent when it never recorded one), then the ledger's figures: the view already
    // omits every value the ledger cannot state (P10), so the spread adds only known keys.
    ...(entry?.compactionCount !== undefined ? { compactionCount: entry.compactionCount } : {}),
    ...compactionLedger,
    pluginExtensions: pluginExtensions.length > 0 ? pluginExtensions : undefined,
    // FORK 2026-09-24 (prompt-queue.md §6.3 / §7 G5) — spread so the key is ABSENT, not an explicit
    // undefined, when nothing is pending (the same rule as chat.ts's `disposition`).
    ...(pendingPrompts ? { pendingPrompts } : {}),
  };
}

function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = entry?.channel ?? parsed?.channel;
  if (!channel) {
    return undefined;
  }
  return buildGroupDisplayName({
    provider: channel,
    subject: entry?.subject,
    groupChannel: entry?.groupChannel,
    space: entry?.space,
    id: parsed?.id,
    key,
  });
}

export function loadGatewaySessionRow(
  sessionKey: string,
  options?: { includeDerivedTitles?: boolean; includeLastMessage?: boolean; now?: number },
): GatewaySessionRow | null {
  // FORK 2026-09-21 — runs on every sessions.changed broadcast. The store is
  // only read here (resolveChildSessionKeys iterates it), so pass the cached
  // object directly instead of paying a full-store clone via
  // loadSessionEntry().store; the entry is still copied because the row
  // embeds sub-objects of it.
  const { cfg, storePath, rawStore, freshestMatch, canonicalKey } =
    loadSessionEntryShared(sessionKey);
  if (!freshestMatch) {
    return null;
  }
  return buildGatewaySessionRow({
    cfg,
    storePath,
    store: rawStore,
    key: canonicalKey,
    entry: structuredClone(freshestMatch.entry),
    now: options?.now,
    includeDerivedTitles: options?.includeDerivedTitles,
    includeLastMessage: options?.includeLastMessage,
  });
}

export function listSessionsFromStore(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  modelCatalog?: ModelCatalogEntry[];
  opts: import("./protocol/index.js").SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  // FORK 2026-05-24 (fourth pass) — bug task-mpjhzu3j-ma9ts: server-side
  // lazy-mint, drawing from the shared FORTUNE_COOKIES pool. For each
  // non-main / non-deleted / non-cron / non-heartbeat entry that either
  // (a) has no cookiePhrase OR (b) has a legacy 2-word value from the
  // first-pass invented generator, mint a fresh phrase + persist.
  //
  // Why server-side after the second pass tried client-side: webchat
  // clients (the Tinker UI is one) are blocked from calling
  // sessions.patch by the rejectWebchatSessionMutation guard in
  // server-methods/sessions.ts. The third pass's 148 client-side
  // patches all returned INVALID_REQUEST. Server is the only path that
  // can persist cookiePhrase for a chat-originated session.
  const mainKey = resolveMainSessionKey(cfg);
  // FORK 2026-05-24 (fifth pass) — bug task-mpjhzu3j-ma9ts: heartbeat
  // gets a fixed special-case label "❤️ Heartbeat" (same persistence
  // mechanism as the random cookiePhrase — stored in
  // SessionEntry.cookiePhrase, surfaced through the standard priority
  // chain in renderSessionRow + tab.title sync). Previously heartbeat
  // was excluded from the mint, so it had NO cookiePhrase; clicking
  // the row opened a tab whose freshly-minted randomFortune title
  // bubbled up through the priority chain and changed the side-panel
  // display every time. With a stable cookiePhrase, both side panel
  // and tab title hold the same "❤️ Heartbeat" value forever.
  const HEARTBEAT_LABEL = "❤️ Heartbeat";
  let storeMutated = false;
  {
    const taken = collectExistingPhrases(store);
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || entry.deletedAt) continue;
      if (key === mainKey) continue;
      if (key === "global" || key === "unknown") continue;
      if (isCronRunSessionKey(key)) continue;
      // Heartbeat sessions get a stable special label, not a random fortune.
      if (key.includes(":heartbeat")) {
        if (entry.cookiePhrase !== HEARTBEAT_LABEL) {
          entry.cookiePhrase = HEARTBEAT_LABEL;
          storeMutated = true;
        }
        continue;
      }
      // FORK 2026-05-25 (third pass) — canonical-deterministic phrase
      // is the ONLY source of truth now. Re-mint any entry whose
      // cookiePhrase doesn't match fortuneForKey(key), not just legacy
      // 2-word shapes. This heals pre-canonicalisation entries where
      // the client side picked phrase X (hash of short "tinker:abc")
      // and the server side picked phrase Y (hash of canonical
      // "agent:main:tinker:abc"). After today's fortuneForKey strips
      // the `agent:<id>:` prefix before hashing, both sides agree on
      // the same phrase; this loop drives the in-memory store toward
      // that agreement on the next sessions.list. User-customised
      // phrases NOW reach this path (the Tinker UI persists them via
      // sessions.patch with cookiePhraseUserSet=true); the guard
      // immediately above skips them so they are never trampled.
      // FORK 2026-06-10 — u3-tab-naming: never overwrite a user-set / auto
      // DISPLAY NAME. A manual rename or auto-name from the Tinker UI is
      // persisted into cookiePhrase via sessions.patch with
      // cookiePhraseUserSet=true; the lazy-mint must leave it untouched so the
      // name is durable server-side (survives any restart/browser/device).
      if (entry.cookiePhraseUserSet) continue;
      const canonicalPhrase = fortuneForKey(key);
      if (entry.cookiePhrase === canonicalPhrase) continue;
      entry.cookiePhrase = canonicalPhrase;
      taken.add(canonicalPhrase);
      storeMutated = true;
    }
  }
  if (storeMutated) {
    // FORK 2026-05-24 (sixth pass) — bug task-mpjhzu3j-ma9ts: was direct
    // fs.writeFileSync of the in-memory store. That's a non-atomic
    // last-writer-wins overwrite — if a concurrent sessions.delete had
    // just stamped deletedAt via the atomic updateSessionStore path,
    // and our in-memory snapshot was older than that write, we'd clobber
    // the deletedAt on disk. Symptom: user clicks delete, server returns
    // 200, but on page refresh the row reappears because the lazy-mint
    // write that immediately followed wiped the deletedAt.
    //
    // Fix: use updateSessionStore (atomic read-modify-write via the
    // rename-temp pattern). Re-reads disk INSIDE the helper, applies
    // ONLY the cookiePhrase fields we minted, writes atomically. Any
    // other field a concurrent writer set (deletedAt, label, etc.) is
    // preserved.
    //
    // Fire-and-forget — the list response doesn't wait. Worst case the
    // persistence fails for one mint and the next list re-mints; cost is
    // a re-render of one phrase, not data loss.
    const phrasesToPersist: Record<string, string> = {};
    for (const [k, v] of Object.entries(store)) {
      if (v?.cookiePhrase) {
        phrasesToPersist[k] = v.cookiePhrase;
      }
    }
    setImmediate(() => {
      updateSessionStore(storePath, async (s) => {
        let mutated = false;
        for (const [k, phrase] of Object.entries(phrasesToPersist)) {
          const existing = s[k];
          // FORK 2026-05-25 (third pass) — persist if the disk value
          // doesn't already match the canonical-deterministic phrase
          // we minted in-memory. Includes empty entries, legacy
          // 2-word holdovers, and off-canonical phrases from before
          // fortuneForKey learned to strip the agent prefix. Same
          // logic as the in-memory mint loop above; the two must
          // agree or we'd repeatedly re-mint without persisting.
          if (existing && existing.cookiePhrase !== phrase) {
            existing.cookiePhrase = phrase;
            mutated = true;
          }
        }
        return mutated;
      }).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[sessions.list] cookiePhrase persist failed", err);
      });
    });
  }

  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const includeDeleted = opts.includeDeleted === true;
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let entries = Object.entries(store)
    .filter(([, entry]) => {
      // FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts: soft-delete filter.
      // Entries with a deletedAt timestamp are hidden by default; the
      // metadata stays in the store + the transcript JSONL stays on
      // disk (archived with .deleted.<ts> suffix by sessions.delete)
      // so Jarvis can still archaeology them when needed. The user
      // explicitly asked for this safety net: "it will stay somewhere
      // Jarvis can retrieve if necessary."
      if (entry?.deletedAt && !includeDeleted) {
        return false;
      }
      const operatorId = typeof opts.operatorId === "string" ? opts.operatorId.trim() : "";
      if (operatorId) {
        const meta = (entry as { operatorId?: string; seatId?: string } | undefined) ?? {};
        if (!sessionVisibleToOperator(meta, operatorId, opts.includeHive === true)) {
          return false;
        }
      }
      return true;
    })
    .filter(([key]) => {
      // FORK 2026-05-25 — hide ALL cron-related sessions from the panel,
      // not just `:run:` per-execution sub-sessions. The top-level cron
      // entries (cron:morning-briefing, etc.) already reuse one session
      // per cron name; the per-profile sessions in cron:people-profiles
      // legitimately stay separate for per-person memory isolation. None
      // of this is user-interactable, so don't list it.
      if (key.includes(":cron:")) {
        return false;
      }
      if (isCronRunSessionKey(key)) {
        return false;
      }
      // FORK 2026-05-25 — DO NOT hide *:main keys. An earlier attempt
      // filtered them out to avoid the duplicate-"🏠 Main" rows seen
      // after a /clear rotated tab-main's sessionKey away from
      // `agent:main:main`. But for users whose tab-main is still on
      // `agent:main:main` (fresh state, no /clear since session
      // creation), that filter erased the only main row from the panel
      // entirely. The proper fix lives in the /clear handler in
      // tinker-ui/src/app.ts: tab-main MUST NOT rotate its sessionKey
      // — it stays on `agent:main:main` across /clear, sessions.reset
      // archives the transcript on the same key. With that, the orphan
      // scenario can't arise and a single canonical row remains.
      if (!includeGlobal && key === "global") {
        return false;
      }
      if (!includeUnknown && key === "unknown") {
        return false;
      }
      if (agentId) {
        if (key === "global" || key === "unknown") {
          return false;
        }
        const parsed = parseAgentSessionKey(key);
        if (!parsed) {
          return false;
        }
        return normalizeAgentId(parsed.agentId) === agentId;
      }
      return true;
    })
    .filter(([key, entry]) => {
      if (!spawnedBy) {
        return true;
      }
      if (key === "unknown" || key === "global") {
        return false;
      }
      const latest = getSessionDisplaySubagentRunByChildSessionKey(key);
      if (latest) {
        const latestControllerSessionKey =
          normalizeOptionalString(latest.controllerSessionKey) ||
          normalizeOptionalString(latest.requesterSessionKey);
        return (
          latestControllerSessionKey === spawnedBy &&
          shouldKeepSubagentRunChildLink(latest, {
            activeDescendants: countActiveDescendantRuns(key),
            now,
          })
        );
      }
      return (
        shouldKeepStoreOnlyChildLink(entry, now) &&
        (entry?.spawnedBy === spawnedBy || entry?.parentSessionKey === spawnedBy)
      );
    })
    .filter(([, entry]) => {
      if (!label) {
        return true;
      }
      return entry?.label === label;
    })
    .toSorted((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0));

  if (search) {
    entries = entries.filter(([key, entry]) => {
      const fields = [
        resolveSessionListSearchDisplayName(key, entry),
        entry?.label,
        entry?.subject,
        entry?.sessionId,
        key,
      ];
      return fields.some(
        (f) => typeof f === "string" && normalizeLowercaseStringOrEmpty(f).includes(search),
      );
    });
  }

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    entries = entries.filter(([, entry]) => (entry?.updatedAt ?? 0) >= cutoff);
  }

  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    const limit = Math.max(1, Math.floor(opts.limit));
    entries = entries.slice(0, limit);
  }

  const sessions = entries.map(([key, entry]) =>
    buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key,
      entry,
      modelCatalog: params.modelCatalog,
      now,
      includeDerivedTitles,
      includeLastMessage,
    }),
  );

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    defaults: getSessionDefaults(cfg, params.modelCatalog),
    sessions,
  };
}
