import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PG_ORDER_KEY,
  renderPresenceGraphsHtml,
  resetPresenceGraphStateForTests,
  type GGroup,
} from "./presence-graph.ts";
import {
  fetchTokenReport,
  tokenUsageGroup,
  weeklyRunningTotals,
  type TokenReport,
  type TokenRow,
} from "./token-users.ts";

// Sat 14, Sun 15, Mon 16, Tue 17, Wed 18 November 2026
const DAYS = ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"];
const row = (name: string, daily: number[], extra: Partial<TokenRow> = {}): TokenRow => ({
  id: name.toLowerCase(),
  name,
  status: "active",
  daily,
  ...extra,
});
const report = (rows: TokenRow[], extra: Partial<TokenReport> = {}): TokenReport => ({
  generatedAt: "2026-11-18T09:00:00.000Z",
  today: "2026-11-18",
  timeZone: "Europe/Madrid",
  reset: { weekday: 1, hour: 7 },
  days: DAYS,
  rows,
  ledger: { found: true, calls: 10, since: "2026-11-14" },
  ...extra,
});
const circles = (html: string, sid: number) =>
  new DOMParser().parseFromString(html, "text/html").querySelectorAll(`circle[data-sid="${sid}"]`)
    .length;

afterEach(() => {
  resetPresenceGraphStateForTests();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("weeklyRunningTotals", () => {
  it("adds the days up and starts again on the reset weekday", () => {
    expect(weeklyRunningTotals(DAYS, [1, 2, 4, 8, 16])).toEqual([1, 3, 4, 12, 28]);
    // a week that restarts on Wednesday instead
    expect(weeklyRunningTotals(DAYS, [1, 2, 4, 8, 16], 3)).toEqual([1, 3, 7, 15, 16]);
    expect(weeklyRunningTotals(DAYS, [])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("tokenUsageGroup", () => {
  it("draws one line per person, in the report's order: the week so far, one point per day", () => {
    const g = tokenUsageGroup(
      report([
        row("Ana", [1, 2, 4, 8, 16]),
        row("Ben", [0, 0, 0, 0, 0]),
        row("Cleo", [5, 0, 0, 0, 1], { status: "revoked" }),
      ]),
    )!;
    expect(g.key).toBe("tokens");
    expect(g.first).toBe(true);
    // the last day is a Wednesday: 2 days into this week, plus last week
    expect(g.spanDays).toBe(9);
    expect(g.accent).toBe("resets Mon 07:00");
    expect(g.series.map((s) => s.label)).toEqual(["Ana", "Ben", "Cleo (revoked)"]);
    const ana = g.series[0];
    expect(ana.points.map((p) => p.value)).toEqual([1, 3, 4, 12, 28]);
    expect(ana.cumulative).toBeUndefined(); // the weekly restart is ours; the chart must not add again
    // noon UTC of each day, so every value lands on its own calendar day
    expect(new Date(ana.points[2].ts).toISOString()).toBe("2026-11-16T12:00:00.000Z");
    // a person with no calls still has a line, flat at zero
    expect(g.series[1].points.every((p) => p.value === 0)).toBe(true);
  });

  it("takes the reset day and hour from the report", () => {
    const g = tokenUsageGroup(
      report([row("Ana", [1, 2, 4, 8, 16])], { reset: { weekday: 3, hour: 9 } }),
    )!;
    expect(g.accent).toBe("resets Wed 09:00");
    expect(g.spanDays).toBe(7); // the last day IS the reset day: last week only
    expect(g.series[0].points.map((p) => p.value)).toEqual([1, 3, 7, 15, 16]);
  });

  it("puts the agent's own owner on the right-hand axis only next to other people", () => {
    const mixed = tokenUsageGroup(
      report([row("Dan", [9, 9, 9, 9, 9], { self: true }), row("Ana", [1, 1, 1, 1, 1])]),
    )!;
    expect(mixed.series.map((s) => s.axis)).toEqual(["right", undefined]);
    const alone = tokenUsageGroup(report([row("Dan", [9, 9, 9, 9, 9], { self: true })]))!;
    expect(alone.series[0].axis).toBeUndefined();
  });

  it("has nothing to draw without people or without a ledger", () => {
    expect(tokenUsageGroup(report([]))).toBeNull();
    expect(
      tokenUsageGroup(
        report([row("Ana", [1, 1, 1, 1, 1])], { ledger: { found: false, calls: 0, since: null } }),
      ),
    ).toBeNull();
  });
});

describe("the tokens chart among the other Pulse graphs", () => {
  const other: GGroup = {
    key: "stars",
    title: "Stars",
    series: [{ id: "s", label: "s", points: [{ ts: Date.UTC(2026, 10, 16, 12), value: 1 }] }],
  };
  const order = (html: string) =>
    [...new DOMParser().parseFromString(html, "text/html").querySelectorAll(".pg-chart")].map(
      (c) => (c as HTMLElement).dataset.group,
    );

  it("comes first until the user drags the charts into an order of their own", () => {
    const tokens = tokenUsageGroup(report([row("Ana", [1, 2, 3, 4, 5])]))!;
    localStorage.setItem(PG_ORDER_KEY, JSON.stringify(["stars"]));
    expect(order(renderPresenceGraphsHtml([other, tokens]))).toEqual(["tokens", "stars"]);
    localStorage.setItem(PG_ORDER_KEY, JSON.stringify(["stars", "tokens"]));
    expect(order(renderPresenceGraphsHtml([other, tokens]))).toEqual(["stars", "tokens"]);
  });

  it("opens on last week and this one, from last week's reset day", () => {
    const days = Array.from({ length: 60 }, (_, i) =>
      new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10),
    );
    const g = tokenUsageGroup(
      report(
        [
          row(
            "Ana",
            days.map(() => 1),
          ),
        ],
        { days },
      ),
    )!;
    // 60 days from 20 Sep end on Wed 18 Nov: this week's Monday is the 16th, last week's the 9th.
    expect(days[days.length - 1]).toBe("2026-11-18");
    // a dot is drawn only for a point inside the window: Mon 9 → Wed 18, both included
    expect(circles(renderPresenceGraphsHtml([g]), 0)).toBe(10);
    expect(circles(renderPresenceGraphsHtml([{ ...g, spanDays: undefined }]), 0)).toBe(60);
  });

  it("labels its axis in billions once a week passes a billion tokens", () => {
    const big = tokenUsageGroup(report([row("Ana", [0, 0, 0, 1.5e9, 3e9])]))!;
    const html = renderPresenceGraphsHtml([big]);
    expect(html).toMatch(/>\d+(?:\.\d)?B</);
    expect(html).not.toMatch(/>\d{4,}(?:\.\d)?M</);
  });
});

describe("fetchTokenReport", () => {
  const answer = (status: number, body: unknown, json = true) =>
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (!json) {
          throw new Error("not json");
        }
        return body;
      },
    }));

  it("asks the door with the viewer's time zone and returns its report", async () => {
    const f = answer(200, report([row("Ana", [1, 1, 1, 1, 1])]));
    vi.stubGlobal("fetch", f);
    const r = await fetchTokenReport("door");
    expect(r?.rows[0].name).toBe("Ana");
    const url = String(f.mock.calls[0][0]);
    expect(url.startsWith("/tinker/door/api/usage?tz=")).toBe(true);
    expect(decodeURIComponent(url.split("tz=")[1])).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("fails loudly behind the door", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "admins only" }));
    await expect(fetchTokenReport("door")).rejects.toThrow("admins only");
  });

  it("stays silent on a page whose own server has no such route", async () => {
    vi.stubGlobal("fetch", answer(404, null, false));
    expect(await fetchTokenReport("local")).toBeNull();
    // a server that answers every path with its page (200, not a report)
    vi.stubGlobal("fetch", answer(200, { hello: "world" }));
    expect(await fetchTokenReport("local")).toBeNull();
    const f = answer(200, report([row("Dan", [1, 1, 1, 1, 1], { self: true })]));
    vi.stubGlobal("fetch", f);
    expect((await fetchTokenReport("local"))?.rows[0].self).toBe(true);
    expect(String(f.mock.calls[0][0]).startsWith("/api/usage?tz=")).toBe(true);
  });
});
