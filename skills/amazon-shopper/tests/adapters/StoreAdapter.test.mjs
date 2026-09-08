import assert from "node:assert/strict";
import test from "node:test";
import { StoreAdapter } from "../../adapters/StoreAdapter.mjs";

test("base StoreAdapter.search() throws (required, unimplemented)", async () => {
  const a = new StoreAdapter();
  await assert.rejects(() => a.search("x", {}), /search\(\) not implemented/);
});

test("base StoreAdapter.extract() throws (required, unimplemented)", () => {
  const a = new StoreAdapter();
  assert.throws(() => a.extract("<html>", {}), /extract\(\) not implemented/);
});

test("base StoreAdapter.name throws (must be overridden)", () => {
  const a = new StoreAdapter();
  assert.throws(() => a.name, /'name' getter not implemented/);
});

test("optional detailFetch() defaults to null", async () => {
  const a = new StoreAdapter();
  assert.equal(await a.detailFetch("id"), null);
});

test("optional rankMode() defaults to null", () => {
  const a = new StoreAdapter();
  assert.equal(a.rankMode([], {}), null);
});

test("optional classifyResponse() defaults to OK", () => {
  const a = new StoreAdapter();
  assert.deepEqual(a.classifyResponse({ status: 200, body: "" }), { outcome: "OK" });
});

test("a subclass that overrides required methods does NOT throw", async () => {
  class Sub extends StoreAdapter {
    get name() {
      return "sub";
    }
    async search() {
      return [{ asin: "X", position: 1, title: "t", url: "u" }];
    }
    extract() {
      return [];
    }
  }
  const s = new Sub();
  assert.equal(s.name, "sub");
  assert.deepEqual(s.extract("raw", {}), []);
  const r = await s.search("k", {});
  assert.equal(r[0].asin, "X");
});
