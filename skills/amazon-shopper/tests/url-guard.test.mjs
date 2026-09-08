import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAmazonPageUrl,
  isAmazonPageUrl,
  isPrivateAddress,
  fetchImageSafely,
  UrlNotAllowed,
} from "../scripts/url-guard.mjs";

test("assertAmazonPageUrl accepts amazon.es over HTTPS", () => {
  assert.equal(assertAmazonPageUrl("https://www.amazon.es/s?k=x"), "https://www.amazon.es/s?k=x");
  assert.ok(isAmazonPageUrl("https://amazon.es/dp/B000000000"));
});

test("assertAmazonPageUrl refuses plaintext, other hosts, and embedded credentials", () => {
  assert.throws(() => assertAmazonPageUrl("http://www.amazon.es/s?k=x"), /non-HTTPS/);
  assert.throws(() => assertAmazonPageUrl("https://evil.example/x"), /only fetches/);
  assert.throws(() => assertAmazonPageUrl("https://u:p@www.amazon.es/x"), /embedded credentials/);
  // Lookalike hostnames must not pass on a suffix match.
  assert.throws(() => assertAmazonPageUrl("https://amazon.es.evil.example/x"), /only fetches/);
  assert.throws(() => assertAmazonPageUrl("not a url"), UrlNotAllowed);
});

test("isPrivateAddress covers the ranges an SSRF would aim at", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(a), true, `${a} must be treated as private`);
  }
  for (const a of [
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "2606:2800:220:1:248:1893:25c8:1946",
  ]) {
    assert.equal(isPrivateAddress(a), false, `${a} is public`);
  }
});

test("fetchImageSafely refuses a redirect rather than following it", async () => {
  // redirect:"error" is what enforces this, so assert the option is actually set.
  let seenInit;
  const _fetch = async (_url, init) => {
    seenInit = init;
    return {
      ok: true,
      headers: new Map([["content-type", "image/png"]]),
      arrayBuffer: async () => new ArrayBuffer(4),
    };
  };
  await fetchImageSafely("https://m.media-amazon.com/images/I/x.png", {
    _fetch,
    _lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(seenInit.redirect, "error");
});

test("fetchImageSafely enforces the byte cap on a lying content-length", async () => {
  const big = new Uint8Array(64);
  const _fetch = async () => ({
    ok: true,
    headers: new Map([
      ["content-type", "image/png"],
      ["content-length", "1"],
    ]),
    arrayBuffer: async () => big.buffer,
  });
  await assert.rejects(
    () =>
      fetchImageSafely("https://m.media-amazon.com/images/I/x.png", {
        _fetch,
        _lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        maxBytes: 16,
      }),
    /too large/,
  );
});

test("fetchImageSafely refuses a host that is not an Amazon image CDN", async () => {
  await assert.rejects(
    () =>
      fetchImageSafely("https://attacker.example/x.png", {
        _fetch: async () => {
          throw new Error("must not be called");
        },
      }),
    /not an Amazon image CDN/,
  );
});
