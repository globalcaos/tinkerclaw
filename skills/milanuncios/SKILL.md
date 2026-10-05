---
name: milanuncios
description: Code-based HTTP scraper for Milanuncios (Spain classifieds). Use it BEFORE the browser-relay CDP path when the marketplace-watcher cron — or any shopping task — needs to query Milanuncios: it's faster, doesn't burn the shared browser tab, and survives the WAF/cookie-wall failure modes via a documented fallback contract. The HTTP path WORKS. Prints one JSON object (listings + meta) to stdout, or exits non-zero with `BLOCKED: <reason>` when browser fallback is required. Split out of the former combined `marketplace-search` skill (2026-09-19) so Milanuncios and Wallapop each stand alone.
metadata:
  openclaw:
    emoji: 🛒
    requires:
      bins: [node]
    why: Bug task-mpie1ypb-1e8i6 ("Overnight cron uses browser to explore milanuncios and wallapop") — the cron was using the shared browser tab as the primary scraping path, taking over the user's Chrome surface for routine queries and consuming the only authenticated session. Code-based scraping returns the browser to a fallback role. Split from marketplace-search 2026-09-19 so each marketplace is its own skill.
---

# milanuncios

A single Node script that fetches Milanuncios search results without the browser-relay shared tab. It prints one JSON object to stdout (listings array + meta) or exits non-zero with `BLOCKED: <reason>` to stderr when the HTTP path can't deliver and browser fallback is required.

## Usage — HTTP path WORKS (use this first)

```bash
node ~/.openclaw/workspace/skills/milanuncios/scripts/milanuncios.mjs \
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

`created_at_iso` is `sortDate` (last bumped — the right "newness" signal for the cron's freshness scoring). `created_at_iso_orig` is the original `publishDate` (kept for audit).

If the page returns the cookie-wall consent splash, the script exits 2 with `BLOCKED: cookie-wall`. On a WAF challenge / 403, exits 2 with `BLOCKED: waf`. If `__INITIAL_PROPS__` is missing (page shape changed), exits 2 with `BLOCKED: parse-html ...`. The script ALSO tolerates the older `__NEXT_DATA__` script-tag shape and the direct-object-literal `window.__INITIAL_PROPS__ = {...}` shape as fallbacks.

Pass `--search-path` to try the legacy `/buscar/?s=...` URL (currently 404 → don't bother, but kept for the day the endpoint returns).

## When to use vs fall back to CDP

ALWAYS try the script FIRST — it works for Milanuncios. Fall back to the browser-relay CDP path (the user's shared tab) ONLY when:

- The script exits 2 with `BLOCKED: waf` or `BLOCKED: cookie-wall` AND
- A retry 10–30s later still fails AND
- The watchlist item is high-value enough to burn the shared tab for.

For routine watchlist scans where source-diversity already carries the day, prefer "mark Milanuncios 🟡 in the receipt and move on" over the CDP fallback.

## Authoritative reference

See `~/.claude/projects/-home-globalcaos-src-jarvis-icu/memory/reference_marketplace_watcher_scrape.md` for the historical scrape-recipe context. This script implements the same `__INITIAL_PROPS__` parse contract documented there, run server-side instead of in-page via CDP `Runtime.evaluate`.
