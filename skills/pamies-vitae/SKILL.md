---
name: pamies-vitae
description: >-
  Crawl web.pamiesvitae.com (Pàmies Vitae, a Catalan WordPress/WooCommerce shop)
  for medicinal herbs and live medicinal plants. Use when the user wants to
  search, list, price, or filter Pàmies Vitae's catalogue — e.g. "find live
  ashwagandha / salvia / aloe plants on pamiesvitae", "what dried herbs does
  Pàmies sell", "price of a plant at pamiesvitae", "list their live medicinal
  plants in stock", or building a dataset of their ~4,300 products. Distinguishes
  product FORM (live plant / seed / dried herb / extract), captures the Latin
  binomial, price, stock, and category. NOT for placing orders or checkout.
---

# Pàmies Vitae crawler

The shipped crawler is self-contained and does not require a separate knowledge base. It
provides catalogue facts such as product names, forms, prices, stock, categories, and product
URLs.

A project may separately provide a sourced medicinal-plant knowledge base. Treat it as an
optional enhancement: use it only when it is present, read its source and limitation notes,
and carry through any evidence tiers or hazard warnings. If it is absent, continue using the
crawler for catalogue questions. Do not infer medical uses from memory or from the shop's
product claims; use authoritative health sources for medical questions.

Zero-dependency Node CLI (twin of `amazon-shopper` / `marketplace-search`). The
shop's WooCommerce Store API and `wp/v2` REST endpoints are locked by a security
plugin (403/401), but the **native WP sitemap is public** and robots.txt permits
crawling product pages. Every product page carries clean **JSON-LD** (`Product` +
`BreadcrumbList`) — name, SKU, price, availability — and the title/slug embeds the
**Latin binomial**. The crawler walks the sitemap, fetches product pages politely
(cached), parses the JSON-LD, classifies each product's **form**, and emits JSON.

## CLI

```bash
node {baseDir}/scripts/crawl.mjs sitemap                 # count products across the product sitemaps
node {baseDir}/scripts/crawl.mjs categories              # list product_cat taxonomy slugs
node {baseDir}/scripts/crawl.mjs product <url-or-slug>   # fetch + parse one product (debug)
node {baseDir}/scripts/crawl.mjs crawl [options]         # walk all products, parse, classify, filter
```

Each command prints one JSON object/array on stdout; progress goes to stderr.

### crawl options

| flag                               | meaning                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--filter live,seed,dried,extract` | keep only products offered in these forms (default: all)                                                                                                                 |
| `--query <text>`                   | **cheap slug pre-filter** — only fetch URLs whose slug contains the text (e.g. `--query salvia`). Use this for single-plant lookups; it avoids fetching all 4,300 pages. |
| `--category <slug-or-text>`        | keep products whose product_cat / breadcrumb matches                                                                                                                     |
| `--in-stock`                       | keep only in-stock products                                                                                                                                              |
| `--limit N`                        | max products to fetch (default: all)                                                                                                                                     |
| `--concurrency N`                  | parallel fetches (default 3)                                                                                                                                             |
| `--delay MS`                       | base per-request delay, jittered (default 1200)                                                                                                                          |
| `--out FILE`                       | write full JSON to FILE; stdout gets a summary                                                                                                                           |
| `--no-cache`                       | bypass the local page cache                                                                                                                                              |

### Product record shape

```json
{
  "name": "SALVIA - Salvia officinalis",
  "scientific_name": "Salvia officinalis",
  "sku": "12345",
  "price": 5.45,
  "price_max": 20.0,
  "currency": "EUR",
  "availability": "in_stock",
  "forms": ["dried", "live"],
  "categories": ["Infusiones de plantas medicinales", "Simples"],
  "category_slugs": ["infusiones-de-plantas-medicinales", "simples"],
  "url": "https://web.pamiesvitae.com/tienda/..."
}
```

`price` is the low end of a variable product's range; `price_max` is the high end
(null for fixed-price products).

## Recommended usage

- **Single plant / small set** → always pass `--query` so only matching slugs are
  fetched: `node {baseDir}/scripts/crawl.mjs crawl --query ashwagandha --filter live --in-stock`.
- **Live medicinal plants only** → `--filter live`. Pure live-plant products live
  in the `Nuestras Plantas` / `plantel-horticolas` categories (typ. €3.18); many
  herbs are also offered live alongside a dried sachet.
- **Full catalogue dump** → `node {baseDir}/scripts/crawl.mjs crawl --out catalogue.json` (slow:
  ~4,300 polite fetches; first run is long, then served from cache). Raise
  `--concurrency` / lower `--delay` only with reason — be a good guest.
- **A whole CATEGORY → read the listing pages, not the product pages** (found
  2026-08-25, ~60× cheaper). WooCommerce archive pages carry everything the
  listing-level questions need — title, Latin binomial (in
  `woocommerce-product-details__short-description`), price, and the `instock` /
  `outofstock` class on the `<li class="product ...">` — **12 products per fetch**.
  All 746 live plants came out of 63 fetches in ~90 s; the per-product path would
  have been 746. Page URLs are `<category-url>` then `<category-url>page/N/`; the
  "N productos" counter renders as `0 productos` (JS-populated), so get the page
  count from the `/page/(\d+)/` links in the paginator instead. Only fall back to
  per-product fetches when you need SKU, stock quantity, or the long description.

**Historical category sizes** (observed 2026-08-25):
`nuestras-plantas/todas-las-plantas` = 63 pages / 746 products / 724 in stock.
Re-crawl for current counts and availability.

## Form classification

`forms` is a SET — a product can be sold in several (e.g. dried sachet + live
plant). It's derived from two signals: (1) the WooCommerce **category** (most
reliable: `plantel-horticolas`→live, `llavors`→seed, `infusiones`/`simples`→dried,
`tintura`/`gotes`→extract) and (2) **keyword tokens** in the product summary (ES/CA:
`planter`, `llavor`, `sobre`, `gotes`…). Tune the `FORM_RULES` / `CATEGORY_FORM`
tables at the top of `scripts/crawl.mjs` as new forms appear.

**Known limitation:** variable products load their variation dropdown via AJAX, so
the exact set of purchasable variations isn't in the static HTML. `forms` is a
best-effort inference from category + summary text, not a guaranteed variation
list. Pure live-plant and pure-seed categories classify cleanly; multi-form herbs
may occasionally over- or under-tag a secondary form.

## Data quality — the shop's own taxonomy is unreliable

**Do not trust `scientific_name` for identification.** Audited 2026-08-25 over the
724 in-stock live plants:

- **119 of 724 (16%) carry no binomial at all** — the short-description field is
  empty or holds marketing text. Name-matching cannot rely on `latin` being set.
- **Outright mislabels exist.** The product sold as **"Matricaria"** is labelled
  _Tanacetum partenium_ — that is **feverfew**, not chamomile (_Matricaria
  recutita_). Different plant, different action (migraine prophylaxis vs. mild
  sedative), and the common name actively misleads.
- **Misspelled / wrong-genus binomials** are common: `Euphoria lactea` (→
  _Euphorbia_), `Jazmin grandiflorum` (→ _Jasminum_), `Acacia occidentalis` (→
  _Senna occidentalis_), `Lesvisticum officinale` (→ _Levisticum_), `Nicotina`
  (→ _Nicotiana_), `Filodendro "Red Sun"` (genus as common name).

Consequence: for any **medicinal or edibility** question, confirm the species from
the product page's own description and photo, and treat the listing binomial as a
hint. Fuzzy-match on the Spanish/Catalan common name too — it is more consistently
populated than the Latin.

**Absent staples** (checked 2026-08-25, live-plant catalogue): no _Hypericum_
(St John's wort), no _Calendula_, no true chamomile. _Artemisia annua_ — the
flagship Pàmies plant — exists but was **out of stock** on this date; 22 of 746
records were out of stock overall.

## Politeness & caching

Realistic UA, `accept-language: es,ca`, default 3 concurrent fetches with a
~1.2 s jittered delay, one retry on 5xx/timeout. Pages cache to
`~/.openclaw/workspace/memory/pamies-vitae/cache` (7-day TTL); override with
`PAMIES_CACHE_DIR` / `PAMIES_CACHE_TTL_MS`. robots.txt only disallows cart/admin/
uploads — product pages are allowed.

## Failure modes

| Condition                   | Behaviour                                                      |
| --------------------------- | -------------------------------------------------------------- |
| Sitemap unreachable         | `crawl`/`sitemap` exits with `{"error":...}`                   |
| Product page 4xx            | that product is skipped (null); crawl continues                |
| Page has no JSON-LD Product | skipped; `product` reports `no JSON-LD Product on page`        |
| REST API (do not use)       | locked by security plugin — the sitemap path is the only route |
