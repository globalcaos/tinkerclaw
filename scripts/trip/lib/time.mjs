// FORK 2026-10-19 (the architect: phone app) — timezone helpers for the trip corner, Intl only (no deps).
// trip.json stores wall-clock times ("2025-03-14T09:30") next to an IANA zone; everything that
// compares or counts down needs the real instant, and every label needs the zone's own abbreviation.

const validCache = new Map();
/** True when Intl knows the zone ("Europe/Madrid"); false for typos such as "Europe/Valencia" or "PDT". */
export function isValidTz(tz) {
  if (typeof tz !== "string" || !tz) {
    return false;
  }
  let ok = validCache.get(tz);
  if (ok === undefined) {
    try {
      ok = Boolean(new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone);
    } catch {
      ok = false;
      // trip.json is written by hand and from emails: one bad zone must not take the page down.
      console.warn(`[trip] unknown time zone ${JSON.stringify(tz)}, using UTC for it`);
    }
    validCache.set(tz, ok);
  }
  return ok;
}

/** The zone itself when valid, else UTC. */
export function safeTz(tz) {
  return isValidTz(tz) ? tz : "UTC";
}

const dtfCache = new Map();
function partsFormatter(zone) {
  const tz = safeTz(zone);
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of instant `ms` in zone `tz`. */
export function zonedParts(ms, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday,
  };
}

function offsetMs(tz, ms) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** "2025-03-14T09:30" (wall clock in `tz`) -> epoch ms, or null when unparseable. */
export function localToUtcMs(local, tz) {
  if (typeof local !== "string") {
    return null;
  }
  const m = LOCAL_RE.exec(local.trim());
  if (!m) {
    return null;
  }
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (!tz) {
    return guess;
  }
  const off1 = offsetMs(tz, guess);
  let ms = guess - off1;
  const off2 = offsetMs(tz, ms);
  if (off2 !== off1) {
    ms = guess - off2;
  }
  return ms;
}

const pad = (n) => String(n).padStart(2, "0");

/** Instant -> {date:"YYYY-MM-DD", time:"HH:MM", weekday} in `tz`. */
export function utcToLocal(ms, tz) {
  const p = zonedParts(ms, tz);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    weekday: p.weekday,
  };
}

/** Short zone name at that instant: CEST, PDT, EDT... (falls back to GMT+N). */
export function tzAbbr(ms, zone) {
  if (!zone || !Number.isFinite(ms)) {
    return "";
  }
  const tz = safeTz(zone);
  const pick = (locale) =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date(ms))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const us = pick("en-US");
  if (!/^(GMT|UTC)/.test(us)) {
    return us;
  }
  const gb = pick("en-GB");
  return /^(GMT|UTC)[+-]/.test(gb) || !gb ? us : gb;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2025-03-14" -> "Fri 14 Mar" (calendar date, no zone involved). */
export function dayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? "");
  if (!m) {
    return date ?? "";
  }
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Whole days between two calendar dates ("YYYY-MM-DD"), b - a. */
export function daysBetween(a, b) {
  const pa = localToUtcMs(a, null);
  const pb = localToUtcMs(b, null);
  if (pa == null || pb == null) {
    return null;
  }
  return Math.round((pb - pa) / 86_400_000);
}

/** "in 3 h 05 min" style duration for a positive ms span. */
export function spanLabel(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) {
    return `${min} min`;
  }
  const h = Math.floor(min / 60);
  if (h < 48) {
    return `${h} h ${pad(min % 60)} min`;
  }
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
