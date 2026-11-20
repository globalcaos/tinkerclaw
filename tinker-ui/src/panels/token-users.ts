// FORK 2026-11-18 (requested: in the left HUD with the graphs, a graph comparing the model tokens
// the other people spent; then a time graph with a coloured line per person, like the other Pulse
// graphs; 2026-11-20: cumulative, starting again every Monday at 07:00, and the same chart on the
// owner's own agent with his own use next to the others').
//
// The "Tokens per person" chart in the Graphs section of the 🎯 HUD's Pulse tab, drawn by the same
// renderer as every other Pulse graph (presence-graph.ts): one coloured line per person, one point
// per day, zoom, pan, hover and the shared time link. Each line is the person's RUNNING TOTAL OF
// THE WEEK: it climbs as they spend and starts again on the report's reset day (Monday, 07:00 on
// the viewer's clock), so the right end is "this week so far". The chart opens on last week and
// this one, from last week's reset day, so no older week's peak sets the scale; zooming out
// reaches the older weeks. The owner chose this over tokens per day (spiky: on
// the first host one person's days swung between 0 and 109 M) and over a 7-day sum.
//
// Data, by where the page runs:
//   - behind the hive door, for an admin: /tinker/door/api/usage (scripts/hive-door/usage.mjs).
//     The admin looking is left out; every active person has a line, also at zero.
//   - with no door (one person's own agent): /api/usage on the page's own server, when that server
//     has it. Its report marks the owner's row `self`; next to other people's rows that line goes on
//     the right-hand axis, because one person's whole agent can spend a hundred times what a
//     colleague types into a shared one, and on one scale the others would lie flat.

import type { GGroup } from "./presence-graph.ts";

export type TokenRow = {
  id: string;
  name: string;
  status: string | null;
  /** Tokens on each day of `days`. */
  daily: number[];
  /** The owner of the agent the page runs on (single-user mode). */
  self?: boolean;
};
export type TokenReport = {
  generatedAt: string;
  today: string;
  timeZone?: string;
  /** When a running total starts again: weekday 0 Sunday … 6 Saturday, and the hour the day starts. */
  reset?: { weekday: number; hour: number };
  days: string[];
  rows: TokenRow[];
  ledger: { found: boolean; calls: number; since: string | null };
};

const DEFAULT_RESET = { weekday: 1, hour: 7 };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The report for this page. "door": the hive door's admin route; a failure throws. "local": the
 * page's own server; a server without the route (any answer that is not a report) is simply
 * `null`, so a host that never had it shows no chart and logs nothing.
 */
export async function fetchTokenReport(source: "door" | "local"): Promise<TokenReport | null> {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = source === "door" ? "/tinker/door/api/usage" : "/api/usage";
  const res = await fetch(`${base}?tz=${encodeURIComponent(zone)}`, { credentials: "same-origin" });
  const json = (await res.json().catch(() => null)) as (TokenReport & { error?: string }) | null;
  const isReport = Boolean(json && Array.isArray(json.rows) && Array.isArray(json.days));
  if (res.ok && isReport) {
    return json;
  }
  if (source === "local") {
    return null;
  }
  throw new Error(json?.error || (res.ok ? "not a usage report" : `HTTP ${res.status}`));
}

/** Noon UTC of a "YYYY-MM-DD" day: the graph files one point per UTC day, and noon keeps the date. */
function dayTs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

/** For each day, the sum since the last `resetWeekday` (that day included): the week so far. */
export function weeklyRunningTotals(days: string[], daily: number[], resetWeekday = 1): number[] {
  let run = 0;
  return days.map((day, i) => {
    if (new Date(dayTs(day)).getUTCDay() === resetWeekday) {
      run = 0;
    }
    run += daily[i] ?? 0;
    return run;
  });
}

/**
 * The report as one Pulse graph: a line per person in the report's order (the order people were
 * added, so a person keeps their colour). null when there is nothing to draw.
 */
export function tokenUsageGroup(report: TokenReport): GGroup | null {
  if (!report.ledger.found || !report.rows.length || !report.days.length) {
    return null;
  }
  const reset = report.reset ?? DEFAULT_RESET;
  const others = report.rows.some((r) => !r.self);
  // Days since this week's reset day (0 on the day itself), plus the week before it.
  const lastDay = new Date(dayTs(report.days[report.days.length - 1])).getUTCDay();
  const spanDays = ((lastDay - reset.weekday + 7) % 7) + 7;
  return {
    key: "tokens",
    title: "Tokens per person",
    accent: `resets ${WEEKDAYS[reset.weekday] ?? "Mon"} ${String(reset.hour).padStart(2, "0")}:00`,
    first: true,
    spanDays,
    series: report.rows.map((r) => {
      const totals = weeklyRunningTotals(report.days, r.daily, reset.weekday);
      return {
        id: `tokens.${r.id}`,
        label: r.status && r.status !== "active" ? `${r.name} (${r.status})` : r.name,
        points: report.days.map((day, i) => ({ ts: dayTs(day), value: totals[i] })),
        ...(r.self && others ? { axis: "right" as const } : {}),
      };
    }),
  };
}
