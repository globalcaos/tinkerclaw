import assert from "node:assert/strict";
import test from "node:test";
import { AmazonAdapter } from "../../adapters/AmazonAdapter.mjs";
import {
  resolveAdapter,
  knownStores,
  isKnownStore,
  DEFAULT_STORE,
} from "../../adapters/registry.mjs";

test("DEFAULT_STORE is amazon", () => {
  assert.equal(DEFAULT_STORE, "amazon");
});

test("resolveAdapter('amazon') → AmazonAdapter", () => {
  const a = resolveAdapter("amazon");
  assert.ok(a instanceof AmazonAdapter);
  assert.equal(a.name, "amazon");
});

test("resolveAdapter() with no arg → default amazon", () => {
  assert.ok(resolveAdapter() instanceof AmazonAdapter);
});

test("resolveAdapter() is case-insensitive", () => {
  assert.ok(resolveAdapter("AMAZON") instanceof AmazonAdapter);
});

test("resolveAdapter() returns a fresh instance each call", () => {
  assert.notEqual(resolveAdapter("amazon"), resolveAdapter("amazon"));
});

test("resolveAdapter() throws on an unknown store", () => {
  assert.throws(() => resolveAdapter("ebay"), /unknown store "ebay"/);
});

test("amazon is the ONLY store this package can reach", () => {
  assert.deepEqual(knownStores(), ["amazon"]);
});

// Regression guard for the 1.2.1 scope cut. The classifieds adapters used to ship
// disabled behind AMAZON_SHOPPER_ENABLE_OTHER_STORES=1; a disabled scraper is still
// a shipped scraper. Setting the old flag must not resurrect anything.
test("the removed other-store flag no longer resolves anything", () => {
  process.env.AMAZON_SHOPPER_ENABLE_OTHER_STORES = "1";
  try {
    for (const gone of ["milanuncios", "wallapop"]) {
      assert.equal(isKnownStore(gone), false);
      assert.throws(() => resolveAdapter(gone), /unknown store/);
    }
    assert.deepEqual(knownStores(), ["amazon"]);
  } finally {
    delete process.env.AMAZON_SHOPPER_ENABLE_OTHER_STORES;
  }
});

test("isKnownStore() works case-insensitively", () => {
  assert.equal(isKnownStore("amazon"), true);
  assert.equal(isKnownStore("AMAZON"), true);
  assert.equal(isKnownStore("ebay"), false);
});
