import assert from "node:assert/strict";
import test from "node:test";
import { apifyConfigured, searchItems, getItem } from "../scripts/apify.mjs";

function withToken(t, env) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === null) delete process.env[k];
    else process.env[k] = env[k];
  }
  t.after(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test("apifyConfigured returns false without token", (t) => {
  withToken(t, { AMAZON_SHOPPER_APIFY_TOKEN: null });
  assert.equal(apifyConfigured(), false);
});

test("apifyConfigured returns true with token", (t) => {
  withToken(t, { AMAZON_SHOPPER_APIFY_TOKEN: "apify_api_xxx" });
  assert.equal(apifyConfigured(), true);
});

test("searchItems authenticates with a Bearer header, never the URL, and injects no affiliate tag", async (t) => {
  withToken(t, { AMAZON_SHOPPER_APIFY_TOKEN: "apify_api_xxx" });
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => [
        {
          asin: "B0SAMPLE01",
          title: "Reductor pH líquido 25L",
          url: "https://www.amazon.es/dp/B0SAMPLE01/",
          thumbnailImage: "https://m.media-amazon.com/images/I/xxx.jpg",
          price: "35,95 €",
          stars: 4.5,
          reviewsCount: 234,
          isPrime: true,
          isBestSeller: false,
        },
        {
          asin: "B0SAMPLE02",
          title: "Bisulfato sódico granulado 8kg",
          url: "https://www.amazon.es/dp/B0SAMPLE02/",
          price: "32.94",
          stars: 4.3,
          reviewsCount: 89,
          isPrime: false,
        },
      ],
    };
  };
  const products = await searchItems("ph minus", { maxProducts: 10, _fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/acts\/junglee~amazon-crawler\/run-sync-get-dataset-items/);
  assert.doesNotMatch(calls[0].url, /apify_api_xxx/, "token must NOT appear in the URL");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer apify_api_xxx");
  assert.equal(products.length, 2);
  assert.equal(products[0].asin, "B0SAMPLE01");
  assert.equal(products[0].title, "Reductor pH líquido 25L");
  assert.equal(products[0].current_price_eur, 35.95);
  assert.equal(products[0].rating, 4.5);
  assert.equal(products[0].review_count, 234);
  assert.equal(products[0].is_prime, true);
  assert.equal(products[0].url, "https://www.amazon.es/dp/B0SAMPLE01/");
  assert.doesNotMatch(products[0].url, /[?&]tag=/, "no affiliate tag may be appended");
  assert.equal(products[1].current_price_eur, 32.94);
});

test("searchItems throws on non-OK HTTP", async (t) => {
  withToken(t, { AMAZON_SHOPPER_APIFY_TOKEN: "apify_api_xxx" });
  const fakeFetch = async () => ({
    ok: false,
    status: 402,
    text: async () => "Payment Required for apify_api_xxx",
  });
  await assert.rejects(
    () => searchItems("x", { _fetch: fakeFetch }),
    /Apify actor .* failed: HTTP 402/,
  );
  // and the reflected token is scrubbed out of the thrown message
  await assert.rejects(() => searchItems("x", { _fetch: fakeFetch }), /<redacted>/);
});

test("getItem maps detail response with bullets and weight inference", async (t) => {
  withToken(t, { AMAZON_SHOPPER_APIFY_TOKEN: "apify_api_xxx" });
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [
      {
        title: "Quimicamp Bisulfato Sódico 7kg",
        brand: "Quimicamp",
        features: ["Bisulfato sódico al 100%", "Envase 7 kg", "Granulado"],
        attributes: { "Peso del producto": "7 kg", Composición: "NaHSO4 100%" },
      },
    ],
  });
  const spec = await getItem("B0BISUL001", { _fetch: fakeFetch });
  assert.equal(spec.title, "Quimicamp Bisulfato Sódico 7kg");
  assert.equal(spec.brand, "Quimicamp");
  assert.equal(spec.weight_kg, 7);
  assert.equal(spec.bullets.length, 3);
  assert.match(spec.combined_text, /Title: Quimicamp/);
  assert.match(spec.combined_text, /Bullets:\n- Bisulfato/);
});

test("getItem returns empty shape when actor returns no items", async (t) => {
  withToken(t, { AMAZON_SHOPPER_APIFY_TOKEN: "apify_api_xxx" });
  const fakeFetch = async () => ({ ok: true, json: async () => [] });
  const spec = await getItem("B0NOSUCH00", { _fetch: fakeFetch });
  assert.equal(spec.title, null);
  assert.equal(spec.bullets.length, 0);
  assert.equal(spec.combined_text, "");
});
