import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProductImage } from "../scripts/image-spec.mjs";

// The download path validates the destination (HTTPS, Amazon image CDN host,
// public IP, no redirect, image content-type, size cap), so the stubs supply the
// headers it inspects and a resolver that keeps the tests off real DNS.
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function fakeFetchOk(contentType = "image/jpeg") {
  return async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", contentType]]),
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer, // tiny fake jpeg
  });
}

const opts = (extra) => ({ _lookup: publicLookup, ...extra });

test("returns null when no image url", async () => {
  const r = await analyzeProductImage(
    null,
    opts({ _fetch: fakeFetchOk(), _vision: async () => ({}) }),
  );
  assert.equal(r, null);
});

test("reads spec from image when vision confident", async () => {
  const vision = async ({ call_site, imagePath }) => {
    assert.equal(call_site, "image_spec");
    assert.match(imagePath, /product\.jpg$/);
    return {
      package_size_l: 20,
      package_size_kg: 25,
      concentration_pct: 15,
      active_ingredient: "sulfuric acid",
      form: "liquid",
      dimensions_cm: "40x30x20",
      confidence: 0.85,
    };
  };
  const r = await analyzeProductImage(
    "https://m.media-amazon.com/images/I/x.jpg",
    opts({ _fetch: fakeFetchOk(), _vision: vision }),
  );
  assert.equal(r.spec_source, "image");
  assert.equal(r.package_size_l, 20);
  assert.equal(r.concentration_pct, 15);
  assert.equal(r.active_ingredient, "sulfuric acid");
  assert.equal(r.dimensions_cm, "40x30x20");
});

test("returns null when vision confidence below threshold", async () => {
  const vision = async () => ({ package_size_l: null, confidence: 0.2 });
  const r = await analyzeProductImage(
    "https://m.media-amazon.com/images/I/x.jpg",
    opts({ _fetch: fakeFetchOk(), _vision: vision }),
  );
  assert.equal(r, null);
});

test("returns null on download error (graceful)", async () => {
  const badFetch = async () => ({ ok: false, status: 404, headers: new Map() });
  const r = await analyzeProductImage(
    "https://m.media-amazon.com/images/I/x.jpg",
    opts({ _fetch: badFetch, _vision: async () => ({ confidence: 1 }) }),
  );
  assert.equal(r, null);
});

test("a non-Amazon image host is never fetched", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(3) };
  };
  const r = await analyzeProductImage(
    "https://attacker.example/x.jpg",
    opts({ _fetch: spy, _vision: async () => ({ confidence: 1 }) }),
  );
  assert.equal(r, null);
  assert.equal(called, false, "must refuse before opening a socket");
});

test("an Amazon hostname resolving to a private address is never fetched", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(3) };
  };
  const r = await analyzeProductImage("https://m.media-amazon.com/images/I/x.jpg", {
    _fetch: spy,
    _lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    _vision: async () => ({ confidence: 1 }),
  });
  assert.equal(r, null);
  assert.equal(called, false, "DNS rebinding to link-local must be refused");
});

test("a non-image response is rejected even from an allowed host", async () => {
  const htmlFetch = async () => ({
    ok: true,
    headers: new Map([["content-type", "text/html"]]),
    arrayBuffer: async () => new ArrayBuffer(3),
  });
  const r = await analyzeProductImage(
    "https://m.media-amazon.com/images/I/x.jpg",
    opts({ _fetch: htmlFetch, _vision: async () => ({ confidence: 1 }) }),
  );
  assert.equal(r, null);
});

test("returns null on vision error (graceful)", async () => {
  const vision = async () => {
    throw new Error("vision boom");
  };
  const r = await analyzeProductImage(
    "https://m.media-amazon.com/images/I/x.jpg",
    opts({ _fetch: fakeFetchOk(), _vision: vision }),
  );
  assert.equal(r, null);
});
