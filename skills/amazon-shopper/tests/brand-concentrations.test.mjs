import assert from "node:assert/strict";
import test from "node:test";
import { lookupConcentration } from "../scripts/brand-concentrations.mjs";
import { researchProduct } from "../scripts/research.mjs";

test("brand table resolves a known brand+form to a confirmed concentration", () => {
  const r = lookupConcentration({
    brand: "CTX",
    form: "liquid",
    title: "CTX-15 Minorador pH líquido 20 L",
  });
  assert.equal(r.concentration_pct, 15);
  assert.equal(r.active_ingredient, "sulfuric acid");
  assert.match(r.concentration_source, /brand-table:ctx/);
  assert.equal(r.needs_concentration, false);
});

test("brand sniffed from title when brand field is absent", () => {
  const r = lookupConcentration({
    brand: null,
    form: "granular",
    title: "Bayrol pH-Minus 6 kg gránulos",
  });
  assert.equal(r.concentration_pct, 100);
  assert.match(r.concentration_source, /brand-table:bayrol/);
});

test("unknown brand falls back to a per-form default flagged for research", () => {
  const r = lookupConcentration({
    brand: "NoNameBrand",
    form: "granular",
    title: "Generic Granulado 5 KG",
  });
  assert.equal(r.concentration_pct, 95);
  assert.equal(r.active_ingredient, "sodium bisulfate");
  assert.equal(r.concentration_source, "form-default");
  assert.equal(r.needs_concentration, true, "form-default is an assumption → needs research");
});

test("no form → null (nothing to default from)", () => {
  assert.equal(lookupConcentration({ brand: "x", form: null, title: "x" }), null);
});

test("research ladder makes active_kg computable for a title with form+size but no % (the €/kg-active fix)", async () => {
  // "CONTROL GARDEN Granulado 10 KG" — names neither ingredient nor concentration.
  // Before the fix this returned spec_status:ok with active_kg:null, forcing the
  // ranker off €/kg-active. Now the form-default fills 95% bisulfate → active_kg.
  const research = await researchProduct({
    product: {
      id: 1,
      title: "CONTROL GARDEN Bajador PH Piscinas Granulado 10 KG",
      image_url: null,
    },
    detailSpec: {},
    fetcher: { get: async () => ({ outcome: "BLOCKED", reason: "n/a" }) },
  });
  assert.equal(research.spec_status, "ok");
  assert.equal(research.form, "granular");
  assert.equal(research.concentration_pct, 95);
  assert.equal(research.needs_concentration, true);
  assert.ok(research.active_kg > 0, "active_kg must compute (10kg × 95%)");
  assert.equal(research.spec_source, "title:form-default");
});
