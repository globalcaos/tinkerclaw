#!/usr/bin/env node
// marketplace-search/wallapop.mjs — fetch Wallapop public search API.
//
// Replaces the browser-relay CDP path the marketplace-watcher cron used to
// drive (bug task-mpie1ypb-1e8i6 / FORK 2026-05-24). No browser involved;
// the public search endpoint at api.wallapop.com requires no auth.
//
// Output: one JSON object to stdout with { source, keywords, fetched_at,
// count, listings[] }. Listings are normalised to the shape consumed by
// the cron's Step 5 scoring (title, price, location, distance_km, url,
// image_url, created_at_iso, seller_handle).
//
// Exit codes:
//   0  — success, JSON on stdout
//   1  — bad CLI args
//   2  — BLOCKED: <reason> on stderr (HTTP non-2xx, parse failure,
//        rate-limit). Cron should treat as "this source failed, mark 🟡,
//        continue" exactly as the prior browser-relay path's blocked-state
//        contract.

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    keywords: { type: "string" },
    limit: { type: "string", default: "10" },
    latitude: { type: "string", default: "41.3851" },
    longitude: { type: "string", default: "2.1734" },
    order_by: { type: "string", default: "newest" },
    max_price: { type: "string" },
    min_price: { type: "string" },
  },
  strict: false,
});

if (!values.keywords || !values.keywords.trim()) {
  process.stderr.write("ERROR: --keywords is required\n");
  process.exit(1);
}

const keywords = String(values.keywords).trim();
const limit = Math.max(1, Math.min(50, Number.parseInt(String(values.limit), 10) || 10));
const latitude = Number.parseFloat(String(values.latitude));
const longitude = Number.parseFloat(String(values.longitude));
const orderBy = String(values.order_by || "newest");

const qs = new URLSearchParams({
  keywords,
  latitude: String(latitude),
  longitude: String(longitude),
  order_by: orderBy,
  filters_source: "quick_filters",
});
if (values.max_price) qs.set("max_sale_price", String(values.max_price));
if (values.min_price) qs.set("min_sale_price", String(values.min_price));

const url = `https://api.wallapop.com/api/v3/general/search?${qs.toString()}`;

// Modern Chrome-on-Mac UA — Wallapop's edge accepts unauthenticated reads
// with a normal browser UA. Mobile UA also works but yields a slightly
// different listing-card shape; desktop is more consistent.
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "X-AppVersion": "84140",
  "X-DeviceOS": "0",
  Origin: "https://es.wallapop.com",
  Referer: "https://es.wallapop.com/",
};

let resp;
try {
  resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
} catch (err) {
  process.stderr.write(`BLOCKED: fetch-error ${err.message || err}\n`);
  process.exit(2);
}

if (!resp.ok) {
  // 403 / 429 / 5xx all indicate the API doesn't want to serve us. Bucket
  // them as BLOCKED so the cron's fallback logic kicks in.
  process.stderr.write(`BLOCKED: http-${resp.status} ${resp.statusText}\n`);
  process.exit(2);
}

let body;
try {
  body = await resp.json();
} catch (err) {
  process.stderr.write(`BLOCKED: parse-json ${err.message || err}\n`);
  process.exit(2);
}

const objects = Array.isArray(body?.search_objects) ? body.search_objects : [];

const listings = objects.slice(0, limit).map((o) => {
  const id = String(o.id ?? "");
  const title = String(o.title ?? "").trim();
  const description = String(o.description ?? "").trim();
  // Wallapop price shape: { price: number, currency: { id: "EUR" } } OR
  // legacy { sale_price: number, currency_code: "EUR" }. Normalise both.
  const priceRaw = typeof o.price === "number" ? o.price : Number(o.sale_price);
  const currency =
    typeof o.currency?.id === "string" ? o.currency.id : String(o.currency_code ?? "EUR");
  const location =
    String(o.location?.city ?? o.distance_label ?? o.user?.location?.city ?? "").trim() ||
    "(unknown)";
  const distanceKm = typeof o.distance === "number" ? Math.round(o.distance / 100) / 10 : null;
  const slug = (o.web_slug ?? `item-${id}`).toString();
  const listingUrl = `https://es.wallapop.com/item/${slug}`;
  const imageUrl =
    String(o.images?.[0]?.urls?.medium ?? o.images?.[0]?.original_url ?? "").trim() || null;
  const createdAtMs = Number(o.modified_date ?? o.created_at ?? 0);
  const createdAtIso = createdAtMs ? new Date(createdAtMs).toISOString() : null;
  const sellerHandle = String(o.user?.micro_name ?? o.user?.user_name ?? "").trim() || null;
  return {
    id,
    title,
    description: description.length > 280 ? `${description.slice(0, 277)}…` : description,
    price: Number.isFinite(priceRaw) ? priceRaw : null,
    currency,
    location,
    distance_km: distanceKm,
    url: listingUrl,
    image_url: imageUrl,
    created_at_iso: createdAtIso,
    seller_handle: sellerHandle,
  };
});

const out = {
  source: "wallapop",
  keywords,
  fetched_at: new Date().toISOString(),
  count: listings.length,
  listings,
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
