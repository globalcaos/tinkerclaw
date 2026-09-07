export type SessionStateValue = "idle" | "processing" | "waiting";

export type SessionState = {
  sessionId?: string;
  sessionKey?: string;
  lastActivity: number;
  state: SessionStateValue;
  queueDepth: number;
  toolCallHistory?: ToolCallRecord[];
  toolLoopWarningBuckets?: Map<string, number>;
  commandPollCounts?: Map<string, { count: number; lastPollAt: number }>;
  /**
   * Last time this session's turn demonstrably moved forward (a recorded tool
   * call, a streamed block, an explicit markDiagnosticSessionProgress call).
   * Distinct from lastActivity, which tracks state-machine transitions: a long
   * turn can be progressing (stream growing) while lastActivity stays frozen
   * at the transition into "processing".
   */
  lastProgressAt?: number;
  /**
   * Liveness of the session's LLM client process, when a supervisor knows it.
   * false = confirmed dead (a stuck warning is always justified);
   * true/undefined = alive/unknown, so progress recency decides.
   */
  clientAlive?: boolean;
};

export type ToolCallRecord = {
  toolName: string;
  argsHash: string;
  toolCallId?: string;
  runId?: string;
  resultHash?: string;
  unknownToolName?: string;
  timestamp: number;
};

export type SessionRef = {
  sessionId?: string;
  sessionKey?: string;
};

export const diagnosticSessionStates = new Map<string, SessionState>();

const SESSION_STATE_TTL_MS = 30 * 60 * 1000;
const SESSION_STATE_PRUNE_INTERVAL_MS = 60 * 1000;
const SESSION_STATE_MAX_ENTRIES = 2000;

let lastSessionPruneAt = 0;

export function pruneDiagnosticSessionStates(now = Date.now(), force = false): void {
  const shouldPruneForSize = diagnosticSessionStates.size > SESSION_STATE_MAX_ENTRIES;
  if (!force && !shouldPruneForSize && now - lastSessionPruneAt < SESSION_STATE_PRUNE_INTERVAL_MS) {
    return;
  }
  lastSessionPruneAt = now;

  for (const [key, state] of diagnosticSessionStates.entries()) {
    const ageMs = now - state.lastActivity;
    const isIdle = state.state === "idle";
    if (isIdle && state.queueDepth <= 0 && ageMs > SESSION_STATE_TTL_MS) {
      diagnosticSessionStates.delete(key);
    }
  }

  if (diagnosticSessionStates.size <= SESSION_STATE_MAX_ENTRIES) {
    return;
  }
  const excess = diagnosticSessionStates.size - SESSION_STATE_MAX_ENTRIES;
  const ordered = Array.from(diagnosticSessionStates.entries()).toSorted(
    (a, b) => a[1].lastActivity - b[1].lastActivity,
  );
  for (let i = 0; i < excess; i += 1) {
    const key = ordered[i]?.[0];
    if (!key) {
      break;
    }
    diagnosticSessionStates.delete(key);
  }
}

function resolveSessionKey({ sessionKey, sessionId }: SessionRef) {
  return sessionKey ?? sessionId ?? "unknown";
}

function findStateBySessionId(sessionId: string): SessionState | undefined {
  for (const state of diagnosticSessionStates.values()) {
    if (state.sessionId === sessionId) {
      return state;
    }
  }
  return undefined;
}

export function getDiagnosticSessionState(ref: SessionRef): SessionState {
  pruneDiagnosticSessionStates();
  const key = resolveSessionKey(ref);
  const existing =
    diagnosticSessionStates.get(key) ?? (ref.sessionId && findStateBySessionId(ref.sessionId));
  if (existing) {
    if (ref.sessionId) {
      existing.sessionId = ref.sessionId;
    }
    if (ref.sessionKey) {
      existing.sessionKey = ref.sessionKey;
    }
    return existing;
  }
  const created: SessionState = {
    sessionId: ref.sessionId,
    sessionKey: ref.sessionKey,
    lastActivity: Date.now(),
    state: "idle",
    queueDepth: 0,
  };
  diagnosticSessionStates.set(key, created);
  pruneDiagnosticSessionStates(Date.now(), true);
  return created;
}

function findDiagnosticSessionState(ref: SessionRef): SessionState | undefined {
  const key = resolveSessionKey(ref);
  return (
    diagnosticSessionStates.get(key) ??
    (ref.sessionId ? findStateBySessionId(ref.sessionId) : undefined)
  );
}

/**
 * Record evidence that a session's turn is moving forward (streamed block,
 * tool call, run attempt). Lookup-only on purpose: a progress mark for a
 * session we are not tracking has nothing to keep alive, and creating state
 * here would resurrect pruned sessions and leak entries when diagnostics are
 * disabled.
 */
export function markDiagnosticSessionProgress(ref: SessionRef, at = Date.now()): void {
  const state = findDiagnosticSessionState(ref);
  if (!state) {
    return;
  }
  if (state.lastProgressAt === undefined || at > state.lastProgressAt) {
    state.lastProgressAt = at;
  }
}

/** Record whether the session's LLM client process is alive (lookup-only, see above). */
export function setDiagnosticSessionClientLiveness(
  ref: SessionRef,
  alive: boolean | undefined,
): void {
  const state = findDiagnosticSessionState(ref);
  if (!state) {
    return;
  }
  state.clientAlive = alive;
}

/**
 * Best-known "last forward progress" for a session: the explicit progress mark
 * or the newest recorded tool call, whichever is later. Command polls are
 * deliberately excluded — a wedged turn's client can keep polling forever.
 */
export function resolveDiagnosticSessionLastProgressAt(state: SessionState): number | undefined {
  let last = state.lastProgressAt ?? 0;
  if (state.toolCallHistory) {
    for (const call of state.toolCallHistory) {
      if (call.timestamp > last) {
        last = call.timestamp;
      }
    }
  }
  return last > 0 ? last : undefined;
}

export function getDiagnosticSessionStateCountForTest(): number {
  return diagnosticSessionStates.size;
}

export function resetDiagnosticSessionStateForTest(): void {
  diagnosticSessionStates.clear();
  lastSessionPruneAt = 0;
}
