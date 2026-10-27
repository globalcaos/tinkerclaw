// FORK 2026-10-19 (the architect: phone app) — provider fallback chain with a politeness cache.
// Order: FlightStats (has belts and an explicit delay), FlightAware, AeroDataBox (only with a key).
// The first provider that recognises the flight wins. Each provider is asked at most once per flight
// per POLITE_MS; within that window the cached answer (hit or miss) is reused.
import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/trip-io.mjs";
import * as aerodatabox from "./aerodatabox.mjs";
import * as flightaware from "./flightaware.mjs";
import * as flightstats from "./flightstats.mjs";

export const PROVIDERS = [flightstats, flightaware, aerodatabox];
// Ten minutes, less a little slack: the timer fires every 10 min and the fetch lands a few seconds
// into each run, so a strict 10:00 would skip every other run.
export const POLITE_MS = 9.5 * 60_000;

export function queryFor(seg) {
  return {
    carrier: String(seg.carrier ?? "")
      .trim()
      .toUpperCase(),
    number: String(seg.number ?? "")
      .trim()
      .replace(/^0+(?=\d)/, ""),
    depDateLocal: String(seg.depLocal ?? "").slice(0, 10),
    from: seg.from?.iata ?? null,
    to: seg.to?.iata ?? null,
  };
}

/**
 * Live status for a flight segment, or null. `cacheFile` (optional) persists the politeness window.
 * Returns { status, provider, cached } or null; errors per provider are collected in `log`.
 */
export async function fetchFlightStatus(
  seg,
  {
    cacheFile,
    now = Date.now(),
    providers = PROVIDERS,
    fetchImpl,
    env = process.env,
    log = () => {},
  } = {},
) {
  const q = queryFor(seg);
  if (!q.carrier || !q.number || !/^\d{4}-\d{2}-\d{2}$/.test(q.depDateLocal)) {
    return null;
  }
  const cache = cacheFile ? (readJson(cacheFile, {}) ?? {}) : {};
  let dirty = false;
  let result = null;
  for (const p of providers) {
    if (p.enabled && !p.enabled(env)) {
      continue;
    }
    const key = `${p.name}:${q.carrier}${q.number}:${q.depDateLocal}:${q.from ?? ""}`;
    const hit = cache[key];
    let status;
    if (hit && now - Date.parse(hit.at) < POLITE_MS) {
      status = hit.status;
      if (status) {
        result = { status, provider: p.name, cached: true };
      }
    } else {
      try {
        status = await p.fetchStatus(q, { fetchImpl, env });
      } catch (err) {
        log(`${p.name}: ${err.message}`);
        status = undefined;
      }
      if (status !== undefined) {
        cache[key] = { at: new Date(now).toISOString(), status: status ?? null };
        dirty = true;
      }
      if (status) {
        result = { status, provider: p.name, cached: false };
      }
    }
    if (result) {
      break;
    }
  }
  if (cacheFile && dirty) {
    for (const [k, v] of Object.entries(cache)) {
      if (now - Date.parse(v.at) > 2 * 86_400_000) {
        delete cache[k];
      }
    }
    writeJsonAtomic(cacheFile, cache);
  }
  return result;
}

export const cachePath = (dir) => path.join(dir, "provider-cache.json");
