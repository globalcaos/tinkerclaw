import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractSearchResults } from "../scripts/extract-search.mjs";
import {
  parseSdCard,
  parseCapacityGb,
  parsePackCount,
  parseSpeedMarks,
  speedTier,
} from "../scripts/sdcard-spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_EN = join(HERE, "fixtures", "search-microsd-en.html");

// --- capacity ------------------------------------------------------------
test("capacity: TB is normalised to GB", () => {
  assert.equal(parseCapacityGb("Lexar Blue 1TB Micro SD Card, Up to 160MB/s"), 1024);
  assert.equal(parseCapacityGb("SanDisk 512GB Extreme Go"), 512);
  assert.equal(parseCapacityGb("Netac 3 Packs of 64G Micro SDXC"), 64);
});

test("capacity: absent means null, never a guess", () => {
  assert.equal(parseCapacityGb("High Speed High Capacity Micro SD TF Memory Card"), null);
});

// --- packs ---------------------------------------------------------------
test("pack count is parsed so €/GB compares single cards", () => {
  assert.equal(parsePackCount("GIGASTONE 32GB Micro SD, Pack of 5"), 5);
  assert.equal(parsePackCount("1GB Class 4 microSD Memory Card (2 Pack, 1GB)"), 2);
  assert.equal(parsePackCount("SanDisk Extreme 128GB"), 1);
});

// --- the markings --------------------------------------------------------
test("speed marks are read independently, not as alternatives", () => {
  const m = parseSpeedMarks("SanDisk Extreme 128GB microSDXC UHS-I A2 U3 V30 Class 10");
  assert.deepEqual(m, { app: "A2", uhs: "U3", video: "V30", legacy: "C10", bus: "UHS-I" });
});

test("a card with no class marks is Unrated, not assumed Basic", () => {
  const spec = parseSdCard("GIGASTONE Micro SD Card 256GB, Speed up to 100MB/s");
  assert.equal(spec.marks_label, "");
  assert.equal(spec.name, "Unrated");
});

test("A2 outranks a big sequential-read number for the OS-disk case", () => {
  const a2 = parseSdCard("Lexar 512GB microSDXC A2 U3 V30 Class 10, up to 160MB/s");
  const a1 = parseSdCard("SanDisk Ultra 512GB microSDXC A1 U1 Class 10, up to 200MB/s");
  assert.equal(a2.name, "Fast");
  assert.ok(a2.tier > a1.tier, "A2+U3 must rank above A1+U1 despite the lower MB/s headline");
});

test("UHS-II / V60 reaches the Pro tier", () => {
  assert.equal(
    speedTier({ app: null, uhs: null, video: "V60", legacy: null, bus: null }, null).name,
    "Pro",
  );
  assert.equal(
    speedTier({ app: null, uhs: null, video: null, legacy: null, bus: "UHS-II" }, null).name,
    "Pro",
  );
});

// --- English (logged-in tab) delivery ------------------------------------
test("logged-in English markup yields a next-day promise", async () => {
  const html = await readFile(FIX_EN, "utf8");
  const rows = extractSearchResults(html);
  assert.ok(rows.length >= 3, `expected >=3 cards, got ${rows.length}`);
  for (const r of rows) {
    assert.ok(r.delivery_free || r.delivery_fastest, `no delivery text for ${r.asin}`);
    assert.equal(r.delivery_tomorrow, true, `next-day not detected for ${r.asin}`);
  }
});

test("every parsed row carries a usable product link", async () => {
  const html = await readFile(FIX_EN, "utf8");
  for (const r of extractSearchResults(html)) {
    assert.match(r.url, /^https:\/\/www\.amazon\.es\/dp\/[A-Z0-9]{10}$/);
  }
});

// Regression: the 2026-08-06 chart shipped with zero next-day options because
// the extractor spoke only Spanish while the shared tab served /-/en/. A row
// count alone would have passed — the DERIVED field was the broken one.
test("delivery is asserted as a derived field, not just a row count", async () => {
  const html = await readFile(FIX_EN, "utf8");
  const rows = extractSearchResults(html);
  assert.notEqual(rows.filter((r) => r.delivery_tomorrow).length, 0);
});

// Regression 2026-08-06: an "SD2Vita Adapter … supports microSD 256GB" at €6.95
// scored 0.027 €/GB and ranked as the best buy on the chart. A €/GB ranking is
// only meaningful across things that actually store the GB.
test("accessories are not priced as if they were cards", async () => {
  const { isAccessory, parseCapacityGb } = await import("../scripts/sdcard-spec.mjs");
  assert.equal(
    isAccessory("SD2Vita 6.0 Adapter for PS Vita 1000/2000 | Supports microSD/TF"),
    true,
  );
  assert.equal(
    isAccessory("EMSea 2 x Dual SD/TF Card to MS Speicherkartenhalter CR5400 512"),
    true,
  );
  assert.equal(parseCapacityGb("TECHZOCO PS Vita Card Adapter, SD2Vita, Compatible 256GB"), null);
  assert.equal(isAccessory("SanDisk Extreme 128GB Micro SDXC Card + SD Adapter"), false);
});

test("a supported-capacity limit is not the product's own capacity", async () => {
  const { parseCapacityGb } = await import("../scripts/sdcard-spec.mjs");
  assert.equal(parseCapacityGb("USB card reader, supports up to 512GB"), null);
  assert.equal(parseCapacityGb("Dash cam mount compatible with 256GB"), null);
  // …but a real card keeps its capacity even when it also lists a bus limit.
  assert.equal(parseCapacityGb("Lexar 512GB microSDXC UHS-I up to 160MB/s"), 512);
});
