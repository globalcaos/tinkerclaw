#!/usr/bin/env node
// fast-search.mjs — multi-phrasing anonymous sweep over amazon.es search pages.
//
// WHY IT EXISTS: one keyword query is one slice of the catalogue. Sweeping
// variants ("micro sd 1tb", "micro sd 512gb") found 18 x 1 TB and 31 x 512 GB
// where a single query found none and one. This runs the variants, parses each
// results page once, and dedupes by ASIN.
//
// WHAT IT NO LONGER DOES (removed in 1.2.1): it used to shell out to a Python
// fetcher that replayed your stored amazon.es login cookies, with --session and
// --next-day flags that made delivery promises address-specific. That whole
// credential path is gone from this package, so this reads amazon.es exactly the
// way an anonymous visitor does — no account, no cookies, no subprocess. Price,
// stock, title and images do not need a login; a personalised delivery promise
// does, and is therefore simply not something this skill reports any more.
//
// Requests are paced by scripts/fetch.mjs at a fixed interval, so a sweep is
// deliberately sequential and polite rather than parallel and loud.
//
// Usage:
//   node fast-search.mjs --query "micro sd" [--sweep "1tb,512gb,256gb,128gb"]
//                        [--pages 2] [--out dataset.json]

import fs from "node:fs";
import { extractSearchResults } from "./extract-search.mjs";
import { createFetcher } from "./fetch.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};

const baseQuery = flag("query");
if (!baseQuery) {
  console.error(
    'usage: fast-search.mjs --query "micro sd" [--sweep "1tb,512gb"] [--pages N] [--out dataset.json]',
  );
  process.exit(5);
}

const sweep = (flag("sweep", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const pages = Math.max(1, Number(flag("pages", "1")) || 1);

const searchUrl = (query, page) => {
  const u = new URL("https://www.amazon.es/s");
  u.searchParams.set("k", query);
  if (page > 1) u.searchParams.set("page", String(page));
  return u.toString();
};

const fetcher = createFetcher();

/** One anonymous search page → HTML string (or null, with the reason logged). */
async function fetchOne(query, page) {
  const r = await fetcher.get(searchUrl(query, page));
  if (r.outcome !== "OK") {
    console.error(`  ✗ ${query} p${page}: BLOCKED:${r.reason}`);
    return null;
  }
  return r.body;
}

const queries = sweep.length ? sweep.map((s) => `${baseQuery} ${s}`) : [baseQuery];

const t0 = Date.now();
const htmls = [];
for (const q of queries) {
  for (let p = 1; p <= pages; p++) htmls.push(await fetchOne(q, p));
}
const fetchMs = Date.now() - t0;

const byAsin = new Map();
let parsed = 0;
for (const html of htmls) {
  if (!html) continue;
  for (const r of extractSearchResults(html)) {
    parsed++;
    const prev = byAsin.get(r.asin);
    // Keep the cheapest sighting; the same ASIN appears across sweep queries.
    if (!prev || (r.current_price_eur ?? Infinity) < (prev.current_price_eur ?? Infinity)) {
      byAsin.set(r.asin, r);
    }
  }
}
const rows = [...byAsin.values()];
const okPages = htmls.filter(Boolean).length;

const summary = {
  ok: okPages > 0,
  anonymous: true,
  queries: queries.length,
  pages_requested: htmls.length,
  pages_ok: okPages,
  rows_seen: parsed,
  unique_asins: rows.length,
  fetch_seconds: +(fetchMs / 1000).toFixed(2),
  total_seconds: +((Date.now() - t0) / 1000).toFixed(2),
};

const out = flag("out");
if (out) {
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  summary.out = out;
}
console.log(JSON.stringify(summary, null, 2));
if (!okPages) process.exit(1);
