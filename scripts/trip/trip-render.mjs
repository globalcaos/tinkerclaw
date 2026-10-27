#!/usr/bin/env node
/**
 * Trip render — trip.json (+ trip-state.json) -> one self-contained, offline trip.html.
 *
 * WHAT IT IS FOR: the phone's ✈ corner. One file, inline CSS and JS, no external requests, so the app
 * can keep a copy and show it with no signal (in a plane, at a border desk). Mobile-first, 360-420 px.
 * HOW IT WAS DERIVED: TripIt's layout (next item large, then day by day), reduced to what a traveller
 * reads at a gate: flight number, local times with the zone, terminal, gate, status, belt, the code to
 * read out at a desk. Flight times are wall clock in the airport's zone (as booked) with the home-time
 * hint, because that is how both the boarding pass and the people at home think about them.
 * WHAT WOULD CHANGE IT: a second traveller who needs per-person seats or codes; trips with many
 * legs a day (then the timeline wants hours, not cards).
 *
 * Run: node trip-render.mjs [--out <file>] [--now <ISO>]   (env TRIP_DIR, default ~/.openclaw/data/trip)
 * Library: renderTripHtml(trip, state, { now }) -> string; renderToDir(dir) -> path written.
 */
// FORK 2026-10-19 (the architect: phone app) — offline trip view served by the phone door at /trip/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dayLabel, daysBetween, localToUtcMs, spanLabel, tzAbbr, utcToLocal } from "./lib/time.mjs";
import {
  depDelayMin,
  loadState,
  loadTrip,
  segmentTimes,
  segmentTz,
  tripDir,
  tripView,
  writeAtomic,
} from "./lib/trip-io.mjs";

const ALERT_WINDOW_MS = 48 * 3_600_000;

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "");

/** "09:30 CET" for an instant in a zone. */
function clock(ms, tz) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  return `${utcToLocal(ms, tz).time} ${tzAbbr(ms, tz)}`;
}

/** Wall-clock text as written in trip.json plus the zone abbreviation. */
function wallClock(local, tz) {
  const ms = localToUtcMs(local, tz);
  const time = /T(\d{2}:\d{2})/.exec(local ?? "")?.[1] ?? "";
  const abbr = ms == null ? "" : tzAbbr(ms, tz);
  return { ms, time, abbr, text: abbr ? `${time} ${abbr}` : time };
}

/** " (Wed 04:20 at home)" — only when the airport is not in the home zone. */
function homeHint(ms, tz, homeTz, refDate) {
  if (!Number.isFinite(ms) || !homeTz || tz === homeTz) {
    return "";
  }
  const h = utcToLocal(ms, homeTz);
  const day = refDate && h.date !== refDate ? `${h.weekday} ` : "";
  return `${day}${h.time} ${tzAbbr(ms, homeTz)} at home`;
}

/** Status chip text + tone from trip-state. */
export function statusChip(seg, live, now) {
  if (!live || !live.status) {
    return { text: "no live status yet", tone: "muted" };
  }
  const delay = depDelayMin(seg, live);
  switch (live.status) {
    case "cancelled":
      return { text: "cancelled", tone: "critical" };
    case "diverted":
      return { text: "diverted", tone: "critical" };
    case "landed":
      return { text: "landed", tone: "ok" };
    case "departed":
      return { text: delay >= 15 ? `departed +${delay} min` : "departed", tone: "info" };
    case "boarding":
      return { text: "boarding", tone: "info" };
    case "unknown":
      return { text: "status unknown", tone: "muted" };
    default: {
      if (delay >= 5) {
        return { text: `delayed +${delay} min`, tone: delay >= 15 ? "warn" : "info" };
      }
      const t = segmentTimes(null, seg, live);
      const soon = Number.isFinite(t.start) && t.start - now < 3_600_000 && t.start > now;
      return { text: soon ? "on time · board soon" : "on time", tone: "ok" };
    }
  }
}

function tbcBadge(seg) {
  return seg.confirmed === false ? `<span class="tbc-badge">not booked / to confirm</span>` : "";
}

function copyChip(code, label = "Confirmation") {
  if (!code) {
    return "";
  }
  return `<button class="copy" type="button" data-copy="${esc(code)}" aria-label="Copy ${esc(label)} ${esc(code)}"><span class="copy-k">${esc(label)}</span> <span class="copy-v">${esc(code)}</span> <span class="copy-i">⧉</span></button>`;
}

function mapsLinks(seg) {
  const q = seg.address || seg.name || "";
  const hasGeo = Number.isFinite(seg.lat) && Number.isFinite(seg.lon);
  if (!q && !hasGeo) {
    return "";
  }
  const gq = hasGeo && !seg.address ? `${seg.lat},${seg.lon}` : q;
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gq)}`;
  const geo = hasGeo
    ? `geo:${seg.lat},${seg.lon}?q=${encodeURIComponent(`${seg.lat},${seg.lon}(${seg.name || q})`)}`
    : `geo:0,0?q=${encodeURIComponent(q)}`;
  return `<div class="links"><a href="${esc(gmaps)}" rel="noopener">Google Maps</a><a href="${esc(geo)}">Open in maps app</a></div>`;
}

function flightTitle(seg) {
  const num = [seg.carrier, seg.number].filter(Boolean).join(" ");
  return num || seg.airline || "Flight";
}

/** Facts row: terminal, gate, belt, seats. Only what is known. */
function flightFacts(seg, live, big) {
  const f = [];
  const add = (k, v) =>
    v &&
    f.push(`<div class="fact"><span class="fk">${k}</span><span class="fv">${esc(v)}</span></div>`);
  add("Terminal", live?.depTerminal);
  add("Gate", live?.depGate);
  if (big || live?.status === "landed" || live?.baggage) {
    add("Belt", live?.baggage);
  }
  if (live?.status === "departed" || live?.status === "landed") {
    add("Arr. terminal", live?.arrTerminal);
    add("Arr. gate", live?.arrGate);
  }
  add("Seats", seg.seats);
  return f.length ? `<div class="facts">${f.join("")}</div>` : "";
}

function flightTimes(trip, seg, live) {
  const dep = wallClock(seg.depLocal, seg.from?.tz);
  const arr = wallClock(seg.arrLocal, seg.to?.tz);
  const depDate = seg.depLocal?.slice(0, 10);
  const arrDate = seg.arrLocal?.slice(0, 10);
  const dayShift = depDate && arrDate ? daysBetween(depDate, arrDate) : 0;
  const t = segmentTimes(trip, seg, live);
  const newDep = Number.isFinite(t.start) && dep.ms != null && Math.abs(t.start - dep.ms) >= 60_000;
  const newArr = Number.isFinite(t.end) && arr.ms != null && Math.abs(t.end - arr.ms) >= 60_000;
  const depHint = homeHint(dep.ms, seg.from?.tz, trip.homeTz, depDate);
  const arrHint = homeHint(arr.ms, seg.to?.tz, trip.homeTz, depDate);
  return `<div class="route">
  <div class="ep"><div class="iata">${esc(seg.from?.iata)}</div><div class="tm">${esc(dep.time)}<span class="tz">${esc(dep.abbr)}</span></div>${
    newDep
      ? `<div class="new">${live?.actDep ? "left" : "now"} ${esc(clock(t.start, seg.from?.tz))}</div>`
      : ""
  }<div class="ap">${esc(seg.from?.name)}</div>${depHint ? `<div class="hint">${esc(depHint)}</div>` : ""}</div>
  <div class="arrow">→</div>
  <div class="ep"><div class="iata">${esc(seg.to?.iata)}</div><div class="tm">${esc(arr.time)}<span class="tz">${esc(arr.abbr)}</span>${
    dayShift > 0 ? ` <sup>+${dayShift}</sup>` : ""
  }</div>${
    newArr
      ? `<div class="new">${live?.actArr ? "landed" : "now"} ${esc(clock(t.end, seg.to?.tz))}</div>`
      : ""
  }<div class="ap">${esc(seg.to?.name)}</div>${arrHint ? `<div class="hint">${esc(arrHint)}</div>` : ""}</div>
</div>`;
}

function flightCard(trip, seg, live, now, { big = false } = {}) {
  const chip = statusChip(seg, live, now);
  const updated = live?.fetchedAt
    ? `<div class="src">live: ${esc(live.source || "?")}, ${esc(clock(Date.parse(live.fetchedAt), trip.homeTz))}</div>`
    : "";
  return `<article class="card flight${seg.confirmed === false ? " tbc" : ""}${big ? " big" : ""}" data-seg="${esc(seg.id)}">
  <div class="card-h"><span class="kind">✈</span><span class="fno">${esc(flightTitle(seg))}</span><span class="airline">${esc(seg.airline)}</span><span class="chip ${chip.tone}">${esc(chip.text)}</span></div>
  ${tbcBadge(seg)}
  ${flightTimes(trip, seg, live)}
  ${flightFacts(seg, live, big)}
  ${copyChip(seg.confirmation)}
  ${seg.notes ? `<p class="notes">${esc(seg.notes)}</p>` : ""}
  ${updated}
</article>`;
}

function stayCard(trip, seg, { big = false } = {}) {
  const nights = seg.checkIn && seg.checkOut ? daysBetween(seg.checkIn, seg.checkOut) : null;
  return `<article class="card stay${seg.confirmed === false ? " tbc" : ""}${big ? " big" : ""}" data-seg="${esc(seg.id)}">
  <div class="card-h"><span class="kind">🛏</span><span class="fno">${esc(seg.name || "Place to stay")}</span></div>
  ${tbcBadge(seg)}
  <div class="kv">${esc(dayLabel(seg.checkIn))} → ${esc(dayLabel(seg.checkOut))}${nights != null ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}</div>
  ${seg.address ? `<div class="addr">${esc(seg.address)}</div>` : ""}
  ${mapsLinks(seg)}
  ${copyChip(seg.confirmation)}
  ${seg.notes ? `<p class="notes">${esc(seg.notes)}</p>` : ""}
</article>`;
}

function carCard(trip, seg, { big = false } = {}) {
  const tz = segmentTz(trip, seg);
  const pu = wallClock(seg.pickup?.local, tz);
  const doTz = seg.dropoff?.tz || tz;
  const dr = wallClock(seg.dropoff?.local, doTz);
  const when = (w, local) => (local ? `${dayLabel(local)} ${w.text}` : "");
  return `<article class="card car${seg.confirmed === false ? " tbc" : ""}${big ? " big" : ""}" data-seg="${esc(seg.id)}">
  <div class="card-h"><span class="kind">🚗</span><span class="fno">${esc(seg.company || "Car")}</span></div>
  ${tbcBadge(seg)}
  <div class="kv"><span class="fk">Pick up</span> ${esc(when(pu, seg.pickup?.local))}${seg.pickup?.place ? ` · ${esc(seg.pickup.place)}` : ""}</div>
  <div class="kv"><span class="fk">Return</span> ${esc(when(dr, seg.dropoff?.local))}${seg.dropoff?.place ? ` · ${esc(seg.dropoff.place)}` : ""}</div>
  ${copyChip(seg.confirmation)}
  ${seg.notes ? `<p class="notes">${esc(seg.notes)}</p>` : ""}
</article>`;
}

function activityRow(seg) {
  return `<div class="row activity${seg.confirmed === false ? " tbc" : ""}" data-seg="${esc(seg.id)}"><span class="kind">★</span><div><div class="rt">${esc(seg.title || "Activity")}</div>${tbcBadge(seg)}${seg.notes ? `<div class="notes">${esc(seg.notes)}</div>` : ""}</div></div>`;
}

function smallRow(icon, text, seg) {
  return `<div class="row${seg.confirmed === false ? " tbc" : ""}"><span class="kind">${icon}</span><div class="rt">${esc(text)}</div></div>`;
}

/**
 * Timeline entries: [{date, sort, html}] grouped later by local date. An entry with no date (a flight
 * not booked yet) is kept: it goes to a "date to confirm" group instead of vanishing.
 */
function timelineEntries(trip, state, now) {
  const out = [];
  for (const seg of trip.segments ?? []) {
    try {
      out.push(...segmentEntries(trip, state, now, seg));
    } catch (err) {
      // One odd segment must not blank the whole page; it is reported where the page is rendered.
      console.warn(`[trip-render] segment ${seg.id ?? "?"} skipped: ${err.message}`);
    }
  }
  return out;
}

function segmentEntries(trip, state, now, seg) {
  const out = [];
  const live = state.segments?.[seg.id];
  const t = segmentTimes(trip, seg, live);
  if (seg.type === "flight") {
    out.push({
      date: seg.depLocal?.slice(0, 10),
      sort: t.schedDep ?? t.start,
      html: flightCard(trip, seg, live, now),
    });
  } else if (seg.type === "stay") {
    out.push({ date: seg.checkIn, sort: t.start, html: stayCard(trip, seg) });
    if (seg.checkOut) {
      const tz = segmentTz(trip, seg);
      out.push({
        date: seg.checkOut,
        sort: localToUtcMs(`${seg.checkOut}T11:00`, tz),
        html: smallRow("🛏", `Check out · ${seg.name || "place to stay"}`, seg),
      });
    }
  } else if (seg.type === "car") {
    out.push({ date: seg.pickup?.local?.slice(0, 10), sort: t.start, html: carCard(trip, seg) });
    if (seg.dropoff?.local) {
      const tz = seg.dropoff.tz || segmentTz(trip, seg);
      out.push({
        date: seg.dropoff.local.slice(0, 10),
        sort: localToUtcMs(seg.dropoff.local, tz),
        html: smallRow(
          "🚗",
          `Return car${seg.dropoff.place ? ` · ${seg.dropoff.place}` : ""} · ${wallClock(seg.dropoff.local, tz).text}`,
          seg,
        ),
      });
    }
  } else if (seg.type === "activity") {
    out.push({ date: seg.date, sort: (t.start ?? 0) + 12 * 3_600_000, html: activityRow(seg) });
  }
  return out;
}

function nextUpCards(trip, state, now) {
  const items = (trip.segments ?? [])
    .filter((s) => s.type === "flight" || s.type === "stay" || s.type === "car")
    .map((s) => ({
      s,
      live: state.segments?.[s.id],
      t: segmentTimes(trip, s, state.segments?.[s.id]),
    }))
    .filter((x) => Number.isFinite(x.t.start) && Number.isFinite(x.t.end) && x.t.end > now)
    // Every upcoming item is rendered (hidden but the first): an offline copy days old still finds
    // the right "next" by itself.
    .toSorted((a, b) => a.t.start - b.t.start);
  const cards = items.map(({ s, live, t }) => {
    const label =
      s.type === "flight"
        ? flightTitle(s)
        : s.type === "stay"
          ? s.name || "check-in"
          : s.company || "car pick-up";
    const verb = s.type === "flight" ? "departs" : s.type === "stay" ? "check-in" : "pick-up";
    let card;
    try {
      card =
        s.type === "flight"
          ? flightCard(trip, s, live, now, { big: true })
          : s.type === "stay"
            ? stayCard(trip, s, { big: true })
            : carCard(trip, s, { big: true });
    } catch (err) {
      console.warn(`[trip-render] next-up ${s.id ?? "?"} skipped: ${err.message}`);
      return null;
    }
    const left = t.start - now;
    const cd =
      left > 0 ? `${verb} in ${spanLabel(left)}` : s.type === "flight" ? "in the air" : "now";
    const html = (
      i,
    ) => `<div class="next-item${i ? " hidden" : ""}" data-start="${iso(t.start)}" data-end="${iso(t.end)}" data-label="${esc(label)}" data-verb="${esc(verb)}" data-kind="${s.type}">
  <div class="countdown" data-countdown="${iso(t.start)}" data-verb="${esc(verb)}">${esc(cd)}</div>
  ${card}
</div>`;
    return { html, label, verb, kind: s.type, start: t.start };
  });
  return cards.filter(Boolean).map((c, i) => Object.assign(c, { html: c.html(i) }));
}

function alertsHtml(trip, now) {
  // An alert about a flight in the plan repeats what its status chip already shows: the phone ping is
  // enough, the page keeps only alerts with nowhere else to live.
  const shown = new Set((trip.segments ?? []).filter((s) => s.type === "flight").map((s) => s.id));
  const recent = (trip.alerts ?? [])
    .filter((a) => !shown.has(a.segmentId))
    .filter((a) => Number.isFinite(Date.parse(a.at)) && now - Date.parse(a.at) < ALERT_WINDOW_MS)
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!recent.length) {
    return "";
  }
  const items = recent
    .map((a) => {
      const level = ["critical", "warn", "info"].includes(a.level) ? a.level : "info";
      return `<div class="alert ${level}" data-at="${esc(a.at)}"><span class="at">${esc(clock(Date.parse(a.at), trip.homeTz))}</span> ${esc(a.text)}</div>`;
    })
    .join("");
  return `<section class="alerts" id="alerts">${items}</section>`;
}

// Checklist items live inside the plan: a dated item on its `due` day, an undated one (packing) on
// departure day, before the flight. Consecutive items of one `group` fold together; the fold state
// and the ticks are kept on the device.
function tasksHtml(items, today) {
  const row = (c) => {
    const overdue = !c.done && c.due && c.due < today;
    return `<li class="${c.done ? "done" : ""}${overdue ? " overdue" : ""}" data-due="${esc(c.due ?? "")}" data-k="${esc(c.text)}"><span class="box">${c.done ? "✓" : ""}</span><span class="ct">${esc(c.text)}</span></li>`;
  };
  const runs = [];
  for (const c of items) {
    const g = typeof c.group === "string" && c.group ? c.group : "To do";
    if (!runs.length || runs.at(-1).g !== g) {
      runs.push({ g, items: [] });
    }
    runs.at(-1).items.push(c);
  }
  return runs
    .map(({ g, items: its }) => {
      const done = its.filter((c) => c.done).length;
      const open = its.some((c) => c.due) && done < its.length;
      return `<details class="cgroup" data-g="${esc(g)}"${open ? " open" : ""}><summary><span class="cg-name">☐ ${esc(g)}</span><span class="cg-count">${done}/${its.length}</span></summary><ul class="check">${its.map(row).join("")}</ul></details>`;
    })
    .join("");
}

/** date -> checklist items for that day, in trip.json order. */
function tasksByDate(trip, dates) {
  const list = (trip.checklist ?? []).filter((c) => c && typeof c.text === "string");
  const flights = (trip.segments ?? [])
    .filter((s) => s.type === "flight" && /^\d{4}-\d{2}-\d{2}/.test(s.depLocal ?? ""))
    .map((s) => s.depLocal.slice(0, 10))
    .toSorted();
  const departure = flights[0] ?? [...dates].toSorted()[0];
  const out = new Map();
  for (const c of list) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(c.due ?? "") ? c.due : departure;
    if (!d) {
      continue;
    }
    if (!out.has(d)) {
      out.set(d, []);
    }
    out.get(d).push(c);
  }
  return out;
}

function contactsHtml(trip) {
  const list = (trip.contacts ?? []).filter((c) => c.name || c.phone);
  if (!list.length) {
    return "";
  }
  const rows = list
    .map((c) => {
      const tel = c.phone ? String(c.phone).replace(/[^\d+]/g, "") : "";
      return `<li><div><div class="ct">${esc(c.name)}</div>${c.role ? `<div class="role">${esc(c.role)}</div>` : ""}</div>${
        tel
          ? `<a class="tel" href="tel:${esc(tel)}">${esc(c.phone)}</a>`
          : `<span class="role">no phone</span>`
      }</li>`;
    })
    .join("");
  return `<section class="block"><h2>Contacts</h2><ul class="contacts">${rows}</ul></section>`;
}

function questionsHtml(trip) {
  const qs = (trip.openQuestions ?? []).filter(Boolean);
  if (!qs.length) {
    return "";
  }
  return `<section class="block tbc-box"><h2>To confirm</h2><ul>${qs.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></section>`;
}

const CSS = `
:root{--bg:#f4ead9;--card:#fffaf1;--line:#e2d3bb;--wood:#6b5545;--wood2:#4e3b31;--accent:#a07d50;--text:#2a2018;--muted:#7a6a58;
--ok:#2f7d3a;--info:#2b5f9e;--warn:#b26a00;--crit:#b3261e}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:440px;margin:0 auto;padding:0 12px 40px}
header.top{background:var(--wood2);color:#f4ead9;padding:14px 14px 12px;margin:0 -12px 12px;border-bottom:3px solid var(--accent)}
header.top h1{margin:0;font-size:20px;line-height:1.2}
header.top .sub{font-size:13px;opacity:.85;margin-top:4px}
header.top .hcd{font-size:15px;font-weight:600;margin-top:6px;color:#ffe2b8}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--wood);margin:18px 2px 8px}
.alerts{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
.alert{border-radius:10px;padding:9px 11px;font-size:14px;border-left:5px solid}
.alert .at{font-weight:600;margin-right:4px}
.alert.critical{background:#fbe3e1;border-color:var(--crit);color:#6d1510}
.alert.warn{background:#fdf0d8;border-color:var(--warn);color:#5c3900}
.alert.info{background:#e3edf8;border-color:var(--info);color:#173a63}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:10px;box-shadow:0 1px 2px rgba(78,59,49,.08)}
.card.tbc,.row.tbc{border-style:dashed;border-color:#c9b28f;background:#fbf4e7}
.card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kind{font-size:16px;width:22px;text-align:center}
.fno{font-weight:700;font-size:17px}
.airline{color:var(--muted);font-size:13px}
.chip{margin-left:auto;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;white-space:nowrap;border:1px solid}
.chip.ok{color:var(--ok);border-color:#9cc9a3;background:#edf7ee}
.chip.info{color:var(--info);border-color:#a8c2e3;background:#eef4fb}
.chip.warn{color:var(--warn);border-color:#e8c27f;background:#fdf3e1}
.chip.critical{color:#fff;border-color:var(--crit);background:var(--crit)}
.chip.muted{color:var(--muted);border-color:var(--line);background:#f6efe2}
.tbc-badge{display:inline-block;margin:6px 0 0;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#8a5a00;background:#fbe9c6;border-radius:6px;padding:2px 7px}
.route{display:grid;grid-template-columns:1fr 22px 1fr;align-items:start;gap:6px;margin-top:10px}
.arrow{text-align:center;font-size:20px;color:var(--accent);padding-top:6px}
.ep .iata{font-size:13px;font-weight:700;color:var(--wood);letter-spacing:.06em}
.ep .tm{font-size:20px;font-weight:700;line-height:1.15}
.ep .tm .tz{font-size:12px;font-weight:600;color:var(--muted);margin-left:4px}
.ep .tm sup{font-size:11px;color:var(--warn)}
.ep .new{font-size:13px;font-weight:700;color:var(--warn)}
.ep .ap{font-size:12px;color:var(--muted)}
.ep .hint{font-size:12px;color:var(--info)}
.big .fno{font-size:22px}
.big .ep .tm{font-size:26px}
.facts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.fact{background:#f3e8d5;border-radius:8px;padding:5px 9px;min-width:64px}
.fk{display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.fv{font-size:18px;font-weight:700}
.big .fv{font-size:22px}
.kv{margin-top:6px;font-size:14px}
.kv .fk{display:inline;margin-right:4px}
.addr{margin-top:4px;font-size:14px}
.links{display:flex;gap:14px;margin-top:6px;font-size:14px}
a{color:var(--info)}
.copy{margin-top:10px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#f3e8d5;border-radius:10px;padding:6px 10px;font:inherit;color:var(--text);cursor:pointer}
.copy-k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.copy-v{font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:700;letter-spacing:.08em}
.copy.done .copy-i{color:var(--ok)}
.notes{margin:8px 0 0;font-size:13px;color:var(--muted)}
.src{margin-top:6px;font-size:11px;color:var(--muted)}
.countdown{font-size:14px;font-weight:600;color:var(--wood);margin:0 2px 6px}
.hidden{display:none}
.day{margin-bottom:6px}
.day h3{font-size:14px;margin:14px 2px 6px;color:var(--wood2);display:flex;gap:8px;align-items:center}
.day.past{opacity:.55}
.today-badge{font-size:11px;background:var(--wood);color:#fff;border-radius:6px;padding:1px 6px}
.row{display:flex;gap:8px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:9px 12px;margin-bottom:8px}
.row .rt{font-weight:600}
.block ul{list-style:none;margin:0;padding:0}
.check li{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:6px}
.check .box{width:20px;height:20px;border:2px solid var(--accent);border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;color:var(--ok);flex:none}
.check li.done .ct{text-decoration:line-through;color:var(--muted)}
.check .ct{flex:1}
.check .due{font-size:12px;color:var(--muted);white-space:nowrap}
.check li.overdue .due{color:var(--crit);font-weight:700}
.check li{cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none}
.cgroup{margin-bottom:8px}
.cgroup summary{display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-weight:700;padding:8px 4px;border-bottom:1px solid var(--line);margin-bottom:6px}
.cgroup .cg-count{font-size:12px;font-weight:400;color:var(--muted)}
.contacts li{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:6px}
.contacts .role{font-size:12px;color:var(--muted)}
.tel{font-weight:700;white-space:nowrap;text-decoration:none;border:1px solid #a8c2e3;border-radius:8px;padding:5px 9px;background:#eef4fb}
.tbc-box{background:#fbf4e7;border:1px dashed #c9b28f;border-radius:12px;padding:2px 12px 8px;margin-top:16px}
.tbc-box h2{margin-top:10px}
.tbc-box li{font-size:14px;padding:3px 0}
.tbc-box li::before{content:"? ";color:var(--warn);font-weight:700}
footer{margin-top:24px;font-size:11px;color:var(--muted);text-align:center}
.empty{color:var(--muted);font-size:14px;padding:6px 2px}
`;

// Client side: countdowns tick, "next up" moves on by itself, alerts age out, copy works over plain
// http (navigator.clipboard needs a secure context, so the app bridge and execCommand are fallbacks).
// "Today" (past days, overdue checklist items) is the phone's own date: the server's homeTz guess is
// only the first paint, and tick() runs at load.
const JS = `
(function(){
function span(ms){var m=Math.max(0,Math.round(ms/60000));if(m<60)return m+" min";var h=Math.floor(m/60);if(h<48)return h+" h "+String(m%60).padStart(2,"0")+" min";return Math.floor(h/24)+" d "+(h%24)+" h";}
function tick(){
  var now=Date.now();
  var items=[].slice.call(document.querySelectorAll(".next-item")),shown=null;
  items.forEach(function(el){var end=Date.parse(el.dataset.end);var keep=!shown&&!(end<=now);el.classList.toggle("hidden",!keep);if(keep)shown=el;});
  var none=document.getElementById("next-none");if(none)none.classList.toggle("hidden",!!shown||!items.length);
  [].slice.call(document.querySelectorAll("[data-countdown]")).forEach(function(el){
    var t=Date.parse(el.dataset.countdown);if(isNaN(t))return;var left=t-now,item=el.closest(".next-item");
    el.textContent=left>0?(el.dataset.verb||"starts")+" in "+span(left):(item&&item.dataset.kind==="flight"?"in the air":"now");
  });
  var h=document.getElementById("hcd");
  if(h&&items.length){if(shown){var s=Date.parse(shown.dataset.start),l=s-now;h.textContent=shown.dataset.label+" · "+(l>0?shown.dataset.verb+" in "+span(l):shown.dataset.kind==="flight"?"in the air":shown.dataset.verb+" now");}else h.textContent="";}
  var al=document.getElementById("alerts");
  if(al){var vis=0;[].slice.call(al.querySelectorAll(".alert")).forEach(function(a){var old=now-Date.parse(a.dataset.at)>=172800000;a.classList.toggle("hidden",old);if(!old)vis++;});al.classList.toggle("hidden",!vis);}
  var d=new Date(),today=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  [].slice.call(document.querySelectorAll(".day[data-date]")).forEach(function(el){var dd=el.dataset.date;el.classList.toggle("past",dd<today);var b=el.querySelector(".today-badge");if(b)b.classList.toggle("hidden",dd!==today);});
  [].slice.call(document.querySelectorAll(".check li[data-due]")).forEach(function(li){var due=li.dataset.due;li.classList.toggle("overdue",!!due&&!li.classList.contains("done")&&due<today);});
}
function fallbackCopy(t){
  if(window.JarvisNative&&typeof window.JarvisNative.copyText==="function"){try{window.JarvisNative.copyText(t);return true;}catch(e){}}
  try{var ta=document.createElement("textarea");ta.value=t;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();var ok=document.execCommand("copy");document.body.removeChild(ta);return ok;}catch(e){return false;}
}
function flash(btn,ok){var i=btn.querySelector(".copy-i");if(i){i.textContent=ok?"✓ copied":"copy failed";}btn.classList.toggle("done",ok);setTimeout(function(){if(i)i.textContent="⧉";btn.classList.remove("done");},1800);}
// Checklist ticks live on the device (localStorage), so a re-render of trip.html keeps them.
var CK="trip-check:";
function store(){try{return window.localStorage;}catch(e){return null;}}
function setDone(li,on){li.classList.toggle("done",on);var b=li.querySelector(".box");if(b)b.textContent=on?"✓":"";}
function recount(){[].slice.call(document.querySelectorAll(".cgroup")).forEach(function(g){var all=g.querySelectorAll(".check li"),d=g.querySelectorAll(".check li.done"),c=g.querySelector(".cg-count");if(c)c.textContent=d.length+"/"+all.length;});}
// Open/folded per section is remembered on the device too; the server's default only applies until the first tap.
var FK="trip-fold:";
(function(){var s=store();if(!s)return;[].slice.call(document.querySelectorAll(".cgroup[data-g]")).forEach(function(g){var v=s.getItem(FK+g.dataset.g);if(v!==null)g.open=v==="1";});})();
document.addEventListener("toggle",function(e){var g=e.target;if(!g.matches||!g.matches(".cgroup[data-g]"))return;var s=store();if(s){try{s.setItem(FK+g.dataset.g,g.open?"1":"0");}catch(x){}}},true);
(function(){var s=store();if(!s)return;[].slice.call(document.querySelectorAll(".check li[data-k]")).forEach(function(li){var v=s.getItem(CK+li.dataset.k);if(v!==null)setDone(li,v==="1");});recount();})();
document.addEventListener("click",function(e){
  var li=e.target.closest&&e.target.closest(".check li[data-k]");if(!li)return;
  var on=!li.classList.contains("done");setDone(li,on);var s=store();if(s){try{s.setItem(CK+li.dataset.k,on?"1":"0");}catch(x){}}
  recount();tick();
});
document.addEventListener("click",function(e){
  var btn=e.target.closest&&e.target.closest("[data-copy]");if(!btn)return;var t=btn.dataset.copy;
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(function(){flash(btn,true);},function(){flash(btn,fallbackCopy(t));});}
  else flash(btn,fallbackCopy(t));
});
tick();setInterval(tick,30000);
document.addEventListener("visibilitychange",function(){if(!document.hidden)tick();});
})();
`;

/** Pure: trip + state -> HTML string. `now` only decides the server-side first paint. */
export function renderTripHtml(rawTrip, state = {}, { now = Date.now() } = {}) {
  const trip = tripView(rawTrip);
  state = { segments: {}, ...state };
  const homeTz = trip.homeTz || "UTC";
  const updatedMs = Date.parse(trip.updatedAt ?? "") || now;
  const next = nextUpCards(trip, state, now);
  const first = next[0];
  const hcd = first
    ? `${first.label} · ${first.start > now ? `${first.verb} in ${spanLabel(first.start - now)}` : first.kind === "flight" ? "in the air" : `${first.verb} now`}`
    : "";

  const byDate = new Map();
  const undated = [];
  for (const e of timelineEntries(trip, state, now)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "")) {
      undated.push(e);
      continue;
    }
    if (!byDate.has(e.date)) {
      byDate.set(e.date, []);
    }
    byDate.get(e.date).push(e);
  }
  const today = utcToLocal(now, homeTz).date;
  const tasks = tasksByDate(trip, byDate.keys());
  for (const d of tasks.keys()) {
    if (!byDate.has(d)) {
      byDate.set(d, []);
    }
  }
  const days = [...byDate.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, entries]) => {
      entries.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      return `<div class="day${date < today ? " past" : ""}" data-date="${esc(date)}"><h3>${esc(dayLabel(date))}<span class="today-badge${date === today ? "" : " hidden"}">today</span></h3>${tasks.has(date) ? tasksHtml(tasks.get(date), today) : ""}${entries.map((e) => e.html).join("\n")}</div>`;
    })
    .join("\n");
  const undatedHtml = undated.length
    ? `<div class="day undated"><h3>Date to confirm</h3>${undated.map((e) => e.html).join("\n")}</div>`
    : "";

  const travellers = (trip.travellers ?? [])
    .map((t) => t.name)
    .filter(Boolean)
    .join(", ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#4e3b31">
<meta name="trip-rendered-at" content="${iso(now)}">
<title>${esc(trip.title || "Trip")}</title>
<style>${CSS}</style></head>
<body><main>
<header class="top"><h1>${esc(trip.title || "Trip")}</h1>
<div class="sub">updated ${esc(dayLabel(utcToLocal(updatedMs, homeTz).date))} ${esc(clock(updatedMs, homeTz))}${travellers ? ` · ${esc(travellers)}` : ""}</div>
<div class="hcd" id="hcd">${esc(hcd)}</div></header>
${alertsHtml(trip, now)}
<section class="timeline"><h2>Day by day</h2>${days || undatedHtml ? `${days}${undatedHtml}` : `<div class="empty">No segments yet.</div>`}</section>
${contactsHtml(trip)}
${questionsHtml(trip)}
<footer>Offline copy · rendered ${esc(dayLabel(utcToLocal(now, homeTz).date))} ${esc(clock(now, homeTz))}</footer>
</main><script>${JS}</script></body></html>
`;
}

/** Read TRIP_DIR, write TRIP_DIR/trip.html (or `out`) atomically. Returns the path, or null if no trip.json. */
export function renderToDir(dir = tripDir(), { out, now = Date.now() } = {}) {
  const trip = loadTrip(dir);
  if (!trip) {
    return null;
  }
  const file = out || path.join(dir, "trip.html");
  writeAtomic(file, renderTripHtml(trip, loadState(dir), { now }));
  return file;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = tripDir();
  const nowArg = arg("--now");
  const file = renderToDir(dir, {
    out: arg("--out"),
    now: nowArg ? Date.parse(nowArg) : Date.now(),
  });
  if (!file) {
    console.error(`trip-render: no trip.json in ${dir}`);
    process.exit(1);
  }
  console.log(`trip-render: wrote ${file}`);
}
