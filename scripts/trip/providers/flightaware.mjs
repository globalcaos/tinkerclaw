import { utcToLocal } from "../lib/time.mjs";
// FORK 2026-10-19 (the architect: phone app) — FlightAware public flight page, no key.
// /live/flight/<ICAO ident> inlines `var trackpollBootstrap = {...};` with the current leg plus an
// activityLog of recent and upcoming days (each with gates, terminals, scheduled/estimated/actual
// epochs). Verified 2026-10-19 on live flights: one with upcoming days listed, one airborne.
// robots.txt only disallows /live/flight/id/. The IATA ident is ambiguous here ("LH454" resolved to an
// unrelated 2017 flight), so the airline's ICAO code is used when known; the date + origin match below
// rejects any wrong flight either way. No baggage belt on this page.
import { blankStatus, fetchText, isoOrNull, scheduledOrDelayed, strOrNull } from "./common.mjs";

export const name = "flightaware";

// IATA -> ICAO for airlines likely on a Spain <-> USA trip. Unknown carriers fall back to IATA.
export const ICAO = {
  UA: "UAL",
  AA: "AAL",
  DL: "DAL",
  AS: "ASA",
  WN: "SWA",
  B6: "JBU",
  F9: "FFT",
  NK: "NKS",
  HA: "HAL",
  AC: "ACA",
  IB: "IBE",
  I2: "IBS",
  UX: "AEA",
  VY: "VLG",
  LH: "DLH",
  BA: "BAW",
  AF: "AFR",
  KL: "KLM",
  LX: "SWR",
  TP: "TAP",
  EI: "EIN",
  AY: "FIN",
  SK: "SAS",
  OS: "AUA",
  SN: "BEL",
  AZ: "ITY",
  LO: "LOT",
  TK: "THY",
  QR: "QTR",
  EK: "UAE",
  EY: "ETD",
  DY: "NOZ",
  D8: "IBK",
  FR: "RYR",
  U2: "EZY",
  V7: "VOE",
  LV: "LVL",
  G3: "GLO",
  AM: "AMX",
  AV: "AVA",
  CM: "CMP",
  LA: "LAN",
  WS: "WJA",
  SY: "SCX",
  G4: "AAY",
};

export function url({ carrier, number }) {
  const ident = `${ICAO[String(carrier).toUpperCase()] ?? carrier}${number}`;
  return `https://www.flightaware.com/live/flight/${encodeURIComponent(ident)}`;
}

export function extractBootstrap(html) {
  const m = /var trackpollBootstrap = (\{.*?\});\s*<\/script>/s.exec(html);
  if (!m) {
    return null;
  }
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const tzOf = (ap) => String(ap?.TZ ?? "").replace(/^:/, "") || "UTC";

/** Page HTML -> trip-state segment for the leg leaving `from` on local date `depDateLocal`, or null. */
export function parse(html, { from, depDateLocal } = {}) {
  const data = extractBootstrap(html);
  const main = data?.flights ? Object.values(data.flights)[0] : null;
  if (!main) {
    return null;
  }
  const legs = [main, ...(main.activityLog?.flights ?? [])];
  const leg = legs.find((l) => {
    if (from && l.origin?.iata && l.origin.iata !== from) {
      return false;
    }
    const sched = l.gateDepartureTimes?.scheduled ?? l.takeoffTimes?.scheduled;
    if (!sched) {
      return false;
    }
    return !depDateLocal || utcToLocal(sched * 1000, tzOf(l.origin)).date === depDateLocal;
  });
  if (!leg) {
    return null;
  }

  const s = blankStatus(name);
  const gd = leg.gateDepartureTimes ?? {};
  const ga = leg.gateArrivalTimes ?? {};
  const to = leg.takeoffTimes ?? {};
  const ld = leg.landingTimes ?? {};
  s.schedDep = isoOrNull(gd.scheduled ?? to.scheduled);
  s.schedArr = isoOrNull(ga.scheduled ?? ld.scheduled);
  s.actDep = isoOrNull(gd.actual ?? to.actual);
  s.estDep = s.actDep ? null : isoOrNull(gd.estimated ?? to.estimated);
  s.actArr = isoOrNull(ga.actual ?? ld.actual);
  s.estArr = s.actArr ? null : isoOrNull(ga.estimated ?? ld.estimated);
  s.depTerminal = strOrNull(leg.origin?.terminal);
  s.depGate = strOrNull(leg.origin?.gate);
  s.arrTerminal = strOrNull(leg.destination?.terminal);
  s.arrGate = strOrNull(leg.destination?.gate);

  const fs = String(leg.flightStatus ?? "").toLowerCase();
  if (leg.cancelled || fs === "cancelled") {
    s.status = "cancelled";
  } else if (leg.diverted || fs === "diverted") {
    s.status = "diverted";
  } else if (fs === "arrived" || fs === "landed" || s.actArr) {
    s.status = "landed";
  } else if (
    fs === "airborne" ||
    fs === "en route" ||
    fs === "departed" ||
    fs === "taxiing" ||
    s.actDep
  ) {
    s.status = "departed";
  } else if (leg.resultUnknown) {
    s.status = "unknown";
  } else {
    s.status = scheduledOrDelayed(s);
  }
  return s;
}

export async function fetchStatus(q, opts = {}) {
  return parse(await fetchText(url(q), opts), q);
}
