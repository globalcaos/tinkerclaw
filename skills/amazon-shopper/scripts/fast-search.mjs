#!/usr/bin/env node
// fast-search.mjs — the default search path: parallel cookie-replay HTTP.
//
// Speed comes from three places, in order of impact:
//   1. No browser. Driving the shared tab costs ~40-60 s per page (navigate,
//      settle, chunked DOM read). Cookie replay is ~1.5 s.
//   2. Queries run CONCURRENTLY. A capacity sweep is N independent requests;
//      running them in series was the other half of the old slowness.
//   3. One parse pass, deduped by ASIN.
//
// It also fixes a correctness bug the old path had: ONE keyword query is one
// slice of the catalogue. Sweeping variants ("micro sd 1tb", "micro sd 512gb")
// found 18 x 1 TB and 31 x 512 GB where a single query found none and one.
//
// Usage:
//   node fast-search.mjs --query "micro sd" [--sweep "1tb,512gb,256gb,128gb"]
//                        [--next-day] [--pages 2] [--out dataset.json]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSearchResults } from "./extract-search.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCH_PY = path.join(HERE, "amazon_fetch.py");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

const baseQuery = flag("query");
if (!baseQuery) {
  console.error(
    'usage: fast-search.mjs --query "micro sd" [--sweep "1tb,512gb"] [--next-day] [--session] [--pages N]',
  );
  process.exit(5);
}
const sweep = (flag("sweep", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const pages = Number(flag("pages", "1"));
const nextDay = has("next-day");
// Anonymous unless asked. --session replays the stored amazon.es session, which is
// what makes a delivery promise address-specific rather than a generic estimate;
// without it these runs carry no credential at all.
const useSession = has("session");
if (nextDay && !useSession) {
  console.error(
    "note: --next-day without --session returns Amazon's GENERIC delivery estimate, not a promise " +
      "for your address. Add --session (after `node scripts/session-capture.mjs --yes`) for the real one.",
  );
}
const CONCURRENCY = Number(flag("concurrency", "5"));

/** One amazon_fetch.py run → HTML string (or null, with the reason logged). */
function fetchOne(query, page) {
  return new Promise((resolve) => {
    const args = [FETCH_PY, "--query", query, "--page", String(page)];
    if (nextDay) args.push("--next-day");
    if (useSession) args.push("--session");
    const p = spawn("python3", args, { maxBuffer: 64 * 1024 * 1024 });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) {
        // Surface the machine-readable prefix (SESSION_STALE / BLOCKED) so the
        // caller can tell "needs a re-capture" from "no results".
        console.error(`  ✗ ${query} p${page}: ${err.trim().split("\n").pop()}`);
        return resolve(null);
      }
      resolve(out);
    });
  });
}

async function pool(tasks, n) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (i < tasks.length) {
        const idx = i++;
        results[idx] = await tasks[idx]();
      }
    }),
  );
  return results;
}

const queries = sweep.length ? sweep.map((s) => `${baseQuery} ${s}`) : [baseQuery];
const jobs = [];
for (const q of queries) for (let p = 1; p <= pages; p++) jobs.push(() => fetchOne(q, p));

const t0 = Date.now();
const htmls = await pool(jobs, CONCURRENCY);
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
  queries: queries.length,
  pages_requested: jobs.length,
  pages_ok: okPages,
  rows_seen: parsed,
  unique_asins: rows.length,
  next_day: rows.filter((r) => r.delivery_tomorrow).length,
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
