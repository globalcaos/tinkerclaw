#!/usr/bin/env python3
"""Fetch Obramat product PAGES by URL: displayed price, selected-store stock, full specs.

Search (obramat_search.py) returns name/stock/price only, and its index has gaps.
Product pages carry (a) the schema.org Product LD-JSON whose *description* holds the
pack contents ("paquetes de 12 paneles para cubrir 9,72 m2"), lambda/R and GTIN, and
(b) the rendered price block.

Two traps this script handles, both verified 2026-08-06:
  1. The LD-JSON "price" is a STALE base price — for SKU 25046668 it said 44.98 while
     the page charged 40,81 € sin IVA / 49,38 € con IVA. NEVER quote the LD price.
     Quote `price_unit_iva` (rendered) instead; it matches obramat_search.py exactly.
  2. Everything below the recommendation carousel belongs to OTHER products: their
     stock counts, and a "El producto no está disponible" banner that is the carousel
     having no offer — NOT this product being delisted. We truncate the HTML at the
     carousel before parsing, so a missing stock line means "no stock badge for the
     selected store", which in practice means not stocked at that store.

Usage: python3 obramat_product.py <url> [url2 ...] [--store "Obramat <Town>"]
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from obramat_common import fetch, load_jar, resolve_store, stock_regex  # noqa: E402


def text_of(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


def main():
    ap = argparse.ArgumentParser(description="Fetch Obramat product pages (cookie replay).")
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--store", default=None,
                    help='expected store, e.g. "Obramat Alcorcón" (default: $OBRAMAT_STORE, '
                         "else whatever store the cookies carry)")
    a = ap.parse_args()
    jar = load_jar()
    store = resolve_store(jar, a.store)
    stock_re = stock_regex(store["name"])

    out = []
    for url in a.urls:
        r = fetch(url, jar)
        rec = {"url": url, "http": r.status_code}

        # LD-JSON: specs only (price deliberately ignored, see module docstring)
        for m in re.finditer(r'application/ld\+json[^>]*>(.*?)</script>', r.text, re.S):
            try:
                d = json.loads(m.group(1))
            except json.JSONDecodeError:
                continue
            if not isinstance(d, dict) or d.get("@type") != "Product":
                continue
            rec["name"] = d.get("name")
            rec["sku"] = d.get("sku")
            rec["brand"] = (d.get("brand") or {}).get("name")
            rec["description"] = " ".join((d.get("description") or "").split())

        # cut off recommendations — everything after belongs to other products
        head = re.split(r'name="recommendation"', r.text)[0]
        body = text_of(head)

        m = re.search(r"Vendido ([\d.,]+) € IVA por Unidad", body)
        rec["price_unit_iva"] = m.group(1) if m else None
        m = re.search(r"Vendido ([\d.,]+) € IVA por m²", body)
        rec["price_m2_iva"] = m.group(1) if m else None
        m = re.search(r"Vendido ([\d.,]+) € sin IVA por Unidad", body)
        rec["price_unit_no_iva"] = m.group(1) if m else None

        m = stock_re.search(body)
        if m:
            rec["stock"] = {"qty": m.group(1), "store": m.group(2).strip()}
        else:
            rec["stock"] = None  # no badge → not stocked at the selected store
        rec["store"] = store["name"]

        out.append(rec)

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
