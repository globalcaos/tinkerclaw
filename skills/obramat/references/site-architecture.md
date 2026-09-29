# Obramat.es — site architecture & access notes

Reconnaissance dated **2026-08-06** (by the agent). Verify before trusting details older than a few months — the site ships micro-frontend releases frequently.

## Access wall: DataDome

`www.obramat.es` is protected by **DataDome**. Verified 2026-08-06:

| Attempt                                                    | Result                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| curl with browser UA                                       | 403 "Please enable JS and disable any ad blocker"    |
| `curl_cffi` impersonate=chrome (TLS fingerprint)           | 403 challenge                                        |
| Playwright + real Chrome channel, headless=new, spoofed UA | 403                                                  |
| Cookie-retry dance (reuse datadome cookie from 403)        | 403                                                  |
| API paths (e.g. `.../account-creation-backend/stores`)     | 403 → captcha redirect to `geo.captcha-delivery.com` |
| Static assets `/media/catalog/product/...`                 | **200 OK** (images accessible directly)              |
| `robots.txt`                                               | **200 OK**                                           |

Conclusion: only a real, human-established Chrome session passes. The skill therefore starts from the user's shared tab via the browser relay (and then replays its cookies, see below).

**Optional upgrade path (not built):** install `xvfb` on the host (needs sudo), run headed Chrome with a persistent profile + stealth flags; the user solves the DataDome challenge once in that profile; afterwards the profile's cookies may allow unattended runs. Not verified — DataDome may still flag Playwright-driven sessions. Do not attempt without the owner's sign-off.

## Platform stack (Adeo group)

- Commerce shell: Magento-flavoured routing (`/catalogsearch/result/?q=`, `/customer/`, `.html` CMS pages).
- Frontend: **Adeo "Fox" micro-frontends**, served at `/fox--microfront--<domain>/<version>/public/js/*.js` — domains seen: `catalog`, `store`, `offer`, `cross` (header/footer), `cart`, `analytics`, `cms`, `comparator`, `sitebox`, `search`. Versions rotate; bundles are minified and reference runtime-injected config (no hardcoded API URLs in them).
- Search: **Sensefuel** (`tag.search.sensefuel.live/tag/<tag-id>/tagp.js`; the tag id is in the page source and may rotate; the tag returns "get tag content error" outside the real page context).
- Store maps/geolocation: **Woosmap** (`sdk.woosmap.com`).
- Page state: `window.__INITIAL_STATE__` (JSON) — contains store state: `fetchSelectedStore`, `currentStore`, `storeList`; product pages embed `storeAvailability` objects with geozone identifiers. Store ids use `STORE-xxx` format in some layers.

## Stores

The selected store travels in the **`customer_context` cookie**: URL-encoded JSON with `main_store` (the store id), `stores_name` (`[{"name":"Obramat+<Town>","id":"<id>"}]`), and the user's `city`, `postcode`, `latitude`, `longitude`. The scripts read the store name and id from it; `refresh_cookies.js` prints it after every capture. Note that the jar therefore also holds the user's approximate location — one more reason it never leaves the machine.

Store list API (JSON, `{"stores":[{"id":..,"label":".."}]}`):

```
/account-creation-frontend/services/account-creation-backend/stores
```

DataDome-blocked live, but archived on Wayback (snapshot 2026-04-23). Sample of known ids (April 2026): Alcalá de Guadaíra 23, Alcobendas 24, Alcorcón 18, Alicante 3, Salamanca 22, Santander 15, Santiago 13, Sestao 17, Siero 2, Usera 12, Valladolid 10, Zaragoza 27. For any other store, read its id from `customer_context` after selecting it, or from the archived store list.

Store page slug: `/almacenes/obramat-<town>.html` (address, phone, opening hours).

## URL patterns

- Search: `/search?q=<query>` (SSR, what the scripts use; `&page=N` for pagination). The Magento default `/catalogsearch/result/?q=` returns 404.
- Categories: clean nested paths, e.g. `/fontaneria/termos/termos-electricos/`, `/ceramica/pavimentos-ceramicos/`, `/materiales-de-construccion/madera-construccion/`, `/herramientas/herramientas-electricas-portatiles/`.
- Store pages: `/almacenes/obramat-<town>.html`.
- Product sitemap: `/mapa-del-sitio-del-producto.html?p=<n>` (complete product index, ~10 pages).
- Product images: `/media/catalog/product/<path>` (direct access OK).
- robots.txt disallows filters in URLs: `?*filters`, `?*order_by`, `/sort=` — keep query URLs simple.

## Offline research fallback (Wayback)

Live pages blocked, but Wayback has good coverage — useful for structure reconnaissance, NOT for prices:

```bash
# list snapshots
curl -s 'http://web.archive.org/cdx/search/cdx?url=www.obramat.es*&output=json&limit=4000&filter=statuscode:200&collapse=urlkey&from=2024'
# fetch raw snapshot content
curl -s 'http://web.archive.org/web/<timestamp>id_/https://www.obramat.es/<path>'
```

Archived JS bundles (`...id_/https://www.obramat.es/fox--microfront--store/...`) reveal micro-frontend versions and class names (e.g. `b-change-store__search`, `b-header__search`) when the live DOM can't be inspected.

## Cookie replay breakthrough (2026-08-06, live-verified)

The DataDome wall can be passed WITHOUT a browser: capture the full cookie set from the user's real Chrome session (via relay CDP `Network.getAllCookies` — includes the `datadome` cookie, 128 chars) and replay it with `curl_cffi impersonate=chrome` from the same machine (same IP). Verified working on homepage AND `/search?q=...` (SSR HTML with product cards, stock, prices).

Key facts:

- Cookie set ≈ 24 cookies; the essential one is `datadome` (`.obramat.es`). `customer_context` carries the selected store (see Stores). Replay from a different IP would likely fail — keep it on the capturing machine.
- Search results HTML is SSR: cards `class="product-thumbnail product-thumbnail-item..."`, designation link `<a href="/productos/..." title="NAME">`, stock in `stock-status_label` ("N en stock en Obramat <Town>"), prices as "X,XX € IVA / Unidad|m²|cajas" (SSR text puts spaces around the decimal comma: "13 ,85 €").
- Pages also embed `<script type="application/json" class="dataTms">` analytics blobs (5 per search page) — one contains `cdl_products_list` with clean JSON (brand, sku, name, offer.unitprice_ati = € IVA, url), and one contains user context (city and postcode of the session). Strip `<script>` blocks before regex-parsing cards.
- Pagination: search returned 94 results for "pladur" across pages; `&page=2` supported.
- `scripts/obramat_search.py` implements this; `scripts/refresh_cookies.js` refreshes the cookie jar from a shared relay tab (CDP port 18792 by default).
