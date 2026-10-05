---
name: obramat
description: Query the Obramat (formerly Bricomart, Spain) product catalog — prices, sizes, properties, and stock at the store you choose. Use when the user asks about construction/DIY materials, tools, or products at Obramat, their price, stock, dimensions, or specs. Primary path is fully autonomous (scripts/obramat_search.py, DataDome cookie replay); the browser relay is only needed occasionally to refresh cookies. No cookies ship with the skill — the first run needs one capture from the user's own browser. Read references/site-architecture.md before the first query of a session.
---

# Obramat product queries

Query products, prices, sizes, properties, and availability at **one Obramat store — the one the user picks**. Obramat keeps the selected store in a session cookie (`customer_context`), so the store is whatever was selected in the browser when the cookies were captured.

## Configuration

| Setting                        | Default                               | What it does                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OBRAMAT_STORE` (or `--store`) | empty                                 | The store you expect, as the site prints it: `"Obramat <Town>"`. Empty = use whatever store the captured session has selected. When set, the scripts stop with `STORE_MISMATCH` rather than quote another store's stock. |
| `OBRAMAT_COOKIE_FILE`          | `state/cookies.json` in the skill dir | Where the cookie jar lives. `state/` is git-ignored.                                                                                                                                                                     |
| `OBRAMAT_CDP_PORT`             | `18792`                               | Browser relay CDP port, used by `refresh_cookies.js` only.                                                                                                                                                               |
| `OBRAMAT_WS_MODULE`            | `ws`                                  | Path to the `ws` package. Only needed on Node < 22.                                                                                                                                                                      |

Dependency: `pip install --user curl_cffi`.

## First run: pick a store

1. Ask the user which Obramat warehouse they use. If they don't know, the store pages are `/almacenes/obramat-<town>.html` and the store chooser in the site header lists them all (a partial id list is in `references/site-architecture.md`).
2. Ask the user to open obramat.es in Chrome, select that store in the header's store chooser, and share the tab through the browser relay.
3. Run Mode 2 below. `refresh_cookies.js` prints the store the cookies carry (`STORE: Obramat <Town> (id N)`). Confirm it is the right one.
4. Optionally set `OBRAMAT_STORE="Obramat <Town>"` so a later capture with a different store is caught.

## Mode 1 (primary): autonomous search script

```bash
python3 scripts/obramat_search.py "<query>" [--page N] [--limit N] [--store "Obramat <Town>"]
```

- No browser needed. Replays the session cookies from the jar via `curl_cffi` (Chrome TLS impersonation) from the same machine that captured them — DataDome accepts it (verified 2026-08-06).
- Output: JSON with product name (dimensions embedded, e.g. `2600X1200X13 MM`), stock status/qty at the selected store, prices (€/unit, €/m², €/box with IVA), product URL, and the store name/id.
- Store context is baked into the cookies. If the user switches store, re-capture cookies.
- Search phrasing: Sensefuel ignores bare numeric tokens ("20", "2cm") — search the noun ("tablero OSB", "placa yeso laminado") and filter results by name/facets.
- Exit messages: `DATADOME_BLOCKED` or `NO_COOKIES` → run Mode 2 (cookie refresh), then retry. `STORE_MISMATCH` → the cookies carry a different store than `OBRAMAT_STORE`/`--store`; switch store in the tab and run Mode 2.
- ⚠️ **Sensefuel's search index has gaps.** Verified 2026-08-06: of the 7 OSB SKUs in the full catalog, search only returned 5 — the 1.8cm and 2.2cm boards never appeared in search results.

  **Trigger on the QUESTION TYPE, not on how the results look.** "Looks thin" is the judgement that already failed once: 5 OSB results did not look thin either.
  - **Completeness question** — "what thicknesses/sizes/variants do they have", "what's available in X", "do they have X at all", any answer that will be phrased as a complete set → **the sitemap crawl is MANDATORY, always, even when search returns plenty.** Verified 2026-08-07: search for `poliestireno extruido` vs the catalog's 21 XPS SKUs; the long-format 260×60 boards in 5 cm and 6 cm were missed by answering off search alone, and the answer wrongly said that format existed only in 4 cm.
  - **Single-product lookup** — "how much is this board", "is it in stock" → search alone is fine; add the crawl if results look thin or the user says something exists that you can't find.

```bash
python3 scripts/obramat_sitemap_grep.py <keyword>   # crawls mapa-del-sitio-del-producto.html (complete index, ~10 pages)
```

Then fetch individual product pages with:

```bash
python3 scripts/obramat_product.py <product-url> [url2 ...] [--store "Obramat <Town>"]   # displayed price + selected-store stock + LD specs
```

Product pages are also where the **pack contents** live ("paquetes de 16 paneles para cubrir 12,96 m2"), plus lambda/R and GTIN — search never returns those. Two traps, both verified 2026-08-06 (the script handles them; do not hand-roll a fetch that doesn't):

- **The JSON-LD `offers.price` is STALE.** SKU 25046668 advertised `"price": "47"`/`44.98` in LD while the page charged 40,81 € sin IVA / 49,38 € con IVA. Quote the _rendered_ price (`price_unit_iva`), which matches `obramat_search.py` exactly. Ratios between LD and rendered prices varied 1.10×–1.39× across SKUs — it is not a tax offset.
- **"El producto no está disponible" is a recommendation-carousel banner**, not a delisting notice — it means that carousel slot has no offer. Likewise, stock counts below the carousel belong to OTHER products. Always truncate the HTML at `name="recommendation"` before parsing. A product with **no rendered price and no stock badge** above that cut is what "not available at the selected store" actually looks like (e.g. the 6 cm Sonorock panels and both 8 m rolls, 2026-08-06).

Corollary on the search-index gap: sitemap-only SKUs are not always hidden stock — for `lana de roca` all 4 sitemap extras turned out to be genuinely unavailable at the store, so search was right. Confirm with the product page before telling the user something exists.

## Mode 2: cookie refresh (relay, occasional)

Needed on first run and whenever a script reports `DATADOME_BLOCKED`/`NO_COOKIES`/`STORE_MISMATCH`:

1. Ask the user to open obramat.es in Chrome with their store selected and share the tab through the browser relay.
2. `node scripts/refresh_cookies.js [cdpPort]` — pulls cookies via the relay CDP endpoint (`Network.getAllCookies`), keeps only obramat.es cookies, verifies a `datadome` cookie is present, writes the jar with mode 0600, and prints the store the cookies carry.
3. Retry the search.

The `datadome` cookie carries a 1-year Max-Age but DataDome can invalidate it server-side at any time; treat `DATADOME_BLOCKED` as "refresh time", not a bug.

## Mode 3 (fallback): drive the relay tab

For product detail pages (full spec tables, per-store stock widget) or if the script is blocked and cookies can't be refreshed:

- Find the shared tab: `browser action=tabs` (URL contains obramat.es). If none, ask the user to share one.
- Search: navigate via `act kind=evaluate fn="() => { location.href='https://www.obramat.es/search?q=...' }"` (plain `navigate` times out — Sensefuel never fires `load`), `wait ~3s`, then extract `.product-thumbnail` innerText. Do NOT use `/catalogsearch/result/` (404).
- Store check: header shows "Obramat <Town> — Abierto • cierra a las HH:MM". If it is not the user's store, open the store chooser and pick it.
- JSON-LD is absent on search results; may exist on product pages — check `script[type="application/ld+json"]`.

## Answering

- Prices in EUR with IVA; name the store the numbers are for and say prices are as of now.
- Include product URLs. For >5 results use a rendered table.
- Dimensions live in product names; for deeper specs open the product page (`obramat_product.py`, or Mode 3).

## Permissions, data flow & consent

- **Reads only.** No login, no basket, no order. Every request goes to `https://www.obramat.es`.
- **Cookies are secrets.** They are the user's live session. The jar is written only by `refresh_cookies.js`, only after the user shares a tab, only with obramat.es cookies, mode 0600, into a git-ignored `state/` directory. Scripts never print cookie values. None ship with the skill.
- The relay is contacted on loopback (`127.0.0.1`) only.
- Replay from a different IP likely fails; run the scripts on the machine that captured the cookies.

## Notes

- Images at `/media/catalog/product/...` are NOT DataDome-protected.
- Full architecture + access matrix: `references/site-architecture.md`.
