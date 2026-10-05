#!/usr/bin/env python3
"""Enumerate the FULL Obramat catalog via the HTML sitemap and filter by keyword.

Use when the Sensefuel search seems incomplete (it has index gaps — e.g. OSB
1.8cm/2.2cm boards are in the catalog but never appeared in search results).
The sitemap is store-independent: it lists what exists, not what a store stocks.
Check stock with obramat_product.py.

Usage: python3 obramat_sitemap_grep.py <keyword> [keyword2 ...]
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from obramat_common import BASE, fetch, load_jar  # noqa: E402


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: obramat_sitemap_grep.py <keyword> [...]")
    keywords = [k.upper() for k in sys.argv[1:]]

    jar = load_jar()
    hits = {}
    for p in range(1, 40):
        r = fetch(f"{BASE}/mapa-del-sitio-del-producto.html?p={p}", jar)
        items = re.findall(r'href="(https://www\.obramat\.es/productos/[^"]+)"\s*title="([^"]+)"', r.text)
        if not items:
            items = [(u, u.split("/")[-1]) for u in re.findall(r'href="(https://www\.obramat\.es/productos/[^"]+)"', r.text)]
        if not items:
            break
        for u, n in items:
            if any(k in n.upper() or k in u.upper() for k in keywords):
                hits[n.strip()] = u
        if len(items) < 1000:
            break
    print(json.dumps({"keywords": sys.argv[1:], "count": len(hits), "products": hits}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
