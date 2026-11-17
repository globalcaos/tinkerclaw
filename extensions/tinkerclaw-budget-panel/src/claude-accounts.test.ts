import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountLabel,
  accountOfToken,
  buildReserve,
  liveAccountAt,
  readReports,
  readVault,
  rememberReport,
  stamp,
} from "./claude-accounts.js";

/**
 * Guards the reserve half of the Claude bars (FORK 2026-11-14). The case it was built for:
 * the seat keeper moved the Pi from gmail to acme at 22:33; gmail's Fable had hit its own
 * cap at 20:45 (resets Thursday 17:00), which only Thalamus' cooling file still knew.
 */

const GMAIL = "owner@gmail.com";
const WORK = "owner@acme.ai";
// local times, as the keeper writes them
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();
const NOW = at(14, 0, 30);
const SWITCH_LOG = [
  "2026-11-13 22:33:48 owner@gmail.com -> owner@acme.ai (auto chosen by hand)",
  "2026-11-13 22:40:48 exchange-laptop: owner@gmail.com login from the laptop now on the Pi",
].join("\n");
const THU_17 = at(19, 17, 0);

const temps: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "claude-accounts-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("accountLabel", () => {
  it("names an account by its mail domain", () => {
    expect(accountLabel(GMAIL)).toBe("gmail");
    expect(accountLabel(WORK)).toBe("acme");
  });
});

describe("liveAccountAt", () => {
  it("before the first switch: its source; after it: its target", () => {
    expect(liveAccountAt(SWITCH_LOG, at(13, 20, 45))).toBe(GMAIL);
    expect(liveAccountAt(SWITCH_LOG, at(13, 23, 0))).toBe(WORK);
  });
  it("lines that are not switches are ignored; no switch at all is unknown", () => {
    expect(liveAccountAt("2026-11-13 22:40:48 exchange-laptop: x", at(13, 23, 0))).toBeUndefined();
    expect(liveAccountAt("", NOW)).toBeUndefined();
  });
});

describe("stamp", () => {
  it("the time of day within 20 hours, the weekday before that", () => {
    expect(stamp(at(13, 23, 34), NOW)).toBe("23:34");
    expect(stamp(at(12, 9, 5), NOW)).toBe("Thu 09:05");
  });
});

describe("buildReserve", () => {
  const base = {
    live: WORK,
    accounts: [GMAIL, WORK],
    readings: {},
    reports: {},
    cooling: {},
    switchLog: SWITCH_LOG,
    now: NOW,
  };

  it("CONTROL: one account, or no live account, has no reserve", () => {
    expect(buildReserve({ ...base, accounts: [WORK] })).toBeUndefined();
    expect(buildReserve({ ...base, live: undefined })).toBeUndefined();
  });

  it("CONTROL: nothing known of the other account is no reserve, not a fabricated 0 %", () => {
    expect(buildReserve(base)).toBeUndefined();
  });

  it("the night it was built for: gmail's week from the keeper, its Fable spent from the cooling file", () => {
    const r = buildReserve({
      ...base,
      readings: {
        [GMAIL]: {
          utilization: 0.66,
          resetsAt: THU_17 / 1000,
          status: "allowed",
          at: at(13, 23, 34) / 1000,
        },
        [WORK]: {
          utilization: 0.52,
          resetsAt: at(14, 7, 0) / 1000,
          status: "allowed",
          at: at(13, 23, 34) / 1000,
        },
      },
      cooling: {
        "model:fable": {
          until: THU_17,
          since: at(13, 20, 45),
          detail: "You've hit your Fable limit",
        },
      },
    });
    expect(r).toEqual({
      account: GMAIL,
      label: "gmail",
      limits: {
        seven_day: { utilization: 66, resets_at: new Date(THU_17).toISOString() },
        scoped: { fable: { utilization: 100, resets_at: new Date(THU_17).toISOString() } },
      },
      notes: { seven_day: "read 23:34", scoped: { fable: "limit hit 20:45" } },
    });
  });

  it("a limit filed while the live account was in use is not pinned on the reserve", () => {
    const r = buildReserve({
      ...base,
      readings: { [GMAIL]: { utilization: 0.1, resetsAt: THU_17 / 1000, at: NOW / 1000 } },
      cooling: { "model:fable": { until: THU_17, since: at(13, 23, 50) } },
    });
    expect(r?.limits.scoped).toBeUndefined();
  });

  it("a stored report fills the windows the keeper does not read, until they reset", () => {
    const r = buildReserve({
      ...base,
      reports: {
        [GMAIL]: {
          fetchedAt: at(13, 21, 2),
          limits: {
            seven_day: { utilization: 62, resets_at: new Date(THU_17).toISOString() },
            scoped: {
              fable: { utilization: 100, resets_at: new Date(THU_17).toISOString() },
              gone: { utilization: 90, resets_at: new Date(at(13, 23, 0)).toISOString() },
            },
          },
        },
      },
    });
    expect(r?.limits.seven_day?.utilization).toBe(62);
    expect(r?.notes.seven_day).toBe("as of 21:02");
    expect(r?.limits.scoped).toEqual({
      fable: { utilization: 100, resets_at: new Date(THU_17).toISOString() },
    });
  });

  it("the keeper's week outranks a stored report, and a reading past its reset is a fresh week", () => {
    const r = buildReserve({
      ...base,
      readings: {
        [GMAIL]: { utilization: 0.9, resetsAt: at(13, 7, 0) / 1000, at: at(13, 6, 0) / 1000 },
      },
      reports: {
        [GMAIL]: {
          fetchedAt: at(12, 9, 0),
          limits: { seven_day: { utilization: 80, resets_at: null } },
        },
      },
    });
    expect(r?.limits.seven_day).toEqual({ utilization: 0, resets_at: null });
  });

  it("a 5-hour window the keeper kept rides along while it is open", () => {
    const r = buildReserve({
      ...base,
      readings: {
        [GMAIL]: {
          utilization: 0.3,
          resetsAt: THU_17 / 1000,
          at: NOW / 1000,
          fiveHour: { utilization: 0.4, resetsAt: at(14, 3, 0) / 1000 },
        },
      },
    });
    expect(r?.limits.five_hour?.utilization).toBe(40);
  });

  it("with several other accounts the reserve is the one whose week resets first", () => {
    const third = "x@third.example";
    const r = buildReserve({
      ...base,
      accounts: [GMAIL, WORK, third],
      readings: {
        [GMAIL]: { utilization: 0.2, resetsAt: THU_17 / 1000, at: NOW / 1000 },
        [third]: { utilization: 0.2, resetsAt: at(15, 9, 0) / 1000, at: NOW / 1000 },
      },
    });
    expect(r?.account).toBe(third);
  });
});

describe("files", () => {
  it("rememberReport keeps the newest report per account", () => {
    const file = join(tempDir(), "deep", "claude-accounts.json");
    const limits = { seven_day: { utilization: 10, resets_at: null } };
    rememberReport(file, GMAIL, limits, 2000);
    rememberReport(file, GMAIL, { seven_day: { utilization: 5, resets_at: null } }, 1000);
    rememberReport(file, WORK, limits, 3000);
    expect(readReports(file)).toEqual({
      [GMAIL]: { limits, fetchedAt: 2000 },
      [WORK]: { limits, fetchedAt: 3000 },
    });
  });

  it("a report is credited only when its token is the one in Claude Code's login file", () => {
    const home = tempDir();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-live" } }),
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: WORK } }),
    );
    expect(accountOfToken("tok-live", home)).toBe(WORK);
    expect(accountOfToken("tok-old", home)).toBeUndefined();
    expect(accountOfToken(null, home)).toBeUndefined();
  });

  it("an install with no keeper has no vault: no accounts, nothing read", () => {
    expect(readVault(join(tempDir(), "missing"))).toEqual({
      accounts: [],
      readings: {},
      switchLog: "",
    });
  });

  it("the vault lists one account per e-mail folder", () => {
    const dir = tempDir();
    mkdirSync(join(dir, GMAIL));
    mkdirSync(join(dir, WORK));
    writeFileSync(join(dir, "readings.json"), JSON.stringify({ [GMAIL]: { utilization: 0.5 } }));
    writeFileSync(join(dir, "switch.log"), SWITCH_LOG);
    expect(readVault(dir)).toEqual({
      accounts: [WORK, GMAIL].sort(),
      readings: { [GMAIL]: { utilization: 0.5 } },
      switchLog: SWITCH_LOG,
    });
  });
});
