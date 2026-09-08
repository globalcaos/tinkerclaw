import assert from "node:assert/strict";
import test from "node:test";
import { creatorsApiConfigured, searchItems, getItem } from "../scripts/creators-api.mjs";

const SAMPLE_SEARCH_RESPONSE = {
  SearchResult: {
    Items: [
      {
        ASIN: "B0BISUL001",
        DetailPageURL: "https://www.amazon.es/dp/B0BISUL001/?tag=<your-associate-tag>",
        ItemInfo: { Title: { DisplayValue: "Quimicamp Bisulfato Sódico 7kg" } },
        Images: { Primary: { Large: { URL: "https://m.media-amazon.com/images/I/x.jpg" } } },
        Offers: {
          Listings: [
            {
              Price: { Amount: 25.99, Currency: "EUR" },
              SavingBasis: { Amount: 29.99 },
              DeliveryInfo: { IsPrimeEligible: true },
            },
          ],
        },
        CustomerReviews: { Count: 1234, StarRating: { Value: 4.5 } },
      },
      {
        ASIN: "B0HCLLIQ02",
        DetailPageURL: "https://www.amazon.es/dp/B0HCLLIQ02/?tag=<your-associate-tag>",
        ItemInfo: { Title: { DisplayValue: "Reductor PH Líquido 25L HCl 14,5%" } },
        Offers: {
          Listings: [
            {
              Price: { Amount: 39.9, Currency: "EUR" },
              DeliveryInfo: { IsPrimeEligible: false },
            },
          ],
        },
        CustomerReviews: { Count: 512, StarRating: { Value: 4.2 } },
      },
    ],
  },
};

const SAMPLE_GETITEM_RESPONSE = {
  ItemsResult: {
    Items: [
      {
        ASIN: "B0BISUL001",
        ItemInfo: {
          Title: { DisplayValue: "Quimicamp Bisulfato Sódico 7kg Granulado" },
          ByLineInfo: { Brand: { DisplayValue: "Quimicamp" } },
          Features: { DisplayValues: ["Bisulfato sódico 100%", "7 kg granulado", "Reduce el pH"] },
          TechnicalInfo: {
            Specifications: [
              { Name: "Composición", Value: "Bisulfato sódico 100%" },
              { Name: "Peso", Value: "7 kg" },
            ],
          },
        },
      },
    ],
  },
};

function makeFetchOk(body) {
  return async (_url, _opts) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function makeFetchErr(status, body) {
  return async () => ({
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  });
}

function withEnv(t, env) {
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    process.env[k] = env[k];
  }
  t.after(() => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test("creatorsApiConfigured() is false when env vars missing", () => {
  const prev = {
    ak: process.env.AMAZON_SHOPPER_CREATORS_ACCESS_KEY,
    sk: process.env.AMAZON_SHOPPER_CREATORS_SECRET_KEY,
    tag: process.env.AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG,
  };
  delete process.env.AMAZON_SHOPPER_CREATORS_ACCESS_KEY;
  delete process.env.AMAZON_SHOPPER_CREATORS_SECRET_KEY;
  delete process.env.AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG;
  try {
    assert.equal(creatorsApiConfigured(), false);
  } finally {
    if (prev.ak !== undefined) process.env.AMAZON_SHOPPER_CREATORS_ACCESS_KEY = prev.ak;
    if (prev.sk !== undefined) process.env.AMAZON_SHOPPER_CREATORS_SECRET_KEY = prev.sk;
    if (prev.tag !== undefined) process.env.AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG = prev.tag;
  }
});

test("creatorsApiConfigured() is true when all 3 env vars present", (t) => {
  withEnv(t, {
    AMAZON_SHOPPER_CREATORS_ACCESS_KEY: "AKIAFAKE",
    AMAZON_SHOPPER_CREATORS_SECRET_KEY: "secretfake",
    AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG: "<your-associate-tag>",
  });
  assert.equal(creatorsApiConfigured(), true);
});

test("searchItems maps Creators API response to product[] shape", async (t) => {
  withEnv(t, {
    AMAZON_SHOPPER_CREATORS_ACCESS_KEY: "AKIAFAKE",
    AMAZON_SHOPPER_CREATORS_SECRET_KEY: "secretfake",
    AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG: "<your-associate-tag>",
  });
  const products = await searchItems("ph minus piscina", {
    _fetch: makeFetchOk(SAMPLE_SEARCH_RESPONSE),
  });
  assert.equal(products.length, 2);
  assert.equal(products[0].asin, "B0BISUL001");
  assert.equal(products[0].title, "Quimicamp Bisulfato Sódico 7kg");
  assert.equal(products[0].current_price_eur, 25.99);
  assert.equal(products[0].rating, 4.5);
  assert.equal(products[0].is_prime, true);
  assert.equal(products[1].is_prime, false);
});

test("searchItems throws on HTTP error with body excerpt", async (t) => {
  withEnv(t, {
    AMAZON_SHOPPER_CREATORS_ACCESS_KEY: "AKIAFAKE",
    AMAZON_SHOPPER_CREATORS_SECRET_KEY: "secretfake",
    AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG: "<your-associate-tag>",
  });
  await assert.rejects(
    () => searchItems("test", { _fetch: makeFetchErr(403, "AssociateNotEligible") }),
    /Creators API SearchItems failed: HTTP 403/,
  );
});

test("getItem maps Creators API GetItems response to spec shape", async (t) => {
  withEnv(t, {
    AMAZON_SHOPPER_CREATORS_ACCESS_KEY: "AKIAFAKE",
    AMAZON_SHOPPER_CREATORS_SECRET_KEY: "secretfake",
    AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG: "<your-associate-tag>",
  });
  const spec = await getItem("B0BISUL001", { _fetch: makeFetchOk(SAMPLE_GETITEM_RESPONSE) });
  assert.match(spec.title, /Bisulfato/);
  assert.equal(spec.brand, "Quimicamp");
  assert.equal(spec.bullets.length, 3);
  assert.match(spec.combined_text, /Bisulfato sódico 100%/);
});
