// FORK 2026-10-19 (the architect: phone app) — trip.json / trip-state.json paths, atomic writes, and the
// instants each segment stands for. Shared by trip-render.mjs and flight-watch.mjs so both agree on
// what "next", "departs" and "lands" mean.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localToUtcMs } from "./time.mjs";

export function tripDir(env = process.env) {
  return env.TRIP_DIR || path.join(os.homedir(), ".openclaw", "data", "trip");
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return fallback;
    }
    throw new Error(`${file}: ${err.message}`, { cause: err });
  }
}

/** Write via a temp file in the same directory + rename, so a reader never sees half a file. */
export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, obj) {
  writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}

export function loadTrip(dir) {
  return readJson(path.join(dir, "trip.json"), null);
}

export function loadState(dir) {
  const s = readJson(path.join(dir, "trip-state.json"), {}) ?? {};
  return { segments: {}, notified: {}, ...s };
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : null);
const objList = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const place = (v) => (isObj(v) ? { ...v, local: str(v.local), tz: str(v.tz) } : null);

function segmentView(s) {
  return {
    ...s,
    id: s.id == null ? null : String(s.id),
    depLocal: str(s.depLocal),
    arrLocal: str(s.arrLocal),
    checkIn: str(s.checkIn),
    checkOut: str(s.checkOut),
    date: str(s.date),
    tz: str(s.tz),
    from: isObj(s.from) ? { ...s.from, tz: str(s.from.tz) } : null,
    to: isObj(s.to) ? { ...s.to, tz: str(s.to.tz) } : null,
    pickup: place(s.pickup),
    dropoff: place(s.dropoff),
  };
}

function checklistView(c) {
  return { ...c, due: str(c.due) };
}

/**
 * A copy of trip.json that the renderer and the watcher can read without guarding every field:
 * non-object segments and list items are dropped, time fields that are not strings become null.
 * Read-only: flight-watch writes alerts into the raw file, so a hand-made odd value is never lost.
 */
export function tripView(raw) {
  const trip = isObj(raw) ? raw : {};
  return {
    ...trip,
    title: trip.title == null ? null : String(trip.title),
    homeTz: str(trip.homeTz),
    segments: objList(trip.segments).map(segmentView),
    travellers: objList(trip.travellers),
    checklist: objList(trip.checklist).map(checklistView),
    contacts: objList(trip.contacts),
    alerts: objList(trip.alerts),
    openQuestions: Array.isArray(trip.openQuestions)
      ? trip.openQuestions.filter((q) => typeof q === "string" && q)
      : [],
  };
}

/** Last flight arrival zone at or before `ms`, so a car pickup or an activity gets a sensible zone. */
function zoneAt(trip, ms) {
  let tz = trip.homeTz || "UTC";
  const flights = (trip.segments ?? [])
    .filter((s) => s.type === "flight" && s.to?.tz)
    .map((s) => ({ s, dep: localToUtcMs(s.depLocal, s.from?.tz) }))
    .filter((x) => x.dep != null)
    .toSorted((a, b) => a.dep - b.dep);
  for (const { s, dep } of flights) {
    if (dep <= ms) {
      tz = s.to.tz;
    }
  }
  return tz;
}

/** Zone a non-flight segment lives in. */
export function segmentTz(trip, seg) {
  if (seg.tz) {
    return seg.tz;
  }
  const local =
    seg.type === "car" ? seg.pickup?.local : seg.type === "stay" ? seg.checkIn : seg.date;
  const guess = localToUtcMs(local, "UTC");
  return guess == null ? trip.homeTz || "UTC" : zoneAt(trip, guess);
}

/**
 * Scheduled instants of a segment: start (what the countdown aims at), end (after which it is no
 * longer "next up"). Flights use live estimates from trip-state when present.
 */
export function segmentTimes(trip, seg, live) {
  if (seg.type === "flight") {
    const schedDep = localToUtcMs(seg.depLocal, seg.from?.tz);
    const schedArr = localToUtcMs(seg.arrLocal, seg.to?.tz);
    const iso = (v) => (v ? Date.parse(v) : Number.NaN);
    const dep = [live?.actDep, live?.estDep].map(iso).find(Number.isFinite) ?? schedDep;
    const arr = [live?.actArr, live?.estArr].map(iso).find(Number.isFinite) ?? schedArr;
    return { start: dep, end: arr ?? (dep == null ? null : dep + 3_600_000), schedDep, schedArr };
  }
  const tz = segmentTz(trip, seg);
  if (seg.type === "stay") {
    const start = localToUtcMs(`${seg.checkIn}T15:00`, tz);
    return { start, end: start == null ? null : start + 9 * 3_600_000 };
  }
  if (seg.type === "car") {
    const start = localToUtcMs(seg.pickup?.local, tz);
    return { start, end: start == null ? null : start + 3_600_000 };
  }
  const start = localToUtcMs(seg.date, tz);
  return { start, end: start == null ? null : start + 86_400_000 };
}

/** Delay in whole minutes of the departure (actual or estimated vs scheduled), or 0. */
export function depDelayMin(seg, live) {
  if (!live) {
    return 0;
  }
  const sched = live.schedDep
    ? Date.parse(live.schedDep)
    : localToUtcMs(seg.depLocal, seg.from?.tz);
  const now = [live.actDep, live.estDep]
    .map((v) => (v ? Date.parse(v) : Number.NaN))
    .find(Number.isFinite);
  if (!Number.isFinite(sched) || !Number.isFinite(now)) {
    return 0;
  }
  return Math.round((now - sched) / 60_000);
}
