/**
 * FORK 2026-10-09 — wake a Tinker chat once the Claude usage limit that cut its turn has reset.
 *
 * Measured 2026-10-09: the five-hour window ran out at 19:37 and turns in Tinker chats ended with
 * "You've hit your session limit · resets 8:30pm (Europe/Madrid)". Nothing resumed them; the owner
 * restarted three chats by hand at 20:52, 22 minutes after the reset. The 2026-09-03 retry
 * (src/auto-reply/reply/rate-limit-retry.ts) never saw these turns: it hangs off the embedded
 * runner's "failed before reply" funnel, and this bridge ends a limit-hit turn as an ordinary
 * `done` message carrying the `__ERR_ENV__` envelope (stream.ts, the `is_error` arm), so nothing
 * failed as far as the runner knows. That arm is where this module is called from.
 *
 * What it does, all in code:
 *   - ONE pending wake per chat, persisted in `~/.openclaw/tinker-bridge/limit-resume.json`. A
 *     newer limit error in the same chat replaces the older wake.
 *   - Fires at the stated reset + 2 minutes, through `chat.send` (the lane longjob and
 *     wake-on-finish use), as a blue agent bubble that names itself: LIMIT_RESUME_MESSAGE.
 *   - Skips when any prompt reached that chat after the error: the owner's, an agent's wake, a
 *     gateway `[System]` resume (read from the chat's transcript at fire time, so a chat Auto
 *     routing moved to another provider counts too). Wider than "the owner wrote" on purpose:
 *     master-worker's wake-on-finish re-sends its own wake after a limit reset (develop
 *     1a53f9fd49e), and a second "continue" on top of it would start a second turn. Nothing is
 *     lost by skipping: a later prompt whose turn hit the limit again armed a fresh wake.
 *   - Survives a gateway restart: the record on disk is the one-shot, the timer is only the clock,
 *     and `gateway_start` re-arms every record. A wake whose moment passed while the gateway was
 *     down fires shortly after boot; one more than LIMIT_RESUME_STALE_MS overdue is dropped.
 *   - At most once: the record is removed before the send, so a crash mid-send loses a wake
 *     rather than doubling it.
 *
 * Measured 2026-10-09 over 30 days of gateway logs: 0 of 189 limit errors with a bare clock reset
 * were logged after their own stated reset, so reset + 2 minutes finds the window open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLongUsageWindow, parseRateLimitReset } from "openclaw/plugin-sdk/fork-rate-limit-reset";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

/** How long after the stated reset the wake fires. */
export const LIMIT_RESUME_DELAY_MS = 2 * 60_000;
/** No Claude window is longer than a week; a reset further out than this is a misparse. */
export const LIMIT_RESUME_MAX_HORIZON_MS = 8 * 24 * 60 * 60_000;
/** A wake overdue by more than this at boot (laptop off, gateway down) is dropped, not sent. */
export const LIMIT_RESUME_STALE_MS = 6 * 60 * 60_000;
/** An overdue wake found at boot fires this long after the boot, not in the same millisecond. */
export const LIMIT_RESUME_BOOT_SETTLE_MS = 30_000;

export const LIMIT_RESUME_MESSAGE =
  "⟦AGENT:⏰ Limit reset⟧ The usage limit that stopped your last turn has reset; continue where you stopped.";

export type LimitResumeRecord = {
  sessionKey: string;
  /** When the limit error ended the turn, epoch ms. The skip check reads prompts after it. */
  errorAt: number;
  /** The reset the provider stated, epoch ms. */
  resetAt: number;
  /** resetAt + LIMIT_RESUME_DELAY_MS. */
  fireAt: number;
  /** The provider's own text, kept for the log. */
  raw: string;
};

export type LimitResumeDeps = {
  send: (req: { sessionKey: string; message: string; idempotencyKey: string }) => Promise<void>;
  promptedSince: (sessionKey: string, sinceMs: number) => boolean;
};

const TINKER_CHAT_RE = /^agent:[^:]+:tinker:[^:]+$/;

/** A Tinker tab (`agent:<id>:tinker:<tab>`); subagents, Fractal turns and channels are not. */
export function isTinkerChatSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && TINKER_CHAT_RE.test(sessionKey);
}

/**
 * The wake a turn-ending error asks for, or null. Pure: no clock read, no disk.
 * Null unless the chat is a Tinker tab, the text names a usage window (session, weekly, five-hour)
 * and a reset time, and that reset is inside the horizon.
 */
export function planLimitResume(params: {
  sessionKey: string | undefined;
  raw: string;
  now: number;
}): LimitResumeRecord | null {
  const { sessionKey, raw, now } = params;
  if (!sessionKey || !isTinkerChatSessionKey(sessionKey) || !isLongUsageWindow(raw)) {
    return null;
  }
  const resetAt = parseRateLimitReset(raw, now);
  if (resetAt === undefined || resetAt - now > LIMIT_RESUME_MAX_HORIZON_MS) {
    return null;
  }
  return {
    sessionKey,
    errorAt: now,
    resetAt,
    fireAt: Math.max(resetAt, now) + LIMIT_RESUME_DELAY_MS,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Did anything prompt the chat after the error
// ---------------------------------------------------------------------------

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * True when the transcript holds a prompt (a user-role message with text) after `sinceMs`, whoever
 * sent it. Takes the transcript text so it tests without a disk.
 */
export function promptAfter(transcriptJsonl: string, sinceMs: number): boolean {
  for (const line of transcriptJsonl.split("\n")) {
    if (!line.includes('"user"')) {
      continue;
    }
    let record: { type?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const message = record.message;
    if (record.type !== "message" || !message || message.role !== "user") {
      continue;
    }
    const at =
      typeof message.timestamp === "number"
        ? message.timestamp
        : typeof record.timestamp === "string"
          ? Date.parse(record.timestamp)
          : Number.NaN;
    if (!(at > sinceMs)) {
      continue;
    }
    if (messageText(message.content).trim()) {
      return true;
    }
  }
  return false;
}

/** The chat's transcript on disk, read at fire time (the file rotates on reset and compaction). */
export async function promptedSinceOnDisk(sessionKey: string, sinceMs: number): Promise<boolean> {
  const { loadSessionStore, resolveStorePath } =
    await import("openclaw/plugin-sdk/session-store-runtime");
  const agentId = sessionKey.split(":")[1];
  const storePath = resolveStorePath(undefined, { agentId });
  const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
  if (!entry) {
    return false;
  }
  const transcript =
    entry.sessionFile || path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);
  try {
    return promptAfter(fs.readFileSync(transcript, "utf8"), sinceMs);
  } catch {
    // No transcript to read: nothing shows the chat moved on, and the wake is what was asked for.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const STORE_PATH_ENV = "OPENCLAW_TINKER_BRIDGE_LIMIT_RESUME";

function storePath(): string {
  return (
    process.env[STORE_PATH_ENV] ||
    path.join(os.homedir(), ".openclaw", "tinker-bridge", "limit-resume.json")
  );
}

function isRecord(value: unknown): value is LimitResumeRecord {
  const r = value as Partial<LimitResumeRecord> | null;
  return (
    !!r &&
    typeof r.sessionKey === "string" &&
    isTinkerChatSessionKey(r.sessionKey) &&
    Number.isFinite(r.errorAt) &&
    Number.isFinite(r.resetAt) &&
    Number.isFinite(r.fireAt)
  );
}

export function readLimitResumes(): LimitResumeRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as { wakes?: unknown };
    return Array.isArray(parsed?.wakes) ? parsed.wakes.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function writeLimitResumes(wakes: LimitResumeRecord[]): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, wakes }, null, 2)}\n`, "utf8");
  // Atomic swap: a half-written store would read as "no wakes" and drop one silently.
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function sendThroughGateway(req: {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<void> {
  const { callGateway } = await import("openclaw/plugin-sdk/gateway-runtime");
  await callGateway({ method: "chat.send", params: req, timeoutMs: 30_000 });
}

let deps: {
  send: LimitResumeDeps["send"];
  promptedSince: (sessionKey: string, sinceMs: number) => boolean | Promise<boolean>;
} = { send: sendThroughGateway, promptedSince: promptedSinceOnDisk };

/** Tests replace the gateway call and/or the transcript read; null restores both. */
export function setLimitResumeDeps(next: Partial<LimitResumeDeps> | null): void {
  deps = {
    send: next?.send ?? sendThroughGateway,
    promptedSince: next?.promptedSince ?? promptedSinceOnDisk,
  };
}

const SEND_ATTEMPTS = 4;
const SEND_RETRY_MS = 15_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function arm(sessionKey: string, atMs: number): void {
  const existing = timers.get(sessionKey);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(
    () => {
      timers.delete(sessionKey);
      void fire(sessionKey);
    },
    Math.max(0, atMs - Date.now()),
  );
  timer.unref?.();
  timers.set(sessionKey, timer);
}

async function fire(sessionKey: string): Promise<void> {
  const wakes = readLimitResumes();
  const record = wakes.find((w) => w.sessionKey === sessionKey);
  if (!record) {
    return;
  }
  // Removed before the send: at most once. A lost wake costs a "keep going"; a doubled one starts
  // two turns in the same chat.
  writeLimitResumes(wakes.filter((w) => w.sessionKey !== sessionKey));
  if (await deps.promptedSince(sessionKey, record.errorAt)) {
    log.info(
      `[limit-resume] ${sessionKey}: a prompt reached the chat after the limit error; no wake`,
    );
    return;
  }
  const idempotencyKey = `limit-resume-${sessionKey}-${record.errorAt}`;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      await deps.send({ sessionKey, message: LIMIT_RESUME_MESSAGE, idempotencyKey });
      log.info(
        `[limit-resume] ${sessionKey}: woke after the reset of ${new Date(record.resetAt).toISOString()} (attempt ${attempt})`,
      );
      return;
    } catch (err) {
      log.warn(
        `[limit-resume] ${sessionKey}: wake attempt ${attempt}/${SEND_ATTEMPTS} failed: ${String(err)}`,
      );
      if (attempt < SEND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_MS));
      }
    }
  }
}

/**
 * Called when a bridge turn ends with an error. Arms one wake for the chat when the error is a
 * usage limit that names its reset; replaces the chat's pending wake if it has one. Never throws:
 * it sits on the error path of a turn.
 */
export function scheduleLimitResume(params: {
  sessionKey: string | undefined;
  raw: string;
  now?: number;
}): LimitResumeRecord | null {
  try {
    const plan = planLimitResume({
      sessionKey: params.sessionKey,
      raw: params.raw,
      now: params.now ?? Date.now(),
    });
    if (!plan) {
      return null;
    }
    const others = readLimitResumes().filter((w) => w.sessionKey !== plan.sessionKey);
    writeLimitResumes([...others, plan]);
    arm(plan.sessionKey, plan.fireAt);
    log.info(
      `[limit-resume] ${plan.sessionKey}: wake armed for ${new Date(plan.fireAt).toISOString()} (provider: ${plan.raw})`,
    );
    return plan;
  } catch (err) {
    log.warn(`[limit-resume] could not arm a wake for ${params.sessionKey}: ${String(err)}`);
    return null;
  }
}

/**
 * Re-arm every persisted wake. Called on `gateway_start`; returns how many were armed. A wake more
 * than LIMIT_RESUME_STALE_MS overdue is dropped: by then a person is back in charge of the chat.
 */
export function rearmLimitResumes(now: number = Date.now()): number {
  try {
    const wakes = readLimitResumes();
    const live = wakes.filter((w) => now - w.fireAt <= LIMIT_RESUME_STALE_MS);
    for (const dropped of wakes.filter((w) => !live.includes(w))) {
      log.warn(
        `[limit-resume] ${dropped.sessionKey}: wake for ${new Date(dropped.fireAt).toISOString()} is stale; dropped`,
      );
    }
    if (live.length !== wakes.length) {
      writeLimitResumes(live);
    }
    for (const w of live) {
      arm(w.sessionKey, Math.max(w.fireAt, now + LIMIT_RESUME_BOOT_SETTLE_MS));
    }
    if (live.length > 0) {
      log.info(`[limit-resume] re-armed ${live.length} pending wake(s) at boot`);
    }
    return live.length;
  } catch (err) {
    log.warn(`[limit-resume] re-arm at boot failed: ${String(err)}`);
    return 0;
  }
}

/** Test hook: clear the in-memory timers, as a gateway restart does. The store is left alone. */
export function __resetLimitResumeTimersForTest(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}
