/**
 * FORK 2026-09-07 — recover the provider's OWN reset time from a rate-limit error.
 *
 * The client retry ladder (tinker-ui/src/retry-policy.ts) is 3s/10s/30s/2m/7m/15m and already
 * honours a provider wait: `nextRetryDelayMs` does `Math.max(step, retryAfterSec * 1000)`. It has
 * simply never been handed one — both gateway emitters omit `retryAfter` deliberately, on the
 * reasoning that "the frontend backoff ladder owns the timing".
 *
 * That reasoning holds for a 30-second 429 and breaks completely for a subscription window.
 * Measured 2026-09-07 15:00: three tabs hit `You have hit your ChatGPT usage limit (plus plan).
 * Try again in ~262 min.` The blind ladder spent all six attempts inside 25 minutes, every one
 * against the same wall, and gave up FOUR HOURS before the window reopened. The answer was in the
 * error string the whole time. Same for Claude: `resets 3:10pm (Europe/Madrid)`.
 *
 * Pure and side-effect free so the parsing is unit-testable; `nowMs` is injected rather than read
 * from the clock.
 */

/** Refuse to park a turn for longer than this. A wait beyond it is far more likely a mis-parse
 *  than a real window, and an agent asleep for half a day is indistinguishable from a hang. */
export const MAX_RETRY_AFTER_SECONDS = 12 * 60 * 60;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
};

/** "Try again in ~262 min", "retry after 45s", "in 2 hours". The leading verb is required: a bare
 *  number elsewhere in the text (an HTTP status, a model name) must never read as a wait. */
const DURATION_RE =
  /(?:try again in|retry after|retry in|again in|wait|available in|resets? in)\s*[~≈]?\s*(\d+(?:\.\d+)?)\s*(seconds|second|secs|sec|minutes|minute|mins|min|hours|hour|hrs|hr|s|m|h)\b/i;

/** An absolute instant: "resets 2026-09-07T12:57:53.032291+00:00". */
const ISO_RE = /(\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

/** A wall clock with an IANA zone: "resets 3:10pm (Europe/Madrid)". */
const WALL_CLOCK_RE =
  /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:\(([A-Za-z]+\/[A-Za-z_+-]+)\))?/i;

function clampSeconds(seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const rounded = Math.round(seconds);
  return rounded > MAX_RETRY_AFTER_SECONDS ? undefined : rounded;
}

/**
 * The wall-clock offset of `timeZone` at `atMs`, in minutes east of UTC. Derived by formatting the
 * instant in that zone and reading the parts back, which is the only way to get a zone offset
 * without a tz database of our own.
 */
function zoneOffsetMinutes(timeZone: string, atMs: number): number | undefined {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(atMs))) {
      if (part.type !== "literal") {
        parts[part.type] = part.value;
      }
    }
    const asUTC = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      // Intl renders midnight as "24" in some locales/zones.
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    if (!Number.isFinite(asUTC)) {
      return undefined;
    }
    return Math.round((asUTC - Math.floor(atMs / 1000) * 1000) / 60000);
  } catch {
    return undefined;
  }
}

function wallClockResetSeconds(text: string, nowMs: number): number | undefined {
  const m = WALL_CLOCK_RE.exec(text);
  if (!m) {
    return undefined;
  }
  const rawHour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase().replace(/\./g, "");
  const timeZone = m[4];
  if (!Number.isFinite(rawHour) || rawHour > 23 || minute > 59) {
    return undefined;
  }
  let hour = rawHour;
  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  // Without a zone we cannot place the clock face on the timeline at all. Guessing the host's
  // zone would silently produce a wrong wait, which is worse than declining.
  if (!timeZone) {
    return undefined;
  }
  const offsetMin = zoneOffsetMinutes(timeZone, nowMs);
  if (offsetMin === undefined) {
    return undefined;
  }

  // Local wall-clock time in the target zone, expressed as ms since epoch of the same instant.
  const localNow = nowMs + offsetMin * 60000;
  const d = new Date(localNow);
  const targetLocal = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    hour,
    minute,
    0,
  );
  let deltaMs = targetLocal - localNow;
  if (deltaMs <= 0) {
    // The clock face has already passed today — the provider means tomorrow.
    deltaMs += 24 * 60 * 60 * 1000;
  }
  return clampSeconds(deltaMs / 1000);
}

/**
 * Seconds to wait before retrying, derived from a provider's rate-limit text.
 * Returns undefined when the text carries no usable timing, when the moment has already passed,
 * or when the implied wait is longer than MAX_RETRY_AFTER_SECONDS.
 */
export function resolveRetryAfterSeconds(
  text: string | undefined | null,
  nowMs: number,
): number | undefined {
  if (!text) {
    return undefined;
  }

  // A relative duration is the provider speaking most directly; prefer it.
  const dur = DURATION_RE.exec(text);
  if (dur) {
    const value = Number(dur[1]);
    const unit = UNIT_SECONDS[dur[2].toLowerCase()];
    if (Number.isFinite(value) && unit) {
      return clampSeconds(value * unit);
    }
  }

  const iso = ISO_RE.exec(text);
  if (iso) {
    const at = Date.parse(iso[1].replace(" ", "T"));
    if (Number.isFinite(at)) {
      return clampSeconds((at - nowMs) / 1000);
    }
  }

  return wallClockResetSeconds(text, nowMs);
}
