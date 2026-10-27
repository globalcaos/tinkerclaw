// node --test scripts/trip/flight-watch.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  appendAlerts,
  bundle,
  deliverPending,
  diffStatus,
  errSummary,
  htmlStale,
  isDomestic,
  makeSender,
  mergeStatus,
  normPlace,
  parseCliJson,
  pickAndroidNode,
  queueEvents,
  reminders,
  runOnce,
  takeLock,
  watchedFlights,
} from "./flight-watch.mjs";

const H = 3_600_000;
const trip_io = await import("./lib/trip-io.mjs");
const flight = (over = {}) => ({
  id: "f1",
  type: "flight",
  confirmed: true,
  airline: "Example Air",
  carrier: "ZX",
  number: "101",
  confirmation: "ABC123",
  from: { iata: "BCN", name: "Valencia", tz: "Europe/Madrid" },
  to: { iata: "SFO", name: "San Francisco", tz: "America/Los_Angeles" },
  depLocal: "2025-10-21T16:05",
  arrLocal: "2025-10-21T19:20",
  ...over,
});
const DEP = Date.parse("2025-10-21T14:05:00Z"); // 16:05 CEST
const trip = (segments) => ({
  version: 1,
  title: "t",
  homeTz: "Europe/Madrid",
  segments,
  alerts: [],
});
const live = (over = {}) => ({
  status: "scheduled",
  schedDep: "2025-10-21T14:05:00.000Z",
  schedArr: "2025-10-22T02:20:00.000Z",
  estDep: null,
  actDep: null,
  estArr: null,
  actArr: null,
  depTerminal: null,
  depGate: null,
  arrTerminal: null,
  arrGate: null,
  baggage: null,
  source: "flightstats",
  fetchedAt: "2025-10-21T10:00:00.000Z",
  ...over,
});
const keys = (evs) => evs.map((e) => e.key);

describe("change detection", () => {
  it("first sighting of a plain scheduled flight is silent", () => {
    assert.deepEqual(diffStatus(flight(), undefined, mergeStatus(undefined, live())), []);
  });

  it("delay alerts at >= 15 min, then only when it moves another 15", () => {
    const s = flight();
    const a = mergeStatus(undefined, live());
    const b = mergeStatus(a, live({ estDep: "2025-10-21T14:25:00.000Z" })); // +20
    const e1 = diffStatus(s, a, b);
    assert.deepEqual(keys(e1), ["f1:delay:20:1"]);
    assert.equal(e1[0].level, "warn");
    assert.match(e1[0].body, /16:25 CEST \(was 16:05 CEST\)/);
    assert.equal(b.alertedDelayMin, 20);
    const c = mergeStatus(b, live({ estDep: "2025-10-21T14:35:00.000Z" })); // +30, only 10 more
    assert.deepEqual(diffStatus(s, b, c), []);
    const d = mergeStatus(c, live({ estDep: "2025-10-21T15:15:00.000Z" })); // +70
    const e3 = diffStatus(s, c, d);
    assert.deepEqual(keys(e3), ["f1:delay:70:2"]);
    assert.equal(e3[0].level, "critical");
    const back = mergeStatus(d, live({ estDep: "2025-10-21T14:10:00.000Z" })); // +5
    assert.deepEqual(keys(diffStatus(s, d, back)), ["f1:delay:5:3"]);
  });

  it("creeping 10-min steps still alert once the total moves 15 from what was told", () => {
    const s = flight();
    let prev = mergeStatus(undefined, live());
    const fired = [];
    for (const min of [10, 20, 30, 40]) {
      const next = mergeStatus(prev, live({ estDep: new Date(DEP + min * 60_000).toISOString() }));
      fired.push(...keys(diffStatus(s, prev, next)));
      prev = next;
    }
    assert.deepEqual(fired, ["f1:delay:20:1", "f1:delay:40:2"]);
  });

  it("cancellation and diversion are critical", () => {
    const a = mergeStatus(undefined, live());
    const c = diffStatus(flight(), a, mergeStatus(a, live({ status: "cancelled" })));
    assert.deepEqual(keys(c), ["f1:status:cancelled"]);
    assert.equal(c[0].level, "critical");
    const d = diffStatus(flight(), a, mergeStatus(a, live({ status: "diverted" })));
    assert.equal(d[0].key, "f1:status:diverted");
  });

  it("gate assigned is info, changed is a warning, a spelling difference alone is not news", () => {
    const s = flight();
    const a = mergeStatus(undefined, live());
    const b = mergeStatus(a, live({ depGate: "E77", depTerminal: "1" }));
    const e1 = diffStatus(s, a, b);
    assert.deepEqual(keys(e1).toSorted(), ["f1:depGate:E77:1", "f1:depTerminal:1:1"]);
    assert.ok(e1.every((e) => e.level === "info"));
    const c = mergeStatus(b, live({ depGate: "E80", depTerminal: "1" }));
    const e2 = diffStatus(s, b, c);
    assert.deepEqual(keys(e2), ["f1:depGate:E80:2"]);
    assert.equal(e2[0].level, "warn");
    assert.match(e2[0].title, /GATE CHANGED E77 → E80/);
    const d = mergeStatus(c, live({ depGate: "E80", depTerminal: "T1", source: "flightaware" }));
    assert.deepEqual(diffStatus(s, c, d), []);
  });

  it("departed, landed and belt", () => {
    const s = flight();
    const a = mergeStatus(undefined, live());
    const b = mergeStatus(
      a,
      live({
        status: "departed",
        actDep: "2025-10-21T14:10:00.000Z",
        estArr: "2025-10-22T02:30:00.000Z",
      }),
    );
    const e1 = diffStatus(s, a, b);
    assert.deepEqual(keys(e1), ["f1:status:departed"]);
    assert.match(e1[0].title, /departed 16:10 CEST/);
    assert.match(e1[0].body, /19:30 PDT/);
    const c = mergeStatus(
      b,
      live({
        status: "landed",
        actDep: "2025-10-21T14:10:00.000Z",
        actArr: "2025-10-22T02:28:00.000Z",
        baggage: "4",
      }),
    );
    const e2 = diffStatus(s, b, c);
    assert.deepEqual(keys(e2).toSorted(), ["f1:baggage:4:1", "f1:status:landed"]);
    assert.match(e2.find((e) => e.key === "f1:status:landed").body, /belt 4/);
  });

  it("a lagging fallback cannot walk landed back to departed, and dropped fields are kept", () => {
    const a = live({ status: "landed", depGate: "E77", baggage: "4" });
    const m = mergeStatus(a, live({ status: "departed", source: "flightaware" }));
    assert.equal(m.status, "landed");
    assert.equal(m.depGate, "E77");
    assert.equal(m.baggage, "4");
    assert.equal(
      mergeStatus(live({ status: "delayed" }), live({ status: "unknown" })).status,
      "delayed",
    );
  });
});

describe("changes back and provider flaps (review 2025-10-20)", () => {
  // Feed a sequence of provider answers through merge -> diff -> queue, like successive passes.
  const passes = (answers) => {
    const s = flight();
    const state = { segments: {}, notified: {}, pending: [] };
    const sent = [];
    for (const a of answers) {
      const prev = state.segments.f1;
      const next = mergeStatus(prev, live(a));
      for (const e of queueEvents(state, diffStatus(s, prev, next), 0)) {
        sent.push(e.title);
        state.notified[e.key] = "x";
      }
      state.pending = [];
      state.segments.f1 = next;
    }
    return sent;
  };
  const delayed = (min) => ({ estDep: new Date(DEP + min * 60_000).toISOString() });

  it("a gate that flips back is announced again", () => {
    assert.deepEqual(passes([{ depGate: "B12" }, { depGate: "B14" }, { depGate: "B12" }]), [
      "ZX 101: gate B12",
      "ZX 101: GATE CHANGED B12 → B14",
      "ZX 101: GATE CHANGED B14 → B12",
    ]);
  });

  it("a delay that shrinks or comes back is announced again", () => {
    assert.deepEqual(passes([{}, delayed(30), delayed(45), delayed(30), delayed(0), delayed(30)]), [
      "ZX 101 delayed +30 min",
      "ZX 101 delayed +45 min",
      "ZX 101 delayed +30 min",
      "ZX 101 back near on time",
      "ZX 101 delayed +30 min",
    ]);
  });

  it("a real change seen only by the fallback provider is announced once", () => {
    assert.deepEqual(
      passes([
        { depGate: "B12" },
        { depGate: "B30", source: "flightaware" },
        { depGate: "B30" },
        { depGate: "B30" },
      ]),
      ["ZX 101: gate B12", "ZX 101: GATE CHANGED B12 → B30"],
    );
  });

  it("the same place spelled differently is not news", () => {
    assert.equal(normPlace("arrTerminal", "INTL"), normPlace("arrTerminal", "I"));
    assert.equal(normPlace("depTerminal", "Terminal 1"), normPlace("depTerminal", "T1"));
    assert.equal(normPlace("depTerminal", "TBIT"), "TBIT");
    assert.equal(normPlace("depGate", "Gate B 12"), "B12");
    assert.deepEqual(
      passes([{ arrTerminal: "INTL" }, { arrTerminal: "I", source: "flightaware" }]),
      ["ZX 101: arrival terminal INTL"],
    );
  });

  it("an early departure on a flight never reported late is not 'back near on time'", () => {
    assert.deepEqual(passes([{}, delayed(-20)]), []);
  });
});

describe("dedupe and delivery", () => {
  it("an event is queued once, even across runs", () => {
    const state = { segments: {}, notified: {} };
    const ev = [{ key: "f1:delay:20", segmentId: "f1", level: "warn", title: "x", body: "y" }];
    assert.equal(queueEvents(state, ev, 0).length, 1);
    assert.equal(queueEvents(state, ev, 1).length, 0);
    state.pending = [];
    state.notified["f1:delay:20"] = "2025-10-21T00:00:00Z";
    assert.equal(queueEvents(state, ev, 2).length, 0);
  });

  it("failed sends stay pending, then give up after 6 h; one notification per flight", async () => {
    const state = { segments: {}, notified: {} };
    const t0 = Date.parse("2025-10-21T10:00:00Z");
    queueEvents(
      state,
      [
        { key: "f1:depGate:E77", segmentId: "f1", level: "info", title: "gate", body: "g" },
        {
          key: "f1:status:cancelled",
          segmentId: "f1",
          level: "critical",
          title: "CANCELLED",
          body: "c",
        },
        { key: "f2:remind:leave", segmentId: "f2", level: "warn", title: "leave", body: "l" },
      ],
      t0,
    );
    const b = bundle(state.pending);
    assert.equal(b.length, 2);
    assert.equal(b[0].title, "CANCELLED");
    assert.match(b[0].body, /gate\./);
    const sentMsgs = [];
    await deliverPending(state, async () => false, t0 + H);
    assert.equal(state.pending.length, 3);
    await deliverPending(
      state,
      async (m) => {
        sentMsgs.push(m);
        return m.items[0].segmentId === "f2";
      },
      t0 + 2 * H,
    );
    assert.deepEqual(state.pending.map((p) => p.key).toSorted(), [
      "f1:depGate:E77",
      "f1:status:cancelled",
    ]);
    assert.ok(state.notified["f2:remind:leave"]);
    await deliverPending(state, async () => false, t0 + 7 * H);
    assert.equal(state.pending.length, 0);
    assert.ok(state.notified["f1:status:cancelled"]);
  });
});

describe("reminders across time zones", () => {
  const at = (ms, seg = flight(), st = {}) => keys(reminders(trip([seg]), { segments: st }, ms));

  it("check-in opens at T-24 h of the Madrid departure (14:05Z)", () => {
    assert.deepEqual(at(DEP - 24 * H - 60_000), []);
    assert.deepEqual(at(DEP - 24 * H), ["f1:remind:checkin"]);
    assert.deepEqual(at(DEP - 2 * H - 60_000).includes("f1:remind:checkin"), true);
    assert.deepEqual(at(DEP - 2 * H).includes("f1:remind:checkin"), false);
  });

  it("international: leave at T-3 h; domestic (LA zone both ends): T-2 h", () => {
    assert.ok(!at(DEP - 3 * H - 60_000).includes("f1:remind:leave"));
    assert.ok(at(DEP - 3 * H).includes("f1:remind:leave"));
    const dom = flight({
      from: { iata: "SFO", tz: "America/Los_Angeles" },
      to: { iata: "LAX", tz: "America/Los_Angeles" },
      depLocal: "2025-10-25T09:00",
      arrLocal: "2025-10-25T10:30",
    });
    const domDep = Date.parse("2025-10-25T16:00:00Z"); // 09:00 PDT
    assert.ok(isDomestic(dom));
    assert.ok(!at(domDep - 2 * H - 60_000, dom).includes("f1:remind:leave"));
    assert.ok(at(domDep - 2 * H, dom).includes("f1:remind:leave"));
    assert.ok(!isDomestic(flight()));
    assert.ok(
      isDomestic(flight({ from: { tz: "America/New_York" }, to: { tz: "America/Los_Angeles" } })),
    );
    assert.ok(
      !isDomestic(flight({ from: { tz: "America/Toronto" }, to: { tz: "America/Los_Angeles" } })),
    );
  });

  it("uses the right offset on DST weekends (Madrid 26 Oct, Los Angeles 2 Nov)", () => {
    const mad = flight({ depLocal: "2025-10-26T08:00" }); // CET after the switch -> 07:00Z
    assert.ok(at(Date.parse("2025-10-26T04:00:00Z"), mad).includes("f1:remind:leave"));
    assert.ok(!at(Date.parse("2025-10-26T03:59:00Z"), mad).includes("f1:remind:leave"));
    const lax = flight({
      from: { iata: "LAX", tz: "America/Los_Angeles" },
      to: { iata: "BCN", tz: "Europe/Madrid" },
      depLocal: "2025-11-02T15:30",
      arrLocal: "2025-11-03T11:45",
    }); // PST after the switch -> 23:30Z
    assert.ok(at(Date.parse("2025-11-02T20:30:00Z"), lax).includes("f1:remind:leave"));
    assert.ok(!at(Date.parse("2025-11-02T20:29:00Z"), lax).includes("f1:remind:leave"));
    const leave = reminders(trip([lax]), { segments: {} }, Date.parse("2025-11-02T21:00:00Z")).find(
      (e) => e.key === "f1:remind:leave",
    );
    assert.match(leave.body, /15:30 PST/);
  });

  it("no reminders for a flight that is not booked; no booking code in the text", () => {
    assert.deepEqual(at(DEP - 3 * H, flight({ confirmed: false })), []);
    const r = reminders(trip([flight()]), { segments: {} }, DEP - 3 * H);
    assert.equal(r.length, 2);
    assert.ok(r.every((e) => !e.body.includes("ABC123")));
  });

  it("no reminders for a cancelled or departed flight", () => {
    assert.deepEqual(at(DEP - 3 * H, flight(), { f1: live({ status: "cancelled" }) }), []);
    assert.deepEqual(at(DEP - 3 * H, flight(), { f1: live({ status: "departed" }) }), []);
  });
});

describe("odd trip.json input", () => {
  it("an unknown zone or a malformed segment does not stop the other flights", () => {
    const bad = flight({ id: "f9", from: { iata: "BCN", tz: "Europe/Valencia" } });
    const t = trip([null, 42, bad, flight({ depLocal: 20251021 }), flight({ id: "f2" })]);
    const { tripView } = trip_io;
    const view = tripView(t);
    assert.deepEqual(
      watchedFlights(view, { segments: {} }, DEP - H).map((s) => s.id),
      ["f9", "f2"],
    );
    assert.ok(keys(reminders(view, { segments: {} }, DEP - 3 * H)).includes("f2:remind:leave"));
  });
});

describe("which flights are watched", () => {
  it("36 h ahead, in the air, and up to 2 h after landing", () => {
    const t = trip([flight()]);
    const arr = Date.parse("2025-10-22T02:20:00Z");
    const w = (ms, st = {}) => watchedFlights(t, { segments: st }, ms).length;
    assert.equal(w(DEP - 37 * H), 0);
    assert.equal(w(DEP - 35 * H), 1);
    assert.equal(w(DEP + 5 * H), 1);
    assert.equal(w(arr + H), 1);
    assert.equal(w(arr + 2 * H + 60_000), 0);
    // A late landing keeps it watched longer.
    assert.equal(
      w(arr + 2 * H + 60_000, {
        f1: live({ status: "landed", actArr: new Date(arr + H).toISOString() }),
      }),
      1,
    );
    assert.equal(
      watchedFlights(trip([flight({ carrier: "" })]), { segments: {} }, DEP - H).length,
      0,
    );
  });
});

describe("sender", () => {
  const statusOut =
    "[plugins/registry] some log line\n" +
    JSON.stringify({
      ts: 1,
      nodes: [
        { nodeId: "mac-1", platform: "macos", connected: true },
        { nodeId: "phone-1", platform: "Android", connected: true },
      ],
    });

  it("parses CLI json behind log lines and picks the connected android node", () => {
    assert.equal(pickAndroidNode(parseCliJson(statusOut)), "phone-1");
    assert.equal(
      pickAndroidNode({ nodes: [{ nodeId: "p", platform: "android", connected: false }] }),
      null,
    );
  });

  it("invokes system.notify with the Android handler's param names", async () => {
    const calls = [];
    const send = makeSender({
      env: {},
      run: async (args) => {
        calls.push(args);
        return args[1] === "status" ? statusOut : "{}";
      },
    });
    assert.equal(await send({ level: "critical", title: "ZX 101 CANCELLED", body: "b" }), true);
    const inv = calls.find((c) => c[1] === "invoke");
    assert.deepEqual(inv.slice(0, 6), [
      "nodes",
      "invoke",
      "--node",
      "phone-1",
      "--command",
      "system.notify",
    ]);
    const params = JSON.parse(inv[inv.indexOf("--params") + 1]);
    assert.deepEqual(Object.keys(params).toSorted(), ["body", "priority", "title"]);
    assert.equal(params.priority, "timeSensitive");
  });

  it("a failed invoke is logged without the notification text", async () => {
    const logs = [];
    const err = Object.assign(
      new Error("Command failed: openclaw nodes invoke --params {secret}"),
      {
        code: 3,
        stderr: "warn\nnode not connected\n",
      },
    );
    assert.equal(errSummary(err), "code 3, node not connected");
    await makeSender({
      env: { TRIP_NOTIFY_NODE: "phone-1" },
      log: (m) => logs.push(m),
      run: async () => {
        throw err;
      },
    })({ level: "info", title: "t", body: "secret body" });
    assert.ok(logs.every((l) => !l.includes("secret")));
  });

  it("falls back to WhatsApp only when TRIP_WHATSAPP_TARGET is set", async () => {
    const calls = [];
    const failing = async (args) => {
      calls.push(args);
      if (args[0] === "nodes") {
        throw new Error("node offline");
      }
      return "{}";
    };
    assert.equal(
      await makeSender({ env: { TRIP_NOTIFY_NODE: "phone-1" }, run: failing })({
        level: "info",
        title: "t",
        body: "b",
      }),
      false,
    );
    assert.ok(!calls.some((c) => c[0] === "message"));
    assert.equal(
      await makeSender({
        env: { TRIP_NOTIFY_NODE: "phone-1", TRIP_WHATSAPP_TARGET: "+10000000000" },
        run: failing,
      })({ level: "info", title: "t", body: "b" }),
      true,
    );
    const wa = calls.find((c) => c[0] === "message");
    assert.deepEqual(wa.slice(0, 6), [
      "message",
      "send",
      "--channel",
      "whatsapp",
      "--target",
      "+10000000000",
    ]);
  });
});

describe("runOnce", () => {
  it("writes alerts, state and html once; a second pass is quiet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-watch-"));
    try {
      fs.writeFileSync(path.join(dir, "trip.json"), JSON.stringify(trip([flight()])));
      const fetchStatus = async () => ({
        status: live({ depGate: "E77", estDep: "2025-10-21T14:45:00.000Z" }),
        provider: "fake",
        cached: false,
      });
      const sent = [];
      const send = async (m) => {
        sent.push(m);
        return true;
      };
      const now = DEP - 5 * H;
      const r1 = await runOnce({ dir, now, fetchStatus, send });
      assert.deepEqual(r1.events.map((e) => e.key).toSorted(), [
        "f1:delay:40:1",
        "f1:depGate:E77:1",
        "f1:remind:checkin",
      ]);
      assert.equal(sent.length, 1, "one bundled notification for the flight");
      const tripAfter = JSON.parse(fs.readFileSync(path.join(dir, "trip.json"), "utf8"));
      assert.equal(tripAfter.alerts.length, 3);
      const st = JSON.parse(fs.readFileSync(path.join(dir, "trip-state.json"), "utf8"));
      assert.equal(st.segments.f1.depGate, "E77");
      assert.equal(st.pending.length, 0);
      assert.ok(fs.readFileSync(path.join(dir, "trip.html"), "utf8").includes("delayed +40 min"));
      const r2 = await runOnce({ dir, now: now + 600_000, fetchStatus, send });
      assert.equal(r2.events.length, 0);
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders trip.html when trip.json changed even if no flight did", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-watch-"));
    try {
      const file = path.join(dir, "trip.json");
      fs.writeFileSync(file, JSON.stringify(trip([flight()])));
      const quiet = { now: DEP - 40 * H, fetchStatus: async () => null, send: async () => true };
      assert.ok(htmlStale(dir));
      await runOnce({ dir, ...quiet });
      assert.ok(fs.existsSync(path.join(dir, "trip.html")), "first pass renders a missing page");
      assert.ok(!htmlStale(dir));
      const t = trip([
        flight(),
        { id: "a1", type: "activity", date: "2025-10-23", title: "Ferry" },
      ]);
      fs.writeFileSync(file, JSON.stringify(t));
      const later = Date.now() / 1000 + 5;
      fs.utimesSync(file, later, later);
      assert.ok(htmlStale(dir));
      await runOnce({ dir, ...quiet });
      assert.match(fs.readFileSync(path.join(dir, "trip.html"), "utf8"), /Ferry/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a pass killed after writing alerts adds no duplicate alert and no second send", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-watch-"));
    try {
      fs.writeFileSync(path.join(dir, "trip.json"), JSON.stringify(trip([flight()])));
      const fetchStatus = async () => ({ status: live({ depGate: "E77" }), provider: "fake" });
      const now = DEP - 5 * H;
      // First pass: delivery "crashes" (send throws past the sender) after alerts are written.
      await assert.rejects(
        runOnce({
          dir,
          now,
          fetchStatus,
          send: async () => {
            throw Object.assign(new Error("killed"), { fatal: true });
          },
          log: (m) => {
            if (m.startsWith("notify failed")) {
              throw new Error("simulated crash");
            }
          },
        }),
      );
      const st = JSON.parse(fs.readFileSync(path.join(dir, "trip-state.json"), "utf8"));
      assert.equal(st.pending.length, 2, "events survive in pending");
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(dir, "trip.json"), "utf8")).alerts.length,
        2,
      );
      assert.ok(!fs.existsSync(path.join(dir, ".flight-watch.lock")), "lock released");
      const sent = [];
      await runOnce({ dir, now: now + 600_000, fetchStatus, send: async (m) => sent.push(m) });
      assert.equal(sent.length, 1);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(dir, "trip.json"), "utf8")).alerts.length,
        2,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendAlerts is idempotent; deliverPending saves after each send; one pass at a time", async () => {
    const ev = {
      at: "2025-10-21T10:00:00.000Z",
      segmentId: "f1",
      level: "info",
      title: "t",
      body: "b",
    };
    const once = appendAlerts({ alerts: [] }, [ev]);
    assert.equal(appendAlerts({ alerts: once }, [ev]).length, 1);
    const state = { notified: {}, pending: [] };
    queueEvents(
      state,
      [
        { ...ev, key: "f1:x" },
        { ...ev, key: "f2:y", segmentId: "f2" },
      ],
      0,
    );
    const saved = [];
    await deliverPending(
      state,
      async () => true,
      0,
      () => {},
      () => saved.push(state.pending.length),
    );
    assert.deepEqual(saved, [1, 0]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-watch-"));
    try {
      const release = takeLock(dir);
      assert.ok(release);
      assert.equal(takeLock(dir), null);
      release();
      assert.ok(takeLock(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run writes nothing and sends nothing; no trip.json is a quiet no-op", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-watch-"));
    try {
      assert.deepEqual(await runOnce({ dir, now: DEP }), { watched: 0, events: [], sent: [] });
      fs.writeFileSync(path.join(dir, "trip.json"), JSON.stringify(trip([flight()])));
      const before = fs.readdirSync(dir).toSorted();
      const r = await runOnce({
        dir,
        now: DEP - 2.5 * H,
        dryRun: true,
        fetchStatus: async () => null,
        send: async () => assert.fail("sent in dry-run"),
      });
      assert.ok(r.events.some((e) => e.key === "f1:remind:leave"));
      assert.deepEqual(fs.readdirSync(dir).toSorted(), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
