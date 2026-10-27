#!/usr/bin/env node
/**
 * Flight watch — live status for the trip's flights, alerts on what matters, a ping on the phone.
 *
 * WHAT IT IS FOR: a traveller should not have to keep checking an airline app. Every
 * 10 minutes (systemd user timer) this looks at flights leaving within 36 h, in the air, or landed
 * under 2 h ago; on a meaningful change it appends an alert to trip.json, updates trip-state.json,
 * re-renders trip.html and notifies the phone. It also sends time-based reminders: check-in open
 * (T-24 h) and leave for the airport (T-3 h international, T-2 h domestic).
 * HOW IT WAS DERIVED: "meaningful" = what changes what you do at the airport: delay moved by 15 min or
 * more (against the last delay we told you about, so slow creep still triggers), cancellation,
 * diversion, gate/terminal assigned or changed, departed, landed, baggage belt. Each notification has a
 * key in trip-state `notified`, so a re-run never repeats it; a failed delivery waits in `pending` and
 * is retried for 6 h. Gate, terminal, belt and delay keys carry a per-field counter, so a change back
 * to a value announced earlier (gate B12 -> B14 -> B12) is news again. Terminal and gate names are
 * compared normalised ("Terminal 1" = "T1" = "1", "INTL" = "I"), so two providers spelling the same
 * place differently stay quiet while a real change is announced whichever provider saw it. Providers: providers/index.mjs (keyless public pages, verified 2026-10-19).
 * WHAT WOULD CHANGE IT: a paid status API with push (then the timer goes), or the airline's own app
 * notifications proving enough.
 *
 * Run: node flight-watch.mjs [--once] [--dry-run] [--now <ISO>]
 * Env: TRIP_DIR (default ~/.openclaw/data/trip), TRIP_NOTIFY_NODE (node id/name; default = first
 *      connected android node), TRIP_WHATSAPP_TARGET (fallback, E.164; unset = no fallback),
 *      OPENCLAW_BIN (default "openclaw"), AERODATABOX_KEY (optional third provider).
 */
// FORK 2026-10-19 (the architect: phone app) — trip corner flight watcher.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dayLabel, localToUtcMs, spanLabel, tzAbbr, utcToLocal } from "./lib/time.mjs";
import {
  depDelayMin,
  loadState,
  loadTrip,
  segmentTimes,
  tripDir,
  tripView,
  writeJsonAtomic,
} from "./lib/trip-io.mjs";
import { cachePath, fetchFlightStatus } from "./providers/index.mjs";
import { renderToDir } from "./trip-render.mjs";

const H = 3_600_000;
export const WATCH_AHEAD_MS = 36 * H;
export const WATCH_AFTER_LANDING_MS = 2 * H;
export const DELAY_STEP_MIN = 15;
export const PENDING_TTL_MS = 6 * H;
export const MAX_ALERTS = 100;
const INTERVAL_MS = 10 * 60_000;

const US_ZONES = new Set([
  "America/New_York",
  "America/Detroit",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Boise",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Nome",
  "America/Yakutat",
  "America/Metlakatla",
  "America/Adak",
  "America/Menominee",
  "America/Puerto_Rico",
  "Pacific/Honolulu",
]);
const US_ZONE_PREFIXES = ["America/Indiana/", "America/Kentucky/", "America/North_Dakota/"];
const isUsZone = (tz) => US_ZONES.has(tz) || US_ZONE_PREFIXES.some((p) => tz.startsWith(p));
const ES_ZONES = new Set(["Europe/Madrid", "Atlantic/Canary", "Africa/Ceuta"]);

/** Same country by zone (the schema has no country). A segment may override with `international`. */
export function isDomestic(seg) {
  if (typeof seg.international === "boolean") {
    return !seg.international;
  }
  const a = seg.from?.tz;
  const b = seg.to?.tz;
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return (isUsZone(a) && isUsZone(b)) || (ES_ZONES.has(a) && ES_ZONES.has(b));
}

const fno = (seg) => [seg.carrier, seg.number].filter(Boolean).join(" ") || seg.airline || "Flight";
const at = (ms, tz) => (Number.isFinite(ms) ? `${utcToLocal(ms, tz).time} ${tzAbbr(ms, tz)}` : "?");
const isoMs = (v) => (v ? Date.parse(v) : Number.NaN);

/** Flights worth a live lookup right now. */
export function watchedFlights(trip, state, now, log = () => {}) {
  return (trip.segments ?? []).filter((seg) => {
    if (seg?.type !== "flight" || !seg.carrier || !seg.number) {
      return false;
    }
    try {
      const live = state.segments?.[seg.id];
      const t = segmentTimes(trip, seg, live);
      const dep = Number.isFinite(t.start) ? t.start : t.schedDep;
      if (!Number.isFinite(dep)) {
        return false;
      }
      if (dep >= now) {
        return dep - now <= WATCH_AHEAD_MS;
      }
      const arr = Number.isFinite(t.end) ? t.end : dep + 12 * H;
      return now - arr < WATCH_AFTER_LANDING_MS;
    } catch (err) {
      log(`segment ${seg.id ?? "?"} skipped: ${err.message}`);
      return false;
    }
  });
}

const FIELDS = ["depTerminal", "depGate", "arrTerminal", "arrGate", "baggage"];

/** Comparable form of a terminal/gate/belt name: "Terminal 1" = "T1" = "1", "INTL" = "I", "Gate B 12" = "B12". */
export function normPlace(field, v) {
  if (v == null) {
    return null;
  }
  let x = String(v).trim().toUpperCase();
  if (field.endsWith("Terminal")) {
    x = x.replace(/^TERMINAL\s*/, "").replace(/^T(?=\d)/, "");
    if (/^(I|INT|INTL|INTERNATIONAL)$/.test(x)) {
      x = "I";
    }
  } else if (field.endsWith("Gate")) {
    x = x.replace(/^GATE\s*/, "");
  } else {
    x = x.replace(/^(BELT|CAROUSEL|CLAIM)\s*/, "");
  }
  x = x.replace(/[\s-]/g, "");
  return x || null;
}
const STATUS_RANK = { scheduled: 0, delayed: 0, boarding: 1, departed: 2, landed: 3 };

/** New trip-state segment: fresh values win, but a field a provider dropped keeps its last value. */
export function mergeStatus(prev, next) {
  if (!prev) {
    return { ...next };
  }
  const out = { ...prev, ...next };
  for (const k of [...FIELDS, "estDep", "actDep", "estArr", "actArr", "schedDep", "schedArr"]) {
    if (
      next[k] == null &&
      prev[k] != null &&
      !(k === "estDep" && next.actDep) &&
      !(k === "estArr" && next.actArr)
    ) {
      out[k] = prev[k];
    }
  }
  if (next.status === "unknown" && prev.status) {
    out.status = prev.status;
  }
  // A slower fallback provider must not walk a flight back from landed to departed.
  if (
    (STATUS_RANK[prev.status] ?? -1) > (STATUS_RANK[out.status] ?? -1) &&
    STATUS_RANK[out.status] != null
  ) {
    out.status = prev.status;
  }
  if (prev.alertedDelayMin != null) {
    out.alertedDelayMin = prev.alertedDelayMin;
  }
  return out;
}

/**
 * Events for one flight between the previous and the merged-new trip-state segment.
 * Mutates `next.alertedDelayMin` when a delay event is produced.
 */
export function diffStatus(seg, prev, next) {
  const ev = [];
  const id = seg.id;
  const name = fno(seg);
  const fromTz = seg.from?.tz;
  const toTz = seg.to?.tz;
  const route = `${seg.from?.iata ?? "?"} → ${seg.to?.iata ?? "?"}`;
  const p = prev ?? {};
  // `seq` names a field whose value can come back (gate, delay): its counter goes into the key, so
  // the dedupe map never swallows a real second change to a value announced before.
  const push = (key, level, title, body, seq) => {
    let k = `${id}:${key}`;
    if (seq) {
      const counts = { ...p.alertSeq, ...next.alertSeq };
      counts[seq] = (counts[seq] ?? 0) + 1;
      next.alertSeq = counts;
      k += `:${counts[seq]}`;
    }
    ev.push({ key: k, segmentId: id, level, title, body });
  };

  if (next.status !== p.status) {
    if (next.status === "cancelled") {
      push(
        "status:cancelled",
        "critical",
        `${name} CANCELLED`,
        `${route} on ${dayLabel(seg.depLocal)}. Check the airline app or call them for rebooking.`,
      );
    } else if (next.status === "diverted") {
      push(
        "status:diverted",
        "critical",
        `${name} diverted`,
        `${route} is diverted. Check the airline app.`,
      );
    } else if (next.status === "departed" && p.status !== "landed") {
      const dep = isoMs(next.actDep) || isoMs(next.estDep);
      const arr = isoMs(next.estArr);
      push(
        "status:departed",
        "info",
        `${name} departed ${at(dep, fromTz)}`,
        Number.isFinite(arr)
          ? `Lands about ${at(arr, toTz)} at ${seg.to?.iata ?? "destination"}.`
          : route,
      );
    } else if (next.status === "landed") {
      const arr = isoMs(next.actArr) || isoMs(next.estArr);
      push(
        "status:landed",
        "info",
        `${name} landed ${at(arr, toTz)}`,
        next.baggage ? `Bags at belt ${next.baggage}.` : `At ${seg.to?.iata ?? "destination"}.`,
      );
    }
  }

  if (!["cancelled", "diverted", "departed", "landed"].includes(next.status)) {
    const delay = depDelayMin(seg, next);
    const told = p.alertedDelayMin ?? 0;
    // An early departure (negative delay) on a flight never reported late is not "back on time".
    if (
      Math.abs(delay - told) >= DELAY_STEP_MIN &&
      (delay >= DELAY_STEP_MIN || told >= DELAY_STEP_MIN)
    ) {
      const dep = isoMs(next.estDep);
      const sched = isoMs(next.schedDep) || localToUtcMs(seg.depLocal, fromTz);
      if (delay >= DELAY_STEP_MIN) {
        push(
          `delay:${delay}`,
          delay >= 60 ? "critical" : "warn",
          `${name} delayed +${delay} min`,
          `Now departs ${at(dep, fromTz)} (was ${at(sched, fromTz)}). ${route}.`,
          "delay",
        );
      } else {
        push(
          `delay:${delay}`,
          "info",
          `${name} back near on time`,
          `Departs ${at(dep, fromTz)}. ${route}.`,
          "delay",
        );
      }
      next.alertedDelayMin = delay;
    }
  }

  // Providers spell the same place differently ("INTL" vs "I"), so values are compared normalised;
  // any other difference is news whichever provider reported it.
  const fieldEvent = (k, label, levelOnChange) => {
    const a = p[k] ?? null;
    const b = next[k] ?? null;
    if (b == null || normPlace(k, a) === normPlace(k, b)) {
      return;
    }
    const body = k.startsWith("dep") ? describeDep(seg, next) : describeArr(seg, next);
    if (a == null) {
      push(`${k}:${b}`, "info", `${name}: ${label} ${b}`, body, k);
    } else {
      push(
        `${k}:${b}`,
        levelOnChange,
        `${name}: ${label.toUpperCase()} CHANGED ${a} → ${b}`,
        body,
        k,
      );
    }
  };
  if (next.status !== "cancelled") {
    if (!["departed", "landed"].includes(next.status)) {
      fieldEvent("depTerminal", "terminal", "warn");
      fieldEvent("depGate", "gate", "warn");
    }
    fieldEvent("arrTerminal", "arrival terminal", "info");
    fieldEvent("arrGate", "arrival gate", "info");
    fieldEvent("baggage", "bags at belt", "info");
  }
  return ev;
}

function describeDep(seg, live) {
  const parts = [];
  if (live.depTerminal) {
    parts.push(`Terminal ${live.depTerminal}`);
  }
  if (live.depGate) {
    parts.push(`gate ${live.depGate}`);
  }
  const dep = isoMs(live.actDep) || isoMs(live.estDep) || localToUtcMs(seg.depLocal, seg.from?.tz);
  parts.push(`departs ${at(dep, seg.from?.tz)}`);
  return `${parts.join(", ")}.`;
}

function describeArr(seg, live) {
  const arr = isoMs(live.actArr) || isoMs(live.estArr) || localToUtcMs(seg.arrLocal, seg.to?.tz);
  const parts = [
    `${live.actArr ? "Landed" : "Lands"} ${at(arr, seg.to?.tz)} at ${seg.to?.iata ?? "destination"}`,
  ];
  if (live.arrTerminal) {
    parts.push(`terminal ${live.arrTerminal}`);
  }
  if (live.arrGate) {
    parts.push(`gate ${live.arrGate}`);
  }
  if (live.baggage) {
    parts.push(`belt ${live.baggage}`);
  }
  return `${parts.join(", ")}.`;
}

/**
 * Time-based reminders that are due now (check-in open, leave for the airport). A flight marked
 * `confirmed: false` is a placeholder, not a booking: no reminders for it. No booking code in the
 * text either: it would sit on the lock screen, and the trip page has it behind the door.
 */
export function reminders(trip, state, now, log = () => {}) {
  const ev = [];
  for (const seg of trip.segments ?? []) {
    if (seg?.type !== "flight" || seg.confirmed === false) {
      continue;
    }
    try {
      ev.push(...flightReminders(seg, state, now));
    } catch (err) {
      log(`segment ${seg.id ?? "?"} skipped: ${err.message}`);
    }
  }
  return ev;
}

function flightReminders(seg, state, now) {
  const ev = [];
  const live = state.segments?.[seg.id];
  if (live && ["cancelled", "departed", "landed", "diverted"].includes(live.status)) {
    return ev;
  }
  const sched = localToUtcMs(seg.depLocal, seg.from?.tz);
  if (sched == null) {
    return ev;
  }
  const name = fno(seg);
  const fromTz = seg.from?.tz;
  const dep = isoMs(live?.actDep) || isoMs(live?.estDep) || sched;
  if (now >= sched - 24 * H && now < sched - 2 * H) {
    ev.push({
      key: `${seg.id}:remind:checkin`,
      segmentId: seg.id,
      level: "info",
      title: `${name} check-in is open`,
      body: `Departs ${dayLabel(seg.depLocal)} ${at(sched, fromTz)} from ${seg.from?.iata ?? "?"}.`,
    });
  }
  const lead = isDomestic(seg) ? 2 * H : 3 * H;
  if (now >= sched - lead && now < sched - 45 * 60_000) {
    const where = [
      live?.depTerminal && `terminal ${live.depTerminal}`,
      live?.depGate && `gate ${live.depGate}`,
    ]
      .filter(Boolean)
      .join(", ");
    ev.push({
      key: `${seg.id}:remind:leave`,
      segmentId: seg.id,
      level: "warn",
      title: `Time to leave for ${seg.from?.iata ?? "the airport"}`,
      body: `${name} departs ${at(dep, fromTz)}${dep !== sched ? ` (delayed, was ${at(sched, fromTz)})` : ""}, in ${spanLabel(dep - now)}.${where ? ` ${where[0].toUpperCase()}${where.slice(1)}.` : ""}`,
    });
  }
  return ev;
}

/** Keep only events never sent and not already waiting. Adds them to state.pending. */
export function queueEvents(state, events, now) {
  state.notified ??= {};
  state.pending ??= [];
  const waiting = new Set(state.pending.map((p) => p.key));
  const fresh = [];
  for (const e of events) {
    if (state.notified[e.key] || waiting.has(e.key)) {
      continue;
    }
    waiting.add(e.key);
    const item = { ...e, at: new Date(now).toISOString() };
    state.pending.push(item);
    fresh.push(item);
  }
  return fresh;
}

const SEVERITY = { critical: 0, warn: 1, info: 2 };

/**
 * Pending events grouped per flight into one notification each, most severe first, so a pass that
 * sees gate + terminal + belt at once buzzes the phone once.
 */
export function bundle(pending) {
  const groups = new Map();
  for (const p of pending) {
    const k = p.segmentId ?? p.key;
    if (!groups.has(k)) {
      groups.set(k, []);
    }
    groups.get(k).push(p);
  }
  return [...groups.values()].map((items) => {
    const headline = (e) => (/:(status|delay|remind):/.test(e.key) ? 0 : 1);
    items.sort(
      (a, b) => (SEVERITY[a.level] ?? 3) - (SEVERITY[b.level] ?? 3) || headline(a) - headline(b),
    );
    const [top, ...rest] = items;
    return {
      items,
      level: top.level,
      title: top.title,
      body: [top.body, ...rest.map((r) => `${r.title}.`)].join("\n"),
    };
  });
}

/**
 * Try every pending notification; sent or expired ones move to `notified`. `onSent` runs after each
 * delivered message (runOnce saves trip-state there), so a pass killed halfway never re-sends what
 * already reached the phone.
 */
export async function deliverPending(state, send, now, log = () => {}, onSent = () => {}) {
  const still = [];
  const sent = [];
  const stamp = new Date(now).toISOString();
  const msgs = bundle(state.pending ?? []);
  for (const [i, msg] of msgs.entries()) {
    let ok = false;
    try {
      ok = await send(msg);
    } catch (err) {
      log(`notify failed for ${msg.title}: ${err.message}`);
    }
    for (const p of msg.items) {
      if (ok) {
        state.notified[p.key] = stamp;
        sent.push(p);
      } else if (now - Date.parse(p.at) > PENDING_TTL_MS) {
        log(`giving up on ${p.key} after ${PENDING_TTL_MS / H} h`);
        state.notified[p.key] = stamp;
      } else {
        still.push(p);
      }
    }
    if (ok) {
      state.pending = [...still, ...msgs.slice(i + 1).flatMap((m) => m.items)];
      onSent();
    }
  }
  state.pending = still;
  return sent;
}

export function pruneNotified(state, now) {
  for (const [k, v] of Object.entries(state.notified ?? {})) {
    if (now - Date.parse(v) > 30 * 86_400_000) {
      delete state.notified[k];
    }
  }
}

/**
 * Append alerts (trip.json shape) and keep the newest MAX_ALERTS. Idempotent: an alert already there
 * (same time, segment and text) is not added again, so a pass re-run after a crash adds nothing twice.
 */
export function appendAlerts(trip, events) {
  const alerts = Array.isArray(trip.alerts) ? [...trip.alerts] : [];
  const sig = (a) => `${a?.at}|${a?.segmentId}|${a?.text}`;
  const have = new Set(alerts.map(sig));
  for (const e of events) {
    const a = { at: e.at, segmentId: e.segmentId, level: e.level, text: `${e.title}. ${e.body}` };
    if (!have.has(sig(a))) {
      have.add(sig(a));
      alerts.push(a);
    }
  }
  alerts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return alerts.slice(-MAX_ALERTS);
}

/** Parse `openclaw ... --json` output that may carry log lines before the JSON. */
export function parseCliJson(stdout) {
  // Log lines such as "[plugins/registry] ..." also start with "[", so try each candidate line.
  const lines = String(stdout ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[{[]/.test(lines[i])) {
      continue;
    }
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // not the JSON yet
    }
  }
  return null;
}

export function pickAndroidNode(status) {
  const nodes = Array.isArray(status?.nodes) ? status.nodes : [];
  const n = nodes.find((x) => x.connected && /android/i.test(String(x.platform ?? "")));
  return n ? n.nodeId || n.displayName : null;
}

const PRIORITY = { critical: "timeSensitive", warn: "timeSensitive", info: "active" };

/**
 * What a failed CLI call is logged as: exit code, signal, last stderr line. Never err.message, which
 * for execFile is the whole command line, notification text included.
 */
export function errSummary(err) {
  const last = String(err?.stderr ?? "")
    .trim()
    .split("\n")
    .pop()
    ?.slice(0, 200);
  const parts = [
    err?.killed ? "timed out" : null,
    err?.code != null ? `code ${err.code}` : null,
    err?.signal ?? null,
    last || null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "failed";
}

/** Real sender: phone node via `openclaw nodes invoke system.notify`, WhatsApp only if configured. */
export function makeSender({ env = process.env, log = () => {}, run } = {}) {
  const bin = env.OPENCLAW_BIN || "openclaw";
  const exec =
    run ??
    (async (args, timeout) =>
      (await promisify(execFile)(bin, args, { timeout, maxBuffer: 4 << 20 })).stdout);
  let node;
  const resolveNode = async () => {
    if (node !== undefined) {
      return node;
    }
    node = env.TRIP_NOTIFY_NODE || null;
    if (!node) {
      try {
        node = pickAndroidNode(parseCliJson(await exec(["nodes", "status", "--json"], 90_000)));
      } catch (err) {
        log(`nodes status failed: ${errSummary(err)}`);
      }
      if (!node) {
        log("no connected android node");
      }
    }
    return node;
  };
  return async (ev) => {
    const target = await resolveNode();
    if (target) {
      // Param names from apps/android/.../node/SystemHandler.kt parseNotifyRequest: title, body, sound, priority.
      const params = JSON.stringify({
        title: `✈ ${ev.title}`,
        body: ev.body,
        priority: PRIORITY[ev.level] ?? "active",
      });
      try {
        await exec(
          [
            "nodes",
            "invoke",
            "--node",
            target,
            "--command",
            "system.notify",
            "--params",
            params,
            "--json",
          ],
          60_000,
        );
        log(`notified ${target}: ${ev.title}`);
        return true;
      } catch (err) {
        log(`system.notify on ${target} failed: ${errSummary(err)}`);
      }
    }
    if (env.TRIP_WHATSAPP_TARGET) {
      try {
        await exec(
          [
            "message",
            "send",
            "--channel",
            "whatsapp",
            "--target",
            env.TRIP_WHATSAPP_TARGET,
            "--message",
            `✈ ${ev.title}\n${ev.body}`,
          ],
          60_000,
        );
        log(`sent via WhatsApp: ${ev.title}`);
        return true;
      } catch (err) {
        log(`WhatsApp fallback failed: ${errSummary(err)}`);
      }
    } else {
      log("TRIP_WHATSAPP_TARGET unset, no fallback");
    }
    return false;
  };
}

/** True when trip.html is missing or older than trip.json / trip-state.json. */
export function htmlStale(dir) {
  const mtime = (f) => {
    try {
      return fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {
      return Number.NaN;
    }
  };
  const html = mtime("trip.html");
  if (!Number.isFinite(html)) {
    return true;
  }
  return [mtime("trip.json"), mtime("trip-state.json")].some((m) => Number.isFinite(m) && m > html);
}

const LOCK_STALE_MS = 15 * 60_000;

/** One pass at a time (timer + a manual --once). Returns a release function, or null when busy. */
export function takeLock(dir, log = () => {}) {
  const lock = path.join(dir, ".flight-watch.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return () => fs.rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released in between
      }
      if (age < LOCK_STALE_MS) {
        log("another pass is running, skipping this one");
        return null;
      }
      log(`removing a stale lock (${Math.round(age / 60_000)} min old)`);
      fs.rmSync(lock, { force: true });
    }
  }
  return null;
}

/**
 * One pass. Returns { watched, events, sent }. In dry-run nothing is written except the provider
 * politeness cache, and nothing is sent.
 * Write order, so a pass killed at any point neither loses nor repeats a notification: trip-state
 * (events now in `pending`) -> trip.json alerts (idempotent) -> each send, saving trip-state after it.
 */
export async function runOnce({
  dir = tripDir(),
  now = Date.now(),
  dryRun = false,
  fetchStatus = fetchFlightStatus,
  send,
  log = () => {},
} = {}) {
  const raw = loadTrip(dir);
  if (!raw) {
    log(`no trip.json in ${dir}, nothing to do`);
    return { watched: 0, events: [], sent: [] };
  }
  const release = dryRun ? () => {} : takeLock(dir, log);
  if (!release) {
    return { watched: 0, events: [], sent: [] };
  }
  try {
    return await pass({ dir, raw, now, dryRun, fetchStatus, send, log });
  } finally {
    release();
  }
}

async function pass({ dir, raw, now, dryRun, fetchStatus, send, log }) {
  // Computation reads a sanitised copy; alerts are written into the file as it is on disk.
  const trip = tripView(raw);
  const state = loadState(dir);
  state.segments ??= {};
  state.pending = Array.isArray(state.pending) ? state.pending : [];
  const events = [];
  const flights = watchedFlights(trip, state, now, log);
  let changed = false;
  for (const seg of flights) {
    try {
      const r = await fetchStatus(seg, { cacheFile: cachePath(dir), now, log });
      if (!r) {
        log(`${fno(seg)} ${seg.depLocal}: no provider knows it`);
        continue;
      }
      const prev = state.segments[seg.id];
      const next = mergeStatus(prev, r.status);
      events.push(...diffStatus(seg, prev, next));
      log(`${fno(seg)}: ${next.status} via ${r.provider}${r.cached ? " (cached)" : ""}`);
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        changed = true;
      }
      state.segments[seg.id] = next;
    } catch (err) {
      log(`${fno(seg)}: skipped this pass, ${err.message}`);
    }
  }
  events.push(...reminders(trip, state, now, log));
  const fresh = queueEvents(state, events, now);

  if (dryRun) {
    for (const m of bundle(state.pending)) {
      const keys = m.items.map((i) => i.key).join(", ");
      console.log(
        `[dry-run] would notify (${m.level}) [${keys}]: ✈ ${m.title} | ${m.body.replace(/\n/g, " / ")}`,
      );
    }
    if (!state.pending.length) {
      console.log("[dry-run] nothing to notify");
    }
    return { watched: flights.length, events: fresh, sent: [] };
  }

  const statePath = path.join(dir, "trip-state.json");
  const saveState = () => writeJsonAtomic(statePath, state);
  if (changed || fresh.length) {
    saveState();
  }
  const unwritten = state.pending.filter((p) => !p.alerted);
  if (unwritten.length) {
    // Re-read right before writing: another writer (the trip data unit, a person) may have saved since.
    const latest = loadTrip(dir) ?? raw;
    if (latest && typeof latest === "object" && !Array.isArray(latest)) {
      latest.alerts = appendAlerts(latest, unwritten);
      writeJsonAtomic(path.join(dir, "trip.json"), latest);
    } else {
      log("trip.json is not an object, alerts not written");
    }
    for (const p of unwritten) {
      p.alerted = true;
    }
    saveState();
  }
  const sent = state.pending.length
    ? await deliverPending(state, send ?? makeSender({ log }), now, log, saveState)
    : [];
  pruneNotified(state, now);
  if (sent.length || state.pending.length || changed || fresh.length) {
    saveState();
  }
  // Also when only trip.json changed (a stay or checklist item added): the door serves the file as is.
  if (htmlStale(dir)) {
    try {
      renderToDir(dir, { now });
    } catch (err) {
      log(`render failed: ${err.message}`);
    }
  }
  return { watched: flights.length, events: fresh, sent };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  const once = process.argv.includes("--once");
  const nowArg = arg("--now");
  const log = (m) => console.log(`[trip-watch ${new Date().toISOString()}] ${m}`);
  const pass = async () => {
    const r = await runOnce({ now: nowArg ? Date.parse(nowArg) : Date.now(), dryRun, log });
    log(`watched ${r.watched} flight(s), ${r.events.length} new event(s), ${r.sent.length} sent`);
  };
  try {
    await pass();
    if (!once && !nowArg) {
      setInterval(
        () => pass().catch((err) => log(`pass failed: ${err.stack || err.message}`)),
        INTERVAL_MS,
      );
    }
  } catch (err) {
    log(`failed: ${err.stack || err.message}`);
    process.exit(1);
  }
}
