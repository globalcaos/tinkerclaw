#!/usr/bin/env node
// marketplace-search/milanuncios.mjs — fetch Milanuncios search via HTML.
//
// Same role as the wallapop.mjs sibling: replaces the browser-relay CDP
// path the marketplace-watcher cron used (bug task-mpie1ypb-1e8i6 /
// FORK 2026-05-24). Milanuncios has no public JSON API; we fetch the
// search-results HTML and parse the `window.__INITIAL_PROPS__` JSON
// blob it embeds (same blob the in-page CDP script would have read).
//
// Output: one JSON object to stdout with { source, keywords, fetched_at,
// count, listings[] }. Listings are normalised to the same envelope as
// wallapop.mjs so the cron's Step 5 scoring is source-agnostic.
//
// Exit codes:
//   0  — success, JSON on stdout
//   1  — bad CLI args
//   2  — BLOCKED: <reason> on stderr. Reasons:
//        - waf       (HTTP 403 or AWS WAF challenge HTML detected)
//        - cookie-wall (consent splash returned, see SKILL.md)
//        - http-Nxx  (other HTTP error)
//        - parse-html (no __INITIAL_PROPS__ found in response)
//        - parse-json (props blob found but JSON.parse failed)
//        - fetch-error (network)

import { parseArgs } from "node:util";

// FORK 2026-05-24 (smoke-test result): the legacy /buscar/?s=<keywords>
// endpoint now 404s and meta-redirects to /. The slug-path /anuncios/
// <slug>.htm is the only HTTP shape that currently returns a real listing
// page with __INITIAL_PROPS__, so it's the default; --search-path is the
// opt-in for the legacy form (kept for the day milanuncios brings it back).
const { values } = parseArgs({
  options: {
    keywords: { type: "string" },
    limit: { type: "string", default: "10" },
    order: { type: "string", default: "fechaDesc" }, // or "precioAsc", "precioDesc", "relevancia"
    max_price: { type: "string" },
    search_path: { type: "boolean", default: false },
  },
  strict: false,
});

if (!values.keywords || !values.keywords.trim()) {
  process.stderr.write("ERROR: --keywords is required\n");
  process.exit(1);
}

const keywords = String(values.keywords).trim();
const limit = Math.max(1, Math.min(50, Number.parseInt(String(values.limit), 10) || 10));
const order = String(values.order || "fechaDesc");

// Two URL shapes, per the bible's history of WAF/cookie-wall workarounds:
//   - /anuncios/<slug>.htm   — the slug-path (DEFAULT — currently the only
//                               shape that returns a real listing page;
//                               smoke-tested 2026-05-24)
//   - /buscar/?s=<keywords>  — the legacy search endpoint (now 404→/)
// Default to slug-path; pass --search-path to try the legacy form.
let searchUrl;
if (values.search_path) {
  const qs = new URLSearchParams({ s: keywords, orden: order });
  if (values.max_price) qs.set("precioHasta", String(values.max_price));
  searchUrl = `https://www.milanuncios.com/buscar/?${qs.toString()}`;
} else {
  const slug = keywords
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  searchUrl = `https://www.milanuncios.com/anuncios/${slug}.htm`;
}

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

let resp;
try {
  resp = await fetch(searchUrl, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
} catch (err) {
  process.stderr.write(`BLOCKED: fetch-error ${err.message || err}\n`);
  process.exit(2);
}

if (resp.status === 403) {
  process.stderr.write(`BLOCKED: waf http-403\n`);
  process.exit(2);
}
if (!resp.ok) {
  process.stderr.write(`BLOCKED: http-${resp.status} ${resp.statusText}\n`);
  process.exit(2);
}

let html;
try {
  html = await resp.text();
} catch (err) {
  process.stderr.write(`BLOCKED: fetch-error read-body ${err.message || err}\n`);
  process.exit(2);
}

// Cookie-wall detection — the consent splash is plain text in the body.
// Per the bible (cron-marketplace-watcher-prompt.txt Step 3): the slug-path
// fallback does NOT bypass cookie-walls; mark 🟡 and continue.
if (
  html.includes("Access to Milanuncios is subject to consenting to certain cookies") ||
  html.includes("Acceso a Milanuncios está sujeto a aceptar ciertas cookies")
) {
  process.stderr.write(`BLOCKED: cookie-wall\n`);
  process.exit(2);
}

// AWS WAF challenge signature
if (html.includes("aws-waf") || html.includes("AWSWAF") || html.includes("Request blocked")) {
  process.stderr.write(`BLOCKED: waf challenge-html\n`);
  process.exit(2);
}

// Extract window.__INITIAL_PROPS__ blob. Milanuncios uses three shapes
// depending on route + render path; try all three in order.
//
// Shape A (current, smoke-tested 2026-05-24 on /anuncios/<slug>.htm):
//   window.__INITIAL_PROPS__ = JSON.parse("{escaped json string}");
//   The JSON is double-encoded — we read the string-literal arg of JSON.parse,
//   eval (via JSON.parse) it to get the inner JSON string, then JSON.parse THAT
//   to get the object.
// Shape B (legacy, before the JSON.parse wrap):
//   window.__INITIAL_PROPS__ = {...};
// Shape C (newer Next.js routes):
//   <script id="__NEXT_DATA__" type="application/json">{...}</script>

function extractInitialProps(src) {
  // Shape A
  const jpMatch = src.match(/window\.__INITIAL_PROPS__\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\s*\)/);
  if (jpMatch) {
    try {
      // Inner string is JSON-encoded: surround with quotes, parse once to
      // resolve escapes back to a real JSON string, then parse again.
      const innerJson = JSON.parse(`"${jpMatch[2]}"`);
      return { obj: JSON.parse(innerJson), source: "INITIAL_PROPS-json-parse" };
    } catch (err) {
      return { error: `parse-json (INITIAL_PROPS-json-parse): ${err.message || err}` };
    }
  }
  // Shape B
  const bMatch = src.match(/window\.__INITIAL_PROPS__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
  if (bMatch) {
    try {
      return { obj: JSON.parse(bMatch[1]), source: "INITIAL_PROPS-direct" };
    } catch (err) {
      return { error: `parse-json (INITIAL_PROPS-direct): ${err.message || err}` };
    }
  }
  // Shape C
  const cMatch = src.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (cMatch) {
    try {
      return { obj: JSON.parse(cMatch[1]), source: "NEXT_DATA" };
    } catch (err) {
      return { error: `parse-json (NEXT_DATA): ${err.message || err}` };
    }
  }
  return { error: "parse-html no __INITIAL_PROPS__ or __NEXT_DATA__ found" };
}

const extracted = extractInitialProps(html);
if (extracted.error) {
  process.stderr.write(`BLOCKED: ${extracted.error}\n`);
  process.exit(2);
}
const parsed = extracted.obj;
const propsSource = extracted.source;

// Navigate the parsed tree to the ads list. Two known shapes:
//   INITIAL_PROPS path: parsed.adListPagination?.adList?.ads
//   NEXT_DATA   path:   parsed.props?.pageProps?.adList?.ads
//                  OR   parsed.props?.pageProps?.initialReduxState?.ads?.list
let ads = [];
const candidates = [
  parsed?.adListPagination?.adList?.ads,
  parsed?.props?.pageProps?.adList?.ads,
  parsed?.props?.pageProps?.initialReduxState?.ads?.list,
  parsed?.props?.pageProps?.results,
];
for (const c of candidates) {
  if (Array.isArray(c) && c.length > 0) {
    ads = c;
    break;
  }
}

if (ads.length === 0) {
  // Empty but parseable — possibly genuinely no results. Emit empty
  // listings, exit success with 0 count rather than BLOCKED.
  process.stdout.write(
    `${JSON.stringify(
      {
        source: "milanuncios",
        keywords,
        fetched_at: new Date().toISOString(),
        count: 0,
        listings: [],
        note: "no ads parsed from response (could be empty result set or unknown shape)",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

// Field-mapping derived from smoke-test 2026-05-24 on /anuncios/leica.htm:
//   price        = { cashPrice: { value: N } }  (sometimes other keys for
//                                                financed/etc.; cashPrice
//                                                is the relevant one)
//   location     = { city:{name}, province:{name}, region:{name} }
//   images       = [ "images.milanuncios.com/api/v1/...", ... ]  (no scheme)
//   url          = "/category/title-id.htm"  (relative; needs prefix)
//   publishDate  = "2024-06-24T15:25:20Z"  (creation; we prefer sortDate
//                                            for "newness" ranking)
//   sortDate     = "2026-05-21T22:53:25Z"  (last-bumped; what the cron's
//                                            freshness signal should use)
//   sellerType   = "professional" | "private"
//   sellType     = "supply" | "demand" (filter demand=ISOs)
const listings = ads
  .filter((o) => o?.sellType !== "demand") // skip "looking for X" ISOs
  .slice(0, limit)
  .map((o) => {
    const id = String(o.id ?? "");
    const title = String(o.title ?? "").trim();
    const description = String(o.description ?? "").trim();
    const priceRaw = Number(o.price?.cashPrice?.value ?? o.price?.value ?? NaN);
    const city = String(o.location?.city?.name ?? o.city?.name ?? "").trim();
    const province = String(o.location?.province?.name ?? o.province?.name ?? "").trim();
    const location = [city, province].filter(Boolean).join(", ") || "(unknown)";
    const relUrl = String(o.url ?? "").trim();
    const listingUrl = relUrl.startsWith("http") ? relUrl : `https://www.milanuncios.com${relUrl}`;
    const firstImage = String(o.images?.[0] ?? "").trim();
    const imageUrl = firstImage
      ? firstImage.startsWith("http")
        ? firstImage
        : `https://${firstImage.replace(/^\/+/, "")}`
      : null;
    // sortDate is when the listing was last bumped (the "newness" signal the
    // cron's freshness scoring wants). publishDate is the original creation
    // date — less useful for daily ranking, kept under created_at_iso_orig
    // for audit.
    const createdAtIso = o.sortDate ?? o.publishDate ?? null;
    return {
      id,
      title,
      description: description.length > 280 ? `${description.slice(0, 277)}…` : description,
      price: Number.isFinite(priceRaw) ? priceRaw : null,
      currency: "EUR",
      location,
      distance_km: null, // milanuncios doesn't compute distance from the requester
      url: listingUrl,
      image_url: imageUrl,
      created_at_iso: createdAtIso,
      created_at_iso_orig: o.publishDate ?? null,
      seller_handle: o.sellerType === "professional" ? "(professional)" : "(private)",
    };
  });

const out = {
  source: "milanuncios",
  keywords,
  fetched_at: new Date().toISOString(),
  count: listings.length,
  listings,
  _meta: { props_source: propsSource, search_path: values.search_path === true },
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
