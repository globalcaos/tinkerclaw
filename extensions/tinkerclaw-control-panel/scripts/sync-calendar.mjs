#!/usr/bin/env node
/**
 * FORK: tinkerclaw-control-panel — one-shot Google Calendar sync.
 *
 * Reads events from `gog calendar events primary` for a date range and
 * upserts them into the calendar_event_cache table. Idempotent: re-running
 * just refreshes the cache. Intended to be called by:
 *   1. a manual run (now) to bootstrap the picker's heat bars,
 *   2. a 30-min cron entry (Phase E proper).
 *
 * Usage:
 *   node scripts/sync-calendar.mjs               # default: today → +14d
 *   node scripts/sync-calendar.mjs 2026-05-11 2026-05-25
 */
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const DB = path.join(os.homedir(), ".openclaw/data/control-panel/store.db");

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isoDaysAhead(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const FROM = process.argv[2] || isoToday();
const TO = process.argv[3] || isoDaysAhead(14);

console.log(`▶ syncing google.primary calendar ${FROM} → ${TO}`);

let events = [];
try {
  const out = execSync(`gog calendar events primary --from ${FROM} --to ${TO} --json`, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  events = parsed.events ?? parsed.items ?? (Array.isArray(parsed) ? parsed : []);
} catch (err) {
  console.error("Failed to fetch from gog:", err.message);
  process.exit(2);
}

console.log(`  fetched ${events.length} events`);

const db = new Database(DB);
const now = Date.now();

const upsert = db.prepare(`
  INSERT INTO calendar_event_cache (
    source, event_id, date, start_ts, end_ts, all_day, title,
    attendees_json, location, metadata_json, synced_at
  ) VALUES (
    'google.primary', @event_id, @date, @start_ts, @end_ts, @all_day, @title,
    @attendees_json, @location, @metadata_json, @synced_at
  )
  ON CONFLICT(source, event_id) DO UPDATE SET
    date = excluded.date,
    start_ts = excluded.start_ts,
    end_ts = excluded.end_ts,
    all_day = excluded.all_day,
    title = excluded.title,
    attendees_json = excluded.attendees_json,
    location = excluded.location,
    metadata_json = excluded.metadata_json,
    synced_at = excluded.synced_at
`);

let synced = 0;
let skipped = 0;
const counts = { all_day: 0, timed: 0 };

const upsertAll = db.transaction((rows) => {
  for (const ev of rows) {
    const allDay = !!(ev.start?.date && !ev.start?.dateTime);
    if (allDay) counts.all_day++;
    else counts.timed++;

    const startStr = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : null);
    const endStr = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00` : null);
    if (!startStr) {
      skipped++;
      continue;
    }
    const start_ts = new Date(startStr).getTime();
    const end_ts = endStr ? new Date(endStr).getTime() : null;
    if (!Number.isFinite(start_ts)) {
      skipped++;
      continue;
    }

    const startDate = new Date(start_ts);
    const dateIso = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;

    upsert.run({
      event_id: ev.id ?? ev.iCalUID,
      date: dateIso,
      start_ts,
      end_ts,
      all_day: allDay ? 1 : 0,
      title: ev.summary ?? "(untitled)",
      attendees_json: ev.attendees ? JSON.stringify(ev.attendees) : null,
      location: ev.location ?? null,
      metadata_json: JSON.stringify({
        html_link: ev.htmlLink ?? null,
        status: ev.status ?? null,
        description: ev.description ?? null,
        creator_email: ev.creator?.email ?? null,
        organizer_email: ev.organizer?.email ?? null,
      }),
      synced_at: now,
    });
    synced++;
  }
});

upsertAll(events);

console.log(
  `  upserted ${synced} events (${counts.timed} timed, ${counts.all_day} all-day), skipped ${skipped}`,
);

// Summary by date
console.log("");
console.log("▶ events per day (synced range):");
const summary = db
  .prepare(
    `SELECT date, COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN end_ts IS NOT NULL AND all_day=0 THEN (end_ts - start_ts)/60000 ELSE 0 END), 0) AS minutes
     FROM calendar_event_cache
     WHERE source='google.primary' AND date >= ? AND date <= ?
     GROUP BY date ORDER BY date`,
  )
  .all(FROM, TO);
for (const r of summary) {
  console.log(`  ${r.date}  ${r.n.toString().padStart(2)} evts  ${Math.round(r.minutes)}min`);
}
