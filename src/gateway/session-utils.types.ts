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

/**
 * FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 / §7 step G5. The four states a
 * prompt can be in after its `chat.send` was acked and before its terminal, while a gateway holder
 * still owns it (§2). Mirrors the consumer, tinker-ui/src/prompt-state.ts `PendingPromptPhase`.
 */
export type GatewaySessionPendingPromptState = "behind" | "steered" | "preparing" | "running";

/** One entry of GatewaySessionRow.pendingPrompts. */
export type GatewaySessionPendingPrompt = {
  /** The prompt's one identity (PQ-1): the client's `chat.send` idempotencyKey. */
  key: string;
  state: GatewaySessionPendingPromptState;
  /**
   * Epoch ms, the reporting holder's own timestamp for the prompt: the follow-up item's
   * `enqueuedAt` (BEHIND), the steer's acceptance (STEERED), the reply operation's `startedAt`
   * (PREPARING, RUNNING).
   */
  since: number;
};

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
  /**
   * FORK 2026-09-24 — prompt-queue.md §6.3 / §7 step G5. WHICH prompts of this session a gateway
   * holder still owns, and in which §2 state; `run` above says only WHETHER the session is working.
   * DERIVED when the row is built (session-utils.ts deriveSessionPendingPrompts) from in-memory
   * holders only, with no session-store read (failures.md M21). PQ-11 re-derives a prompt's state
   * from it after a reload; PQ-5 counts a key's absence as evidence for LOST.
   *
   * ABSENT when nothing is pending, never `[]`. An absent field alone therefore cannot tell
   * "nothing pending" from "a gateway without this field"; the consumer decides that
   * (tinker-ui/src/prompt-state.ts `noGatewayHolder`). Additive: a client that does not know this
   * field ignores it.
   */
  pendingPrompts?: GatewaySessionPendingPrompt[];
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
  /**
   * FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A7. The session entry's
   * own durable counter (SessionEntry.compactionCount), passed through as stored and ABSENT when
   * the entry never recorded one. Only gateway-side executors bump it: the claude CLI's own
   * compactions (trigger "cli-internal") and the EVICT button never reach it. `compactions` below
   * counts every executor.
   */
  compactionCount?: number;
  /**
   * FORK 2026-09-24 — A4 / A7: the compaction LEDGER's figures for this session
   * (src/infra/compaction-ledger.ts): the events database's `compaction.run` rows of earlier
   * gateway processes, inside that table's retention window, plus this process's own. Read from
   * memory when the row is built, never from a store (failures.md M21). All four are ABSENT until
   * the ledger was seeded for this session after a gateway start (P10: the UI shows "—", not 0).
   * Additive: a client that does not know these fields ignores them.
   *
   * `compactions`: completed compactions of every executor except the EVICT button.
   */
  compactions?: number;
  /** Completed EVICT-button evictions (trigger "evict"). */
  evictions?: number;
  /**
   * Tokens those compactions and evictions removed: each end's measured drop, else its before
   * minus after. ALSO absent when some ran and none carried a figure (never a fabricated 0).
   */
  droppedTokens?: number;
  /** Epoch ms of the latest completed compaction, evictions excluded; absent when there is none. */
  lastCompactionAt?: number;
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
