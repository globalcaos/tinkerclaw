// FORK 2026-11-14 (the architect, 00:18): the MODELS panel shows BOTH Claude subscriptions. Each Claude
// row's bars split in two halves: the top half is the account the Pi uses now (in auto mode, the
// one whose week resets first), the lower half the other one, kept in reserve for a switch or a
// 5-hour limit. The hover lists both (00:19).
//
// WHERE THE RESERVE'S NUMBERS COME FROM. No extra call to Anthropic. The seat keeper
// (~/.openclaw/workspace/scripts/claude-seat-vault.py, unit claude-seat-keep) already reads every
// account's week from a one-word call every 30 minutes and keeps it in
// ~/.config/claude-seats/readings.json; reading the usage page with a second login while a burner
// runs on that account gets the burner HTTP 429 (recipe claude-seats). A model's own weekly cap
// (Fable's half of the week) is not in that reading: Claude Code's rate-limit line carries only the
// 5-hour, 7-day and overage windows. So it comes from:
//   1. the last usage report this plugin fetched while that account was in use, kept per account
//      (`rememberReport`), until its window resets;
//   2. a model limit Thalamus filed (thalamus-cooling.json, `model:<family>`), credited to the
//      account in use when it was filed (the keeper's switch.log).
// An install with no keeper has no vault folder: no reserve, and the panel draws as before.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type UsageWin = { utilization: number; resets_at: string | null };

/** The shape `buildClaudeProfile` sends the page, utilization in percent. */
export type AccountLimits = {
  five_hour?: UsageWin;
  seven_day?: UsageWin;
  seven_day_sonnet?: UsageWin;
  scoped?: Record<string, UsageWin>;
};

/** One account in the keeper's readings.json: its week as a fraction 0..1, times in epoch seconds. */
export type KeeperReading = {
  utilization?: number;
  resetsAt?: number;
  status?: string;
  at?: number;
  /** A keeper that also keeps the 5-hour window writes it here (absent when none is open). */
  fiveHour?: { utilization?: number; resetsAt?: number; status?: string };
};

export type StoredReport = { limits: AccountLimits; fetchedAt: number };

/** One entry of Thalamus' cooling file; only `model:<family>` keys are read here. */
export type CoolingEntry = { until?: number; since?: number; detail?: string };

export type ClaudeReserve = {
  account: string;
  label: string;
  limits: AccountLimits;
  /** Where each figure comes from and how old it is, printed after its percentage on the hover. */
  notes: { five_hour?: string; seven_day?: string; scoped?: Record<string, string> };
};

export const VAULT_DIR = join(homedir(), ".config", "claude-seats");

/** "owner@gmail.com" → "gmail"; "owner@acme.ai" → "acme". */
export function accountLabel(email: string): string {
  const domain = email.split("@")[1] ?? "";
  return domain.split(".")[0] || email;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "23:34" for a time within the last 20 hours, else "Fri 23:34" (gateway local time). */
export function stamp(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return now - ms < 20 * 3_600_000 ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

const SWITCH_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (\S+@\S+) -> (\S+@\S+)/;

/**
 * The account in use at `tMs`, from the keeper's switch.log (local time, one
 * "<date> <time> <from> -> <to> (why)" line per switch, oldest first): the target of the last
 * switch at or before `tMs`, else the source of the first switch after it. Undefined with no
 * switch line at all.
 */
export function liveAccountAt(log: string, tMs: number): string | undefined {
  let before: string | undefined;
  let after: string | undefined;
  for (const line of log.split("\n")) {
    const m = SWITCH_LINE.exec(line);
    if (!m) {
      continue;
    }
    const t = new Date(`${m[1]}T${m[2]}`).getTime();
    if (!Number.isFinite(t)) {
      continue;
    }
    if (t <= tMs) {
      before = m[4];
    } else if (!after) {
      after = m[3];
    }
  }
  return before ?? after;
}

const alive = (w: UsageWin | undefined, now: number): w is UsageWin =>
  !!w && typeof w.utilization === "number" && (!w.resets_at || Date.parse(w.resets_at) > now);

const isoOfSeconds = (s: number): string => new Date(s * 1000).toISOString();

/**
 * The reserve account's windows, or undefined when there is no second account or nothing is
 * known of it. With more than one other account, the reserve is the one whose week resets first
 * (the keeper's own order). Pure: every input is passed in.
 */
export function buildReserve(input: {
  live: string | undefined;
  accounts: readonly string[];
  readings: Readonly<Record<string, KeeperReading | undefined>>;
  reports: Readonly<Record<string, StoredReport | undefined>>;
  cooling: Readonly<Record<string, CoolingEntry | undefined>>;
  switchLog: string;
  now: number;
}): ClaudeReserve | undefined {
  const { live, now } = input;
  if (!live) {
    return undefined;
  }
  const others = input.accounts.filter((a) => a !== live);
  if (others.length === 0) {
    return undefined;
  }
  const resetOf = (a: string): number => {
    const r = input.readings[a]?.resetsAt;
    return typeof r === "number" && r * 1000 > now ? r : Number.POSITIVE_INFINITY;
  };
  const account = [...others].sort((a, b) => resetOf(a) - resetOf(b))[0];
  const limits: AccountLimits = {};
  const notes: ClaudeReserve["notes"] = {};

  // 1. What was last known while it was in use, for the windows that have not reset since.
  const report = input.reports[account];
  if (report?.limits) {
    const asOf = `as of ${stamp(report.fetchedAt, now)}`;
    const l = report.limits;
    if (alive(l.five_hour, now)) {
      limits.five_hour = l.five_hour;
      notes.five_hour = asOf;
    }
    if (alive(l.seven_day, now)) {
      limits.seven_day = l.seven_day;
      notes.seven_day = asOf;
    }
    if (alive(l.seven_day_sonnet, now)) {
      limits.seven_day_sonnet = l.seven_day_sonnet;
    }
    for (const [family, w] of Object.entries(l.scoped ?? {})) {
      if (alive(w, now)) {
        (limits.scoped ??= {})[family] = w;
        (notes.scoped ??= {})[family] = asOf;
      }
    }
  }

  // 2. The keeper's reading of the week (and 5-hour window, when it keeps one) is newer than any
  // stored report. A reading from before its reset counts as a fresh week, as in the keeper.
  const kr = input.readings[account];
  if (kr && typeof kr.utilization === "number") {
    const passed = typeof kr.resetsAt === "number" && kr.resetsAt * 1000 <= now;
    limits.seven_day = {
      utilization: passed ? 0 : Math.round(kr.utilization * 100),
      resets_at: passed || typeof kr.resetsAt !== "number" ? null : isoOfSeconds(kr.resetsAt),
    };
    if (typeof kr.at === "number") {
      notes.seven_day = `read ${stamp(kr.at * 1000, now)}`;
    }
    const fh = kr.fiveHour;
    if (
      fh &&
      typeof fh.utilization === "number" &&
      typeof fh.resetsAt === "number" &&
      fh.resetsAt * 1000 > now
    ) {
      limits.five_hour = {
        utilization: Math.round(fh.utilization * 100),
        resets_at: isoOfSeconds(fh.resetsAt),
      };
      if (typeof kr.at === "number") {
        notes.five_hour = `read ${stamp(kr.at * 1000, now)}`;
      }
    }
  }

  // 3. A model limit Thalamus filed while this account was in use: that model is spent on it
  // until the reset the error stated.
  for (const [key, entry] of Object.entries(input.cooling)) {
    if (!key.startsWith("model:") || !entry || typeof entry.until !== "number") {
      continue;
    }
    if (entry.until <= now || typeof entry.since !== "number") {
      continue;
    }
    if (liveAccountAt(input.switchLog, entry.since) !== account) {
      continue;
    }
    const family = key.slice("model:".length);
    (limits.scoped ??= {})[family] = {
      utilization: 100,
      resets_at: new Date(entry.until).toISOString(),
    };
    (notes.scoped ??= {})[family] = `limit hit ${stamp(entry.since, now)}`;
  }

  if (!limits.five_hour && !limits.seven_day && !limits.scoped) {
    return undefined;
  }
  return { account, label: accountLabel(account), limits, notes };
}

// ── file readers: never throw, a missing or broken file reads as empty ──────────────────────

type Cached = { mtimeMs: number; size: number; value: unknown };
const fileCache = new Map<string, Cached>();

function readJsonCached<T>(file: string, fallback: T): T {
  try {
    const st = statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.value as T;
    }
    const value = JSON.parse(readFileSync(file, "utf8")) as T;
    fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return fallback;
  }
}

/** The account Claude Code is signed in to now (~/.claude.json; the keeper rewrites it on a switch). */
export function readLiveAccount(file = join(homedir(), ".claude.json")): string | undefined {
  const cfg = readJsonCached<Record<string, any>>(file, {});
  const email = cfg?.oauthAccount?.emailAddress;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

/**
 * The account a usage report belongs to, or undefined when it cannot be told. The gateway's
 * claude-cli profile re-reads Claude Code's login through a 15-minute cache, so right after a
 * switch it can still hold the previous account's token: a report is credited to the live
 * account only when the token that fetched it is the one in Claude Code's login file now.
 * Compared in memory, never logged.
 */
export function accountOfToken(
  token: string | null | undefined,
  home = homedir(),
): string | undefined {
  if (!token) {
    return undefined;
  }
  const cred = readJsonCached<Record<string, any>>(join(home, ".claude", ".credentials.json"), {});
  if (cred?.claudeAiOauth?.accessToken !== token) {
    return undefined;
  }
  return readLiveAccount(join(home, ".claude.json"));
}

/** The keeper's vault: its accounts (one folder per e-mail), their week readings, its switch log. */
export function readVault(dir = VAULT_DIR): {
  accounts: string[];
  readings: Record<string, KeeperReading>;
  switchLog: string;
} {
  let accounts: string[];
  try {
    accounts = readdirSync(dir)
      .filter((n) => n.includes("@"))
      .sort();
  } catch {
    return { accounts: [], readings: {}, switchLog: "" };
  }
  const readings = readJsonCached<Record<string, KeeperReading>>(join(dir, "readings.json"), {});
  let switchLog = "";
  try {
    switchLog = readFileSync(join(dir, "switch.log"), "utf8");
  } catch {
    switchLog = "";
  }
  return { accounts, readings, switchLog };
}

/** Thalamus' cooling file (same default and override as src/infra/thalamus-cooling.ts). */
export function readCooling(
  file = process.env.OPENCLAW_THALAMUS_COOLING_FILE?.trim() ||
    join(homedir(), ".openclaw", "thalamus-cooling.json"),
): Record<string, CoolingEntry> {
  return readJsonCached<Record<string, CoolingEntry>>(file, {});
}

export function readReports(file: string): Record<string, StoredReport> {
  return readJsonCached<Record<string, StoredReport>>(file, {});
}

/**
 * Keeps the newest usage report per account, so an account moved to reserve keeps what was last
 * known of it (above all its own Fable cap). Written through a temp file and a rename; a failed
 * write only costs the reserve its last-known figures.
 */
export function rememberReport(
  file: string,
  email: string,
  limits: AccountLimits | undefined,
  fetchedAt: number,
): void {
  if (!limits) {
    return;
  }
  try {
    const all = { ...readReports(file) };
    const prev = all[email];
    if (prev && prev.fetchedAt >= fetchedAt) {
      return;
    }
    all[email] = { limits, fetchedAt };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    // see the doc comment
  }
}
