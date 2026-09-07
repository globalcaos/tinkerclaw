import { describe, it, expect } from "vitest";
import { buildSchedule, humanizeSchedule, parseSchedule } from "./cron-schedule";

describe("parseSchedule", () => {
  it("reads the daily 06:00 Madrid jobs as daily + time", () => {
    const v = parseSchedule({ kind: "cron", expr: "0 6 * * *", tz: "Europe/Madrid" });
    expect(v).toMatchObject({ repeat: "daily", time: "06:00", tz: "Europe/Madrid" });
  });

  it("reads Sunday 10:00 as weekly", () => {
    const v = parseSchedule({ kind: "cron", expr: "0 10 * * 0", tz: "Europe/Madrid" });
    expect(v).toMatchObject({ repeat: "weekly", time: "10:00", weekday: 0 });
  });

  it("reads everyMs as interval minutes", () => {
    const v = parseSchedule({ kind: "every", everyMs: 15 * 60_000 });
    expect(v).toMatchObject({ repeat: "interval", intervalMin: 15 });
  });

  it("falls back to raw cron for anything else", () => {
    const v = parseSchedule({ kind: "cron", expr: "15 4 1 * *" });
    expect(v.repeat).toBe("cron");
    expect(v.expr).toBe("15 4 1 * *");
  });
});

describe("buildSchedule", () => {
  it("daily 06:00 → 0 6 * * *", () => {
    expect(
      buildSchedule({
        repeat: "daily",
        time: "06:00",
        weekday: 0,
        intervalMin: 15,
        expr: "",
        tz: "Europe/Madrid",
      }),
    ).toEqual({ kind: "cron", expr: "0 6 * * *", tz: "Europe/Madrid" });
  });

  it("weekly Thu 08:02 → 2 8 * * 4", () => {
    expect(
      buildSchedule({
        repeat: "weekly",
        time: "08:02",
        weekday: 4,
        intervalMin: 15,
        expr: "",
        tz: "Europe/Madrid",
      }),
    ).toEqual({ kind: "cron", expr: "2 8 * * 4", tz: "Europe/Madrid" });
  });

  it("interval 15 → everyMs", () => {
    expect(
      buildSchedule({
        repeat: "interval",
        time: "00:00",
        weekday: 0,
        intervalMin: 15,
        expr: "",
        tz: "Europe/Madrid",
      }),
    ).toEqual({ kind: "every", everyMs: 900_000 });
  });

  it("rejects a 4-field cron expr", () => {
    const r = buildSchedule({
      repeat: "cron",
      time: "06:00",
      weekday: 0,
      intervalMin: 15,
      expr: "* * * *",
      tz: "Europe/Madrid",
    });
    expect(r).toHaveProperty("error");
  });

  it("round-trips every live-shaped daily/weekly job", () => {
    for (const expr of ["0 6 * * *", "30 22 * * *", "0 10 * * 0", "2 8 * * 4"]) {
      const parsed = parseSchedule({ kind: "cron", expr, tz: "Europe/Madrid" });
      const built = buildSchedule(parsed);
      expect(built).toEqual({ kind: "cron", expr, tz: "Europe/Madrid" });
    }
  });
});

describe("humanizeSchedule", () => {
  it("names daily and weekly in plain language", () => {
    expect(humanizeSchedule({ kind: "cron", expr: "0 6 * * *", tz: "Europe/Madrid" })).toBe(
      "06:00 daily",
    );
    expect(humanizeSchedule({ kind: "cron", expr: "0 10 * * 0", tz: "Europe/Madrid" })).toBe(
      "10:00 Sun",
    );
    expect(humanizeSchedule({ kind: "every", everyMs: 900_000 })).toBe("every 15 min");
  });
});
