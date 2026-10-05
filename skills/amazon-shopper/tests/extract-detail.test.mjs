import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractDetailSpec } from "../scripts/extract-detail.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "detail-bisulfato.html");

test("extracts bullets and combined_text from fixture", async () => {
  const html = await readFile(FIX, "utf8");
  const spec = extractDetailSpec(html);
  assert.ok(spec.bullets.length >= 3, `got ${spec.bullets.length} bullets`);
  assert.ok(spec.combined_text.length > 100);
});

test("extracts title and brand from detail table", async () => {
  const html = await readFile(FIX, "utf8");
  const spec = extractDetailSpec(html);
  assert.match(spec.title, /Bisulfato/);
  assert.equal(spec.brand, "Quimicamp");
});

test("infers weight_kg=7 from detail-table 'peso del producto'", async () => {
  const html = await readFile(FIX, "utf8");
  const spec = extractDetailSpec(html);
  assert.equal(spec.weight_kg, 7);
});
