import assert from "node:assert/strict";
import test from "node:test";
import { MilanunciosAdapter } from "../../adapters/MilanunciosAdapter.mjs";

// Synthetic ad payload shaped like the live milanuncios tree
// (adListPagination.adList.ads), per milanuncios.mjs:185-270.
const ADS = [
  {
    id: 12345,
    title: "Leica M6 analógica",
    description: "Cámara en buen estado",
    price: { cashPrice: { value: 1800 } },
    location: { city: { name: "Madrid" }, province: { name: "Madrid" } },
    images: ["images.milanuncios.com/api/v1/abc.jpg"],
    url: "/fotografia/leica-m6-12345.htm",
    sortDate: "2026-05-21T22:53:25Z",
    publishDate: "2024-06-24T15:25:20Z",
    sellerType: "private",
    sellType: "supply",
  },
  {
    id: 67890,
    title: "Busco Leica (ISO)",
    price: { value: 0 },
    url: "/fotografia/busco-leica-67890.htm",
    sellerType: "professional",
    sellType: "demand", // must be filtered out
  },
  {
    id: 11111,
    title: "Leica lente 50mm",
    price: { cashPrice: { value: 450 } },
    images: ["https://cdn.example.com/lens.jpg"],
    url: "https://www.milanuncios.com/fotografia/leica-50-11111.htm",
    sellerType: "professional",
    sellType: "supply",
  },
];

function shapeA(ads) {
  // Shape A: window.__INITIAL_PROPS__ = JSON.parse("<double-encoded json>");
  const inner = JSON.stringify({ adListPagination: { adList: { ads } } });
  // Encode the inner JSON as a JS string literal (double-escaped).
  const encoded = JSON.stringify(inner).slice(1, -1); // strip the wrapping quotes
  return `<html><body><script>window.__INITIAL_PROPS__ = JSON.parse("${encoded}")</script></body></html>`;
}

function shapeB(ads) {
  // Shape B: window.__INITIAL_PROPS__ = {...};
  const obj = JSON.stringify({ adListPagination: { adList: { ads } } });
  return `<html><body><script>window.__INITIAL_PROPS__ = ${obj};</script></body></html>`;
}

function shapeC(ads) {
  // Shape C: __NEXT_DATA__ → props.pageProps.adList.ads
  const obj = JSON.stringify({ props: { pageProps: { adList: { ads } } } });
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${obj}</script></body></html>`;
}

test("extract() parses Shape A (double-encoded INITIAL_PROPS)", () => {
  const a = new MilanunciosAdapter();
  const listings = a.extract(shapeA(ADS), {});
  // demand ISO is filtered → 2 supply listings
  assert.equal(listings.length, 2);
  const first = listings[0];
  assert.equal(first.asin, "12345");
  assert.equal(first.title, "Leica M6 analógica");
  assert.equal(first.current_price_eur, 1800);
  assert.equal(first.position, 1);
  assert.equal(first.url, "https://www.milanuncios.com/fotografia/leica-m6-12345.htm");
  assert.equal(first.image_url, "https://images.milanuncios.com/api/v1/abc.jpg");
  assert.equal(first.seller_name, "(private)");
});

test("extract() parses Shape B (direct INITIAL_PROPS object)", () => {
  const a = new MilanunciosAdapter();
  const listings = a.extract(shapeB(ADS), {});
  assert.equal(listings.length, 2);
  assert.equal(listings[0].asin, "12345");
});

test("extract() parses Shape C (__NEXT_DATA__)", () => {
  const a = new MilanunciosAdapter();
  const listings = a.extract(shapeC(ADS), {});
  assert.equal(listings.length, 2);
  assert.equal(listings[1].asin, "11111");
  // already-absolute url + image kept verbatim
  assert.equal(listings[1].url, "https://www.milanuncios.com/fotografia/leica-50-11111.htm");
  assert.equal(listings[1].image_url, "https://cdn.example.com/lens.jpg");
  assert.equal(listings[1].seller_name, "(professional)");
});

test("extract() filters out demand (ISO) ads and re-numbers positions", () => {
  const a = new MilanunciosAdapter();
  const listings = a.extract(shapeA(ADS), {});
  assert.ok(listings.every((l) => l.asin !== "67890"));
  assert.deepEqual(
    listings.map((l) => l.position),
    [1, 2],
  );
});

test("extract() respects maxProducts", () => {
  const a = new MilanunciosAdapter();
  const listings = a.extract(shapeA(ADS), { maxProducts: 1 });
  assert.equal(listings.length, 1);
});

test("extract() produces the shared Listing schema fields", () => {
  const a = new MilanunciosAdapter();
  const l = a.extract(shapeA(ADS), {})[0];
  for (const k of [
    "asin",
    "position",
    "title",
    "url",
    "image_url",
    "current_price_eur",
    "list_price_eur",
    "rating",
    "review_count",
    "is_prime",
    "is_best_seller",
    "seller_name",
    "seller_is_amazon",
    "in_stock",
    "source",
    "listing_kind",
  ]) {
    assert.ok(k in l, `missing Listing field: ${k}`);
  }
  assert.equal(l.is_prime, false);
  assert.equal(l.is_best_seller, false);
  assert.equal(l.seller_is_amazon, false);
  assert.equal(l.rating, null);
});

test("extract() throws on unparseable HTML (no INITIAL_PROPS / NEXT_DATA)", () => {
  const a = new MilanunciosAdapter();
  assert.throws(() => a.extract("<html><body>nope</body></html>", {}), /parse-html/);
});

test("extract() returns [] when ads array is empty", () => {
  const a = new MilanunciosAdapter();
  assert.deepEqual(a.extract(shapeA([]), {}), []);
});

test("name is 'milanuncios' and slugUrl builds the /anuncios/<slug>.htm path", () => {
  const a = new MilanunciosAdapter();
  assert.equal(a.name, "milanuncios");
  assert.equal(a.slugUrl("Leica M6"), "https://www.milanuncios.com/anuncios/leica-m6.htm");
});

test("classifyResponse() flags 403 as waf", () => {
  const a = new MilanunciosAdapter();
  assert.equal(a.classifyResponse({ status: 403, body: "" }).reason, "waf http-403");
  assert.equal(a.classifyResponse({ status: 200, body: "<html>ok</html>" }).outcome, "OK");
});
