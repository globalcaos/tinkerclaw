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
- `delivery` is the buy box's own sentence, read at that minute. It is `null` when `availability` is `OutOfStock`: a sold-out page shows "Avísame" and "Sin fecha exacta de entrada", and every date further down belongs to a similar-product tile. Run `product` again right before you quote a date or say "in stock": a laptop in stock at 04:45 was sold out at 12:23 the same day.
- `seller` other than `PcComponentes` means a marketplace seller. For a company invoice, say so in the row; software keys from marketplace sellers are the usual €49-110 "Windows 11 Pro" offers.
- `ram`, `storage`, `os`, `keyboard`, `weight` are the first matching spec line on the page. They are leads: open the page when one of them decides the buy. `LPDDR` in the RAM line means soldered memory, which can never be upgraded.
- `sale_banner` is the shop-wide campaign countdown. It does not say whether this product's price belongs to the campaign.
- One product name can cover several editions (Windows Home/Pro, OEM/retail, language), each at its own URL and price. Link the URL you priced, and run `product` on it before it goes in a list.

## Find a product by name or part number: one call

`listing` reads category pages only. To find an accessory or a part number (a charger, a spare battery, "GX21T68202"), fetch the shop's search page with WebFetch: `https://www.pccomponentes.com/buscar/?query=<words>`. It returns name, price, seller and delivery date in one call. On 2026-11-10, `pcc.py listing` on a `/buscar/` URL ran past a 90 s Bash timeout on the Pi twice, while the WebFetch of the same URL answered at once.

A listing name ending in `(PT)` (or a URL with `portugues`) is a Portuguese-keyboard edition, not a Spanish one. Say so before you put it in a list.

## Reading the output

`product` prints ONE JSON object per LINE, one line per URL. Parse each line with `json.loads`. Do not filter lines with `grep -v '"image"'` or match a multi-line `{ … }` block: every line holds every key, so the filter drops everything and the call looks empty.

```bash
python3 -I ~/src/tinkerclaw/skills/pccomponentes/scripts/pcc.py product <url> <url> | python3 -I -c "
import sys,json
for l in sys.stdin:
    if l.startswith('{'):
        d=json.loads(l); print({k:d.get(k) for k in ('name','price_eur','availability','seller','delivery','ram','keyboard')})"
```

## "What is in stock in Spain": the other shops, and which ones answer

For a market sweep ("who has an RTX 5090 laptop", "what share of shops did you check"), send these WebFetch calls together in one turn, then count read / blocked / not opened in the answer. Measured 2026-11-13 from a Raspberry Pi:

- Answer with products: `https://www.pccomponentes.com/buscar/?query=<words>` (laptops by chip name, e.g. `portatil+nvidia+n1x`; a bare chip name returns graphics cards), `https://www.mediamarkt.es/es/search.html?query=<words>`, `https://lifeinformatica.com/?s=<words>&post_type=product`, `https://www.alternate.es/listing.xhtml?q=<words>`, the maker's own collection pages (`es-store.msi.com/collections/...`), and Geeknetic's comparator page for one model (prices at Coolmod, PcComponentes and MediaMarkt, no stock).
- Refuse the fetch (403, 429, 503 or a redirect loop): El Corte Inglés, Neobyte, Fnac, Lenovo's store, Slimbook, idealo.es, Coolmod's search AND its product pages (WebFetch redirect loop again 2026-11-15; go straight to the headless render below), bestware (XMG), Amazon. Do not retry them; name them as not read.
- PCBox's search page loads with no products in it (they are drawn by script).
- Tuxedo's product page loads, but the configurator with per-option stock does not.

Confirm stock of the final picks with `product`: a search page shows a delivery date, not `InStock`.

**The same unit at MediaMarkt and Coolmod: one local render each (2026-11-13).** Their PRODUCT pages answer `chromium --headless=new --disable-gpu --password-store=basic --user-data-dir=/tmp/jarvis/<task>/prof --virtual-time-budget=20000 --dump-dom <url>` even where WebFetch loops or shows no specs. Find the Coolmod product URL with a WebSearch limited to `coolmod.com`; take the MediaMarkt one from its search page.

- Coolmod: the schema.org block gives `price`, `availability` and `mpn`; the text gives "Recíbelo el …" under "Disponibilidad" and "Idioma del teclado - …". The crossed-out price sits above the real one, so take the price from the schema.org block.
- MediaMarkt: the text gives "Disponible online" and "Entrega dd/mm/yyyy". The page data gives `"marketplaceSeller":null` on MediaMarkt's own offer (a seller name there is a marketplace offer, often dearer) and the barcode as `"ean"`. The specs with the keyboard language do not load.
- **Same unit is not same box (2026-11-15).** Before ranking shops by price, read what each ships in the box (charger, cable, bag): Coolmod's ProArt N1X page carries "Cargador no incluido" while MediaMarkt ships the 140 W adapter, so Coolmod's 19.05 EUR saving became a 24.75 EUR loss once a charger was priced. A pick was made on price alone although the note from two days earlier already recorded the missing charger. Price = laptop + whatever the box lacks.
- Same barcode does not mean same box. Before ranking shops on price, read each shop's box contents ("Cargador no incluido", "Accesorios incluidos"). Coolmod's label for the N1X ProArt says the charger is not included, while MediaMarkt ships it. Add the missing part's price to that shop's total (2026-11-15: a 19.05 € Coolmod saving turned into a 24.75 € loss once a charger was added).
- **Box contents before price (2026-11-15).** The same barcode can ship with or without a charger: Coolmod's EU label for the ProArt P16 N1X says "Cargador no incluido" while MediaMarkt's offer has it, so Coolmod's 19.05 € lower price was really dearer once a 140 W PD 3.1 charger (43.80 € and up) was added. Read the charger line on each page and add the charger to the shop that lacks it before ranking. A spare charger must match the box rating (140 W needs USB PD 3.1; a 65-68 W PD 3.0 "ASUS" adapter is not a spare).
- The barcode decides "is it the same unit": the same `ean`/`gtin13` at two shops is the same product, keyboard included. PcComponentes prints it in its page source next to `mpn`.

## When it fails

- `BLOCKED: Cloudflare challenge`: rerun once; if it persists, the headless route is blocked for now. Do not switch to Playwright, which hits the challenge every time.
- `NO ItemList found` on a listing: the URL is not a category page or the layout changed. Search for the category URL first instead of guessing it (`/brands/microsoft/...` style URLs from search results can 404).

## Failures overcome

- 2026-10-09: a laptop row showed four prices in its text (€1,699 / €1,899 / €2,308.99 / -€609). The structured data said €1,699. Hence: price from JSON-LD, never from page text.
- 2026-10-09: a shopping list linked its Windows licence to a €109.99 English OEM key from a marketplace seller, while the price beside it (€259) was the Spanish retail licence PcComponentes sells itself. Hence the editions rule above.
- 2026-11-10: on a Raspberry Pi with Chromium and no desktop session, every render hung until the 120 s timeout (two searches killed after 90 s), because Chromium waited on the keyring. The launch now passes `--password-store=basic` and a throwaway `--user-data-dir`; the same SSD page then rendered in 7 s.
- 2026-11-13: a sold-out laptop page still printed `delivery: "Entrega el lunes, 16 de noviembre"` beside `availability: "OutOfStock"`. The date was the first "Entrega el" line in the page text, and it belonged to a marketplace seller's tile under "similar products". `delivery` is now `null` for a sold-out product.
