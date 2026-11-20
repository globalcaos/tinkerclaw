#!/usr/bin/env node
/**
 * Hive door — model tokens used per person, read from the gateway's LLM ledger.
 *
 * WHAT IT IS FOR: an admin compares how many model tokens the other people spent on the shared
 * agent (requested 2026-11-18). The same day the owner narrowed it: the viewer's own use is left
 * out ("comparing the rest"), and every active person has a row, also with no calls yet, so nobody
 * is missing from the comparison. Then a time graph, one line per person, drawn like the other Pulse
 * graphs. 2026-11-20: each line is a running total that starts again every Monday at 07:00, and the
 * owner's own agent on another host shows the same people next to his own use (the `report`
 * command below is what that host fetches).
 * HOW IT WAS DERIVED: the ledger (src/forensic/llm-ledger.ts) keeps one row per model call with its
 * chat key, the chat that spawned it, a driver and four token counts. Behind the door most calls
 * carry the driver `client:webchat-ui`, whoever typed; the driver names a person only when the
 * call came with that person's seat. So a call belongs to: the seat's person, else the chat's owner
 * in acl.json (subagents through their parent), else "Shared" for chats from before multi-user
 * mode, else "System" (titles, reflections, crons). Shared and System are nobody's, so the report
 * leaves them out. Measured on the first host, 2026-11-18: of 415 calls, 107 named a person as
 * driver and 152 more ran in a chat with an owner.
 * The week restarts at a wall-clock hour, so days are counted in a NAMED time zone, never the
 * server's: the first host runs on UTC while its people work an hour or two east of it. The page
 * sends the viewer's zone; a day here runs from 07:00 to 07:00 so that Monday's first seven hours
 * still belong to the week before.
 * WHAT WOULD CHANGE IT: per-person identity inside the gateway (every driver would name a person);
 * a reset the owner moves (RESET below is the one place).
 *
 * A token count is input + output + cache write + cache read, the four numbers the ledger keeps.
 *
 * Command (prints the report as JSON; reads the door's files, writes nothing):
 *   node usage.mjs report [--tz <zone>] [--viewer <operatorId>] [--state-dir <door state dir>]
 *                         [--ledger <file>] [--sessions <sessions.json>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonKey } from "./acl.mjs";
import { loadRows } from "./table.mjs";

export const SYSTEM = "system";
export const SHARED = "shared";
/** When the running total starts again: weekday 1 = Monday, at 07:00 (the owner, 2026-11-20). */
export const RESET = Object.freeze({ weekday: 1, hour: 7 });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const MAX_INHERIT_DEPTH = 6;

/** The gateway's ledger file, resolved the way src/forensic/llm-ledger.ts resolves it. */
export function defaultLedgerFile(env = process.env) {
  const state = env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return env.OPENCLAW_LLM_LEDGER_PATH?.trim() || path.join(state, "forensic", "llm-ledger.sqlite");
}

/** The day `n` days before `day` ("YYYY-MM-DD"). Plain calendar arithmetic, no time zone in it. */
export function dayMinus(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/** 0 Sunday … 6 Saturday of a "YYYY-MM-DD" day. */
export function weekdayOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Every day from `from` to `to`, both included ("YYYY-MM-DD"); empty when `from` is later. */
export function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = dayMinus(d, -1)) out.push(d);
  return out;
}

/** `tz` when the runtime knows that zone name, else this machine's own zone. */
export function zoneOrLocal(tz) {
  if (typeof tz === "string" && tz && tz.length <= 64) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
      return tz;
    } catch {
      // not a zone this runtime knows: fall through to the machine's own
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A function from an instant to its USAGE DAY in `timeZone`: the wall-clock date there, with the
 * day starting at `hour` o'clock. 06:59 on a Monday is still Sunday's usage day.
 */
export function usageDayIn(timeZone, hour = RESET.hour) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  return (date) => {
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const day = `${p.year}-${p.month}-${p.day}`;
    return Number(p.hour) < hour ? dayMinus(day, 1) : day;
  };
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, total: 0 };
}
function add(into, c) {
  into.input += c.input;
  into.output += c.output;
  into.cacheRead += c.cacheRead;
  into.cacheWrite += c.cacheWrite;
  into.calls += c.calls;
  into.total += c.input + c.output + c.cacheRead + c.cacheWrite;
}

/**
 * Model calls grouped by UTC hour ("YYYY-MM-DDTHH"), chat, parent chat and driver. Read-only; null
 * when there is no ledger. The hour is the finest step the report needs: it lets a day start at
 * 07:00 in any zone. `node:sqlite` is loaded here, not at the top, so a door without a ledger never
 * needs it.
 */
export async function readLedgerGroups(file) {
  if (!file || !fs.existsSync(file)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    return db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H', started_at) AS hour, session_key AS sessionKey,
                spawned_by AS spawnedBy, driver, COUNT(*) AS calls,
                SUM(COALESCE(input_tokens, 0)) AS input, SUM(COALESCE(output_tokens, 0)) AS output,
                SUM(COALESCE(cache_read_tokens, 0)) AS cacheRead,
                SUM(COALESCE(cache_write_tokens, 0)) AS cacheWrite
           FROM calls GROUP BY 1, 2, 3, 4`,
      )
      .all()
      .filter((g) => typeof g.hour === "string" && HOUR_RE.test(g.hour))
      .map((g) => ({
        ...g,
        calls: Number(g.calls) || 0,
        input: Number(g.input) || 0,
        output: Number(g.output) || 0,
        cacheRead: Number(g.cacheRead) || 0,
        cacheWrite: Number(g.cacheWrite) || 0,
      }));
  } finally {
    db.close();
  }
}

/**
 * Who a group of calls belongs to: an operatorId, SHARED or SYSTEM.
 * @param {{sessionKey?: string|null, spawnedBy?: string|null, driver?: string|null}} g
 * @param {{ownerOf: (key: string) => ({owner?: string|null, legacy?: boolean}|null), people: Set<string>}} ctx
 */
export function personOf(g, ctx) {
  if (g.driver && ctx.people.has(g.driver)) return g.driver;
  const own = (g.sessionKey && ctx.ownerOf(g.sessionKey)) || null;
  if (own?.owner) return own.owner;
  const parent = (g.spawnedBy && ctx.ownerOf(g.spawnedBy)) || null;
  if (parent?.owner) return parent.owner;
  if (own?.legacy || parent?.legacy) return SHARED;
  return SYSTEM;
}

/** Day totals of the calls grouped by person: Map<who, Map<day, counts>>. Each group carries `day`. */
export function totalsByPerson(groups, ctx) {
  const out = new Map();
  for (const g of groups ?? []) {
    const who = personOf(g, ctx);
    if (!out.has(who)) out.set(who, new Map());
    const days = out.get(who);
    if (!days.has(g.day)) days.set(g.day, zero());
    add(days.get(g.day), g);
  }
  return out;
}

// About a year of days, like the other Pulse graphs (their metrics keep 365 days).
const MAX_DAYS = 400;

/**
 * The admin report: a day axis, and for every person except the viewer the tokens they used on
 * each day of it. A day is a usage day in `timeZone` (07:00 to 07:00). Every active person is
 * listed, also with no calls; a revoked or deleted person only while they have calls. Rows keep the
 * people table's order (the order people were added), so a person keeps the same line colour on the
 * page as others join. `reset` says when a running total drawn from this report starts again.
 * @param {object} o
 * @param {Array|null} o.groups       readLedgerGroups() (null: no ledger); a group has `hour`, or `day`
 * @param {Array} o.people            the door's people table rows
 * @param {(key: string) => object|null} o.ownerOf  read-only owner lookup (acl.peek)
 * @param {string} [o.viewer]         operatorId of the admin asking; left out
 * @param {string} [o.timeZone]       the viewer's zone; an unknown name falls back to this machine's
 * @param {Date} [o.now]
 */
export function usageReport(o) {
  const now = o.now ?? new Date();
  const timeZone = zoneOrLocal(o.timeZone);
  const toDay = usageDayIn(timeZone);
  const today = toDay(now);
  const dayOfHour = new Map();
  const groups = (o.groups ?? [])
    .map((g) => {
      if (typeof g.day === "string" && DAY_RE.test(g.day)) return g;
      if (!dayOfHour.has(g.hour)) dayOfHour.set(g.hour, toDay(new Date(`${g.hour}:00:00Z`)));
      return { ...g, day: dayOfHour.get(g.hour) };
    })
    .filter((g) => DAY_RE.test(g.day ?? ""));
  const people = o.people ?? [];
  const known = new Set(people.map((r) => r.operatorId));
  const totals = totalsByPerson(groups, { ownerOf: o.ownerOf, people: known });
  let since = null;
  for (const g of groups) if (!since || g.day < since) since = g.day;
  const oldest = dayMinus(today, MAX_DAYS - 1);
  const first = !since || since > today ? today : since < oldest ? oldest : since;
  const days = dayRange(first, today);
  const rows = [];
  const push = (id, name, status) => {
    if (id === o.viewer) return;
    const mine = totals.get(id);
    if (status !== "active" && !mine?.size) return;
    rows.push({ id, name, status, daily: days.map((d) => mine?.get(d)?.total ?? 0) });
  };
  for (const r of people) push(r.operatorId, r.displayName || r.operatorId, r.status ?? null);
  // An owner the table no longer names still spent tokens: list them under their id.
  for (const id of totals.keys())
    if (id !== SYSTEM && id !== SHARED && !known.has(id)) push(id, id, null);
  return {
    generatedAt: now.toISOString(),
    today,
    timeZone,
    reset: { ...RESET },
    days,
    rows,
    ledger: {
      found: o.groups !== null,
      calls: groups.reduce((n, g) => n + g.calls, 0),
      since,
    },
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The owner lookup of acl.mjs `peek`, straight from the files, for the `report` command: the door
 * process is not in the room. Read-only; a missing file means "nobody owns anything".
 */
export function ownerLookupFromFiles({ aclFile, gatewayStoreFile, defaultAgent = "main" }) {
  const sessions = readJson(aclFile)?.sessions ?? {};
  const store = {};
  for (const [k, v] of Object.entries(readJson(gatewayStoreFile) ?? {})) store[k.toLowerCase()] = v;
  const peek = (key, depth = 0) => {
    const k = canonKey(key, defaultAgent);
    if (!k) return null;
    if (sessions[k]) return sessions[k];
    if (depth > MAX_INHERIT_DEPTH) return null;
    const gw = store[k];
    const parent = gw && (gw.spawnedBy || gw.parentSessionKey || gw.requesterSessionKey);
    return typeof parent === "string" ? peek(parent, depth + 1) : null;
  };
  return (key) => peek(key);
}

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv[0] !== "report") {
    console.error(
      "usage: node usage.mjs report [--tz <zone>] [--viewer <operatorId>] [--state-dir <dir>] [--ledger <file>] [--sessions <file>]",
    );
    process.exit(2);
  }
  const home = os.homedir();
  const stateDir =
    argValue(argv, "state-dir") ??
    process.env.DOOR_STATE_DIR ??
    path.join(home, ".openclaw", "data", "door");
  const people = loadRows(path.join(stateDir, "tokens.json"));
  if (!people.length) {
    console.error(
      `[usage] no people table at ${path.join(stateDir, "tokens.json")}: no hive door here`,
    );
    process.exit(1);
  }
  const report = usageReport({
    groups: await readLedgerGroups(argValue(argv, "ledger") ?? defaultLedgerFile()),
    people,
    ownerOf: ownerLookupFromFiles({
      aclFile: path.join(stateDir, "acl.json"),
      gatewayStoreFile:
        argValue(argv, "sessions") ??
        process.env.DOOR_SESSIONS_STORE ??
        path.join(home, ".openclaw", "agents", "main", "sessions", "sessions.json"),
    }),
    viewer: argValue(argv, "viewer"),
    timeZone: argValue(argv, "tz"),
  });
  process.stdout.write(JSON.stringify(report) + "\n");
}
