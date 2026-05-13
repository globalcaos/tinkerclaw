/**
 * FORK: tinkerclaw-control-panel — calendar event cache CRUD.
 *
 * The calendar sync poller (src/calendar/sync.ts, future) writes to this
 * table; the Exec calendar strip and the reschedule picker read from it.
 */
import type { ControlPanelResolvedConfig } from "../paths.js";
import { getDb } from "./db.js";

export type CalendarSource = "google.primary" | "outlook.serra" | "manual";

export type CalendarEventRow = {
  source: CalendarSource;
  event_id: string;
  date: string;
  start_ts: number;
  end_ts: number | null;
  all_day: number;
  title: string;
  attendees_json: string | null;
  location: string | null;
  metadata_json: string | null;
  synced_at: number;
};

export function upsertCalendarEvent(
  cfg: ControlPanelResolvedConfig,
  ev: {
    source: CalendarSource;
    event_id: string;
    date: string;
    start_ts: number;
    end_ts?: number | null;
    all_day?: boolean;
    title: string;
    attendees?: unknown;
    location?: string | null;
    metadata?: unknown;
  },
): void {
  const db = getDb(cfg);
  db.prepare(
    `INSERT INTO calendar_event_cache (source, event_id, date, start_ts, end_ts, all_day, title, attendees_json, location, metadata_json, synced_at)
     VALUES (@source, @event_id, @date, @start_ts, @end_ts, @all_day, @title, @attendees_json, @location, @metadata_json, @synced_at)
     ON CONFLICT (source, event_id) DO UPDATE SET
       date = excluded.date,
       start_ts = excluded.start_ts,
       end_ts = excluded.end_ts,
       all_day = excluded.all_day,
       title = excluded.title,
       attendees_json = excluded.attendees_json,
       location = excluded.location,
       metadata_json = excluded.metadata_json,
       synced_at = excluded.synced_at`,
  ).run({
    source: ev.source,
    event_id: ev.event_id,
    date: ev.date,
    start_ts: ev.start_ts,
    end_ts: ev.end_ts ?? null,
    all_day: ev.all_day ? 1 : 0,
    title: ev.title,
    attendees_json: ev.attendees === undefined ? null : JSON.stringify(ev.attendees),
    location: ev.location ?? null,
    metadata_json: ev.metadata === undefined ? null : JSON.stringify(ev.metadata),
    synced_at: Date.now(),
  });
}

export function listCalendarEvents(
  cfg: ControlPanelResolvedConfig,
  params: { from: string; to: string; source?: CalendarSource },
): CalendarEventRow[] {
  const db = getDb(cfg);
  const where: string[] = [`date >= @from AND date <= @to`];
  const qp: Record<string, unknown> = { from: params.from, to: params.to };
  if (params.source) {
    where.push(`source = @source`);
    qp.source = params.source;
  }
  return db
    .prepare(
      `SELECT * FROM calendar_event_cache WHERE ${where.join(" AND ")} ORDER BY start_ts ASC`,
    )
    .all(qp) as CalendarEventRow[];
}

export type CalendarDensityRow = { date: string; count: number; total_minutes: number };

export function getCalendarDensity(
  cfg: ControlPanelResolvedConfig,
  params: { from: string; to: string; source?: CalendarSource },
): CalendarDensityRow[] {
  const db = getDb(cfg);
  const where: string[] = [`date >= @from AND date <= @to`];
  const qp: Record<string, unknown> = { from: params.from, to: params.to };
  if (params.source) {
    where.push(`source = @source`);
    qp.source = params.source;
  }
  return db
    .prepare(
      `SELECT
         date,
         COUNT(*) AS count,
         CAST(SUM(COALESCE(end_ts, start_ts + 1800000) - start_ts) / 60000 AS INTEGER) AS total_minutes
       FROM calendar_event_cache
       WHERE ${where.join(" AND ")}
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(qp) as CalendarDensityRow[];
}
