// FORK 2026-10-19 (the architect: phone app) — FlightStats public flight-tracker page, no key.
// The page is a Next.js app; the server inlines the whole flight as `__NEXT_DATA__ = {...}` in a
// script tag (props.initialState.flightTracker.flight). Verified 2026-10-19 on live transatlantic
// flights: one scheduled, one landed, one in the air. robots.txt allows /v2/flight-tracker/.
// It is the first choice because it carries the baggage belt and an explicit delay.
import { blankStatus, fetchText, isoOrNull, scheduledOrDelayed, strOrNull } from "./common.mjs";

export const name = "flightstats";

export function url({ carrier, number, depDateLocal }) {
  const [y, m, d] = depDateLocal.split("-").map(Number);
  return `https://www.flightstats.com/v2/flight-tracker/${encodeURIComponent(carrier)}/${encodeURIComponent(number)}?year=${y}&month=${m}&date=${d}`;
}

export function extractNextData(html) {
  const start = html.indexOf("__NEXT_DATA__ = ");
  if (start < 0) {
    return null;
  }
  const from = start + "__NEXT_DATA__ = ".length;
  let end = html.indexOf(";__NEXT_LOADED_PAGES__", from);
  if (end < 0) {
    end = html.indexOf("</script>", from);
  }
  if (end < 0) {
    return null;
  }
  try {
    return JSON.parse(html.slice(from, end).trim().replace(/;$/, ""));
  } catch {
    return null;
  }
}

/** Page HTML -> trip-state segment, or null when the page is not that flight on that day/route. */
export function parse(html, { from, to, depDateLocal } = {}) {
  const data = extractNextData(html);
  const f = data?.props?.initialState?.flightTracker?.flight;
  if (!f || !f.flightId || !f.schedule) {
    return null;
  }
  const dep = f.departureAirport ?? {};
  const arr = f.arrivalAirport ?? {};
  if (from && dep.iata && dep.iata !== from) {
    return null;
  }
  if (to && arr.iata && arr.iata !== to && !f.status?.diverted) {
    return null;
  }
  if (depDateLocal && !String(f.schedule.scheduledDeparture ?? "").startsWith(depDateLocal)) {
    return null;
  }

  const sc = f.schedule;
  const note = f.flightNote ?? {};
  const st = f.status ?? {};
  const s = blankStatus(name);
  s.schedDep = isoOrNull(sc.scheduledDepartureUTC);
  s.schedArr = isoOrNull(sc.scheduledArrivalUTC);
  const depIso = isoOrNull(sc.estimatedActualDepartureUTC);
  const arrIso = isoOrNull(sc.estimatedActualArrivalUTC);
  if (sc.estimatedActualDepartureTitle === "Actual") {
    s.actDep = depIso;
  } else {
    s.estDep = depIso;
  }
  if (sc.estimatedActualArrivalTitle === "Actual") {
    s.actArr = arrIso;
  } else {
    s.estArr = arrIso;
  }
  s.depTerminal = strOrNull(dep.terminal);
  s.depGate = strOrNull(dep.gate);
  s.arrTerminal = strOrNull(arr.terminal);
  s.arrGate = strOrNull(arr.gate);
  s.baggage = strOrNull(arr.baggage);

  const code = st.statusCode;
  if (note.canceled || code === "C") {
    s.status = "cancelled";
  } else if (st.diverted || code === "D" || code === "R") {
    s.status = "diverted";
  } else if (note.landed || code === "L") {
    s.status = "landed";
  } else if (code === "A" || note.hasDepartedGate || note.hasDepartedRunway) {
    s.status = "departed";
  } else if (code === "S") {
    s.status = scheduledOrDelayed(s);
  } else {
    s.status = "unknown";
  }
  if (s.status === "scheduled" && (st.delay?.departure?.minutes ?? 0) >= 15) {
    s.status = "delayed";
  }
  return s;
}

export async function fetchStatus(q, opts = {}) {
  return parse(await fetchText(url(q), opts), q);
}
