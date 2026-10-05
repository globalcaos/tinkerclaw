/**
 * Spend accounting over the verdict table (design doc §3 M5: `spend(day)` is a query over the store).
 */

import type { AmygdalaStore } from "./store.js";

export interface Spend {
  usd: number;
  eur: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  skipped: number;
}

export function spendBetween(
  store: AmygdalaStore,
  fromTs: number,
  toTs: number,
  eurPerUsd: number,
): Spend {
  const s = store.verdictSpend(fromTs, toTs);
  return {
    usd: s.usd,
    eur: s.usd * eurPerUsd,
    calls: s.calls,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    skipped: s.skipped,
  };
}

/** Offset of `tz` from UTC at instant `ts`, in ms (whole seconds). */
function tzOffsetMs(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

function localParts(ts: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

/** The UTC instant at which local wall-clock midnight of y-m-d occurs in `tz`. */
function localMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  // A second pass corrects a guess that landed on the other side of a DST change.
  t = guess - tzOffsetMs(t, tz);
  return t;
}

/** Local calendar day containing `now`: [start, end) in epoch ms. A DST-change day is 23 or 25 hours long. */
export function dayBounds(now: number, tz = "Europe/Madrid"): { start: number; end: number } {
  const p = localParts(now, tz);
  const start = localMidnight(p.y, p.m, p.d, tz);
  // Date.UTC normalises day overflow into the next month/year.
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  const end = localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz);
  return { start, end };
}

export function spendToday(
  store: AmygdalaStore,
  now: number,
  eurPerUsd: number,
  tz?: string,
): Spend {
  const { start, end } = dayBounds(now, tz);
  return spendBetween(store, start, end, eurPerUsd);
}
