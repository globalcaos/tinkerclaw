#!/usr/bin/env node
// dev-capture-fixtures.mjs — one-shot helper to capture live amazon.es HTML
// into tests/fixtures/. Run manually when fixtures need refreshing. NEVER in CI.

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFetcher } from "./fetch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "tests", "fixtures");

async function main() {
  const f = createFetcher({ intervalMs: 2500 });

  console.error("[1/2] Fetching search page for 'ph minus piscina'...");
  const search = await f.get("https://www.amazon.es/s?k=ph+minus+piscina");
  if (search.outcome !== "OK") {
    console.error(`SEARCH FAILED: ${search.reason}`);
    await writeFile(join(FIX, `BLOCKED-search-${Date.now()}.html`), search.body);
    process.exit(2);
  }
  await writeFile(join(FIX, "search-ph-minus.html"), search.body);
  console.error(`  saved ${search.body.length} bytes`);

  const m = search.body.match(/\/dp\/([A-Z0-9]{10})\b/);
  if (!m) {
    console.error("Could not find a product ASIN in search HTML.");
    process.exit(3);
  }
  const detailUrl = `https://www.amazon.es/dp/${m[1]}/`;
  console.error(`[2/2] Fetching detail page ${detailUrl}...`);
  const detail = await f.get(detailUrl);
  if (detail.outcome !== "OK") {
    console.error(`DETAIL FAILED: ${detail.reason}`);
    await writeFile(join(FIX, `BLOCKED-detail-${Date.now()}.html`), detail.body);
    process.exit(2);
  }
  await writeFile(join(FIX, "detail-bisulfato.html"), detail.body);
  console.error(`  saved ${detail.body.length} bytes`);
  console.error("DONE.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
