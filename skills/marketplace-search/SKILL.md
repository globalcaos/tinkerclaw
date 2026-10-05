---
name: marketplace-search
description: Code-based HTTP scrapers for Milanuncios + Wallapop. Use these BEFORE the browser-relay CDP path when the marketplace-watcher cron needs to query either site — they're faster, don't burn the shared browser tab, and (for Milanuncios) survive the same WAF/cookie-wall failure modes via a documented fallback contract. Wallapop's HTTP path returns BLOCKED at the moment (the API is auth-gated and the HTML page lazy-loads results via client-side JS); browser-relay is unavoidable for Wallapop until a headless renderer is wired. Milanuncios HTTP works.
metadata:
  openclaw:
    emoji: 🛒
    requires:
      bins: [node]
    why: Bug task-mpie1ypb-1e8i6 ("Overnight cron uses browser to explore milanuncios and wallapop") — the cron was using the shared browser tab as the primary scraping path, taking over the user's Chrome surface for routine queries and consuming the only authenticated session. Code-based scraping returns the browser to a fallback role where it remains unavoidable, and removes it entirely where the HTTP path works.
---

# marketplace-search

Two Node scripts that try to fetch search results from Milanuncios + Wallapop without going through the browser-relay shared tab. Each prints one JSON object to stdout (listings array + meta) or exits non-zero with `BLOCKED: <reason>` to stderr when the HTTP path can't deliver and browser fallback is required.

## Milanuncios — HTTP path WORKS (use this first)

```bash
node {baseDir}/scripts/milanuncios.mjs \
  --keywords "espresso eureka mignon" \
  --limit 10 \
  --order fechaDesc
```

Fetches `https://www.milanuncios.com/anuncios/<slug>.htm` (the slug-path URL — the legacy `/buscar/?s=...` endpoint now 404→redirects). Parses `window.__INITIAL_PROPS__ = JSON.parse("...")` from the response HTML. Listings come from `parsed.adListPagination.adList.ads`. Filters out `sellType: "demand"` ISOs ("looking for X"). Output shape:

```json
{
  "source": "milanuncios",
  "keywords": "leica",
  "fetched_at": "2026-05-24T...",
  "count": 10,
  "listings": [
    {
      "id": "517581387",
      "title": "TELÉMETRO LEICA",
      "description": "SE VENDE TELÉMETRO LEICA EN PERFECTO ESTADO ...",
      "price": 350,
      "currency": "EUR",
      "location": "Talavera de la Reina, Toledo",
      "distance_km": null,
      "url": "https://www.milanuncios.com/articulos-de-caza/telemetro-leica-517581387.htm",
      "image_url": "https://images.milanuncios.com/api/v1/...",
      "created_at_iso": "2026-05-21T22:53:25Z",
      "created_at_iso_orig": "2024-06-24T15:25:20Z",
      "seller_handle": "(professional)"
    }
  ],
  "_meta": { "props_source": "INITIAL_PROPS-json-parse", "search_path": false }
}
```

`created_at_iso` is `sortDate` (last bumped — the right "newness" signal for the cron's Step 5 freshness scoring). `created_at_iso_orig` is the original `publishDate` (kept for audit).

If the page returns the cookie-wall consent splash, the script exits 2 with `BLOCKED: cookie-wall`. If it returns a WAF challenge / 403, exits 2 with `BLOCKED: waf`. If `__INITIAL_PROPS__` is missing (page shape changed), exits 2 with `BLOCKED: parse-html ...`. The script ALSO tolerates the older `__NEXT_DATA__` script-tag shape and the direct-object-literal `window.__INITIAL_PROPS__ = {...}` shape as fallbacks.

Pass `--search-path` to try the legacy `/buscar/?s=...` URL (currently returns 404 → don't bother, but kept for the day the endpoint comes back).

## Wallapop — HTTP path BLOCKED (browser-relay is unavoidable, for now)

```bash
node {baseDir}/scripts/wallapop.mjs \
  --keywords "leica m6" \
  --limit 10
```

The script TARGETS `https://api.wallapop.com/api/v3/general/search` — the public search JSON API — but as of 2026-05-24 that endpoint returns **HTTP 403** for unauthenticated callers regardless of header tuning. Wallapop's HTML page at `https://es.wallapop.com/app/search?keywords=...` returns a Next.js shell with `__NEXT_DATA__` but ZERO embedded listings — the actual results are fetched client-side via the same auth-gated API after the page hydrates.

Until a headless renderer (Playwright) is wired into a future revision of this skill, **Wallapop must continue to use the browser-relay CDP path**. The script exists as scaffolding for that future revision; for now it reliably returns `BLOCKED: http-403 Forbidden` so the cron's fallback logic kicks in immediately.

When the browser-relay path is used for Wallapop, FORK 2026-05-24 (a5d54492e7) added a cross-site `Page.navigate` guard in the extension — the cron CAN'T accidentally navigate the user's shared tab to a different domain. Same-site (`wallapop.com` → `es.wallapop.com`, etc.) is allowed.

## When to use vs when to fall back to CDP

ALWAYS try the script FIRST. For Milanuncios this works. For Wallapop it currently returns BLOCKED — go straight to the browser-relay CDP path (the user's shared `wallapop.com` tab).

Fall back to the browser-relay CDP path for Milanuncios ONLY when:

- The Milanuncios script exits 2 with `BLOCKED: waf` or `BLOCKED: cookie-wall` AND
- A retry 10–30s later still fails AND
- The watchlist item is high-value enough to burn the shared tab for

For routine watchlist scans where source-diversity already carries the day (WhatsApp + Gmail alerts + Wallapop via shared tab still working), prefer "mark Milanuncios 🟡 in the receipt and move on" over the CDP fallback.

## Parser contract

The shipped Milanuncios script contains the complete parser contract. It recognizes the current `window.__INITIAL_PROPS__ = JSON.parse(...)` response plus the older direct-object and `__NEXT_DATA__` shapes; no external scrape notes are required.
