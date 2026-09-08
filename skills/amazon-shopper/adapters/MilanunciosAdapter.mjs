// MilanunciosAdapter.mjs — Milanuncios (Spain classifieds) store adapter.
//
// Ports the extract logic from
//   ~/.openclaw/workspace/skills/marketplace-search/scripts/milanuncios.mjs:139-196
// (the three window.__INITIAL_PROPS__ / __NEXT_DATA__ shape variants, then
// navigating to adListPagination.adList.ads), and normalizes each ad to the
// shared Listing schema (scripts/store.mjs:27-58) so the same orchestrator and
// store.insertProducts work unchanged.
//
// Milanuncios has no stable "ASIN"; we use the ad's numeric `id` as the
// store-agnostic product id (the `asin` Listing field — unique within a result
// set). Classifieds have no rating/prime/best-seller, so those normalize to
// null/false.

import { StoreAdapter } from "./StoreAdapter.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Ported verbatim from milanuncios.mjs:139-171 — the three embedded-JSON shapes.
function extractInitialProps(src) {
  // Shape A: window.__INITIAL_PROPS__ = JSON.parse("...double-encoded...");
  const jpMatch = src.match(/window\.__INITIAL_PROPS__\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\s*\)/);
  if (jpMatch) {
    try {
      const innerJson = JSON.parse(`"${jpMatch[2]}"`);
      return { obj: JSON.parse(innerJson), source: "INITIAL_PROPS-json-parse" };
    } catch (err) {
      return { error: `parse-json (INITIAL_PROPS-json-parse): ${err.message || err}` };
    }
  }
  // Shape B: window.__INITIAL_PROPS__ = {...};
  const bMatch = src.match(/window\.__INITIAL_PROPS__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
  if (bMatch) {
    try {
      return { obj: JSON.parse(bMatch[1]), source: "INITIAL_PROPS-direct" };
    } catch (err) {
      return { error: `parse-json (INITIAL_PROPS-direct): ${err.message || err}` };
    }
  }
  // Shape C: <script id="__NEXT_DATA__" type="application/json">{...}</script>
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

// Ported from milanuncios.mjs:185-197 — the known tree shapes to the ad array.
function adsFrom(parsed) {
  const candidates = [
    parsed?.adListPagination?.adList?.ads,
    parsed?.props?.pageProps?.adList?.ads,
    parsed?.props?.pageProps?.initialReduxState?.ads?.list,
    parsed?.props?.pageProps?.results,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }
  return [];
}

// Normalize one milanuncios ad → shared Listing. Field-mapping derived from
// milanuncios.mjs:219-270.
function adToListing(o, position) {
  const id = String(o.id ?? "");
  const title = String(o.title ?? "").trim();
  const priceRaw = Number(o.price?.cashPrice?.value ?? o.price?.value ?? NaN);
  const relUrl = String(o.url ?? "").trim();
  const url = relUrl
    ? relUrl.startsWith("http")
      ? relUrl
      : `https://www.milanuncios.com${relUrl}`
    : `https://www.milanuncios.com/`;
  const firstImage = String(o.images?.[0] ?? "").trim();
  const image_url = firstImage
    ? firstImage.startsWith("http")
      ? firstImage
      : `https://${firstImage.replace(/^\/+/, "")}`
    : null;
  const seller_name = o.sellerType === "professional" ? "(professional)" : "(private)";
  return {
    asin: id, // store-agnostic product id
    position,
    title,
    url,
    image_url,
    current_price_eur: Number.isFinite(priceRaw) ? priceRaw : null,
    list_price_eur: null,
    rating: null,
    review_count: null,
    is_prime: false,
    is_best_seller: false,
    seller_name,
    seller_is_amazon: false,
    // Classifieds have no stock concept: a listing is one used item that may
    // already be sold, and nothing in the search HTML says which. Reporting 1
    // ("in stock") coerced that unknown into a positive, which is exactly the
    // kind of false confidence the availability gate exists to prevent. null =
    // unknown, and downstream must treat it as unknown.
    in_stock: null,
    // Source discriminator so no consumer can mistake a classifieds row for an
    // Amazon row with the same field names.
    source: "milanuncios",
    listing_kind: "classified",
  };
}

export class MilanunciosAdapter extends StoreAdapter {
  get name() {
    return "milanuncios";
  }

  slugUrl(keywords) {
    const slug = String(keywords)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `https://www.milanuncios.com/anuncios/${slug}.htm`;
  }

  // REQUIRED. Parse search-results HTML into normalized Listing[].
  // Throws on an unparseable response so the orchestrator can mark BLOCKED.
  extract(html, context = {}) {
    const { maxProducts = 50 } = context;
    const ex = extractInitialProps(html);
    if (ex.error) throw new Error(`milanuncios extract: ${ex.error}`);
    const ads = adsFrom(ex.obj);
    const out = [];
    let position = 1;
    for (const o of ads) {
      if (o?.sellType === "demand") continue; // skip "looking for X" ISOs
      out.push(adToListing(o, position++));
      if (out.length >= maxProducts) break;
    }
    return out;
  }

  // REQUIRED. Fetch the slug-path search page over HTTP, then extract.
  // Returns { outcome:"OK", products } or { outcome:"BLOCKED", reason }.
  async search(keywords, opts = {}) {
    const doFetch = opts.fetch || globalThis.fetch;
    const url = this.slugUrl(keywords);
    let resp;
    try {
      resp = await doFetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      return { outcome: "BLOCKED", reason: `fetch-error ${err.message || err}` };
    }
    const cls = this.classifyResponse({ status: resp.status, body: "" });
    if (cls.outcome === "BLOCKED") return cls;
    const html = await resp.text();
    const bodyCls = this.classifyResponse({ status: resp.status, body: html });
    if (bodyCls.outcome === "BLOCKED") return bodyCls;
    try {
      return { outcome: "OK", products: this.extract(html, { keywords }) };
    } catch (err) {
      return { outcome: "BLOCKED", reason: err.message };
    }
  }

  // Optional. Classify a milanuncios response (403/WAF/cookie-wall) — mirrors
  // the BLOCKED reasons in milanuncios.mjs:92-124.
  classifyResponse({ status, body }) {
    if (status === 403) return { outcome: "BLOCKED", reason: "waf http-403" };
    if (status >= 400) return { outcome: "BLOCKED", reason: `http-${status}` };
    if (body) {
      if (
        body.includes("Access to Milanuncios is subject to consenting to certain cookies") ||
        body.includes("Acceso a Milanuncios está sujeto a aceptar ciertas cookies")
      ) {
        return { outcome: "BLOCKED", reason: "cookie-wall" };
      }
      if (body.includes("aws-waf") || body.includes("AWSWAF") || body.includes("Request blocked")) {
        return { outcome: "BLOCKED", reason: "waf challenge-html" };
      }
    }
    return { outcome: "OK" };
  }
}

export default MilanunciosAdapter;
