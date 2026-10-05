// Regression tests for the 2026-08-06 microSD failure: the extractor reported
// ZERO next-day options on a page containing 40 of them, and produced
// "https://www.amazon.es#" as every product link.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractSearchResults } from "../scripts/extract-search.mjs";
import { parseMemCardSpec, speedTier } from "../scripts/memcard-spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "search-microsd-delivery.html");
const load = async () => extractSearchResults(await readFile(FIX, "utf8"));

test("every product link is a usable /dp/<ASIN> URL, never '#'", async () => {
  for (const p of await load()) {
    assert.match(p.url, /^https:\/\/www\.amazon\.es\/dp\/[A-Z0-9]{10}$/, `bad url: ${p.url}`);
  }
});

test("next-day delivery is detected in the Spanish no-'el' + randomised-id shape", async () => {
  const p = (await load()).find((x) => x.asin === "B09X7DQJQL");
  assert.equal(p.delivery_fastest, "mañana, 7 de ago");
  assert.equal(p.delivery_tomorrow, true);
});

test("next-day delivery is detected in the English logged-in-tab shape", async () => {
  const p = (await load()).find((x) => x.asin === "B0FFENGLSH");
  assert.equal(p.delivery_tomorrow, true);
});

test("English 'Or fastest delivery' and 'FREE delivery' both parse", async () => {
  const p = (await load()).find((x) => x.asin === "B0FFENGLS2");
  assert.equal(p.delivery_free, "Mon, 10 Aug");
  assert.equal(p.delivery_fastest, "Sat, 8 Aug");
  assert.equal(p.delivery_tomorrow, false, "a Saturday date is not 'tomorrow'");
});

test("a delivery DATE RANGE is never counted as next-day", async () => {
  const p = (await load()).find((x) => x.asin === "B0DSVTSTY4");
  assert.equal(p.delivery_free, "10 - 11 de ago");
  assert.equal(p.delivery_tomorrow, false);
});

test("sponsored cards are flagged and the title prefix is stripped", async () => {
  const p = (await load()).find((x) => x.asin === "B09X7DQJQL");
  assert.equal(p.is_sponsored, true);
  assert.ok(!/Anuncio patrocinado/i.test(p.title), `prefix left in: ${p.title}`);
});

test("capacity parses GB and TB, including '1TB' → 1024", () => {
  assert.equal(parseMemCardSpec("SanDisk 512 GB microSDXC").capacity_gb, 512);
  assert.equal(parseMemCardSpec("SanDisk Extreme PRO 1TB microSDXC").capacity_gb, 1024);
  assert.equal(parseMemCardSpec("Kingston 128GB").capacity_gb, 128);
});

test("speed markings parse out of a real title", () => {
  const s = parseMemCardSpec(
    "SanDisk Extreme Tarjeta Micro SDXC 128GB + adaptador SD, V30, hasta 190 MB/s, A2 C10 U3 UHS-I",
  );
  assert.equal(s.video_class, 30);
  assert.equal(s.app_class, 2);
  assert.equal(s.uhs_class, 3);
  assert.equal(s.speed_class, 10);
  assert.equal(s.bus, "UHS-I");
  assert.equal(s.read_mbs, 190);
});

test("UHS-II is not mistaken for UHS-I", () => {
  assert.equal(parseMemCardSpec("Lexar 256GB UHS-II V60").bus, "UHS-II");
  assert.equal(parseMemCardSpec("SanDisk 256GB UHS-I U1").bus, "UHS-I");
});

test("tier ranks by sustained write and IOPS, not by the headline MB/s", () => {
  const flashy = speedTier(parseMemCardSpec("NoName 512GB hasta 200 MB/s"));
  const solid = speedTier(parseMemCardSpec("Samsung 512GB V30 A2 U3 UHS-I hasta 130 MB/s"));
  assert.ok(
    solid.rank > flashy.rank,
    "A2/V30 must outrank an unmarked card with a bigger MB/s number",
  );
  assert.equal(solid.label, "V30 · A2");
});

test("an unmarked card is reported as unknown rather than guessed", () => {
  assert.equal(speedTier(parseMemCardSpec("Tarjeta Micro SD 128 GB")).rank, 0);
});
