import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AmazonAdapter } from "../../adapters/AmazonAdapter.mjs";
import { extractSearchResults } from "../../scripts/extract-search.mjs";
import { refundTier } from "../../scripts/rank.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures", "search-ph-minus.html");

test("AmazonAdapter.extract() === extractSearchResults() on the fixture (PARITY)", async () => {
  const html = await readFile(FIX, "utf8");
  const adapter = new AmazonAdapter();
  const viaAdapter = adapter.extract(html, {});
  const viaLegacy = extractSearchResults(html);
  // Byte-for-byte identical normalized Listing[].
  assert.deepEqual(viaAdapter, viaLegacy);
  assert.ok(viaAdapter.length >= 10, `got ${viaAdapter.length}`);
});

test("AmazonAdapter.name is 'amazon'", () => {
  assert.equal(new AmazonAdapter().name, "amazon");
});

test("AmazonAdapter.search() returns OK + products via injected fetcher", async () => {
  const html = await readFile(FIX, "utf8");
  const fetcher = { get: async () => ({ outcome: "OK", body: html }) };
  const adapter = new AmazonAdapter();
  const r = await adapter.search("ph minus", { fetcher });
  assert.equal(r.outcome, "OK");
  assert.deepEqual(r.products, extractSearchResults(html));
});

test("AmazonAdapter.search() propagates BLOCKED from the fetcher", async () => {
  const fetcher = { get: async () => ({ outcome: "BLOCKED", reason: "captcha" }) };
  const adapter = new AmazonAdapter();
  const r = await adapter.search("ph minus", { fetcher });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "captcha");
});

test("AmazonAdapter.search() builds the canonical amazon.es /s?k= URL", async () => {
  let seen;
  const fetcher = {
    get: async (u) => {
      seen = u;
      return { outcome: "OK", body: "" };
    },
  };
  const adapter = new AmazonAdapter();
  await adapter.search("ph minus piscina", { fetcher });
  assert.equal(seen, "https://www.amazon.es/s?k=ph%20minus%20piscina");
});

test("AmazonAdapter.detailFetch() parses detail HTML on OK", async () => {
  const detailHtml = await readFile(join(HERE, "..", "fixtures", "detail-bisulfato.html"), "utf8");
  const fetcher = { get: async () => ({ outcome: "OK", body: detailHtml }) };
  const adapter = new AmazonAdapter();
  const r = await adapter.detailFetch({ url: "https://www.amazon.es/dp/X/" }, { fetcher });
  assert.equal(r.outcome, "OK");
  assert.ok("combined_text" in r.detailSpec);
});

test("AmazonAdapter.detailFetch() returns BLOCKED envelope on block", async () => {
  const fetcher = { get: async () => ({ outcome: "BLOCKED", reason: "rate-limit" }) };
  const adapter = new AmazonAdapter();
  const r = await adapter.detailFetch({ url: "https://www.amazon.es/dp/X/" }, { fetcher });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "rate-limit");
});

test("AmazonAdapter.rankMode() exposes the same refundTier as rank.mjs", () => {
  const mode = new AmazonAdapter().rankMode([], {});
  assert.equal(mode.refundTier, refundTier);
  // sold-by-amazon + in stock → tier 2
  assert.equal(mode.refundTier({ in_stock: 1, seller_is_amazon: 1 }), 2);
  // third-party + in stock → tier 1
  assert.equal(mode.refundTier({ in_stock: 1, seller_name: "Third Co" }), 1);
  // out of stock → tier 0
  assert.equal(mode.refundTier({ in_stock: 0, seller_is_amazon: 1 }), 0);
});

test("AmazonAdapter.classifyResponse() delegates to detect.mjs", () => {
  const adapter = new AmazonAdapter();
  assert.equal(adapter.classifyResponse({ status: 503, body: "" }).reason, "rate-limit");
  const ok = adapter.classifyResponse({
    status: 200,
    body: "<title>Amazon.es : x</title>" + "x".repeat(6000),
  });
  assert.equal(ok.outcome, "OK");
});
