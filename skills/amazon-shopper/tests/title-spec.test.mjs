import assert from "node:assert/strict";
import test from "node:test";
import { parseSpecFromTitle, activeKg } from "../scripts/title-spec.mjs";

test("granular bisulfate with kg", () => {
  const s = parseSpecFromTitle("CONTROL GARDEN PH LOWER PH POOLS Granulated 5 kg | pH Reducer");
  assert.equal(s.form, "granular");
  assert.equal(s.package_size_kg, 5);
  assert.equal(s.confidence >= 0.5, true);
});

test("liquid with litres and explicit concentration", () => {
  const s = parseSpecFromTitle("Liquid pH Minorator 20L (25 kg) – PH Minus Sulfuric Acid 15%");
  assert.equal(s.form, "liquid");
  assert.equal(s.package_size_l, 20);
  assert.equal(s.package_size_kg, 25);
  assert.equal(s.concentration_pct, 15);
  assert.equal(s.active_ingredient, "sulfuric acid");
  assert.ok(s.confidence >= 0.75);
});

test("hydrochloric detected + default concentration", () => {
  const s = parseSpecFromTitle("QUIMICAMP Hydrochloride Liquid pH Reducer 25 L");
  assert.equal(s.active_ingredient, "hydrochloric acid");
  assert.equal(s.concentration_pct, 22); // default for HCl
  assert.equal(s.form, "liquid");
  assert.equal(s.package_size_l, 25);
});

test("mixed L+kg title prefers liquid form", () => {
  const s = parseSpecFromTitle("PH Minus 10 liters (12.5 kg) - sulfuric acid 15%");
  assert.equal(s.form, "liquid");
  assert.equal(s.package_size_l, 10);
  assert.equal(s.package_size_kg, 12.5);
});

test("bisulfate 100% concentration default", () => {
  const s = parseSpecFromTitle("ctx10 pH Minus Bisulfato 5kg");
  assert.equal(s.active_ingredient, "sodium bisulfate");
  assert.equal(s.concentration_pct, 100);
  assert.equal(s.package_size_kg, 5);
});

test("empty/unparseable title → confidence 0", () => {
  const s = parseSpecFromTitle("pH Reducer for Swimming Pools");
  assert.equal(s.package_size_kg, null);
  assert.equal(s.package_size_l, null);
  // form may be detected ("reducer" doesn't imply form), confidence stays low
  assert.ok(s.confidence < 0.5);
});

test("activeKg: solid bisulfate 5kg @ 100% = 5", () => {
  assert.equal(activeKg({ package_size_kg: 5, concentration_pct: 100 }), 5);
});

test("activeKg: liquid 20L @ 15% ≈ 3.3 (with 1.1 density)", () => {
  const v = activeKg({ package_size_l: 20, concentration_pct: 15 });
  assert.ok(Math.abs(v - 3.3) < 0.01, `got ${v}`);
});

test("activeKg: no concentration → null", () => {
  assert.equal(activeKg({ package_size_kg: 5, concentration_pct: null }), null);
});
