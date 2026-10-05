import type { VerboseLevel } from "../auto-reply/thinking.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "error"
  | "item"
  | "plan"
  | "approval"
  | "command_output"
  | "patch"
  | "compaction"
  | "thinking"
  | (string & {});

export type AgentItemEventPhase = "start" | "update" | "end";
export type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
export type AgentItemEventKind =
  | "tool"
  | "command"
  | "patch"
  | "search"
  | "analysis"
  | (string & {});

export type AgentItemEventData = {
  itemId: string;
  phase: AgentItemEventPhase;
  kind: AgentItemEventKind;
  title: string;
  status: AgentItemEventStatus;
  name?: string;
  meta?: string;
  toolCallId?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  summary?: string;
  progressText?: string;
  approvalId?: string;
  approvalSlug?: string;
};

export type AgentPlanEventData = {
  phase: "update";
  title: string;
  explanation?: string;
  steps?: string[];
  source?: string;
};

export type AgentApprovalEventPhase = "requested" | "resolved";
export type AgentApprovalEventStatus = "pending" | "unavailable" | "approved" | "denied" | "failed";
export type AgentApprovalEventKind = "exec" | "plugin" | "unknown";

export type AgentApprovalEventData = {
  phase: AgentApprovalEventPhase;
  kind: AgentApprovalEventKind;
  status: AgentApprovalEventStatus;
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  scope?: "turn" | "session";
  message?: string;
};

export type AgentCommandOutputEventData = {
  itemId: string;
  phase: "delta" | "end";
  title: string;
  toolCallId: string;
  name?: string;
  output?: string;
  status?: AgentItemEventStatus | "running";
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
};

export type AgentPatchSummaryEventData = {
  itemId: string;
  phase: "end";
  title: string;
  toolCallId: string;
  name?: string;
  added: string[];
  modified: string[];
  deleted: string[];
  summary: string;
};

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
  /** Timestamp when this context was first registered (for TTL-based cleanup). */
  registeredAt?: number;
  /**
   * Timestamp of last activity: updated on every emitAgentEvent, and on every phase change of the
   * reply operation that owns this run (touchAgentRunContextsForSession).
   */
  lastActiveAt?: number;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");

function getAgentEventState(): AgentEventState {
  return resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
    seqByRun: new Map<string, number>(),
    listeners: new Set<(evt: AgentEventPayload) => void>(),
    runContextById: new Map<string, AgentRunContext>(),
  }));
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const state = getAgentEventState();
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, {
      ...context,
      registeredAt: context.registeredAt ?? Date.now(),
    });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isControlUiVisible !== undefined) {
    existing.isControlUiVisible = context.isControlUiVisible;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (context.registeredAt !== undefined) {
    existing.registeredAt = context.registeredAt;
  }
  if (context.lastActiveAt !== undefined) {
    existing.lastActiveAt = context.lastActiveAt;
  }
}

export function getAgentRunContext(runId: string) {
  return getAgentEventState().runContextById.get(runId);
}

/**
 * THE RUN SET — the frame of reference for "is this session running right now?".
 *
 * FORK 2026-07-29. Four UI surfaces (chat indicator, sessions-panel row, tab title, models
 * count) had been answering that question by arbitrating between the persisted session store,
 * a viewed-gated client map, and wall-clock comparisons between two different transports. Five
 * successive precedence rules produced five user-visible inversions, because arbitration cannot
 * repair an input that is unsound.
 *
 * The authoritative answer already lived here and nothing asked it:
 *
 *   - `runContextById` is opened by registerAgentRunContext and closed by clearAgentRunContext,
 *     at event ingest — upstream of every gateway path that can miss a terminal write to the
 *     session store (those corrupt the ARCHIVE; they cannot corrupt this map);
 *   - `lastActiveAt` is refreshed on every emitAgentEvent, so silence is measurable;
 *   - sweepStaleRunContextsDetailed (called from server-maintenance.ts) bounds a run that never
 *     closed. It keeps a context while a holder still owns the run, and returns what it drops so
 *     the caller announces it (prompt-queue.md §6.2 "Sweep (C9)");
 *   - it is in memory, so a gateway restart erases it — "running at boot" is unrepresentable
 *     rather than something a recovery path must remember to clear;
 *   - it is a resolveGlobalSingleton, so bundle splits share one map.
 *
 * The only thing missing was a way to ask it BY SESSION. That is this function. It is
 * deliberately a derivation over the existing map rather than a second index: the map is bounded
 * by concurrent runs (single digits), and a second index is a second thing to keep in sync —
 * which is the class of bug this whole exercise is about.
 *
 * Keyed per RUN, never per session: the embedded runner genuinely permits concurrent runs on one
 * session, so collapsing to one slot would let a superseded run's late close silence a live
 * sibling.
 */
export function getSessionRunLiveness(
  sessionKey: string,
  now = Date.now(),
): { live: boolean; count: number; heartbeatCount: number; since?: number; lastActiveAt?: number } {
  const empty = { live: false, count: 0, heartbeatCount: 0 };
  if (!sessionKey) {
    return empty;
  }
  const state = getAgentEventState();
  let count = 0;
  let heartbeatCount = 0;
  let since: number | undefined;
  let lastActiveAt: number | undefined;
  for (const ctx of state.runContextById.values()) {
    if (ctx.sessionKey !== sessionKey) {
      continue;
    }
    if (ctx.isHeartbeat) {
      heartbeatCount++;
      continue;
    }
    count++;
    const started = ctx.registeredAt;
    if (typeof started === "number" && (since === undefined || started < since)) {
      since = started;
    }
    const active = ctx.lastActiveAt ?? ctx.registeredAt;
    if (typeof active === "number" && (lastActiveAt === undefined || active > lastActiveAt)) {
      lastActiveAt = active;
    }
  }
  void now;
  return { live: count > 0, count, heartbeatCount, since, lastActiveAt };
}

export function clearAgentRunContext(runId: string) {
  const state = getAgentEventState();
  state.runContextById.delete(runId);
  state.seqByRun.delete(runId);
}

/**
 * Close every run of ONE session in the run set at once: `sessions.delete` / `sessions.reset`
 * (FORK 2026-09-24, TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.2 step 5, PQ-10). Without it a turn
 * still before the model kept `sessions.list` reporting `run.live` until the silent 30-minute
 * sweep below.
 *
 * A derivation over `runContextById`, exactly like getSessionRunLiveness — not a second index.
 * It matches `sessionKey` EXACTLY, as getSessionRunLiveness does, so a caller holding several key
 * forms of one session passes each. Heartbeat runs are included: a deleted or reset session has no
 * turn of any kind left. `registeredAtOrBefore` keeps any run registered after that instant (a
 * turn another tab started on the same key while the caller was waiting). Each run closes through
 * clearAgentRunContext, the one per-run close path. Returns the runIds it closed.
 */
export function clearAgentRunContextsForSession(
  sessionKey: string,
  opts?: { registeredAtOrBefore?: number },
): string[] {
  if (!sessionKey) {
    return [];
  }
  const cutoff = opts?.registeredAtOrBefore;
  const runIds: string[] = [];
  for (const [runId, ctx] of getAgentEventState().runContextById) {
    if (ctx.sessionKey !== sessionKey) {
      continue;
    }
    if (cutoff !== undefined && (ctx.registeredAt ?? 0) > cutoff) {
      continue;
    }
    runIds.push(runId);
  }
  for (const runId of runIds) {
    clearAgentRunContext(runId);
  }
  return runIds;
}

/**
 * Refresh `lastActiveAt` on the run contexts one reply operation owns. Returns the count.
 *
 * FORK 2026-09-24 (prompt-queue.md §6.2 "Sweep (C9)", step G4). Called by the reply operation on
 * every phase change (src/auto-reply/reply/reply-run-registry.ts `setPhase`): a turn that is
 * compacting, flushing memory or starting its run is working, even though it emits no agent event.
 * Only contexts of `sessionKey` registered at or after `registeredSince` (the operation's start)
 * are touched. An older context on the same session is an earlier turn's orphan, and refreshing it
 * would let every later turn keep it alive, which is why the run set is keyed per RUN (see
 * getSessionRunLiveness). Like that function, a derivation over `runContextById`, not an index.
 */
export function touchAgentRunContextsForSession(
  sessionKey: string,
  registeredSince: number,
  now = Date.now(),
): number {
  if (!sessionKey) {
    return 0;
  }
  let touched = 0;
  for (const ctx of getAgentEventState().runContextById.values()) {
    if (ctx.sessionKey === sessionKey && (ctx.registeredAt ?? 0) >= registeredSince) {
      ctx.lastActiveAt = now;
      touched++;
    }
  }
  return touched;
}

/** One run context a sweep removed: what its caller needs to announce the removal. */
export type SweptRunContext = {
  runId: string;
  sessionKey?: string;
  isHeartbeat?: boolean;
  isControlUiVisible?: boolean;
  /** The silence the sweep measured; Infinity when the context carried no timestamp. */
  silentMs: number;
};

/**
 * Sweep stale run contexts that exceeded the given TTL, and RETURN what was removed.
 * Guards against orphaned entries when lifecycle "end"/"error" events are missed.
 *
 * FORK 2026-09-24 (prompt-queue.md §6.2 "Sweep (C9)", step G4). This sweep used to drop a context
 * after 30 min of silence and tell nobody, while turns were measured waiting 21–49 min before the
 * model (bug-log.md 2026-09-23), so a slow prompt could turn into one that looks idle. Both fixes
 * live in the signature, so a caller cannot skip them:
 *   - `keepAlive` is REQUIRED. The caller names what still owns the run (server-maintenance.ts
 *     passes the reply-operation registry and the chat abort controllers). This module cannot
 *     import those holders itself: reply-run-registry imports THIS module for the phase hook
 *     above, and the reverse import would close a cycle (scripts/check-import-cycles.ts).
 *   - the removed contexts are RETURNED, so the caller can emit the terminal and
 *     `sessions.changed`. A count cannot be announced.
 */
export function sweepStaleRunContextsDetailed({
  keepAlive,
  maxAgeMs = 30 * 60 * 1000,
  now = Date.now(),
}: {
  keepAlive: (runId: string, ctx: Readonly<AgentRunContext>, silentMs: number) => boolean;
  maxAgeMs?: number;
  now?: number;
}): SweptRunContext[] {
  const state = getAgentEventState();
  const swept: SweptRunContext[] = [];
  for (const [runId, ctx] of state.runContextById.entries()) {
    // Use lastActiveAt (refreshed on every event and reply-op phase change) to avoid sweeping
    // active runs. Fall back to registeredAt, then treat missing timestamps as infinitely old.
    const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
    const silentMs = lastSeen ? now - lastSeen : Infinity;
    if (silentMs <= maxAgeMs || keepAlive(runId, ctx, silentMs)) {
      continue;
    }
    state.runContextById.delete(runId);
    state.seqByRun.delete(runId);
    swept.push({
      runId,
      sessionKey: ctx.sessionKey,
      isHeartbeat: ctx.isHeartbeat,
      isControlUiVisible: ctx.isControlUiVisible,
      silentMs,
    });
  }
  return swept;
}

/**
 * The count-only form, with NO holder consulted: a context whose session still has an active
 * reply operation IS dropped here, and nothing is announced. The gateway's maintenance timer
 * calls sweepStaleRunContextsDetailed instead; this form remains for callers that own no holder.
 */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000): number {
  return sweepStaleRunContextsDetailed({ maxAgeMs, keepAlive: () => false }).length;
}

export function resetAgentRunContextForTest() {
  getAgentEventState().runContextById.clear();
  getAgentEventState().seqByRun.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const state = getAgentEventState();
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  if (context) {
    context.lastActiveAt = Date.now();
  }
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const sessionKey = isControlUiVisible ? (eventSessionKey ?? context?.sessionKey) : undefined;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  notifyListeners(state.listeners, enriched);
}

export function emitAgentItemEvent(params: {
  runId: string;
  data: AgentItemEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "item",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentPlanEvent(params: {
  runId: string;
  data: AgentPlanEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "plan",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentApprovalEvent(params: {
  runId: string;
  data: AgentApprovalEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "approval",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentCommandOutputEvent(params: {
  runId: string;
  data: AgentCommandOutputEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "command_output",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentPatchSummaryEvent(params: {
  runId: string;
  data: AgentPatchSummaryEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "patch",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  const state = getAgentEventState();
  return registerListener(state.listeners, listener);
}

export function resetAgentEventsForTest() {
  const state = getAgentEventState();
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
}
