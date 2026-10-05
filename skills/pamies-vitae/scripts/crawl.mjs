#!/usr/bin/env node
// crawl.mjs — zero-dep crawler for web.pamiesvitae.com (WordPress/WooCommerce).
//
// The WooCommerce Store API + wp/v2 REST endpoints are locked by a security
// plugin (403/401), but the native WP sitemap is public and robots.txt permits
// crawling product pages. Each product page carries clean JSON-LD (Product +
// BreadcrumbList) with name, sku, price, availability — and the slug/name embeds
// the Latin binomial. This crawler walks the sitemap, fetches product pages
// politely, parses the JSON-LD, classifies the product's available FORMS
// (live plant / seed / dried herb / extract), and emits structured JSON.
//
// Subcommands: sitemap | categories | product | search | crawl
// All emit one JSON object/array on stdout; human text goes to stderr.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://web.pamiesvitae.com";
const SITEMAP_INDEX = `${BASE}/wp-sitemap.xml`;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CACHE_DIR =
  process.env.PAMIES_CACHE_DIR ||
  join(homedir(), ".openclaw", "workspace", "memory", "pamies-vitae", "cache");
const CACHE_TTL_MS = Number(process.env.PAMIES_CACHE_TTL_MS ?? 7 * 24 * 3600 * 1000);

// ── Form classification ──────────────────────────────────────────────────────
// A single product is often sold in several formats (seed + dried sachet, etc).
// We detect every form it offers from attribute slugs + visible ES/CA labels.
const FORM_RULES = [
  {
    form: "live",
    tokens: [
      "planters",
      "planter",
      "planta viva",
      "plantel",
      "testos",
      "test ",
      "esqueje",
      "maceta",
    ],
  },
  { form: "seed", tokens: ["llavor", "llavors", "semilla", "semillas", "seed"] },
  {
    form: "dried",
    tokens: [
      "sobre",
      "tarrina",
      "bossa",
      "bolsa",
      "pols",
      "polvo",
      "tauleta de te",
      "planta seca",
      "infusion",
      "infusión",
      "ramillete",
      "manojo",
    ],
  },
  {
    form: "extract",
    tokens: [
      "gotes",
      "gotas",
      "tintura",
      "comprimits",
      "comprimidos",
      "capsules",
      "cápsulas",
      "capsulas",
      "vial",
      "ampolla",
      "extracto",
      "jarabe",
      "aceite esencial",
      "oleato",
    ],
  },
];

// Category slug → form. The product's WooCommerce category is the most reliable
// static signal (variation dropdowns load via AJAX and aren't in the HTML).
const CATEGORY_FORM = [
  {
    form: "live",
    re: /planter|plantel|nuestras-plantas|todas-las-plantas|plantas-medicinales|plantas-aromaticas|cactus|crasas|tillandsias|purificadoras|aromatiques|horticol|frutal|arbust|trepadora/,
  },
  { form: "seed", re: /llavor|semilla|semill|germinad/ },
  { form: "dried", re: /infusion|infusión|simples|planta-seca|tisana|condiment|especias|te-|tes-/ },
  {
    form: "extract",
    re: /tintura|gotes|gotas|comprimid|capsul|aceite|oleato|jarabe|extracto|suplement/,
  },
];

function classifyForms(haystackLower, catSlugs = []) {
  const forms = new Set();
  for (const rule of FORM_RULES) {
    if (rule.tokens.some((t) => haystackLower.includes(t))) forms.add(rule.form);
  }
  for (const slug of catSlugs) {
    for (const rule of CATEGORY_FORM) if (rule.re.test(slug)) forms.add(rule.form);
  }
  return [...forms];
}

// ── HTTP with cache + polite cadence + 1 retry ───────────────────────────────
function cachePath(url) {
  const safe = url.replace(/[^a-z0-9]+/gi, "_").slice(0, 180);
  return join(CACHE_DIR, safe);
}
function readCache(url) {
  const p = cachePath(url);
  if (!existsSync(p)) return null;
  if (Date.now() - statSync(p).mtimeMs > CACHE_TTL_MS) return null;
  return readFileSync(p, "utf8");
}
function writeCache(url, body) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(url), body);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { useCache = true, delayMs = 0, jitterMs = 0 } = {}) {
  if (useCache) {
    const c = readCache(url);
    if (c !== null) return { body: c, cached: true };
  }
  if (delayMs || jitterMs) await sleep(delayMs + Math.floor(Math.random() * (jitterMs || 1)));
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, {
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "es-ES,es;q=0.9,ca;q=0.8,en;q=0.7",
        },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(to));
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { body: null, status: res.status, cached: false };
      const body = await res.text();
      writeCache(url, body);
      return { body, status: res.status, cached: false };
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  return { body: null, error: String(lastErr), cached: false };
}

// ── Parsing helpers ──────────────────────────────────────────────────────────
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "’")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&euro;/g, "€");
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(decodeEntities(m[1].trim()));
  return out;
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function pickType(node, type) {
  const t = node["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

// Split "COMMON NAME - Genus species" → scientific binomial when it looks like one.
function scientificFromName(name) {
  if (!name) return null;
  const parts = name.split(/\s[–—-]\s/);
  const tail = parts.length > 1 ? parts[parts.length - 1].trim() : null;
  if (tail && /^[A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:sp\.?|spp\.?|x|×|[a-zà-ÿ]+)){1,3}$/.test(tail))
    return tail;
  return null;
}

function offerPrice(productNode) {
  const o = productNode.offers;
  const offers = Array.isArray(o) ? o : o ? [o] : [];
  for (const of of offers) {
    const cur = of.priceCurrency || "EUR";
    // Variable products → AggregateOffer with a low/high range.
    if (of.lowPrice)
      return {
        price: Number(of.lowPrice),
        price_max: of.highPrice ? Number(of.highPrice) : null,
        currency: cur,
      };
    if (of.price) return { price: Number(of.price), price_max: null, currency: cur };
    const ps = Array.isArray(of.priceSpecification)
      ? of.priceSpecification
      : of.priceSpecification
        ? [of.priceSpecification]
        : [];
    for (const p of ps)
      if (p.price)
        return { price: Number(p.price), price_max: null, currency: p.priceCurrency || cur };
  }
  return { price: null, price_max: null, currency: null };
}

function availabilityOf(productNode) {
  const o = productNode.offers;
  const offers = Array.isArray(o) ? o : o ? [o] : [];
  for (const of of offers) {
    const a = of.availability || "";
    if (a)
      return a.includes("InStock")
        ? "in_stock"
        : a.includes("OutOfStock")
          ? "out_of_stock"
          : a.split("/").pop();
  }
  return "unknown";
}

function parseProduct(html, url) {
  const blocks = jsonLdBlocks(html);
  let prod = null,
    crumbs = [];
  for (const b of blocks) {
    const graph = b["@graph"] || [b];
    for (const n of graph) {
      if (!prod && pickType(n, "Product")) prod = n;
      if (pickType(n, "BreadcrumbList")) {
        crumbs = (n.itemListElement || [])
          .map((e) => decodeEntities(e.name || (e.item && e.item.name) || ""))
          .filter(Boolean);
      }
    }
  }
  if (!prod) return null;
  const name = decodeEntities(prod.name || "");
  const { price, price_max, currency } = offerPrice(prod);
  // body class product_cat-* gives the WooCommerce category slugs.
  const catSlugs = [...new Set([...html.matchAll(/product_cat-([a-z0-9-]+)/gi)].map((m) => m[1]))];
  // Forms: scan the product-options area + body classes + breadcrumb for tokens.
  const formHay =
    (
      html.match(
        /class="[^"]*(?:variations|product_meta|posted_in|summary entry-summary)[^"]*"[\s\S]{0,8000}/i,
      )?.[0] ||
      html.slice(0, 40000) ||
      ""
    ).toLowerCase() +
    " " +
    catSlugs.join(" ") +
    " " +
    crumbs.join(" ").toLowerCase();
  const forms = classifyForms(formHay, catSlugs);
  return {
    name,
    scientific_name: scientificFromName(name),
    sku: prod.sku ? String(prod.sku) : null,
    price,
    price_max,
    currency,
    availability: availabilityOf(prod),
    forms,
    categories: crumbs.length > 2 ? crumbs.slice(1, -1) : crumbs,
    category_slugs: catSlugs,
    url,
  };
}

// ── Sitemap walking ──────────────────────────────────────────────────────────
async function getSitemapIndex() {
  const { body } = await fetchText(SITEMAP_INDEX);
  if (!body) throw new Error("could not fetch sitemap index");
  return extractLocs(body);
}
async function getProductUrls() {
  const idx = await getSitemapIndex();
  const productMaps = idx.filter((u) => /wp-sitemap-posts-product-\d+\.xml/.test(u));
  let urls = [];
  for (const sm of productMaps) {
    const { body } = await fetchText(sm);
    if (body) urls.push(...extractLocs(body).filter((u) => u.includes("/tienda/")));
  }
  return [...new Set(urls)];
}

// ── pool: bounded-concurrency map ────────────────────────────────────────────
async function pool(items, concurrency, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else {
        a[key] = next;
        i++;
      }
    } else a._.push(t);
  }
  return a;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function err(msg) {
  process.stderr.write(msg + "\n");
}

async function cmdSitemap() {
  const idx = await getSitemapIndex();
  const productMaps = idx.filter((u) => /posts-product-\d+/.test(u));
  let total = 0;
  const per = [];
  for (const sm of productMaps) {
    const { body } = await fetchText(sm);
    const n = body ? extractLocs(body).filter((u) => u.includes("/tienda/")).length : 0;
    per.push({ sitemap: sm, products: n });
    total += n;
  }
  out({ index: SITEMAP_INDEX, product_sitemaps: per, total_products: total });
}

async function cmdCategories() {
  const idx = await getSitemapIndex();
  const catMap = idx.find((u) => /taxonomies-product_cat-\d+/.test(u));
  if (!catMap) return out({ categories: [] });
  const { body } = await fetchText(catMap);
  const urls = extractLocs(body);
  const cats = urls.map((u) => {
    const slug = u.replace(/\/$/, "").split("/").pop();
    return { slug, url: u };
  });
  out({ count: cats.length, categories: cats });
}

async function cmdProduct(args) {
  let url = args._[0];
  if (!url) {
    err("usage: product <url-or-slug>");
    process.exit(1);
  }
  if (!url.startsWith("http")) url = `${BASE}/tienda/${url.replace(/^\/|\/$/g, "")}/`;
  const { body, status } = await fetchText(url, { useCache: !args["no-cache"] });
  if (!body) return out({ error: `fetch failed`, status, url });
  const p = parseProduct(body, url);
  if (!p) return out({ error: "no JSON-LD Product on page", url });
  out(p);
}

async function cmdCrawl(args) {
  const limit = args.limit ? Number(args.limit) : Infinity;
  const concurrency = Number(args.concurrency ?? 3);
  const delayMs = Number(args.delay ?? 1200);
  const wantForms =
    args.filter && args.filter !== "all"
      ? String(args.filter)
          .split(",")
          .map((s) => s.trim().toLowerCase())
      : null;
  const query = args.query ? String(args.query).toLowerCase() : null;
  const catFilter = args.category ? String(args.category).toLowerCase() : null;
  const inStockOnly = !!args["in-stock"];

  err("Walking product sitemaps…");
  let urls = await getProductUrls();
  err(`Found ${urls.length} product URLs.`);

  // Cheap pre-filter on the slug (avoids fetching pages we don't want).
  if (query) urls = urls.filter((u) => u.toLowerCase().includes(query));
  err(
    `${urls.length} after slug query filter; fetching up to ${limit === Infinity ? "all" : limit}…`,
  );

  const targets = urls.slice(0, limit === Infinity ? urls.length : limit);
  let done = 0;
  const parsed = await pool(targets, concurrency, async (url) => {
    const { body } = await fetchText(url, {
      useCache: !args["no-cache"],
      delayMs,
      jitterMs: delayMs,
    });
    done++;
    if (done % 25 === 0) err(`  …${done}/${targets.length}`);
    if (!body) return null;
    return parseProduct(body, url);
  });

  let products = parsed.filter(Boolean);
  if (wantForms) products = products.filter((p) => p.forms.some((f) => wantForms.includes(f)));
  if (catFilter)
    products = products.filter(
      (p) =>
        p.category_slugs.some((s) => s.includes(catFilter)) ||
        p.categories.some((c) => c.toLowerCase().includes(catFilter)),
    );
  if (inStockOnly) products = products.filter((p) => p.availability === "in_stock");

  const result = {
    source: BASE,
    crawled: targets.length,
    matched: products.length,
    filters: { forms: wantForms, query, category: catFilter, in_stock_only: inStockOnly },
    products,
  };
  if (args.out) {
    writeFileSync(String(args.out), JSON.stringify(result, null, 2));
    err(`Wrote ${products.length} products → ${args.out}`);
    out({ ...result, products: `[${products.length} products written to ${args.out}]` });
  } else {
    out(result);
  }
}

const HELP = `pamies-vitae — crawl web.pamiesvitae.com for herbs & live medicinal plants

  sitemap                       Count products across the WP sitemaps.
  categories                    List product_cat taxonomy slugs.
  product <url-or-slug>         Fetch + parse one product (JSON-LD).
  crawl [opts]                  Walk all products, parse, classify, filter.

crawl options:
  --filter live,seed,dried,extract   Keep only products offered in these forms (default: all)
  --query <text>                Slug pre-filter (cheap; e.g. --query salvia)
  --category <slug-or-text>     Keep products in matching product_cat / breadcrumb
  --in-stock                    Keep only in-stock products
  --limit N                     Max products to fetch (default: all ~6000)
  --concurrency N               Parallel fetches (default 3)
  --delay MS                    Base per-request delay, jittered (default 1200)
  --out FILE                    Write full JSON to FILE (stdout gets a summary)
  --no-cache                    Bypass the local page cache

Cache: ${CACHE_DIR} (TTL ${Math.round(CACHE_TTL_MS / 86400000)}d). Set PAMIES_CACHE_DIR / PAMIES_CACHE_TTL_MS to override.`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    switch (cmd) {
      case "sitemap":
        return await cmdSitemap();
      case "categories":
        return await cmdCategories();
      case "product":
        return await cmdProduct(args);
      case "crawl":
        return await cmdCrawl(args);
      case "help":
      case "--help":
      case undefined:
        err(HELP);
        return;
      default:
        err(`unknown command: ${cmd}\n\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    out({ error: String(e && e.message ? e.message : e) });
    process.exit(1);
  }
}
main();
