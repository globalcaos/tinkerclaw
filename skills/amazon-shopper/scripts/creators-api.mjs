// creators-api.mjs — Amazon Creators API client (replaces deprecating PA-API 5.0).
//
// Amazon is deprecating PA-API on 2026-05-15. The Creators API is the
// future-proof path. Both require the same eligibility gate: ≥10 qualifying
// sales in the last 30 days (per locale). Credentials are SEPARATE from AWS
// IAM — generated inside Associates Central → Tools → Creators API.
//
// Env vars (all required; module is a no-op without them):
//   AMAZON_SHOPPER_CREATORS_ACCESS_KEY     — Creators API access key
//   AMAZON_SHOPPER_CREATORS_SECRET_KEY     — Creators API secret key
//   AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG  — Associate tag (e.g. <your-associate-tag>)
//   AMAZON_SHOPPER_CREATORS_REGION         — Marketplace (default: es)
//
// Activation: when all three of ACCESS_KEY / SECRET_KEY / ASSOCIATE_TAG are
// set, shopper.mjs prefers this module over the HTML fetcher. Otherwise the
// HTML path is used (currently WAF-blocked from this gateway IP; honest exit).

const REGION_HOST = {
  es: "webservices.amazon.es",
  us: "webservices.amazon.com",
  uk: "webservices.amazon.co.uk",
  de: "webservices.amazon.de",
  fr: "webservices.amazon.fr",
  it: "webservices.amazon.it",
};

const SERVICE = "ProductAdvertisingAPI"; // Creators API uses the same service signing as PAAPI 5
const TARGET_PREFIX = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.";

export function creatorsApiConfigured() {
  return Boolean(
    process.env.AMAZON_SHOPPER_CREATORS_ACCESS_KEY &&
    process.env.AMAZON_SHOPPER_CREATORS_SECRET_KEY &&
    process.env.AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG,
  );
}

function getConfig() {
  const accessKey = process.env.AMAZON_SHOPPER_CREATORS_ACCESS_KEY;
  const secretKey = process.env.AMAZON_SHOPPER_CREATORS_SECRET_KEY;
  const partnerTag = process.env.AMAZON_SHOPPER_CREATORS_ASSOCIATE_TAG;
  const region = (process.env.AMAZON_SHOPPER_CREATORS_REGION || "es").toLowerCase();
  if (!accessKey || !secretKey || !partnerTag) {
    throw new Error("Creators API not configured (missing env vars).");
  }
  const host = REGION_HOST[region];
  if (!host) {
    throw new Error(
      `Unknown region "${region}". Supported: ${Object.keys(REGION_HOST).join(", ")}.`,
    );
  }
  return { accessKey, secretKey, partnerTag, region, host };
}

// AWS SigV4 signing — same algorithm PA-API 5 used. Creators API
// piggybacks on it. References:
//   https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html
//   https://webservices.amazon.com/paapi5/documentation/sending-request.html
async function signRequest({ method, host, path, payload, accessKey, secretKey, region }) {
  const { createHash, createHmac } = await import("node:crypto");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const contentEncoding = "amz-1.0";
  const contentType = "application/json; charset=utf-8";

  const canonicalUri = path;
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:${contentEncoding}\n` +
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${TARGET_PREFIX}SearchItems\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign =
    `${algorithm}\n${amzDate}\n${credentialScope}\n` +
    createHash("sha256").update(canonicalRequest).digest("hex");

  const kDate = createHmac("sha256", `AWS4${secretKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(SERVICE).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization =
    `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    "Content-Encoding": contentEncoding,
    "Content-Type": contentType,
    Host: host,
    "X-Amz-Date": amzDate,
    "X-Amz-Target": `${TARGET_PREFIX}SearchItems`,
    Authorization: authorization,
  };
}

// SearchItems — main entry for keyword → product[] lookup.
//
// Returns the same shape as extract-search.mjs:extractSearchResults() so the
// rest of the pipeline (categorize, research, rank) is source-agnostic.
export async function searchItems(keywords, { maxProducts = 10, _fetch = globalThis.fetch } = {}) {
  const { accessKey, secretKey, partnerTag, region, host } = getConfig();
  const path = "/paapi5/searchitems";
  const payload = JSON.stringify({
    Keywords: keywords,
    SearchIndex: "All",
    ItemCount: Math.min(10, maxProducts),
    PartnerTag: partnerTag,
    PartnerType: "Associates",
    Marketplace: `www.amazon.${region}`,
    Resources: [
      "Images.Primary.Large",
      "ItemInfo.Title",
      "ItemInfo.Features",
      "ItemInfo.ProductInfo",
      "Offers.Listings.Price",
      "Offers.Listings.SavingBasis",
      "CustomerReviews.Count",
      "CustomerReviews.StarRating",
    ],
  });

  const headers = await signRequest({
    method: "POST",
    host,
    path,
    payload,
    accessKey,
    secretKey,
    region,
  });

  const res = await _fetch(`https://${host}${path}`, {
    method: "POST",
    headers,
    body: payload,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Creators API SearchItems failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return mapSearchResponseToProducts(data, partnerTag);
}

// Map Creators API JSON to the product[] shape extract-search.mjs produces.
function mapSearchResponseToProducts(data, _partnerTag) {
  const items = data?.SearchResult?.Items ?? [];
  return items.map((item, i) => ({
    asin: item.ASIN,
    position: i + 1,
    title: item.ItemInfo?.Title?.DisplayValue ?? "",
    url: item.DetailPageURL ?? `https://www.amazon.es/dp/${item.ASIN}/`,
    image_url: item.Images?.Primary?.Large?.URL ?? null,
    current_price_eur: item.Offers?.Listings?.[0]?.Price?.Amount ?? null,
    list_price_eur: item.Offers?.Listings?.[0]?.SavingBasis?.Amount ?? null,
    rating: item.CustomerReviews?.StarRating?.Value ?? null,
    review_count: item.CustomerReviews?.Count ?? null,
    is_prime: Boolean(item.Offers?.Listings?.[0]?.DeliveryInfo?.IsPrimeEligible),
    is_best_seller: false,
  }));
}

// GetItems — detail-page equivalent. Returns the same shape as
// extract-detail.mjs:extractDetailSpec() so the research ladder can ingest.
export async function getItem(asin, { _fetch = globalThis.fetch } = {}) {
  const { accessKey, secretKey, partnerTag, region, host } = getConfig();
  const path = "/paapi5/getitems";
  const payload = JSON.stringify({
    ItemIds: [asin],
    PartnerTag: partnerTag,
    PartnerType: "Associates",
    Marketplace: `www.amazon.${region}`,
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.Features",
      "ItemInfo.ProductInfo",
      "ItemInfo.ManufactureInfo",
      "ItemInfo.TechnicalInfo",
    ],
  });
  const headers = await signRequest({
    method: "POST",
    host,
    path,
    payload,
    accessKey,
    secretKey,
    region,
  });
  // GetItems uses a different X-Amz-Target.
  headers["X-Amz-Target"] = `${TARGET_PREFIX}GetItems`;

  const res = await _fetch(`https://${host}${path}`, {
    method: "POST",
    headers,
    body: payload,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Creators API GetItems failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const item = data?.ItemsResult?.Items?.[0];
  if (!item)
    return {
      title: null,
      brand: null,
      weight_kg: null,
      bullets: [],
      detail_rows: {},
      combined_text: "",
    };

  const title = item.ItemInfo?.Title?.DisplayValue ?? null;
  const bullets = item.ItemInfo?.Features?.DisplayValues ?? [];
  const brand = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ?? null;
  const detail_rows = {};
  const tech = item.ItemInfo?.TechnicalInfo?.Specifications ?? [];
  for (const spec of tech) {
    if (spec.Name && spec.Value) detail_rows[String(spec.Name).toLowerCase()] = String(spec.Value);
  }
  return {
    title,
    brand,
    weight_kg: null,
    bullets,
    detail_rows,
    combined_text: [
      title ? `Title: ${title}` : "",
      brand ? `Brand: ${brand}` : "",
      bullets.length ? `Bullets:\n- ${bullets.join("\n- ")}` : "",
      Object.keys(detail_rows).length
        ? `Details:\n${Object.entries(detail_rows)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
