/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { type SessionEntry, loadSessionStore, updateSessionStore } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;

function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return true;
  }
  if (entry.subagentRole != null) {
    return true;
  }
  return (
    isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) || isAcpSessionKey(sessionKey)
  );
}

function sessionIdFromLockPath(lockPath: string): string | undefined {
  const fileName = path.basename(lockPath);
  if (!fileName.endsWith(".jsonl.lock")) {
    return undefined;
  }
  const sessionId = fileName.slice(0, -".jsonl.lock".length).trim();
  return sessionId || undefined;
}

function getMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isMeaningfulTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  if (!role || role === "system") {
    return false;
  }
  return true;
}

function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

function isApprovalPendingToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return false;
  }
  return (details as { status?: unknown }).status === "approval-pending";
}

function resolveMainSessionResumeBlockReason(messages: unknown[]): string | null {
  const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return "transcript tail is not resumable";
  }
  if (isApprovalPendingToolResult(lastMeaningful)) {
    return "transcript tail is a stale approval-pending tool result";
  }
  return null;
}

/**
 * A trailing `tool_use` block with no following `tool_result` means the turn
 * was interrupted while waiting for tool execution — genuinely resumable. If
 * the assistant message were followed by its tool_result, that result (a
 * user/tool message) would be the last meaningful message instead, not this
 * assistant message — so any tool_use in the LAST assistant message is dangling.
 */
function assistantTurnHasPendingToolUse(message: unknown): boolean {
  if (getMessageRole(message) !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  // Accept both the raw Anthropic name (`tool_use`) and OpenClaw's normalized
  // name (`toolCall`): recognizing more tool-block shapes only ever errs toward
  // resuming, never toward wrongly skipping a genuine mid-tool interruption.
  return content.some((block) => {
    if (block == null || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return type === "tool_use" || type === "toolCall";
  });
}

/**
 * FORK 2026-05-31 (the architect directive): is the session idle — i.e. did its last
 * turn already COMPLETE, so there is nothing to resume? Distinguishes the three
 * tail shapes the 2026-05-10 change collapsed into one "not resumable" verdict:
 *   - no meaningful message (empty transcript) → tinker-bridge mid-flight → NOT idle (resume)
 *   - last message is `assistant` with a trailing tool_use → interrupted → NOT idle (resume)
 *   - last message is `assistant`, text only → turn finished → IDLE (skip resume)
 *   - last message is user/tool/toolResult → genuine interruption → NOT idle (resume)
 * Returning true here is what breaks the phantom-resume loop on idle sessions.
 */
function isIdleCompletedTail(messages: unknown[]): boolean {
  const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
  if (!lastMeaningful || getMessageRole(lastMeaningful) !== "assistant") {
    return false;
  }
  return !assistantTurnHasPendingToolUse(lastMeaningful);
}

function buildResumeMessage(): string {
  // FORK 2026-05-30 (the architect directive): the resume must be LEGIBLE. The user
  // wants a brief "here's where I'm picking up" note — which plan step, what's
  // already on disk vs. half-written — so they can see whether the restart
  // cost much work and that resume actually worked, THEN seamless continuation.
  return (
    "[System] The gateway restarted and interrupted your previous turn. Resume it, and make the resume legible to the user:\n" +
    '1. ORIENT FIRST — post one short message (1-3 sentences) stating where you are picking up. If you have an active prefrontal plan, call prefrontal.plan.get and name the step you were on plus which artifacts are already complete on disk vs. half-finished; if there is no plan, summarize from the transcript tail what was in flight. Example shape: "Plan was already written; I was interrupted on step 3 — 3 files complete on disk, 1 half-written. Reading them and resuming."\n' +
    "2. RECOVER CONTEXT — read any half-written artifacts (and run `git status`) so you continue from the real on-disk state, not from memory.\n" +
    "3. CONTINUE as if nothing happened — finish the interrupted work; do NOT redo steps already marked done.\n" +
    "Keep the orientation brief; its only job is to show the user where you resumed and roughly what the restart cost."
  );
}

export async function markSessionFailed(params: {
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<void> {
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.sessionKey];
      if (!entry || entry.status !== "running") {
        return;
      }
      entry.status = "failed";
      entry.abortedLastRun = true;
      entry.endedAt = Date.now();
      entry.updatedAt = entry.endedAt;
      store[params.sessionKey] = entry;
    },
    { skipMaintenance: true },
  );
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}

/**
 * FORK 2026-05-31 — an idle session that the drain flagged `running` +
 * `abortedLastRun` (because a prior phantom resume-turn was killed by the next
 * restart) keeps re-matching the recovery gate on every boot. Clear the flags
 * so the gate stops matching and the resume loop ends. Atomic read-modify-write
 * via updateSessionStore — never clobber a stale snapshot.
 */
async function settleIdleSession(params: { storePath: string; sessionKey: string }): Promise<void> {
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.sessionKey];
      if (!entry || entry.status !== "running") {
        return;
      }
      entry.status = "done";
      entry.abortedLastRun = false;
      entry.endedAt = Date.now();
      entry.updatedAt = entry.endedAt;
      store[params.sessionKey] = entry;
    },
    { skipMaintenance: true },
  );
}

/**
 * FORK 2026-05-10 — push a visible orange `__ERR_ENV__:` envelope into the
 * given session so the user SEES that the gateway interrupted their turn.
 *
 * Wording is deliberately uniform: we never tell the user to retry. Per
 * the user's 2026-05-10 directive, every recovered session attempts resume
 * (tinker-bridge resumes via its own session-map → claude-cli --resume; native
 * sessions resume via the `[System] continue from transcript` dispatch).
 * The chip just acknowledges the restart so the user knows why a thinking
 * dot disappeared and that work is being resumed.
 *
 * This is best-effort: if `chat.inject` fails, recovery still proceeds.
 */
async function pushRestartWarningEnvelope(params: { sessionKey: string }): Promise<void> {
  const now = new Date();
  const localTime = now.toLocaleTimeString("en-GB", { hour12: false });
  const envelope = {
    kind: "error",
    id: `gw-restart-${now.getTime()}`,
    fatal: false,
    category: "busy",
    // FORK 2026-05-30 (the architect directive): the collapsed warning is just
    // "Gateway restarted" — small, plain, easy to glance past. The restart
    // time is technical, so it lives in `details` (the expandable kv block),
    // not the headline. No "retry"/"check the journal" hints: I resume and
    // inspect logs myself; those are not the user's job.
    headline: "Gateway restarted",
    explanation:
      "Your previous turn was interrupted. I'm resuming it automatically — your chat context is preserved.",
    icon: "🔄",
    details: { restarted_at: localTime },
    timestamp: now.toISOString(),
  };
  try {
    await callGateway({
      method: "chat.inject",
      params: {
        sessionKey: params.sessionKey,
        message: `__ERR_ENV__:${JSON.stringify(envelope)}`,
        label: "system",
      },
      timeoutMs: 5_000,
    });
    log.info(`pushed restart-warning envelope to ${params.sessionKey}`);
  } catch (err) {
    log.warn(`failed to push restart-warning envelope: ${String(err)}`);
  }
}

async function resumeMainSession(params: {
  storePath: string;
  sessionKey: string;
}): Promise<boolean> {
  try {
    await pushRestartWarningEnvelope({ sessionKey: params.sessionKey });
    await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: buildResumeMessage(),
        sessionKey: params.sessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: CommandLane.Main,
      },
      timeoutMs: 10_000,
    });
    await updateSessionStore(
      params.storePath,
      (store) => {
        const entry = store[params.sessionKey];
        if (!entry) {
          return;
        }
        entry.abortedLastRun = false;
        entry.updatedAt = Date.now();
        store[params.sessionKey] = entry;
      },
      { skipMaintenance: true },
    );
    log.info(`resumed interrupted main session: ${params.sessionKey}`);
    return true;
  } catch (err) {
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

/**
 * FORK 2026-05-09 — mark every status:"running" main session as interrupted
 * at gateway boot, regardless of stale-lock state. The original
 * `markRestartAbortedMainSessionsFromLocks` only fires when stale lock files
 * are detected — i.e. unclean shutdowns. But the COMMON case (graceful
 * `openclaw-restart`) releases locks cleanly during the drain window, leaving
 * sessions with `status:"running"` but no stale locks. Without marking them,
 * `recoverRestartAbortedMainSessions` skips them and the user never sees the
 * "[System] Your previous turn was interrupted ... continue" injection — the
 * interrupted prompt just dies silently.
 *
 * A session that's `status:"running"` AT BOOT is, by definition, interrupted:
 * normal session lifecycle flips status to `done` or `failed` before the
 * gateway exits cleanly. Anything still `running` was caught mid-turn.
 */
export async function markRunningMainSessionsAsInterrupted(params: {
  sessionsDir: string;
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const storePath = path.join(path.resolve(params.sessionsDir), "sessions.json");
  await updateSessionStore(
    storePath,
    (store) => {
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry || entry.status !== "running") {
          continue;
        }
        if (shouldSkipMainRecovery(entry, sessionKey)) {
          result.skipped++;
          continue;
        }
        if (entry.abortedLastRun) {
          // Already marked — recovery will pick it up.
          continue;
        }
        entry.abortedLastRun = true;
        store[sessionKey] = entry;
        result.marked++;
      }
    },
    { skipMaintenance: true },
  );
  if (result.marked > 0) {
    log.info(
      `marked ${result.marked} interrupted main session(s) from running-at-boot state (skipped=${result.skipped})`,
    );
  }
  return result;
}

export async function markRestartAbortedMainSessionsFromLocks(params: {
  sessionsDir: string;
  cleanedLocks: SessionLockInspection[];
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const interruptedSessionIds = new Set(
    params.cleanedLocks
      .map((lock) => sessionIdFromLockPath(lock.lockPath))
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  if (interruptedSessionIds.size === 0) {
    return result;
  }

  const storePath = path.join(path.resolve(params.sessionsDir), "sessions.json");
  await updateSessionStore(
    storePath,
    (store) => {
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry || entry.status !== "running") {
          continue;
        }
        if (shouldSkipMainRecovery(entry, sessionKey)) {
          result.skipped++;
          continue;
        }
        if (!interruptedSessionIds.has(entry.sessionId)) {
          continue;
        }
        entry.abortedLastRun = true;
        store[sessionKey] = entry;
        result.marked++;
      }
    },
    { skipMaintenance: true },
  );

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} interrupted main session(s) from stale transcript locks`);
  }
  return result;
}

async function recoverStore(params: {
  storePath: string;
  resumedSessionKeys: Set<string>;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(params.storePath);
  } catch (err) {
    log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const [sessionKey, entry] of Object.entries(store).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
      continue;
    }
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (params.resumedSessionKeys.has(sessionKey)) {
      result.skipped++;
      continue;
    }

    let messages: unknown[];
    try {
      messages = readSessionMessages(entry.sessionId, params.storePath, entry.sessionFile);
    } catch (err) {
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    // FORK 2026-05-10 (user directive): we no longer block resume on the tail
    // check. The original `resumeBlockReason` heuristic was designed for
    // native sessions where the agent owns the transcript; for tinker-bridge
    // sessions the agent transcript is empty mid-flight (tinker-bridge runs in
    // a subprocess), so the heuristic always returned "transcript tail is
    // not resumable" and dropped recovery on the floor. Now:
    //   - tinker-bridge sessions: the [System] continue dispatch hits tinker-bridge
    //     which spawns claude-cli with `--resume <sessionId>` from its
    //     session-map. claude-cli loads the prior conversation including
    //     the user's prompt, sees the [System] continue, and finishes.
    //   - native sessions with resumable tail: same as before — works.
    //   - native sessions with assistant tail: a complete-looking turn IS
    //     resumed via [System] continue. Edge case: completed turns get a
    //     follow-up "continue" that the model may interpret as "anything
    //     else?". Acceptable trade-off versus dropping recovery for the
    //     common tinker-bridge case.
    // The chip wording deliberately omits any "please retry" hint; we
    // promise the user we are picking up where we stopped.
    // FORK 2026-05-31 (the architect directive): do NOT resume an IDLE session whose
    // last turn already completed. The 2026-05-10 change disabled the tail
    // check entirely to keep tinker-bridge mid-flight recovery working, but that
    // also resurrected every completed session on each restart — firing a
    // phantom [System] continue at a turn with nothing to resume (the "talked
    // with no prompt" loop). isIdleCompletedTail still resumes the empty
    // transcript (tinker-bridge mid-flight) and the dangling-tool_use cases.
    if (isIdleCompletedTail(messages)) {
      log.info(`skipping resume; last turn already completed (idle): ${sessionKey}`);
      await settleIdleSession({ storePath: params.storePath, sessionKey });
      result.skipped++;
      continue;
    }

    const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
    if (resumeBlockReason) {
      log.info(
        `attempting resume despite tail-check warning: ${sessionKey} (${resumeBlockReason})`,
      );
    }

    const resumed = await resumeMainSession({
      storePath: params.storePath,
      sessionKey,
    });
    if (resumed) {
      params.resumedSessionKeys.add(sessionKey);
      result.recovered++;
    } else {
      result.failed++;
    }
  }

  return result;
}

export async function recoverRestartAbortedMainSessions(
  params: {
    stateDir?: string;
    resumedSessionKeys?: Set<string>;
  } = {},
): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const sessionDirs = await resolveAgentSessionDirs(stateDir);

  for (const sessionsDir of sessionDirs) {
    const storeResult = await recoverStore({
      storePath: path.join(sessionsDir, "sessions.json"),
      resumedSessionKeys,
    });
    result.recovered += storeResult.recovered;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

export function scheduleRestartAbortedMainSessionRecovery(
  params: {
    delayMs?: number;
    maxRetries?: number;
    stateDir?: string;
  } = {},
): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void recoverRestartAbortedMainSessions({
        stateDir: params.stateDir,
        resumedSessionKeys,
      })
        .then((result) => {
          if (result.failed > 0 && attempt < maxRetries) {
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          }
        })
        .catch((err) => {
          if (attempt < maxRetries) {
            log.warn(`main-session restart recovery failed: ${String(err)}`);
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          } else {
            log.warn(`main-session restart recovery gave up: ${String(err)}`);
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(1, initialDelay);
}
