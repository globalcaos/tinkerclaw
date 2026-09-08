import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractSearchResults } from "../scripts/extract-search.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "search-ph-minus.html");

test("extracts at least 10 products from fixture", async () => {
  const html = await readFile(FIX, "utf8");
  const products = extractSearchResults(html);
  assert.ok(products.length >= 10, `got ${products.length}`);
});

test("each product has asin, title, url, position", async () => {
  const html = await readFile(FIX, "utf8");
  const products = extractSearchResults(html);
  for (const p of products) {
    assert.match(p.asin, /^[A-Z0-9]{10}$/, `bad asin ${p.asin}`);
    assert.ok(p.title?.length > 5, `bad title for ${p.asin}: ${p.title}`);
    assert.match(p.url, /^https:\/\/www\.amazon\.es\//, `bad url for ${p.asin}: ${p.url}`);
    assert.ok(p.position > 0);
  }
});

test("at least half the products have a price", async () => {
  const html = await readFile(FIX, "utf8");
  const products = extractSearchResults(html);
  const priced = products.filter((p) => p.current_price_eur != null);
  assert.ok(
    priced.length >= products.length / 2,
    `only ${priced.length}/${products.length} priced`,
  );
});

test("prime products are flagged", async () => {
  const html = await readFile(FIX, "utf8");
  const products = extractSearchResults(html);
  const prime = products.filter((p) => p.is_prime);
  assert.ok(prime.length >= 1, "expect at least 1 prime product in fixture");
});
