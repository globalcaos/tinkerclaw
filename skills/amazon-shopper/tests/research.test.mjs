import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { researchProduct } from "../scripts/research.mjs";

function withMock(t, payload) {
  const dir = mkdtempSync(join(tmpdir(), "res-"));
  const p = join(dir, "m.json");
  writeFileSync(p, JSON.stringify(payload));
  process.env.MOCK_LLM_RESPONSE_FILE = p;
  t.after(() => {
    delete process.env.MOCK_LLM_RESPONSE_FILE;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("title-parse step 0 → returns spec from title, no LLM/fetch", async (t) => {
  // No mock LLM + a fetcher that throws — proves the title parser short-circuits.
  const fetcher = {
    get: async () => {
      throw new Error("should not be called");
    },
  };
  const r = await researchProduct({
    product: { asin: "B0000001", title: "Quimicamp Bisulfato Sódico 5kg Granulado Reductor pH" },
    detailSpec: { combined_text: "" },
    fetcher,
  });
  assert.equal(r.spec_status, "ok");
  assert.equal(r.spec_source, "title");
  assert.equal(r.active_ingredient, "sodium bisulfate");
  assert.equal(r.package_size_kg, 5);
  assert.equal(r.form, "granular");
});

test("unparseable title → amazon-detail LLM path returns spec", async (t) => {
  withMock(t, {
    extract_spec: {
      active_ingredient: "sodium bisulfate",
      concentration_pct: 100,
      package_size_kg: 5,
      confidence: 0.95,
    },
  });
  const fetcher = {
    get: async () => {
      throw new Error("should not be called");
    },
  };
  const r = await researchProduct({
    product: { asin: "B0000001", title: "Pool pH control product" },
    detailSpec: { combined_text: "Title: Pool pH product\nBullets:\n- active sodium bisulfate" },
    fetcher,
  });
  assert.equal(r.spec_status, "ok");
  assert.equal(r.spec_source, "amazon");
  assert.equal(r.active_ingredient, "sodium bisulfate");
});

test("unparseable title + insufficient detail → escalates to producer-site", async (t) => {
  withMock(t, {
    extract_spec: { confidence: 0.3 },
    extract_spec_producer: {
      active_ingredient: "hydrochloric acid",
      concentration_pct: 14.5,
      package_size_kg: 25,
      confidence: 0.9,
    },
  });
  let calls = 0;
  const fetcher = {
    get: async (url) => {
      calls++;
      assert.match(url, /quimicamp/);
      return { outcome: "OK", body: "<html>Hydrochloric Acid 14.5% Technical Datasheet</html>" };
    },
  };
  const r = await researchProduct({
    product: { asin: "B0000002", title: "Pool pH control product", brand_hint: "quimicamp" },
    detailSpec: { combined_text: "Title: pool pH product" },
    fetcher,
    // Leaving amazon.es is opt-in, and it runs on its own cookie-free fetcher.
    allowWebResearch: true,
    webFetcher: fetcher,
  });
  assert.equal(r.spec_status, "ok");
  assert.equal(r.spec_source, "producer");
  assert.equal(calls, 1);
});

test("off-Amazon research is OFF by default: no request leaves amazon.es", async (t) => {
  withMock(t, {
    extract_spec: { confidence: 0.3 },
    extract_spec_producer: { active_ingredient: "hydrochloric acid", confidence: 0.9 },
    extract_spec_web: { confidence: 0.9 },
  });
  let offAmazonCalls = 0;
  const webFetcher = {
    get: async () => {
      offAmazonCalls++;
      return { outcome: "OK", body: "<html>x</html>" };
    },
  };
  const r = await researchProduct({
    product: { asin: "B0000004", title: "Pool pH control product", brand_hint: "quimicamp" },
    detailSpec: { combined_text: "Title: pool pH product" },
    fetcher: { get: async () => ({ outcome: "OK", body: "<html>x</html>" }) },
    webFetcher,
  });
  assert.equal(offAmazonCalls, 0, "no producer-site or search-engine request without opt-in");
  assert.equal(r.spec_status, "spec_unknown");
  assert.equal(r.spec_source, null);
});

test("ladder fully exhausted → spec_unknown", async (t) => {
  withMock(t, {
    extract_spec: { confidence: 0.2 },
    extract_spec_producer: { confidence: 0.1 },
    extract_spec_web: { confidence: 0.1 },
  });
  const fetcher = { get: async () => ({ outcome: "OK", body: "<html>nothing useful</html>" }) };
  const r = await researchProduct({
    product: { asin: "B0000003", title: "Generic ph minus" },
    detailSpec: { combined_text: "Title: Generic ph minus" },
    fetcher,
    allowWebResearch: true,
    webFetcher: fetcher,
  });
  assert.equal(r.spec_status, "spec_unknown");
});
