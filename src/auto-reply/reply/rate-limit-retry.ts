/**
 * FORK 2026-09-03 — bounded automatic retry after a subscription rate limit.
 *
 * PURPOSE. Eleven of one week's "keep going" prods from the architect followed a
 * Claude subscription rate-limit envelope of the shape
 *   "You have hit your session limit — resets 11:20am (Europe/Madrid)"
 * (category `rate_limit`, failover surface_error reason=`rate_limit`). The
 * envelope copy promises that "automatic retry is in progress". No such retry
 * existed: two tabs sat unanswered for HOURS past their stated reset until a
 * human noticed. The comment and the code disagreed; this module makes the code
 * true rather than softening the copy.
 *
 * WHY NOT MODEL FALLBACK. `agents.defaults.model.fallbacks` is deliberately `[]`
 * and MUST stay that way — the architect does not want a silent mid-turn
 * downgrade to another model. With no fallback chain there is nothing to fail
 * over TO, so the only honest recovery is to wait out the provider's own reset
 * and re-send the same prompt into the same session.
 *
 * INVARIANTS (each exists because its unbounded version is dangerous):
 *   - AT MOST ONE armed timer per session key; a newer schedule replaces an older.
 *   - AT MOST ONE automatic retry per turn. If the retry is itself rate-limited,
 *     the envelope surfaces and nothing is re-armed (turn-suppression window).
 *   - 6 h horizon. A reset further out than that — or missing, or already more
 *     than 6 h stale — arms nothing and returns `undefined`.
 *   - 15–45 s of jitter past the stated reset, so sessions released by the same
 *     provider window do not stampede it on the same millisecond.
 *   - The dispatcher is INJECTED. This module never reaches the gateway on its
 *     own; that is what keeps it unit-testable under fake timers.
 *
 * MECHANISM: CODE, not prompt. The want is "this happens the same way every
 * turn", and a prompt-level reminder is exactly what already failed here — the
 * envelope SAID a retry was in progress and nothing fired.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import { CommandLane } from "../../process/lanes.js";

/** Timezone assumed when the provider states a clock time without naming one. */
export const RATE_LIMIT_RETRY_DEFAULT_TIMEZONE = "Europe/Madrid";
/** Never arm a timer further out than this — a longer wait is a human's call. */
export const RATE_LIMIT_RETRY_MAX_HORIZON_MS = 6 * 60 * 60 * 1000;
export const RATE_LIMIT_RETRY_JITTER_MIN_MS = 15_000;
export const RATE_LIMIT_RETRY_JITTER_MAX_MS = 45_000;
/**
 * How long after a retry FIRES a further schedule for the same session+prompt is
 * read as "the retry hit the limit again" and suppressed. This is what makes
 * "exactly one automatic retry per turn" true even across a gateway restart,
 * because the fired marker is persisted with the record.
 */
export const RATE_LIMIT_RETRY_TURN_SUPPRESSION_MS = 10 * 60 * 1000;

const STORE_VERSION = 1;

export interface RateLimitRetryRecord {
  sessionKey: string;
  runId?: string;
  prompt: string;
  /** Provider-stated reset, epoch ms (pre-jitter). */
  resetAt: number;
  /** What the timer is armed for, epoch ms (post-jitter). */
  scheduledFor: number;
  createdAt: number;
  /** Set once the retry has actually been dispatched. */
  firedAt?: number;
}

export interface RateLimitRetryDispatchInput {
  sessionKey: string;
  prompt: string;
  runId?: string;
  /** Epoch ms the retry was armed for (post-jitter). */
  scheduledFor: number;
  /** Provider-stated reset, epoch ms (pre-jitter). */
  resetAt: number;
}

export type RateLimitRetryDispatch = (input: RateLimitRetryDispatchInput) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) {
    return false;
  }
  try {
    return Boolean(Intl.DateTimeFormat("en-US", { timeZone }));
  } catch {
    return false;
  }
}

type ZoneParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zoneParts(instantMs: number, timeZone: string): ZoneParts | undefined {
  try {
    const parts = Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instantMs));
    const read = (type: string): number => {
      const value = parts.find((part) => part.type === type)?.value;
      return value === undefined ? Number.NaN : Number.parseInt(value, 10);
    };
    const year = read("year");
    const month = read("month");
    const day = read("day");
    // Some engines render midnight as "24" under hour12:false.
    const hour = read("hour") % 24;
    const minute = read("minute");
    const second = read("second");
    if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) {
      return undefined;
    }
    return { year, month, day, hour, minute, second };
  } catch {
    return undefined;
  }
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(instantMs: number, timeZone: string): number | undefined {
  // Floor to the second: formatToParts has no ms field, so comparing against an
  // unfloored instant would report an offset that is wrong by up to 999 ms.
  const reference = Math.floor(instantMs / 1000) * 1000;
  const parts = zoneParts(reference, timeZone);
  if (!parts) {
    return undefined;
  }
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - reference;
}

/**
 * Convert a WALL-CLOCK time in `timeZone` to epoch ms. Two passes: the first
 * guesses the offset from the naive-UTC instant, the second re-reads it at the
 * corrected instant so a DST boundary falling between the two does not shift the
 * answer by an hour.
 */
function zonedWallClockToEpoch(
  fields: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number | undefined {
  const asIfUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    0,
    0,
  );
  const firstOffset = zoneOffsetMs(asIfUtc, timeZone);
  if (firstOffset === undefined) {
    return undefined;
  }
  let epoch = asIfUtc - firstOffset;
  const secondOffset = zoneOffsetMs(epoch, timeZone);
  if (secondOffset !== undefined && secondOffset !== firstOffset) {
    epoch = asIfUtc - secondOffset;
  }
  return epoch;
}

function addCalendarDays(
  fields: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(fields.year, fields.month - 1, fields.day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const MONTHS_BY_PREFIX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Reject "resets 5 hours" / "resets 2h" / "resets 45 mins" — a DURATION, not a
 * clock time. Without this guard the clock branch reads "5 hours" as 05:00 and
 * arms a retry at the wrong moment while looking perfectly successful.
 */
const DURATION_UNIT_LOOKAHEAD =
  "(?!\\s*(?:h(?:ou)?rs?\\b|hrs?\\b|h\\b|min(?:ute)?s?\\b|m\\b|sec(?:ond)?s?\\b|s\\b|days?\\b|d\\b|weeks?\\b|months?\\b))";

/** "resets Sep 3, 6pm" / "resets on September 3 at 18:00 (Europe/Madrid)". */
const DATED_RESET_RE =
  /reset(?:s|ting|ted)?\b[^A-Za-z0-9]{0,4}(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(?:at\s+)?(?:(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?\s*(?:\(([^)]{1,64})\))?/i;

/** "resets 11:20am (Europe/Madrid)" / "resets at 4:30pm" / "resets 16:20". */
const CLOCK_RESET_RE = new RegExp(
  // (?!\d) after the hour is load-bearing: without it the engine answers a failed
  // duration lookahead by BACKTRACKING the hour to a shorter prefix. "resets 45 minutes
  // from now" then matched as "resets 4" -- the lookahead saw "5 minutes", which is not
  // a duration unit -- and scheduled a retry at 4 o'clock. Pinning the number to its
  // full width removes the prefix escape hatch.
  `reset(?:s|ting|ted)?\\s+(?:at\\s+)?(\\d{1,2})(?!\\d)(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)?${DURATION_UNIT_LOOKAHEAD}(?:\\s*\\(([^)]{1,64})\\))?`,
  "i",
);

function applyMeridiem(hour: number, meridiem: string | undefined): number {
  const marker = meridiem ? meridiem.toLowerCase().replace(/\./g, "") : "";
  if (marker === "pm" && hour < 12) {
    return hour + 12;
  }
  if (marker === "am" && hour === 12) {
    return 0;
  }
  return hour;
}

function resolveTimeZone(candidate: string | undefined, fallback: string): string {
  const trimmed = candidate?.trim() ?? "";
  return trimmed && isValidTimeZone(trimmed) ? trimmed : fallback;
}

/**
 * Parse the reset time a provider states in a rate-limit message into epoch ms,
 * or `undefined` when nothing parseable is there.
 *
 * Shapes handled (all observed live):
 *   "You have hit your session limit — resets 11:20am (Europe/Madrid)"
 *   "resets Sep 3, 6pm"
 *   "resets at 4:30pm"
 *   "resets 16:20"
 *
 * A bare clock time already behind us rolls to TOMORROW — that is what the
 * provider means by a rolling window — and the 6 h horizon in
 * `scheduleRateLimitRetry` is what stops a bad roll from arming a day-long wait.
 */
export function parseRateLimitReset(
  text: string | undefined,
  now: number = Date.now(),
  defaultTimeZone: string = RATE_LIMIT_RETRY_DEFAULT_TIMEZONE,
): number | undefined {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim() || !Number.isFinite(now)) {
    return undefined;
  }
  const zoneFallback = isValidTimeZone(defaultTimeZone)
    ? defaultTimeZone
    : RATE_LIMIT_RETRY_DEFAULT_TIMEZONE;

  // Explicit calendar date first: the clock branch would otherwise never see it,
  // and a month name can never be mistaken for an hour.
  const dated = raw.match(DATED_RESET_RE);
  const monthNumber = dated ? MONTHS_BY_PREFIX[dated[1].slice(0, 3).toLowerCase()] : undefined;
  if (dated && monthNumber !== undefined) {
    const day = Number.parseInt(dated[2], 10);
    const hour =
      dated[3] === undefined ? 0 : applyMeridiem(Number.parseInt(dated[3], 10), dated[5]);
    const minute = dated[4] === undefined ? 0 : Number.parseInt(dated[4], 10);
    if (day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const timeZone = resolveTimeZone(dated[6], zoneFallback);
      const today = zoneParts(now, timeZone);
      if (today) {
        let epoch = zonedWallClockToEpoch(
          { year: today.year, month: monthNumber, day, hour, minute },
          timeZone,
        );
        // A stated calendar date already behind us can only mean next year (a
        // December → January rollover). The 6 h horizon then refuses it, which is
        // the right outcome: a year out is not an automatic retry.
        if (epoch !== undefined && epoch <= now) {
          epoch = zonedWallClockToEpoch(
            { year: today.year + 1, month: monthNumber, day, hour, minute },
            timeZone,
          );
        }
        return epoch;
      }
    }
  }

  const clock = raw.match(CLOCK_RESET_RE);
  if (!clock) {
    return undefined;
  }
  const hour = applyMeridiem(Number.parseInt(clock[1], 10), clock[3]);
  const minute = clock[2] === undefined ? 0 : Number.parseInt(clock[2], 10);
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) {
    return undefined;
  }
  const timeZone = resolveTimeZone(clock[4], zoneFallback);
  const today = zoneParts(now, timeZone);
  if (!today) {
    return undefined;
  }
  const sameDay = zonedWallClockToEpoch(
    { year: today.year, month: today.month, day: today.day, hour, minute },
    timeZone,
  );
  if (sameDay === undefined) {
    return undefined;
  }
  if (sameDay > now) {
    return sameDay;
  }
  const tomorrow = addCalendarDays(today, 1);
  return zonedWallClockToEpoch({ ...tomorrow, hour, minute }, timeZone);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function resolveRateLimitRetryStorePath(override?: string): string {
  const explicit = override?.trim();
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.OPENCLAW_RATE_LIMIT_RETRY_STORE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(resolveStateDir(), "state", "rate-limit-retries.json");
}

function isRecord(value: unknown): value is RateLimitRetryRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RateLimitRetryRecord>;
  return (
    typeof candidate.sessionKey === "string" &&
    candidate.sessionKey.length > 0 &&
    typeof candidate.prompt === "string" &&
    candidate.prompt.length > 0 &&
    typeof candidate.resetAt === "number" &&
    Number.isFinite(candidate.resetAt) &&
    typeof candidate.scheduledFor === "number" &&
    Number.isFinite(candidate.scheduledFor)
  );
}

function readRecords(storePath: string): RateLimitRetryRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as { retries?: unknown };
    if (!Array.isArray(parsed?.retries)) {
      return [];
    }
    return parsed.retries.filter(isRecord);
  } catch {
    // A missing or corrupt store is not an error: the retry is best-effort and
    // must never be the reason a turn's failure path throws.
    return [];
  }
}

function pruneRecords(records: RateLimitRetryRecord[], now: number): RateLimitRetryRecord[] {
  return records.filter((record) => {
    if (typeof record.firedAt === "number") {
      // Fired records are kept only as long as they can still suppress a
      // same-turn re-schedule; that is what bounds the file's growth.
      return now - record.firedAt <= RATE_LIMIT_RETRY_TURN_SUPPRESSION_MS;
    }
    return (
      record.scheduledFor >= now - RATE_LIMIT_RETRY_MAX_HORIZON_MS &&
      record.scheduledFor <= now + RATE_LIMIT_RETRY_MAX_HORIZON_MS + RATE_LIMIT_RETRY_JITTER_MAX_MS
    );
  });
}

function writeRecords(storePath: string, records: RateLimitRetryRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tmpPath,
      `${JSON.stringify({ version: STORE_VERSION, retries: records }, null, 2)}\n`,
      "utf8",
    );
    // Atomic swap: a half-written store found after a crash would parse as "no
    // pending retries" and silently drop an armed retry.
    fs.renameSync(tmpPath, storePath);
  } catch (err) {
    logVerbose(`rate-limit retry store write failed (non-fatal): ${String(err)}`);
  }
}

function upsertRecord(storePath: string, record: RateLimitRetryRecord, now: number): void {
  const kept = pruneRecords(readRecords(storePath), now).filter(
    (existing) => existing.sessionKey !== record.sessionKey,
  );
  kept.push(record);
  writeRecords(storePath, kept);
}

function removeRecord(storePath: string, sessionKey: string, now: number): void {
  const kept = pruneRecords(readRecords(storePath), now).filter(
    (existing) => existing.sessionKey !== sessionKey,
  );
  writeRecords(storePath, kept);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

type ArmedRetry = {
  timer: ReturnType<typeof setTimeout>;
  record: RateLimitRetryRecord;
  storePath: string;
};

const armed = new Map<string, ArmedRetry>();

function pickJitterMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  const span = RATE_LIMIT_RETRY_JITTER_MAX_MS - RATE_LIMIT_RETRY_JITTER_MIN_MS;
  return RATE_LIMIT_RETRY_JITTER_MIN_MS + Math.floor(Math.random() * (span + 1));
}

/** Cancel the armed retry for a session, if any. Returns whether one was cancelled. */
export function cancelRateLimitRetry(sessionKey: string, opts?: { storePath?: string }): boolean {
  const existing = armed.get(sessionKey);
  if (!existing) {
    return false;
  }
  clearTimeout(existing.timer);
  armed.delete(sessionKey);
  removeRecord(opts?.storePath ?? existing.storePath, sessionKey, Date.now());
  return true;
}

function armTimer(params: {
  record: RateLimitRetryRecord;
  storePath: string;
  dispatch: RateLimitRetryDispatch;
}): void {
  const { record, storePath, dispatch } = params;
  // Always relative to the REAL clock, never to an injected `now`: an injected
  // `now` is a schedule-math input, not a statement about when this process is.
  const delayMs = Math.max(0, record.scheduledFor - Date.now());
  const timer = setTimeout(() => {
    armed.delete(record.sessionKey);
    const firedAt = Date.now();
    // Persist the fired marker BEFORE dispatching: if the retry itself trips the
    // rate limit, the suppression check must already see this turn as spent.
    upsertRecord(storePath, { ...record, firedAt }, firedAt);
    void (async () => {
      try {
        await dispatch({
          sessionKey: record.sessionKey,
          prompt: record.prompt,
          runId: record.runId,
          scheduledFor: record.scheduledFor,
          resetAt: record.resetAt,
        });
      } catch (err) {
        logVerbose(`rate-limit retry dispatch failed for ${record.sessionKey}: ${String(err)}`);
      }
    })();
  }, delayMs);
  // Deliberately optional: Node timers expose unref(), fake and browser timers
  // may not. Nothing depends on the call landing — it only stops a pending retry
  // from holding the process open at shutdown.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  armed.set(record.sessionKey, { timer, record, storePath });
}

/**
 * Arm ONE bounded automatic retry for `sessionKey`, returning the epoch ms it is
 * armed for, or `undefined` when nothing was armed.
 *
 * `undefined` when: there is no session key or prompt; `resetAt` is missing or
 * not finite; `resetAt` is more than 6 h out or more than 6 h stale; or an
 * automatic retry for this session+prompt already fired inside the
 * turn-suppression window (the "exactly one retry per turn" rule).
 */
export function scheduleRateLimitRetry(params: {
  sessionKey?: string;
  runId?: string;
  prompt: string;
  resetAt?: number;
  dispatch: RateLimitRetryDispatch;
  now?: number;
  /** Test hook: fixed jitter instead of the 15–45 s random window. */
  jitterMs?: number;
  storePath?: string;
}): number | undefined {
  const sessionKey = params.sessionKey?.trim() ?? "";
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  if (!sessionKey || !prompt.trim()) {
    return undefined;
  }
  const resetAt = params.resetAt;
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const now =
    typeof params.now === "number" && Number.isFinite(params.now) ? params.now : Date.now();
  if (resetAt - now > RATE_LIMIT_RETRY_MAX_HORIZON_MS) {
    logVerbose(
      `rate-limit retry skipped for ${sessionKey}: reset is ${Math.round((resetAt - now) / 60_000)}m out (> 6h horizon)`,
    );
    return undefined;
  }
  if (now - resetAt > RATE_LIMIT_RETRY_MAX_HORIZON_MS) {
    // A reset that stale did not come from this turn; retrying on it would
    // replay an old prompt into a live session.
    return undefined;
  }
  const storePath = resolveRateLimitRetryStorePath(params.storePath);
  const persisted = readRecords(storePath).find((record) => record.sessionKey === sessionKey);
  if (
    persisted &&
    typeof persisted.firedAt === "number" &&
    persisted.prompt === prompt &&
    now - persisted.firedAt <= RATE_LIMIT_RETRY_TURN_SUPPRESSION_MS
  ) {
    logVerbose(
      `rate-limit retry suppressed for ${sessionKey}: the one automatic retry for this turn already fired`,
    );
    return undefined;
  }

  // Per-session dedupe: a newer schedule replaces an older one.
  const existing = armed.get(sessionKey);
  if (existing) {
    clearTimeout(existing.timer);
    armed.delete(sessionKey);
  }

  const scheduledFor = Math.max(now, resetAt) + pickJitterMs(params.jitterMs);
  const record: RateLimitRetryRecord = {
    sessionKey,
    runId: params.runId,
    prompt,
    resetAt,
    scheduledFor,
    createdAt: now,
  };
  upsertRecord(storePath, record, now);
  armTimer({ record, storePath, dispatch: params.dispatch });
  logVerbose(
    `rate-limit retry armed for ${sessionKey} at ${new Date(scheduledFor).toISOString()} (reset ${new Date(resetAt).toISOString()})`,
  );
  return scheduledFor;
}

/**
 * Re-arm every pending retry the store still holds. Call once at gateway
 * startup: without it, a restart between the failure and the reset silently
 * drops the retry — the exact failure this module exists to close. Returns how
 * many were re-armed.
 */
export function rearmPersistedRateLimitRetries(
  dispatch: RateLimitRetryDispatch,
  opts?: { now?: number; storePath?: string; jitterMs?: number },
): number {
  const storePath = resolveRateLimitRetryStorePath(opts?.storePath);
  const now = typeof opts?.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const surviving = pruneRecords(readRecords(storePath), now);
  writeRecords(storePath, surviving);
  let rearmed = 0;
  for (const record of surviving) {
    if (typeof record.firedAt === "number" || armed.has(record.sessionKey)) {
      continue;
    }
    // A retry whose moment passed while the gateway was down still fires, but one
    // jitter window AFTER boot rather than instantly — a boot restoring several
    // of these must not send them all in the same millisecond.
    const settleAt = Math.max(record.scheduledFor, now + pickJitterMs(opts?.jitterMs));
    armTimer({
      record: record.scheduledFor >= now ? record : { ...record, scheduledFor: settleAt },
      storePath,
      dispatch,
    });
    rearmed += 1;
  }
  if (rearmed > 0) {
    logVerbose(`re-armed ${rearmed} persisted rate-limit retr${rearmed === 1 ? "y" : "ies"}`);
  }
  return rearmed;
}

/**
 * Production dispatcher: re-send the SAME user prompt into the SAME session.
 *
 * Mirrors `resumeMainSession` (src/agents/main-session-restart-recovery.ts) —
 * same `agent` method, same `deliver:false`, same Main lane — because that is the
 * one dispatch path already proven to resume a main-tab turn from outside a
 * request. `deliver:false` is also why callers must only schedule for sessions
 * the control UI is watching: a channel-originated session would need a delivery
 * context this module does not have, and the retry would land invisibly.
 *
 * `callGateway` is imported lazily so this module stays cheap to load — and
 * trivially mockable — in unit tests.
 */
export const dispatchRateLimitRetryThroughGateway: RateLimitRetryDispatch = async (input) => {
  const { callGateway } = await import("../../gateway/call.js");
  await callGateway<{ runId: string }>({
    method: "agent",
    params: {
      message: input.prompt,
      sessionKey: input.sessionKey,
      idempotencyKey: crypto.randomUUID(),
      deliver: false,
      lane: CommandLane.Main,
    },
    timeoutMs: 10_000,
  });
};

/** Test hook: drop every armed timer without touching the persisted store. */
export function __resetRateLimitRetryStateForTest(): void {
  for (const entry of armed.values()) {
    clearTimeout(entry.timer);
  }
  armed.clear();
}
