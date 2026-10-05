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

test("isPrivateAddress: IPv6 forms the URL parser produces, and embedded IPv4", () => {
  for (const a of [
    "::ffff:7f00:1", // WHATWG URL normalises [::ffff:127.0.0.1] to this
    "::ffff:a00:1", // 10.0.0.1 mapped, hex form
    "[::1]", // bracketed, as URL.hostname returns it
    "::127.0.0.1", // IPv4-compatible (deprecated)
    "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
    "2002:c0a8:101::1", // 6to4 → 192.168.1.1
    "fec0::1",
    "2001:db8::1",
    "fe80:0:0:0:0:0:0:1",
    "not-an-ip:zz",
    "198.18.0.1",
    "203.0.113.5",
  ]) {
    assert.equal(isPrivateAddress(a), true, `${a} must be treated as private`);
  }
  for (const a of ["::ffff:5db8:d822", "2002:5db8:d822::1", "2a00:1450:4001:80b::200e"]) {
    assert.equal(isPrivateAddress(a), false, `${a} is public`);
  }
});

test("publicOnlyLookup refuses loopback and returns public addresses", async () => {
  const { publicOnlyLookup } = await import("../scripts/url-guard.mjs");
  const call = (host, opts) =>
    new Promise((resolve) => {
      publicOnlyLookup(host, opts, (err, address, family) => resolve({ err, address, family }));
    });
  const lo = await call("localhost", {});
  assert.ok(lo.err instanceof UrlNotAllowed, "localhost must be refused at connect time");
  const lit = await call("8.8.8.8", {});
  assert.equal(lit.err, null);
  assert.equal(lit.address, "8.8.8.8");
  const all = await call("8.8.8.8", { all: true });
  assert.deepEqual(all.address, [{ address: "8.8.8.8", family: 4 }]);
});
