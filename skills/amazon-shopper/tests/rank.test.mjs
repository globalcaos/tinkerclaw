import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rankProducts, applyMetric } from "../scripts/rank.mjs";

function withMock(t, payload) {
  const dir = mkdtempSync(join(tmpdir(), "rank-"));
  const p = join(dir, "m.json");
  writeFileSync(p, JSON.stringify(payload));
  process.env.MOCK_LLM_RESPONSE_FILE = p;
  t.after(() => {
    delete process.env.MOCK_LLM_RESPONSE_FILE;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("chemistry category → ranks by €/kg-active, excludes spec_unknown", async (t) => {
  withMock(t, {
    choose_metric: {
      metric_id: "eur_per_kg_active",
      formula_human: "price ÷ (size × concentration/100)",
    },
  });
  const products = [
    {
      asin: "A",
      current_price_eur: 25,
      package_size_kg: 5,
      concentration_pct: 100,
      spec_status: "ok",
      title: "Powder 5kg granulado",
    },
    {
      asin: "B",
      current_price_eur: 20,
      package_size_kg: 5,
      concentration_pct: 14.5,
      spec_status: "ok",
      title: "Liquid 5L 14.5% HCl",
    },
    {
      asin: "C",
      current_price_eur: 100,
      package_size_kg: 25,
      concentration_pct: 100,
      spec_status: "ok",
      title: "Powder bulk 25kg granulado",
    },
    {
      asin: "D",
      current_price_eur: 30,
      package_size_kg: null,
      concentration_pct: null,
      spec_status: "spec_unknown",
      title: "Unknown",
    },
  ];
  const r = await rankProducts({
    products,
    category_filter: { form: "powder" },
    volume_bracket: "5kg",
  });
  assert.equal(r.top_3.length, 2);
  assert.equal(r.top_3[0].asin, "C", "cheapest €/kg-active should rank first");
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].asin, "D");
});

test("returns exactly 3 when 5 candidates available", async (t) => {
  withMock(t, {
    choose_metric: {
      metric_id: "eur_per_kg",
    },
  });
  const products = [
    { asin: "A", current_price_eur: 10, package_size_kg: 1, spec_status: "ok", title: "1kg" },
    { asin: "B", current_price_eur: 18, package_size_kg: 2, spec_status: "ok", title: "2kg" },
    { asin: "C", current_price_eur: 25, package_size_kg: 5, spec_status: "ok", title: "5kg" },
    { asin: "D", current_price_eur: 45, package_size_kg: 10, spec_status: "ok", title: "10kg" },
    { asin: "E", current_price_eur: 100, package_size_kg: 25, spec_status: "ok", title: "25kg" },
  ];
  const r = await rankProducts({ products, category_filter: {}, volume_bracket: null });
  assert.equal(r.top_3.length, 3);
  assert.deepEqual(
    r.top_3.map((p) => p.asin),
    ["E", "D", "C"],
  );
});

test("refund tier breaks ties within 10% — prefers Amazon-sold", async (t) => {
  // Two products near-identical on €/unit; Amazon-sold should win the tie.
  const products = [
    {
      asin: "TP",
      current_price_eur: 20.0,
      package_size_l: 20,
      spec_status: "ok",
      title: "Liquid 20L",
      seller_name: "Proquimar",
      seller_is_amazon: 0,
      in_stock: 1,
    },
    {
      asin: "AMZ",
      current_price_eur: 20.8,
      package_size_l: 20,
      spec_status: "ok",
      title: "Liquid 20L",
      seller_name: "Amazon",
      seller_is_amazon: 1,
      in_stock: 1,
    },
  ];
  const r = await rankProducts({ products, category_filter: {}, volume_bracket: null });
  // €1.00/L vs €1.04/L → within 10% → Amazon-sold (tier 2) wins despite being pricier.
  assert.equal(r.top_3[0].asin, "AMZ");
  assert.equal(r.top_3[0].refund_tier, 2);
});

test("refund tier does NOT override a >10% cheaper option", async (t) => {
  const products = [
    {
      asin: "TP",
      current_price_eur: 10,
      package_size_l: 20,
      spec_status: "ok",
      title: "Liquid 20L",
      seller_name: "Proquimar",
      seller_is_amazon: 0,
      in_stock: 1,
    },
    {
      asin: "AMZ",
      current_price_eur: 20,
      package_size_l: 20,
      spec_status: "ok",
      title: "Liquid 20L",
      seller_name: "Amazon",
      seller_is_amazon: 1,
      in_stock: 1,
    },
  ];
  const r = await rankProducts({ products, category_filter: {}, volume_bracket: null });
  // €0.50/L vs €1.00/L → 50% cheaper → third-party wins on price.
  assert.equal(r.top_3[0].asin, "TP");
});

test("out-of-stock products drop to refund tier 0", async (t) => {
  const products = [
    {
      asin: "OOS",
      current_price_eur: 5,
      package_size_l: 20,
      spec_status: "ok",
      title: "Liquid 20L",
      seller_name: "Amazon",
      seller_is_amazon: 1,
      in_stock: 0,
    },
    {
      asin: "OK",
      current_price_eur: 20,
      package_size_l: 20,
      spec_status: "ok",
      title: "Liquid 20L",
      seller_name: "Amazon",
      seller_is_amazon: 1,
      in_stock: 1,
    },
  ];
  const r = await rankProducts({ products, category_filter: {}, volume_bracket: null });
  const oos = r.top_3.find((p) => p.asin === "OOS");
  assert.equal(oos.refund_tier, 0);
});

// ── 1.2.1: metrics are functions chosen by id, never a compiled string ─────

test("applyMetric computes each of the three metrics", () => {
  const chem = { current_price_eur: 25, active_kg: 5 };
  assert.equal(applyMetric("eur_per_kg_active", chem), 5);

  assert.equal(applyMetric("eur_per_unit", { current_price_eur: 20, package_size_l: 4 }), 5);
  assert.equal(applyMetric("eur_per_unit", { current_price_eur: 20, package_size_kg: 2 }), 10);

  assert.equal(applyMetric("price_eur", { current_price_eur: 12.5 }), 12.5);
});

test("applyMetric scores an uncomputable row LAST, not first", () => {
  // The failure this guards: a missing size must not read as "free".
  assert.equal(
    applyMetric("eur_per_kg_active", { current_price_eur: 25, active_kg: null }),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(applyMetric("eur_per_unit", { current_price_eur: 25 }), Number.POSITIVE_INFINITY);
  assert.equal(applyMetric("price_eur", {}), Number.POSITIVE_INFINITY);
});

test("an unknown metric id yields no score instead of throwing or evaluating", () => {
  assert.equal(applyMetric("eur_per_anything", { current_price_eur: 1 }), Number.POSITIVE_INFINITY);
  // The old path took a JS string; passing one now names no metric and computes nothing.
  assert.equal(
    applyMetric("p.current_price_eur * 0", { current_price_eur: 10 }),
    Number.POSITIVE_INFINITY,
  );
});

test("the ranked metric carries no executable formula field", async (t) => {
  withMock(t, {});
  const products = [
    { asin: "A", current_price_eur: 10, package_size_kg: 1, spec_status: "ok", title: "1kg" },
    { asin: "B", current_price_eur: 18, package_size_kg: 3, spec_status: "ok", title: "3kg" },
  ];
  const r = await rankProducts({ products, category_filter: {}, volume_bracket: null });
  assert.ok(r.metric, "a metric should be chosen");
  assert.equal(r.metric.formula_js, undefined, "no JS-string formula may be handed back");
  assert.ok(r.metric.metric_id, "the metric is identified by id");
  assert.ok(r.metric.formula_human, "and described in words");
});
