#!/usr/bin/env python3
"""Read a PcComponentes product or listing page in one call.

PcComponentes answers a Playwright browser with a Cloudflare "Just a moment..."
page, but a plain headless Chrome render (--dump-dom) gets the real page. Every
product page carries schema.org JSON-LD: the FIRST offer price is the product's
own (the visible price text is split across lines and easy to misread), and
listing pages carry an ItemList with each item's URL and price.

  python3 -I pcc.py product <url> [<url> ...]   one JSON object per URL
  python3 -I pcc.py listing <url>               price | name | url, one per line

Read-only: it never logs in, adds to a basket or buys.
"""
import html as htmllib
import json
import re
import subprocess
import sys

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")
CHROMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")


def render(url):
    for chrome in CHROMES:
        try:
            out = subprocess.run(
                [chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                 "--virtual-time-budget=15000", f"--user-agent={UA}", "--dump-dom", url],
                capture_output=True, text=True, timeout=120)
        except FileNotFoundError:
            continue
        return out.stdout
    sys.exit("BLOCKED: no headless Chrome/Chromium found")


def ld_blocks(page):
    found = []
    for raw in re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', page, flags=re.S):
        try:
            found.append(json.loads(raw))
        except ValueError:
            pass
    return found


def text_lines(page):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    t = htmllib.unescape(re.sub(r"<[^>]+>", "\n", t))
    return [" ".join(l.split()) for l in t.split("\n") if l.strip()]


def after(lines, label):
    for i, l in enumerate(lines):
        if l == label and i + 1 < len(lines):
            return lines[i + 1]
    return None


def first(lines, pattern):
    rx = re.compile(pattern, re.I)
    return next((l for l in lines if rx.search(l) and len(l) < 160), None)


def product(url):
    page = render(url)
    if "Just a moment" in page[:3000]:
        return {"url": url, "error": "BLOCKED: Cloudflare challenge"}
    prod = next((b for b in ld_blocks(page)
                 if isinstance(b, dict) and str(b.get("@type", "")).lower() == "product"), {})
    offers = prod.get("offers") or {}
    offer = offers[0] if isinstance(offers, list) and offers else offers
    offer = offer if isinstance(offer, dict) else {}
    title = re.search(r"<title>([^<]*)", page)
    name = prod.get("name") or (title.group(1).split(" | ")[0].strip() if title else None)
    lines = text_lines(page)
    # Spec lines are read BELOW the product title only: the menus above it carry
    # filter labels ("PC sin sistema operativo") that look like specs.
    start = next((i for i, l in enumerate(lines) if name and l.startswith(name[:40])), 0)
    body = lines[start + 1:] if start else lines
    pvpr = after(body, "PVPR")
    image = prod.get("image")
    return {
        "url": url,
        "name": name,
        "price_eur": offer.get("price"),
        "price_valid_until": offer.get("priceValidUntil"),
        "availability": (offer.get("availability") or "").rsplit("/", 1)[-1] or None,
        "list_price": pvpr,
        "seller": (offer.get("offeredBy") or {}).get("name") or after(body, "Vendido y enviado por"),
        "delivery": first(body, r"^(Recíbelo|Entrega el)"),
        "image": image[0] if isinstance(image, list) and image else image,
        "mpn": prod.get("mpn") or prod.get("sku"),
        "os": first(body, r"FreeDOS|^Sin sistema operativo|no incluye sistema operativo|^Windows 1[01] (Home|Pro)"),
        "ram": first(body, r"^(?!.*GDDR).*\b\d+\s?GB\b.*(LPDDR|DDR|SO-DIMM|soldad)"),
        "storage": first(body, r"M\.2.*(ranura|unidades|segundo|soporte)|(ranura|unidades).*M\.2"),
        "keyboard": first(body, r"teclado.*(español|QWERTY)") or after(body, "Teclado"),
        "weight": after(body, "Peso") or after(body, "Peso/Dimensiones"),
        "sale_banner": " ".join(lines[1:8]) if first(lines[:10], r"acaban en") else None,
    }


def listing(url):
    page = render(url)
    rows = []
    for block in ld_blocks(page):
        if isinstance(block, dict) and block.get("@type") == "ItemList":
            for el in block.get("itemListElement", []):
                item = el.get("item") or {}
                offers = item.get("offers") or {}
                offer = offers[0] if isinstance(offers, list) and offers else offers
                price = offer.get("price") if isinstance(offer, dict) else None
                rows.append((float(price) if price not in (None, "") else float("inf"),
                             item.get("name"), item.get("url") or (offer.get("url") if isinstance(offer, dict) else None)))
    for price, name, link in sorted(rows, key=lambda r: r[0]):
        print(f"{price:>9.2f} | {name} | {link}")
    if not rows:
        sys.exit("NO ItemList found (blocked page or layout change)")


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("product", "listing"):
        sys.exit(__doc__)
    if sys.argv[1] == "listing":
        listing(sys.argv[2])
    else:
        for u in sys.argv[2:]:
            print(json.dumps(product(u), ensure_ascii=False))
