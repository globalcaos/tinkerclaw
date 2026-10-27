// node --test scripts/trip/providers.test.mjs
// Fixtures are trimmed real pages captured 2026-10-19 with airline, flight number and airports swapped
// and every date moved back 52 weeks (weekdays and DST order kept), so no real travel date is in here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as aerodatabox from "./providers/aerodatabox.mjs";
import * as flightaware from "./providers/flightaware.mjs";
import * as flightstats from "./providers/flightstats.mjs";
import { POLITE_MS, fetchFlightStatus, queryFor } from "./providers/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => fs.readFileSync(path.join(here, "fixtures", f), "utf8");

describe("flightstats parser", () => {
  it("scheduled flight", () => {
    const s = flightstats.parse(fx("flightstats-scheduled.page.txt"), {
      from: "MAD",
      to: "LAX",
      depDateLocal: "2025-10-21",
    });
    assert.equal(s.status, "scheduled");
    assert.equal(s.schedDep, "2025-10-21T14:05:00.000Z");
    assert.equal(s.schedArr, "2025-10-22T02:20:00.000Z");
    assert.equal(s.depTerminal, "1");
    assert.equal(s.depGate, null);
    assert.equal(s.source, "flightstats");
  });

  it("landed flight with gates and belt", () => {
    const s = flightstats.parse(fx("flightstats-landed.page.txt"), {
      from: "MAD",
      depDateLocal: "2025-10-19",
    });
    assert.equal(s.status, "landed");
    assert.equal(s.actDep, "2025-10-19T14:08:00.000Z");
    assert.equal(s.actArr, "2025-10-20T02:47:00.000Z");
    assert.equal(s.depGate, "E77");
    assert.equal(s.arrGate, "G2");
    assert.equal(s.baggage, "CL4");
  });

  it("flight in the air", () => {
    const s = flightstats.parse(fx("flightstats-departed.page.txt"), {
      from: "FRA",
      depDateLocal: "2025-10-20",
    });
    assert.equal(s.status, "departed");
    assert.equal(s.actDep, "2025-10-20T08:49:00.000Z");
    assert.equal(s.estArr, "2025-10-20T19:57:00.000Z");
    assert.equal(s.actArr, null);
  });

  it("rejects another day, another origin, or a page without data", () => {
    assert.equal(
      flightstats.parse(fx("flightstats-scheduled.page.txt"), {
        from: "MAD",
        depDateLocal: "2025-10-22",
      }),
      null,
    );
    assert.equal(
      flightstats.parse(fx("flightstats-scheduled.page.txt"), {
        from: "BCN",
        depDateLocal: "2025-10-21",
      }),
      null,
    );
    assert.equal(flightstats.parse("<html>nothing</html>", {}), null);
  });

  it("builds the tracker URL from the local date", () => {
    assert.equal(
      flightstats.url({ carrier: "ZX", number: "101", depDateLocal: "2025-10-21" }),
      "https://www.flightstats.com/v2/flight-tracker/ZX/101?year=2025&month=10&date=21",
    );
  });
});

describe("flightaware parser", () => {
  it("finds the upcoming leg by origin-local date in the activity log", () => {
    const s = flightaware.parse(fx("flightaware-upcoming.page.txt"), {
      from: "MAD",
      depDateLocal: "2025-10-21",
    });
    assert.equal(s.status, "scheduled");
    assert.equal(s.schedDep, "2025-10-21T14:05:00.000Z");
    assert.equal(s.depTerminal, "1");
  });

  it("past leg is landed with actual times and gates", () => {
    const s = flightaware.parse(fx("flightaware-upcoming.page.txt"), {
      from: "MAD",
      depDateLocal: "2025-10-19",
    });
    assert.equal(s.status, "landed");
    assert.ok(s.actArr);
    assert.equal(s.depGate, "E77");
  });

  it("airborne leg is departed", () => {
    const s = flightaware.parse(fx("flightaware-airborne.page.txt"), {
      from: "FRA",
      depDateLocal: "2025-10-20",
    });
    assert.equal(s.status, "departed");
    assert.ok(s.actDep);
    assert.equal(s.actArr, null);
    assert.equal(s.depGate, "Z23");
  });

  it("no leg on that date -> null; ICAO ident used when known", () => {
    assert.equal(
      flightaware.parse(fx("flightaware-upcoming.page.txt"), {
        from: "MAD",
        depDateLocal: "2025-12-02",
      }),
      null,
    );
    assert.match(flightaware.url({ carrier: "LH", number: "454" }), /\/live\/flight\/DLH454$/);
    assert.match(flightaware.url({ carrier: "ZZ", number: "1" }), /\/live\/flight\/ZZ1$/);
  });
});

describe("aerodatabox parser (key-gated, synthetic sample)", () => {
  it("maps the documented shape", () => {
    const s = aerodatabox.parse(
      [
        {
          status: "Expected",
          departure: {
            airport: { iata: "MAD" },
            scheduledTime: { utc: "2025-10-21 14:05Z" },
            revisedTime: { utc: "2025-10-21 14:40Z" },
            terminal: "4S",
            gate: "S12",
          },
          arrival: {
            airport: { iata: "LAX" },
            scheduledTime: { utc: "2025-10-22 02:20Z" },
            baggageBelt: "7",
          },
        },
      ],
      { from: "MAD" },
    );
    assert.equal(s.status, "delayed");
    assert.equal(s.estDep, "2025-10-21T14:40:00.000Z");
    assert.equal(s.depGate, "S12");
    assert.equal(s.baggage, "7");
    assert.equal(aerodatabox.enabled({}), false);
  });
});

describe("provider chain", () => {
  const seg = {
    carrier: "zx",
    number: "0101",
    depLocal: "2025-10-21T16:05",
    from: { iata: "MAD" },
    to: { iata: "LAX" },
  };
  const ok = (name) => ({ status: "scheduled", source: name });

  it("normalises the query", () => {
    assert.deepEqual(queryFor(seg), {
      carrier: "ZX",
      number: "101",
      depDateLocal: "2025-10-21",
      from: "MAD",
      to: "LAX",
    });
  });

  it("falls through misses and errors, and is polite within the window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-prov-"));
    try {
      const calls = [];
      const providers = [
        {
          name: "a",
          fetchStatus: async () => {
            calls.push("a");
            return null;
          },
        },
        {
          name: "b",
          fetchStatus: async () => {
            calls.push("b");
            throw new Error("boom");
          },
        },
        {
          name: "c",
          fetchStatus: async () => {
            calls.push("c");
            return ok("c");
          },
        },
        {
          name: "d",
          enabled: () => false,
          fetchStatus: async () => assert.fail("disabled provider called"),
        },
      ];
      const cacheFile = path.join(dir, "cache.json");
      const t0 = Date.parse("2025-10-21T10:00:00Z");
      const logs = [];
      const r1 = await fetchFlightStatus(seg, {
        providers,
        cacheFile,
        now: t0,
        log: (m) => logs.push(m),
      });
      assert.equal(r1.provider, "c");
      assert.equal(r1.cached, false);
      assert.deepEqual(calls, ["a", "b", "c"]);
      assert.match(logs[0], /b: boom/);
      // Inside the window: a's miss and c's hit are cached; b failed so it is retried.
      const r2 = await fetchFlightStatus(seg, { providers, cacheFile, now: t0 + 60_000 });
      assert.equal(r2.cached, true);
      assert.deepEqual(calls, ["a", "b", "c", "b"]);
      await fetchFlightStatus(seg, { providers, cacheFile, now: t0 + POLITE_MS + 1 });
      assert.deepEqual(calls.slice(4), ["a", "b", "c"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips segments without carrier, number or a date", async () => {
    assert.equal(await fetchFlightStatus({ ...seg, number: "" }, { providers: [] }), null);
    assert.equal(await fetchFlightStatus({ ...seg, depLocal: "" }, { providers: [] }), null);
  });
});
