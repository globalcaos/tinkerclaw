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

/** FORK 2026-10-29: the length of the panel's sliding spend window, 30 x 24 h as before (not 30 calendar days). */
const WINDOW_MS = 30 * 86_400_000;

/**
 * FORK 2026-10-29: spend over [now - 30 x 24 h, now): the rows one `spendBetween` over that range sums, without reading
 * the whole window on each call. That SUM read about 518k verdicts of a 4.15 GB store through `v_ts`, one table lookup
 * per row: about 230 ms warm and 1-1.2 s cold inside the synchronous `amygdala2.feed` (measured 2026-10-29). Split at
 * local midnights:
 * - the oldest day's part, [now - 30 x 24 h, end of that day), and today so far, [start of today, now), move with
 *   `now` and are summed live, a day of rows at most each;
 * - each whole day between them is over: the store sums it once and keeps it until a write changes it
 *   (`closedDaysSpend`).
 * Today's part stops at `now`, where `spendToday` runs to midnight: a verdict stamped later today than `now` (a replay
 * carries the exchange's own time) is outside the window. Added in another order than one SUM, the total can differ
 * from it in a float's last digit.
 */
export function spendLast30Days(
  store: AmygdalaStore,
  now: number,
  eurPerUsd: number,
  tz?: string,
): Spend {
  const from = now - WINDOW_MS;
  const oldest = dayBounds(from, tz);
  const today = dayBounds(now, tz);
  // The whole days tile [end of the oldest day, start of today) with no gap, 23 h and 25 h DST days included.
  const days: { start: number; end: number }[] = [];
  for (let at = oldest.end; at < today.start; ) {
    const end = Math.min(dayBounds(at, tz).end, today.start);
    days.push({ start: at, end });
    at = end;
  }
  const parts = [
    store.verdictSpend(from, oldest.end),
    store.closedDaysSpend(days),
    store.verdictSpend(today.start, now),
  ];
  const usd = parts.reduce((sum, p) => sum + p.usd, 0);
  return {
    usd,
    eur: usd * eurPerUsd,
    calls: parts.reduce((sum, p) => sum + p.calls, 0),
    tokensIn: parts.reduce((sum, p) => sum + p.tokensIn, 0),
    tokensOut: parts.reduce((sum, p) => sum + p.tokensOut, 0),
    skipped: parts.reduce((sum, p) => sum + p.skipped, 0),
  };
}
