// FORK 2026-08-19 (the architect: expanded cron cards should set timing, periodicity,
// and enable/disable). The gateway already owns writes via `cron.update`.
// This module is the VIEW of a schedule — parse the stored shape into fields
// a 360px card can edit, and build a patch the existing RPC will accept.
// Never write jobs.json from the UI.

export type CronRepeat = "daily" | "weekly" | "interval" | "cron";

export type CronScheduleInput = {
  kind?: string;
  expr?: string;
  tz?: string;
  everyMs?: number;
};

export type CronScheduleView = {
  repeat: CronRepeat;
  /** HH:MM, 24h. Meaningful for daily/weekly. */
  time: string;
  /** 0=Sun … 6=Sat. Meaningful for weekly. */
  weekday: number;
  /** Minutes. Meaningful for interval. */
  intervalMin: number;
  /** Raw five-field expr. Meaningful for cron. */
  expr: string;
  tz: string;
};

export const DEFAULT_TZ = "Europe/Madrid";
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function parseTimeParts(expr: string | undefined): { min: number; hour: number } | null {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const min = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(min) || !Number.isInteger(hour)) return null;
  if (min < 0 || min > 59 || hour < 0 || hour > 23) return null;
  return { min, hour };
}

export function formatTime(hour: number, min: number): string {
  return `${pad(hour)}:${pad(min)}`;
}

export function parseSchedule(schedule: CronScheduleInput | undefined): CronScheduleView {
  const tz = (schedule?.tz && schedule.tz.trim()) || DEFAULT_TZ;
  if (schedule?.kind === "every" && typeof schedule.everyMs === "number" && schedule.everyMs > 0) {
    const intervalMin = Math.max(1, Math.round(schedule.everyMs / 60_000));
    return { repeat: "interval", time: "00:00", weekday: 0, intervalMin, expr: "", tz };
  }
  const expr = schedule?.expr?.trim() ?? "";
  const parts = expr.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    const timeParts = parseTimeParts(expr);
    if (timeParts && dom === "*" && mon === "*") {
      if (dow === "*") {
        return {
          repeat: "daily",
          time: formatTime(timeParts.hour, timeParts.min),
          weekday: 0,
          intervalMin: 15,
          expr,
          tz,
        };
      }
      if (/^\d+$/.test(dow)) {
        return {
          repeat: "weekly",
          time: formatTime(timeParts.hour, timeParts.min),
          weekday: Number(dow) % 7,
          intervalMin: 15,
          expr,
          tz,
        };
      }
    }
    const step = /^\*\/(\d+)$/.exec(min);
    if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
      return {
        repeat: "interval",
        time: "00:00",
        weekday: 0,
        intervalMin: Math.max(1, Number(step[1])),
        expr,
        tz,
      };
    }
  }
  return { repeat: "cron", time: "06:00", weekday: 0, intervalMin: 15, expr, tz };
}

export type CronSchedulePatch =
  | { kind: "cron"; expr: string; tz: string }
  | { kind: "every"; everyMs: number };

export function buildSchedule(view: CronScheduleView): CronSchedulePatch | { error: string } {
  const tz = view.tz.trim() || DEFAULT_TZ;
  if (view.repeat === "interval") {
    const n = Math.round(view.intervalMin);
    if (!Number.isFinite(n) || n < 1) return { error: "interval must be at least 1 minute" };
    return { kind: "every", everyMs: n * 60_000 };
  }
  if (view.repeat === "cron") {
    const expr = view.expr.trim();
    if (expr.split(/\s+/).length !== 5) return { error: "cron expression needs 5 fields" };
    return { kind: "cron", expr, tz };
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(view.time.trim());
  if (!m) return { error: "time must be HH:MM" };
  const hour = Number(m[1]);
  const min = Number(m[2]);
  if (hour > 23 || min > 59) return { error: "time must be HH:MM" };
  if (view.repeat === "weekly") {
    const dow = Number.isInteger(view.weekday) ? view.weekday % 7 : 0;
    return { kind: "cron", expr: `${min} ${hour} * * ${dow}`, tz };
  }
  return { kind: "cron", expr: `${min} ${hour} * * *`, tz };
}

export function humanizeSchedule(schedule: CronScheduleInput | undefined): string {
  if (schedule?.kind === "every" && typeof schedule.everyMs === "number") {
    const min = Math.max(1, Math.round(schedule.everyMs / 60_000));
    return `every ${min} min`;
  }
  const expr = schedule?.expr;
  if (!expr) return "—";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const tz = schedule?.tz;
  const tzSuffix = tz && tz !== DEFAULT_TZ ? ` (${tz})` : "";
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
    const time = formatTime(Number(hour), Number(min));
    if (dow === "*") return `${time} daily${tzSuffix}`;
    if (/^\d+$/.test(dow)) return `${time} ${WEEKDAYS[Number(dow) % 7]}${tzSuffix}`;
    return `${time} on ${dow}${tzSuffix}`;
  }
  const step = /^\*\/(\d+)$/.exec(min);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `every ${step[1]} min`;
  }
  return expr;
}
