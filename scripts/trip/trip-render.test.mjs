// node --test scripts/trip/trip-render.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { localToUtcMs, tzAbbr } from "./lib/time.mjs";
import { renderToDir, renderTripHtml, statusChip } from "./trip-render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const trip = JSON.parse(fs.readFileSync(path.join(here, "fixtures/trip.fixture.json"), "utf8"));
const state = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures/trip-state.fixture.json"), "utf8"),
);
const NOW = Date.parse("2025-10-20T16:00:00Z");

describe("trip-render", () => {
  const html = renderTripHtml(trip, state, { now: NOW });

  it("is one self-contained document with no external loads", () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<style>/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /<link[^>]+rel="?stylesheet/);
    assert.doesNotMatch(html, /<img /);
    assert.doesNotMatch(html, /url\(http/);
  });

  it("header, countdown and next up", () => {
    assert.match(html, /<h1>Test trip · Oct–Nov 2025<\/h1>/);
    assert.match(html, /id="hcd">ZX 101 · departs in 22 h 45 min</);
    assert.doesNotMatch(html, /<h2>Next up<\/h2>/);
    assert.match(html, /delayed \+40 min/);
  });

  it("alerts: a flight's alerts live on its status chip, others show newest first", () => {
    assert.doesNotMatch(html, /class="alert /);
    assert.match(html, /delayed \+40 min/);
    const t = {
      ...trip,
      alerts: [
        ...trip.alerts,
        { at: "2025-10-20T15:30:00.000Z", level: "warn", text: "Strike at the airport" },
        { at: "2025-10-20T15:10:00.000Z", level: "info", text: "Road closed" },
      ],
    };
    const h = renderTripHtml(t, state, { now: NOW });
    assert.match(h, /class="alert warn"[^>]*>.*Strike at the airport/);
    assert.ok(h.indexOf("Strike at the airport") < h.indexOf("Road closed"));
    assert.doesNotMatch(h, /old alert that must not show/);
    assert.doesNotMatch(h, /ZX 101 check-in is open/);
  });

  it("flight times as written, zone abbreviations and the home-time hint", () => {
    assert.match(html, /16:05<span class="tz">CEST<\/span>/);
    assert.match(html, /19:20<span class="tz">PDT<\/span>/);
    assert.match(html, /Wed 04:20 CEST at home/);
    assert.match(html, /now 16:45 CEST/);
    // Return flight after both DST switches.
    assert.match(html, /15:30<span class="tz">PST<\/span>/);
    assert.match(html, /11:45<span class="tz">CET<\/span> <sup>\+1<\/sup>/);
  });

  it("stay links, tap-to-copy, unconfirmed marks, checklist, contacts, questions", () => {
    assert.match(
      html,
      /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=1%20Example%20St/,
    );
    assert.match(html, /href="geo:37\.7879,-122\.4075\?q=/);
    assert.match(html, /data-copy="ABC123"/);
    assert.match(html, /JarvisNative/);
    assert.ok((html.match(/not booked \/ to confirm/g) ?? []).length >= 3);
    assert.match(html, /class="done"[^>]*>.*ESTA approved/);
    assert.match(html, /href="tel:\+14155550100"/);
    assert.match(html, /<h2>To confirm<\/h2>.*Which beach house/);
  });

  it("days are in order and grouped by local date", () => {
    const days = [...html.matchAll(/class="day[^"]*" data-date="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(days, [
      "2025-10-16",
      "2025-10-20",
      "2025-10-21",
      "2025-10-23",
      "2025-10-25",
      "2025-11-03",
    ]);
  });

  it("escapes text from trip.json", () => {
    const evil = renderTripHtml({ ...trip, title: '<script>alert("x")</script>' }, state, {
      now: NOW,
    });
    assert.doesNotMatch(evil, /<script>alert/);
    assert.match(evil, /&lt;script&gt;alert/);
  });

  it("an empty trip still renders", () => {
    const h = renderTripHtml({ version: 1, title: "Empty", segments: [] }, {}, { now: NOW });
    assert.match(h, /No segments yet/);
  });

  it("a segment with no date is shown under 'Date to confirm', not dropped", () => {
    const t = {
      ...trip,
      segments: [
        ...trip.segments,
        {
          id: "f9",
          type: "flight",
          confirmed: false,
          carrier: "ZX",
          number: "909",
          from: { iata: "AAA", tz: "America/Los_Angeles" },
          to: { iata: "BBB", tz: "America/New_York" },
          depLocal: null,
          arrLocal: null,
        },
      ],
    };
    const h = renderTripHtml(t, state, { now: NOW });
    assert.match(h, /<h3>Date to confirm<\/h3><article class="card flight tbc" data-seg="f9"/);
    assert.match(h.slice(h.indexOf("Date to confirm")), /not booked \/ to confirm/);
  });

  it("odd input (bad zone, null items, numbers for times) still renders the rest", () => {
    const t = structuredClone(trip);
    t.homeTz = "CET+1";
    t.segments[0].from.tz = "Europe/Valencia";
    t.segments.push(null, 7, { id: "x", type: "flight", depLocal: 20251021 });
    t.checklist.push(null);
    t.contacts = [null, ...t.contacts];
    const h = renderTripHtml(t, state, { now: NOW });
    assert.match(h, /data-seg="s1"/);
    assert.match(h, /ZX 101/);
    assert.match(h, /data-seg="x"/);
    const odd = renderTripHtml({ segments: { a: 1 }, checklist: "x", title: 5 }, {}, { now: NOW });
    assert.match(odd, /<h1>5<\/h1>/);
  });

  it("overdue checklist marks are refreshed by the page itself", () => {
    assert.match(html, /querySelectorAll\("\.check li\[data-due\]"\)/);
  });

  it("checklist items sit in their day of the plan, fold by group, and are tappable", () => {
    const t = {
      ...trip,
      checklist: [
        { text: "check in", group: "Before leaving", due: "2025-10-20" },
        { text: "belt", group: "Clothes" },
        { text: "suit", group: "Trade fair", done: true },
        { text: "taxi", group: "Before the flight", due: "2025-10-21" },
      ],
    };
    const h = renderTripHtml(t, state, { now: NOW });
    const day = (d) => h.indexOf(`data-date="${d}"`);
    assert.ok(
      day("2025-10-20") < h.indexOf('data-k="check in"') &&
        h.indexOf('data-k="check in"') < day("2025-10-21"),
    );
    // Undated packing lands on departure day, before that day's flight; the dated item after it.
    assert.ok(day("2025-10-21") < h.indexOf('data-k="belt"'));
    assert.ok(h.indexOf('data-k="belt"') < h.indexOf('data-k="taxi"'));
    assert.ok(h.indexOf('data-k="taxi"') < h.indexOf("ZX 101", day("2025-10-21")));
    assert.match(h, /<details class="cgroup" data-g="Before leaving" open>/);
    assert.match(h, /<details class="cgroup" data-g="Clothes">/);
    assert.match(
      h,
      /data-g="Trade fair"><summary><span class="cg-name">☐ Trade fair<\/span><span class="cg-count">1\/1/,
    );
    assert.doesNotMatch(h, /<h2>Checklist<\/h2>/);
    assert.match(h, /trip-check:/);
    assert.match(h, /trip-fold:/);
  });

  it("status chip vocabulary", () => {
    const seg = trip.segments[0];
    const base = state.segments.f1;
    assert.equal(statusChip(seg, undefined, NOW).text, "no live status yet");
    assert.equal(
      statusChip(seg, { ...base, status: "scheduled", estDep: null }, NOW).text,
      "on time",
    );
    assert.equal(statusChip(seg, base, NOW).text, "delayed +40 min");
    assert.equal(statusChip(seg, { ...base, status: "cancelled" }, NOW).tone, "critical");
    assert.equal(statusChip(seg, { ...base, status: "landed" }, NOW).text, "landed");
  });

  it("renderToDir writes trip.html atomically into TRIP_DIR", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-render-"));
    try {
      assert.equal(renderToDir(dir, { now: NOW }), null);
      fs.writeFileSync(path.join(dir, "trip.json"), JSON.stringify(trip));
      const out = renderToDir(dir, { now: NOW });
      assert.equal(out, path.join(dir, "trip.html"));
      assert.match(fs.readFileSync(out, "utf8"), /no live status yet/);
      assert.deepEqual(fs.readdirSync(dir).toSorted(), ["trip.html", "trip.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("time helpers", () => {
  it("wall clock -> instant across DST, and zone abbreviations", () => {
    assert.equal(
      new Date(localToUtcMs("2025-10-21T16:05", "Europe/Madrid")).toISOString(),
      "2025-10-21T14:05:00.000Z",
    );
    assert.equal(
      new Date(localToUtcMs("2025-10-27T16:05", "Europe/Madrid")).toISOString(),
      "2025-10-27T15:05:00.000Z",
    );
    assert.equal(
      new Date(localToUtcMs("2025-11-03T15:30", "America/Los_Angeles")).toISOString(),
      "2025-11-03T23:30:00.000Z",
    );
    assert.equal(tzAbbr(Date.parse("2025-10-21T14:05:00Z"), "Europe/Madrid"), "CEST");
    assert.equal(tzAbbr(Date.parse("2025-10-21T14:05:00Z"), "America/Los_Angeles"), "PDT");
    assert.equal(tzAbbr(Date.parse("2025-11-03T14:05:00Z"), "America/New_York"), "EST");
  });
});
