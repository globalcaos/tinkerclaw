import assert from "node:assert/strict";
import test from "node:test";
import {
  dhashFromGrayRaw,
  hammingDistance,
  clusterByImageHash,
  pickCheapestPerCluster,
  hashProductImages,
} from "../scripts/image-hash.mjs";

// 9x8 = 72 grayscale bytes. Build a known gradient (each row strictly
// increasing left→right) → every comparison is left<right → all bits 0.
function gradientRaw() {
  const raw = Buffer.alloc(72);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 9; col++) raw[row * 9 + col] = col * 28; // increasing
  }
  return raw;
}
// Reverse gradient (decreasing) → every comparison left>right → all bits 1.
function reverseGradientRaw() {
  const raw = Buffer.alloc(72);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 9; col++) raw[row * 9 + col] = (8 - col) * 28;
  }
  return raw;
}

test("dhashFromGrayRaw: increasing gradient → all zero bits", () => {
  assert.equal(dhashFromGrayRaw(gradientRaw()), "0000000000000000");
});

test("dhashFromGrayRaw: decreasing gradient → all one bits", () => {
  assert.equal(dhashFromGrayRaw(reverseGradientRaw()), "ffffffffffffffff");
});

test("dhashFromGrayRaw: throws on short buffer", () => {
  assert.throws(() => dhashFromGrayRaw(Buffer.alloc(10)), /expected >=72/);
});

test("hammingDistance: identical hashes → 0", () => {
  assert.equal(hammingDistance("ffffffffffffffff", "ffffffffffffffff"), 0);
});

test("hammingDistance: all-0 vs all-1 → 64", () => {
  assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
});

test("hammingDistance: one nibble flip → 4", () => {
  assert.equal(hammingDistance("0000000000000000", "000000000000000f"), 4);
});

test("clusterByImageHash: near-duplicates cluster, distinct stays apart", () => {
  const products = [
    { asin: "A", image_hash: "ffffffffffffffff", current_price_eur: 30 },
    { asin: "B", image_hash: "fffffffffffffff0", current_price_eur: 29 }, // 4 bits from A → same cluster
    { asin: "C", image_hash: "0000000000000000", current_price_eur: 50 }, // 64 bits → own cluster
  ];
  const clusters = clusterByImageHash(products, { threshold: 8 });
  assert.equal(clusters.length, 2);
  const big = clusters.find((c) => c.length === 2);
  assert.deepEqual(big.map((p) => p.asin).sort(), ["A", "B"]);
  assert.equal(products.find((p) => p.asin === "A").cluster_size, 2);
});

test("clusterByImageHash: products without hash are singletons", () => {
  const products = [
    { asin: "A", image_hash: null },
    { asin: "B", image_hash: null },
  ];
  const clusters = clusterByImageHash(products);
  assert.equal(clusters.length, 2);
});

test("pickCheapestPerCluster: keeps cheapest, flags copycats", () => {
  const products = [
    { asin: "A", image_hash: "ffffffffffffffff", current_price_eur: 30.0 },
    { asin: "B", image_hash: "fffffffffffffff0", current_price_eur: 29.99 }, // 1 cent cheaper copycat
    { asin: "C", image_hash: "0000000000000000", current_price_eur: 50.0 },
  ];
  const clusters = clusterByImageHash(products, { threshold: 8 });
  const reps = pickCheapestPerCluster(clusters);
  const repAsins = reps.map((r) => r.asin).sort();
  assert.deepEqual(repAsins, ["B", "C"]); // B beats A by a cent; C is its own cluster
  assert.equal(products.find((p) => p.asin === "A").cheaper_alternative_asin, "B");
  assert.equal(products.find((p) => p.asin === "B").cluster_member_count, 2);
});

test("hashProductImages: failures leave image_hash null, never throws", async () => {
  const products = [
    { asin: "A", image_url: "https://example.com/a.jpg" },
    { asin: "B", image_url: null }, // no url → skipped
  ];
  const badFetch = async () => {
    throw new Error("network down");
  };
  await hashProductImages(products, { _fetch: badFetch, concurrency: 2 });
  assert.equal(products[0].image_hash, null);
  assert.equal("image_hash" in products[1], false); // never attempted
});
