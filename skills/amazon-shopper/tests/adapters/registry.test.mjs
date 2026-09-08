import assert from "node:assert/strict";
import test from "node:test";
import { AmazonAdapter } from "../../adapters/AmazonAdapter.mjs";
import { MilanunciosAdapter } from "../../adapters/MilanunciosAdapter.mjs";
import {
  resolveAdapter,
  knownStores,
  isKnownStore,
  DEFAULT_STORE,
} from "../../adapters/registry.mjs";
import { WallapopAdapter } from "../../adapters/WallapopAdapter.mjs";

// The non-Amazon adapters are outside the skill's declared scope and are refused
// unless explicitly enabled. These tests opt in; the gate itself is tested below.
test.beforeEach(() => {
  process.env.AMAZON_SHOPPER_ENABLE_OTHER_STORES = "1";
});
test.afterEach(() => {
  delete process.env.AMAZON_SHOPPER_ENABLE_OTHER_STORES;
});

test("non-Amazon stores are refused unless explicitly enabled", () => {
  delete process.env.AMAZON_SHOPPER_ENABLE_OTHER_STORES;
  assert.throws(
    () => resolveAdapter("milanuncios"),
    /outside this skill's declared amazon\.es scope/,
  );
  assert.throws(() => resolveAdapter("wallapop"), /outside this skill's declared amazon\.es scope/);
  // amazon is never gated
  assert.equal(resolveAdapter("amazon").name, "amazon");
});

test("DEFAULT_STORE is amazon", () => {
  assert.equal(DEFAULT_STORE, "amazon");
});

test("resolveAdapter('amazon') → AmazonAdapter", () => {
  const a = resolveAdapter("amazon");
  assert.ok(a instanceof AmazonAdapter);
  assert.equal(a.name, "amazon");
});

test("resolveAdapter('milanuncios') → MilanunciosAdapter", () => {
  const a = resolveAdapter("milanuncios");
  assert.ok(a instanceof MilanunciosAdapter);
  assert.equal(a.name, "milanuncios");
});

test("resolveAdapter('wallapop') → WallapopAdapter", () => {
  const a = resolveAdapter("wallapop");
  assert.ok(a instanceof WallapopAdapter);
  assert.equal(a.name, "wallapop");
});

test("resolveAdapter() with no arg → default amazon", () => {
  assert.ok(resolveAdapter() instanceof AmazonAdapter);
});

test("resolveAdapter() is case-insensitive", () => {
  assert.ok(resolveAdapter("AMAZON") instanceof AmazonAdapter);
  assert.ok(resolveAdapter("Milanuncios") instanceof MilanunciosAdapter);
});

test("resolveAdapter() returns a fresh instance each call", () => {
  assert.notEqual(resolveAdapter("amazon"), resolveAdapter("amazon"));
});

test("resolveAdapter() throws on an unknown store", () => {
  assert.throws(() => resolveAdapter("ebay"), /unknown store "ebay"/);
});

test("knownStores() lists the three Phase 0 stores", () => {
  assert.deepEqual(knownStores().sort(), ["amazon", "milanuncios", "wallapop"]);
});

test("isKnownStore() works case-insensitively", () => {
  assert.equal(isKnownStore("amazon"), true);
  assert.equal(isKnownStore("WALLAPOP"), true);
  assert.equal(isKnownStore("ebay"), false);
});
