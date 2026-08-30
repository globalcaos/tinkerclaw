import type { ChatType } from "../channels/chat-type.js";
import type { SessionCompactionCheckpoint, SessionEntry } from "../config/sessions/types.js";
import type { PluginSessionExtensionProjection } from "../plugins/host-hooks.js";
import type {
  GatewayAgentRow as SharedGatewayAgentRow,
  SessionsListResultBase,
  SessionsPatchResultBase,
} from "../shared/session-types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

export type GatewayThinkingLevelOption = {
  id: string;
  label: string;
};

export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";

export type SubagentRunState = "active" | "interrupted" | "historical";

export type GatewaySessionRow = {
  key: string;
  spawnedBy?: string;
  spawnedWorkspaceDir?: string;
  forkedFromParent?: boolean;
  spawnDepth?: number;
  subagentRole?: SessionEntry["subagentRole"];
  subagentControlScope?: SessionEntry["subagentControlScope"];
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  /**
   * FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts ("Tabs behavior" part 1).
   * Persistent fortune-cookie name. See SessionEntry.cookiePhrase for the
   * persistence + lazy-mint contract. Surfaced here so the Tinker UI can
   * use it as the primary display string in renderSessionRow.
   */
  cookiePhrase?: string;
  /** FORK 2026-06-10 — u3-tab-naming: mirrors SessionEntry.cookiePhraseUserSet; TRUE when cookiePhrase is a user/auto display name (not a fortune), so the client can lock the tab title. */
  cookiePhraseUserSet?: boolean;
  /**
   * FORK 2026-05-24 — bug task-mpjhzu3j-ma9ts. Soft-delete timestamp.
   * sessions.list omits rows where this is set unless the caller passes
   * `includeDeleted:true`. See SessionEntry.deletedAt for the full
   * contract.
   */
  deletedAt?: number;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: ChatType;
  origin?: SessionEntry["origin"];
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  /**
   * FORK 2026-07-29 — THE RUN SET, as observed by the gateway process at the instant this row was
   * built (src/infra/agent-events.ts getSessionRunLiveness).
   *
   * `status` above is a verbatim passthrough of the PERSISTED entry, so it describes the archive:
   * it can latch at "running" when a terminal write is missed, and it is absent entirely on a
   * measured 61 of 348 rows. This field describes the PROCESS instead — it is true only while a
   * run is actually open, and a gateway restart erases it rather than resurrecting it.
   *
   * Consumers should prefer `run.live` and treat `status` as history. Added additively: a client
   * that does not know this field ignores it.
   */
  run?: {
    live: boolean;
    count: number;
    heartbeatCount: number;
    since?: number;
    lastActiveAt?: number;
  };
  subagentRunState?: SubagentRunState;
  hasActiveSubagentRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  parentSessionKey?: string;
  childSessions?: string[];
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  model?: string;
  /**
   * FORK 2026-08-29 — the DURABLE PIN, published separately from the RUNTIME pair above.
   *
   * `model`/`modelProvider` are "what SERVED" (pin ?? last-served identity) — they cannot
   * distinguish a session that is pinned to a model from one on Auto that merely happened to
   * run on it. ABSENT here means the session is on Auto; PRESENCE, not value, is the
   * Auto/pinned predicate. Reading `model` as if it were a pin is exactly what made the Auto
   * button light up Opus.
   *
   * Additive: a client that does not know these fields ignores them.
   */
  modelOverride?: string;
  providerOverride?: string;
  modelOverrideSource?: "auto" | "user";
  contextTokens?: number;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: SessionEntry["lastThreadId"];
  compactionCheckpointCount?: number;
  latestCompactionCheckpoint?: SessionCompactionCheckpoint;
  pluginExtensions?: PluginSessionExtensionProjection[];
};

export type GatewayAgentRow = SharedGatewayAgentRow;

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionsListResult = SessionsListResultBase<GatewaySessionsDefaults, GatewaySessionRow>;

export type SessionsPatchResult = SessionsPatchResultBase<SessionEntry> & {
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};
