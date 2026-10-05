/**
 * Post-restart recovery for main sessions interrupted while holding a transcript lock.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry as TranscriptEntry,
} from "@mariozechner/pi-coding-agent";
import { resolveStateDir } from "../config/paths.js";
import { type SessionEntry, loadSessionStore, updateSessionStore } from "../config/sessions.js";
import { classifyAssistantOutcome } from "../fork/turn-outcome.js";
import { callGateway } from "../gateway/call.js";
import { type RestartNoticeHow, takeRestartContext } from "../gateway/restart-notice.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { awaitBridgeReattachScan, bridgeReattachFor } from "../infra/bridge-reattach.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { planContinuation } from "./embedded-agent-runner/continuation.js";
import { appendInterruptedRun } from "./interrupted-run-ledger.js";
import { findDanglingToolCall } from "./interrupted-run-probe.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
/** How long recovery waits for the cc-bridge's adoption scan; past it, bridge chats get a prompt. */
const BRIDGE_SCAN_WAIT_MS = 20_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * FORK 2026-09-08 — the boot-storm window: at most ONE restart-recovery resume
 * per session per this many ms, measured from the moment a resume was
 * dispatched (`SessionEntry.lastResumeAt`).
 *
 * Measured (verified 2026-09-08): journal "resumed interrupted main session:
 * agent:main:tinker:mthk0fck" at 09-01 10:16:41 AND 10:19:25 — 2m44s apart —
 * two "[System] The gateway restarted…" rows each answered in full: ONE
 * interruption, TWO different answers. The ClawHub tab got resume rows 41 s
 * apart on 09-07; systemd logged "Scheduled restart" every 10 s on 09-03 14:12.
 * Every dispatch carried a fresh `crypto.randomUUID()` idempotencyKey, so
 * nothing downstream collapsed them, and every boot sweep re-armed the RESUMED
 * run as if it were a fresh interruption.
 *
 * Ten minutes covers a restart storm with room to spare and is longer than any
 * observed duplicate gap, while a genuine interruption after a quiet gateway is
 * a NEW incident and still resumes on the next boot. Exported so the tests
 * retune with it rather than around it.
 */
export const RESUME_COOLDOWN_MS = 10 * 60_000;

/**
 * How long ago restart recovery last dispatched a resume to this entry, or
 * undefined when it never has (entries written before `lastResumeAt` existed
 * behave exactly as before). Absolute distance on purpose: a wall-clock step
 * backwards after a resume must read as "recent", not turn the window into a
 * permanent mute — the same "permanent evidence" failure class the 2026-07-31
 * recency gate in `recoverStore` was written to close.
 */
function resumeAgeMs(entry: SessionEntry, now: number): number | undefined {
  const at = entry.lastResumeAt;
  if (typeof at !== "number" || !Number.isFinite(at)) {
    return undefined;
  }
  return Math.abs(now - at);
}

function isWithinResumeCooldown(ageMs: number | undefined): boolean {
  return ageMs !== undefined && ageMs < RESUME_COOLDOWN_MS;
}

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

/**
 * FORK 2026-07-31 — resolve the on-disk transcript file for an entry so the
 * dangling-tool probe can read the RAW jsonl.
 *
 * Deliberately mirrors the two candidates that
 * `readSessionMessages(entry.sessionId, params.storePath, entry.sessionFile)`
 * already tries, in the same order. The probe MUST look at the same file the
 * recovery loop just parsed — probing a different transcript would be worse
 * than not probing at all, because it would silently disagree with the idle
 * check it is supposed to override.
 */
function resolveTranscriptPath(entry: SessionEntry, storePath: string): string | undefined {
  const sessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (sessionFile && fs.existsSync(sessionFile)) {
    return sessionFile;
  }
  const bySessionId = path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);
  return fs.existsSync(bySessionId) ? bySessionId : undefined;
}

type DanglingToolCall = NonNullable<ReturnType<typeof findDanglingToolCall>>;

/**
 * FORK 2026-07-31 — one shape for every ledger line so `detected` and
 * `resumed`/`resume-failed` describe the SAME incident and can be joined on
 * `toolCallId` when reading the ledger back.
 */
function buildInterruptedRunRecord(params: {
  sessionKey: string;
  entry: SessionEntry;
  dangling: DanglingToolCall;
  action: "detected" | "resumed" | "resume-failed";
}): Parameters<typeof appendInterruptedRun>[0] {
  const { dangling, entry } = params;
  return {
    ts: Date.now(),
    sessionKey: params.sessionKey,
    action: params.action,
    detector: "dangling-tinker-bridge-tool",
    sessionId: entry.sessionId,
    toolCallId: dangling.toolCallId,
    ...(dangling.runId ? { runId: dangling.runId } : {}),
    ...(dangling.name ? { toolName: dangling.name } : {}),
    ...(typeof dangling.startedAt === "number" ? { toolStartedAt: dangling.startedAt } : {}),
    ...(typeof entry.providerOverride === "string" && entry.providerOverride
      ? { provider: entry.providerOverride }
      : {}),
    ...(typeof entry.modelOverride === "string" && entry.modelOverride
      ? { model: entry.modelOverride }
      : {}),
  };
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
  // FORK 2026-09-29 (tinker-ui.md §5.8AB): readSessionMessages serves an `openclaw:prompt-error`
  // that ended its run as a display-only assistant row (session-utils.fs.ts). It is evidence the
  // run FAILED, not that it answered, so it must never count as a completed assistant tail.
  const kind = (message as { __openclaw?: { kind?: unknown } } | null)?.__openclaw?.kind;
  if (kind === "prompt-error") {
    return false;
  }
  return true;
}

function getMessageTimestampMs(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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
function isIdleCompletedTail(messages: unknown[], activeRunStartedAt?: number): boolean {
  const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
  if (!lastMeaningful || getMessageRole(lastMeaningful) !== "assistant") {
    return false;
  }
  if (assistantTurnHasPendingToolUse(lastMeaningful)) {
    return false;
  }
  // FORK 2026-09-29 (lifecycles.md L4b, tinker-ui.md §5.8AB): an assistant row that classifies as a
  // failure (an error or restart envelope, an abort, an empty answer) is not a completed turn. The
  // restart itself can leave one behind, the draining reply's "gateway restarting" envelope, and it
  // used to settle the interrupted chat as idle.
  if (classifyAssistantOutcome(lastMeaningful)) {
    return false;
  }
  const tailTimestamp = getMessageTimestampMs(lastMeaningful);
  if (
    typeof activeRunStartedAt === "number" &&
    Number.isFinite(activeRunStartedAt) &&
    typeof tailTimestamp === "number" &&
    tailTimestamp < activeRunStartedAt
  ) {
    return false;
  }
  return true;
}

/**
 * FORK 2026-09-04 (reported: "an automated system message appears without any
 * need, that wakes up opus to finally say that there was nothing to do"). The prompt
 * used to open with "The gateway restarted" unconditionally — including on the
 * mid-tool path, where no restart need have happened at all. Three consecutive
 * Opus turns were spent theorizing about a restart the gateway PID proved never
 * occurred. State the actual cause, and say up front that finding the work
 * already done is a valid, cheap outcome — it is the outcome we EXPECT whenever
 * a duplicate slips through.
 */
/** When this host booted, in ms since the epoch (from the kernel's uptime). */
export function hostBootedAtMs(now: number = Date.now(), uptimeS: number = os.uptime()): number {
  return now - uptimeS * 1000;
}

/**
 * FORK 2026-10-01 — a reboot is not a gateway restart. The plain resume said "The gateway
 * restarted" after a freeze and power-off as well (AcmeVision worker, interrupted 06:35, back
 * 07:13): the agent wrote that cause into a status file, and its earlier probes and /tmp files
 * were gone without it knowing why. When the interrupted turn's newest transcript entry is older
 * than this boot, the machine went down: returns the boot time, else null.
 */
export function rebootedAtMs(
  lastActivityMs: number | undefined,
  bootedAtMs: number,
): number | null {
  return lastActivityMs !== undefined && lastActivityMs < bootedAtMs ? bootedAtMs : null;
}

function newestTimestampMs(messages: unknown[]): number | undefined {
  let newest: number | undefined;
  for (const message of messages) {
    const t = getMessageTimestampMs(message);
    if (t !== undefined && (newest === undefined || t > newest)) {
      newest = t;
    }
  }
  return newest;
}

/** Local HH:MM, the way the chat shows times. */
function clockTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

/**
 * The reboot wording keeps the clause "the gateway restarted and interrupted your previous turn"
 * verbatim: the Tinker UI recognises the resume notice by it (tinker-ui/src/fractal-prompt-strip.ts,
 * tinker-ui/src/system-notice.ts).
 */
export function buildResumeMessage(
  dangling?: DanglingToolCall | null,
  rebootedAt?: number | null,
): string {
  // FORK 2026-05-30 (the architect directive): the resume must be LEGIBLE. The user
  // wants a brief "here's where I'm picking up" note — which plan step, what's
  // already on disk vs. half-written — so they can see whether the restart
  // cost much work and that resume actually worked, THEN seamless continuation.
  const lost =
    rebootedAt == null
      ? ""
      : " Every process the turn started is gone; check /tmp before trusting files there.";
  const cause = dangling
    ? `[System] Your previous turn stopped while the tool \`${dangling.name ?? "unknown"}\` (${dangling.toolCallId}) was still running, so its result never arrived.` +
      (rebootedAt == null
        ? ""
        : ` The machine was shut down or rebooted meanwhile (it was back at ${clockTime(rebootedAt)}).${lost}`)
    : rebootedAt == null
      ? "[System] The gateway restarted and interrupted your previous turn."
      : `[System] The machine was shut down or rebooted (it was back at ${clockTime(rebootedAt)}), so the gateway restarted and interrupted your previous turn.${lost}`;
  return (
    `${cause} Resume it, and make the resume legible to the user:\n` +
    '1. ORIENT FIRST — post one short message (1-3 sentences) stating where you are picking up. If you have an active prefrontal plan, call prefrontal.plan.get and name the step you were on plus which artifacts are already complete on disk vs. half-finished; if there is no plan, summarize from the transcript tail what was in flight. Example shape: "Plan was already written; I was interrupted on step 3 — 3 files complete on disk, 1 half-written. Reading them and resuming."\n' +
    "2. RECOVER CONTEXT — read any half-written artifacts (and run `git status`) so you continue from the real on-disk state, not from memory.\n" +
    "3. CHECK BEFORE REDOING — this message is an instruction to CONTINUE work, so acting on it twice would do the work twice. Verify each artifact the turn owed actually on disk first. If they are all already complete, say so in one line and STOP; never re-run a deploy, a send or a delete on the strength of this message alone.\n" +
    "4. CONTINUE as if nothing happened — finish whatever is genuinely unfinished; do NOT redo steps already marked done.\n" +
    "Keep the orientation brief; its only job is to show the user where you resumed and roughly what the interruption cost."
  );
}

/**
 * FORK 2026-09-04 — the `agent` RPC does not ack until the turn is actually
 * under way, and a turn takes minutes; the 10 s call timeout is a bound on the
 * ACK, not on delivery. When it fires the prompt has already been handed to the
 * gateway (measured: three forensic dumps, one per "failed" attempt). Treating
 * that as a failure is what armed the retry that sent the same prompt three
 * times per boot, so a timeout must read as DISPATCHED — the conservative
 * direction, since a duplicate resume is an instruction to redo work while a
 * missed one only costs a turn the user can re-ask for.
 */
function isGatewayDispatchTimeout(err: unknown): boolean {
  return err instanceof Error && /gateway timeout after \d+ms/.test(err.message);
}

type ResumeVerdict = "resumed" | "dispatched" | "failed";

export async function markSessionFailed(params: {
  storePath: string;
  sessionKey: string;
  reason: string;
  /**
   * FORK 2026-07-30 — `abortedLastRun` is not just bookkeeping: `body.ts`
   * prefixes the NEXT user turn with "The previous agent run was aborted by the
   * user. Resume carefully or ask for clarification." That copy is right for a
   * kill/abort and WRONG for a provider failure — a Grok timeout would make
   * Jarvis open the following turn asking for clarification it doesn't need.
   * Callers that are recording a *failure* (not an abort) pass `false`.
   * Defaults to `true` to preserve the 2026-05-12 surface_error behaviour.
   */
  abortedLastRun?: boolean;
}): Promise<void> {
  await updateSessionStore(
    params.storePath,
    (store) => {
      const entry = store[params.sessionKey];
      if (!entry || entry.status !== "running") {
        return;
      }
      entry.status = "failed";
      entry.abortedLastRun = params.abortedLastRun ?? true;
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
 * FORK 2026-09-29 (lifecycles.md L4b) — the visible "Gateway restarted" row in each chat recovery
 * resumes: when it paused, when it came back, why, and how it resumed (gateway/restart-notice.ts).
 *
 * It replaces the 2026-05-10 `chat.inject` error envelope. That one was an assistant MESSAGE: it
 * became the transcript tail, so a promptless `Agent.continue()` refused it, and the next prompt's
 * model read it. The notice is a display-only custom entry. Wording stays as before: never "retry".
 *
 * Best-effort: if it fails, recovery still proceeds.
 */
async function postRestartNotice(params: {
  sessionKey: string;
  how: RestartNoticeHow;
}): Promise<void> {
  const ctx = takeRestartContext();
  try {
    await callGateway({
      method: "chat.restartNotice",
      params: {
        sessionKey: params.sessionKey,
        how: params.how,
        ...(ctx ? { stoppedAt: ctx.stoppedAt } : {}),
        ...(ctx?.reason ? { reason: ctx.reason } : {}),
      },
      timeoutMs: 5_000,
    });
    log.info(`posted restart notice (${params.how}) to ${params.sessionKey}`);
  } catch (err) {
    log.warn(`failed to post restart notice: ${String(err)}`);
  }
}

type ResumePlan = {
  how: RestartNoticeHow;
  /** Dispatch the run with no prompt (the resume message rides along only as a fallback). */
  continueFromTranscript: boolean;
  /** False when a run already took the turn (the architect's own prompt reached a held worker). */
  dispatch: boolean;
};

/**
 * FORK 2026-09-30 (lifecycles.md L4b) — how this interrupted session comes back:
 *   - an embedded turn continues from its transcript when the transcript allows it;
 *   - a cc-bridge turn whose worker the bridge adopted, frozen mid-turn, is REATTACHED: the
 *     continued run takes the live worker's turn (src/infra/bridge-reattach.ts);
 *   - anything else gets the resume prompt, as before (a cc-bridge turn lives in its CLI session,
 *     so without a held worker only a prompt reaches it).
 */
function planResume(
  entry: SessionEntry,
  sessionKey: string,
  transcriptPath: string | undefined,
): ResumePlan {
  const provider = entry.providerOverride ?? entry.modelProvider;
  if (provider === "claude-code") {
    const held = bridgeReattachFor(sessionKey);
    if (held) {
      return {
        how: "reattached",
        continueFromTranscript: true,
        dispatch: held.state === "pending",
      };
    }
    return { how: "prompted", continueFromTranscript: false, dispatch: true };
  }
  return canContinueFromTranscript(transcriptPath)
    ? { how: "continued", continueFromTranscript: true, dispatch: true }
    : { how: "prompted", continueFromTranscript: false, dispatch: true };
}

/**
 * FORK 2026-09-29 (lifecycles.md L4b) — can this embedded turn go on from its transcript, with no
 * prompt? The drain left it at a model-call boundary, so the tail is normally a tool result or the
 * user's own prompt. Planned against the same context the runner loads (buildSessionContext); the
 * runner plans again and falls back to the resume message if its answer differs.
 */
function canContinueFromTranscript(transcriptPath: string | undefined): boolean {
  if (!transcriptPath) {
    return false;
  }
  try {
    // Parsed by hand, never through SessionManager.open: that TRUNCATES a file with no session
    // header, and this check must not write.
    const entries = parseSessionEntries(fs.readFileSync(transcriptPath, "utf8"));
    const header = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (header?.type !== "session" || typeof header.id !== "string") {
      return false;
    }
    migrateSessionEntries(entries);
    const body = entries.filter((e) => e.type !== "session") as TranscriptEntry[];
    return planContinuation(buildSessionContext(body).messages).ok;
  } catch (err) {
    log.warn(`continuation check failed for ${transcriptPath}: ${String(err)}`);
    return false;
  }
}

/**
 * The model this session is explicitly pinned to, if any.
 *
 * FORK 2026-07-29 (the architect: "I specifically requested Grok and Sol did the job instead").
 * Measured: `agent:main:main` held `providerOverride=xai / modelOverride=grok-4.5 (source=user)`,
 * the gateway restarted, and the resumed turn ran `codex/gpt-5.6-sol`.
 *
 * `server-methods/agent.ts` does resolve a session's model itself (resolveSessionModelRef), but
 * recovery dispatches DURING STARTUP — the same window in which the gateway was still answering
 * `chat.history` with "unavailable during gateway startup". Ambient resolution against a store
 * that may still be warming is not something a replayed turn should depend on, so state the
 * pinned model explicitly instead of hoping it is inferred.
 */
async function readPinnedModel(
  storePath: string,
  sessionKey: string,
): Promise<{ provider: string; model: string } | undefined> {
  try {
    const store = await loadSessionStore(storePath);
    const entry = store?.[sessionKey];
    const provider = entry?.providerOverride;
    const model = entry?.modelOverride;
    if (typeof provider === "string" && provider && typeof model === "string" && model) {
      return { provider, model };
    }
  } catch (err) {
    log.warn(`could not read pinned model for ${sessionKey}: ${String(err)}`);
  }
  return undefined;
}

async function resumeMainSession(params: {
  storePath: string;
  sessionKey: string;
  dangling?: DanglingToolCall | null;
  plan?: ResumePlan;
  /** Boot time when the machine went down during the turn (rebootedAtMs), else null. */
  rebootedAt?: number | null;
}): Promise<ResumeVerdict> {
  let dispatched = false;
  const plan = params.plan ?? { how: "prompted", continueFromTranscript: false, dispatch: true };
  try {
    await postRestartNotice({ sessionKey: params.sessionKey, how: plan.how });
    const pinned = await readPinnedModel(params.storePath, params.sessionKey);
    const baseParams = {
      message: buildResumeMessage(params.dangling, params.rebootedAt),
      sessionKey: params.sessionKey,
      idempotencyKey: crypto.randomUUID(),
      deliver: false,
      lane: CommandLane.Main,
      ...(plan.continueFromTranscript ? { continueFromTranscript: true } : {}),
    };
    try {
      if (plan.dispatch) {
        await callGateway<{ runId: string }>({
          method: "agent",
          params: pinned
            ? { ...baseParams, provider: pinned.provider, model: pinned.model }
            : baseParams,
          timeoutMs: 10_000,
        });
        if (pinned) {
          log.info(
            `resuming ${params.sessionKey} on its pinned ${pinned.provider}/${pinned.model}`,
          );
        }
      } else {
        // The architect's own prompt reached the held worker first and took its turn. Nothing is
        // sent; the bookkeeping below still settles the session.
        log.info(
          `not dispatching a resume to ${params.sessionKey}: a run already took its held turn`,
        );
      }
    } catch (err) {
      // FORK 2026-09-04 — a missed ACK is not a failed delivery; see
      // `isGatewayDispatchTimeout`. Fall through to the bookkeeping below so the
      // session is settled exactly as if the ack had arrived, and no retry
      // re-sends this prompt.
      if (isGatewayDispatchTimeout(err)) {
        dispatched = true;
        log.info(
          `resume dispatched to ${params.sessionKey} but the gateway did not ack in time; treating as dispatched, not retrying`,
        );
      } else if (!pinned) {
        // `agent` rejects provider/model from a caller without allowModelOverride. Resuming the turn
        // at all matters more than resuming it on the right model, so never let the override be the
        // reason recovery fails — retry once without it, loudly.
        throw err;
      } else {
        log.warn(
          `resume with pinned ${pinned.provider}/${pinned.model} failed (${String(err)}); retrying without the model override`,
        );
        try {
          await callGateway<{ runId: string }>({
            method: "agent",
            params: baseParams,
            timeoutMs: 10_000,
          });
        } catch (retryErr) {
          // FORK 2026-09-30 — the same rule as the first call (`isGatewayDispatchTimeout`): a missed
          // ack is a delivered prompt. Read as a failure it armed the retry pass AND the restart
          // skill's own fallback, and a live test got its chat resumed twice (01:21:58, 01:22:17,
          // 01:22:30).
          if (!isGatewayDispatchTimeout(retryErr)) {
            throw retryErr;
          }
          dispatched = true;
          log.info(
            `resume dispatched to ${params.sessionKey} (without the model override) but the gateway did not ack in time; treating as dispatched, not retrying`,
          );
        }
      }
    }
    await updateSessionStore(
      params.storePath,
      (store) => {
        const entry = store[params.sessionKey];
        if (!entry) {
          return;
        }
        const now = Date.now();
        entry.abortedLastRun = false;
        entry.updatedAt = now;
        // FORK 2026-09-08 — write-once at the source: the resume prompt is out
        // the door, stamp WHEN. Reached on the acked path AND on the ack-timeout
        // path (both deliver); a hard dispatch error throws past this block, so
        // its legitimate retry is not suppressed. Read against
        // RESUME_COOLDOWN_MS by `markRunningMainSessionsAsInterrupted` and
        // `recoverStore` so the next boot can tell "this `running` entry is the
        // resume we just sent" from "this is a fresh interruption".
        entry.lastResumeAt = now;
        // FORK 2026-09-04 — remember WHICH stuck tool call we already fired a
        // resume for. A dangling `phase:'start'` record is permanent evidence
        // (nothing ever pairs it retroactively), so without this the same call
        // forces a fresh resume on every boot for the rest of the session's
        // life. Measured: one Bash call stuck at 10:25 produced six Opus turns
        // across two boots. Keyed on the toolCallId, so a genuinely NEW
        // mid-tool interruption still resumes.
        if (params.dangling) {
          entry.restartResumeToolCallId = params.dangling.toolCallId;
        }
        store[params.sessionKey] = entry;
      },
      { skipMaintenance: true },
    );
    log.info(
      dispatched
        ? `dispatched resume to interrupted main session: ${params.sessionKey}`
        : `resumed interrupted main session: ${params.sessionKey}`,
    );
    return dispatched ? "dispatched" : "resumed";
  } catch (err) {
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(err)}`);
    return "failed";
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
 *
 * FORK 2026-09-08 — with ONE exception: a run that recovery itself resumed
 * less than RESUME_COOLDOWN_MS ago. That entry is `running` because OUR resume
 * is (or was) under way, not because a new turn was caught; see the guard in
 * the loop.
 */
export async function markRunningMainSessionsAsInterrupted(params: {
  sessionsDir: string;
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const storePath = path.join(path.resolve(params.sessionsDir), "sessions.json");
  await updateSessionStore(
    storePath,
    (store) => {
      const now = Date.now();
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
        // FORK 2026-09-08 (measured: ONE interruption, TWO different answers —
        // see RESUME_COOLDOWN_MS). A `running` entry whose resume we dispatched
        // inside the window is not a fresh interruption: it is OUR resume's run,
        // killed by the next boot of a systemd restart storm. Marking it hands
        // `recoverStore` a second turn to resume, which is exactly how the
        // duplicate was produced. Leave it alone inside the window; past the
        // window it is an ordinary interrupted run again and is marked exactly
        // as before. The stale-lock sweep can still mark it on an unclean boot —
        // `recoverStore` applies the same window, so that path is held too.
        const ageMs = resumeAgeMs(entry, now);
        if (isWithinResumeCooldown(ageMs)) {
          log.info(
            `not re-marking ${sessionKey}: its resume was dispatched ${ageMs}ms ago (boot-storm window ${RESUME_COOLDOWN_MS}ms)`,
          );
          result.skipped++;
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
    // FORK 2026-07-31 (the architect, measured incident: gateway restart SIGTERMed a
    // tinker-bridge agent mid-tool; the thinking indicator vanished and no answer
    // ever arrived). The idle check below has a BLIND SPOT that no amount of
    // staring at `messages` can close, so do NOT "simplify" this probe away:
    //
    //   1. tinker-bridge does not write `tool_use` blocks into the OpenClaw
    //      transcript at all. It persists tool events as custom entries —
    //      `{type:'custom', customType:'tinker-bridge-tool',
    //        data:{runId, phase:'start'|'result', toolCallId, name, startedAt}}`
    //      (see fork/attempt-hooks.ts, appendCustomEntry).
    //   2. Production transcripts are the pi-coding-agent TREE format, and the
    //      tree branch of `readSessionMessages` emits ONLY `message` and
    //      `compaction` entries — every `custom` record is dropped. So `messages`
    //      physically cannot contain the tool call.
    //   3. At SIGTERM the assistant's already-streamed TEXT was persisted but its
    //      tool block was not, so the transcript tail is a text-only assistant
    //      message.
    //   4. `assistantTurnHasPendingToolUse` therefore finds nothing,
    //      `isIdleCompletedTail` says "idle", `settleIdleSession` flips the entry
    //      to status:'done' / abortedLastRun:false, and the recovery gate at the
    //      top of this loop stops matching FOREVER. The turn is never resumed.
    //
    // The fix reads the raw jsonl for a `phase:'start'` tinker-bridge tool record
    // with no matching `phase:'result'`. A dangling call is positive proof the
    // turn died MID-TOOL, and that outranks any tail-shape heuristic — so when it
    // is found we skip the idle branch entirely and fall through to resume.
    // `isIdleCompletedTail` itself is deliberately left untouched: it only ever
    // sees parsed `message` records, i.e. exactly the information that is missing.
    let dangling: DanglingToolCall | null = null;
    const transcriptPath = resolveTranscriptPath(entry, params.storePath);
    if (transcriptPath) {
      try {
        dangling = findDanglingToolCall(transcriptPath);
      } catch (err) {
        // A probe failure must never be worse than no probe: fall back to the
        // pre-2026-07-31 behaviour rather than dropping the session.
        log.warn(`dangling-tool probe failed for ${sessionKey}: ${String(err)}`);
      }
    }
    // FORK 2026-07-31 (adversarial review) — a dangling start is PERMANENT evidence: nothing
    // pairs it retroactively (emitToolResult needs a claude-cli tool_result echo; onTurnComplete
    // drains the buffer on EVERY exit, including aborted/timedOut/promptError). Without a recency
    // bound, ONE stale start makes settleIdleSession unreachable forever for this session key and
    // restores the 2026-05-31 phantom-resume loop. Measured: 27/295 live transcripts already carry
    // one, some 36 days old; replaying three days of real "idle" boots gave 4 false forced resumes
    // for every 2 correct ones. Only evidence from the CURRENT run may force a resume.
    //
    // POLICY: when EITHER timestamp is missing or non-finite we DROP the dangling call and fall
    // back to the pre-existing idle heuristic. That is the conservative direction — it can only
    // ever MISS a resume, never MANUFACTURE a phantom one, and it restores exactly the old
    // behaviour in the unknown case. Never invert this.
    if (
      dangling &&
      !(
        typeof dangling.startedAt === "number" &&
        Number.isFinite(dangling.startedAt) &&
        typeof entry.startedAt === "number" &&
        Number.isFinite(entry.startedAt) &&
        dangling.startedAt >= entry.startedAt
      )
    ) {
      log.info(
        `ignoring stale dangling tool call (${dangling.name ?? "unknown"} ${dangling.toolCallId}, startedAt=${dangling.startedAt ?? "unknown"}) older than the interrupted run (startedAt=${entry.startedAt ?? "unknown"}): ${sessionKey}`,
      );
      dangling = null;
    }

    // FORK 2026-09-04 (measured incident: one chat tab looped six Opus
    // turns on ONE stuck Bash call). The 2026-07-31 recency gate above bounds a
    // dangling call against `entry.startedAt` — but `startedAt` only advances
    // when a resumed run actually starts, and a resume whose ack timed out left
    // it untouched. So the gate held open and the same call forced a resume on
    // every pass, forever. This is the second, absolute bound: we fire AT MOST
    // ONE resume per toolCallId, ever. It is keyed on the call rather than on
    // elapsed time so a genuine mid-tool interruption after a long shutdown is
    // still recovered, and a genuinely new stuck call still is too — outside
    // the boot-storm window below (FORK 2026-09-08): inside RESUME_COOLDOWN_MS
    // of a dispatched resume even a NEW dangling call is that resume's own run
    // dying in the storm, and it waits for the window like everything else.
    if (dangling && entry.restartResumeToolCallId === dangling.toolCallId) {
      log.info(
        `already fired one resume for dangling tool call ${dangling.toolCallId}; not re-firing: ${sessionKey}`,
      );
      dangling = null;
    }

    // FORK 2026-09-08 — the idle branch now runs BEFORE the mid-tool ledger
    // write. The two are mutually exclusive (`dangling` vs `!dangling`, and
    // neither reassigns it), so the order is behaviourally identical — it just
    // lets the boot-storm window sit between them, where it can hold back a
    // duplicate resume WITHOUT stranding an idle session and WITHOUT opening a
    // `detected` ledger row that no `resumed`/`resume-failed` row ever closes.
    if (!dangling && isIdleCompletedTail(messages, entry.startedAt)) {
      log.info(`skipping resume; last turn already completed (idle): ${sessionKey}`);
      await settleIdleSession({ storePath: params.storePath, sessionKey });
      result.skipped++;
      continue;
    }

    // FORK 2026-09-08 (measured: ONE interruption, TWO different answers — see
    // RESUME_COOLDOWN_MS for the journal evidence). `resumeMainSession` clears
    // `abortedLastRun` but leaves `status:"running"` (the resumed run really is
    // in flight), so a restart storm's next boot found the session it had just
    // resumed, re-armed it, and this loop matched it again. The toolCallId
    // guard above remembers only the dangling-tool path; the plain "gateway
    // restarted" path had no memory of ever having resumed, and the stale-lock
    // sweep re-arms `abortedLastRun` on every unclean boot regardless. This is
    // the write-once-at-the-source bound: ONE resume per window, recorded
    // where the dispatch happens (`lastResumeAt`), not a dedup of the prompt
    // downstream.
    //
    // It sits AFTER the idle check on purpose: a resumed turn that finished
    // before the next boot has nothing to resume and still settles to done;
    // only a genuinely unfinished turn is held back. `abortedLastRun` is
    // deliberately left armed — the window DEFERS, it does not settle: the
    // interruption is real, the first boot after the window resumes it, and if
    // the user types first `body.ts` consumes the flag as before. Clearing it
    // here would discard a genuine interruption that outlives the window.
    const ageMs = resumeAgeMs(entry, Date.now());
    if (isWithinResumeCooldown(ageMs)) {
      log.info(
        `skipping resume; a resume was already dispatched ${ageMs}ms ago (boot-storm window ${RESUME_COOLDOWN_MS}ms): ${sessionKey}`,
      );
      result.skipped++;
      continue;
    }

    if (dangling) {
      log.info(
        `interrupted mid-tool (${dangling.name ?? "unknown"} ${dangling.toolCallId}); forcing resume: ${sessionKey}`,
      );
      // appendInterruptedRun swallows its own errors, so awaiting it can never
      // break recovery. Ledger only for dangling that SURVIVED the recency gate.
      await appendInterruptedRun(
        buildInterruptedRunRecord({ sessionKey, entry, dangling, action: "detected" }),
      );
    }

    const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
    if (resumeBlockReason) {
      log.info(
        `attempting resume despite tail-check warning: ${sessionKey} (${resumeBlockReason})`,
      );
    }

    const verdict = await resumeMainSession({
      storePath: params.storePath,
      sessionKey,
      dangling,
      plan: planResume(entry, sessionKey, transcriptPath),
      rebootedAt: rebootedAtMs(newestTimestampMs(messages), hostBootedAtMs()),
    });
    const resumed = verdict !== "failed";
    if (dangling) {
      // FORK 2026-07-31 — close the ledger entry opened at detection time so the
      // forced mid-tool resume is auditable end-to-end (detected → resumed /
      // resume-failed), joinable on toolCallId.
      await appendInterruptedRun(
        buildInterruptedRunRecord({
          sessionKey,
          entry,
          dangling,
          action: resumed ? "resumed" : "resume-failed",
        }),
      );
    }
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
  // FORK 2026-09-30 (lifecycles.md L4b): a cc-bridge worker the last gateway froze mid-turn is
  // adopted by the bridge's gateway_start scan; read its list only once it is complete.
  await awaitBridgeReattachScan(BRIDGE_SCAN_WAIT_MS);

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
