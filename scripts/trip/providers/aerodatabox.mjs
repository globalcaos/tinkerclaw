// FORK 2026-10-19 (the architect: phone app) — AeroDataBox (RapidAPI), OFF unless AERODATABOX_KEY is set.
// Kept as the last link of the chain in case both public pages change shape mid-trip. Not verified
// live: there is no key on this machine. Endpoint: GET /flights/number/{ident}/{date} (local date).
import { blankStatus, isoOrNull, scheduledOrDelayed, strOrNull } from "./common.mjs";

export const name = "aerodatabox";

export const enabled = (env = process.env) => Boolean(env.AERODATABOX_KEY);

const utc = (t) => isoOrNull(t?.utc ? String(t.utc).replace(" ", "T").replace(/Z?$/, "Z") : null);

/** API JSON (array of legs) -> trip-state segment, or null. */
export function parse(json, { from } = {}) {
  const legs = Array.isArray(json) ? json : [];
  const leg = legs.find((l) => !from || l.departure?.airport?.iata === from);
  if (!leg) {
    return null;
  }
  const s = blankStatus(name);
  const d = leg.departure ?? {};
  const a = leg.arrival ?? {};
  s.schedDep = utc(d.scheduledTime);
  s.schedArr = utc(a.scheduledTime);
  s.actDep =
    utc(d.runwayTime) ??
    (/Departed|EnRoute|Arrived|Landed/i.test(leg.status ?? "") ? utc(d.revisedTime) : null);
  s.estDep = s.actDep ? null : utc(d.revisedTime);
  s.actArr = /Arrived|Landed/i.test(leg.status ?? "")
    ? (utc(a.runwayTime) ?? utc(a.revisedTime))
    : null;
  s.estArr = s.actArr ? null : (utc(a.predictedTime) ?? utc(a.revisedTime));
  s.depTerminal = strOrNull(d.terminal);
  s.depGate = strOrNull(d.gate);
  s.arrTerminal = strOrNull(a.terminal);
  s.arrGate = strOrNull(a.gate);
  s.baggage = strOrNull(a.baggageBelt);
  const st = String(leg.status ?? "").toLowerCase();
  if (st.includes("cancel")) {
    s.status = "cancelled";
  } else if (st.includes("divert")) {
    s.status = "diverted";
  } else if (st === "arrived" || st === "landed") {
    s.status = "landed";
  } else if (st === "departed" || st === "enroute" || st === "approaching") {
    s.status = "departed";
  } else if (st === "boarding" || st === "gateclosed") {
    s.status = "boarding";
  } else {
    s.status = scheduledOrDelayed(s);
  }
  return s;
}

export async function fetchStatus(q, { fetchImpl = fetch, env = process.env } = {}) {
  if (!enabled(env)) {
    return null;
  }
  const res = await fetchImpl(
    `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(q.carrier + q.number)}/${q.depDateLocal}?withAircraftImage=false&withLocation=false`,
    {
      headers: {
        "x-rapidapi-key": env.AERODATABOX_KEY,
        "x-rapidapi-host": "aerodatabox.p.rapidapi.com",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (res.status === 204) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`aerodatabox HTTP ${res.status}`);
  }
  return parse(await res.json(), q);
}
