// node --test scripts/hive-door/usage.test.mjs
// Tokens per person: who a model call belongs to, the usage day (07:00 in a named zone), who gets a
// row, the `report` command, and the admin-only route.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDoor } from "./door.mjs";
import { sha256Hex } from "./table.mjs";
import {
  RESET,
  SHARED,
  SYSTEM,
  dayMinus,
  dayRange,
  ownerLookupFromFiles,
  personOf,
  readLedgerGroups,
  usageDayIn,
  usageReport,
  weekdayOf,
  zoneOrLocal,
} from "./usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TZ = "Europe/Madrid";
const OWNERS = {
  "agent:main:tinker:a1": { owner: "alice" },
  "agent:main:tinker:b1": { owner: "bob" },
  "agent:main:tinker:old": { owner: null, legacy: true },
};
const ctx = {
  ownerOf: (k) => OWNERS[k] ?? null,
  people: new Set(["alice", "bob"]),
};

function makeLedger(file, calls) {
  // Same columns the gateway writes (src/forensic/llm-ledger.ts), only those the report reads.
  return import("node:sqlite").then(({ DatabaseSync }) => {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL, source TEXT NOT NULL, session_key TEXT, spawned_by TEXT,
      driver TEXT NOT NULL, driver_source TEXT NOT NULL, outcome TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, request_gz BLOB, response_gz BLOB)`);
    const ins = db.prepare(`INSERT INTO calls (call_id, started_at, source, session_key, spawned_by,
      driver, driver_source, outcome, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens) VALUES (?, ?, 'agent', ?, ?, ?, 'client', 'ok', ?, ?, ?, ?)`);
    calls.forEach((c, i) =>
      ins.run(
        `c${i}`,
        c.at,
        c.key ?? null,
        c.parent ?? null,
        c.driver ?? "client:webchat-ui",
        c.i ?? 0,
        c.o ?? 0,
        c.cr ?? null,
        c.cw ?? 0,
      ),
    );
    db.close();
  });
}

// Noon UTC is after 07:00 and on the same date in every zone from UTC-5 to UTC+11.
const noon = (day) => `${day}T12:00:00.000Z`;

describe("who a model call belongs to", () => {
  it("a seat that names a person wins over the chat's owner", () => {
    assert.equal(personOf({ sessionKey: "agent:main:tinker:b1", driver: "alice" }, ctx), "alice");
  });
  it("otherwise the chat's owner, then the owner of the chat that spawned it", () => {
    assert.equal(personOf({ sessionKey: "agent:main:tinker:b1", driver: "client:x" }, ctx), "bob");
    assert.equal(
      personOf({ sessionKey: "agent:main:subagent:s9", spawnedBy: "agent:main:tinker:a1" }, ctx),
      "alice",
    );
  });
  it("a chat from before multi-user mode is Shared; anything else is System", () => {
    assert.equal(personOf({ sessionKey: "agent:main:tinker:old", driver: "x" }, ctx), SHARED);
    assert.equal(personOf({ sessionKey: "temp:title-suggest", driver: "unknown" }, ctx), SYSTEM);
    assert.equal(personOf({ sessionKey: null, driver: "unknown" }, ctx), SYSTEM);
  });
});

describe("the usage day", () => {
  it("lists every day, both ends included, across months", () => {
    assert.deepEqual(dayRange("2026-10-30", "2026-11-02"), [
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    assert.deepEqual(dayRange("2026-11-02", "2026-11-01"), []);
    assert.equal(dayMinus("2026-03-01", 1), "2026-02-28");
    assert.equal(weekdayOf("2026-11-16"), 1); // a Monday
    assert.equal(weekdayOf("2026-11-22"), 0); // a Sunday
  });
  it("starts at 07:00 on the wall clock of the named zone, so the week can restart on Monday 07:00", () => {
    const madrid = usageDayIn(TZ);
    // Monday 2026-11-16, 06:30 in Madrid (05:30 UTC): still Sunday's usage day
    assert.equal(madrid(new Date("2026-11-16T05:30:00Z")), "2026-11-15");
    // 07:30 in Madrid (06:30 UTC): Monday has begun
    assert.equal(madrid(new Date("2026-11-16T06:30:00Z")), "2026-11-16");
    // the same instant on a server clock set to UTC is 06:30: there it is still Sunday
    assert.equal(usageDayIn("UTC")(new Date("2026-11-16T06:30:00Z")), "2026-11-15");
    assert.deepEqual(RESET, { weekday: 1, hour: 7 });
  });
  it("follows the clock change: 07:00 stays 07:00 on the wall, summer and winter", () => {
    const madrid = usageDayIn(TZ);
    assert.equal(madrid(new Date("2026-07-06T04:59:00Z")), "2026-07-05"); // 06:59 CEST
    assert.equal(madrid(new Date("2026-07-06T05:00:00Z")), "2026-07-06"); // 07:00 CEST
    assert.equal(madrid(new Date("2026-12-07T05:59:00Z")), "2026-12-06"); // 06:59 CET
    assert.equal(madrid(new Date("2026-12-07T06:00:00Z")), "2026-12-07"); // 07:00 CET
  });
  it("an unknown zone name falls back to this machine's own zone", () => {
    assert.equal(zoneOrLocal("Europe/Madrid"), "Europe/Madrid");
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(zoneOrLocal("Mars/Olympus"), own);
    assert.equal(zoneOrLocal(undefined), own);
  });
});

describe("who gets a row and what it holds", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const today = "2026-11-18";
  const g = (day, sessionKey, driver, counts) => ({
    day,
    sessionKey,
    spawnedBy: null,
    driver,
    calls: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...counts,
  });
  const people = [
    { operatorId: "alice", displayName: "Alice", status: "active", admin: true },
    { operatorId: "bob", displayName: "Bob", status: "active" },
    { operatorId: "carol", displayName: "Carol", status: "active" },
    { operatorId: "dave", displayName: "Dave", status: "deleted" },
    { operatorId: "erin", displayName: "Erin", status: "revoked" },
  ];
  const r = usageReport({
    groups: [
      g(today, "agent:main:tinker:a1", "client:webchat-ui", { input: 1000 }), // alice, the viewer
      g(today, "agent:main:tinker:b1", "client:webchat-ui", { input: 50 }),
      g(dayMinus(today, 2), "agent:main:tinker:b1", "client:webchat-ui", {
        input: 1,
        output: 2,
        cacheRead: 30,
        cacheWrite: 400,
      }),
      g(dayMinus(today, 1), "agent:main:tinker:e1", "erin", { input: 7 }),
      g(dayMinus(today, 2), "agent:main:tinker:old", "client:webchat-ui", { input: 5 }), // Shared
      g(today, "temp:title-suggest", "unknown", { input: 3 }), // System
    ],
    people,
    ownerOf: ctx.ownerOf,
    viewer: "alice",
    timeZone: TZ,
    now,
  });
  it("the axis runs from the ledger's first day to today, and says when the total restarts", () => {
    assert.deepEqual(r.days, [dayMinus(today, 2), dayMinus(today, 1), today]);
    assert.equal(r.today, today);
    assert.equal(r.ledger.since, dayMinus(today, 2));
    assert.equal(r.ledger.calls, 6);
    assert.equal(r.timeZone, TZ);
    assert.deepEqual(r.reset, { weekday: 1, hour: 7 });
  });
  it("the viewer is left out, removed people only with calls, and the table order is kept", () => {
    assert.deepEqual(
      r.rows.map((x) => x.name),
      ["Bob", "Carol", "Erin"],
    );
  });
  it("a day's value is input + output + cache write + cache read; a quiet day is 0", () => {
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x.daily]));
    assert.deepEqual(by.Bob, [433, 0, 50]);
    assert.deepEqual(by.Carol, [0, 0, 0]);
    assert.deepEqual(by.Erin, [0, 7, 0]);
  });
  it("a ledger older than about a year is cut to the last 400 days", () => {
    const old = usageReport({
      groups: [g(dayMinus(today, 500), "agent:main:tinker:b1", "client:webchat-ui", { input: 9 })],
      people,
      ownerOf: ctx.ownerOf,
      timeZone: TZ,
      now,
    });
    assert.equal(old.days.length, 400);
    assert.equal(old.days[0], dayMinus(today, 399));
  });
  it("puts an hour of the ledger on the usage day of the viewer's zone, not the server's", () => {
    // Monday 2026-11-16 06:00 UTC = 07:00 in Madrid: Monday there, still Sunday on a UTC clock.
    const hourly = [
      {
        hour: "2026-11-16T06",
        sessionKey: "agent:main:tinker:b1",
        spawnedBy: null,
        driver: "client:webchat-ui",
        calls: 1,
        input: 8,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ];
    const at = (timeZone) =>
      usageReport({ groups: hourly, people, ownerOf: ctx.ownerOf, timeZone, now }).ledger.since;
    assert.equal(at(TZ), "2026-11-16");
    assert.equal(at("UTC"), "2026-11-15");
  });
});

describe("the ledger reader", () => {
  let tmp, ledger;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "door-usage-"));
    ledger = path.join(tmp, "llm-ledger.sqlite");
    await makeLedger(ledger, [
      { at: "2026-11-18T12:00:00.000Z", key: "agent:main:tinker:a1", i: 10, o: 20, cr: 300, cw: 4 },
      { at: "2026-11-18T12:59:59.000Z", key: "agent:main:tinker:a1", i: 1 },
      { at: "2026-11-18T13:00:00.000Z", key: "agent:main:tinker:a1", i: 100 },
      { at: "2026-11-15T09:10:00.000Z", key: "agent:main:tinker:b1", i: 5, cr: null },
    ]);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("groups by UTC hour and chat; a missing count is zero", async () => {
    const groups = await readLedgerGroups(ledger);
    const a1 = groups.filter((x) => x.sessionKey === "agent:main:tinker:a1");
    assert.deepEqual(a1.map((x) => x.hour).sort(), ["2026-11-18T12", "2026-11-18T13"]);
    const noonHour = a1.find((x) => x.hour === "2026-11-18T12");
    assert.equal(noonHour.calls, 2);
    assert.equal(noonHour.input, 11);
    assert.equal(noonHour.cacheRead, 300);
    assert.equal(groups.find((x) => x.sessionKey === "agent:main:tinker:b1").cacheRead, 0);
    assert.equal(await readLedgerGroups(path.join(tmp, "none.sqlite")), null);
  });
});

describe("the report command, for another host to fetch", () => {
  let tmp;
  const run = (args) =>
    execFileSync(process.execPath, [path.join(HERE, "usage.mjs"), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "door-usage-cli-"));
    const row = (id, extra = {}) => ({
      tokenId: `t_${id}`,
      operatorId: id,
      displayName: id[0].toUpperCase() + id.slice(1),
      hash: sha256Hex(`${id}-secret-token`),
      token: `${id}-secret-token`,
      status: "active",
      ...extra,
    });
    fs.writeFileSync(
      path.join(tmp, "tokens.json"),
      JSON.stringify([row("alice", { admin: true }), row("bob"), row("carol")]),
    );
    fs.writeFileSync(
      path.join(tmp, "acl.json"),
      JSON.stringify({ version: 1, sessions: { "agent:main:tinker:b1": { owner: "bob" } } }),
    );
    fs.writeFileSync(
      path.join(tmp, "sessions.json"),
      JSON.stringify({ "Agent:main:subagent:S1": { spawnedBy: "agent:main:tinker:b1" } }),
    );
    await makeLedger(path.join(tmp, "ledger.sqlite"), [
      { at: "2026-11-16T06:30:00.000Z", key: "agent:main:tinker:b1", i: 5 },
      { at: "2026-11-17T10:00:00.000Z", key: "agent:main:subagent:s1", i: 7 }, // bob's, via its parent
      { at: "2026-11-17T10:00:00.000Z", key: "agent:main:tinker:nobody", i: 99 }, // System
    ]);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const args = () => [
    "report",
    "--state-dir",
    tmp,
    "--ledger",
    path.join(tmp, "ledger.sqlite"),
    "--sessions",
    path.join(tmp, "sessions.json"),
  ];

  it("reads the door's files and prints the same report, in the zone it is asked for", () => {
    const out = run([...args(), "--tz", TZ, "--viewer", "alice"]);
    const r = JSON.parse(out);
    assert.equal(r.timeZone, TZ);
    assert.deepEqual(
      r.rows.map((x) => x.name),
      ["Bob", "Carol"],
    );
    const bob = r.rows[0];
    assert.equal(bob.daily[r.days.indexOf("2026-11-16")], 5); // 07:30 in Madrid: Monday
    assert.equal(bob.daily[r.days.indexOf("2026-11-17")], 7);
    // in UTC the first call is 06:30, before the day starts: Sunday
    const utc = JSON.parse(run([...args(), "--tz", "UTC"]));
    assert.equal(utc.rows.find((x) => x.name === "Bob").daily[utc.days.indexOf("2026-11-15")], 5);
    assert.ok(utc.rows.some((x) => x.name === "Alice")); // no viewer named: everyone is listed
  });

  it("never prints a token or a hash", () => {
    const out = run(args());
    assert.ok(!out.includes("secret-token"));
    assert.ok(!out.includes(sha256Hex("bob-secret-token")));
  });

  it("the file lookup follows a subagent to its parent's owner, read-only", () => {
    const ownerOf = ownerLookupFromFiles({
      aclFile: path.join(tmp, "acl.json"),
      gatewayStoreFile: path.join(tmp, "sessions.json"),
    });
    assert.equal(ownerOf("agent:main:subagent:s1").owner, "bob");
    assert.equal(ownerOf("agent:main:tinker:nobody"), null);
    const aclBefore = fs.readFileSync(path.join(tmp, "acl.json"), "utf8");
    run(args());
    assert.equal(fs.readFileSync(path.join(tmp, "acl.json"), "utf8"), aclBefore);
  });

  it("says so and fails where there is no door", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "door-usage-none-"));
    assert.throws(() => run(["report", "--state-dir", empty]), /no hive door here/);
    assert.throws(() => run(["feed"]), /usage: node usage\.mjs report/);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe("the door's usage route", () => {
  let tmp, door, port;
  const T = { alice: "alice-token-aaaaaaaa", bob: "bob-token-bbbbbbbb" };
  // "Today" the way the door sees it with no zone given: this machine's zone, day from 07:00.
  const today = usageDayIn(zoneOrLocal())(new Date());
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "door-usage-route-"));
    const row = (id, admin) => ({
      tokenId: `t_${id}`,
      operatorId: id,
      displayName: id[0].toUpperCase() + id.slice(1),
      seatId: id,
      hash: sha256Hex(T[id] ?? id),
      status: "active",
      admin,
    });
    fs.writeFileSync(
      path.join(tmp, "tokens.json"),
      JSON.stringify([row("alice", true), row("bob", false), row("carol", false)]),
    );
    const ledgerFile = path.join(tmp, "llm-ledger.sqlite");
    await makeLedger(ledgerFile, [
      { at: noon(today), key: "agent:main:tinker:z", driver: "bob", o: 9 },
      { at: noon(today), key: "agent:main:tinker:y", driver: "alice", o: 1000 },
    ]);
    door = createDoor({ stateDir: tmp, upstream: "127.0.0.1:9", gatewayToken: "GW", ledgerFile });
    await new Promise((r) => door.server.listen(0, "127.0.0.1", r));
    port = door.server.address().port;
  });
  after(() => {
    door.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const req = (method, p, headers = {}, body) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
        const b = [];
        res.on("data", (d) => b.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(b).toString(),
          }),
        );
      });
      r.on("error", reject);
      if (body) r.write(body);
      r.end();
    });
  const cookieFor = async (token) =>
    (
      await req(
        "POST",
        "/tinker/login",
        { "content-type": "application/x-www-form-urlencoded" },
        `token=${token}`,
      )
    ).headers["set-cookie"][0].split(";")[0];

  it("an admin gets everyone else's count, people with no calls included, never their own", async () => {
    const r = await req("GET", "/tinker/door/api/usage", { cookie: await cookieFor(T.alice) });
    assert.equal(r.status, 200);
    const rows = JSON.parse(r.body).rows.map((x) => `${x.name}=${x.daily.at(-1)}`);
    assert.deepEqual(rows, ["Bob=9", "Carol=0"]);
  });

  it("counts the days in the zone the page sends, and ignores a zone that does not exist", async () => {
    const cookie = await cookieFor(T.alice);
    const get = async (q) =>
      JSON.parse((await req("GET", `/tinker/door/api/usage${q}`, { cookie })).body);
    assert.equal((await get("?tz=Pacific%2FAuckland")).timeZone, "Pacific/Auckland");
    assert.equal((await get("?tz=Mars%2FOlympus")).timeZone, zoneOrLocal());
  });

  it("a regular person is refused, and so is nobody", async () => {
    const r = await req("GET", "/tinker/door/api/usage", { cookie: await cookieFor(T.bob) });
    assert.equal(r.status, 403);
    assert.equal(
      (await req("GET", "/tinker/door/api/usage", { accept: "application/json" })).status,
      401,
    );
  });
});
