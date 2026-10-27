---
name: pccomponentes
description: Read PcComponentes (Spain's big electronics shop) in one call per page. `product` gives the real price, stock, seller (PcComponentes itself or a marketplace seller), delivery date, list price, part number, photo and the spec lines a buyer gates on (RAM type and slots, second M.2 slot, operating system, keyboard, weight). `listing` gives a whole category sorted by price with links. Use it for any "find me a laptop / SSD / licence at PcComponentes", for pricing a shopping list, and as the row source for the product-comparison-chart recipe. Read-only.
metadata:
  openclaw:
    emoji: 🛒
    requires:
      bins: [python3, google-chrome]
    why: Four laptop-shopping sessions (2026-10-01 to 10-09) each rebuilt the same headless render and text scraping by hand, 3-6 calls per page. One of them read a split price wrong, and a Playwright browser got Cloudflare's "Just a moment" page instead of the product.
---

# pccomponentes

One Python script. It renders the page with headless Chrome and reads the page's own schema.org data, so the price is the one the shop publishes for that exact product.

```bash
# one or more product pages → one JSON object each
python3 -I ~/src/tinkerclaw/skills/pccomponentes/scripts/pcc.py product <url> [<url> ...]

# a category or filter page → "price | name | url", cheapest first
python3 -I ~/src/tinkerclaw/skills/pccomponentes/scripts/pcc.py listing https://www.pccomponentes.com/portatiles/geforce-rtx-5070-series
```

Each page takes 15-25 s. Pass several product URLs in one call rather than one call each.

## What to trust and what to check

- `price_eur`, `availability`, `seller`, `mpn` come from the shop's structured data. Quote them.
- `seller` other than `PcComponentes` means a marketplace seller. For a company invoice, say so in the row; software keys from marketplace sellers are the usual €49-110 "Windows 11 Pro" offers.
- `ram`, `storage`, `os`, `keyboard`, `weight` are the first matching spec line on the page. They are leads: open the page when one of them decides the buy. `LPDDR` in the RAM line means soldered memory, which can never be upgraded.
- `sale_banner` is the shop-wide campaign countdown. It does not say whether this product's price belongs to the campaign.
- One product name can cover several editions (Windows Home/Pro, OEM/retail, language), each at its own URL and price. Link the URL you priced, and run `product` on it before it goes in a list.

## When it fails

- `BLOCKED: Cloudflare challenge`: rerun once; if it persists, the headless route is blocked for now. Do not switch to Playwright, which hits the challenge every time.
- `NO ItemList found` on a listing: the URL is not a category page or the layout changed. Search for the category URL first instead of guessing it (`/brands/microsoft/...` style URLs from search results can 404).

## Failures overcome

- 2026-10-09: a laptop row showed four prices in its text (€1,699 / €1,899 / €2,308.99 / -€609). The structured data said €1,699. Hence: price from JSON-LD, never from page text.
- 2026-10-09: a shopping list linked its Windows licence to a €109.99 English OEM key from a marketplace seller, while the price beside it (€259) was the Spanish retail licence PcComponentes sells itself. Hence the editions rule above.
