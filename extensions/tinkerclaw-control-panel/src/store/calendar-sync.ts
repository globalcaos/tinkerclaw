/**
 * FORK 2026-05-14 — On-demand Google Calendar sync, used by the reschedule
 * picker so it shows fresh events on every open (not just whatever the cron
 * happened to write 0–30 min ago).
 *
 * Mirrors scripts/sync-calendar.mjs but in-process: spawns `gog calendar
 * events primary --json` for the given range, upserts into the
 * calendar_event_cache. Best-effort: a sync failure (no gog on PATH, no
 * auth, network error) is logged and swallowed so the caller can still
 * serve the cached rows.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ControlPanelResolvedConfig } from "../paths.js";
import { upsertCalendarEvent } from "./calendar.js";

const execAsync = promisify(exec);

const GOG_TIMEOUT_MS = 15_000;
const GOG_MAX_BUFFER = 8 * 1024 * 1024;

type GogEvent = {
  id?: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string | null;
  status?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: unknown;
  creator?: { email?: string };
  organizer?: { email?: string };
};

export type SyncResult = {
  ok: boolean;
  synced: number;
  skipped: number;
  error?: string;
};

export async function syncGoogleCalendarRange(
  cfg: ControlPanelResolvedConfig,
  params: { from: string; to: string },
): Promise<SyncResult> {
  const { from, to } = params;
  let stdout: string;
  try {
    const r = await execAsync(`gog calendar events primary --from ${from} --to ${to} --json`, {
      encoding: "utf8",
      timeout: GOG_TIMEOUT_MS,
      maxBuffer: GOG_MAX_BUFFER,
      // Inherit the user's PATH so `gog` (typically ~/.local/bin/gog) resolves.
      env: process.env,
    });
    stdout = r.stdout;
  } catch (err) {
    return {
      ok: false,
      synced: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let events: GogEvent[] = [];
  try {
    const parsed = JSON.parse(stdout);
    events = parsed.events ?? parsed.items ?? (Array.isArray(parsed) ? parsed : []);
  } catch (err) {
    return {
      ok: false,
      synced: 0,
      skipped: 0,
      error: `parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let synced = 0;
  let skipped = 0;
  for (const ev of events) {
    const allDay = !!(ev.start?.date && !ev.start?.dateTime);
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
    const eventId = ev.id ?? ev.iCalUID;
    if (!eventId) {
      skipped++;
      continue;
    }
    upsertCalendarEvent(cfg, {
      source: "google.primary",
      event_id: eventId,
      date: dateIso,
      start_ts,
      end_ts,
      all_day: allDay,
      title: ev.summary ?? "(untitled)",
      attendees: ev.attendees,
      location: ev.location ?? null,
      metadata: {
        html_link: ev.htmlLink ?? null,
        status: ev.status ?? null,
        description: ev.description ?? null,
        creator_email: ev.creator?.email ?? null,
        organizer_email: ev.organizer?.email ?? null,
      },
    });
    synced++;
  }

  return { ok: true, synced, skipped };
}
