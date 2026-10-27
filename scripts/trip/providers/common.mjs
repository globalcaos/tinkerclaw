// FORK 2026-10-19 (the architect: phone app) — shared bits for the flight-status providers.

export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** GET a public page as a normal browser would; throws on non-2xx. */
export async function fetchText(url, { fetchImpl = fetch, timeoutMs = 20_000, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      ...headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/** Empty trip-state segment, every field the renderer and the watcher read. */
export function blankStatus(source) {
  return {
    status: "unknown",
    schedDep: null,
    schedArr: null,
    estDep: null,
    actDep: null,
    estArr: null,
    actArr: null,
    depTerminal: null,
    depGate: null,
    arrTerminal: null,
    arrGate: null,
    baggage: null,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

export const isoOrNull = (v) => {
  if (v == null || v === "") {
    return null;
  }
  const ms = typeof v === "number" ? v * 1000 : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export const strOrNull = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());

/** Delay status from scheduled vs estimated/actual departure, in the shared vocabulary. */
export function scheduledOrDelayed(s) {
  const sched = Date.parse(s.schedDep ?? "");
  const est = Date.parse(s.actDep ?? s.estDep ?? "");
  if (Number.isFinite(sched) && Number.isFinite(est) && est - sched >= 15 * 60_000) {
    return "delayed";
  }
  return "scheduled";
}
